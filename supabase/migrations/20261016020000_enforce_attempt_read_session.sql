-- An active attempt is readable only from the authentication session that owns
-- it. Terminal attempts remain available to the same user from later sessions
-- so grades and history can still be consulted.

create or replace function private.current_auth_session_id()
returns uuid
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  return nullif((select auth.jwt()) ->> 'session_id', '')::uuid;
exception
  when invalid_text_representation then
    return null;
end;
$$;

revoke all on function private.current_auth_session_id()
from public, anon, authenticated, service_role;
grant execute on function private.current_auth_session_id() to authenticated;

create or replace function private.student_can_read_attempt(
  p_student_id uuid,
  p_status text,
  p_active_session_id uuid
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select
    p_student_id = (select auth.uid())
    and (
      p_status not in ('not_started', 'in_progress')
      or p_active_session_id = private.current_auth_session_id()
    );
$$;

revoke all on function private.student_can_read_attempt(uuid, text, uuid)
from public, anon, authenticated, service_role;
grant execute on function private.student_can_read_attempt(uuid, text, uuid)
to authenticated;

create or replace function private.student_can_read_attempt_by_id(
  p_attempt_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.attempts a
    where a.id = p_attempt_id
      and private.student_can_read_attempt(
        a.student_id,
        a.status,
        a.active_session_id
      )
  );
$$;

revoke all on function private.student_can_read_attempt_by_id(uuid)
from public, anon, authenticated, service_role;
grant execute on function private.student_can_read_attempt_by_id(uuid)
to authenticated;

alter policy "Students can read own attempts"
on public.attempts
to authenticated
using (
  private.student_can_read_attempt(
    student_id,
    status,
    active_session_id
  )
);

alter policy "Students can read own responses"
on public.responses
to authenticated
using (private.student_can_read_attempt_by_id(attempt_id));

alter policy "Students can read own focus events"
on public.focus_events
to authenticated
using (private.student_can_read_attempt_by_id(attempt_id));
