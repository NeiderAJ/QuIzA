-- Optional display name for bulk imports; authorization remains email-based.

alter table public.course_authorized_emails
add column participant_name text;

alter table public.course_authorized_emails
add constraint course_authorized_emails_participant_name_not_blank
check (participant_name is null or btrim(participant_name) <> '');

create or replace function private.normalize_course_authorized_email()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.email := lower(btrim(new.email));
  new.participant_name := nullif(btrim(new.participant_name), '');
  return new;
end;
$$;
