


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "private";


ALTER SCHEMA "private" OWNER TO "postgres";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "private"."enforce_attempt_deadline"("p_attempt_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_user_id uuid;
  v_auth_session_id uuid;

  v_status text;
  v_deadline_at timestamptz;
  v_hard_deadline_at timestamptz;

  v_quiz_id uuid;
  v_grade_scale_max numeric;

  v_score numeric;
  v_total_points numeric;
  v_final_grade numeric;
begin

  v_user_id := auth.uid();

  if v_user_id is null then
    return null;
  end if;


  v_auth_session_id :=
    (auth.jwt() ->> 'session_id')::uuid;

  if v_auth_session_id is null then
    return null;
  end if;


  /*
   * Recuperar y bloquear el intento.
   */
  select
    a.status,
    a.deadline_at,
    a.quiz_id,
    q.grade_scale_max
  into
    v_status,
    v_deadline_at,
    v_quiz_id,
    v_grade_scale_max
  from public.attempts a
  join public.quizzes q
    on q.id = a.quiz_id
  where a.id = p_attempt_id
    and a.student_id = v_user_id
    and a.active_session_id = v_auth_session_id
  for update of a;


  if not found then
    return null;
  end if;


  /*
   * deadline_at:
   * momento en que el contador visible llega a 0:00.
   *
   * hard deadline:
   * cierre efectivo 10 segundos después.
   */
  if v_deadline_at is not null then
    v_hard_deadline_at :=
      v_deadline_at + interval '10 seconds';
  end if;


  if v_status = 'in_progress'
     and v_hard_deadline_at is not null
     and now() >= v_hard_deadline_at then

    /*
     * La pregunta que estaba visible,
     * pero no fue enviada a tiempo,
     * queda invalidada.
     */
    update public.responses r
    set status = 'invalidated'
    where r.attempt_id = p_attempt_id
      and r.status = 'assigned';


    /*
     * Puntos realmente obtenidos
     * en respuestas que sí fueron enviadas
     * y calificadas.
     */
    select coalesce(sum(r.score), 0)
    into v_score
    from public.responses r
    where r.attempt_id = p_attempt_id
      and r.status = 'graded';


    /*
     * Puntaje TOTAL posible del quiz.
     *
     * Cada slot cuenta una sola vez,
     * aunque tenga múltiples variantes.
     */
    select coalesce(sum(slot_points), 0)
    into v_total_points
    from (
      select
        q.slot_number,
        max(q.points) as slot_points
      from public.questions q
      where q.quiz_id = v_quiz_id
      group by q.slot_number
    ) s;


    if v_total_points > 0 then
      v_final_grade :=
        round(
          (
            v_score
            / v_total_points
            * v_grade_scale_max
          )::numeric,
          2
        );
    else
      v_final_grade := 0;
    end if;


    /*
     * El intento conserva status = expired,
     * pero también queda con puntaje y nota.
     */
    update public.attempts a
    set
      status = 'expired',
      expired_at = coalesce(
        a.expired_at,
        v_hard_deadline_at
      ),
      current_question_id = null,
      score_points = v_score,
      grade = v_final_grade,
      last_heartbeat_at = now()
    where a.id = p_attempt_id
      and a.student_id = v_user_id
      and a.active_session_id = v_auth_session_id;


    return 'expired';
  end if;


  return v_status;

end;
$$;


ALTER FUNCTION "private"."enforce_attempt_deadline"("p_attempt_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."is_course_member"("p_course_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select exists (
    select 1
    from public.course_members cm
    where cm.course_id = p_course_id
      and cm.student_id = (select auth.uid())
      and cm.status = 'active'
  );
$$;


ALTER FUNCTION "private"."is_course_member"("p_course_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."is_student_of_teacher"("p_student_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select exists (
    select 1
    from public.course_members cm
    join public.courses c
      on c.id = cm.course_id
    where cm.student_id = p_student_id
      and cm.status = 'active'
      and c.teacher_id = (select auth.uid())
  );
$$;


ALTER FUNCTION "private"."is_student_of_teacher"("p_student_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."is_teacher"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.is_teacher = true
  );
$$;


ALTER FUNCTION "private"."is_teacher"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."is_teacher_of_student"("p_teacher_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select exists (
    select 1
    from public.courses c
    join public.course_members cm
      on cm.course_id = c.id
    where c.teacher_id = p_teacher_id
      and cm.student_id = (select auth.uid())
      and cm.status = 'active'
  );
$$;


ALTER FUNCTION "private"."is_teacher_of_student"("p_teacher_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."owns_course"("p_course_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select exists (
    select 1
    from public.courses c
    where c.id = p_course_id
      and c.teacher_id = (select auth.uid())
  );
$$;


ALTER FUNCTION "private"."owns_course"("p_course_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."apply_llm_grade"("p_response_id" "uuid", "p_score" numeric, "p_feedback" "text") RETURNS TABLE("response_id" "uuid", "attempt_id" "uuid", "attempt_status" "text", "final_grade" numeric)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_attempt_id uuid;
  v_question_points numeric;

  v_pending integer;

  v_score_points numeric;
  v_total_points numeric;

  v_grade_scale_max numeric;
  v_final_grade numeric;
  v_attempt_status text;
begin

  /*
   * Encontrar la respuesta pendiente
   * y conocer el puntaje máximo de su pregunta.
   */
  select
    r.attempt_id,
    q.points
  into
    v_attempt_id,
    v_question_points
  from public.responses r
  join public.questions q
    on q.id = r.question_id
  where r.id = p_response_id
    and r.status = 'answered'
  for update of r;


  if v_attempt_id is null then
    raise exception
      'Respuesta inexistente o no pendiente de calificación';
  end if;


  /*
   * El LLM nunca puede asignar una nota
   * negativa ni superior al valor de la pregunta.
   */
  if p_score < 0 or p_score > v_question_points then
    raise exception
      'Puntaje inválido: debe estar entre 0 y %',
      v_question_points;
  end if;


  -- Guardar calificación de esta respuesta.
  update public.responses
  set
    score = p_score,
    feedback = p_feedback,
    grading_method = 'llm',
    status = 'graded',
    graded_at = now()
  where id = p_response_id;


  /*
   * Verificar si todavía quedan respuestas
   * pendientes de calificación por IA.
   */
  select count(*)
  into v_pending
  from public.responses
  where attempt_id = v_attempt_id
    and status = 'answered';


  if v_pending = 0 then

    /*
     * Sumar puntos obtenidos únicamente
     * de respuestas válidas y calificadas.
     */
    select
      coalesce(sum(r.score), 0),
      coalesce(sum(q.points), 0)
    into
      v_score_points,
      v_total_points
    from public.responses r
    join public.questions q
      on q.id = r.question_id
    where r.attempt_id = v_attempt_id
      and r.status = 'graded';


    select q.grade_scale_max
    into v_grade_scale_max
    from public.attempts a
    join public.quizzes q
      on q.id = a.quiz_id
    where a.id = v_attempt_id;


    if v_total_points <= 0 then
      raise exception 'El quiz no tiene puntaje total válido';
    end if;


    /*
     * Conversión a la escala del docente.
     *
     * Ejemplo:
     * 8 puntos obtenidos / 10 posibles × 5.0
     * = 4.0
     */
    v_final_grade :=
      round(
        (
          v_score_points
          / v_total_points
          * v_grade_scale_max
        )::numeric,
        2
      );


    update public.attempts
    set
      score_points = v_score_points,
      grade = v_final_grade,
      status = 'graded',
      graded_at = now()
    where id = v_attempt_id;

    v_attempt_status := 'graded';

  else

    v_final_grade := null;
    v_attempt_status := 'submitted';

  end if;


  return query
  select
    p_response_id,
    v_attempt_id,
    v_attempt_status,
    v_final_grade;

end;
$$;


ALTER FUNCTION "public"."apply_llm_grade"("p_response_id" "uuid", "p_score" numeric, "p_feedback" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."close_quiz_session"("p_quiz_session_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
declare
  v_closed boolean;
begin

  update public.quiz_sessions qs
  set status = 'closed'
  where qs.id = p_quiz_session_id
    and qs.status = 'active'
    and exists (
      select 1
      from public.quizzes q
      where q.id = qs.quiz_id
        and private.owns_course(q.course_id)
    );

  v_closed := found;

  return v_closed;
end;
$$;


ALTER FUNCTION "public"."close_quiz_session"("p_quiz_session_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_quiz_session"("p_quiz_id" "uuid", "p_access_minutes" integer DEFAULT 5) RETURNS TABLE("quiz_session_id" "uuid", "qr_token" "text", "expires_at" timestamp with time zone)
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
declare
  v_token text;
  v_session_id uuid;
  v_expires_at timestamptz;
begin

  if p_access_minutes < 1 or p_access_minutes > 30 then
    raise exception
      'La ventana de acceso debe estar entre 1 y 30 minutos';
  end if;

  /*
   * Bloqueamos el quiz durante esta operación.
   * Así evitamos que dos clics simultáneos creen
   * dos QR activos para el mismo quiz.
   */
  perform 1
  from public.quizzes q
  where q.id = p_quiz_id
    and q.status = 'published'
    and private.owns_course(q.course_id)
  for update;

  if not found then
    raise exception
      'Quiz inexistente, no publicado o no autorizado';
  end if;

  /*
   * Cualquier QR anterior del mismo quiz
   * deja inmediatamente de admitir estudiantes.
   *
   * Esto NO afecta a quienes ya ingresaron.
   */
  update public.quiz_sessions qs
  set status = 'closed'
  where qs.quiz_id = p_quiz_id
    and qs.status = 'active';

  v_token := encode(
    extensions.gen_random_bytes(24),
    'hex'
  );

  v_expires_at :=
    now() + make_interval(mins => p_access_minutes);

  insert into public.quiz_sessions (
    quiz_id,
    created_by,
    qr_token_hash,
    starts_at,
    expires_at,
    status
  )
  values (
    p_quiz_id,
    auth.uid(),
    encode(
      extensions.digest(v_token, 'sha256'),
      'hex'
    ),
    now(),
    v_expires_at,
    'active'
  )
  returning id
  into v_session_id;

  return query
  select
    v_session_id,
    v_token,
    v_expires_at;

end;
$$;


ALTER FUNCTION "public"."create_quiz_session"("p_quiz_id" "uuid", "p_access_minutes" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_current_question"("p_attempt_id" "uuid") RETURNS TABLE("response_id" "uuid", "question_id" "uuid", "slot_number" integer, "question_type" "text", "statement" "text", "options" "jsonb")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_user_id uuid;
  v_auth_session_id uuid;

  v_quiz_id uuid;
  v_current_slot integer;
  v_current_question_id uuid;

  v_response_id uuid;
  v_question_id uuid;

  v_attempt_status text;
begin

  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;


  v_auth_session_id :=
    (auth.jwt() ->> 'session_id')::uuid;

  if v_auth_session_id is null then
    raise exception 'Sesión de autenticación inválida';
  end if;


  /*
   * Verificar primero si el tiempo terminó.
   *
   * IMPORTANTE:
   * no lanzamos una excepción si expiró,
   * porque una excepción revertiría también
   * el cambio de estado realizado por el helper.
   */
  v_attempt_status :=
    private.enforce_attempt_deadline(
      p_attempt_id
    );


  if v_attempt_status = 'expired' then
    return;
  end if;


  /*
   * Obtener y bloquear el intento.
   */
  select
    a.quiz_id,
    a.current_slot,
    a.current_question_id
  into
    v_quiz_id,
    v_current_slot,
    v_current_question_id
  from public.attempts a
  where a.id = p_attempt_id
    and a.student_id = v_user_id
    and a.status = 'in_progress'
    and a.active_session_id = v_auth_session_id
  for update;


  if v_quiz_id is null then
    raise exception
      'Intento inexistente, finalizado o activo en otra sesión';
  end if;


  /*
   * Si existe una pregunta activa,
   * devolver exactamente la misma.
   *
   * Esto impide obtener otra variante
   * simplemente recargando.
   */
  if v_current_question_id is not null then

    select r.id
    into v_response_id
    from public.responses r
    where r.attempt_id = p_attempt_id
      and r.question_id = v_current_question_id
      and r.status = 'assigned'
    order by r.assigned_at desc
    limit 1;


    if v_response_id is not null then

      return query
      select
        r.id,
        q.id,
        q.slot_number,
        q.question_type,
        q.statement,
        q.options
      from public.responses r
      join public.questions q
        on q.id = r.question_id
      where r.id = v_response_id;

      return;

    end if;

  end if;


  /*
   * Si todavía no comenzó,
   * empezar por el slot 1.
   */
  if v_current_slot is null then
    v_current_slot := 1;
  end if;


  /*
   * Elegir aleatoriamente una variante
   * nunca mostrada anteriormente.
   */
  select q.id
  into v_question_id
  from public.questions q
  where q.quiz_id = v_quiz_id
    and q.slot_number = v_current_slot
    and not exists (
      select 1
      from public.responses r
      where r.attempt_id = p_attempt_id
        and r.question_id = q.id
    )
  order by random()
  limit 1;


  if v_question_id is null then
    raise exception
      'No quedan variantes disponibles para esta pregunta';
  end if;


  insert into public.responses (
    attempt_id,
    question_id,
    slot_number,
    status
  )
  values (
    p_attempt_id,
    v_question_id,
    v_current_slot,
    'assigned'
  )
  returning id
  into v_response_id;


  update public.attempts
  set
    current_slot = v_current_slot,
    current_question_id = v_question_id,
    last_heartbeat_at = now()
  where id = p_attempt_id;


  /*
   * Nunca enviamos correct_answer ni rubric
   * al frontend.
   */
  return query
  select
    r.id,
    q.id,
    q.slot_number,
    q.question_type,
    q.statement,
    q.options
  from public.responses r
  join public.questions q
    on q.id = r.question_id
  where r.id = v_response_id;

end;
$$;


ALTER FUNCTION "public"."get_current_question"("p_attempt_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_quiz_session_live_status"("p_quiz_session_id" "uuid") RETURNS TABLE("active_devices" bigint, "attempts_in_progress" bigint, "attempts_finished" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin

  -- Solo el docente propietario del curso puede consultar esta sesión.
  if not exists (
    select 1
    from public.quiz_sessions qs
    join public.quizzes q
      on q.id = qs.quiz_id
    where qs.id = p_quiz_session_id
      and private.owns_course(q.course_id)
  ) then
    raise exception 'Sesión inexistente o no autorizada';
  end if;

  return query
  select

    count(*) filter (
      where a.status = 'in_progress'
        and a.last_heartbeat_at >= now() - interval '20 seconds'
    )::bigint,

    count(*) filter (
      where a.status = 'in_progress'
    )::bigint,

    count(*) filter (
      where a.status in ('submitted', 'graded')
    )::bigint

  from public.attempts a
  where a.quiz_session_id = p_quiz_session_id;

end;
$$;


ALTER FUNCTION "public"."get_quiz_session_live_status"("p_quiz_session_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_student_quiz_history"() RETURNS TABLE("attempt_id" "uuid", "quiz_id" "uuid", "quiz_title" "text", "course_id" "uuid", "course_name" "text", "grade" numeric, "grade_scale_max" numeric, "submitted_at" timestamp with time zone, "graded_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select
    a.id,
    q.id,
    q.title,
    c.id,
    c.name,
    a.grade,
    q.grade_scale_max,
    a.submitted_at,
    a.graded_at
  from public.attempts a
  join public.quizzes q
    on q.id = a.quiz_id
  join public.courses c
    on c.id = q.course_id
  where a.student_id = auth.uid()
    and a.status = 'graded'
  order by a.graded_at desc;
$$;


ALTER FUNCTION "public"."get_student_quiz_history"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  insert into public.profiles (
    id,
    email,
    full_name,
    is_teacher
  )
  values (
    new.id,
    new.email,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      split_part(new.email, '@', 1)
    ),
    false
  );

  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."heartbeat_quiz_attempt"("p_attempt_id" "uuid") RETURNS timestamp with time zone
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_user_id uuid;
  v_auth_session_id uuid;
  v_now timestamptz;
  v_attempt_status text;
begin

  v_user_id := auth.uid();
  v_now := now();

  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;


  v_auth_session_id :=
    (auth.jwt() ->> 'session_id')::uuid;

  if v_auth_session_id is null then
    raise exception 'Sesión de autenticación inválida';
  end if;


  /*
   * Confirmar que la sesión todavía existe
   * en Supabase Auth.
   */
  if not exists (
    select 1
    from auth.sessions s
    where s.id = v_auth_session_id
      and s.user_id = v_user_id
  ) then
    raise exception
      'Sesión de autenticación no válida';
  end if;


  /*
   * Verificar primero si el tiempo terminó.
   */
  v_attempt_status :=
    private.enforce_attempt_deadline(
      p_attempt_id
    );


  /*
   * Si expiró, NO lanzamos excepción:
   * hacerlo revertiría el cambio a expired.
   *
   * NULL indicará que ya no existe
   * heartbeat válido para ese intento.
   */
  if v_attempt_status = 'expired' then
    return null;
  end if;


  /*
   * Solo actualiza si:
   *
   * 1. pertenece al estudiante;
   * 2. sigue en progreso;
   * 3. corresponde a esta sesión.
   */
  update public.attempts
  set last_heartbeat_at = v_now
  where id = p_attempt_id
    and student_id = v_user_id
    and status = 'in_progress'
    and active_session_id = v_auth_session_id;


  if not found then
    raise exception
      'Intento inexistente, finalizado o activo en otra sesión';
  end if;


  return v_now;

end;
$$;


ALTER FUNCTION "public"."heartbeat_quiz_attempt"("p_attempt_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."join_quiz_session"("p_qr_token" "text") RETURNS TABLE("attempt_id" "uuid", "quiz_id" "uuid", "quiz_session_id" "uuid", "attempt_status" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_user_id uuid;
  v_auth_session_id uuid;

  v_quiz_session_id uuid;
  v_quiz_id uuid;
  v_course_id uuid;
  v_duration_minutes integer;

  v_attempt_id uuid;
  v_attempt_status text;
  v_existing_session_id uuid;
begin

  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  v_auth_session_id :=
    (auth.jwt() ->> 'session_id')::uuid;

  if v_auth_session_id is null then
    raise exception 'Sesión de autenticación inválida';
  end if;

  if not exists (
    select 1
    from auth.sessions s
    where s.id = v_auth_session_id
      and s.user_id = v_user_id
  ) then
    raise exception
      'La sesión de autenticación ya no es válida';
  end if;


  /*
   * Validar QR y recuperar también
   * la duración configurada por el docente.
   */
  select
    qs.id,
    qs.quiz_id,
    q.course_id,
    q.duration_minutes
  into
    v_quiz_session_id,
    v_quiz_id,
    v_course_id,
    v_duration_minutes
  from public.quiz_sessions qs
  join public.quizzes q
    on q.id = qs.quiz_id
  where qs.qr_token_hash =
    encode(
      extensions.digest(p_qr_token, 'sha256'),
      'hex'
    )
    and qs.status = 'active'
    and qs.starts_at <= now()
    and qs.expires_at > now()
    and q.status = 'published'
    and q.delivery_mode = 'in_person'
  limit 1;


  if v_quiz_session_id is null then
    raise exception 'QR inválido o expirado';
  end if;


  if v_duration_minutes is null
     or v_duration_minutes <= 0 then
    raise exception
      'El quiz no tiene una duración válida configurada';
  end if;


  if not private.is_course_member(v_course_id) then
    raise exception
      'El estudiante no está matriculado en este curso';
  end if;


  /*
   * Crear el intento.
   *
   * El deadline queda fijado en el instante
   * real en que el estudiante entra al quiz.
   */
  insert into public.attempts (
    quiz_id,
    student_id,
    quiz_session_id,
    status,
    active_session_id,
    session_started_at,
    last_heartbeat_at,
    started_at,
    deadline_at
  )
  values (
    v_quiz_id,
    v_user_id,
    v_quiz_session_id,
    'in_progress',
    v_auth_session_id,
    now(),
    now(),
    now(),
    now() + make_interval(
      mins => v_duration_minutes
    )
  )
  on conflict on constraint attempts_quiz_id_student_id_key
  do nothing;


  select
    a.id,
    a.status,
    a.active_session_id
  into
    v_attempt_id,
    v_attempt_status,
    v_existing_session_id
  from public.attempts a
  where a.quiz_id = v_quiz_id
    and a.student_id = v_user_id
  for update;


  if v_attempt_id is null then
    raise exception
      'No fue posible crear o recuperar el intento';
  end if;


  if v_attempt_status in ('submitted', 'graded') then
    raise exception
      'Este quiz ya fue finalizado';
  end if;


  if v_attempt_status = 'blocked' then
    raise exception
      'Este intento fue bloqueado por incidencias de integridad. Contacta al docente';
  end if;


  if v_attempt_status = 'expired' then
    raise exception
      'El tiempo disponible para este intento ya terminó';
  end if;


  if v_existing_session_id is not null
     and v_existing_session_id <> v_auth_session_id then

    if exists (
      select 1
      from auth.sessions s
      where s.id = v_existing_session_id
        and s.user_id = v_user_id
    ) then
      raise exception
        'Este intento ya está activo en otra sesión';
    end if;

  end if;


  /*
   * Una reentrada legítima NO reinicia:
   *
   * - started_at
   * - deadline_at
   */
  update public.attempts as a
  set
    active_session_id = v_auth_session_id,
    quiz_session_id = v_quiz_session_id,
    status = 'in_progress',
    session_started_at = now(),
    last_heartbeat_at = now(),
    deadline_at = coalesce(
      a.deadline_at,
      a.started_at + make_interval(
        mins => v_duration_minutes
      )
    )
  where a.id = v_attempt_id;


  return query
  select
    v_attempt_id,
    v_quiz_id,
    v_quiz_session_id,
    'in_progress'::text;

end;
$$;


ALTER FUNCTION "public"."join_quiz_session"("p_qr_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."replace_question_on_focus_loss"("p_attempt_id" "uuid", "p_event_type" "text") RETURNS TABLE("response_id" "uuid", "question_id" "uuid", "slot_number" integer, "question_type" "text", "statement" "text", "options" "jsonb", "focus_violation_count" integer, "attempt_status" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_user_id uuid;
  v_auth_session_id uuid;

  v_quiz_id uuid;
  v_current_slot integer;
  v_old_question_id uuid;
  v_old_response_id uuid;

  v_new_question_id uuid;
  v_new_response_id uuid;

  v_current_focus_count integer;
  v_next_focus_count integer;
  v_max_focus_violations integer;

  v_attempt_status text;
begin

  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;


  if p_event_type not in (
    'blur',
    'visibility_hidden',
    'fullscreen_exit',
    'reload'
  ) then
    raise exception
      'Tipo de evento de foco no válido';
  end if;


  v_auth_session_id :=
    (auth.jwt() ->> 'session_id')::uuid;

  if v_auth_session_id is null then
    raise exception
      'Sesión de autenticación inválida';
  end if;


  /*
   * Antes de registrar una incidencia,
   * comprobar si el tiempo ya terminó.
   */
  v_attempt_status :=
    private.enforce_attempt_deadline(
      p_attempt_id
    );


  /*
   * Si el examen ya expiró:
   *
   * - no contamos otra incidencia;
   * - no asignamos otra variante;
   * - devolvemos expired al frontend.
   *
   * No lanzamos excepción porque eso
   * revertiría la expiración.
   */
  if v_attempt_status = 'expired' then

    select
      a.current_slot,
      a.focus_violation_count
    into
      v_current_slot,
      v_current_focus_count
    from public.attempts a
    where a.id = p_attempt_id
      and a.student_id = v_user_id
      and a.active_session_id = v_auth_session_id;


    return query
    select
      null::uuid,
      null::uuid,
      v_current_slot,
      null::text,
      null::text,
      null::jsonb,
      v_current_focus_count,
      'expired'::text;

    return;

  end if;


  /*
   * Recuperar y bloquear el intento.
   */
  select
    a.quiz_id,
    a.current_slot,
    a.current_question_id,
    a.focus_violation_count,
    coalesce(q.max_focus_violations, 5)
  into
    v_quiz_id,
    v_current_slot,
    v_old_question_id,
    v_current_focus_count,
    v_max_focus_violations
  from public.attempts a
  join public.quizzes q
    on q.id = a.quiz_id
  where a.id = p_attempt_id
    and a.student_id = v_user_id
    and a.status = 'in_progress'
    and a.active_session_id = v_auth_session_id
  for update of a;


  if v_quiz_id is null then
    raise exception
      'Intento inexistente, finalizado, bloqueado o activo en otra sesión';
  end if;


  if v_old_question_id is null then
    raise exception
      'No existe una pregunta activa para reemplazar';
  end if;


  select r.id
  into v_old_response_id
  from public.responses r
  where r.attempt_id = p_attempt_id
    and r.question_id = v_old_question_id
    and r.status = 'assigned'
  order by r.assigned_at desc
  limit 1;


  if v_old_response_id is null then
    raise exception
      'No existe una respuesta activa asociada a la pregunta';
  end if;


  v_next_focus_count :=
    v_current_focus_count + 1;


  /*
   * Superó el máximo permitido.
   */
  if v_next_focus_count >
     v_max_focus_violations then

    update public.responses
    set status = 'invalidated'
    where id = v_old_response_id;


    update public.attempts
    set
      status = 'blocked',
      current_question_id = null,
      focus_violation_count =
        v_next_focus_count,
      last_heartbeat_at = now()
    where id = p_attempt_id;


    insert into public.focus_events (
      attempt_id,
      event_type,
      from_question_id,
      replacement_question_id,
      metadata
    )
    values (
      p_attempt_id,
      p_event_type,
      v_old_question_id,
      null,
      jsonb_build_object(
        'action',
        'attempt_blocked',
        'limit',
        v_max_focus_violations,
        'count',
        v_next_focus_count
      )
    );


    return query
    select
      null::uuid,
      null::uuid,
      v_current_slot,
      null::text,
      null::text,
      null::jsonb,
      v_next_focus_count,
      'blocked'::text;

    return;

  end if;


  /*
   * Buscar una variante nunca mostrada
   * del mismo slot.
   */
  select q.id
  into v_new_question_id
  from public.questions q
  where q.quiz_id = v_quiz_id
    and q.slot_number = v_current_slot
    and q.id <> v_old_question_id
    and not exists (
      select 1
      from public.responses r
      where r.attempt_id = p_attempt_id
        and r.question_id = q.id
    )
  order by random()
  limit 1;


  /*
   * Si no quedan variantes,
   * bloquear preventivamente.
   */
  if v_new_question_id is null then

    update public.responses
    set status = 'invalidated'
    where id = v_old_response_id;


    update public.attempts
    set
      status = 'blocked',
      current_question_id = null,
      focus_violation_count =
        v_next_focus_count,
      last_heartbeat_at = now()
    where id = p_attempt_id;


    insert into public.focus_events (
      attempt_id,
      event_type,
      from_question_id,
      replacement_question_id,
      metadata
    )
    values (
      p_attempt_id,
      p_event_type,
      v_old_question_id,
      null,
      jsonb_build_object(
        'action',
        'attempt_blocked',
        'reason',
        'variants_exhausted',
        'count',
        v_next_focus_count
      )
    );


    return query
    select
      null::uuid,
      null::uuid,
      v_current_slot,
      null::text,
      null::text,
      null::jsonb,
      v_next_focus_count,
      'blocked'::text;

    return;

  end if;


  /*
   * Invalidar pregunta anterior.
   */
  update public.responses
  set status = 'invalidated'
  where id = v_old_response_id;


  /*
   * Asignar nueva variante.
   */
  insert into public.responses (
    attempt_id,
    question_id,
    slot_number,
    status
  )
  values (
    p_attempt_id,
    v_new_question_id,
    v_current_slot,
    'assigned'
  )
  returning id
  into v_new_response_id;


  update public.attempts as a
  set
    current_question_id =
      v_new_question_id,
    focus_violation_count =
      v_next_focus_count,
    last_heartbeat_at = now()
  where a.id = p_attempt_id;


  insert into public.focus_events (
    attempt_id,
    event_type,
    from_question_id,
    replacement_question_id,
    metadata
  )
  values (
    p_attempt_id,
    p_event_type,
    v_old_question_id,
    v_new_question_id,
    jsonb_build_object(
      'action',
      'question_replaced',
      'limit',
      v_max_focus_violations,
      'count',
      v_next_focus_count
    )
  );


  return query
  select
    r.id,
    q.id,
    q.slot_number,
    q.question_type,
    q.statement,
    q.options,
    v_next_focus_count,
    'in_progress'::text
  from public.responses r
  join public.questions q
    on q.id = r.question_id
  where r.id = v_new_response_id;

end;
$$;


ALTER FUNCTION "public"."replace_question_on_focus_loss"("p_attempt_id" "uuid", "p_event_type" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rls_auto_enable"() RETURNS "event_trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."rls_auto_enable"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."start_async_quiz_attempt"("p_quiz_id" "uuid") RETURNS TABLE("attempt_id" "uuid", "quiz_id" "uuid", "attempt_status" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_user_id uuid;
  v_auth_session_id uuid;

  v_course_id uuid;
  v_duration_minutes integer;
  v_closes_at timestamptz;

  v_attempt_id uuid;
  v_attempt_status text;
  v_existing_session_id uuid;
begin

  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  v_auth_session_id :=
    (auth.jwt() ->> 'session_id')::uuid;

  if v_auth_session_id is null then
    raise exception 'Sesión de autenticación inválida';
  end if;


  if not exists (
    select 1
    from auth.sessions s
    where s.id = v_auth_session_id
      and s.user_id = v_user_id
  ) then
    raise exception
      'La sesión de autenticación ya no es válida';
  end if;


  /*
   * Recuperamos:
   *
   * - curso;
   * - duración definida por el docente;
   * - cierre absoluto de la ventana asincrónica.
   */
  select
    q.course_id,
    q.duration_minutes,
    q.closes_at
  into
    v_course_id,
    v_duration_minutes,
    v_closes_at
  from public.quizzes q
  where q.id = p_quiz_id
    and q.status = 'published'
    and q.delivery_mode = 'asynchronous'
    and q.opens_at <= now()
    and q.closes_at > now();


  if v_course_id is null then
    raise exception
      'El quiz no está disponible en este momento';
  end if;


  if v_duration_minutes is null
     or v_duration_minutes <= 0 then
    raise exception
      'El quiz no tiene una duración válida configurada';
  end if;


  if not private.is_course_member(v_course_id) then
    raise exception
      'El estudiante no está matriculado en este curso';
  end if;


  /*
   * El deadline real será el menor entre:
   *
   * 1. inicio + duración;
   * 2. cierre absoluto del quiz.
   */
  insert into public.attempts (
    quiz_id,
    student_id,
    quiz_session_id,
    status,
    active_session_id,
    session_started_at,
    last_heartbeat_at,
    started_at,
    deadline_at
  )
  values (
    p_quiz_id,
    v_user_id,
    null,
    'in_progress',
    v_auth_session_id,
    now(),
    now(),
    now(),
    least(
      now() + make_interval(
        mins => v_duration_minutes
      ),
      v_closes_at
    )
  )
  on conflict on constraint attempts_quiz_id_student_id_key
  do nothing;


  select
    a.id,
    a.status,
    a.active_session_id
  into
    v_attempt_id,
    v_attempt_status,
    v_existing_session_id
  from public.attempts a
  where a.quiz_id = p_quiz_id
    and a.student_id = v_user_id
  for update;


  if v_attempt_id is null then
    raise exception
      'No fue posible crear o recuperar el intento';
  end if;


  if v_attempt_status in ('submitted', 'graded') then
    raise exception
      'Este quiz ya fue finalizado';
  end if;


  if v_attempt_status = 'blocked' then
    raise exception
      'Este intento fue bloqueado por incidencias de integridad. Contacta al docente';
  end if;


  if v_attempt_status = 'expired' then
    raise exception
      'El tiempo disponible para este intento ya terminó';
  end if;


  if v_existing_session_id is not null
     and v_existing_session_id <> v_auth_session_id then

    if exists (
      select 1
      from auth.sessions s
      where s.id = v_existing_session_id
        and s.user_id = v_user_id
    ) then
      raise exception
        'Este intento ya está activo en otra sesión';
    end if;

  end if;


  /*
   * Una reentrada legítima NO reinicia
   * ni started_at ni deadline_at.
   */
  update public.attempts as a
  set
    active_session_id = v_auth_session_id,
    quiz_session_id = null,
    status = 'in_progress',
    session_started_at = now(),
    last_heartbeat_at = now(),
    deadline_at = coalesce(
      a.deadline_at,
      least(
        a.started_at + make_interval(
          mins => v_duration_minutes
        ),
        v_closes_at
      )
    )
  where a.id = v_attempt_id;


  return query
  select
    v_attempt_id,
    p_quiz_id,
    'in_progress'::text;

end;
$$;


ALTER FUNCTION "public"."start_async_quiz_attempt"("p_quiz_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."submit_quiz_attempt"("p_attempt_id" "uuid") RETURNS TABLE("attempt_id" "uuid", "attempt_status" "text", "pending_llm_grading" integer, "graded_responses" integer, "total_score" numeric)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_user_id uuid;
  v_auth_session_id uuid;

  v_quiz_id uuid;
  v_number_of_slots integer;
  v_grade_scale_max numeric;

  v_current_status text;
  v_deadline_status text;

  v_answered_slots integer;
  v_pending integer;
  v_graded integer;

  v_score numeric;
  v_total_points numeric;
  v_final_grade numeric;

  v_status text;
begin

  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;


  v_auth_session_id :=
    (auth.jwt() ->> 'session_id')::uuid;

  if v_auth_session_id is null then
    raise exception 'Sesión de autenticación inválida';
  end if;


  /*
   * Validar propiedad y sesión.
   *
   * No exigimos todavía status = in_progress
   * porque necesitamos poder devolver
   * limpiamente el estado expired.
   */
  select
    a.quiz_id,
    a.status,
    q.number_of_slots,
    q.grade_scale_max
  into
    v_quiz_id,
    v_current_status,
    v_number_of_slots,
    v_grade_scale_max
  from public.attempts a
  join public.quizzes q
    on q.id = a.quiz_id
  where a.id = p_attempt_id
    and a.student_id = v_user_id
    and a.active_session_id = v_auth_session_id
  for update of a;


  if v_quiz_id is null then
    raise exception
      'Intento inexistente o activo en otra sesión';
  end if;


  /*
   * Si ya expiró anteriormente,
   * devolvemos su estado sin intentar reabrirlo.
   */
  if v_current_status = 'expired' then

    select count(*)
    into v_pending
    from public.responses r
    where r.attempt_id = p_attempt_id
      and r.status = 'answered';


    select count(*)
    into v_graded
    from public.responses r
    where r.attempt_id = p_attempt_id
      and r.status = 'graded';


    select coalesce(sum(r.score), 0)
    into v_score
    from public.responses r
    where r.attempt_id = p_attempt_id
      and r.status = 'graded';


    return query
    select
      p_attempt_id,
      'expired'::text,
      v_pending,
      v_graded,
      v_score;

    return;

  end if;


  if v_current_status <> 'in_progress' then
    raise exception
      'El intento ya no está en progreso';
  end if;


  if v_number_of_slots is null then
    raise exception
      'El quiz no tiene definido number_of_slots';
  end if;


  /*
   * Contar slots que ya tienen una respuesta
   * aceptada por el backend.
   *
   * Si una respuesta fue aceptada, significa
   * que submit_response ya verificó su deadline.
   */
  select count(distinct r.slot_number)
  into v_answered_slots
  from public.responses r
  where r.attempt_id = p_attempt_id
    and r.status in ('answered', 'graded');


  /*
   * Si el quiz todavía está incompleto,
   * entonces sí comprobamos si venció.
   */
  if v_answered_slots <> v_number_of_slots then

    v_deadline_status :=
      private.enforce_attempt_deadline(
        p_attempt_id
      );


    if v_deadline_status = 'expired' then

      select count(*)
      into v_pending
      from public.responses r
      where r.attempt_id = p_attempt_id
        and r.status = 'answered';


      select count(*)
      into v_graded
      from public.responses r
      where r.attempt_id = p_attempt_id
        and r.status = 'graded';


      select coalesce(sum(r.score), 0)
      into v_score
      from public.responses r
      where r.attempt_id = p_attempt_id
        and r.status = 'graded';


      return query
      select
        p_attempt_id,
        'expired'::text,
        v_pending,
        v_graded,
        v_score;

      return;

    end if;


    raise exception
      'Quiz incompleto: respondidos % de %',
      v_answered_slots,
      v_number_of_slots;

  end if;


  /*
   * Desde aquí sabemos que TODAS las preguntas
   * fueron aceptadas por el backend mientras
   * todavía podían responderse.
   */

  select count(*)
  into v_pending
  from public.responses r
  where r.attempt_id = p_attempt_id
    and r.status = 'answered';


  select count(*)
  into v_graded
  from public.responses r
  where r.attempt_id = p_attempt_id
    and r.status = 'graded';


  select coalesce(sum(r.score), 0)
  into v_score
  from public.responses r
  where r.attempt_id = p_attempt_id
    and r.status = 'graded';


  /*
   * CASO A:
   * existen respuestas pendientes de LLM.
   */
  if v_pending > 0 then

    update public.attempts
    set
      status = 'submitted',
      current_question_id = null,
      submitted_at = now(),
      last_heartbeat_at = now()
    where id = p_attempt_id;

    v_status := 'submitted';


  /*
   * CASO B:
   * todas las respuestas ya están calificadas.
   */
  else

    select coalesce(sum(q.points), 0)
    into v_total_points
    from public.responses r
    join public.questions q
      on q.id = r.question_id
    where r.attempt_id = p_attempt_id
      and r.status = 'graded';


    if v_total_points <= 0 then
      raise exception
        'El quiz no tiene puntaje total válido';
    end if;


    v_final_grade :=
      round(
        (
          v_score
          / v_total_points
          * v_grade_scale_max
        )::numeric,
        2
      );


    update public.attempts
    set
      status = 'graded',
      current_question_id = null,
      score_points = v_score,
      grade = v_final_grade,
      submitted_at = now(),
      graded_at = now(),
      last_heartbeat_at = now()
    where id = p_attempt_id;

    v_status := 'graded';

  end if;


  return query
  select
    p_attempt_id,
    v_status,
    v_pending,
    v_graded,
    v_score;

end;
$$;


ALTER FUNCTION "public"."submit_quiz_attempt"("p_attempt_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."submit_response"("p_response_id" "uuid", "p_answer_payload" "jsonb") RETURNS TABLE("response_id" "uuid", "status" "text", "score" numeric, "needs_llm_grading" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_user_id uuid;
  v_auth_session_id uuid;

  v_attempt_id uuid;
  v_question_id uuid;
  v_question_type text;
  v_correct_answer jsonb;
  v_points numeric;
  v_slot_number integer;

  v_score numeric;
  v_needs_llm boolean;

  v_attempt_status text;
begin

  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;


  v_auth_session_id :=
    (auth.jwt() ->> 'session_id')::uuid;

  if v_auth_session_id is null then
    raise exception 'Sesión de autenticación inválida';
  end if;


  if p_answer_payload is null then
    raise exception 'La respuesta no puede estar vacía';
  end if;


  /*
   * Primero identificamos de forma segura
   * a qué intento pertenece esta respuesta.
   */
  select r.attempt_id
  into v_attempt_id
  from public.responses r
  join public.attempts a
    on a.id = r.attempt_id
  where r.id = p_response_id
    and a.student_id = v_user_id
    and a.active_session_id = v_auth_session_id;


  if v_attempt_id is null then
    raise exception
      'Respuesta inexistente o no autorizada';
  end if;


  /*
   * Verificamos el deadline ANTES
   * de aceptar la respuesta.
   */
  v_attempt_status :=
    private.enforce_attempt_deadline(
      v_attempt_id
    );


  /*
   * No usamos raise exception aquí:
   * hacerlo revertiría la transición a expired.
   */
  if v_attempt_status = 'expired' then

    return query
    select
      p_response_id,
      'expired'::text,
      null::numeric,
      false;

    return;

  end if;


  /*
   * Validar simultáneamente:
   *
   * - respuesta asignada;
   * - intento del estudiante;
   * - intento todavía en progreso;
   * - misma sesión autenticada;
   * - pregunta actualmente activa.
   */
  select
    r.attempt_id,
    r.question_id,
    q.question_type,
    q.correct_answer,
    q.points,
    q.slot_number
  into
    v_attempt_id,
    v_question_id,
    v_question_type,
    v_correct_answer,
    v_points,
    v_slot_number
  from public.responses r
  join public.attempts a
    on a.id = r.attempt_id
  join public.questions q
    on q.id = r.question_id
  where r.id = p_response_id
    and r.status = 'assigned'
    and a.student_id = v_user_id
    and a.status = 'in_progress'
    and a.active_session_id = v_auth_session_id
    and a.current_question_id = r.question_id
  for update of r;


  if v_attempt_id is null then
    raise exception
      'Respuesta inexistente, ya respondida o no autorizada';
  end if;


  /*
   * Selección múltiple:
   * calificación determinista inmediata.
   */
  if v_question_type = 'multiple_choice' then

    if p_answer_payload = v_correct_answer then
      v_score := v_points;
    else
      v_score := 0;
    end if;

    v_needs_llm := false;


    update public.responses
    set
      answer_payload = p_answer_payload,
      status = 'graded',
      score = v_score,
      grading_method = 'deterministic',
      answered_at = now(),
      graded_at = now()
    where id = p_response_id;


  /*
   * Texto corto o fotografía:
   * queda pendiente de evaluación.
   */
  else

    v_score := null;
    v_needs_llm := true;


    update public.responses
    set
      answer_payload = p_answer_payload,
      status = 'answered',
      answered_at = now()
    where id = p_response_id;

  end if;


  /*
   * Liberar la pregunta actual
   * y avanzar al siguiente slot.
   */
  update public.attempts
  set
    current_question_id = null,
    current_slot = v_slot_number + 1,
    last_heartbeat_at = now()
  where id = v_attempt_id;


  return query
  select
    p_response_id,
    case
      when v_needs_llm then 'answered'::text
      else 'graded'::text
    end,
    v_score,
    v_needs_llm;

end;
$$;


ALTER FUNCTION "public"."submit_response"("p_response_id" "uuid", "p_answer_payload" "jsonb") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."attempts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "quiz_id" "uuid" NOT NULL,
    "student_id" "uuid" NOT NULL,
    "quiz_session_id" "uuid",
    "status" "text" DEFAULT 'not_started'::"text" NOT NULL,
    "current_slot" integer,
    "current_question_id" "uuid",
    "active_session_id" "uuid",
    "session_started_at" timestamp with time zone,
    "last_heartbeat_at" timestamp with time zone,
    "focus_violation_count" integer DEFAULT 0 NOT NULL,
    "score_points" numeric,
    "grade" numeric,
    "started_at" timestamp with time zone,
    "submitted_at" timestamp with time zone,
    "graded_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expired_at" timestamp with time zone,
    "deadline_at" timestamp with time zone,
    CONSTRAINT "attempts_current_slot_check" CHECK ((("current_slot" IS NULL) OR ("current_slot" > 0))),
    CONSTRAINT "attempts_deadline_check" CHECK ((("deadline_at" IS NULL) OR ("started_at" IS NULL) OR ("deadline_at" > "started_at"))),
    CONSTRAINT "attempts_focus_violation_count_check" CHECK (("focus_violation_count" >= 0)),
    CONSTRAINT "attempts_grade_check" CHECK ((("grade" IS NULL) OR ("grade" >= (0)::numeric))),
    CONSTRAINT "attempts_score_points_check" CHECK ((("score_points" IS NULL) OR ("score_points" >= (0)::numeric))),
    CONSTRAINT "attempts_status_check" CHECK (("status" = ANY (ARRAY['not_started'::"text", 'in_progress'::"text", 'submitted'::"text", 'graded'::"text", 'blocked'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."attempts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."course_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "course_id" "uuid" NOT NULL,
    "student_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "enrolled_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "course_members_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'inactive'::"text"])))
);


ALTER TABLE "public"."course_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."courses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "teacher_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "code" "text",
    "group_name" "text",
    "academic_period" "text",
    "join_code" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "nickname" "text" NOT NULL,
    CONSTRAINT "courses_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'archived'::"text"])))
);


ALTER TABLE "public"."courses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."focus_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "attempt_id" "uuid" NOT NULL,
    "event_type" "text" NOT NULL,
    "from_question_id" "uuid",
    "replacement_question_id" "uuid",
    "occurred_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "metadata" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "focus_events_event_type_check" CHECK (("event_type" = ANY (ARRAY['blur'::"text", 'visibility_hidden'::"text", 'fullscreen_exit'::"text", 'reload'::"text"])))
);


ALTER TABLE "public"."focus_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."llm_credentials" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "teacher_id" "uuid" NOT NULL,
    "provider" "text" NOT NULL,
    "encrypted_api_key" "text" NOT NULL,
    "default_model" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "llm_credentials_provider_check" CHECK (("provider" = ANY (ARRAY['openai'::"text", 'gemini'::"text", 'deepseek'::"text"])))
);


ALTER TABLE "public"."llm_credentials" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."llm_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "teacher_id" "uuid",
    "quiz_id" "uuid",
    "attempt_id" "uuid",
    "response_id" "uuid",
    "purpose" "text" NOT NULL,
    "provider" "text" NOT NULL,
    "model" "text" NOT NULL,
    "status" "text" NOT NULL,
    "input_tokens" integer,
    "output_tokens" integer,
    "latency_ms" integer,
    "result_metadata" "jsonb",
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "llm_runs_input_tokens_check" CHECK ((("input_tokens" IS NULL) OR ("input_tokens" >= 0))),
    CONSTRAINT "llm_runs_latency_ms_check" CHECK ((("latency_ms" IS NULL) OR ("latency_ms" >= 0))),
    CONSTRAINT "llm_runs_output_tokens_check" CHECK ((("output_tokens" IS NULL) OR ("output_tokens" >= 0))),
    CONSTRAINT "llm_runs_purpose_check" CHECK (("purpose" = ANY (ARRAY['quiz_generation'::"text", 'short_text_grading'::"text", 'image_grading'::"text"]))),
    CONSTRAINT "llm_runs_status_check" CHECK (("status" = ANY (ARRAY['success'::"text", 'error'::"text"])))
);


ALTER TABLE "public"."llm_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "full_name" "text" NOT NULL,
    "is_teacher" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."questions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "quiz_id" "uuid" NOT NULL,
    "slot_number" integer NOT NULL,
    "variant_number" integer NOT NULL,
    "question_type" "text" NOT NULL,
    "statement" "text" NOT NULL,
    "options" "jsonb",
    "correct_answer" "jsonb",
    "rubric" "jsonb",
    "points" numeric DEFAULT 1.0 NOT NULL,
    "source_reference" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "questions_points_check" CHECK (("points" > (0)::numeric)),
    CONSTRAINT "questions_question_type_check" CHECK (("question_type" = ANY (ARRAY['multiple_choice'::"text", 'short_text'::"text", 'image'::"text"]))),
    CONSTRAINT "questions_slot_number_check" CHECK (("slot_number" > 0)),
    CONSTRAINT "questions_variant_number_check" CHECK (("variant_number" > 0))
);


ALTER TABLE "public"."questions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."quiz_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "quiz_id" "uuid" NOT NULL,
    "created_by" "uuid" NOT NULL,
    "qr_token_hash" "text" NOT NULL,
    "starts_at" timestamp with time zone NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "status" "text" DEFAULT 'scheduled'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "quiz_sessions_check" CHECK (("expires_at" > "starts_at")),
    CONSTRAINT "quiz_sessions_status_check" CHECK (("status" = ANY (ARRAY['scheduled'::"text", 'active'::"text", 'closed'::"text"])))
);


ALTER TABLE "public"."quiz_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."quizzes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "course_id" "uuid" NOT NULL,
    "source_document_id" "uuid",
    "created_by" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "instructions" "text",
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "opens_at" timestamp with time zone,
    "closes_at" timestamp with time zone,
    "duration_minutes" integer,
    "grade_scale_max" numeric DEFAULT 5.0 NOT NULL,
    "number_of_slots" integer,
    "variants_per_slot" integer,
    "focus_replacement" boolean DEFAULT true NOT NULL,
    "max_focus_violations" integer,
    "llm_provider" "text",
    "llm_model" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "published_at" timestamp with time zone,
    "delivery_mode" "text" DEFAULT 'in_person'::"text" NOT NULL,
    CONSTRAINT "quizzes_async_schedule_check" CHECK ((("delivery_mode" <> 'asynchronous'::"text") OR (("opens_at" IS NOT NULL) AND ("closes_at" IS NOT NULL) AND ("closes_at" > "opens_at")))),
    CONSTRAINT "quizzes_delivery_mode_check" CHECK (("delivery_mode" = ANY (ARRAY['in_person'::"text", 'asynchronous'::"text"]))),
    CONSTRAINT "quizzes_duration_minutes_check" CHECK ((("duration_minutes" IS NULL) OR ("duration_minutes" > 0))),
    CONSTRAINT "quizzes_grade_scale_max_check" CHECK (("grade_scale_max" > (0)::numeric)),
    CONSTRAINT "quizzes_max_focus_violations_check" CHECK ((("max_focus_violations" IS NULL) OR ("max_focus_violations" >= 0))),
    CONSTRAINT "quizzes_number_of_slots_check" CHECK ((("number_of_slots" IS NULL) OR ("number_of_slots" > 0))),
    CONSTRAINT "quizzes_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'published'::"text", 'closed'::"text"]))),
    CONSTRAINT "quizzes_variants_per_slot_check" CHECK ((("variants_per_slot" IS NULL) OR ("variants_per_slot" > 0)))
);


ALTER TABLE "public"."quizzes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."responses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "attempt_id" "uuid" NOT NULL,
    "question_id" "uuid" NOT NULL,
    "slot_number" integer NOT NULL,
    "status" "text" DEFAULT 'assigned'::"text" NOT NULL,
    "answer_payload" "jsonb",
    "score" numeric,
    "feedback" "text",
    "grading_method" "text",
    "assigned_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "answered_at" timestamp with time zone,
    "graded_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "responses_grading_method_check" CHECK ((("grading_method" IS NULL) OR ("grading_method" = ANY (ARRAY['deterministic'::"text", 'llm'::"text", 'teacher'::"text"])))),
    CONSTRAINT "responses_score_check" CHECK ((("score" IS NULL) OR ("score" >= (0)::numeric))),
    CONSTRAINT "responses_slot_number_check" CHECK (("slot_number" > 0)),
    CONSTRAINT "responses_status_check" CHECK (("status" = ANY (ARRAY['assigned'::"text", 'answered'::"text", 'invalidated'::"text", 'graded'::"text"])))
);


ALTER TABLE "public"."responses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."source_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "course_id" "uuid" NOT NULL,
    "uploaded_by" "uuid" NOT NULL,
    "original_filename" "text" NOT NULL,
    "storage_path" "text" NOT NULL,
    "mime_type" "text",
    "file_size_bytes" bigint,
    "sha256" "text",
    "processing_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "drive_backup_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "source_documents_processing_status_check" CHECK (("processing_status" = ANY (ARRAY['pending'::"text", 'processing'::"text", 'ready'::"text", 'error'::"text"])))
);


ALTER TABLE "public"."source_documents" OWNER TO "postgres";


ALTER TABLE ONLY "public"."attempts"
    ADD CONSTRAINT "attempts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."attempts"
    ADD CONSTRAINT "attempts_quiz_id_student_id_key" UNIQUE ("quiz_id", "student_id");



ALTER TABLE ONLY "public"."course_members"
    ADD CONSTRAINT "course_members_course_id_student_id_key" UNIQUE ("course_id", "student_id");



ALTER TABLE ONLY "public"."course_members"
    ADD CONSTRAINT "course_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."courses"
    ADD CONSTRAINT "courses_join_code_key" UNIQUE ("join_code");



ALTER TABLE ONLY "public"."courses"
    ADD CONSTRAINT "courses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."focus_events"
    ADD CONSTRAINT "focus_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."llm_credentials"
    ADD CONSTRAINT "llm_credentials_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."llm_credentials"
    ADD CONSTRAINT "llm_credentials_teacher_id_provider_key" UNIQUE ("teacher_id", "provider");



ALTER TABLE ONLY "public"."llm_runs"
    ADD CONSTRAINT "llm_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."questions"
    ADD CONSTRAINT "questions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."questions"
    ADD CONSTRAINT "questions_quiz_id_slot_number_variant_number_key" UNIQUE ("quiz_id", "slot_number", "variant_number");



ALTER TABLE ONLY "public"."quiz_sessions"
    ADD CONSTRAINT "quiz_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."quiz_sessions"
    ADD CONSTRAINT "quiz_sessions_qr_token_hash_key" UNIQUE ("qr_token_hash");



ALTER TABLE ONLY "public"."quizzes"
    ADD CONSTRAINT "quizzes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."responses"
    ADD CONSTRAINT "responses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."source_documents"
    ADD CONSTRAINT "source_documents_pkey" PRIMARY KEY ("id");



CREATE UNIQUE INDEX "courses_teacher_nickname_unique" ON "public"."courses" USING "btree" ("teacher_id", "lower"("nickname"));



CREATE OR REPLACE TRIGGER "courses_set_updated_at" BEFORE UPDATE ON "public"."courses" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "llm_credentials_set_updated_at" BEFORE UPDATE ON "public"."llm_credentials" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "profiles_set_updated_at" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



ALTER TABLE ONLY "public"."attempts"
    ADD CONSTRAINT "attempts_current_question_id_fkey" FOREIGN KEY ("current_question_id") REFERENCES "public"."questions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."attempts"
    ADD CONSTRAINT "attempts_quiz_id_fkey" FOREIGN KEY ("quiz_id") REFERENCES "public"."quizzes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."attempts"
    ADD CONSTRAINT "attempts_quiz_session_id_fkey" FOREIGN KEY ("quiz_session_id") REFERENCES "public"."quiz_sessions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."attempts"
    ADD CONSTRAINT "attempts_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."course_members"
    ADD CONSTRAINT "course_members_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."course_members"
    ADD CONSTRAINT "course_members_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."courses"
    ADD CONSTRAINT "courses_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "public"."profiles"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."focus_events"
    ADD CONSTRAINT "focus_events_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."focus_events"
    ADD CONSTRAINT "focus_events_from_question_id_fkey" FOREIGN KEY ("from_question_id") REFERENCES "public"."questions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."focus_events"
    ADD CONSTRAINT "focus_events_replacement_question_id_fkey" FOREIGN KEY ("replacement_question_id") REFERENCES "public"."questions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."llm_credentials"
    ADD CONSTRAINT "llm_credentials_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."llm_runs"
    ADD CONSTRAINT "llm_runs_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."llm_runs"
    ADD CONSTRAINT "llm_runs_quiz_id_fkey" FOREIGN KEY ("quiz_id") REFERENCES "public"."quizzes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."llm_runs"
    ADD CONSTRAINT "llm_runs_response_id_fkey" FOREIGN KEY ("response_id") REFERENCES "public"."responses"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."llm_runs"
    ADD CONSTRAINT "llm_runs_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."questions"
    ADD CONSTRAINT "questions_quiz_id_fkey" FOREIGN KEY ("quiz_id") REFERENCES "public"."quizzes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."quiz_sessions"
    ADD CONSTRAINT "quiz_sessions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."quiz_sessions"
    ADD CONSTRAINT "quiz_sessions_quiz_id_fkey" FOREIGN KEY ("quiz_id") REFERENCES "public"."quizzes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."quizzes"
    ADD CONSTRAINT "quizzes_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."quizzes"
    ADD CONSTRAINT "quizzes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."quizzes"
    ADD CONSTRAINT "quizzes_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_documents"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."responses"
    ADD CONSTRAINT "responses_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."responses"
    ADD CONSTRAINT "responses_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."source_documents"
    ADD CONSTRAINT "source_documents_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."source_documents"
    ADD CONSTRAINT "source_documents_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "public"."profiles"("id") ON DELETE RESTRICT;



CREATE POLICY "Students can read enrolled courses" ON "public"."courses" FOR SELECT TO "authenticated" USING ("private"."is_course_member"("id"));



CREATE POLICY "Students can read own attempts" ON "public"."attempts" FOR SELECT TO "authenticated" USING (("student_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "Students can read own focus events" ON "public"."focus_events" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."attempts" "a"
  WHERE (("a"."id" = "focus_events"."attempt_id") AND ("a"."student_id" = ( SELECT "auth"."uid"() AS "uid"))))));



CREATE POLICY "Students can read own memberships" ON "public"."course_members" FOR SELECT TO "authenticated" USING (("student_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "Students can read own responses" ON "public"."responses" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."attempts" "a"
  WHERE (("a"."id" = "responses"."attempt_id") AND ("a"."student_id" = ( SELECT "auth"."uid"() AS "uid"))))));



CREATE POLICY "Students can read profiles of their teachers" ON "public"."profiles" FOR SELECT TO "authenticated" USING ("private"."is_teacher_of_student"("id"));



CREATE POLICY "Students can read published quizzes of enrolled courses" ON "public"."quizzes" FOR SELECT TO "authenticated" USING ((("status" = ANY (ARRAY['published'::"text", 'closed'::"text"])) AND "private"."is_course_member"("course_id")));



CREATE POLICY "Teachers can add documents to own courses" ON "public"."source_documents" FOR INSERT TO "authenticated" WITH CHECK ((("uploaded_by" = ( SELECT "auth"."uid"() AS "uid")) AND (EXISTS ( SELECT 1
   FROM "public"."courses" "c"
  WHERE (("c"."id" = "source_documents"."course_id") AND ("c"."teacher_id" = ( SELECT "auth"."uid"() AS "uid")))))));



CREATE POLICY "Teachers can add students to own courses" ON "public"."course_members" FOR INSERT TO "authenticated" WITH CHECK (("course_id" IN ( SELECT "c"."id"
   FROM "public"."courses" "c"
  WHERE ("c"."teacher_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "Teachers can create own courses" ON "public"."courses" FOR INSERT TO "authenticated" WITH CHECK ((("teacher_id" = ( SELECT "auth"."uid"() AS "uid")) AND (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_teacher" = true))))));



CREATE POLICY "Teachers can create own llm credentials" ON "public"."llm_credentials" FOR INSERT TO "authenticated" WITH CHECK ((("teacher_id" = ( SELECT "auth"."uid"() AS "uid")) AND "private"."is_teacher"()));



CREATE POLICY "Teachers can create questions in own quizzes" ON "public"."questions" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."quizzes" "q"
  WHERE (("q"."id" = "questions"."quiz_id") AND "private"."owns_course"("q"."course_id")))));



CREATE POLICY "Teachers can create quizzes in own courses" ON "public"."quizzes" FOR INSERT TO "authenticated" WITH CHECK ((("created_by" = ( SELECT "auth"."uid"() AS "uid")) AND "private"."is_teacher"() AND "private"."owns_course"("course_id")));



CREATE POLICY "Teachers can create sessions for own quizzes" ON "public"."quiz_sessions" FOR INSERT TO "authenticated" WITH CHECK ((("created_by" = ( SELECT "auth"."uid"() AS "uid")) AND "private"."is_teacher"() AND (EXISTS ( SELECT 1
   FROM "public"."quizzes" "q"
  WHERE (("q"."id" = "quiz_sessions"."quiz_id") AND "private"."owns_course"("q"."course_id"))))));



CREATE POLICY "Teachers can delete documents of own courses" ON "public"."source_documents" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."courses" "c"
  WHERE (("c"."id" = "source_documents"."course_id") AND ("c"."teacher_id" = ( SELECT "auth"."uid"() AS "uid"))))));



CREATE POLICY "Teachers can delete own courses" ON "public"."courses" FOR DELETE TO "authenticated" USING ((("teacher_id" = ( SELECT "auth"."uid"() AS "uid")) AND (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_teacher" = true))))));



CREATE POLICY "Teachers can delete own llm credentials" ON "public"."llm_credentials" FOR DELETE TO "authenticated" USING ((("teacher_id" = ( SELECT "auth"."uid"() AS "uid")) AND "private"."is_teacher"()));



CREATE POLICY "Teachers can delete questions of own quizzes" ON "public"."questions" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."quizzes" "q"
  WHERE (("q"."id" = "questions"."quiz_id") AND "private"."owns_course"("q"."course_id")))));



CREATE POLICY "Teachers can delete quizzes of own courses" ON "public"."quizzes" FOR DELETE TO "authenticated" USING ("private"."owns_course"("course_id"));



CREATE POLICY "Teachers can delete sessions of own quizzes" ON "public"."quiz_sessions" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."quizzes" "q"
  WHERE (("q"."id" = "quiz_sessions"."quiz_id") AND "private"."owns_course"("q"."course_id")))));



