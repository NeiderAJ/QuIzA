import { useEffect, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { supabase } from './supabaseClient'

function App() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const [profile, setProfile] = useState(null)

  const [courses, setCourses] = useState([])
  const [selectedCourse, setSelectedCourse] = useState(null)

  const [quizzes, setQuizzes] = useState([])
  const [selectedQuiz, setSelectedQuiz] = useState(null)

  const [quizSession, setQuizSession] = useState(null)
  const [projectionMode, setProjectionMode] = useState(false)

  const [joinToken, setJoinToken] = useState(null)
  const [activeAttempt, setActiveAttempt] = useState(null)
  const [attemptDeadlineAt, setAttemptDeadlineAt] = useState(null)
  const [remainingSeconds, setRemainingSeconds] = useState(null)
  const [timeWarning, setTimeWarning] = useState(null)

  const [currentQuestion, setCurrentQuestion] = useState(null)
  const [selectedAnswer, setSelectedAnswer] = useState('')
  const [submittingAnswer, setSubmittingAnswer] = useState(false)

  const [attemptResult, setAttemptResult] = useState(null)

  /*
   * Alerta visual de integridad.
   *
   * null:
   *   no hay incidencia pendiente.
   *
   * {
   *   blocked: false,
   *   count: 2,
   *   limit: 5
   * }
   *
   * o:
   *
   * {
   *   blocked: true,
   *   count: 6,
   *   limit: 5
   * }
   */
  const [integrityAlert, setIntegrityAlert] = useState(null)

  /*
   * Evita ejecutar simultáneamente dos RPC
   * de cambio de pregunta por el mismo evento.
   */
  const focusHandlingRef = useRef(false)
  const reloadHandledRef = useRef(false)
  const lastFocusEventAtRef = useRef(0)

  const attemptIdAtPageLoadRef = useRef(
  sessionStorage.getItem(
    'quiza_active_attempt_id'
  )
)

  const oneMinuteWarningShownRef = useRef(false)
  const tenSecondsWarningShownRef = useRef(false)

  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const token = params.get('join')

    if (token) {
      setJoinToken(token)
    }

    async function restoreSession() {
      const {
        data: { user },
      } = await supabase.auth.getUser()

      if (user) {
        const loaded = await loadProfile(user.id)

        /*
         * Si el estudiante escaneó un QR
         * y ya tenía una sesión iniciada,
         * intentamos entrar automáticamente.
         */
        if (loaded && token) {
          /*
          * Si venimos desde un QR,
          * el QR tiene prioridad.
          */
          await joinQuizSession(token)
        } else if (loaded) {
          /*
          * Si fue una recarga normal,
          * intentamos recuperar automáticamente
          * el quiz que estaba en progreso.
          */
          await restoreStoredAttempt()
        }

      }

      setLoading(false)
    }

    restoreSession()
  }, [])

  /*
   * ============================================================
   * CONTROL DE CAMBIO DE PANTALLA
   * ============================================================
   *
   * Solamente vigilamos mientras:
   *
   * - existe intento activo;
   * - existe pregunta activa;
   * - no hay una alerta roja esperando confirmación.
   *
   * Usamos visibilitychange.
   *
   * No usamos blur simultáneamente para evitar
   * registrar dos incidencias por una misma acción.
   */
  useEffect(() => {
  if (
    !activeAttempt ||
    !currentQuestion ||
    integrityAlert
  ) {
    return
  }

  async function registerFocusLoss(eventType) {
    /*
     * Un mismo Alt+Tab puede producir:
     *
     * blur
     * +
     * visibilitychange
     *
     * con pocos milisegundos de diferencia.
     *
     * Solo registramos una incidencia.
     */
    const now = Date.now()

    if (
      now - lastFocusEventAtRef.current <
      1500
    ) {
      return
    }

    if (focusHandlingRef.current) {
      return
    }

    lastFocusEventAtRef.current = now
    focusHandlingRef.current = true

    try {
      await replaceQuestionOnFocusLoss(
        eventType
      )
    } finally {
      focusHandlingRef.current = false
    }
  }


  function handleWindowBlur() {
    registerFocusLoss('blur')
  }


  function handleVisibilityChange() {
    if (
      document.visibilityState === 'hidden'
    ) {
      registerFocusLoss(
        'visibility_hidden'
      )
    }
  }


  window.addEventListener(
    'blur',
    handleWindowBlur
  )

  document.addEventListener(
    'visibilitychange',
    handleVisibilityChange
  )


  return () => {
    window.removeEventListener(
      'blur',
      handleWindowBlur
    )

    document.removeEventListener(
      'visibilitychange',
      handleVisibilityChange
    )
  }
}, [
  activeAttempt,
  currentQuestion,
  integrityAlert,
])

  /*
 * Detectar una recarga real del navegador.
 *
 * Esperamos hasta que React haya recuperado:
 * - el intento activo;
 * - la pregunta actual.
 *
 * Entonces registramos la recarga como
 * incidencia de integridad una sola vez.
 */
