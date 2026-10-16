-- Preserve attempt history while allowing an owner-audited, one-use retry.

alter table public.attempts
add column attempt_number integer not null default 1;

alter table public.attempts
add constraint attempts_attempt_number_check
check (attempt_number > 0);

alter table public.attempts
drop constraint attempts_quiz_id_student_id_key;

create unique index attempts_quiz_student_number_unique
on public.attempts (quiz_id, student_id, attempt_number);

create unique index attempts_one_active_per_student_quiz
on public.attempts (quiz_id, student_id)
where status in ('not_started', 'in_progress');

create table public.attempt_authorizations (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.quizzes(id) on delete restrict,
  student_id uuid not null references auth.users(id) on delete restrict,
  previous_attempt_id uuid not null references public.attempts(id) on delete restrict,
  authorized_by uuid not null references auth.users(id) on delete restrict,
  reason text,
  created_at timestamptz not null default now(),
  used_at timestamptz,
  new_attempt_id uuid references public.attempts(id) on delete restrict,
  constraint attempt_authorizations_reason_not_blank
    check (reason is null or btrim(reason) <> ''),
  constraint attempt_authorizations_usage_consistent
    check (
      (used_at is null and new_attempt_id is null)
      or (used_at is not null and new_attempt_id is not null)
    )
);

create unique index attempt_authorizations_one_pending
on public.attempt_authorizations (quiz_id, student_id)
where used_at is null;

create unique index attempt_authorizations_new_attempt_unique
on public.attempt_authorizations (new_attempt_id)
where new_attempt_id is not null;

alter table public.attempt_authorizations enable row level security;

revoke all on table public.attempt_authorizations
from public, anon, authenticated;
grant all on table public.attempt_authorizations to service_role;

