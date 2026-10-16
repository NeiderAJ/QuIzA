-- Publish a V1.1 quiz only when every logical question has exactly six valid
-- multiple-choice variants. The same validation protects direct table updates,
-- while any later content edit returns an unused published quiz to draft.

alter policy "Teachers can create quizzes in own courses"
on public.quizzes
to authenticated
with check (
  created_by = (select auth.uid())
  and private.owns_course(course_id)
  and status = 'draft'
);

create or replace function private.validate_quiz_for_publication(
  p_quiz_id uuid
)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_slot_count integer;
  v_min_slot integer;
  v_max_slot integer;
  v_question record;
begin
  select
    pg_catalog.count(distinct q.slot_number)::integer,
    pg_catalog.min(q.slot_number),
    pg_catalog.max(q.slot_number)
  into v_slot_count, v_min_slot, v_max_slot
  from public.questions q
  where q.quiz_id = p_quiz_id;

  if coalesce(v_slot_count, 0) = 0 then
    raise exception using
      errcode = '22023',
      message = 'La evaluación necesita al menos una pregunta para publicarse.';
  end if;

  if v_min_slot <> 1 or v_max_slot <> v_slot_count then
    raise exception using
      errcode = '22023',
      message = 'Las preguntas de la evaluación deben estar numeradas consecutivamente desde 1.';
  end if;

  if exists (
    select 1
    from public.questions q
    where q.quiz_id = p_quiz_id
    group by q.slot_number
    having pg_catalog.count(*) <> 6
      or pg_catalog.count(distinct q.variant_number) <> 6
      or pg_catalog.min(q.variant_number) <> 1
      or pg_catalog.max(q.variant_number) <> 6
  ) then
    raise exception using
      errcode = '22023',
      message = 'Cada pregunta debe tener exactamente las variantes 1 a 6 antes de publicar.';
  end if;

  for v_question in
    select
      q.slot_number,
      q.variant_number,
      q.question_type,
      q.statement,
      q.options,
      q.correct_answer
    from public.questions q
    where q.quiz_id = p_quiz_id
    order by q.slot_number, q.variant_number
  loop
    if v_question.question_type <> 'multiple_choice' then
      raise exception using
        errcode = '22023',
        message = pg_catalog.format(
          'La pregunta %s, variante %s, usa un tipo no publicable en V1.1.',
          v_question.slot_number,
          v_question.variant_number
        );
    end if;

    perform private.normalize_multiple_choice_payload(
      pg_catalog.jsonb_build_object(
        'statement', v_question.statement,
        'options', v_question.options,
        'correct_answer', v_question.correct_answer
      ),
      pg_catalog.format(
        'La pregunta %s, variante %s',
        v_question.slot_number,
        v_question.variant_number
      )
    );
  end loop;

  return v_slot_count;
end;
$$;

revoke all on function private.validate_quiz_for_publication(uuid)
from public, anon, authenticated, service_role;

create or replace function private.return_quiz_to_draft_before_question_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    update public.quizzes q
    set
      status = 'draft',
      published_at = null
    where q.id = new.quiz_id
      and q.status = 'published';

    return new;
  end if;

  if tg_op = 'UPDATE' then
    update public.quizzes q
    set
      status = 'draft',
      published_at = null
    where q.id in (old.quiz_id, new.quiz_id)
      and q.status = 'published';

    return new;
  end if;

  update public.quizzes q
  set
    status = 'draft',
    published_at = null
  where q.id = old.quiz_id
    and q.status = 'published';

  return old;
end;
$$;

revoke all on function private.return_quiz_to_draft_before_question_change()
from public, anon, authenticated, service_role;

create trigger questions_return_quiz_to_draft_before_change
before insert or update or delete on public.questions
for each row
execute function private.return_quiz_to_draft_before_question_change();

create or replace function private.enforce_used_quiz_status_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_number_of_slots integer;
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

  if new.status = 'published' then
    v_number_of_slots := private.validate_quiz_for_publication(new.id);
    new.number_of_slots := v_number_of_slots;
    new.variants_per_slot := 6;
    new.published_at := coalesce(new.published_at, pg_catalog.clock_timestamp());
  elsif new.status = 'draft' then
    new.published_at := null;
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_used_quiz_status_transition()
from public, anon, authenticated, service_role;

create or replace function public.publish_quiz(p_quiz_id uuid)
returns table (
  quiz_id uuid,
  status text,
  published_at timestamptz,
  number_of_slots integer,
  variants_per_slot integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_course_id uuid;
  v_status text;
  v_number_of_slots integer;
begin
  if (select auth.uid()) is null then
    raise exception using
      errcode = '42501',
      message = 'Debes autenticarte para publicar una evaluación.';
  end if;

  select q.course_id, q.status
  into v_course_id, v_status
  from public.quizzes q
  where q.id = p_quiz_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'La evaluación no existe.';
  end if;

  if not private.owns_course(v_course_id) then
    raise exception using
      errcode = '42501',
      message = 'No tienes permiso para publicar esta evaluación.';
  end if;

  if v_status = 'closed' then
    raise exception using
      errcode = '55000',
      message = 'Una evaluación cerrada no puede publicarse nuevamente.';
  end if;

  if exists (
    select 1
    from public.attempts a
    where a.quiz_id = p_quiz_id
  ) then
    raise exception using
      errcode = '55000',
      message = 'No se puede publicar nuevamente una evaluación con intentos.';
  end if;

  v_number_of_slots := private.validate_quiz_for_publication(p_quiz_id);

  update public.quizzes q
  set
    status = 'published',
    published_at = pg_catalog.clock_timestamp(),
    number_of_slots = v_number_of_slots,
    variants_per_slot = 6
  where q.id = p_quiz_id;

  return query
  select
    q.id,
    q.status,
    q.published_at,
    q.number_of_slots,
    q.variants_per_slot
  from public.quizzes q
  where q.id = p_quiz_id;
end;
$$;

revoke all on function public.publish_quiz(uuid) from public, anon;
grant execute on function public.publish_quiz(uuid) to authenticated;