useEffect(() => {
  if (reloadHandledRef.current) {
    return
  }

  const navigationEntry =
    performance.getEntriesByType('navigation')?.[0]

  /*
   * La página no nació de una recarga.
   */
  if (navigationEntry?.type !== 'reload') {
    reloadHandledRef.current = true
    return
  }

  /*
   * La página sí nació de un F5, pero en el
   * instante de cargar NO había un intento activo.
   *
   * Por tanto, esa recarga no puede atribuirse
   * a un quiz que el estudiante empiece después.
   */
  if (!attemptIdAtPageLoadRef.current) {
    reloadHandledRef.current = true
    return
  }

  /*
   * Si había un intento activo al ocurrir el F5,
   * esperamos a que React termine de restaurarlo.
   */
  if (
    !activeAttempt ||
    !currentQuestion ||
    integrityAlert
  ) {
    return
  }

  /*
   * Protección adicional:
   * la incidencia debe corresponder exactamente
   * al intento que existía cuando ocurrió el F5.
   */
  if (
    activeAttempt.attempt_id !==
    attemptIdAtPageLoadRef.current
  ) {
    reloadHandledRef.current = true
    return
  }

  reloadHandledRef.current = true

  replaceQuestionOnFocusLoss('reload')
}, [
  activeAttempt,
  currentQuestion,
  integrityAlert,
])


  /*
  * Ocultar automáticamente el QR cuando
  * termine su ventana de acceso.
  */
  useEffect(() => {
    if (!quizSession?.expires_at) {
    return
  }

  const expiresAt =
    new Date(quizSession.expires_at).getTime()

  const remainingTime =
    expiresAt - Date.now()

  if (remainingTime <= 0) {
    setQuizSession(null)

    setMessage(
      'El acceso por QR expiró. Puedes abrirlo nuevamente si lo necesitas.'
    )

    return
  }

  const timerId = window.setTimeout(() => {
    setQuizSession(null)

    setMessage(
      'El acceso por QR expiró. Puedes abrirlo nuevamente si lo necesitas.'
    )
  }, remainingTime)

  return () => {
    window.clearTimeout(timerId)
  }
}, [quizSession])

/************************************************************/

useEffect(() => {
  if (!attemptDeadlineAt || !activeAttempt) {
    setRemainingSeconds(null)
    setTimeWarning(null)
    return
  }

  function updateRemainingTime() {
    const deadlineMs =
      new Date(attemptDeadlineAt).getTime()

    const remainingMs =
      deadlineMs - Date.now()

    const seconds =
      Math.max(
        0,
        Math.ceil(remainingMs / 1000)
      )

    setRemainingSeconds(seconds)

    /*
     * Avisos visibles.
     *
     * El backend conserva internamente
     * los 10 segundos adicionales.
     */
    /*
 * Aviso de 1 minuto.
 * Se dispara una sola vez por intento.
 */
if (
  seconds <= 60 &&
  seconds > 10 &&
  !oneMinuteWarningShownRef.current
) {
  oneMinuteWarningShownRef.current = true
  setTimeWarning('one_minute')
}


/*
 * Aviso de 10 segundos.
 * Sustituye al aviso anterior si todavía
 * estuviera visible.
 */
if (
  seconds <= 10 &&
  seconds > 0 &&
  !tenSecondsWarningShownRef.current
) {
  tenSecondsWarningShownRef.current = true
  setTimeWarning('ten_seconds')
}


/*
 * Cuando el contador visible llega a cero,
 * quitamos cualquier aviso.
 *
 * Los 10 segundos adicionales siguen siendo
 * internos y no se muestran al estudiante.
 */
if (seconds === 0) {
  setTimeWarning(null)
}
  }

  updateRemainingTime()

  const timerId =
    window.setInterval(
      updateRemainingTime,
      1000
    )

  return () => {
    window.clearInterval(timerId)
  }
}, [
  attemptDeadlineAt,
  activeAttempt,
])


useEffect(() => {
  oneMinuteWarningShownRef.current = false
  tenSecondsWarningShownRef.current = false
  setTimeWarning(null)
}, [activeAttempt?.attempt_id])

useEffect(() => {
  if (!timeWarning) {
    return
  }

  const timerId = window.setTimeout(() => {
    setTimeWarning(null)
  }, 4000)

  return () => {
    window.clearTimeout(timerId)
  }
}, [timeWarning])


/************************************************************/


  async function loadProfile(userId) {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, full_name, is_teacher')
      .eq('id', userId)
      .single()

    if (error) {
      setMessage(
        `Error cargando perfil: ${error.message}`
      )
      return false
    }

    setProfile(data)

    const coursesLoaded = await loadCourses()

    return coursesLoaded
  }

  async function loadCourses() {
    const { data, error } = await supabase
      .from('courses')
      .select(
      'id, nickname, name, code, group_name, academic_period, teacher_id'
      )
      .order('name')

    if (error) {
      setMessage(
        `Error cargando cursos: ${error.message}`
      )
      return false
    }

    setCourses(data ?? [])

    return true
  }

  async function loadQuizzes(courseId) {
    setQuizzes([])
    setSelectedQuiz(null)
    setQuizSession(null)

    const { data, error } = await supabase
      .from('quizzes')
      .select(`
        id,
        title,
        instructions,
        status,
        delivery_mode,
        opens_at,
        closes_at,
        duration_minutes,
        grade_scale_max,
        number_of_slots,
        variants_per_slot,
        max_focus_violations
      `)
      .eq('course_id', courseId)
      .order('created_at', { ascending: false })

    if (error) {
      setMessage(
        `Error cargando quizzes: ${error.message}`
      )
      return false
    }

    setQuizzes(data ?? [])
    setMessage('')

    return true
  }

  async function loadQuizMetadata(quizId) {
    const { data, error } = await supabase
      .from('quizzes')
      .select(`
        id,
        course_id,
        title,
        instructions,
        status,
        delivery_mode,
        opens_at,
        closes_at,
        duration_minutes,
        grade_scale_max,
        number_of_slots,
        variants_per_slot,
        max_focus_violations
      `)
      .eq('id', quizId)
      .single()

    if (error) {
      setMessage(
        `Error cargando información del quiz: ${error.message}`
      )
      return null
    }

    setSelectedQuiz(data)

    return data
  }

