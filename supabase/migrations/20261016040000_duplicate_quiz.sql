-- Create an editable copy of a quiz without carrying over sessions, attempts,
-- responses or LLM execution history.

create or replace function public.duplicate_quiz(
  p_source_quiz_id uuid,
  p_title text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_source public.quizzes%rowtype;
  v_new_quiz_id uuid;
  v_title text;
begin
  if v_actor_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'Debes autenticarte para duplicar una evaluación.';
  end if;

  select q.*
  into v_source
  from public.quizzes q
  where q.id = p_source_quiz_id
  for share;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'La evaluación que se duplicará no existe.';
  end if;

  if not private.owns_course(v_source.course_id)
    or v_source.created_by <> v_actor_user_id
  then
    raise exception using
      errcode = '42501',
      message = 'No tienes permiso para duplicar esta evaluación.';
  end if;

  v_title := private.normalize_question_text(
    coalesce(nullif(p_title, ''), v_source.title || ' (copia)')
  );

  if v_title = '' or char_length(v_title) > 300 then
    raise exception using
      errcode = '22023',
      message = 'El título de la copia es inválido.';
  end if;

  insert into public.quizzes (
    course_id,
    source_document_id,
    created_by,
    title,
    instructions,
    status,
    opens_at,
    closes_at,
    duration_minutes,
    grade_scale_max,
    number_of_slots,
    variants_per_slot,
    focus_replacement,
    max_focus_violations,
    llm_provider,
    llm_model,
    published_at,
    delivery_mode
  )
  values (
    v_source.course_id,
    v_source.source_document_id,
    v_actor_user_id,
    v_title,
    v_source.instructions,
    'draft',
    v_source.opens_at,
    v_source.closes_at,
    v_source.duration_minutes,
    v_source.grade_scale_max,
    v_source.number_of_slots,
    v_source.variants_per_slot,
    v_source.focus_replacement,
    v_source.max_focus_violations,
    v_source.llm_provider,
    v_source.llm_model,
    null,
    v_source.delivery_mode
  )
  returning id into v_new_quiz_id;

  insert into public.questions (
    quiz_id,
    slot_number,
    variant_number,
    question_type,
    statement,
    options,
    correct_answer,
    rubric,
    points,
    source_reference
  )
  select
    v_new_quiz_id,
    q.slot_number,
    q.variant_number,
    q.question_type,
    q.statement,
    q.options,
    q.correct_answer,
    q.rubric,
    q.points,
    q.source_reference
  from public.questions q
  where q.quiz_id = p_source_quiz_id
  order by q.slot_number, q.variant_number;

  return v_new_quiz_id;
end;
$$;

revoke all on function public.duplicate_quiz(uuid, text) from public, anon;
grant execute on function public.duplicate_quiz(uuid, text) to authenticated;
