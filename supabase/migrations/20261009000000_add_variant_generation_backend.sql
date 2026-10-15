-- Reserve and atomically persist AI-generated variants 2-6.
-- Provider calls remain outside PostgreSQL; this migration only owns
-- authorization, concurrency, deterministic validation and persistence.

alter table public.llm_runs
  drop constraint llm_runs_status_check;

alter table public.llm_runs
  add constraint llm_runs_status_check
  check (status = any (array['running'::text, 'success'::text, 'error'::text]));

alter table public.llm_runs
  add column base_question_id uuid,
  add column prompt_version text,
  add column base_question_hash text,
  add column lease_expires_at timestamp with time zone;

alter table public.llm_runs
  add constraint llm_runs_base_question_id_fkey
  foreign key (base_question_id)
  references public.questions(id)
  on delete set null,
  add constraint llm_runs_prompt_version_check
  check (
    prompt_version is null
    or char_length(btrim(prompt_version)) between 1 and 100
  ),
  add constraint llm_runs_base_question_hash_check
  check (
    base_question_hash is null
    or base_question_hash ~ '^[0-9a-f]{64}$'
  ),
  add constraint llm_runs_generation_context_check
  check (
    purpose <> 'quiz_generation'
    or status = 'error'
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

create unique index llm_runs_one_running_generation_per_base
on public.llm_runs (base_question_id)
where purpose = 'quiz_generation'
  and status = 'running'
  and base_question_id is not null;

-- Keep historical rows with variant numbers above 6 readable if they exist,
-- while rejecting every new or updated row outside the V1.1 range.
alter table public.questions
  add constraint questions_variant_number_max_check
  check (variant_number <= 6)
  not valid;

do $$
begin
  if not exists (
    select 1
    from public.questions q
    where q.variant_number > 6
  ) then
    alter table public.questions
      validate constraint questions_variant_number_max_check;
  end if;
end;
$$;

create or replace function public.reserve_variant_generation(
  p_actor_user_id uuid,
  p_base_question_id uuid,
  p_provider text,
  p_model text,
  p_prompt_version text
)
returns table (
  run_id uuid,
  quiz_id uuid,
  slot_number integer,
  statement text,
  options jsonb,
  correct_answer jsonb,
  points numeric
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
  v_variant_number integer;
  v_question_type text;
  v_statement text;
  v_options jsonb;
  v_correct_answer jsonb;
  v_points numeric;
  v_question_hash text;
  v_run_id uuid;
  v_lease_expires_at timestamp with time zone;
begin
  if p_actor_user_id is null then
    raise exception using
      errcode = '28000',
      message = 'El actor autenticado es obligatorio.';
  end if;

  if p_base_question_id is null then
    raise exception using
      errcode = '22023',
      message = 'La pregunta base es obligatoria.';
  end if;

  if p_provider is null
    or private.normalize_question_text(p_provider) = ''
    or char_length(private.normalize_question_text(p_provider)) > 100
  then
    raise exception using
      errcode = '22023',
      message = 'El proveedor de IA es inválido.';
  end if;

  if p_model is null
    or private.normalize_question_text(p_model) = ''
    or char_length(private.normalize_question_text(p_model)) > 200
  then
    raise exception using
      errcode = '22023',
      message = 'El modelo de IA es inválido.';
  end if;

  if p_prompt_version is null
    or private.normalize_question_text(p_prompt_version) = ''
    or char_length(private.normalize_question_text(p_prompt_version)) > 100
  then
    raise exception using
      errcode = '22023',
      message = 'La versión del prompt es inválida.';
  end if;

  -- Lock order starts with the question row to match direct question edits.
  select
    q.quiz_id,
    q.slot_number,
    q.variant_number,
    q.question_type,
    q.statement,
    q.options,
    q.correct_answer,
    q.points
  into
    v_quiz_id,
    v_slot_number,
    v_variant_number,
    v_question_type,
    v_statement,
    v_options,
    v_correct_answer,
    v_points
  from public.questions q
  where q.id = p_base_question_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Pregunta base inexistente.';
  end if;

  select
    q.status,
    q.created_by,
    c.teacher_id
  into
    v_quiz_status,
    v_quiz_created_by,
    v_course_owner_id
  from public.quizzes q
  join public.courses c
    on c.id = q.course_id
  where q.id = v_quiz_id
  for update of q;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Evaluación inexistente.';
  end if;

  if v_quiz_created_by <> p_actor_user_id
    or v_course_owner_id <> p_actor_user_id
  then
    raise exception using
      errcode = '42501',
      message = 'No tienes permiso para generar variantes de esta evaluación.';
  end if;

  if v_quiz_status not in ('draft', 'published') then
    raise exception using
      errcode = '55000',
      message = 'La evaluación no está editable para generar variantes.';
  end if;

  if v_question_type <> 'multiple_choice'
    or v_variant_number <> 1
  then
    raise exception using
      errcode = '22023',
      message = 'Solo una pregunta base de selección múltiple puede generar variantes.';
  end if;

  perform private.normalize_multiple_choice_payload(
    pg_catalog.jsonb_build_object(
      'statement', v_statement,
      'options', v_options,
      'correct_answer', v_correct_answer
    ),
    'La pregunta base'
  );

  if exists (
    select 1
    from public.attempts a
    where a.quiz_id = v_quiz_id
  ) then
    raise exception using
      errcode = '55000',
      message = 'No se pueden generar variantes: la evaluación ya tiene intentos.';
  end if;

  if exists (
    select 1
    from public.questions q
    where q.quiz_id = v_quiz_id
      and q.slot_number = v_slot_number
      and q.id <> p_base_question_id
  ) then
    raise exception using
      errcode = '55000',
      message = 'El slot ya tiene variantes adicionales.';
  end if;

  -- Expired reservations are recovered while holding question and quiz locks.
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
  where lr.base_question_id = p_base_question_id
    and lr.purpose = 'quiz_generation'
    and lr.status = 'running'
    and (
      lr.lease_expires_at is null
      or lr.lease_expires_at <= pg_catalog.clock_timestamp()
    );

  if exists (
    select 1
    from public.llm_runs lr
    where lr.base_question_id = p_base_question_id
      and lr.purpose = 'quiz_generation'
      and lr.status = 'running'
  ) then
    raise exception using
      errcode = '55000',
      message = 'Ya existe una generación de variantes en curso para esta pregunta.';
  end if;

  v_question_hash := private.question_academic_hash(p_base_question_id);
  v_lease_expires_at := pg_catalog.statement_timestamp() + interval '15 minutes';

  insert into public.llm_runs (
    teacher_id,
    quiz_id,
    base_question_id,
    purpose,
    provider,
    model,
    status,
    prompt_version,
    base_question_hash,
    lease_expires_at
  )
  values (
    p_actor_user_id,
    v_quiz_id,
    p_base_question_id,
    'quiz_generation',
    private.normalize_question_text(p_provider),
    private.normalize_question_text(p_model),
    'running',
    private.normalize_question_text(p_prompt_version),
    v_question_hash,
    v_lease_expires_at
  )
  returning id into v_run_id;

  return query
  select
    v_run_id,
    v_quiz_id,
    v_slot_number,
    v_statement,
    v_options,
    v_correct_answer,
    v_points;
end;
$$;

revoke all on function public.reserve_variant_generation(uuid, uuid, text, text, text)
from public, anon, authenticated, service_role;
grant execute on function public.reserve_variant_generation(uuid, uuid, text, text, text)
to service_role;

-- Browser clients may create only the canonical variant. Generated variants
-- are inserted by the server-only completion RPC. UPDATE remains available for
-- human review, while the trigger below protects the structural slot fields.
alter policy "Teachers can create questions in own quizzes"
on public.questions
to authenticated
with check (
  questions.variant_number = 1
  and exists (
    select 1
    from public.quizzes q
    where q.id = questions.quiz_id
      and private.owns_course(q.course_id)
  )
  and not private.quiz_has_attempts(questions.quiz_id)
);

-- V1.1 lets any resource owner act as evaluator. Reading one's own execution
-- history must not depend on the legacy profiles.is_teacher flag.
alter policy "Teachers can read own llm runs"
on public.llm_runs
to authenticated
using (llm_runs.teacher_id = (select auth.uid()));

create or replace function private.normalize_question_text(p_text text)
returns text
language sql
immutable
strict
security invoker
set search_path = ''
as $$
  select pg_catalog.btrim(
    pg_catalog.regexp_replace(
      pg_catalog.replace(
        pg_catalog.replace(
          pg_catalog.replace(
            pg_catalog.replace(
              pg_catalog.replace(p_text, pg_catalog.chr(160), ' '),
              pg_catalog.chr(8203),
              ' '
            ),
            pg_catalog.chr(8239),
            ' '
          ),
          pg_catalog.chr(12288),
          ' '
        ),
        pg_catalog.chr(65279),
        ' '
      ),
      '[[:space:]]+',
      ' ',
      'g'
    )
  );
$$;

revoke all on function private.normalize_question_text(text)
from public, anon, authenticated, service_role;

create or replace function private.normalize_multiple_choice_payload(
  p_payload jsonb,
  p_context text
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v_context text := coalesce(nullif(p_context, ''), 'La pregunta');
  v_statement text;
  v_option jsonb;
  v_option_ids text[] := array[]::text[];
  v_option_texts text[] := array[]::text[];
  v_option_id text;
  v_option_text text;
  v_normalized_options jsonb;
  v_correct_answer jsonb;
  v_selected_option text;
begin
  if pg_catalog.jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception using
      errcode = '22023',
      message = format('%s debe ser un objeto JSON.', v_context);
  end if;

  if pg_catalog.octet_length(p_payload::text) > 50000 then
    raise exception using
      errcode = '22023',
      message = format('%s excede el tamaño permitido.', v_context);
  end if;

  if not (p_payload ? 'statement')
    or not (p_payload ? 'options')
    or not (p_payload ? 'correct_answer')
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(p_payload) as key_name
      where key_name not in ('statement', 'options', 'correct_answer')
    )
  then
    raise exception using
      errcode = '22023',
      message = format('%s tiene una estructura inválida.', v_context);
  end if;

  if pg_catalog.jsonb_typeof(p_payload -> 'statement') <> 'string' then
    raise exception using
      errcode = '22023',
      message = format('El enunciado de %s es inválido.', lower(v_context));
  end if;

  v_statement := private.normalize_question_text(p_payload ->> 'statement');

  if v_statement = '' then
    raise exception using
      errcode = '22023',
      message = format('El enunciado de %s está vacío.', lower(v_context));
  end if;

  if char_length(v_statement) > 4000 then
    raise exception using
      errcode = '22023',
      message = format('El enunciado de %s excede 4000 caracteres.', lower(v_context));
  end if;

  if pg_catalog.jsonb_typeof(p_payload -> 'options') <> 'array'
    or pg_catalog.jsonb_array_length(p_payload -> 'options') <> 4
  then
    raise exception using
      errcode = '22023',
      message = format('%s debe tener exactamente cuatro opciones.', v_context);
  end if;

  for v_option in
    select option_item.value
    from pg_catalog.jsonb_array_elements(p_payload -> 'options')
      as option_item(value)
  loop
    if pg_catalog.jsonb_typeof(v_option) <> 'object'
      or not (v_option ? 'id')
      or not (v_option ? 'text')
      or exists (
        select 1
        from pg_catalog.jsonb_object_keys(v_option) as key_name
        where key_name not in ('id', 'text')
      )
      or pg_catalog.jsonb_typeof(v_option -> 'id') <> 'string'
      or pg_catalog.jsonb_typeof(v_option -> 'text') <> 'string'
    then
      raise exception using
        errcode = '22023',
        message = format('%s contiene una opción con estructura inválida.', v_context);
    end if;

    v_option_id := v_option ->> 'id';
    v_option_text := private.normalize_question_text(v_option ->> 'text');

    if v_option_id not in ('A', 'B', 'C', 'D') then
      raise exception using
        errcode = '22023',
        message = format('%s contiene un ID de opción inválido.', v_context);
    end if;

    if v_option_text = '' then
      raise exception using
        errcode = '22023',
        message = format('%s contiene una opción vacía.', v_context);
    end if;

    if char_length(v_option_text) > 1000 then
      raise exception using
        errcode = '22023',
        message = format('%s contiene una opción que excede 1000 caracteres.', v_context);
    end if;

    if v_option_id = any (v_option_ids) then
      raise exception using
        errcode = '22023',
        message = format('%s repite un ID de opción.', v_context);
    end if;

    if v_option_text = any (v_option_texts) then
      raise exception using
        errcode = '22023',
        message = format('%s contiene opciones duplicadas.', v_context);
    end if;

    v_option_ids := pg_catalog.array_append(v_option_ids, v_option_id);
    v_option_texts := pg_catalog.array_append(v_option_texts, v_option_text);
  end loop;

  v_correct_answer := p_payload -> 'correct_answer';

  if pg_catalog.jsonb_typeof(v_correct_answer) <> 'object'
    or not (v_correct_answer ? 'selected_option')
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(v_correct_answer) as key_name
      where key_name <> 'selected_option'
    )
    or pg_catalog.jsonb_typeof(v_correct_answer -> 'selected_option') <> 'string'
  then
    raise exception using
      errcode = '22023',
      message = format('La respuesta correcta de %s es inválida.', lower(v_context));
  end if;

  v_selected_option := v_correct_answer ->> 'selected_option';

  if v_selected_option not in ('A', 'B', 'C', 'D') then
    raise exception using
      errcode = '22023',
      message = format(
        'La respuesta correcta de %s no corresponde a A, B, C o D.',
        lower(v_context)
      );
  end if;

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'id', option_item.value ->> 'id',
      'text', private.normalize_question_text(option_item.value ->> 'text')
    )
    order by option_item.value ->> 'id'
  )
  into v_normalized_options
  from pg_catalog.jsonb_array_elements(p_payload -> 'options')
    as option_item(value);

  return pg_catalog.jsonb_build_object(
    'statement', v_statement,
    'options', v_normalized_options,
    'correct_answer', pg_catalog.jsonb_build_object(
      'selected_option', v_selected_option
    )
  );