create function public.authorize_new_attempt(
  p_previous_attempt_id uuid,
  p_reason text default null
)
returns table (
  authorization_id uuid,
  quiz_id uuid,
  student_id uuid,
  previous_attempt_id uuid,
  authorized_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quiz_id uuid;
  v_student_id uuid;
  v_attempt_number integer;
  v_status text;
  v_authorization_id uuid;
  v_created_at timestamptz;
  v_reason text;
begin
  select
    a.quiz_id,
    a.student_id,
    a.attempt_number,
    a.status
  into
    v_quiz_id,
    v_student_id,
    v_attempt_number,
    v_status
  from public.attempts a
  join public.quizzes q on q.id = a.quiz_id
  where a.id = p_previous_attempt_id
    and private.owns_course(q.course_id)
  for update of a;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'Intento inexistente o no autorizado.';
  end if;

  if v_status not in ('submitted', 'graded', 'expired', 'blocked') then
    raise exception using
      errcode = '55000',
      message = 'Solo se puede autorizar otro intento después de cerrar el actual.';
  end if;

  if exists (
    select 1
    from public.attempts newer
    where newer.quiz_id = v_quiz_id
      and newer.student_id = v_student_id
      and newer.attempt_number > v_attempt_number
  ) then
    raise exception using
      errcode = '55000',
      message = 'Solo el intento más reciente puede recibir una nueva autorización.';
  end if;

  if exists (
    select 1
    from public.attempt_authorizations pending
    where pending.quiz_id = v_quiz_id
      and pending.student_id = v_student_id
      and pending.used_at is null
  ) then
    raise exception using
      errcode = '23505',
      message = 'Ya existe un nuevo intento autorizado pendiente de uso.';
  end if;

  v_reason := nullif(btrim(p_reason), '');

  insert into public.attempt_authorizations (
    quiz_id,
    student_id,
    previous_attempt_id,
    authorized_by,
    reason
  )
  values (
    v_quiz_id,
    v_student_id,
    p_previous_attempt_id,
    auth.uid(),
    v_reason
  )
  returning id, created_at
  into v_authorization_id, v_created_at;

  return query
  select
    v_authorization_id,
    v_quiz_id,
    v_student_id,
    p_previous_attempt_id,
    v_created_at;
end;
$$;

revoke all on function public.authorize_new_attempt(uuid, text)
from public, anon;
grant execute on function public.authorize_new_attempt(uuid, text)
to authenticated;

create or replace function public.join_quiz_session(p_qr_token text)
returns table(
  attempt_id uuid,
  quiz_id uuid,
  quiz_session_id uuid,
  attempt_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_auth_session_id uuid;
  v_quiz_session_id uuid;
  v_quiz_id uuid;
  v_course_id uuid;
  v_duration_minutes integer;
  v_attempt_id uuid;
  v_attempt_status text;
  v_attempt_number integer;
  v_existing_session_id uuid;
  v_authorization_id uuid;
begin
  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  v_auth_session_id := (auth.jwt() ->> 'session_id')::uuid;

  if v_auth_session_id is null then
    raise exception 'Sesión de autenticación inválida';
  end if;

  if not exists (
    select 1
    from auth.sessions s
    where s.id = v_auth_session_id
      and s.user_id = v_user_id
  ) then
    raise exception 'La sesión de autenticación ya no es válida';
  end if;

  select
    qs.id,
    qs.quiz_id,
    q.course_id,
    q.duration_minutes
  into
    v_quiz_session_id,
    v_quiz_id,
    v_course_id,
    v_duration_minutes
  from public.quiz_sessions qs
  join public.quizzes q on q.id = qs.quiz_id
  where qs.qr_token_hash = encode(
      extensions.digest(p_qr_token, 'sha256'),
      'hex'
    )
    and qs.status = 'active'
    and qs.starts_at <= pg_catalog.now()
    and qs.expires_at > pg_catalog.now()
    and q.status = 'published'
    and q.delivery_mode = 'in_person'
  limit 1;

  if v_quiz_session_id is null then
    raise exception 'QR inválido o expirado';
  end if;

  if v_duration_minutes is null or v_duration_minutes <= 0 then
    raise exception 'El quiz no tiene una duración válida configurada';
  end if;

  if not private.is_course_member_or_authorized(v_course_id) then
    raise exception 'El estudiante no está matriculado en este curso';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      v_quiz_id::text || ':' || v_user_id::text,
      0
    )
  );

  select
    a.id,
    a.status,
    a.attempt_number,
    a.active_session_id
  into
    v_attempt_id,
    v_attempt_status,
    v_attempt_number,
    v_existing_session_id
  from public.attempts a
  where a.quiz_id = v_quiz_id
    and a.student_id = v_user_id
  order by a.attempt_number desc
  limit 1
  for update;

  if v_attempt_id is null then
    insert into public.attempts (
      quiz_id,
      student_id,
      quiz_session_id,
      status,
      attempt_number,
      active_session_id,
      session_started_at,
      last_heartbeat_at,
      started_at,
      deadline_at
    )
    values (
      v_quiz_id,
      v_user_id,
      v_quiz_session_id,
      'in_progress',
      1,
      v_auth_session_id,
      pg_catalog.now(),
      pg_catalog.now(),
      pg_catalog.now(),
      pg_catalog.now() + pg_catalog.make_interval(mins => v_duration_minutes)
    )
    returning id, status, attempt_number, active_session_id
    into
      v_attempt_id,
      v_attempt_status,
      v_attempt_number,
      v_existing_session_id;
  elsif v_attempt_status in ('submitted', 'graded', 'expired', 'blocked') then
    select pending.id
    into v_authorization_id
    from public.attempt_authorizations pending
    where pending.quiz_id = v_quiz_id
      and pending.student_id = v_user_id
      and pending.previous_attempt_id = v_attempt_id
      and pending.used_at is null
    order by pending.created_at
    limit 1
    for update;

    if v_authorization_id is null then
      if v_attempt_status = 'blocked' then
        raise exception 'Este intento fue bloqueado por incidencias de integridad. Contacta al docente';
      elsif v_attempt_status = 'expired' then
        raise exception 'El tiempo disponible para este intento ya terminó';
      else
        raise exception 'Este quiz ya fue finalizado';
      end if;
    end if;

    insert into public.attempts (
      quiz_id,
      student_id,
      quiz_session_id,
      status,
      attempt_number,
      active_session_id,
      session_started_at,
      last_heartbeat_at,
      started_at,
      deadline_at
    )
    values (
      v_quiz_id,
      v_user_id,
      v_quiz_session_id,
      'in_progress',
      v_attempt_number + 1,
      v_auth_session_id,
      pg_catalog.now(),
      pg_catalog.now(),
      pg_catalog.now(),
      pg_catalog.now() + pg_catalog.make_interval(mins => v_duration_minutes)
    )
    returning id, status, attempt_number, active_session_id
    into
      v_attempt_id,
      v_attempt_status,
      v_attempt_number,
      v_existing_session_id;

    update public.attempt_authorizations
    set
      used_at = pg_catalog.now(),
      new_attempt_id = v_attempt_id
    where id = v_authorization_id;
  end if;

  if v_attempt_status not in ('not_started', 'in_progress') then
    raise exception 'El intento no está disponible para continuar';
  end if;

  if v_existing_session_id is not null
     and v_existing_session_id <> v_auth_session_id
     and exists (
       select 1
       from auth.sessions s
       where s.id = v_existing_session_id
         and s.user_id = v_user_id
     ) then
    raise exception 'Este intento ya está activo en otra sesión';
  end if;

  update public.attempts as a
  set
    active_session_id = v_auth_session_id,
    quiz_session_id = v_quiz_session_id,
    status = 'in_progress',
    session_started_at = pg_catalog.now(),
    last_heartbeat_at = pg_catalog.now(),
    deadline_at = coalesce(
      a.deadline_at,
      a.started_at + pg_catalog.make_interval(mins => v_duration_minutes)
    )
  where a.id = v_attempt_id;

  return query
  select
    v_attempt_id,
    v_quiz_id,
    v_quiz_session_id,
    'in_progress'::text;
end;
$$;

revoke all on function public.join_quiz_session(text) from public, anon;
grant execute on function public.join_quiz_session(text) to authenticated;

drop function public.get_quiz_results(uuid);

create function public.get_quiz_results(p_quiz_id uuid)
returns table (
  attempt_id uuid,
  attempt_number integer,
  student_id uuid,
  student_name text,
  student_email text,
  attempt_status text,
  score_points numeric,
  grade numeric,
  focus_violation_count integer,
  started_at timestamptz,
  submitted_at timestamptz,
  graded_at timestamptz,
  expired_at timestamptz,
  new_attempt_authorization_pending boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.quizzes q
    where q.id = p_quiz_id
      and private.owns_course(q.course_id)
  ) then
    raise exception using
      errcode = '42501',
      message = 'Evaluación inexistente o no autorizada.';
  end if;

  return query
  select
    a.id,
    a.attempt_number,
    a.student_id,
    p.full_name,
    p.email,
    a.status,
    a.score_points,
    a.grade,
    a.focus_violation_count,
    a.started_at,
    a.submitted_at,
    a.graded_at,
    a.expired_at,
    exists (
      select 1
      from public.attempt_authorizations pending
      where pending.previous_attempt_id = a.id
        and pending.used_at is null
    )
  from public.attempts a
  join public.profiles p on p.id = a.student_id
  where a.quiz_id = p_quiz_id
  order by a.student_id, a.attempt_number;
end;
$$;

revoke all on function public.get_quiz_results(uuid) from public, anon;
grant execute on function public.get_quiz_results(uuid) to authenticated;
