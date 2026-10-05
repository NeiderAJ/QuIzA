create table public.course_authorized_emails (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null
    references public.courses(id)
    on delete cascade,
  email text not null,
  created_at timestamptz not null default now(),
  constraint course_authorized_emails_email_not_empty
    check (btrim(email) <> ''),
  constraint course_authorized_emails_email_normalized
    check (email = lower(btrim(email)))
);

create or replace function private.normalize_course_authorized_email()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.email := lower(btrim(new.email));
  return new;
end;
$$;

revoke all
on function private.normalize_course_authorized_email()
from public;

create trigger course_authorized_emails_normalize_email
before insert or update on public.course_authorized_emails
for each row
execute function private.normalize_course_authorized_email();

create unique index course_authorized_emails_course_email_unique
on public.course_authorized_emails (
  course_id,
  lower(btrim(email))
);

alter table public.course_authorized_emails
enable row level security;

revoke all
on table public.course_authorized_emails
from public, anon, authenticated;

grant select, insert, delete
on table public.course_authorized_emails
to authenticated;

grant all
on table public.course_authorized_emails
to service_role;

create policy "Course owners can read authorized emails"
on public.course_authorized_emails
for select
to authenticated
using (
  private.owns_course(course_id)
);

create policy "Course owners can add authorized emails"
on public.course_authorized_emails
for insert
to authenticated
with check (
  private.owns_course(course_id)
);

create policy "Course owners can remove authorized emails"
on public.course_authorized_emails
for delete
to authenticated
using (
  private.owns_course(course_id)
);

create or replace function private.is_course_member(p_course_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.course_members cm
    where cm.course_id = p_course_id
      and cm.student_id = (select auth.uid())
      and cm.status = 'active'
  );
$$;

create or replace function private.is_course_member_or_authorized(p_course_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    private.is_course_member(p_course_id)
    or exists (
      select 1
      from public.course_authorized_emails cae
      join auth.users u
        on u.id = (select auth.uid())
      where cae.course_id = p_course_id
        and u.email is not null
        and cae.email = pg_catalog.lower(pg_catalog.btrim(u.email))
    );
$$;

revoke all
on function private.is_course_member_or_authorized(uuid)
from public;

grant execute
on function private.is_course_member_or_authorized(uuid)
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
  v_existing_session_id uuid;
begin

  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  v_auth_session_id :=
    (auth.jwt() ->> 'session_id')::uuid;

  if v_auth_session_id is null then
    raise exception 'Sesión de autenticación inválida';
  end if;

  if not exists (
    select 1
    from auth.sessions s
    where s.id = v_auth_session_id
      and s.user_id = v_user_id
  ) then
    raise exception
      'La sesión de autenticación ya no es válida';
  end if;


  /*
   * Validar QR y recuperar también
   * la duración configurada por el docente.
   */
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
  join public.quizzes q
    on q.id = qs.quiz_id
  where qs.qr_token_hash =
    encode(
      extensions.digest(p_qr_token, 'sha256'),
      'hex'
    )
    and qs.status = 'active'
    and qs.starts_at <= now()
    and qs.expires_at > now()
    and q.status = 'published'
    and q.delivery_mode = 'in_person'
  limit 1;


  if v_quiz_session_id is null then
    raise exception 'QR inválido o expirado';
  end if;


  if v_duration_minutes is null
     or v_duration_minutes <= 0 then
    raise exception
      'El quiz no tiene una duración válida configurada';
  end if;


  if not private.is_course_member_or_authorized(v_course_id) then
    raise exception
      'El estudiante no está matriculado en este curso';
  end if;


  /*
   * Crear el intento.
   *
   * El deadline queda fijado en el instante
   * real en que el estudiante entra al quiz.
   */
  insert into public.attempts (
    quiz_id,
    student_id,
    quiz_session_id,
    status,
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
    v_auth_session_id,
    now(),
    now(),
    now(),
    now() + make_interval(
      mins => v_duration_minutes
    )
  )
  on conflict on constraint attempts_quiz_id_student_id_key
  do nothing;


  select
    a.id,
    a.status,
    a.active_session_id
  into
    v_attempt_id,
    v_attempt_status,
    v_existing_session_id
  from public.attempts a
  where a.quiz_id = v_quiz_id
    and a.student_id = v_user_id
  for update;


  if v_attempt_id is null then
    raise exception
      'No fue posible crear o recuperar el intento';
  end if;


  if v_attempt_status in ('submitted', 'graded') then
    raise exception
      'Este quiz ya fue finalizado';
  end if;


  if v_attempt_status = 'blocked' then
    raise exception
      'Este intento fue bloqueado por incidencias de integridad. Contacta al docente';
  end if;


  if v_attempt_status = 'expired' then
    raise exception
      'El tiempo disponible para este intento ya terminó';
  end if;


  if v_existing_session_id is not null
     and v_existing_session_id <> v_auth_session_id then

    if exists (
      select 1
      from auth.sessions s
      where s.id = v_existing_session_id
        and s.user_id = v_user_id
    ) then
      raise exception
        'Este intento ya está activo en otra sesión';
    end if;

  end if;


  /*
   * Una reentrada legítima NO reinicia:
   *
   * - started_at
   * - deadline_at
   */
  update public.attempts as a
  set
    active_session_id = v_auth_session_id,
    quiz_session_id = v_quiz_session_id,
    status = 'in_progress',
    session_started_at = now(),
    last_heartbeat_at = now(),
    deadline_at = coalesce(
      a.deadline_at,
      a.started_at + make_interval(
        mins => v_duration_minutes
      )
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

alter policy "Students can read enrolled courses"
on public.courses
using (
  private.is_course_member_or_authorized(id)
);

alter policy "Students can read published quizzes of enrolled courses"
on public.quizzes
using (
  status = any (array['published'::text, 'closed'::text])
  and private.is_course_member_or_authorized(course_id)
);
