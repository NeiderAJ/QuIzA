-- Owner-only live counters and result detail for synchronous V1.1 quizzes.

drop function if exists public.get_quiz_session_live_status(uuid);

create function public.get_quiz_session_live_status(
  p_quiz_session_id uuid
)
returns table (
  authorized_participants bigint,
  participants_entered bigint,
  active_devices bigint,
  attempts_in_progress bigint,
  attempts_finished bigint,
  attempts_blocked bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_course_id uuid;
begin
  select q.course_id
  into v_course_id
  from public.quiz_sessions qs
  join public.quizzes q on q.id = qs.quiz_id
  where qs.id = p_quiz_session_id
    and private.owns_course(q.course_id);

  if not found then
    raise exception using
      errcode = '42501',
      message = 'Sesión inexistente o no autorizada.';
  end if;

  return query
  select
    (
      select count(*)
      from public.course_authorized_emails cae
      where cae.course_id = v_course_id
    )::bigint,
    count(a.id)::bigint,
    count(a.id) filter (
      where a.status = 'in_progress'
        and a.last_heartbeat_at >= pg_catalog.now() - interval '20 seconds'
    )::bigint,
    count(a.id) filter (where a.status = 'in_progress')::bigint,
    count(a.id) filter (
      where a.status in ('submitted', 'graded', 'expired')
    )::bigint,
    count(a.id) filter (where a.status = 'blocked')::bigint
  from public.attempts a
  where a.quiz_session_id = p_quiz_session_id;
end;
$$;

revoke all on function public.get_quiz_session_live_status(uuid)
from public, anon;
grant execute on function public.get_quiz_session_live_status(uuid)
to authenticated;

create or replace function public.get_quiz_results(p_quiz_id uuid)
returns table (
  attempt_id uuid,
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
  expired_at timestamptz
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
    a.expired_at
  from public.attempts a
  join public.profiles p on p.id = a.student_id
  where a.quiz_id = p_quiz_id
  order by a.created_at, a.id;
end;
$$;

revoke all on function public.get_quiz_results(uuid) from public, anon;
grant execute on function public.get_quiz_results(uuid) to authenticated;

create or replace function public.get_attempt_result_detail(p_attempt_id uuid)
returns table (
  response_id uuid,
  slot_number integer,
  variant_number integer,
  question_statement text,
  options jsonb,
  correct_answer jsonb,
  answer_payload jsonb,
  response_status text,
  score numeric,
  feedback text,
  answered_at timestamptz,
  graded_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.attempts a
    join public.quizzes q on q.id = a.quiz_id
    where a.id = p_attempt_id
      and private.owns_course(q.course_id)
  ) then
    raise exception using
      errcode = '42501',
      message = 'Intento inexistente o no autorizado.';
  end if;

  return query
  select
    r.id,
    r.slot_number,
    q.variant_number,
    q.statement,
    q.options,
    q.correct_answer,
    r.answer_payload,
    r.status,
    r.score,
    r.feedback,
    r.answered_at,
    r.graded_at
  from public.responses r
  join public.questions q on q.id = r.question_id
  where r.attempt_id = p_attempt_id
  order by r.slot_number, r.assigned_at, r.id;
end;
$$;

revoke all on function public.get_attempt_result_detail(uuid)
from public, anon;
grant execute on function public.get_attempt_result_detail(uuid)
to authenticated;