async function loadAttemptDeadline(attemptId) {
  if (!attemptId) {
    return null
  }

  const { data, error } = await supabase
    .from('attempts')
    .select('deadline_at')
    .eq('id', attemptId)
    .single()

  if (error) {
    setMessage(
      `Error cargando el tiempo del quiz: ${error.message}`
    )
    return null
  }

  if (!data?.deadline_at) {
    setMessage(
      'El intento no tiene un tiempo límite definido.'
    )
    return null
  }

  setAttemptDeadlineAt(data.deadline_at)

  return data.deadline_at
}

/************************************++    *********** */

async function restoreStoredAttempt() {
  const storedAttemptId =
    sessionStorage.getItem(
      'quiza_active_attempt_id'
    )

  if (!storedAttemptId) {
    return false
  }

  /*
   * Recuperar el intento que estaba activo
   * antes de la recarga.
   */
  const {
    data: attempt,
    error: attemptError,
  } = await supabase
    .from('attempts')
    .select(`
      id,
      quiz_id,
      status
    `)
    .eq('id', storedAttemptId)
    .single()

  if (attemptError || !attempt) {
    sessionStorage.removeItem(
      'quiza_active_attempt_id'
    )

    return false
  }

  /*
   * Solo restauramos intentos
   * que realmente siguen en progreso.
   */
  if (attempt.status !== 'in_progress') {
    sessionStorage.removeItem(
      'quiza_active_attempt_id'
    )

    return false
  }

  /*
   * Recuperar el quiz.
   * loadQuizMetadata ahora también
   * devuelve course_id.
   */
  const quiz =
    await loadQuizMetadata(
      attempt.quiz_id
    )

  if (!quiz) {
    return false
  }

  /*
   * Recuperar el grupo al que pertenece.
   */
  const {
    data: course,
    error: courseError,
  } = await supabase
    .from('courses')
    .select(`
      id,
      nickname,
      name,
      code,
      group_name,
      academic_period,
      teacher_id
    `)
    .eq('id', quiz.course_id)
    .single()

  if (courseError || !course) {
    setMessage(
      'No fue posible restaurar el grupo del intento.'
    )

    return false
  }

  setSelectedCourse(course)

  /*
   * Cargar la lista normal de quizzes
   * de ese grupo.
   */
  await loadQuizzes(course.id)

  /*
   * loadQuizzes limpia selectedQuiz,
   * así que restauramos después
   * el quiz concreto.
   */
  setSelectedQuiz(quiz)

  const restoredAttempt = {
    attempt_id: attempt.id,
    quiz_id: attempt.quiz_id,
    attempt_status: attempt.status,
  }

  setActiveAttempt(restoredAttempt)
  setAttemptResult(null)
  setIntegrityAlert(null)

  /*
   * Recuperar el deadline ORIGINAL.
   * Nunca comenzamos un reloj nuevo.
   */
  const deadline =
    await loadAttemptDeadline(
      attempt.id
    )

  if (!deadline) {
    return false
  }

  /*
   * PostgreSQL devuelve la pregunta
   * que estaba asignada.
   */
  const questionLoaded =
    await loadCurrentQuestion(
      attempt.id
    )

  if (!questionLoaded) {
    return false
  }

  setMessage(
    'Intento activo restaurado ✅'
  )

  return true
}










  async function joinQuizSession(token) {
    if (!token) {
      return false
    }

    setMessage('Validando acceso presencial...')

    const { data, error } = await supabase.rpc(
      'join_quiz_session',
      {
        p_qr_token: token,
      }
    )

    if (error) {
      setMessage(
        `Error ingresando al quiz: ${error.message}`
      )
      return false
    }

    const attempt = data?.[0]

    if (!attempt) {
      setMessage(
        'Supabase no devolvió un intento válido.'
      )
      return false
    }

    setActiveAttempt(attempt)

    sessionStorage.setItem(
      'quiza_active_attempt_id',
      attempt.attempt_id
    )


    setAttemptResult(null)
    setIntegrityAlert(null)

    /*
     * Necesitamos conocer:
     *
     * - número de preguntas;
     * - escala de nota;
     * - máximo de incidencias.
     */
    const quiz =
      await loadQuizMetadata(attempt.quiz_id)

    if (!quiz) {
      return false
    }

    const deadline =
      await loadAttemptDeadline(
        attempt.attempt_id
      )

    if (!deadline) {
      return false
    }

    const questionLoaded =
      await loadCurrentQuestion(
        attempt.attempt_id
      )

    if (!questionLoaded) {
      return false
    }

    setMessage('Acceso al quiz autorizado ✅')

    return true
  }


  async function handleStartAsyncQuiz() {
  if (!selectedQuiz) {
    return
  }

  setMessage('Iniciando quiz virtual...')

  const { data, error } = await supabase.rpc(
    'start_async_quiz_attempt',
    {
      p_quiz_id: selectedQuiz.id,
    }
  )

  if (error) {
    setMessage(
      `Error iniciando el quiz: ${error.message}`
    )
    return
  }

  const attempt = data?.[0]

  if (!attempt) {
    setMessage(
      'Supabase no devolvió un intento válido.'
    )
    return
  }

  setActiveAttempt(attempt)

        sessionStorage.setItem(
      'quiza_active_attempt_id',
      attempt.attempt_id
    )


  setAttemptResult(null)
  setIntegrityAlert(null)

  const quiz =
    await loadQuizMetadata(attempt.quiz_id)

  if (!quiz) {
    return
  }

  const deadline =
      await loadAttemptDeadline(
        attempt.attempt_id
      )

    if (!deadline) {
      return false
    }

  const questionLoaded =
    await loadCurrentQuestion(
      attempt.attempt_id
    )

  if (!questionLoaded) {
    return
  }

  setMessage('Quiz virtual iniciado ✅')
}


  async function loadCurrentQuestion(attemptId) {
    if (!attemptId) {
      return false
    }

    setMessage('Cargando pregunta...')

    const { data, error } = await supabase.rpc(
      'get_current_question',
      {
        p_attempt_id: attemptId,
      }
    )

    if (error) {
      setMessage(
        `Error cargando pregunta: ${error.message}`
      )
      return false
    }

   const question = data?.[0]

if (!question) {
  const {
    data: attempt,
    error: attemptError,
  } = await supabase
    .from('attempts')
    .select('status')
    .eq('id', attemptId)
    .single()

  if (!attemptError && attempt?.status === 'expired') {
    setCurrentQuestion(null)
    setSelectedAnswer('')

    setAttemptResult({
      status: 'expired',
    })

    setMessage(
      'El tiempo disponible para este quiz terminó.'
    )

    return false
  }

  setMessage(
    'Supabase no devolvió una pregunta.'
  )

  return false
}

    setCurrentQuestion(question)
    setSelectedAnswer('')
    setMessage('')

    return true
  }

  /*
   * ============================================================
   * INCIDENCIA DE INTEGRIDAD
   * ============================================================
   */
  async function replaceQuestionOnFocusLoss(
    eventType
  ) {
    if (!activeAttempt || !currentQuestion) {
      return false
    }

    const { data, error } = await supabase.rpc(
      'replace_question_on_focus_loss',
      {
        p_attempt_id:
          activeAttempt.attempt_id,

        p_event_type:
          eventType,
      }
    )

    if (error) {
      setMessage(
        `Error registrando incidencia: ${error.message}`
      )
      return false
    }

    const replacement = data?.[0]

    if (!replacement) {
      setMessage(
        'No fue posible procesar la incidencia de integridad.'
      )
      return false
    }

    const limit =
      selectedQuiz?.max_focus_violations ?? 5

    /*
     * ==========================================================
     * INTENTO BLOQUEADO
     * ==========================================================
     */

      if (
            replacement.attempt_status === 'expired'
          ) {
            setCurrentQuestion(null)
            setSelectedAnswer('')

            setAttemptResult({
              status: 'expired',
            })

            setIntegrityAlert(null)

            setMessage(
              'El tiempo disponible para este quiz terminó.'
            )

            return true
    }


    if (
      replacement.attempt_status === 'blocked'
    ) {
      setCurrentQuestion(null)
      setSelectedAnswer('')

      setActiveAttempt((previous) => {
        if (!previous) {
          return previous
        }

        return {
          ...previous,
          attempt_status: 'blocked',
        }
      })

      clearStoredAttempt()


      setIntegrityAlert({
        blocked: true,
        count:
          replacement.focus_violation_count,
        limit,
      })

      setMessage('')

      return true
    }

    /*
     * ==========================================================
     * INCIDENCIA PERMITIDA DENTRO DEL MARGEN
     * ==========================================================
     *
     * PostgreSQL ya invalidó la pregunta anterior
     * y nos devolvió una nueva variante.
     */
    setCurrentQuestion(replacement)
    setSelectedAnswer('')

    setIntegrityAlert({
      blocked: false,
      count:
        replacement.focus_violation_count,
      limit,
    })

    setMessage('')

    return true
  }

  function handleContinueAfterIntegrityAlert() {
    if (!integrityAlert) {
      return
    }

    /*
     * Una pantalla bloqueada nunca puede
     * cerrarse desde el estudiante.
     */
    if (integrityAlert.blocked) {
      return
    }

    setIntegrityAlert(null)
  }

  async function handleSubmitAnswer() {
    if (!activeAttempt || !currentQuestion) {
      return
    }

    if (
      currentQuestion.question_type ===
        'multiple_choice' &&
      !selectedAnswer
    ) {
      setMessage(
        'Selecciona una respuesta antes de continuar.'
      )
      return
    }

    setSubmittingAnswer(true)
    setMessage('Guardando respuesta...')

    let answerPayload

    if (
      currentQuestion.question_type ===
      'multiple_choice'
    ) {
      answerPayload = {
        selected_option: selectedAnswer,
      }
    } else {
      setMessage(
        'Este tipo de respuesta todavía no está habilitado en el frontend.'
      )

      setSubmittingAnswer(false)

      return
    }

    /*
     * La respuesta correcta NO existe
     * en React.
     *
     * PostgreSQL realiza la comparación.
     */
    const { data, error } = await supabase.rpc(
      'submit_response',
      {
        p_response_id:
          currentQuestion.response_id,

        p_answer_payload:
          answerPayload,
      }
    )

    if (error) {
      setMessage(
        `Error guardando respuesta: ${error.message}`
      )

      setSubmittingAnswer(false)

      return
    }

    const result = data?.[0]

    if (!result) {
      setMessage(
        'Supabase no confirmó la respuesta.'
      )

      setSubmittingAnswer(false)

      return
    }


    if (result.status === 'expired') {
  setCurrentQuestion(null)
  setSelectedAnswer('')

  setAttemptResult({
    status: 'expired',
  })

  setMessage(
    'El tiempo disponible para este quiz terminó.'
  )

  setSubmittingAnswer(false)

  return
  }

    /*
     * Si quedan slots,
     * solicitamos la siguiente pregunta.
     */
    if (
      selectedQuiz &&
      currentQuestion.slot_number <
        selectedQuiz.number_of_slots
    ) {
      const loaded =
        await loadCurrentQuestion(
          activeAttempt.attempt_id
        )

      if (!loaded) {
        setSubmittingAnswer(false)

        return
      }

      setMessage('Respuesta registrada ✅')
      setSubmittingAnswer(false)

      return
    }

    /*
     * Última pregunta:
     * cerrar oficialmente el intento.
     */
    const {
      data: submitData,
      error: submitError,
    } = await supabase.rpc(
      'submit_quiz_attempt',
      {
        p_attempt_id:
          activeAttempt.attempt_id,
      }
    )

    if (submitError) {
      setMessage(
        `Respuesta guardada, pero hubo un error cerrando el quiz: ${submitError.message}`
      )

      setSubmittingAnswer(false)

      return
    }

    const submission = submitData?.[0]

    /*
     * Consultar resultado final.
     */
    const {
      data: finalAttempt,
      error: finalAttemptError,
    } = await supabase
      .from('attempts')
      .select(`
        id,
        status,
        score_points,
        grade
      `)
      .eq(
        'id',
        activeAttempt.attempt_id
      )
      .single()

    if (finalAttemptError) {
      setMessage(
        `Quiz entregado, pero no fue posible leer el resultado: ${finalAttemptError.message}`
      )

      setSubmittingAnswer(false)

      return
    }

    setCurrentQuestion(null)
    setSelectedAnswer('')

    setAttemptResult({
      ...finalAttempt,

      pending_llm_grading:
        submission?.pending_llm_grading ??
        0,
    })

    clearStoredAttempt()

    if (
      finalAttempt.status === 'graded'
    ) {
      setMessage(
        'Quiz finalizado y calificado ✅'
      )
    } else {
      setMessage(
        'Quiz entregado ✅ Algunas respuestas están pendientes de calificación.'
      )
    }

    setSubmittingAnswer(false)
  }


  function formatRemainingTime(totalSeconds) {
  if (
    totalSeconds === null ||
    totalSeconds === undefined
  ) {
    return '--:--'
  }

  const minutes =
    Math.floor(totalSeconds / 60)

  const seconds =
    totalSeconds % 60

  return `${String(minutes).padStart(2, '0')}:${String(
    seconds
  ).padStart(2, '0')}`
}



