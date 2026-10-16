-- Regenerate one reviewed variant without replacing the other variants in its
-- slot. Reservations share the existing per-base lock and lease mechanism.

alter table public.llm_runs
  add column target_question_id uuid,
  add column target_question_hash text;

alter table public.llm_runs
  drop constraint llm_runs_generation_context_check;

alter table public.llm_runs
  add constraint llm_runs_generation_context_check
  check (
    purpose <> 'quiz_generation'
    or status <> 'running'
    or (
      teacher_id is not null
      and quiz_id is not null
      and base_question_id is not null
      and prompt_version is not null
      and base_question_hash is not null
      and lease_expires_at is not null
      and lease_expires_at > created_at
    )
  ) not valid;

alter table public.llm_runs
  add constraint llm_runs_target_question_id_fkey
  foreign key (target_question_id)
  references public.questions(id)
  on delete set null,
  add constraint llm_runs_target_question_hash_check
  check (
    target_question_hash is null
    or target_question_hash ~ '^[0-9a-f]{64}$'
  ),
  add constraint llm_runs_regeneration_target_check
  check (
    purpose <> 'quiz_generation'
    or status <> 'running'
    or (
      target_question_id is null
      and target_question_hash is null
    )
    or (
      target_question_id is not null
      and target_question_hash is not null
    )
  );

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

  if tg_op = 'DELETE'
    and exists (
      select 1
      from public.llm_runs lr
      where lr.quiz_id = old.id
        and lr.purpose = 'quiz_generation'
        and lr.status = 'running'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'No se puede eliminar una evaluación mientras genera variantes.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_quiz_academic_freeze() from public;

create or replace function public.reserve_variant_regeneration(
  p_actor_user_id uuid,
  p_target_question_id uuid,
  p_provider text,
  p_model text,
  p_prompt_version text
)
returns table (
  run_id uuid,
  quiz_id uuid,
  slot_number integer,
  target_variant_number integer,
  statement text,
  options jsonb,
  correct_answer jsonb,
  existing_variants jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quiz_id uuid;
  v_quiz_status text;
  v_quiz_created_by uuid;
  v_course_owner_id uuid;
  v_slot_number integer;
  v_target_variant_number integer;
  v_target_question_type text;
  v_base_question_id uuid;
  v_base_statement text;
  v_base_options jsonb;
  v_base_correct_answer jsonb;
  v_base_hash text;
  v_target_hash text;
  v_run_id uuid;
  v_lease_expires_at timestamptz;
  v_existing_variants jsonb;
begin
  if p_actor_user_id is null then
    raise exception using
      errcode = '28000',
      message = 'El actor autenticado es obligatorio.';
  end if;

  if p_target_question_id is null then
    raise exception using
      errcode = '22023',
      message = 'La variante que se regenerará es obligatoria.';
  end if;

  if p_provider is null
    or private.normalize_question_text(p_provider) = ''
    or char_length(private.normalize_question_text(p_provider)) > 100
    or p_model is null
    or private.normalize_question_text(p_model) = ''
    or char_length(private.normalize_question_text(p_model)) > 200
    or p_prompt_version is null
    or private.normalize_question_text(p_prompt_version) = ''
    or char_length(private.normalize_question_text(p_prompt_version)) > 100
  then
    raise exception using
      errcode = '22023',
      message = 'La configuración de generación es inválida.';
  end if;

  select
    q.quiz_id,
    q.slot_number,
    q.variant_number,
    q.question_type
  into
    v_quiz_id,
    v_slot_number,
    v_target_variant_number,
    v_target_question_type
  from public.questions q
  where q.id = p_target_question_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'La variante seleccionada no existe.';
  end if;

  if v_target_question_type <> 'multiple_choice'
    or v_target_variant_number not between 2 and 6
  then
    raise exception using
      errcode = '22023',
      message = 'Solo pueden regenerarse las variantes 2 a 6.';
  end if;

  select
    q.id,
    q.statement,
    q.options,
    q.correct_answer
  into
    v_base_question_id,
    v_base_statement,
    v_base_options,
    v_base_correct_answer
  from public.questions q
  where q.quiz_id = v_quiz_id
    and q.slot_number = v_slot_number
    and q.variant_number = 1
    and q.question_type = 'multiple_choice'
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'La pregunta base del slot no existe.';
  end if;

  select q.status, q.created_by, c.teacher_id
  into v_quiz_status, v_quiz_created_by, v_course_owner_id
  from public.quizzes q
  join public.courses c on c.id = q.course_id
  where q.id = v_quiz_id
  for update of q;

  if v_quiz_created_by <> p_actor_user_id
    or v_course_owner_id <> p_actor_user_id
  then
    raise exception using
      errcode = '42501',
      message = 'No tienes permiso para regenerar variantes de esta evaluación.';
  end if;

  if v_quiz_status not in ('draft', 'published') then
    raise exception using
      errcode = '55000',
      message = 'La evaluación no está editable para regenerar variantes.';
  end if;

  if exists (
    select 1
    from public.attempts a
    where a.quiz_id = v_quiz_id
  ) then
    raise exception using
      errcode = '55000',
      message = 'No se pueden regenerar variantes: la evaluación ya tiene intentos.';
  end if;

  if (
    select count(*)
    from public.questions q
    where q.quiz_id = v_quiz_id
      and q.slot_number = v_slot_number
      and q.variant_number between 1 and 6
  ) <> 6 then
    raise exception using
      errcode = '55000',
      message = 'El slot debe conservar seis variantes antes de regenerar una.';
  end if;

  perform private.normalize_multiple_choice_payload(
    pg_catalog.jsonb_build_object(
      'statement', v_base_statement,
      'options', v_base_options,
      'correct_answer', v_base_correct_answer
    ),
    'La pregunta base'
  );

  update public.llm_runs lr
  set
    status = 'error',
    error_message = 'La generación expiró antes de completarse.',
    result_metadata = private.sanitize_llm_result_metadata(
      pg_catalog.jsonb_build_object(
        'provider_status', 'stale',
        'error_code', 'generation_lease_expired'
      )
    )
  where lr.base_question_id = v_base_question_id
    and lr.purpose = 'quiz_generation'
    and lr.status = 'running'
    and (
      lr.lease_expires_at is null
      or lr.lease_expires_at <= pg_catalog.clock_timestamp()
    );

  if exists (
    select 1
    from public.llm_runs lr
    where lr.base_question_id = v_base_question_id
      and lr.purpose = 'quiz_generation'
      and lr.status = 'running'
  ) then
    raise exception using
      errcode = '55000',
      message = 'Ya existe una generación de variantes en curso para esta pregunta.';
  end if;

  v_base_hash := private.question_academic_hash(v_base_question_id);
  v_target_hash := private.question_academic_hash(p_target_question_id);
  v_lease_expires_at := pg_catalog.statement_timestamp() + interval '15 minutes';

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'variant_number', q.variant_number,
      'statement', q.statement,
      'options', q.options,
      'correct_answer', q.correct_answer
    )
    order by q.variant_number
  )
  into v_existing_variants
  from public.questions q
  where q.quiz_id = v_quiz_id
    and q.slot_number = v_slot_number
    and q.id <> p_target_question_id;

  insert into public.llm_runs (
    teacher_id,
    quiz_id,
    base_question_id,
    target_question_id,
    purpose,
    provider,
    model,
    status,
    prompt_version,
    base_question_hash,
    target_question_hash,
    lease_expires_at
  )
  values (
    p_actor_user_id,
    v_quiz_id,
    v_base_question_id,
    p_target_question_id,
    'quiz_generation',
    private.normalize_question_text(p_provider),
    private.normalize_question_text(p_model),
    'running',
    private.normalize_question_text(p_prompt_version),
    v_base_hash,
    v_target_hash,
    v_lease_expires_at
  )
  returning id into v_run_id;

  return query
  select
    v_run_id,
    v_quiz_id,
    v_slot_number,
    v_target_variant_number,
    v_base_statement,
    v_base_options,
    v_base_correct_answer,
    v_existing_variants;
