-- Allow an unused quiz to delete its generated variants through the existing
-- questions.quiz_id ON DELETE CASCADE relationship. Direct deletion of a
-- generated variant remains forbidden while its parent quiz exists.

create or replace function private.enforce_question_academic_freeze()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_has_generated_variants boolean := false;
  v_has_running_generation boolean := false;
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

    if old.variant_number = 1 then
      select exists (
        select 1
        from public.questions q
        where q.quiz_id = old.quiz_id
          and q.slot_number = old.slot_number
          and q.variant_number between 2 and 6
      )
      into v_has_generated_variants;

      select exists (
        select 1
        from public.llm_runs lr
        where lr.base_question_id = old.id
          and lr.purpose = 'quiz_generation'
          and lr.status = 'running'
      )
      into v_has_running_generation;
    end if;

    if (
      old.id is distinct from new.id
      or old.quiz_id is distinct from new.quiz_id
      or old.slot_number is distinct from new.slot_number
      or old.variant_number is distinct from new.variant_number
      or old.question_type is distinct from new.question_type
      or old.points is distinct from new.points
    ) and (
      old.variant_number between 2 and 6
      or new.variant_number between 2 and 6
      or v_has_generated_variants
      or v_has_running_generation
    ) then
      raise exception using
        errcode = '55000',
        message = 'No se puede modificar la estructura de un slot con variantes generadas.';
    end if;

    if new.question_type = 'multiple_choice'
      and (
        old.variant_number between 2 and 6
        or new.variant_number between 2 and 6
        or v_has_generated_variants
        or v_has_running_generation
      )
    then
      perform private.normalize_multiple_choice_payload(
        pg_catalog.jsonb_build_object(
          'statement', new.statement,
          'options', new.options,
          'correct_answer', new.correct_answer
        ),
        'La pregunta editada'
      );
    end if;

    return new;
  end if;

  -- A foreign-key cascade reaches this trigger after the parent quiz row is
  -- no longer visible. The quiz trigger has already rejected used quizzes, so
  -- this exception applies only to the intentional cleanup of an unused quiz.
  if not exists (
    select 1
    from public.quizzes q
    where q.id = old.quiz_id
  ) then
    return old;
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

  if old.variant_number between 2 and 6 then
    raise exception using
      errcode = '55000',
      message = 'Las variantes generadas no pueden eliminarse directamente.';
  end if;

  if old.variant_number = 1
    and exists (
      select 1
      from public.questions q
      where q.quiz_id = old.quiz_id
        and q.slot_number = old.slot_number
        and q.variant_number between 2 and 6
    )
  then
    raise exception using
      errcode = '55000',
      message = 'La pregunta base no puede eliminarse mientras tenga variantes generadas.';
  end if;

  if old.variant_number = 1
    and exists (
      select 1
      from public.llm_runs lr
      where lr.base_question_id = old.id
        and lr.purpose = 'quiz_generation'
        and lr.status = 'running'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'La pregunta base no puede eliminarse mientras tenga una generación en curso.';
  end if;

  return old;
end;
$$;

revoke all on function private.enforce_question_academic_freeze() from public;