async function refreshAttemptStatus(attemptId) {
  if (!attemptId) {
    return null
  }

  const { data, error } = await supabase
    .from('attempts')
    .select(`
      id,
      status,
      score_points,
      grade,
      deadline_at,
      expired_at
    `)
    .eq('id', attemptId)
    .single()

  if (error) {
    setMessage(
      `Error consultando el estado del intento: ${error.message}`
    )
    return null
  }

  if (data.status === 'expired') {
    setCurrentQuestion(null)
    setSelectedAnswer('')
    setIntegrityAlert(null)

    setAttemptResult({
      status: 'expired',
      score_points: data.score_points,
      grade: data.grade,
    })

    setMessage(
      'El tiempo disponible para este quiz terminó.'
    )

      clearStoredAttempt()


  }

  return data
}




useEffect(() => {
  if (
    !activeAttempt?.attempt_id ||
    !currentQuestion ||
    attemptResult
  ) {
    return
  }

  let cancelled = false

  async function sendHeartbeat() {
    const { error } = await supabase.rpc(
      'heartbeat_quiz_attempt',
      {
        p_attempt_id:
          activeAttempt.attempt_id,
      }
    )

    if (cancelled) {
      return
    }

    if (error) {
      console.error(
        'Error enviando heartbeat:',
        error
      )
      return
    }

    await refreshAttemptStatus(
      activeAttempt.attempt_id
    )
  }

  /*
   * Primera comprobación inmediata.
   */
  sendHeartbeat()

  /*
   * Luego comprobamos cada 5 segundos.
   *
   * El backend es quien decide si
   * el intento ya expiró.
   */
  const heartbeatId =
    window.setInterval(
      sendHeartbeat,
      5000
    )

  return () => {
    cancelled = true
    window.clearInterval(heartbeatId)
  }
}, [
  activeAttempt?.attempt_id,
  currentQuestion?.response_id,
  attemptResult,
])









  async function handleLogin(event) {
    event.preventDefault()

    setMessage('Ingresando...')

    const { data, error } =
      await supabase.auth.signInWithPassword({
        email,
        password,
      })

    if (error) {
      setMessage(
        `Error: ${error.message}`
      )

      return
    }

    const loaded =
      await loadProfile(data.user.id)

    if (loaded) {
      const params =
        new URLSearchParams(
          window.location.search
        )

      const token =
        params.get('join')

      if (token) {
        await joinQuizSession(token)
      } else {
        setMessage('')
      }
    }
  }

  function clearStoredAttempt() {
  sessionStorage.removeItem(
    'quiza_active_attempt_id'
  )

  setAttemptDeadlineAt(null)
  setRemainingSeconds(null)
  setTimeWarning(null)
}

  async function handleLogout() {
    await supabase.auth.signOut()

    clearStoredAttempt()

    setProfile(null)

    setCourses([])
    setSelectedCourse(null)

    setQuizzes([])
    setSelectedQuiz(null)

    setQuizSession(null)

    setJoinToken(null)
    setActiveAttempt(null)

    setCurrentQuestion(null)
    setSelectedAnswer('')

    setAttemptResult(null)

    setIntegrityAlert(null)

    setEmail('')
    setPassword('')

    setMessage('')
  }

  async function handleCourseSelect(course) {
    setSelectedCourse(course)

    await loadQuizzes(course.id)
  }

  function handleQuizSelect(quiz) {
  setSelectedQuiz(quiz)
  setQuizSession(null)

  setActiveAttempt(null)
  setCurrentQuestion(null)
  setSelectedAnswer('')
  setAttemptResult(null)
  setIntegrityAlert(null)

  setMessage('')
}

  async function handleCreateQuizSession() {
    if (!selectedQuiz) {
      return
    }

    setMessage(
      'Creando sesión presencial...'
    )

    const { data, error } = await supabase.rpc(
      'create_quiz_session',
      {
        p_quiz_id:
          selectedQuiz.id,

        p_access_minutes: 5,
      }
    )

    if (error) {
      setMessage(
        `Error creando sesión: ${error.message}`
      )

      return
    }

    const session = data?.[0]

    if (!session) {
      setMessage(
        'Supabase no devolvió la sesión creada.'
      )

      return
    }

    setQuizSession(session)
    setMessage('')
  }

  async function handleCloseQuizSession() {
  if (!quizSession) {
    return
  }

  setMessage('Cerrando acceso al quiz...')

  const { data, error } = await supabase.rpc(
    'close_quiz_session',
    {
      p_quiz_session_id: quizSession.quiz_session_id,
    }
  )

  if (error) {
    setMessage(
      `Error cerrando la sesión: ${error.message}`
    )
    return
  }

  if (!data) {
    setMessage(
      'La sesión ya estaba cerrada o no pudo modificarse.'
    )
    return
  }

  setQuizSession(null)
  setMessage('Acceso al quiz cerrado ✅')
}