end;
$$;

revoke all on function public.reserve_variant_regeneration(
  uuid, uuid, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.reserve_variant_regeneration(
  uuid, uuid, text, text, text
) to service_role;

create or replace function public.complete_variant_regeneration(
  p_actor_user_id uuid,
  p_run_id uuid,
  p_variants jsonb,
  p_input_tokens integer,
  p_output_tokens integer,
  p_latency_ms integer,
  p_result_metadata jsonb
)
returns table (
  run_id uuid,
  quiz_id uuid,
  slot_number integer,
  variant_number integer,
  status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quiz_id uuid;
  v_base_question_id uuid;
  v_target_question_id uuid;
  v_reserved_base_hash text;
  v_reserved_target_hash text;
  v_lease_expires_at timestamptz;
  v_quiz_status text;
  v_quiz_created_by uuid;
  v_course_owner_id uuid;
  v_slot_number integer;
  v_variant_number integer;
  v_base_statement text;
  v_base_options jsonb;
  v_base_correct_answer jsonb;
  v_variant jsonb;
  v_normalized_base jsonb;
  v_normalized_variant jsonb;
  v_other_question record;
  v_normalized_other jsonb;
begin
  if p_actor_user_id is null or p_run_id is null then
    raise exception using
      errcode = '22023',
      message = 'El actor y la ejecución son obligatorios.';
  end if;

  if p_input_tokens is not null and p_input_tokens < 0
    or p_output_tokens is not null and p_output_tokens < 0
    or p_latency_ms is not null and p_latency_ms < 0
  then
    raise exception using
      errcode = '22023',
      message = 'Tokens y latencia no pueden ser negativos.';
  end if;

  select lr.quiz_id, lr.base_question_id, lr.target_question_id
  into v_quiz_id, v_base_question_id, v_target_question_id
  from public.llm_runs lr
  where lr.id = p_run_id
    and lr.teacher_id = p_actor_user_id
    and lr.purpose = 'quiz_generation'
    and lr.status = 'running'
    and lr.target_question_id is not null;

  if not found then
    raise exception using
      errcode = '55000',
      message = 'La regeneración no existe, no pertenece al actor o ya no está en curso.';
  end if;

  perform 1
  from public.questions q
  where q.id in (v_base_question_id, v_target_question_id)
  order by q.id
  for update;

  select q.statement, q.options, q.correct_answer
  into v_base_statement, v_base_options, v_base_correct_answer
  from public.questions q
  where q.id = v_base_question_id
    and q.quiz_id = v_quiz_id
    and q.variant_number = 1
    and q.question_type = 'multiple_choice';

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'La pregunta base ya no existe o dejó de ser válida.';
  end if;

  select q.slot_number, q.variant_number
  into v_slot_number, v_variant_number
  from public.questions q
  where q.id = v_target_question_id
    and q.quiz_id = v_quiz_id
    and q.variant_number between 2 and 6
    and q.question_type = 'multiple_choice';

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'La variante seleccionada ya no existe o dejó de ser válida.';
  end if;

  select q.status, q.created_by, c.teacher_id
  into v_quiz_status, v_quiz_created_by, v_course_owner_id
  from public.quizzes q
  join public.courses c on c.id = q.course_id
  where q.id = v_quiz_id
  for update of q;

  select
    lr.base_question_hash,
    lr.target_question_hash,
    lr.lease_expires_at
  into
    v_reserved_base_hash,
    v_reserved_target_hash,
    v_lease_expires_at
  from public.llm_runs lr
  where lr.id = p_run_id
    and lr.teacher_id = p_actor_user_id
    and lr.status = 'running'
  for update;

  if v_quiz_created_by <> p_actor_user_id
    or v_course_owner_id <> p_actor_user_id
  then
    raise exception using
      errcode = '42501',
      message = 'El actor no tiene permiso para completar esta regeneración.';
  end if;

  if v_quiz_status not in ('draft', 'published')
    or exists (
      select 1 from public.attempts a where a.quiz_id = v_quiz_id
    )
  then
    raise exception using
      errcode = '55000',
      message = 'La evaluación ya no está editable para regenerar variantes.';
  end if;

  if v_lease_expires_at is null
    or v_lease_expires_at <= pg_catalog.clock_timestamp()
  then
    raise exception using
      errcode = '55000',
      message = 'La reserva de regeneración expiró.';
  end if;

  if private.question_academic_hash(v_base_question_id)
      is distinct from v_reserved_base_hash
    or private.question_academic_hash(v_target_question_id)
      is distinct from v_reserved_target_hash
  then
    raise exception using
      errcode = '55000',
      message = 'La pregunta o la variante cambió durante la regeneración.';
  end if;

  if pg_catalog.jsonb_typeof(p_variants) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_variants) <> 1
  then
    raise exception using
      errcode = '22023',
      message = 'La regeneración requiere exactamente una variante.';
  end if;

  v_variant := p_variants -> 0;
  v_normalized_base := private.normalize_multiple_choice_payload(
    pg_catalog.jsonb_build_object(
      'statement', v_base_statement,
      'options', v_base_options,
      'correct_answer', v_base_correct_answer
    ),
    'La pregunta base'
  );
  v_normalized_variant := private.normalize_multiple_choice_payload(
    v_variant,
    'La variante regenerada'
  );

  if v_normalized_variant = v_normalized_base then
    raise exception using
      errcode = '22023',
      message = 'La variante regenerada es idéntica a la pregunta base.';
  end if;

  for v_other_question in
    select q.variant_number, q.statement, q.options, q.correct_answer
    from public.questions q
    where q.quiz_id = v_quiz_id
      and q.slot_number = v_slot_number
      and q.id <> v_target_question_id
    order by q.variant_number
  loop
    v_normalized_other := private.normalize_multiple_choice_payload(
      pg_catalog.jsonb_build_object(
        'statement', v_other_question.statement,
        'options', v_other_question.options,
        'correct_answer', v_other_question.correct_answer
      ),
      pg_catalog.format('La variante existente %s', v_other_question.variant_number)
    );

    if v_normalized_variant = v_normalized_other then
      raise exception using
        errcode = '22023',
        message = 'La variante regenerada duplica otra variante del slot.';
    end if;
  end loop;

  update public.questions q
  set
    statement = v_normalized_variant ->> 'statement',
    options = v_normalized_variant -> 'options',
    correct_answer = v_normalized_variant -> 'correct_answer'
  where q.id = v_target_question_id;

  update public.llm_runs lr
  set
    status = 'success',
    input_tokens = p_input_tokens,
    output_tokens = p_output_tokens,
    latency_ms = p_latency_ms,
    result_metadata = private.sanitize_llm_result_metadata(p_result_metadata),
    error_message = null
  where lr.id = p_run_id;

  return query
  select
    p_run_id,
    v_quiz_id,
    v_slot_number,
    v_variant_number,
    'success'::text;
end;
$$;

revoke all on function public.complete_variant_regeneration(
  uuid, uuid, jsonb, integer, integer, integer, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.complete_variant_regeneration(
  uuid, uuid, jsonb, integer, integer, integer, jsonb
) to service_role;
