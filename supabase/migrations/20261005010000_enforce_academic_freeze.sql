-- Freeze the academic definition of a quiz as soon as its first attempt exists.
-- RLS gives authenticated owners an early rejection; triggers preserve the same
-- invariant for privileged backend writes and serialize it with attempt creation.

create or replace function private.quiz_has_attempts(p_quiz_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.attempts a
    where a.quiz_id = p_quiz_id
  );
$$;

revoke all on function private.quiz_has_attempts(uuid) from public;
grant execute on function private.quiz_has_attempts(uuid) to authenticated;

alter policy "Teachers can create questions in own quizzes"
on public.questions
with check (
  exists (
    select 1
    from public.quizzes q
    where q.id = questions.quiz_id
      and private.owns_course(q.course_id)
  )
  and not private.quiz_has_attempts(questions.quiz_id)
);

alter policy "Teachers can update questions of own quizzes"
on public.questions
using (
  exists (
    select 1
    from public.quizzes q
    where q.id = questions.quiz_id
      and private.owns_course(q.course_id)
  )
  and not private.quiz_has_attempts(questions.quiz_id)
)
with check (
  exists (
    select 1
    from public.quizzes q
    where q.id = questions.quiz_id
      and private.owns_course(q.course_id)
  )
  and not private.quiz_has_attempts(questions.quiz_id)
);

alter policy "Teachers can delete questions of own quizzes"
on public.questions
using (
  exists (
    select 1
    from public.quizzes q
    where q.id = questions.quiz_id
      and private.owns_course(q.course_id)
  )
  and not private.quiz_has_attempts(questions.quiz_id)
);

-- Deleting a used quiz would cascade to its attempts and questions, destroying
-- the academic history that this migration freezes.
alter policy "Teachers can delete quizzes of own courses"
on public.quizzes
using (
  private.owns_course(course_id)
  and not private.quiz_has_attempts(id)
);

create or replace function private.lock_quiz_before_attempt_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1
  from public.quizzes q
  where q.id = new.quiz_id
  for update;

  return new;
end;
$$;

revoke all on function private.lock_quiz_before_attempt_insert() from public;

create trigger attempts_lock_quiz_before_insert
before insert on public.attempts
for each row
execute function private.lock_quiz_before_attempt_insert();

create or replace function private.enforce_question_academic_freeze()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform 1
    from public.quizzes q
    where q.id = new.quiz_id
    for update;

    if exists (
      select 1
      from public.attempts a
      where a.quiz_id = new.quiz_id
    ) then
      raise exception using
        errcode = '55000',
        message = 'No se pueden agregar preguntas: la evaluación ya tiene intentos.';
    end if;

    return new;
  end if;

  if tg_op = 'UPDATE' then
    perform 1
    from public.quizzes q
    where q.id in (old.quiz_id, new.quiz_id)
    order by q.id
    for update;

    if exists (
      select 1
      from public.attempts a
      where a.quiz_id in (old.quiz_id, new.quiz_id)
    ) then
      raise exception using
        errcode = '55000',
        message = 'No se pueden modificar preguntas: la evaluación ya tiene intentos.';
    end if;

    return new;
  end if;

  perform 1
  from public.quizzes q
  where q.id = old.quiz_id
  for update;

  if exists (
    select 1
    from public.attempts a
    where a.quiz_id = old.quiz_id
  ) then
    raise exception using
      errcode = '55000',
      message = 'No se pueden eliminar preguntas: la evaluación ya tiene intentos.';
  end if;

  return old;
end;
$$;

revoke all on function private.enforce_question_academic_freeze() from public;

create trigger questions_enforce_academic_freeze
before insert or update or delete on public.questions
for each row
execute function private.enforce_question_academic_freeze();

create or replace function private.enforce_quiz_academic_freeze()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.attempts a
    where a.quiz_id = old.id
  ) then
    if tg_op = 'DELETE' then
      raise exception using
        errcode = '55000',
        message = 'No se puede eliminar una evaluación que ya tiene intentos.';
    end if;

    raise exception using
      errcode = '55000',
      message = 'No se pueden modificar campos académicos: la evaluación ya tiene intentos.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_quiz_academic_freeze() from public;

create trigger quizzes_enforce_academic_freeze_on_update
before update of
  course_id,
  source_document_id,
  title,
  instructions,
  opens_at,
  closes_at,
  duration_minutes,
  grade_scale_max,
  number_of_slots,
  variants_per_slot,
  focus_replacement,
  max_focus_violations,
  published_at,
  delivery_mode
on public.quizzes
for each row
when (
  old.course_id is distinct from new.course_id
  or old.source_document_id is distinct from new.source_document_id
  or old.title is distinct from new.title
  or old.instructions is distinct from new.instructions
  or old.opens_at is distinct from new.opens_at
  or old.closes_at is distinct from new.closes_at
  or old.duration_minutes is distinct from new.duration_minutes
  or old.grade_scale_max is distinct from new.grade_scale_max
  or old.number_of_slots is distinct from new.number_of_slots
  or old.variants_per_slot is distinct from new.variants_per_slot
  or old.focus_replacement is distinct from new.focus_replacement
  or old.max_focus_violations is distinct from new.max_focus_violations
  or old.published_at is distinct from new.published_at
  or old.delivery_mode is distinct from new.delivery_mode
)
execute function private.enforce_quiz_academic_freeze();

create or replace function private.enforce_used_quiz_status_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.attempts a
    where a.quiz_id = old.id
  ) and not (
    old.status = 'published'
    and new.status = 'closed'
  ) then
    raise exception using
      errcode = '55000',
      message = 'Una evaluación con intentos solo puede cambiar de published a closed.';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_used_quiz_status_transition() from public;

create trigger quizzes_enforce_used_status_transition
before update of status on public.quizzes
for each row
when (old.status is distinct from new.status)
execute function private.enforce_used_quiz_status_transition();

create trigger quizzes_enforce_academic_freeze_on_delete
before delete on public.quizzes
for each row
execute function private.enforce_quiz_academic_freeze();