CREATE POLICY "Teachers can read attempts of own courses" ON "public"."attempts" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."quizzes" "q"
  WHERE (("q"."id" = "attempts"."quiz_id") AND "private"."owns_course"("q"."course_id")))));



CREATE POLICY "Teachers can read documents of own courses" ON "public"."source_documents" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."courses" "c"
  WHERE (("c"."id" = "source_documents"."course_id") AND ("c"."teacher_id" = ( SELECT "auth"."uid"() AS "uid"))))));



CREATE POLICY "Teachers can read focus events of own courses" ON "public"."focus_events" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM ("public"."attempts" "a"
     JOIN "public"."quizzes" "q" ON (("q"."id" = "a"."quiz_id")))
  WHERE (("a"."id" = "focus_events"."attempt_id") AND "private"."owns_course"("q"."course_id")))));



CREATE POLICY "Teachers can read memberships of own courses" ON "public"."course_members" FOR SELECT TO "authenticated" USING (("course_id" IN ( SELECT "c"."id"
   FROM "public"."courses" "c"
  WHERE ("c"."teacher_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "Teachers can read own courses" ON "public"."courses" FOR SELECT TO "authenticated" USING ((("teacher_id" = ( SELECT "auth"."uid"() AS "uid")) AND (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_teacher" = true))))));