end;
$$;

revoke all on function private.normalize_multiple_choice_payload(jsonb, text)
from public, anon, authenticated, service_role;

create or replace function private.question_academic_hash(p_question_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'quiz_id', q.quiz_id,
          'slot_number', q.slot_number,
          'variant_number', q.variant_number,
          'question_type', q.question_type,
          'statement', q.statement,
          'options', q.options,
          'correct_answer', q.correct_answer,
          'rubric', q.rubric,
          'points', q.points,
          'source_reference', q.source_reference
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
  from public.questions q
  where q.id = p_question_id;
$$;

revoke all on function private.question_academic_hash(uuid)
from public, anon, authenticated, service_role;

create or replace function private.sanitize_llm_result_metadata(p_metadata jsonb)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v_sanitized jsonb := '{}'::jsonb;
begin
  if p_metadata is null then
    return null;
  end if;

  if pg_catalog.jsonb_typeof(p_metadata) <> 'object' then
    raise exception using
      errcode = '22023',
      message = 'result_metadata debe ser un objeto JSON.';
  end if;

  if pg_catalog.jsonb_typeof(p_metadata -> 'provider_request_id') = 'string' then
    v_sanitized := v_sanitized || pg_catalog.jsonb_build_object(
      'provider_request_id',
      left(p_metadata ->> 'provider_request_id', 300)
    );
  end if;

  if pg_catalog.jsonb_typeof(p_metadata -> 'finish_reason') = 'string' then
    v_sanitized := v_sanitized || pg_catalog.jsonb_build_object(
      'finish_reason',
      left(p_metadata ->> 'finish_reason', 100)
    );
  end if;

  if pg_catalog.jsonb_typeof(p_metadata -> 'provider_status') = 'string' then
    v_sanitized := v_sanitized || pg_catalog.jsonb_build_object(
      'provider_status',
      left(p_metadata ->> 'provider_status', 100)
    );
  end if;

  if pg_catalog.jsonb_typeof(p_metadata -> 'error_code') = 'string' then
    v_sanitized := v_sanitized || pg_catalog.jsonb_build_object(
      'error_code',
      left(p_metadata ->> 'error_code', 100)
    );
  end if;

  if pg_catalog.jsonb_typeof(p_metadata -> 'retry_count') = 'number'
    and (p_metadata ->> 'retry_count') ~ '^[0-9]{1,9}$'
  then
    v_sanitized := v_sanitized || pg_catalog.jsonb_build_object(
      'retry_count',
      p_metadata -> 'retry_count'
    );
  end if;

  return v_sanitized;
end;
$$;

revoke all on function private.sanitize_llm_result_metadata(jsonb)
from public, anon, authenticated, service_role;

create or replace function private.normalize_generated_variants(
  p_variants jsonb,
  p_normalized_base jsonb
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v_variant jsonb;
  v_normalized_variant jsonb;
  v_normalized_variants jsonb := '[]'::jsonb;
  v_seen_variants text[] := array[]::text[];
  v_position bigint;
begin
  if pg_catalog.jsonb_typeof(p_variants) is distinct from 'array' then
    raise exception using
      errcode = '22023',
      message = 'Las variantes deben enviarse como un arreglo JSON.';
  end if;

  if pg_catalog.octet_length(p_variants::text) > 250000 then
    raise exception using
      errcode = '22023',
      message = 'El conjunto de variantes excede el tamaño permitido.';
  end if;

  if pg_catalog.jsonb_array_length(p_variants) <> 5 then
    raise exception using
      errcode = '22023',
      message = 'Se requieren exactamente cinco variantes.';
  end if;

  if pg_catalog.jsonb_typeof(p_normalized_base) is distinct from 'object' then
    raise exception using
      errcode = '22023',
      message = 'La pregunta base normalizada es inválida.';
  end if;

  for v_variant, v_position in
    select item.value, item.ordinality
    from pg_catalog.jsonb_array_elements(p_variants)
      with ordinality as item(value, ordinality)
  loop
    v_normalized_variant := private.normalize_multiple_choice_payload(
      v_variant,
      format('La variante %s', v_position)
    );

    if v_normalized_variant = p_normalized_base then
      raise exception using
        errcode = '22023',
        message = format('La variante %s es idéntica a la pregunta base.', v_position);
    end if;

    if v_normalized_variant::text = any (v_seen_variants) then
      raise exception using
        errcode = '22023',
        message = format('La variante %s está duplicada.', v_position);
    end if;

    v_seen_variants := pg_catalog.array_append(
      v_seen_variants,
      v_normalized_variant::text
    );
    v_normalized_variants := v_normalized_variants
      || pg_catalog.jsonb_build_array(v_normalized_variant);
  end loop;

  return v_normalized_variants;
end;
$$;

revoke all on function private.normalize_generated_variants(jsonb, jsonb)
from public, anon, authenticated, service_role;

-- Preserve the existing attempt-based freeze and additionally protect the
-- identity of generated variants. Content remains editable for human review.
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

create or replace function public.complete_variant_generation(
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
  status text,
  variants_inserted integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quiz_id uuid;
  v_base_question_id uuid;
  v_reserved_hash text;
  v_lease_expires_at timestamp with time zone;
  v_quiz_status text;
  v_quiz_created_by uuid;
  v_course_owner_id uuid;
  v_slot_number integer;
  v_base_points numeric;
  v_base_statement text;
  v_base_options jsonb;
  v_base_correct_answer jsonb;
  v_current_hash text;
  v_normalized_base jsonb;
  v_variant jsonb;
  v_normalized_variants jsonb;
  v_position bigint;
begin
  if p_actor_user_id is null then
    raise exception using
      errcode = '28000',
      message = 'El actor autenticado es obligatorio.';
  end if;

  if p_run_id is null then
    raise exception using
      errcode = '22023',
      message = 'La ejecución de generación es obligatoria.';
  end if;

  if p_input_tokens is not null and p_input_tokens < 0
    or p_output_tokens is not null and p_output_tokens < 0
    or p_latency_ms is not null and p_latency_ms < 0
  then
    raise exception using
      errcode = '22023',
      message = 'Tokens y latencia no pueden ser negativos.';
  end if;

  -- Read identifiers without a lock, then acquire locks in the global order:
  -- question -> quiz -> llm_run.
  select
    lr.quiz_id,
    lr.base_question_id
  into
    v_quiz_id,
    v_base_question_id
  from public.llm_runs lr
  where lr.id = p_run_id
    and lr.teacher_id = p_actor_user_id
    and lr.purpose = 'quiz_generation'
    and lr.status = 'running';

  if not found then
    raise exception using
      errcode = '55000',
      message = 'La generación no existe, no pertenece al actor o ya no está en curso.';
  end if;

  select
    q.slot_number,
    q.points,
    q.statement,
    q.options,
    q.correct_answer
  into
    v_slot_number,
    v_base_points,
    v_base_statement,
    v_base_options,
    v_base_correct_answer
  from public.questions q
  where q.id = v_base_question_id
    and q.quiz_id = v_quiz_id
    and q.variant_number = 1
    and q.question_type = 'multiple_choice'
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'La pregunta base ya no existe o dejó de ser válida.';
  end if;

  select
    q.status,
    q.created_by,
    c.teacher_id
  into
    v_quiz_status,
    v_quiz_created_by,
    v_course_owner_id
  from public.quizzes q
  join public.courses c
    on c.id = q.course_id
  where q.id = v_quiz_id
  for update of q;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Evaluación inexistente.';
  end if;

  select
    lr.base_question_id,
    lr.base_question_hash,
    lr.lease_expires_at
  into
    v_base_question_id,
    v_reserved_hash,
    v_lease_expires_at
  from public.llm_runs lr
  where lr.id = p_run_id
    and lr.quiz_id = v_quiz_id
    and lr.base_question_id = v_base_question_id
    and lr.teacher_id = p_actor_user_id
    and lr.purpose = 'quiz_generation'
    and lr.status = 'running'
  for update;

  if not found then
    raise exception using
      errcode = '55000',
      message = 'La generación ya no está en curso.';
  end if;

  if v_quiz_created_by <> p_actor_user_id
    or v_course_owner_id <> p_actor_user_id
  then
    raise exception using
      errcode = '42501',
      message = 'El actor no tiene permiso para completar esta generación.';
  end if;

  if v_quiz_status not in ('draft', 'published') then
    raise exception using
      errcode = '55000',
      message = 'La evaluación no está editable para completar variantes.';
  end if;

  if v_lease_expires_at is null
    or v_lease_expires_at <= pg_catalog.clock_timestamp()
  then
    raise exception using
      errcode = '55000',
      message = 'La reserva de generación expiró y ya no puede completarse.';
  end if;

  if exists (
    select 1
    from public.attempts a
    where a.quiz_id = v_quiz_id
  ) then
    raise exception using
      errcode = '55000',
      message = 'No se pueden insertar variantes: la evaluación ya tiene intentos.';
  end if;

  v_current_hash := private.question_academic_hash(v_base_question_id);

  if v_current_hash is distinct from v_reserved_hash then
    raise exception using
      errcode = '55000',
      message = 'La pregunta base cambió durante la generación.';
  end if;

  if exists (
    select 1
    from public.questions q
    where q.quiz_id = v_quiz_id
      and q.slot_number = v_slot_number
      and q.id <> v_base_question_id
  ) then
    raise exception using
      errcode = '55000',
      message = 'El slot ya tiene variantes adicionales.';
  end if;

  v_normalized_base := private.normalize_multiple_choice_payload(
    pg_catalog.jsonb_build_object(
      'statement', v_base_statement,
      'options', v_base_options,
      'correct_answer', v_base_correct_answer
    ),
    'La pregunta base'
  );

  v_normalized_variants := private.normalize_generated_variants(
    p_variants,
    v_normalized_base
  );

  if v_lease_expires_at <= pg_catalog.clock_timestamp() then
    raise exception using
      errcode = '55000',
      message = 'La reserva de generación expiró durante la validación.';
  end if;

  for v_variant, v_position in
    select item.value, item.ordinality
    from pg_catalog.jsonb_array_elements(v_normalized_variants)
      with ordinality as item(value, ordinality)
  loop
    insert into public.questions (
      quiz_id,
      slot_number,
      variant_number,
      question_type,
      statement,
      options,
      correct_answer,
      points
    )
    values (
      v_quiz_id,
      v_slot_number,
      (v_position + 1)::integer,
      'multiple_choice',
      v_variant ->> 'statement',
      v_variant -> 'options',
      v_variant -> 'correct_answer',
      v_base_points
    );
  end loop;

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
    'success'::text,
    5;
end;
$$;

revoke all on function public.complete_variant_generation(
  uuid, uuid, jsonb, integer, integer, integer, jsonb
)
from public, anon, authenticated, service_role;
grant execute on function public.complete_variant_generation(
  uuid, uuid, jsonb, integer, integer, integer, jsonb
)
to service_role;

create or replace function public.fail_variant_generation(
  p_actor_user_id uuid,
  p_run_id uuid,
  p_error_message text,
  p_latency_ms integer,
  p_result_metadata jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quiz_id uuid;
  v_quiz_created_by uuid;
  v_course_owner_id uuid;
  v_error_message text;
begin
  if p_actor_user_id is null then
    raise exception using
      errcode = '28000',
      message = 'El actor autenticado es obligatorio.';
  end if;

  if p_run_id is null then
    raise exception using
      errcode = '22023',
      message = 'La ejecución de generación es obligatoria.';
  end if;

  if p_latency_ms is not null and p_latency_ms < 0 then
    raise exception using
      errcode = '22023',
      message = 'La latencia no puede ser negativa.';
  end if;

  select lr.quiz_id
  into v_quiz_id
  from public.llm_runs lr
  where lr.id = p_run_id
    and lr.teacher_id = p_actor_user_id
    and lr.purpose = 'quiz_generation'
    and lr.status = 'running';

  if not found then
    raise exception using
      errcode = '55000',
      message = 'La generación no existe, no pertenece al actor o ya no está en curso.';
  end if;

  -- No question row is needed here; keep the shared order quiz -> llm_run.
  select
    q.created_by,
    c.teacher_id
  into
    v_quiz_created_by,
    v_course_owner_id
  from public.quizzes q
  join public.courses c
    on c.id = q.course_id
  where q.id = v_quiz_id
  for update of q;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Evaluación inexistente.';
  end if;

  if v_quiz_created_by <> p_actor_user_id
    or v_course_owner_id <> p_actor_user_id
  then
    raise exception using
      errcode = '42501',
      message = 'El actor no tiene permiso para cerrar esta generación.';
  end if;

  perform 1
  from public.llm_runs lr
  where lr.id = p_run_id
    and lr.quiz_id = v_quiz_id
    and lr.teacher_id = p_actor_user_id
    and lr.purpose = 'quiz_generation'
    and lr.status = 'running'
  for update;

  if not found then
    raise exception using
      errcode = '55000',
      message = 'La generación ya no está en curso.';
  end if;

  v_error_message := left(
    coalesce(
      nullif(private.normalize_question_text(p_error_message), ''),
      'La generación de variantes falló.'
    ),
    1000
  );

  if v_error_message ~* '(authorization|bearer[[:space:]]|api[_ -]?key|secret|credential|sk-[a-z0-9])' then
    v_error_message := 'La generación de variantes falló; se omitió un detalle potencialmente sensible.';
  end if;

  update public.llm_runs lr
  set
    status = 'error',
    latency_ms = p_latency_ms,
    result_metadata = private.sanitize_llm_result_metadata(p_result_metadata),
    error_message = v_error_message
  where lr.id = p_run_id;

  return true;
end;
$$;

revoke all on function public.fail_variant_generation(uuid, uuid, text, integer, jsonb)
from public, anon, authenticated, service_role;
grant execute on function public.fail_variant_generation(uuid, uuid, text, integer, jsonb)
to service_role;