function handleEnterProjectionMode() {
  if (!quizSession) {
    return
  }

  setProjectionMode(true)
}

function handleExitProjectionMode() {
  setProjectionMode(false)
}

  if (loading) {
    return <p>Cargando QuIzA...</p>
  }

  if (profile) {
        if (
  profile.is_teacher &&
  projectionMode &&
  quizSession
) {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: '2rem',
      }}
    >
      <h1>QuIzA</h1>

      <h2>{selectedCourse?.nickname}</h2>

      <p
        style={{
          fontSize: '1.4rem',
        }}
      >
        Quiz: <strong>{selectedQuiz?.title}</strong>
      </p>

      <QRCodeSVG
        value={`${window.location.origin}/?join=${encodeURIComponent(
          quizSession.qr_token
        )}`}
        size={360}
      />

      <p
        style={{
          fontSize: '1.5rem',
          fontWeight: 'bold',
          marginTop: '1.5rem',
        }}
      >
        Acceso abierto
      </p>

      <p>
        Escanea el código QR para ingresar.
      </p>

      <p>
        QR válido hasta:{' '}
        {new Date(
          quizSession.expires_at
        ).toLocaleTimeString()}
      </p>

      <button
        type="button"
        onClick={handleExitProjectionMode}
        style={{
          marginTop: '2rem',
        }}
      >
        Salir del modo proyección
      </button>
    </main>
  )
}

    return (
      <>
        <main>
          <h1>QuIzA</h1>

          <h2>Sesión iniciada ✅</h2>

          <p>
            <strong>Usuario:</strong>{' '}
            {profile.full_name}
          </p>

          <p>
            <strong>Correo:</strong>{' '}
            {profile.email}
          </p>

          <p>
            <strong>Tipo:</strong>{' '}
            {profile.is_teacher
              ? 'Docente'
              : 'Estudiante'}
          </p>

          <section>
            <h2>Mis cursos</h2>

            {courses.length === 0 ? (
              <p>
                No tienes cursos disponibles.
              </p>
            ) : (
              <ul>
                {courses.map((course) => (
                  <li key={course.id}>
                    <button
                      type="button"
                      onClick={() =>
                        handleCourseSelect(course)
                      }
                    >
                    <strong>{course.nickname}</strong>

                    <br />

                    <small>
                      {course.name} — {course.academic_period}
                    </small>
                  </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {selectedCourse && (
            <>
             <section>
              <h2>Grupo seleccionado</h2>

              <p>
                <strong>{selectedCourse.nickname}</strong>
              </p>

              <p>
                {selectedCourse.name} — {selectedCourse.academic_period}
              </p>
            </section>

              <section>
                <h2>Quizzes</h2>

                {quizzes.length === 0 ? (
                  <p>
                    No hay quizzes disponibles.
                  </p>
                ) : (
                  <ul>
                    {quizzes.map((quiz) => (
                      <li key={quiz.id}>
                        <button
                          type="button"
                          onClick={() =>
                            handleQuizSelect(
                              quiz
                            )
                          }
                        >
                          <strong>
                            {quiz.title}
                          </strong>

                          {' — '}
                          {quiz.status}

                          {' — '}
                          {
                            quiz.duration_minutes
                          }{' '}
                          min
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}

          {selectedQuiz && (
            <section>
              <h2>
                Quiz seleccionado
              </h2>

              <p>
                <strong>
                  {selectedQuiz.title}
                </strong>
              </p>

              <p>
                Modalidad:{' '}
                <strong>
                  {selectedQuiz.delivery_mode === 'in_person'
                    ? 'Presencial'
                    : 'Virtual asincrónico'}
                </strong>
              </p>

              <p>
                Duración:{' '}
                {
                  selectedQuiz.duration_minutes
                }{' '}
                minutos
              </p>

              <p>
                Preguntas:{' '}
                {
                  selectedQuiz.number_of_slots
                }
              </p>

              {profile.is_teacher &&
                selectedQuiz.delivery_mode === 'in_person' && (
                  <button
                    type="button"
                    onClick={handleCreateQuizSession}
                  >
                    {quizSession
                      ? 'Regenerar QR de acceso'
                      : 'Abrir acceso por QR'}
                  </button>
                )}

              {!profile.is_teacher &&
                selectedQuiz.delivery_mode === 'asynchronous' &&
                !activeAttempt && (
                  <button
                    type="button"
                    onClick={handleStartAsyncQuiz}
                  >
                    Comenzar quiz
                  </button>
                )}



            </section>
          )}

          {quizSession &&
            profile.is_teacher && (
              <section>
               <h2>Sesión presencial activa</h2>

                  <p>
                    <strong>{selectedCourse?.nickname}</strong>
                  </p>

                  <p>
                    Quiz: <strong>{selectedQuiz?.title}</strong>
                  </p>

                  <p>
                    Ventana de ingreso: 5 minutos
                  </p>

                  <button
                    type="button"
                    onClick={handleCloseQuizSession}
                  >
                    Cerrar acceso
                  </button>

                  <button
                    type="button"
                    onClick={handleEnterProjectionMode}
                  >
                    Modo proyección
                  </button>




                <QRCodeSVG
                  value={`${window.location.origin}/?join=${encodeURIComponent(
                    quizSession.qr_token
                  )}`}
                  size={240}
                />

                <p>
                  QR válido hasta:{' '}
                  {new Date(
                    quizSession.expires_at
                  ).toLocaleString()}
                </p>

                <p>
                  <strong>
                    Los estudiantes deben
                    escanear este QR dentro
                    del aula.
                  </strong>
                </p>
              </section>
            )}

          {message && (
            <p>{message}</p>
          )}

          {activeAttempt &&
            currentQuestion && (
              <section>

                  <div
                    style={{
                      position: 'sticky',
                      top: 0,
                      zIndex: 100,
                      padding: '0.75rem 1rem',
                      marginBottom: '1rem',
                      textAlign: 'center',
                      fontSize: '1.5rem',
                      fontWeight: 'bold',
                      background: 'white',
                      border: '2px solid #333',
                      borderRadius: '8px',
                    }}
                  >
                    Tiempo restante:{' '}
                    {formatRemainingTime(remainingSeconds)}
                  </div>

                <h2>
                  Pregunta{' '}
                  {
                    currentQuestion.slot_number
                  }

                  {selectedQuiz
                    ?.number_of_slots
                    ? ` de ${selectedQuiz.number_of_slots}`
                    : ''}
                </h2>

                <p>
                  {
                    currentQuestion.statement
                  }
                </p>

                {currentQuestion.question_type ===
                  'multiple_choice' && (
                  <div>
                    {currentQuestion.options?.map(
                      (option) => (
                        <label
                          key={option.id}
                          style={{
                            display:
                              'block',

                            marginBottom:
                              '0.75rem',
                          }}
                        >
                          <input
                            type="radio"
                            name="quiz-answer"
                            value={option.id}
                            checked={
                              selectedAnswer ===
                              option.id
                            }
                            onChange={() =>
                              setSelectedAnswer(
                                option.id
                              )
                            }
                          />

                          {' '}

                          <strong>
                            {option.id}.
                          </strong>{' '}

                          {option.text}
                        </label>
                      )
                    )}
                  </div>
                )}

                <button
                  type="button"
                  onClick={
                    handleSubmitAnswer
                  }
                  disabled={
                    submittingAnswer ||
                    (
                      currentQuestion.question_type ===
                        'multiple_choice' &&
                      !selectedAnswer
                    )
                  }
                >
                  {submittingAnswer
                    ? 'Guardando...'
                    : 'Enviar respuesta'}
                </button>
              </section>
            )}

          {attemptResult && (
            <section>
              <h2>
                Resultado del quiz
              </h2>

        {attemptResult.status === 'graded' ? (
              <>
                <p>
                  <strong>Nota:</strong>{' '}
                  {attemptResult.grade}
                  {' / '}
                  {selectedQuiz?.grade_scale_max ?? 5}
                </p>

                <p>
                  <strong>Puntos obtenidos:</strong>{' '}
                  {attemptResult.score_points}
                </p>
              </>
            ) : attemptResult.status === 'expired' ? (
                  <>
                    <p>
                      <strong>Tiempo agotado.</strong>
                    </p>

                    <p>
                      El tiempo disponible para este quiz terminó.
                      Ya no es posible enviar respuestas.
                    </p>

                    <p>
                      <strong>Nota:</strong>{' '}
                      {attemptResult.grade ?? 0}
                      {' / '}
                      {selectedQuiz?.grade_scale_max ?? 5}
                    </p>

                    <p>
                      <strong>Puntos obtenidos:</strong>{' '}
                      {attemptResult.score_points ?? 0}
                    </p>
                  </>
                ) : (
              <p>
                Tu quiz fue entregado.
                La calificación definitiva está pendiente.
              </p>
            )}
            </section>
          )}

          <button
            type="button"
            onClick={handleLogout}
          >
            Cerrar sesión
          </button>
        </main>

{/* =====================================================
    AVISO DE TIEMPO
    ===================================================== */}

{timeWarning && !integrityAlert && (
  <div
    role="status"
    aria-live="assertive"
    style={{
      position: 'fixed',
      top: '1.5rem',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: 90000,

      width: 'calc(100% - 2rem)',
      maxWidth: '520px',

      padding: '1rem 1.25rem',

      backgroundColor:
        timeWarning === 'ten_seconds'
          ? '#b45309'
          : '#f59e0b',

      color: 'white',

      borderRadius: '10px',

      textAlign: 'center',

      fontSize: '1.15rem',
      fontWeight: 'bold',

      boxShadow:
        '0 4px 16px rgba(0, 0, 0, 0.25)',
    }}
  >
    {timeWarning === 'one_minute' ? (
      <>
        ⏱ Queda aproximadamente 1 minuto
        para finalizar el quiz.
      </>
    ) : (
      <>
        ⚠️ Quedan aproximadamente 10 segundos.
        Envía tu respuesta.
      </>
    )}
  </div>
)}


        {/* =====================================================
            ALERTA ROJA DE INTEGRIDAD
            ===================================================== */}

        {integrityAlert && (
          <div
            role="alert"
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 99999,

              backgroundColor:
                integrityAlert.blocked
                  ? '#8b0000'
                  : '#d00000',

              color: 'white',

              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',

              padding: '2rem',

              textAlign: 'center',
            }}
          >
            <div
              style={{
                width: '100%',
                maxWidth: '700px',
              }}
            >
              <div
                style={{
                  fontSize: '4rem',
                  marginBottom: '1rem',
                }}
              >
                ⚠
              </div>

              {integrityAlert.blocked ? (
                <>
                  <h1
                    style={{
                      fontSize: '2.3rem',
                    }}
                  >
                    INTENTO BLOQUEADO
                  </h1>

                  <p
                    style={{
                      fontSize: '1.4rem',
                    }}
                  >
                    QuIzA detectó múltiples
                    incidencias de integridad
                    durante esta evaluación.
                  </p>

                  <p
                    style={{
                      fontSize: '1.8rem',
                      fontWeight: 'bold',
                    }}
                  >
                    Incidencias registradas:{' '}
                    {
                      integrityAlert.count
                    }
                  </p>

                  <p>
                    El intento ha sido
                    detenido y el evento
                    quedó registrado.
                  </p>

                  <p>
                    Comunícate con el docente.
                  </p>
                </>
              ) : (
                <>
                  <h1
                    style={{
                      fontSize: '2.2rem',
                    }}
                  >
                    SALIDA DE QUIZA DETECTADA
                  </h1>

                  <p
                    style={{
                      fontSize: '1.35rem',
                    }}
                  >
                    Se detectó que la
                    evaluación dejó de estar
                    visible en este
                    dispositivo.
                  </p>

                  <p>
                    La pregunta anterior fue
                    invalidada y reemplazada.
                  </p>

                  <div
                    style={{
                      fontSize: '1.6rem',
                      fontWeight: 'bold',
                      margin: '1.5rem 0',
                    }}
                  >
                    ⚠ Incidencia de integridad registrada
                  </div>

                  <p>
                    Esta incidencia ha quedado
                    registrada.
                  </p>

                  <button
                    type="button"
                    onClick={
                      handleContinueAfterIntegrityAlert
                    }
                    style={{
                      marginTop: '1.5rem',

                      padding:
                        '1rem 1.5rem',

                      fontSize: '1.15rem',

                      fontWeight: 'bold',

                      cursor: 'pointer',
                    }}
                  >
                    Continuar evaluación
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </>
    )
  }

  return (
    <main>
      <h1>QuIzA</h1>

      <form onSubmit={handleLogin}>
        <div>
          <label>
            Correo

            <input
              type="email"
              value={email}
              onChange={(event) =>
                setEmail(
                  event.target.value
                )
              }
              required
            />
          </label>
        </div>

        <div>
          <label>
            Contraseña

            <input
              type="password"
              value={password}
              onChange={(event) =>
                setPassword(
                  event.target.value
                )
              }
              required
            />
          </label>
        </div>

        <button type="submit">
          Ingresar
        </button>
      </form>

      {message && (
        <p>{message}</p>
      )}
    </main>
  )
}

export default App