CREATE POLICY "Teachers can read own llm credentials" ON "public"."llm_credentials" FOR SELECT TO "authenticated" USING ((("teacher_id" = ( SELECT "auth"."uid"() AS "uid")) AND "private"."is_teacher"()));



CREATE POLICY "Teachers can read own llm runs" ON "public"."llm_runs" FOR SELECT TO "authenticated" USING ((("teacher_id" = ( SELECT "auth"."uid"() AS "uid")) AND "private"."is_teacher"()));



CREATE POLICY "Teachers can read profiles of own students" ON "public"."profiles" FOR SELECT TO "authenticated" USING (("private"."is_teacher"() AND "private"."is_student_of_teacher"("id")));



CREATE POLICY "Teachers can read questions of own quizzes" ON "public"."questions" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."quizzes" "q"
  WHERE (("q"."id" = "questions"."quiz_id") AND "private"."owns_course"("q"."course_id")))));



CREATE POLICY "Teachers can read quizzes of own courses" ON "public"."quizzes" FOR SELECT TO "authenticated" USING ("private"."owns_course"("course_id"));



CREATE POLICY "Teachers can read responses of own courses" ON "public"."responses" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM ("public"."attempts" "a"
     JOIN "public"."quizzes" "q" ON (("q"."id" = "a"."quiz_id")))
  WHERE (("a"."id" = "responses"."attempt_id") AND "private"."owns_course"("q"."course_id")))));



