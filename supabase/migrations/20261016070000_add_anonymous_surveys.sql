-- QRS is intentionally isolated from courses, quizzes, attempts and identities.

create table public.surveys (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references auth.users(id) on delete restrict,
  question text not null,
  options jsonb not null,
  status text not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint surveys_question_not_blank check (btrim(question) <> ''),
  constraint surveys_options_array check (
    jsonb_typeof(options) = 'array'
    and jsonb_array_length(options) between 2 and 10
  ),
  constraint surveys_status_check check (status in ('draft', 'active', 'closed'))
);

create table public.survey_links (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.surveys(id) on delete cascade,
  qr_token_hash text not null unique,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  constraint survey_links_status_check check (status in ('active', 'closed')),
  constraint survey_links_closed_at_consistent check (
    (status = 'active' and closed_at is null)
    or (status = 'closed' and closed_at is not null)
  )
);

create unique index survey_links_one_active_per_survey
on public.survey_links (survey_id)
where status = 'active';

create table public.survey_responses (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.surveys(id) on delete restrict,
  survey_link_id uuid not null references public.survey_links(id) on delete restrict,
  selected_option text not null,
  respondent_token_hash text not null,
  created_at timestamptz not null default now(),
  constraint survey_responses_selected_option_not_blank
    check (btrim(selected_option) <> ''),
  unique (survey_id, respondent_token_hash)
);

alter table public.surveys enable row level security;
alter table public.survey_links enable row level security;
alter table public.survey_responses enable row level security;

create policy "Survey creators can read their surveys"
on public.surveys
for select
to authenticated
using (creator_id = (select auth.uid()));

revoke all on table public.surveys from public, anon;
revoke all on table public.survey_links from public, anon, authenticated;
revoke all on table public.survey_responses from public, anon, authenticated;
grant select on table public.surveys to authenticated;
grant all on table public.surveys to service_role;
grant all on table public.survey_links to service_role;
grant all on table public.survey_responses to service_role;