CREATE POLICY "Teachers can read sessions of own quizzes" ON "public"."quiz_sessions" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."quizzes" "q"
  WHERE (("q"."id" = "quiz_sessions"."quiz_id") AND "private"."owns_course"("q"."course_id")))));



CREATE POLICY "Teachers can remove students from own courses" ON "public"."course_members" FOR DELETE TO "authenticated" USING (("course_id" IN ( SELECT "c"."id"
   FROM "public"."courses" "c"
  WHERE ("c"."teacher_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "Teachers can update documents of own courses" ON "public"."source_documents" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."courses" "c"
  WHERE (("c"."id" = "source_documents"."course_id") AND ("c"."teacher_id" = ( SELECT "auth"."uid"() AS "uid")))))) WITH CHECK ((("uploaded_by" = ( SELECT "auth"."uid"() AS "uid")) AND (EXISTS ( SELECT 1
   FROM "public"."courses" "c"
  WHERE (("c"."id" = "source_documents"."course_id") AND ("c"."teacher_id" = ( SELECT "auth"."uid"() AS "uid")))))));



CREATE POLICY "Teachers can update memberships of own courses" ON "public"."course_members" FOR UPDATE TO "authenticated" USING (("course_id" IN ( SELECT "c"."id"
   FROM "public"."courses" "c"
  WHERE ("c"."teacher_id" = ( SELECT "auth"."uid"() AS "uid"))))) WITH CHECK (("course_id" IN ( SELECT "c"."id"
   FROM "public"."courses" "c"
  WHERE ("c"."teacher_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "Teachers can update own courses" ON "public"."courses" FOR UPDATE TO "authenticated" USING ((("teacher_id" = ( SELECT "auth"."uid"() AS "uid")) AND (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_teacher" = true)))))) WITH CHECK ((("teacher_id" = ( SELECT "auth"."uid"() AS "uid")) AND (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_teacher" = true))))));



CREATE POLICY "Teachers can update own llm credentials" ON "public"."llm_credentials" FOR UPDATE TO "authenticated" USING ((("teacher_id" = ( SELECT "auth"."uid"() AS "uid")) AND "private"."is_teacher"())) WITH CHECK ((("teacher_id" = ( SELECT "auth"."uid"() AS "uid")) AND "private"."is_teacher"()));



CREATE POLICY "Teachers can update questions of own quizzes" ON "public"."questions" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."quizzes" "q"
  WHERE (("q"."id" = "questions"."quiz_id") AND "private"."owns_course"("q"."course_id"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."quizzes" "q"
  WHERE (("q"."id" = "questions"."quiz_id") AND "private"."owns_course"("q"."course_id")))));



CREATE POLICY "Teachers can update quizzes of own courses" ON "public"."quizzes" FOR UPDATE TO "authenticated" USING ("private"."owns_course"("course_id")) WITH CHECK ((("created_by" = ( SELECT "auth"."uid"() AS "uid")) AND "private"."owns_course"("course_id")));



CREATE POLICY "Teachers can update sessions of own quizzes" ON "public"."quiz_sessions" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."quizzes" "q"
  WHERE (("q"."id" = "quiz_sessions"."quiz_id") AND "private"."owns_course"("q"."course_id"))))) WITH CHECK ((("created_by" = ( SELECT "auth"."uid"() AS "uid")) AND (EXISTS ( SELECT 1
   FROM "public"."quizzes" "q"
  WHERE (("q"."id" = "quiz_sessions"."quiz_id") AND "private"."owns_course"("q"."course_id"))))));