create function private.normalize_survey_options(p_options jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_options jsonb;
begin
  if pg_catalog.jsonb_typeof(p_options) <> 'array'
     or pg_catalog.jsonb_array_length(p_options) not between 2 and 10 then
    raise exception using
      errcode = '22023',
      message = 'La encuesta debe tener entre 2 y 10 opciones.';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_options) option_value
    where pg_catalog.jsonb_typeof(option_value) <> 'string'
      or pg_catalog.btrim(option_value #>> '{}') = ''
  ) then
    raise exception using
      errcode = '22023',
      message = 'Todas las opciones deben ser textos no vacíos.';
  end if;

  select pg_catalog.jsonb_agg(
    pg_catalog.to_jsonb(pg_catalog.btrim(option_value #>> '{}'))
    order by option_number
  )
  into v_options
  from pg_catalog.jsonb_array_elements(p_options)
    with ordinality as options(option_value, option_number);

  if (
    select count(distinct pg_catalog.lower(option_value))
    from pg_catalog.jsonb_array_elements_text(v_options) option_value
  ) <> pg_catalog.jsonb_array_length(v_options) then
    raise exception using
      errcode = '22023',
      message = 'Las opciones de la encuesta no pueden repetirse.';
  end if;

  return v_options;
end;
$$;

revoke all on function private.normalize_survey_options(jsonb)
from public, anon, authenticated;

create function public.create_survey(
  p_question text,
  p_options jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_survey_id uuid;
  v_question text;
  v_options jsonb;
begin
  if auth.uid() is null then
    raise exception using
      errcode = '28000',
      message = 'Usuario no autenticado.';
  end if;

  v_question := pg_catalog.btrim(p_question);

  if v_question = '' then
    raise exception using
      errcode = '22023',
      message = 'La pregunta de la encuesta es obligatoria.';
  end if;

  v_options := private.normalize_survey_options(p_options);

  insert into public.surveys (creator_id, question, options)
  values (auth.uid(), v_question, v_options)
  returning id into v_survey_id;

  return v_survey_id;
end;
$$;

revoke all on function public.create_survey(text, jsonb) from public, anon;
grant execute on function public.create_survey(text, jsonb) to authenticated;

create function public.open_survey(p_survey_id uuid)
returns table (
  survey_id uuid,
  qr_token text,
  opened_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text;
  v_opened_at timestamptz;
begin
  perform 1
  from public.surveys s
  where s.id = p_survey_id
    and s.creator_id = auth.uid()
  for update;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'Encuesta inexistente o no autorizada.';
  end if;

  update public.survey_links
  set
    status = 'closed',
    closed_at = pg_catalog.now()
  where survey_links.survey_id = p_survey_id
    and status = 'active';

  v_token := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
  v_opened_at := pg_catalog.now();

  insert into public.survey_links (
    survey_id,
    qr_token_hash,
    status,
    created_at
  )
  values (
    p_survey_id,
    pg_catalog.encode(
      extensions.digest(v_token, 'sha256'),
      'hex'
    ),
    'active',
    v_opened_at
  );

  update public.surveys
  set
    status = 'active',
    updated_at = v_opened_at
  where id = p_survey_id;

  return query
  select p_survey_id, v_token, v_opened_at;
end;
$$;

revoke all on function public.open_survey(uuid) from public, anon;
grant execute on function public.open_survey(uuid) to authenticated;

create function public.close_survey(p_survey_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.surveys s
    where s.id = p_survey_id
      and s.creator_id = auth.uid()
  ) then
    raise exception using
      errcode = '42501',
      message = 'Encuesta inexistente o no autorizada.';
  end if;

  update public.survey_links
  set
    status = 'closed',
    closed_at = pg_catalog.now()
  where survey_links.survey_id = p_survey_id
    and status = 'active';

  update public.surveys
  set
    status = 'closed',
    updated_at = pg_catalog.now()
  where id = p_survey_id;

  return true;
end;
$$;

revoke all on function public.close_survey(uuid) from public, anon;
grant execute on function public.close_survey(uuid) to authenticated;

create function public.get_public_survey(p_qr_token text)
returns table (
  survey_id uuid,
  question text,
  options jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query
  select s.id, s.question, s.options
  from public.survey_links sl
  join public.surveys s on s.id = sl.survey_id
  where sl.qr_token_hash = pg_catalog.encode(
      extensions.digest(p_qr_token, 'sha256'),
      'hex'
    )
    and sl.status = 'active'
    and s.status = 'active'
  limit 1;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'QRS inválido o cerrado.';
  end if;
end;
$$;

revoke all on function public.get_public_survey(text) from public;
grant execute on function public.get_public_survey(text) to anon, authenticated;

create function public.submit_survey_response(
  p_qr_token text,
  p_respondent_token text,
  p_selected_option text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_survey_id uuid;
  v_survey_link_id uuid;
  v_options jsonb;
  v_response_id uuid;
begin
  if p_respondent_token is null
     or pg_catalog.length(pg_catalog.btrim(p_respondent_token)) not between 16 and 200 then
    raise exception using
      errcode = '22023',
      message = 'Identificador técnico de respuesta inválido.';
  end if;

  select s.id, sl.id, s.options
  into v_survey_id, v_survey_link_id, v_options
  from public.survey_links sl
  join public.surveys s on s.id = sl.survey_id
  where sl.qr_token_hash = pg_catalog.encode(
      extensions.digest(p_qr_token, 'sha256'),
      'hex'
    )
    and sl.status = 'active'
    and s.status = 'active'
  for share of sl, s;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'QRS inválido o cerrado.';
  end if;

  if not exists (
    select 1
    from pg_catalog.jsonb_array_elements_text(v_options) option_value
    where option_value = p_selected_option
  ) then
    raise exception using
      errcode = '22023',
      message = 'La opción seleccionada no pertenece a esta encuesta.';
  end if;

  insert into public.survey_responses (
    survey_id,
    survey_link_id,
    selected_option,
    respondent_token_hash
  )
  values (
    v_survey_id,
    v_survey_link_id,
    p_selected_option,
    pg_catalog.encode(
      extensions.digest(pg_catalog.btrim(p_respondent_token), 'sha256'),
      'hex'
    )
  )
  on conflict (survey_id, respondent_token_hash) do nothing
  returning id into v_response_id;

  return v_response_id is not null;
end;
$$;

revoke all on function public.submit_survey_response(text, text, text)
from public;
grant execute on function public.submit_survey_response(text, text, text)
to anon, authenticated;

create function public.get_survey_results(p_survey_id uuid)
returns table (
  option_number integer,
  option_text text,
  response_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.surveys s
    where s.id = p_survey_id
      and s.creator_id = auth.uid()
  ) then
    raise exception using
      errcode = '42501',
      message = 'Encuesta inexistente o no autorizada.';
  end if;

  return query
  select
    options.option_number::integer,
    options.option_text,
    count(sr.id)::bigint
  from public.surveys s
  cross join lateral pg_catalog.jsonb_array_elements_text(s.options)
    with ordinality as options(option_text, option_number)
  left join public.survey_responses sr
    on sr.survey_id = s.id
    and sr.selected_option = options.option_text
  where s.id = p_survey_id
  group by options.option_number, options.option_text
  order by options.option_number;
end;
$$;

revoke all on function public.get_survey_results(uuid) from public, anon;
grant execute on function public.get_survey_results(uuid) to authenticated;