CREATE POLICY "Users can read own profile" ON "public"."profiles" FOR SELECT TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "id"));



CREATE POLICY "Users can update own profile" ON "public"."profiles" FOR UPDATE TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "id")) WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "id"));



ALTER TABLE "public"."attempts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."course_members" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."courses" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."focus_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."llm_credentials" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."llm_runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."questions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."quiz_sessions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."quizzes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."responses" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."source_documents" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


GRANT USAGE ON SCHEMA "private" TO "authenticated";



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";






















































































































































REVOKE ALL ON FUNCTION "private"."enforce_attempt_deadline"("p_attempt_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."is_course_member"("p_course_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."is_course_member"("p_course_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "private"."is_student_of_teacher"("p_student_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."is_student_of_teacher"("p_student_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "private"."is_teacher"() FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."is_teacher"() TO "authenticated";



REVOKE ALL ON FUNCTION "private"."is_teacher_of_student"("p_teacher_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."is_teacher_of_student"("p_teacher_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "private"."owns_course"("p_course_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."owns_course"("p_course_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."apply_llm_grade"("p_response_id" "uuid", "p_score" numeric, "p_feedback" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."apply_llm_grade"("p_response_id" "uuid", "p_score" numeric, "p_feedback" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."close_quiz_session"("p_quiz_session_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."close_quiz_session"("p_quiz_session_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."close_quiz_session"("p_quiz_session_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."close_quiz_session"("p_quiz_session_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_quiz_session"("p_quiz_id" "uuid", "p_access_minutes" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_quiz_session"("p_quiz_id" "uuid", "p_access_minutes" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."create_quiz_session"("p_quiz_id" "uuid", "p_access_minutes" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_quiz_session"("p_quiz_id" "uuid", "p_access_minutes" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_current_question"("p_attempt_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_current_question"("p_attempt_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_current_question"("p_attempt_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_current_question"("p_attempt_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_quiz_session_live_status"("p_quiz_session_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_quiz_session_live_status"("p_quiz_session_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_quiz_session_live_status"("p_quiz_session_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_quiz_session_live_status"("p_quiz_session_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_student_quiz_history"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_student_quiz_history"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_student_quiz_history"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_student_quiz_history"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."heartbeat_quiz_attempt"("p_attempt_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."heartbeat_quiz_attempt"("p_attempt_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."heartbeat_quiz_attempt"("p_attempt_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."heartbeat_quiz_attempt"("p_attempt_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."join_quiz_session"("p_qr_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."join_quiz_session"("p_qr_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."join_quiz_session"("p_qr_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."join_quiz_session"("p_qr_token" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."replace_question_on_focus_loss"("p_attempt_id" "uuid", "p_event_type" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."replace_question_on_focus_loss"("p_attempt_id" "uuid", "p_event_type" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."replace_question_on_focus_loss"("p_attempt_id" "uuid", "p_event_type" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."replace_question_on_focus_loss"("p_attempt_id" "uuid", "p_event_type" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "anon";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."start_async_quiz_attempt"("p_quiz_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."start_async_quiz_attempt"("p_quiz_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."start_async_quiz_attempt"("p_quiz_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."start_async_quiz_attempt"("p_quiz_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."submit_quiz_attempt"("p_attempt_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."submit_quiz_attempt"("p_attempt_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."submit_quiz_attempt"("p_attempt_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."submit_quiz_attempt"("p_attempt_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."submit_response"("p_response_id" "uuid", "p_answer_payload" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."submit_response"("p_response_id" "uuid", "p_answer_payload" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."submit_response"("p_response_id" "uuid", "p_answer_payload" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."submit_response"("p_response_id" "uuid", "p_answer_payload" "jsonb") TO "service_role";


















GRANT ALL ON TABLE "public"."attempts" TO "anon";
GRANT ALL ON TABLE "public"."attempts" TO "authenticated";
GRANT ALL ON TABLE "public"."attempts" TO "service_role";



GRANT ALL ON TABLE "public"."course_members" TO "anon";
GRANT ALL ON TABLE "public"."course_members" TO "authenticated";
GRANT ALL ON TABLE "public"."course_members" TO "service_role";



GRANT ALL ON TABLE "public"."courses" TO "anon";
GRANT ALL ON TABLE "public"."courses" TO "authenticated";
GRANT ALL ON TABLE "public"."courses" TO "service_role";



GRANT ALL ON TABLE "public"."focus_events" TO "anon";
GRANT ALL ON TABLE "public"."focus_events" TO "authenticated";
GRANT ALL ON TABLE "public"."focus_events" TO "service_role";



GRANT ALL ON TABLE "public"."llm_credentials" TO "anon";
GRANT ALL ON TABLE "public"."llm_credentials" TO "authenticated";
GRANT ALL ON TABLE "public"."llm_credentials" TO "service_role";



GRANT ALL ON TABLE "public"."llm_runs" TO "anon";
GRANT ALL ON TABLE "public"."llm_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."llm_runs" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT UPDATE("full_name") ON TABLE "public"."profiles" TO "authenticated";



GRANT ALL ON TABLE "public"."questions" TO "anon";
GRANT ALL ON TABLE "public"."questions" TO "authenticated";
GRANT ALL ON TABLE "public"."questions" TO "service_role";



GRANT ALL ON TABLE "public"."quiz_sessions" TO "anon";
GRANT ALL ON TABLE "public"."quiz_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."quiz_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."quizzes" TO "anon";
GRANT ALL ON TABLE "public"."quizzes" TO "authenticated";
GRANT ALL ON TABLE "public"."quizzes" TO "service_role";



GRANT ALL ON TABLE "public"."responses" TO "anon";
GRANT ALL ON TABLE "public"."responses" TO "authenticated";
GRANT ALL ON TABLE "public"."responses" TO "service_role";



GRANT ALL ON TABLE "public"."source_documents" TO "anon";
GRANT ALL ON TABLE "public"."source_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."source_documents" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";



































drop extension if exists "pg_net";

drop trigger if exists "courses_set_updated_at" on "public"."courses";

drop trigger if exists "llm_credentials_set_updated_at" on "public"."llm_credentials";

drop trigger if exists "profiles_set_updated_at" on "public"."profiles";

drop policy "Teachers can read attempts of own courses" on "public"."attempts";

drop policy "Teachers can add students to own courses" on "public"."course_members";

drop policy "Teachers can read memberships of own courses" on "public"."course_members";

drop policy "Teachers can remove students from own courses" on "public"."course_members";

drop policy "Teachers can update memberships of own courses" on "public"."course_members";

drop policy "Teachers can create own courses" on "public"."courses";

drop policy "Teachers can delete own courses" on "public"."courses";

drop policy "Teachers can read own courses" on "public"."courses";

drop policy "Teachers can update own courses" on "public"."courses";

drop policy "Students can read own focus events" on "public"."focus_events";

drop policy "Teachers can read focus events of own courses" on "public"."focus_events";

drop policy "Teachers can create questions in own quizzes" on "public"."questions";

drop policy "Teachers can delete questions of own quizzes" on "public"."questions";

drop policy "Teachers can read questions of own quizzes" on "public"."questions";

drop policy "Teachers can update questions of own quizzes" on "public"."questions";

drop policy "Teachers can create sessions for own quizzes" on "public"."quiz_sessions";

drop policy "Teachers can delete sessions of own quizzes" on "public"."quiz_sessions";

drop policy "Teachers can read sessions of own quizzes" on "public"."quiz_sessions";

drop policy "Teachers can update sessions of own quizzes" on "public"."quiz_sessions";

drop policy "Students can read own responses" on "public"."responses";

drop policy "Teachers can read responses of own courses" on "public"."responses";

drop policy "Teachers can add documents to own courses" on "public"."source_documents";

drop policy "Teachers can delete documents of own courses" on "public"."source_documents";

drop policy "Teachers can read documents of own courses" on "public"."source_documents";

drop policy "Teachers can update documents of own courses" on "public"."source_documents";

revoke update on table "public"."profiles" from "authenticated";

alter table "public"."attempts" drop constraint "attempts_current_question_id_fkey";

alter table "public"."attempts" drop constraint "attempts_quiz_id_fkey";

alter table "public"."attempts" drop constraint "attempts_quiz_session_id_fkey";

alter table "public"."attempts" drop constraint "attempts_student_id_fkey";

alter table "public"."course_members" drop constraint "course_members_course_id_fkey";

alter table "public"."course_members" drop constraint "course_members_student_id_fkey";

alter table "public"."courses" drop constraint "courses_teacher_id_fkey";

alter table "public"."focus_events" drop constraint "focus_events_attempt_id_fkey";

alter table "public"."focus_events" drop constraint "focus_events_from_question_id_fkey";

alter table "public"."focus_events" drop constraint "focus_events_replacement_question_id_fkey";

alter table "public"."llm_credentials" drop constraint "llm_credentials_teacher_id_fkey";

alter table "public"."llm_runs" drop constraint "llm_runs_attempt_id_fkey";

alter table "public"."llm_runs" drop constraint "llm_runs_quiz_id_fkey";

alter table "public"."llm_runs" drop constraint "llm_runs_response_id_fkey";

alter table "public"."llm_runs" drop constraint "llm_runs_teacher_id_fkey";

alter table "public"."questions" drop constraint "questions_quiz_id_fkey";

alter table "public"."quiz_sessions" drop constraint "quiz_sessions_created_by_fkey";

alter table "public"."quiz_sessions" drop constraint "quiz_sessions_quiz_id_fkey";

alter table "public"."quizzes" drop constraint "quizzes_course_id_fkey";

alter table "public"."quizzes" drop constraint "quizzes_created_by_fkey";

alter table "public"."quizzes" drop constraint "quizzes_source_document_id_fkey";

alter table "public"."responses" drop constraint "responses_attempt_id_fkey";

alter table "public"."responses" drop constraint "responses_question_id_fkey";

alter table "public"."source_documents" drop constraint "source_documents_course_id_fkey";

alter table "public"."source_documents" drop constraint "source_documents_uploaded_by_fkey";

alter table "public"."attempts" add constraint "attempts_current_question_id_fkey" FOREIGN KEY (current_question_id) REFERENCES public.questions(id) ON DELETE SET NULL not valid;

alter table "public"."attempts" validate constraint "attempts_current_question_id_fkey";

alter table "public"."attempts" add constraint "attempts_quiz_id_fkey" FOREIGN KEY (quiz_id) REFERENCES public.quizzes(id) ON DELETE CASCADE not valid;

alter table "public"."attempts" validate constraint "attempts_quiz_id_fkey";

alter table "public"."attempts" add constraint "attempts_quiz_session_id_fkey" FOREIGN KEY (quiz_session_id) REFERENCES public.quiz_sessions(id) ON DELETE SET NULL not valid;

alter table "public"."attempts" validate constraint "attempts_quiz_session_id_fkey";

alter table "public"."attempts" add constraint "attempts_student_id_fkey" FOREIGN KEY (student_id) REFERENCES public.profiles(id) ON DELETE CASCADE not valid;

alter table "public"."attempts" validate constraint "attempts_student_id_fkey";

alter table "public"."course_members" add constraint "course_members_course_id_fkey" FOREIGN KEY (course_id) REFERENCES public.courses(id) ON DELETE CASCADE not valid;

alter table "public"."course_members" validate constraint "course_members_course_id_fkey";

alter table "public"."course_members" add constraint "course_members_student_id_fkey" FOREIGN KEY (student_id) REFERENCES public.profiles(id) ON DELETE CASCADE not valid;

alter table "public"."course_members" validate constraint "course_members_student_id_fkey";

alter table "public"."courses" add constraint "courses_teacher_id_fkey" FOREIGN KEY (teacher_id) REFERENCES public.profiles(id) ON DELETE RESTRICT not valid;

alter table "public"."courses" validate constraint "courses_teacher_id_fkey";

alter table "public"."focus_events" add constraint "focus_events_attempt_id_fkey" FOREIGN KEY (attempt_id) REFERENCES public.attempts(id) ON DELETE CASCADE not valid;

alter table "public"."focus_events" validate constraint "focus_events_attempt_id_fkey";

alter table "public"."focus_events" add constraint "focus_events_from_question_id_fkey" FOREIGN KEY (from_question_id) REFERENCES public.questions(id) ON DELETE SET NULL not valid;

alter table "public"."focus_events" validate constraint "focus_events_from_question_id_fkey";

alter table "public"."focus_events" add constraint "focus_events_replacement_question_id_fkey" FOREIGN KEY (replacement_question_id) REFERENCES public.questions(id) ON DELETE SET NULL not valid;

alter table "public"."focus_events" validate constraint "focus_events_replacement_question_id_fkey";

alter table "public"."llm_credentials" add constraint "llm_credentials_teacher_id_fkey" FOREIGN KEY (teacher_id) REFERENCES public.profiles(id) ON DELETE CASCADE not valid;

alter table "public"."llm_credentials" validate constraint "llm_credentials_teacher_id_fkey";

alter table "public"."llm_runs" add constraint "llm_runs_attempt_id_fkey" FOREIGN KEY (attempt_id) REFERENCES public.attempts(id) ON DELETE SET NULL not valid;

alter table "public"."llm_runs" validate constraint "llm_runs_attempt_id_fkey";

alter table "public"."llm_runs" add constraint "llm_runs_quiz_id_fkey" FOREIGN KEY (quiz_id) REFERENCES public.quizzes(id) ON DELETE SET NULL not valid;

alter table "public"."llm_runs" validate constraint "llm_runs_quiz_id_fkey";

alter table "public"."llm_runs" add constraint "llm_runs_response_id_fkey" FOREIGN KEY (response_id) REFERENCES public.responses(id) ON DELETE SET NULL not valid;

alter table "public"."llm_runs" validate constraint "llm_runs_response_id_fkey";

alter table "public"."llm_runs" add constraint "llm_runs_teacher_id_fkey" FOREIGN KEY (teacher_id) REFERENCES public.profiles(id) ON DELETE SET NULL not valid;

alter table "public"."llm_runs" validate constraint "llm_runs_teacher_id_fkey";

alter table "public"."questions" add constraint "questions_quiz_id_fkey" FOREIGN KEY (quiz_id) REFERENCES public.quizzes(id) ON DELETE CASCADE not valid;

alter table "public"."questions" validate constraint "questions_quiz_id_fkey";

alter table "public"."quiz_sessions" add constraint "quiz_sessions_created_by_fkey" FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE RESTRICT not valid;

alter table "public"."quiz_sessions" validate constraint "quiz_sessions_created_by_fkey";

alter table "public"."quiz_sessions" add constraint "quiz_sessions_quiz_id_fkey" FOREIGN KEY (quiz_id) REFERENCES public.quizzes(id) ON DELETE CASCADE not valid;

alter table "public"."quiz_sessions" validate constraint "quiz_sessions_quiz_id_fkey";

alter table "public"."quizzes" add constraint "quizzes_course_id_fkey" FOREIGN KEY (course_id) REFERENCES public.courses(id) ON DELETE CASCADE not valid;

alter table "public"."quizzes" validate constraint "quizzes_course_id_fkey";

alter table "public"."quizzes" add constraint "quizzes_created_by_fkey" FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE RESTRICT not valid;

alter table "public"."quizzes" validate constraint "quizzes_created_by_fkey";

alter table "public"."quizzes" add constraint "quizzes_source_document_id_fkey" FOREIGN KEY (source_document_id) REFERENCES public.source_documents(id) ON DELETE SET NULL not valid;

alter table "public"."quizzes" validate constraint "quizzes_source_document_id_fkey";

alter table "public"."responses" add constraint "responses_attempt_id_fkey" FOREIGN KEY (attempt_id) REFERENCES public.attempts(id) ON DELETE CASCADE not valid;

alter table "public"."responses" validate constraint "responses_attempt_id_fkey";

alter table "public"."responses" add constraint "responses_question_id_fkey" FOREIGN KEY (question_id) REFERENCES public.questions(id) ON DELETE RESTRICT not valid;

alter table "public"."responses" validate constraint "responses_question_id_fkey";

alter table "public"."source_documents" add constraint "source_documents_course_id_fkey" FOREIGN KEY (course_id) REFERENCES public.courses(id) ON DELETE CASCADE not valid;

alter table "public"."source_documents" validate constraint "source_documents_course_id_fkey";

alter table "public"."source_documents" add constraint "source_documents_uploaded_by_fkey" FOREIGN KEY (uploaded_by) REFERENCES public.profiles(id) ON DELETE RESTRICT not valid;

alter table "public"."source_documents" validate constraint "source_documents_uploaded_by_fkey";


  create policy "Teachers can read attempts of own courses"
  on "public"."attempts"
  as permissive
  for select
  to authenticated
using ((EXISTS ( SELECT 1
   FROM public.quizzes q
  WHERE ((q.id = attempts.quiz_id) AND private.owns_course(q.course_id)))));



  create policy "Teachers can add students to own courses"
  on "public"."course_members"
  as permissive
  for insert
  to authenticated
with check ((course_id IN ( SELECT c.id
   FROM public.courses c
  WHERE (c.teacher_id = ( SELECT auth.uid() AS uid)))));



  create policy "Teachers can read memberships of own courses"
  on "public"."course_members"
  as permissive
  for select
  to authenticated
using ((course_id IN ( SELECT c.id
   FROM public.courses c
  WHERE (c.teacher_id = ( SELECT auth.uid() AS uid)))));



  create policy "Teachers can remove students from own courses"
  on "public"."course_members"
  as permissive
  for delete
  to authenticated
using ((course_id IN ( SELECT c.id
   FROM public.courses c
  WHERE (c.teacher_id = ( SELECT auth.uid() AS uid)))));



  create policy "Teachers can update memberships of own courses"
  on "public"."course_members"
  as permissive
  for update
  to authenticated
using ((course_id IN ( SELECT c.id
   FROM public.courses c
  WHERE (c.teacher_id = ( SELECT auth.uid() AS uid)))))
with check ((course_id IN ( SELECT c.id
   FROM public.courses c
  WHERE (c.teacher_id = ( SELECT auth.uid() AS uid)))));



  create policy "Teachers can create own courses"
  on "public"."courses"
  as permissive
  for insert
  to authenticated
with check (((teacher_id = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.is_teacher = true))))));



  create policy "Teachers can delete own courses"
  on "public"."courses"
  as permissive
  for delete
  to authenticated
using (((teacher_id = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.is_teacher = true))))));



  create policy "Teachers can read own courses"
  on "public"."courses"
  as permissive
  for select
  to authenticated
using (((teacher_id = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.is_teacher = true))))));



  create policy "Teachers can update own courses"
  on "public"."courses"
  as permissive
  for update
  to authenticated
using (((teacher_id = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.is_teacher = true))))))
with check (((teacher_id = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.is_teacher = true))))));



  create policy "Students can read own focus events"
  on "public"."focus_events"
  as permissive
  for select
  to authenticated
using ((EXISTS ( SELECT 1
   FROM public.attempts a
  WHERE ((a.id = focus_events.attempt_id) AND (a.student_id = ( SELECT auth.uid() AS uid))))));



  create policy "Teachers can read focus events of own courses"
  on "public"."focus_events"
  as permissive
  for select
  to authenticated
using ((EXISTS ( SELECT 1
   FROM (public.attempts a
     JOIN public.quizzes q ON ((q.id = a.quiz_id)))
  WHERE ((a.id = focus_events.attempt_id) AND private.owns_course(q.course_id)))));



  create policy "Teachers can create questions in own quizzes"
  on "public"."questions"
  as permissive
  for insert
  to authenticated
with check ((EXISTS ( SELECT 1
   FROM public.quizzes q
  WHERE ((q.id = questions.quiz_id) AND private.owns_course(q.course_id)))));



  create policy "Teachers can delete questions of own quizzes"
  on "public"."questions"
  as permissive
  for delete
  to authenticated
using ((EXISTS ( SELECT 1
   FROM public.quizzes q
  WHERE ((q.id = questions.quiz_id) AND private.owns_course(q.course_id)))));



  create policy "Teachers can read questions of own quizzes"
  on "public"."questions"
  as permissive
  for select
  to authenticated
using ((EXISTS ( SELECT 1
   FROM public.quizzes q
  WHERE ((q.id = questions.quiz_id) AND private.owns_course(q.course_id)))));



  create policy "Teachers can update questions of own quizzes"
  on "public"."questions"
  as permissive
  for update
  to authenticated
using ((EXISTS ( SELECT 1
   FROM public.quizzes q
  WHERE ((q.id = questions.quiz_id) AND private.owns_course(q.course_id)))))
with check ((EXISTS ( SELECT 1
   FROM public.quizzes q
  WHERE ((q.id = questions.quiz_id) AND private.owns_course(q.course_id)))));



  create policy "Teachers can create sessions for own quizzes"
  on "public"."quiz_sessions"
  as permissive
  for insert
  to authenticated
with check (((created_by = ( SELECT auth.uid() AS uid)) AND private.is_teacher() AND (EXISTS ( SELECT 1
   FROM public.quizzes q
  WHERE ((q.id = quiz_sessions.quiz_id) AND private.owns_course(q.course_id))))));



  create policy "Teachers can delete sessions of own quizzes"
  on "public"."quiz_sessions"
  as permissive
  for delete
  to authenticated
using ((EXISTS ( SELECT 1
   FROM public.quizzes q
  WHERE ((q.id = quiz_sessions.quiz_id) AND private.owns_course(q.course_id)))));



  create policy "Teachers can read sessions of own quizzes"
  on "public"."quiz_sessions"
  as permissive
  for select
  to authenticated
using ((EXISTS ( SELECT 1
   FROM public.quizzes q
  WHERE ((q.id = quiz_sessions.quiz_id) AND private.owns_course(q.course_id)))));



  create policy "Teachers can update sessions of own quizzes"
  on "public"."quiz_sessions"
  as permissive
  for update
  to authenticated
using ((EXISTS ( SELECT 1
   FROM public.quizzes q
  WHERE ((q.id = quiz_sessions.quiz_id) AND private.owns_course(q.course_id)))))
with check (((created_by = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM public.quizzes q
  WHERE ((q.id = quiz_sessions.quiz_id) AND private.owns_course(q.course_id))))));



  create policy "Students can read own responses"
  on "public"."responses"
  as permissive
  for select
  to authenticated
using ((EXISTS ( SELECT 1
   FROM public.attempts a
  WHERE ((a.id = responses.attempt_id) AND (a.student_id = ( SELECT auth.uid() AS uid))))));



  create policy "Teachers can read responses of own courses"
  on "public"."responses"
  as permissive
  for select
  to authenticated
using ((EXISTS ( SELECT 1
   FROM (public.attempts a
     JOIN public.quizzes q ON ((q.id = a.quiz_id)))
  WHERE ((a.id = responses.attempt_id) AND private.owns_course(q.course_id)))));



  create policy "Teachers can add documents to own courses"
  on "public"."source_documents"
  as permissive
  for insert
  to authenticated
with check (((uploaded_by = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM public.courses c
  WHERE ((c.id = source_documents.course_id) AND (c.teacher_id = ( SELECT auth.uid() AS uid)))))));



  create policy "Teachers can delete documents of own courses"
  on "public"."source_documents"
  as permissive
  for delete
  to authenticated
using ((EXISTS ( SELECT 1
   FROM public.courses c
  WHERE ((c.id = source_documents.course_id) AND (c.teacher_id = ( SELECT auth.uid() AS uid))))));



  create policy "Teachers can read documents of own courses"
  on "public"."source_documents"
  as permissive
  for select
  to authenticated
using ((EXISTS ( SELECT 1
   FROM public.courses c
  WHERE ((c.id = source_documents.course_id) AND (c.teacher_id = ( SELECT auth.uid() AS uid))))));



  create policy "Teachers can update documents of own courses"
  on "public"."source_documents"
  as permissive
  for update
  to authenticated
using ((EXISTS ( SELECT 1
   FROM public.courses c
  WHERE ((c.id = source_documents.course_id) AND (c.teacher_id = ( SELECT auth.uid() AS uid))))))
with check (((uploaded_by = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM public.courses c
  WHERE ((c.id = source_documents.course_id) AND (c.teacher_id = ( SELECT auth.uid() AS uid)))))));


CREATE TRIGGER courses_set_updated_at BEFORE UPDATE ON public.courses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER llm_credentials_set_updated_at BEFORE UPDATE ON public.llm_credentials FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER profiles_set_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


  create policy "Students can read own response images"
  on "storage"."objects"
  as permissive
  for select
  to authenticated
using (((bucket_id = 'response-images'::text) AND ((storage.foldername(name))[1] = ( SELECT (auth.uid())::text AS uid))));



  create policy "Students can upload images for own active attempts"
  on "storage"."objects"
  as permissive
  for insert
  to authenticated
with check (((bucket_id = 'response-images'::text) AND ((storage.foldername(name))[1] = ( SELECT (auth.uid())::text AS uid)) AND (EXISTS ( SELECT 1
   FROM public.attempts a
  WHERE (((a.id)::text = (storage.foldername(objects.name))[2]) AND (a.student_id = ( SELECT auth.uid() AS uid)) AND (a.status = 'in_progress'::text))))));



  create policy "Teachers can delete own source documents"
  on "storage"."objects"
  as permissive
  for delete
  to authenticated
using (((bucket_id = 'source-documents'::text) AND private.is_teacher() AND ((storage.foldername(name))[1] = ( SELECT (auth.uid())::text AS uid))));



  create policy "Teachers can read own source documents"
  on "storage"."objects"
  as permissive
  for select
  to authenticated
using (((bucket_id = 'source-documents'::text) AND private.is_teacher() AND ((storage.foldername(name))[1] = ( SELECT (auth.uid())::text AS uid))));



  create policy "Teachers can read response images of own courses"
  on "storage"."objects"
  as permissive
  for select
  to authenticated
using (((bucket_id = 'response-images'::text) AND (EXISTS ( SELECT 1
   FROM (public.attempts a
     JOIN public.quizzes q ON ((q.id = a.quiz_id)))
  WHERE (((a.id)::text = (storage.foldername(objects.name))[2]) AND private.owns_course(q.course_id))))));



  create policy "Teachers can update own source documents"
  on "storage"."objects"
  as permissive
  for update
  to authenticated
using (((bucket_id = 'source-documents'::text) AND private.is_teacher() AND ((storage.foldername(name))[1] = ( SELECT (auth.uid())::text AS uid))))
with check (((bucket_id = 'source-documents'::text) AND private.is_teacher() AND ((storage.foldername(name))[1] = ( SELECT (auth.uid())::text AS uid))));



  create policy "Teachers can upload own source documents"
  on "storage"."objects"
  as permissive
  for insert
  to authenticated
with check (((bucket_id = 'source-documents'::text) AND private.is_teacher() AND ((storage.foldername(name))[1] = ( SELECT (auth.uid())::text AS uid))));



