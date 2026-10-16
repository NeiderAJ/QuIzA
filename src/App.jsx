import { useCallback, useEffect, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { supabase } from './supabaseClient'

const evaluationStatusLabels = {
  draft: 'Borrador',
  published: 'Publicada',
  closed: 'Cerrada',
}

const deliveryModeLabels = {
  in_person: 'Presencial',
  asynchronous: 'Virtual asincrónica',
}

const attemptStatusLabels = {
  in_progress: 'En curso',
  submitted: 'Entregado',
  graded: 'Calificado',
  expired: 'Vencido',
  blocked: 'Bloqueado',
}

const basicEmailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const baseQuestionOptionIds = ['A', 'B', 'C', 'D']

function createEmptyBaseQuestionDraft() {
  return {
    statement: '',
    options: {
      A: '',
      B: '',
      C: '',
      D: '',
    },
    correctAnswer: '',
  }
}

function formatAnswerPayload(answerPayload) {
  if (!answerPayload) {
    return 'Sin respuesta'
  }

  return answerPayload.selected_option ?? JSON.stringify(answerPayload)
}

function createEmptySurveyOptions() {
  return ['', '']
}

function createAnonymousRespondentToken() {
  if (typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID()
  }

  const randomBytes = new Uint8Array(32)
  window.crypto.getRandomValues(randomBytes)

  return Array.from(randomBytes, (value) =>
    value.toString(16).padStart(2, '0')
  ).join('')
}

function parseParticipantInput(input, existingEmails = []) {
  const candidates = []
  const invalidEntries = []

  function addCandidate(emailValue, nameValue, source) {
    const email = emailValue.trim().toLowerCase()
    const participantName = nameValue?.trim() || null

    if (!basicEmailPattern.test(email)) {
      invalidEntries.push(source)
      return
    }

    candidates.push({ email, participantName })
  }

  input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const tabParts = line.split('\t').map((part) => part.trim())

      if (tabParts.length > 1) {
        const email = tabParts.at(-1)
        addCandidate(email, tabParts.slice(0, -1).join(' '), line)
        return
      }

      const commaParts = line.split(',').map((part) => part.trim())

      if (
        commaParts.length > 1 &&
        commaParts.every((part) => basicEmailPattern.test(part.toLowerCase()))
      ) {
        commaParts.forEach((email) => addCandidate(email, null, line))
        return
      }

      if (
        commaParts.length > 1 &&
        basicEmailPattern.test(commaParts.at(-1).toLowerCase())
      ) {
        addCandidate(
          commaParts.at(-1),
          commaParts.slice(0, -1).join(', '),
          line
        )
        return
      }

      if (basicEmailPattern.test(line.toLowerCase())) {
        addCandidate(line, null, line)
        return
      }

      const nameAndEmail = line.match(
        /^(.*?)\s+([^\s@]+@[^\s@]+\.[^\s@]+)$/
      )

      if (nameAndEmail) {
        addCandidate(nameAndEmail[2], nameAndEmail[1], line)
        return
      }

      invalidEntries.push(line)
    })

  const knownEmails = new Set(existingEmails.map((email) => email.toLowerCase()))
  const importedEmails = new Set()
  const rows = []
  let duplicateCount = 0

  candidates.forEach((candidate) => {
    if (
      knownEmails.has(candidate.email) ||
      importedEmails.has(candidate.email)
    ) {
      duplicateCount += 1
      return
    }

    importedEmails.add(candidate.email)
    rows.push(candidate)
  })

  return { rows, duplicateCount, invalidEntries }
}

function App() {
  const [authMode, setAuthMode] = useState('login')
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const [profile, setProfile] = useState(null)
  const [authenticatedView, setAuthenticatedView] = useState('panel-v1')

  const [evaluationTitle, setEvaluationTitle] = useState('')
  const [evaluationDuration, setEvaluationDuration] = useState('')
  const [evaluationGroup, setEvaluationGroup] = useState('')
  const [evaluationInstructions, setEvaluationInstructions] = useState('')
  const [creatingEvaluation, setCreatingEvaluation] = useState(false)

  const [surveyQuestion, setSurveyQuestion] = useState('')
  const [surveyOptionDrafts, setSurveyOptionDrafts] = useState(
    createEmptySurveyOptions
  )
  const [creatingSurvey, setCreatingSurvey] = useState(false)
  const [surveys, setSurveys] = useState([])
  const [loadingSurveys, setLoadingSurveys] = useState(false)
  const [selectedSurvey, setSelectedSurvey] = useState(null)
  const [surveyAccess, setSurveyAccess] = useState(null)
  const [surveyResults, setSurveyResults] = useState([])
  const [loadingSurveyResults, setLoadingSurveyResults] = useState(false)
  const [surveyMessage, setSurveyMessage] = useState('')
  const [publicSurveyToken, setPublicSurveyToken] = useState(() =>
    new URLSearchParams(window.location.search).get('survey')
  )
  const [publicSurvey, setPublicSurvey] = useState(null)
  const [publicSurveyLoadState, setPublicSurveyLoadState] = useState('idle')
  const [publicSurveyAnswer, setPublicSurveyAnswer] = useState('')
  const [submittingSurveyResponse, setSubmittingSurveyResponse] =
    useState(false)
  const [publicSurveyMessage, setPublicSurveyMessage] = useState('')

  const [courses, setCourses] = useState([])
  const [selectedCourse, setSelectedCourse] = useState(null)
  const [authorizedEmails, setAuthorizedEmails] = useState([])
  const [participantsInput, setParticipantsInput] = useState('')
  const [participantsPreview, setParticipantsPreview] = useState(null)
  const [participantsMessage, setParticipantsMessage] = useState('')
  const [loadingAuthorizedEmails, setLoadingAuthorizedEmails] = useState(false)
  const [addingAuthorizedEmails, setAddingAuthorizedEmails] = useState(false)
  const [deletingAuthorizedEmailId, setDeletingAuthorizedEmailId] = useState(null)

  const [quizzes, setQuizzes] = useState([])
  const [selectedQuiz, setSelectedQuiz] = useState(null)
  const [questionVariants, setQuestionVariants] = useState([])
  const [baseQuestionsLoadState, setBaseQuestionsLoadState] = useState({
    quizId: null,
    status: 'idle',
  })
  const [selectedQuizHasAttempts, setSelectedQuizHasAttempts] = useState(null)
  const [baseQuestionDraft, setBaseQuestionDraft] = useState(
    createEmptyBaseQuestionDraft
  )
  const [baseQuestionFormOpen, setBaseQuestionFormOpen] = useState(false)
  const [savingBaseQuestion, setSavingBaseQuestion] = useState(false)
  const [baseQuestionsMessage, setBaseQuestionsMessage] = useState('')
  const [generatingQuestionId, setGeneratingQuestionId] = useState(null)
  const [editingQuestionId, setEditingQuestionId] = useState(null)
  const [questionEditDraft, setQuestionEditDraft] = useState(
    createEmptyBaseQuestionDraft
  )
  const [savingQuestionId, setSavingQuestionId] = useState(null)
  const [publishingQuiz, setPublishingQuiz] = useState(false)
  const [duplicatingQuiz, setDuplicatingQuiz] = useState(false)

  const [quizSession, setQuizSession] = useState(null)
  const [liveSessionStatus, setLiveSessionStatus] = useState(null)
  const [liveSessionStatusError, setLiveSessionStatusError] = useState('')
  const [quizResults, setQuizResults] = useState([])
  const [quizResultsState, setQuizResultsState] = useState({
    quizId: null,
    status: 'idle',
    error: '',
  })
  const [selectedResultAttemptId, setSelectedResultAttemptId] = useState(null)
  const [attemptResultDetail, setAttemptResultDetail] = useState([])
  const [attemptResultDetailState, setAttemptResultDetailState] = useState({
    attemptId: null,
    status: 'idle',
    error: '',
  })
  const [authorizingAttemptId, setAuthorizingAttemptId] = useState(null)
  const [newAttemptReason, setNewAttemptReason] = useState('')
  const [authorizingNewAttempt, setAuthorizingNewAttempt] = useState(false)
  const [newAttemptAuthorizationMessage, setNewAttemptAuthorizationMessage] =
    useState('')
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
  const lastFocusEventAtRef = useRef(0)

  const oneMinuteWarningShownRef = useRef(false)
  const tenSecondsWarningShownRef = useRef(false)
  const selectedCourseIdRef = useRef(null)
  const authorizedEmailsLoadIdRef = useRef(0)
  const selectedQuizIdRef = useRef(null)
  const selectedQuizCourseIdRef = useRef(null)
  const selectedCourseTeacherIdRef = useRef(null)
  const profileIdRef = useRef(null)
  const baseQuestionsLoadIdRef = useRef(0)
  const baseQuestionSaveRef = useRef(null)
  const questionOperationRef = useRef(null)
  const quizResultsLoadIdRef = useRef(0)
  const attemptResultDetailLoadIdRef = useRef(0)

  const baseQuestions = questionVariants.filter(
    ({ variant_number: variantNumber }) => variantNumber === 1
  )

  const selectedQuizId = selectedQuiz?.id ?? null
  const selectedQuizCourseId = selectedQuiz?.course_id ?? null
  const selectedCourseId = selectedCourse?.id ?? null
  const selectedCourseTeacherId = selectedCourse?.teacher_id ?? null
  const profileId = profile?.id ?? null

  selectedCourseIdRef.current = selectedCourseId
  selectedQuizIdRef.current = selectedQuizId
  selectedQuizCourseIdRef.current = selectedQuizCourseId
  selectedCourseTeacherIdRef.current = selectedCourseTeacherId
  profileIdRef.current = profileId

  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)

  const loadBaseQuestions = useCallback(async (quizId) => {
    const isSelectedQuizOwner =
      Boolean(quizId) &&
      Boolean(selectedCourseIdRef.current) &&
      Boolean(profileIdRef.current) &&
      selectedQuizIdRef.current === quizId &&
      selectedQuizCourseIdRef.current === selectedCourseIdRef.current &&
      selectedCourseTeacherIdRef.current === profileIdRef.current

    if (!isSelectedQuizOwner) {
      return null
    }

    const loadId = baseQuestionsLoadIdRef.current + 1
    baseQuestionsLoadIdRef.current = loadId
    setBaseQuestionsLoadState({
      quizId,
      status: 'loading',
    })
    setSelectedQuizHasAttempts(null)

    const [questionsResult, attemptsResult] = await Promise.all([
      supabase
        .from('questions')
        .select(`
          id,
          slot_number,
          variant_number,
          question_type,
          statement,
          options,
          correct_answer,
          points
        `)
        .eq('quiz_id', quizId)
        .order('slot_number')
        .order('variant_number'),
      supabase
        .from('attempts')
        .select('id')
        .eq('quiz_id', quizId)
        .limit(1),
    ])

    if (
      loadId !== baseQuestionsLoadIdRef.current ||
      selectedQuizIdRef.current !== quizId
    ) {
      return null
    }

    const editabilityLoaded = !attemptsResult.error

    if (editabilityLoaded) {
      setSelectedQuizHasAttempts(
        (attemptsResult.data?.length ?? 0) > 0
      )
    }

    if (questionsResult.error) {
      setBaseQuestionsLoadState({
        quizId,
        status: 'error',
      })
      setBaseQuestionsMessage(
        `Error cargando preguntas: ${questionsResult.error.message}`
      )
      return {
        questionsLoaded: false,
        editabilityLoaded,
      }
    }

    setQuestionVariants(questionsResult.data ?? [])
    setBaseQuestionsLoadState({
      quizId,
      status: 'success',
    })

    if (attemptsResult.error) {
      setBaseQuestionsMessage(
        `Error verificando si la evaluación es editable: ${attemptsResult.error.message}`
      )
    }

    return {
      questionsLoaded: true,
      editabilityLoaded,
    }
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const token = params.get('join')
    const surveyToken = params.get('survey')

    if (token) {
      setJoinToken(token)
    }

    if (surveyToken) {
      setPublicSurveyToken(surveyToken)
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

  useEffect(() => {
    if (!publicSurveyToken) {
      setPublicSurvey(null)
      setPublicSurveyLoadState('idle')
      setPublicSurveyAnswer('')
      setPublicSurveyMessage('')
      return
    }

    let cancelled = false

    async function loadPublicSurvey() {
      setPublicSurveyLoadState('loading')
      setPublicSurveyMessage('')

      const { data, error } = await supabase.rpc('get_public_survey', {
        p_qr_token: publicSurveyToken,
      })

      if (cancelled) {
        return
      }

      if (error || !data?.[0]) {
        setPublicSurvey(null)
        setPublicSurveyLoadState('error')
        setPublicSurveyMessage(
          error?.message ?? 'No fue posible abrir esta encuesta.'
        )
        return
      }

      setPublicSurvey(data[0])
      setPublicSurveyLoadState('success')
    }

    loadPublicSurvey()

    return () => {
      cancelled = true
    }
  }, [publicSurveyToken])

  useEffect(() => {
    authorizedEmailsLoadIdRef.current += 1
    setAuthorizedEmails([])
    setParticipantsInput('')
    setParticipantsPreview(null)
    setParticipantsMessage('')
    setLoadingAuthorizedEmails(false)

    if (
      !selectedCourse ||
      !profile ||
      selectedCourse.teacher_id !== profile.id
    ) {
      return
    }

    loadAuthorizedEmails(selectedCourse.id)
  }, [
    selectedCourse?.id,
    selectedCourse?.teacher_id,
    profile?.id,
  ])

  useEffect(() => {
    baseQuestionsLoadIdRef.current += 1
    baseQuestionSaveRef.current = null
    questionOperationRef.current = null
    setQuestionVariants([])
    setBaseQuestionsLoadState({
      quizId: selectedQuizId,
      status: 'idle',
    })
    setSelectedQuizHasAttempts(null)
    setBaseQuestionDraft(createEmptyBaseQuestionDraft())
    setBaseQuestionFormOpen(false)
    setSavingBaseQuestion(false)
    setBaseQuestionsMessage('')
    setGeneratingQuestionId(null)
    setEditingQuestionId(null)
    setQuestionEditDraft(createEmptyBaseQuestionDraft())
    setSavingQuestionId(null)
    setPublishingQuiz(false)
    setDuplicatingQuiz(false)
    quizResultsLoadIdRef.current += 1
    attemptResultDetailLoadIdRef.current += 1
    setQuizResults([])
    setQuizResultsState({
      quizId: selectedQuizId,
      status: 'idle',
      error: '',
    })
    setSelectedResultAttemptId(null)
    setAttemptResultDetail([])
    setAttemptResultDetailState({
      attemptId: null,
      status: 'idle',
      error: '',
    })
    setAuthorizingAttemptId(null)
    setNewAttemptReason('')
    setAuthorizingNewAttempt(false)
    setNewAttemptAuthorizationMessage('')

    if (
      !selectedQuizId ||
      !selectedQuizCourseId ||
      !selectedCourseId ||
      !profileId ||
      selectedCourseTeacherId !== profileId ||
      selectedQuizCourseId !== selectedCourseId
    ) {
      return
    }

    loadBaseQuestions(selectedQuizId)
    loadQuizResults(selectedQuizId)
  }, [
    selectedQuizId,
    selectedQuizCourseId,
    selectedCourseId,
    selectedCourseTeacherId,
    profileId,
    loadBaseQuestions,
  ])

  useEffect(() => {
    const quizSessionId = quizSession?.quiz_session_id

    setLiveSessionStatus(null)
    setLiveSessionStatusError('')

    if (!quizSessionId) {
      return
    }

    let cancelled = false

    async function refreshLiveSessionStatus() {
      const { data, error } = await supabase.rpc(
        'get_quiz_session_live_status',
        { p_quiz_session_id: quizSessionId }
      )

      if (cancelled) {
        return
      }

      if (error) {
        setLiveSessionStatusError(error.message)
        return
      }

      setLiveSessionStatus(data?.[0] ?? null)
      setLiveSessionStatusError('')
    }

    refreshLiveSessionStatus()

    const refreshId = window.setInterval(
      refreshLiveSessionStatus,
      5000
    )

    return () => {
      cancelled = true
      window.clearInterval(refreshId)
    }
  }, [quizSession?.quiz_session_id])

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

  async function loadAuthorizedEmails(courseId) {
    if (selectedCourseIdRef.current !== courseId) {
      return false
    }

    const loadId =
      authorizedEmailsLoadIdRef.current + 1

    authorizedEmailsLoadIdRef.current = loadId
    setLoadingAuthorizedEmails(true)

    const { data, error } = await supabase
      .from('course_authorized_emails')
      .select('id, email, participant_name, created_at')
      .eq('course_id', courseId)
      .order('email')

    if (
      loadId !== authorizedEmailsLoadIdRef.current ||
      selectedCourseIdRef.current !== courseId
    ) {
      return false
    }

    setLoadingAuthorizedEmails(false)

    if (error) {
      setParticipantsMessage(
        `Error cargando participantes autorizados: ${error.message}`
      )
      return false
    }

    setAuthorizedEmails(data ?? [])

    return true
  }

  function handlePreviewAuthorizedEmails() {
    if (
      !selectedCourse ||
      selectedCourse.teacher_id !== profile?.id
    ) {
      setParticipantsMessage(
        'No tienes permiso para administrar los participantes de este grupo.'
      )
      return
    }

    if (!participantsInput.trim()) {
      setParticipantsMessage(
        'Pega al menos un correo o una fila con nombre y correo.'
      )
      return
    }

    const preview = parseParticipantInput(
      participantsInput,
      authorizedEmails.map(({ email }) => email)
    )
    const summary = [
      `${preview.rows.length} ${
        preview.rows.length === 1
          ? 'listo para confirmar'
          : 'listos para confirmar'
      }`,
      `${preview.duplicateCount} ${
        preview.duplicateCount === 1
          ? 'duplicado ignorado'
          : 'duplicados ignorados'
      }`,
      `${preview.invalidEntries.length} ${
        preview.invalidEntries.length === 1 ? 'inválido' : 'inválidos'
      }`,
    ].join(' · ')

    setParticipantsPreview(preview)
    setParticipantsMessage(summary)
  }

  async function handleAddAuthorizedEmails() {
    if (
      !selectedCourse ||
      selectedCourse.teacher_id !== profile?.id ||
      !participantsPreview ||
      participantsPreview.rows.length === 0
    ) {
      return
    }

    const rowsToInsert = participantsPreview.rows

    setAddingAuthorizedEmails(true)
    setParticipantsMessage('')

    const { error } = await supabase
      .from('course_authorized_emails')
      .insert(
        rowsToInsert.map(({ email, participantName }) => ({
          course_id: selectedCourse.id,
          email,
          participant_name: participantName,
        }))
      )

    if (selectedCourseIdRef.current !== selectedCourse.id) {
      setAddingAuthorizedEmails(false)
      return
    }

    if (error) {
      setParticipantsMessage(
        `Error agregando participantes: ${error.message}`
      )
      setAddingAuthorizedEmails(false)
      return
    }

    const reloaded = await loadAuthorizedEmails(selectedCourse.id)

    setParticipantsInput('')
    setParticipantsPreview(null)
    setAddingAuthorizedEmails(false)

    if (reloaded) {
      setParticipantsMessage(
        `${rowsToInsert.length} ${
          rowsToInsert.length === 1
            ? 'participante agregado'
            : 'participantes agregados'
        } ✅`
      )
    }
  }

  async function handleDeleteAuthorizedEmail(
    authorizedEmail
  ) {
    if (
      !selectedCourse ||
      selectedCourse.teacher_id !== profile?.id
    ) {
      setParticipantsMessage(
        'No tienes permiso para administrar los participantes de este grupo.'
      )
      return
    }

    setDeletingAuthorizedEmailId(authorizedEmail.id)
    setParticipantsMessage('')

    const { error } = await supabase
      .from('course_authorized_emails')
      .delete()
      .eq('id', authorizedEmail.id)

    if (
      selectedCourseIdRef.current !== selectedCourse.id
    ) {
      setDeletingAuthorizedEmailId(null)
      return
    }

    if (error) {
      setParticipantsMessage(
        `Error eliminando participante: ${error.message}`
      )
      setDeletingAuthorizedEmailId(null)
      return
    }

    const reloaded = await loadAuthorizedEmails(
      selectedCourse.id
    )

    setDeletingAuthorizedEmailId(null)

    if (reloaded) {
      setParticipantsMessage(
        `${authorizedEmail.email} eliminado de participantes.`
      )
    }
  }

  async function loadQuizzes(courseId) {
    setQuizzes([])
    setSelectedQuiz(null)
    setQuizSession(null)

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
      .eq('course_id', courseId)
      .order('created_at', { ascending: false })

    if (error) {
      setMessage(
        `Error cargando evaluaciones: ${error.message}`
      )
      return false
    }

    setQuizzes(data ?? [])
    setMessage('')

    return true
  }

  async function handleCreateBaseQuestion(event) {
    event.preventDefault()

    if (baseQuestionSaveRef.current) {
      return
    }

    const quizIdOriginal = selectedQuiz?.id

    if (
      !selectedQuiz ||
      !selectedCourse ||
      selectedCourse.teacher_id !== profile?.id ||
      selectedQuiz.course_id !== selectedCourse.id
    ) {
      setBaseQuestionsMessage(
        'No tienes permiso para crear preguntas en esta evaluación.'
      )
      return
    }

    const isEditable =
      ['draft', 'published'].includes(selectedQuiz.status) &&
      baseQuestionsLoadState.quizId === quizIdOriginal &&
      baseQuestionsLoadState.status === 'success' &&
      selectedQuizHasAttempts === false

    if (!isEditable) {
      setBaseQuestionsMessage(
        'Esta evaluación no está disponible para agregar preguntas.'
      )
      return
    }

    const statement = baseQuestionDraft.statement.trim()
    const trimmedOptions = baseQuestionOptionIds.map((id) => ({
      id,
      text: baseQuestionDraft.options[id].trim(),
    }))

    if (!statement) {
      setBaseQuestionsMessage('El enunciado no puede estar vacío.')
      return
    }

    if (trimmedOptions.some(({ text }) => !text)) {
      setBaseQuestionsMessage('Completa las cuatro opciones A, B, C y D.')
      return
    }

    if (new Set(trimmedOptions.map(({ text }) => text)).size !== 4) {
      setBaseQuestionsMessage(
        'Las opciones no pueden estar duplicadas después de quitar espacios.'
      )
      return
    }

    if (!baseQuestionOptionIds.includes(baseQuestionDraft.correctAnswer)) {
      setBaseQuestionsMessage('Selecciona exactamente una respuesta correcta.')
      return
    }

    const slotNumber =
      Math.max(
        0,
        ...baseQuestions.map(({ slot_number: currentSlotNumber }) =>
          Number(currentSlotNumber)
        )
      ) + 1

    const saveOperation = {
      quizId: quizIdOriginal,
    }

    baseQuestionSaveRef.current = saveOperation

    setSavingBaseQuestion(true)
    setBaseQuestionsMessage('Guardando pregunta...')

    const { error } = await supabase
      .from('questions')
      .insert({
        quiz_id: selectedQuiz.id,
        slot_number: slotNumber,
        variant_number: 1,
        question_type: 'multiple_choice',
        statement,
        options: trimmedOptions,
        correct_answer: {
          selected_option: baseQuestionDraft.correctAnswer,
        },
        points: 1,
      })

    if (
      selectedQuizIdRef.current !== quizIdOriginal ||
      baseQuestionSaveRef.current !== saveOperation
    ) {
      return
    }

    if (error) {
      baseQuestionSaveRef.current = null
      setBaseQuestionsMessage(
        `No fue posible guardar la pregunta: ${error.message}`
      )
      setSavingBaseQuestion(false)
      return
    }

    setBaseQuestionDraft(createEmptyBaseQuestionDraft())
    setBaseQuestionFormOpen(false)
    setBaseQuestionsMessage(
      `Pregunta ${slotNumber} guardada. Actualizando la lista...`
    )

    const reloadResult = await loadBaseQuestions(quizIdOriginal)
    await refreshQuizMetadata(quizIdOriginal)

    if (
      selectedQuizIdRef.current !== quizIdOriginal ||
      baseQuestionSaveRef.current !== saveOperation
    ) {
      return
    }

    baseQuestionSaveRef.current = null
    setSavingBaseQuestion(false)

    if (!reloadResult?.questionsLoaded) {
      setBaseQuestionsMessage(
        'Pregunta guardada, pero no fue posible actualizar la lista. Vuelve a seleccionar la evaluación o recarga la vista.'
      )
      return
    }

    if (!reloadResult.editabilityLoaded) {
      setBaseQuestionsMessage(
        'Pregunta guardada y lista actualizada, pero no fue posible verificar si la evaluación continúa editable.'
      )
      return
    }

    setBaseQuestionsMessage(`Pregunta ${slotNumber} guardada correctamente.`)
  }

  async function handleGenerateVariants(question, regenerate = false) {
    const quizIdOriginal = selectedQuiz?.id

    if (
      !quizIdOriginal ||
      !selectedCourse ||
      selectedCourse.teacher_id !== profile?.id ||
      selectedQuiz.course_id !== selectedCourse.id ||
      selectedQuizHasAttempts !== false ||
      !['draft', 'published'].includes(selectedQuiz.status)
    ) {
      setBaseQuestionsMessage(
        'Esta evaluación no está disponible para generar variantes.'
      )
      return
    }

    const operation = {
      quizId: quizIdOriginal,
      questionId: question.id,
    }

    questionOperationRef.current = operation
    setGeneratingQuestionId(question.id)
    setBaseQuestionsMessage(
      regenerate
        ? `Regenerando la variante ${question.variant_number} de la pregunta ${question.slot_number}...`
        : `Generando cinco variantes para la pregunta ${question.slot_number}...`
    )

    const { error } = await supabase.functions.invoke(
      'generate-quiz-variants',
      {
        body: regenerate
          ? { variantQuestionId: question.id }
          : { baseQuestionId: question.id },
      }
    )

    if (
      questionOperationRef.current !== operation ||
      selectedQuizIdRef.current !== quizIdOriginal
    ) {
      return
    }

    if (error) {
      questionOperationRef.current = null
      setGeneratingQuestionId(null)
      setBaseQuestionsMessage(
        `No fue posible generar las variantes: ${error.message}`
      )
      return
    }

    const reloadResult = await loadBaseQuestions(quizIdOriginal)
    await refreshQuizMetadata(quizIdOriginal)

    if (
      questionOperationRef.current !== operation ||
      selectedQuizIdRef.current !== quizIdOriginal
    ) {
      return
    }

    questionOperationRef.current = null
    setGeneratingQuestionId(null)

    if (!reloadResult?.questionsLoaded) {
      setBaseQuestionsMessage(
        'Las variantes se generaron, pero no fue posible actualizar la lista.'
      )
      return
    }

    setBaseQuestionsMessage(
      regenerate
        ? `Variante ${question.variant_number} de la pregunta ${question.slot_number} regenerada y lista para revisar.`
        : `Variantes de la pregunta ${question.slot_number} listas para revisar.`
    )
  }

  function handleStartQuestionEdit(question) {
    const options = createEmptyBaseQuestionDraft().options

    for (const option of question.options ?? []) {
      if (baseQuestionOptionIds.includes(option.id)) {
        options[option.id] = option.text ?? ''
      }
    }

    setEditingQuestionId(question.id)
    setQuestionEditDraft({
      statement: question.statement ?? '',
      options,
      correctAnswer: question.correct_answer?.selected_option ?? '',
    })
    setBaseQuestionsMessage('')
  }

  async function handleSaveQuestionEdit(event, question) {
    event.preventDefault()

    const quizIdOriginal = selectedQuiz?.id

    if (
      !quizIdOriginal ||
      editingQuestionId !== question.id ||
      selectedQuizHasAttempts !== false ||
      !['draft', 'published'].includes(selectedQuiz.status)
    ) {
      setBaseQuestionsMessage('Esta variante ya no está disponible para editar.')
      return
    }

    const statement = questionEditDraft.statement.trim()
    const options = baseQuestionOptionIds.map((id) => ({
      id,
      text: questionEditDraft.options[id].trim(),
    }))

    if (!statement) {
      setBaseQuestionsMessage('El enunciado no puede estar vacío.')
      return
    }

    if (options.some(({ text }) => !text)) {
      setBaseQuestionsMessage('Completa las cuatro opciones A, B, C y D.')
      return
    }

    if (new Set(options.map(({ text }) => text)).size !== 4) {
      setBaseQuestionsMessage('Las opciones no pueden estar duplicadas.')
      return
    }

    if (!baseQuestionOptionIds.includes(questionEditDraft.correctAnswer)) {
      setBaseQuestionsMessage('Selecciona exactamente una respuesta correcta.')
      return
    }

    const operation = {
      quizId: quizIdOriginal,
      questionId: question.id,
    }

    questionOperationRef.current = operation
    setSavingQuestionId(question.id)
    setBaseQuestionsMessage('Guardando variante...')

    const { error } = await supabase
      .from('questions')
      .update({
        statement,
        options,
        correct_answer: {
          selected_option: questionEditDraft.correctAnswer,
        },
      })
      .eq('id', question.id)

    if (
      questionOperationRef.current !== operation ||
      selectedQuizIdRef.current !== quizIdOriginal
    ) {
      return
    }

    if (error) {
      questionOperationRef.current = null
      setSavingQuestionId(null)
      setBaseQuestionsMessage(
        `No fue posible guardar la variante: ${error.message}`
      )
      return
    }

    const reloadResult = await loadBaseQuestions(quizIdOriginal)
    await refreshQuizMetadata(quizIdOriginal)

    if (
      questionOperationRef.current !== operation ||
      selectedQuizIdRef.current !== quizIdOriginal
    ) {
      return
    }

    questionOperationRef.current = null
    setSavingQuestionId(null)
    setEditingQuestionId(null)

    if (!reloadResult?.questionsLoaded) {
      setBaseQuestionsMessage(
        'La variante se guardó, pero no fue posible actualizar la lista.'
      )
      return
    }

    setBaseQuestionsMessage(
      `Variante ${question.variant_number} de la pregunta ${question.slot_number} guardada.`
    )
  }

  async function handlePublishQuiz() {
    const quizIdOriginal = selectedQuiz?.id

    if (
      !quizIdOriginal ||
      selectedQuiz?.status !== 'draft' ||
      selectedQuizHasAttempts !== false
    ) {
      setBaseQuestionsMessage('Esta evaluación no está disponible para publicar.')
      return
    }

    setPublishingQuiz(true)
    setBaseQuestionsMessage('Validando seis variantes por pregunta...')

    const { error } = await supabase.rpc('publish_quiz', {
      p_quiz_id: quizIdOriginal,
    })

    if (selectedQuizIdRef.current !== quizIdOriginal) {
      return
    }

    if (error) {
      setPublishingQuiz(false)
      setBaseQuestionsMessage(
        `No fue posible publicar: ${error.message}`
      )
      return
    }

    const refreshedQuiz = await refreshQuizMetadata(quizIdOriginal)
    setPublishingQuiz(false)

    if (!refreshedQuiz) {
      setBaseQuestionsMessage(
        'La evaluación se publicó, pero no fue posible actualizar su estado en pantalla.'
      )
      return
    }

    setBaseQuestionsMessage('Evaluación publicada y lista para abrir por QR ✅')
  }

  async function handleDuplicateQuiz() {
    const sourceQuiz = selectedQuiz
    const courseId = selectedCourse?.id

    if (
      !sourceQuiz ||
      !courseId ||
      selectedCourse?.teacher_id !== profile?.id ||
      sourceQuiz.course_id !== courseId
    ) {
      setMessage('No tienes permiso para duplicar esta evaluación.')
      return
    }

    setDuplicatingQuiz(true)
    setMessage('Duplicando evaluación...')

    const { data: copyId, error } = await supabase.rpc('duplicate_quiz', {
      p_source_quiz_id: sourceQuiz.id,
      p_title: null,
    })

    if (error) {
      setDuplicatingQuiz(false)
      setMessage(`No fue posible duplicar la evaluación: ${error.message}`)
      return
    }

    const quizzesLoaded = await loadQuizzes(courseId)
    const copiedQuiz = quizzesLoaded
      ? await loadQuizMetadata(copyId)
      : null

    setDuplicatingQuiz(false)

    if (!copiedQuiz) {
      setMessage(
        'La evaluación se duplicó, pero no fue posible abrir la copia automáticamente.'
      )
      return
    }

    setMessage(`Copia “${copiedQuiz.title}” creada en borrador ✅`)
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
        `Error cargando información de la evaluación: ${error.message}`
      )
      return null
    }

    setSelectedQuiz(data)

    return data
  }

  async function refreshQuizMetadata(quizId) {
    const quiz = await loadQuizMetadata(quizId)

    if (quiz) {
      setQuizzes((currentQuizzes) =>
        currentQuizzes.map((currentQuiz) =>
          currentQuiz.id === quiz.id ? quiz : currentQuiz
        )
      )
    }

    return quiz
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
      `Error cargando el tiempo de la evaluación: ${error.message}`
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

async function handleExpiredAttempt(
  attemptId,
  persistedAttempt = null
) {
  if (!attemptId) {
    return false
  }

  /*
   * La expiración siempre llega desde PostgreSQL.
   * React solamente cierra el estado local y recupera
   * la calificación que el backend ya persistió.
   */
  setCurrentQuestion(null)
  setSelectedAnswer('')
  setActiveAttempt(null)
  setIntegrityAlert(null)
  setSubmittingAnswer(false)
  clearStoredAttempt()

  setAttemptResult({
    status: 'expired',
    score_points: null,
    grade: null,
    details_status: 'loading',
  })

  const hasPersistedResult =
    persistedAttempt?.status === 'expired' &&
    Object.prototype.hasOwnProperty.call(
      persistedAttempt,
      'score_points'
    ) &&
    Object.prototype.hasOwnProperty.call(
      persistedAttempt,
      'grade'
    )

  let attempt = hasPersistedResult
    ? persistedAttempt
    : null

  if (!attempt) {
    const { data, error } = await supabase
      .from('attempts')
      .select(`
        id,
        status,
        score_points,
        grade
      `)
      .eq('id', attemptId)
      .single()

    if (error) {
      setAttemptResult({
        status: 'expired',
        score_points: null,
        grade: null,
        details_status: 'error',
      })

      setMessage(
        'El tiempo disponible terminó, pero no fue posible recuperar la calificación persistida.'
      )

      return false
    }

    attempt = data
  }

  if (attempt?.status !== 'expired') {
    setAttemptResult({
      status: 'expired',
      score_points: null,
      grade: null,
      details_status: 'error',
    })

    setMessage(
      'El backend no confirmó el resultado vencido de la evaluación.'
    )

    return false
  }

  setAttemptResult({
    status: 'expired',
    score_points: attempt.score_points,
    grade: attempt.grade,
    details_status: 'loaded',
  })

  setMessage(
    'El tiempo disponible para esta evaluación terminó.'
  )

  return true
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
      status,
      score_points,
      grade
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
  if (attempt.status === 'expired') {
    await loadQuizMetadata(attempt.quiz_id)
    await handleExpiredAttempt(attempt.id, attempt)

    return false
  }

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
        `Error ingresando a la evaluación: ${error.message}`
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

    setMessage('Acceso a la evaluación autorizado ✅')

    return true
  }


  async function handleStartAsyncQuiz() {
  if (!selectedQuiz) {
    return
  }

  setMessage('Iniciando evaluación virtual...')

  const { data, error } = await supabase.rpc(
    'start_async_quiz_attempt',
    {
      p_quiz_id: selectedQuiz.id,
    }
  )

  if (error) {
    setMessage(
      `Error iniciando la evaluación: ${error.message}`
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

  setMessage('Evaluación virtual iniciada ✅')
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
    .select('status, score_points, grade')
    .eq('id', attemptId)
    .single()

  if (!attemptError && attempt?.status === 'expired') {
    await handleExpiredAttempt(attemptId, attempt)

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
            await handleExpiredAttempt(
              activeAttempt.attempt_id
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
      await handleExpiredAttempt(
        activeAttempt.attempt_id
      )

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
        `Respuesta guardada, pero hubo un error cerrando la evaluación: ${submitError.message}`
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
        `Evaluación entregada, pero no fue posible leer el resultado: ${finalAttemptError.message}`
      )

      setSubmittingAnswer(false)

      return
    }

    if (finalAttempt.status === 'expired') {
      await handleExpiredAttempt(
        activeAttempt.attempt_id,
        finalAttempt
      )

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
        'Evaluación finalizada y calificada ✅'
      )
    } else {
      setMessage(
        'Evaluación entregada ✅ Algunas respuestas están pendientes de calificación.'
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
    await handleExpiredAttempt(attemptId, data)
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









  async function handleSignUp(event) {
    event.preventDefault()

    const normalizedName = fullName.trim()
    const normalizedEmail =
      email.trim().toLowerCase()

    if (!normalizedName) {
      setMessage('Ingresa tu nombre.')
      return
    }

    setMessage('Creando cuenta...')

    const { data, error } =
      await supabase.auth.signUp({
        email: normalizedEmail,
        password,
        options: {
          data: {
            full_name: normalizedName,
          },
        },
      })

    if (error) {
      setMessage(`Error: ${error.message}`)
      return
    }

    setEmail(normalizedEmail)
    setPassword('')

    if (data.session && data.user) {
      const params =
        new URLSearchParams(
          window.location.search
        )

      const token = params.get('join')

      if (token) {
        setJoinToken(token)
      }

      const loaded =
        await loadProfile(data.user.id)

      if (loaded) {
        setFullName('')

        if (token) {
          await joinQuizSession(token)
        } else {
          setMessage('Cuenta creada correctamente ✅')
        }
      }

      return
    }

    setFullName('')
    setAuthMode('login')
    setMessage(
      'Cuenta creada. Revisa tu correo para confirmarla antes de iniciar sesión.'
    )
  }

  async function handleGoogleSignIn() {
    const redirectUrl = new URL(
      import.meta.env.BASE_URL,
      window.location.origin
    )

    redirectUrl.search = window.location.search

    setMessage('Redirigiendo a Google...')

    const { error } =
      await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: redirectUrl.toString(),
        },
      })

    if (error) {
      setMessage(`Error: ${error.message}`)
    }
  }

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

    setSurveyQuestion('')
    setSurveyOptionDrafts(createEmptySurveyOptions())
    setCreatingSurvey(false)
    setSurveys([])
    setSelectedSurvey(null)
    setSurveyAccess(null)
    setSurveyResults([])
    setSurveyMessage('')

    setJoinToken(null)
    setActiveAttempt(null)

    setCurrentQuestion(null)
    setSelectedAnswer('')

    setAttemptResult(null)

    setIntegrityAlert(null)

    setEmail('')
    setPassword('')
    setFullName('')
    setAuthMode('login')
    setAuthenticatedView('panel-v1')

    setMessage('')
  }

  async function handleCourseSelect(course) {
    setSelectedCourse(course)

    await loadQuizzes(course.id)
  }

  async function loadSurveys() {
    setLoadingSurveys(true)

    const { data, error } = await supabase
      .from('surveys')
      .select('id, question, options, status, created_at, updated_at')
      .order('created_at', { ascending: false })

    setLoadingSurveys(false)

    if (error) {
      setSurveyMessage(`Error cargando encuestas: ${error.message}`)
      return null
    }

    setSurveys(data ?? [])
    return data ?? []
  }

  async function openSurveyManager() {
    setAuthenticatedView('create-survey')
    setSurveyMessage('')
    await loadSurveys()
  }

  async function loadSurveyResults(surveyId) {
    if (!surveyId) {
      return false
    }

    setLoadingSurveyResults(true)

    const { data, error } = await supabase.rpc('get_survey_results', {
      p_survey_id: surveyId,
    })

    setLoadingSurveyResults(false)

    if (error) {
      setSurveyMessage(`Error cargando resultados: ${error.message}`)
      return false
    }

    setSurveyResults(data ?? [])
    return true
  }

  async function handleSurveySelect(survey) {
    setSelectedSurvey(survey)
    setSurveyAccess(null)
    setSurveyResults([])
    setSurveyMessage('')
    await loadSurveyResults(survey.id)
  }

  async function handleCreateSurvey(event) {
    event.preventDefault()

    const question = surveyQuestion.trim()
    const options = surveyOptionDrafts.map((option) => option.trim())

    if (!question || options.some((option) => !option)) {
      setSurveyMessage('Completa la pregunta y todas las opciones.')
      return
    }

    setCreatingSurvey(true)
    setSurveyMessage('Creando encuesta...')

    const created = await supabase.rpc('create_survey', {
      p_question: question,
      p_options: options,
    })

    if (created.error) {
      setCreatingSurvey(false)
      setSurveyMessage(`Error creando encuesta: ${created.error.message}`)
      return
    }

    const opened = await supabase.rpc('open_survey', {
      p_survey_id: created.data,
    })

    if (opened.error || !opened.data?.[0]) {
      setCreatingSurvey(false)
      setSurveyMessage(
        `La encuesta se creó, pero no fue posible generar el QRS: ${
          opened.error?.message ?? 'respuesta vacía'
        }`
      )
      await loadSurveys()
      return
    }

    const loadedSurveys = await loadSurveys()
    const createdSurvey = loadedSurveys?.find(
      (survey) => survey.id === created.data
    )

    setCreatingSurvey(false)
    setSurveyQuestion('')
    setSurveyOptionDrafts(createEmptySurveyOptions())
    setSelectedSurvey(createdSurvey ?? null)
    setSurveyAccess(opened.data[0])
    setSurveyResults(
      options.map((optionText, index) => ({
        option_number: index + 1,
        option_text: optionText,
        response_count: 0,
      }))
    )
    setSurveyMessage('Encuesta creada y QRS activo ✅')
  }

  async function handleOpenSurvey() {
    if (!selectedSurvey) {
      return
    }

    setSurveyMessage('Generando un nuevo QRS...')

    const { data, error } = await supabase.rpc('open_survey', {
      p_survey_id: selectedSurvey.id,
    })

    if (error || !data?.[0]) {
      setSurveyMessage(
        `No fue posible generar el QRS: ${error?.message ?? 'respuesta vacía'}`
      )
      return
    }

    setSurveyAccess(data[0])
    setSelectedSurvey((survey) => ({ ...survey, status: 'active' }))
    setSurveys((currentSurveys) =>
      currentSurveys.map((survey) =>
        survey.id === selectedSurvey.id
          ? { ...survey, status: 'active' }
          : survey
      )
    )
    setSurveyMessage('QRS activo ✅')
  }

  async function handleCloseSurvey() {
    if (!selectedSurvey) {
      return
    }

    const { error } = await supabase.rpc('close_survey', {
      p_survey_id: selectedSurvey.id,
    })

    if (error) {
      setSurveyMessage(`No fue posible cerrar la encuesta: ${error.message}`)
      return
    }

    setSurveyAccess(null)
    setSelectedSurvey((survey) => ({ ...survey, status: 'closed' }))
    setSurveys((currentSurveys) =>
      currentSurveys.map((survey) =>
        survey.id === selectedSurvey.id
          ? { ...survey, status: 'closed' }
          : survey
      )
    )
    setSurveyMessage('Encuesta cerrada. El QRS ya no admite respuestas.')
  }

  async function handleSubmitSurveyResponse(event) {
    event.preventDefault()

    if (!publicSurvey || !publicSurveyAnswer || !publicSurveyToken) {
      setPublicSurveyMessage('Selecciona una opción antes de responder.')
      return
    }

    const storageKey = `quiza_survey_respondent_${publicSurvey.survey_id}`
    let respondentToken

    try {
      respondentToken = window.localStorage.getItem(storageKey)

      if (!respondentToken) {
        respondentToken = createAnonymousRespondentToken()
        window.localStorage.setItem(storageKey, respondentToken)
      }
    } catch {
      respondentToken = createAnonymousRespondentToken()
    }

    setSubmittingSurveyResponse(true)
    setPublicSurveyMessage('Registrando respuesta...')

    const { data, error } = await supabase.rpc('submit_survey_response', {
      p_qr_token: publicSurveyToken,
      p_respondent_token: respondentToken,
      p_selected_option: publicSurveyAnswer,
    })

    setSubmittingSurveyResponse(false)

    if (error) {
      setPublicSurveyMessage(`No fue posible responder: ${error.message}`)
      return
    }

    setPublicSurveyMessage(
      data
        ? 'Respuesta registrada. Gracias por participar ✅'
        : 'Este dispositivo ya respondió esta encuesta.'
    )
  }

  function handleLeavePublicSurvey() {
    window.history.replaceState({}, '', window.location.pathname)
    setPublicSurveyToken(null)
  }

  async function findOwnedCourseByNickname(userId, nickname) {
    const { data, error } = await supabase
      .from('courses')
      .select(
        'id, nickname, name, code, group_name, academic_period, teacher_id'
      )
      .eq('teacher_id', userId)

    if (error) {
      throw error
    }

    const normalizedNickname = nickname.toLowerCase()

    return (data ?? []).find(
      (course) =>
        course.nickname.trim().toLowerCase() ===
        normalizedNickname
    ) ?? null
  }

  async function handleCreateEvaluation(event) {
    event.preventDefault()

    const title = evaluationTitle.trim()
    const groupName = evaluationGroup
      .trim()
      .replace(/\s+/g, ' ')
    const durationMinutes = Number(evaluationDuration)
    const instructions = evaluationInstructions.trim()

    if (!title || !groupName) {
      setMessage(
        'Completa el título y el nombre del grupo.'
      )
      return
    }

    if (
      !Number.isInteger(durationMinutes) ||
      durationMinutes <= 0
    ) {
      setMessage(
        'La duración debe ser un número entero mayor que cero.'
      )
      return
    }

    setCreatingEvaluation(true)
    setMessage('Creando evaluación...')

    try {
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser()

      if (userError || !user) {
        throw userError ?? new Error(
          'No fue posible verificar la sesión autenticada.'
        )
      }

      let course = await findOwnedCourseByNickname(
        user.id,
        groupName
      )

      if (!course) {
        const { data, error } = await supabase
          .from('courses')
          .insert({
            teacher_id: user.id,
            name: groupName,
            nickname: groupName,
          })
          .select(
            'id, nickname, name, code, group_name, academic_period, teacher_id'
          )
          .single()

        if (error?.code === '23505') {
          course = await findOwnedCourseByNickname(
            user.id,
            groupName
          )
        } else if (error) {
          throw error
        } else {
          course = data
        }
      }

      if (!course) {
        throw new Error(
          'No fue posible crear o recuperar el grupo.'
        )
      }

      const { data: quiz, error: quizError } = await supabase
        .from('quizzes')
        .insert({
          course_id: course.id,
          created_by: user.id,
          title,
          instructions: instructions || null,
          duration_minutes: durationMinutes,
          delivery_mode: 'in_person',
          status: 'draft',
        })
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
        .single()

      if (quizError) {
        throw quizError
      }

      await loadCourses()
      await loadQuizzes(course.id)

      setSelectedCourse(course)
      setSelectedQuiz(quiz)
      setAuthenticatedView('panel-v1')

      setEvaluationTitle('')
      setEvaluationDuration('')
      setEvaluationGroup('')
      setEvaluationInstructions('')

      setMessage(
        `Evaluación “${quiz.title}” creada en borrador ✅`
      )
    } catch (error) {
      setMessage(
        `Error creando evaluación: ${error.message}`
      )
    } finally {
      setCreatingEvaluation(false)
    }
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

  async function loadQuizResults(quizId) {
    if (!quizId) {
      return false
    }

    const loadId = quizResultsLoadIdRef.current + 1
    quizResultsLoadIdRef.current = loadId
    setQuizResultsState({
      quizId,
      status: 'loading',
      error: '',
    })

    const { data, error } = await supabase.rpc('get_quiz_results', {
      p_quiz_id: quizId,
    })

    if (
      loadId !== quizResultsLoadIdRef.current ||
      selectedQuizIdRef.current !== quizId
    ) {
      return false
    }

    if (error) {
      setQuizResultsState({
        quizId,
        status: 'error',
        error: error.message,
      })
      return false
    }

    setQuizResults(data ?? [])
    setQuizResultsState({
      quizId,
      status: 'success',
      error: '',
    })
    return true
  }

  async function handleLoadAttemptResultDetail(attemptId) {
    if (!attemptId) {
      return
    }

    const loadId = attemptResultDetailLoadIdRef.current + 1
    attemptResultDetailLoadIdRef.current = loadId
    setSelectedResultAttemptId(attemptId)
    setAttemptResultDetail([])
    setAttemptResultDetailState({
      attemptId,
      status: 'loading',
      error: '',
    })

    const { data, error } = await supabase.rpc(
      'get_attempt_result_detail',
      { p_attempt_id: attemptId }
    )

    if (
      loadId !== attemptResultDetailLoadIdRef.current ||
      selectedQuizIdRef.current !== selectedQuiz?.id
    ) {
      return
    }

    if (error) {
      setAttemptResultDetailState({
        attemptId,
        status: 'error',
        error: error.message,
      })
      return
    }

    setAttemptResultDetail(data ?? [])
    setAttemptResultDetailState({
      attemptId,
      status: 'success',
      error: '',
    })
  }

  async function handleAuthorizeNewAttempt(event) {
    event.preventDefault()

    const attemptId = authorizingAttemptId

    if (!attemptId || authorizingNewAttempt) {
      return
    }

    setAuthorizingNewAttempt(true)
    setNewAttemptAuthorizationMessage('')

    const { error } = await supabase.rpc('authorize_new_attempt', {
      p_previous_attempt_id: attemptId,
      p_reason: newAttemptReason.trim() || null,
    })

    if (error) {
      setAuthorizingNewAttempt(false)
      setNewAttemptAuthorizationMessage(
        `No fue posible autorizar el nuevo intento: ${error.message}`
      )
      return
    }

    const refreshed = await loadQuizResults(selectedQuizIdRef.current)

    setAuthorizingNewAttempt(false)

    if (!refreshed) {
      setNewAttemptAuthorizationMessage(
        'El intento fue autorizado, pero no fue posible actualizar los resultados.'
      )
      return
    }

    setAuthorizingAttemptId(null)
    setNewAttemptReason('')
    setNewAttemptAuthorizationMessage(
      'Nuevo intento autorizado. La autorización se consumirá en el próximo ingreso por QRR.'
    )
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

  setMessage('Cerrando acceso a la evaluación...')

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
  setMessage('Acceso a la evaluación cerrado ✅')
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

function renderAuthenticatedHeader() {
  return (
    <header className="authenticated-header">
      <h1>QuIzA</h1>

      <details className="user-menu">
        <summary>
          <span>{profile.full_name}</span>
          <span aria-hidden="true">▾</span>
        </summary>

        <div className="user-menu-panel">
          <p>{profile.email}</p>

          <button
            type="button"
            onClick={handleLogout}
          >
            Cerrar sesión
          </button>
        </div>
      </details>
    </header>
  )
}

  if (loading) {
    return <p>Cargando QuIzA...</p>
  }

  if (publicSurveyToken) {
    return (
      <main className="public-survey-page">
        <h1>QuIzA</h1>

        <section aria-labelledby="public-survey-heading">
          <h2 id="public-survey-heading">Encuesta rápida</h2>

          {publicSurveyLoadState === 'loading' ? (
            <p>Cargando encuesta...</p>
          ) : publicSurveyLoadState === 'error' ? (
            <p role="alert">{publicSurveyMessage}</p>
          ) : publicSurvey ? (
            <form onSubmit={handleSubmitSurveyResponse}>
              <fieldset disabled={submittingSurveyResponse}>
                <legend>{publicSurvey.question}</legend>

                <div className="survey-answer-options">
                  {publicSurvey.options.map((option) => (
                    <label key={option}>
                      <input
                        type="radio"
                        name="survey-answer"
                        value={option}
                        checked={publicSurveyAnswer === option}
                        onChange={() => setPublicSurveyAnswer(option)}
                      />
                      {option}
                    </label>
                  ))}
                </div>
              </fieldset>

              <button
                type="submit"
                disabled={
                  submittingSurveyResponse || !publicSurveyAnswer
                }
              >
                {submittingSurveyResponse
                  ? 'Enviando...'
                  : 'Enviar respuesta'}
              </button>

              {publicSurveyMessage && (
                <p role="status">{publicSurveyMessage}</p>
              )}
            </form>
          ) : null}

          <button type="button" onClick={handleLeavePublicSurvey}>
            Ir a QuIzA
          </button>
        </section>
      </main>
    )
  }

  if (profile) {
    const isSelectedCourseOwner =
      Boolean(selectedCourse) &&
      selectedCourse?.teacher_id === profile.id

    const isSelectedEvaluationOwner =
      Boolean(selectedQuiz) &&
      Boolean(selectedCourse) &&
      selectedCourse.teacher_id === profile.id &&
      selectedQuiz.course_id === selectedCourse.id

    const selectedBaseQuestionsLoadStatus =
      baseQuestionsLoadState.quizId === selectedQuiz?.id
        ? baseQuestionsLoadState.status
        : 'idle'

    const questionGroups = baseQuestions.map((baseQuestion) => ({
      baseQuestion,
      variants: questionVariants.filter(
        ({ slot_number: slotNumber }) =>
          slotNumber === baseQuestion.slot_number
      ),
    }))
    const completeQuestionGroups = questionGroups.filter(
      ({ variants }) =>
        variants.length === 6 &&
        variants.every(
          ({ variant_number: variantNumber }, index) =>
            variantNumber === index + 1
        )
    ).length

    const baseQuestionsSummary =
      selectedBaseQuestionsLoadStatus === 'loading'
        ? 'Cargando preguntas...'
        : selectedBaseQuestionsLoadStatus === 'success'
          ? `${baseQuestions.length} ${
              baseQuestions.length === 1
                ? 'pregunta base'
                : 'preguntas base'
            } · ${completeQuestionGroups}/${baseQuestions.length} con seis variantes`
          : selectedBaseQuestionsLoadStatus === 'error'
            ? 'Preguntas no disponibles'
            : 'Preguntas pendientes de carga'

    const isSelectedEvaluationEditable =
      isSelectedEvaluationOwner &&
      ['draft', 'published'].includes(selectedQuiz?.status) &&
      selectedBaseQuestionsLoadStatus === 'success' &&
      selectedQuizHasAttempts === false

    const latestAttemptNumberByStudent = quizResults.reduce(
      (latestAttempts, result) => {
        const currentLatest =
          latestAttempts.get(result.student_id) ?? 0

        if (result.attempt_number > currentLatest) {
          latestAttempts.set(result.student_id, result.attempt_number)
        }

        return latestAttempts
      },
      new Map()
    )

        if (
  isSelectedEvaluationOwner &&
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
        Evaluación: <strong>{selectedQuiz?.title}</strong>
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

    const hasPriorityQuizFlow =
      joinToken ||
      activeAttempt ||
      currentQuestion ||
      attemptResult ||
      integrityAlert

    if (
      authenticatedView === 'create-survey' &&
      !hasPriorityQuizFlow
    ) {
      return (
        <main>
          {renderAuthenticatedHeader()}

          <section className="survey-manager">
            <div className="results-header">
              <div>
                <h2>Crear encuesta rápida</h2>
                <p>
                  Las respuestas son anónimas y no se relacionan con cuentas,
                  grupos ni evaluaciones.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setAuthenticatedView('panel-v1')
                  setSurveyMessage('')
                }}
                disabled={creatingSurvey}
              >
                Volver al dashboard
              </button>
            </div>

            <form
              className="survey-create-form"
              onSubmit={handleCreateSurvey}
            >
              <label>
                Pregunta
                <textarea
                  value={surveyQuestion}
                  onChange={(event) =>
                    setSurveyQuestion(event.target.value)
                  }
                  rows="3"
                  required
                  disabled={creatingSurvey}
                />
              </label>

              {surveyOptionDrafts.map((option, index) => (
                <div className="survey-option-draft" key={index}>
                  <label>
                    Opción {index + 1}
                    <input
                      type="text"
                      value={option}
                      onChange={(event) =>
                        setSurveyOptionDrafts((currentOptions) =>
                          currentOptions.map((currentOption, optionIndex) =>
                            optionIndex === index
                              ? event.target.value
                              : currentOption
                          )
                        )
                      }
                      required
                      disabled={creatingSurvey}
                    />
                  </label>

                  {surveyOptionDrafts.length > 2 && (
                    <button
                      type="button"
                      onClick={() =>
                        setSurveyOptionDrafts((currentOptions) =>
                          currentOptions.filter(
                            (_, optionIndex) => optionIndex !== index
                          )
                        )
                      }
                      disabled={creatingSurvey}
                    >
                      Eliminar
                    </button>
                  )}
                </div>
              ))}

              {surveyOptionDrafts.length < 10 && (
                <button
                  type="button"
                  onClick={() =>
                    setSurveyOptionDrafts((currentOptions) => [
                      ...currentOptions,
                      '',
                    ])
                  }
                  disabled={creatingSurvey}
                >
                  Agregar opción
                </button>
              )}

              <button type="submit" disabled={creatingSurvey}>
                {creatingSurvey ? 'Creando...' : 'Crear y abrir QRS'}
              </button>
            </form>

            {surveyMessage && <p role="status">{surveyMessage}</p>}
          </section>

          <section className="survey-manager">
            <h2>Mis encuestas</h2>

            {loadingSurveys ? (
              <p>Cargando encuestas...</p>
            ) : surveys.length === 0 ? (
              <p className="empty-state">No has creado encuestas todavía.</p>
            ) : (
              <div className="survey-dashboard">
                <ul className="selection-list">
                  {surveys.map((survey) => (
                    <li key={survey.id}>
                      <button
                        type="button"
                        className={
                          selectedSurvey?.id === survey.id
                            ? 'is-selected'
                            : ''
                        }
                        aria-pressed={selectedSurvey?.id === survey.id}
                        onClick={() => handleSurveySelect(survey)}
                      >
                        <strong>{survey.question}</strong>
                        <small>{survey.status}</small>
                      </button>
                    </li>
                  ))}
                </ul>

                {selectedSurvey && (
                  <div className="survey-detail">
                    <h3>{selectedSurvey.question}</h3>
                    <p>Estado: {selectedSurvey.status}</p>

                    <button type="button" onClick={handleOpenSurvey}>
                      {selectedSurvey.status === 'active'
                        ? 'Regenerar QRS'
                        : 'Abrir QRS'}
                    </button>

                    {selectedSurvey.status === 'active' && (
                      <button type="button" onClick={handleCloseSurvey}>
                        Cerrar encuesta
                      </button>
                    )}

                    {surveyAccess && (
                      <div className="survey-qr">
                        <QRCodeSVG
                          value={`${window.location.origin}/?survey=${encodeURIComponent(
                            surveyAccess.qr_token
                          )}`}
                          size={240}
                        />
                        <p>
                          Este QRS solo abre la encuesta y no contiene datos
                          personales.
                        </p>
                      </div>
                    )}

                    <div className="results-header">
                      <h3>Resultados agregados</h3>
                      <button
                        type="button"
                        onClick={() =>
                          loadSurveyResults(selectedSurvey.id)
                        }
                        disabled={loadingSurveyResults}
                      >
                        {loadingSurveyResults
                          ? 'Actualizando...'
                          : 'Actualizar'}
                      </button>
                    </div>

                    <ul className="survey-results">
                      {surveyResults.map((result) => (
                        <li key={result.option_number}>
                          <span>{result.option_text}</span>
                          <strong>{result.response_count}</strong>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </section>
        </main>
      )
    }

    if (
      authenticatedView === 'home' &&
      !hasPriorityQuizFlow
    ) {
      return (
        <main>
          {renderAuthenticatedHeader()}

          <nav
            className="primary-actions"
            aria-label="Acciones principales"
          >
            <button
              type="button"
              onClick={() =>
                setMessage(
                  'El escáner interno aún está en desarrollo. Por ahora, abre el código QR con la cámara de tu dispositivo.'
                )
              }
            >
              Escanear QR
            </button>

            <button
              type="button"
              onClick={() => {
                setAuthenticatedView('create-evaluation')
                setMessage('')
              }}
            >
              Crear evaluación
            </button>

            <button
              type="button"
              onClick={openSurveyManager}
            >
              Crear encuesta rápida
            </button>
          </nav>

          {message && (
            <p>{message}</p>
          )}
        </main>
      )
    }

    if (
      authenticatedView === 'create-evaluation' &&
      !hasPriorityQuizFlow
    ) {
      return (
        <main>
          {renderAuthenticatedHeader()}

          <form
            onSubmit={handleCreateEvaluation}
            style={{ marginTop: '24px' }}
          >
            <h2>Crear evaluación</h2>

            <div>
              <label>
                Título de la evaluación
                <input
                  type="text"
                  value={evaluationTitle}
                  onChange={(event) =>
                    setEvaluationTitle(event.target.value)
                  }
                  required
                  disabled={creatingEvaluation}
                />
              </label>
            </div>

            <div>
              <label>
                Duración en minutos
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={evaluationDuration}
                  onChange={(event) =>
                    setEvaluationDuration(event.target.value)
                  }
                  required
                  disabled={creatingEvaluation}
                />
              </label>
            </div>

            <div>
              <label>
                Nombre del grupo
                <input
                  type="text"
                  value={evaluationGroup}
                  onChange={(event) =>
                    setEvaluationGroup(event.target.value)
                  }
                  required
                  disabled={creatingEvaluation}
                />
              </label>
            </div>

            <div>
              <label>
                Instrucciones (opcional)
                <textarea
                  value={evaluationInstructions}
                  onChange={(event) =>
                    setEvaluationInstructions(event.target.value)
                  }
                  rows="4"
                  disabled={creatingEvaluation}
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    border: '1px solid #cfd6cd',
                    borderRadius: '9px',
                    resize: 'vertical',
                  }}
                />
              </label>
            </div>

            <button
              type="submit"
              disabled={creatingEvaluation}
            >
              {creatingEvaluation
                ? 'Creando...'
                : 'Crear evaluación'}
            </button>

            <button
              type="button"
              onClick={() => {
                setAuthenticatedView('panel-v1')
                setMessage('')
              }}
              disabled={creatingEvaluation}
              style={{
                width: '100%',
                marginTop: '10px',
                backgroundColor: '#fff',
                borderColor: '#b8c9b4',
                color: '#2e6b24',
              }}
            >
              Cancelar
            </button>

            {message && (
              <p role="status">{message}</p>
            )}
          </form>
        </main>
      )
    }

    return (
      <>
        <main>
          {renderAuthenticatedHeader()}

          {!hasPriorityQuizFlow && (
            <>
              <nav
                className="primary-actions"
                aria-label="Acciones principales"
              >
                <button
                  type="button"
                  onClick={() => {
                    setAuthenticatedView('panel-v1')
                    setMessage(
                      'El escáner interno aún está en desarrollo. Por ahora, abre el código QR con la cámara de tu dispositivo.'
                    )
                  }}
                >
                  Escanear QR
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setAuthenticatedView('create-evaluation')
                    setMessage('')
                  }}
                >
                  Crear evaluación
                </button>

                <button
                  type="button"
                  onClick={openSurveyManager}
                >
                  Crear encuesta rápida
                </button>
              </nav>

              <div className="dashboard-grid">
                <section className="dashboard-column">
                  <h2>Mis grupos</h2>

                  {courses.length === 0 ? (
                    <p className="empty-state">
                      No tienes grupos disponibles.
                    </p>
                  ) : (
                    <ul className="selection-list">
                      {courses.map((course) => {
                        const isSelected =
                          selectedCourse?.id === course.id
                        const namesAreEqual =
                          course.name.trim().toLowerCase() ===
                          course.nickname.trim().toLowerCase()

                        return (
                          <li key={course.id}>
                            <button
                              type="button"
                              className={
                                isSelected ? 'is-selected' : ''
                              }
                              aria-pressed={isSelected}
                              onClick={() =>
                                handleCourseSelect(course)
                              }
                            >
                              <strong>{course.name}</strong>

                              {!namesAreEqual && (
                                <small>{course.nickname}</small>
                              )}
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </section>

                <section className="dashboard-column">
                  <h2>Evaluaciones</h2>

                  {!selectedCourse ? (
                    <p className="empty-state">
                      Selecciona un grupo para ver sus evaluaciones.
                    </p>
                  ) : quizzes.length === 0 ? (
                    <p className="empty-state">
                      No hay evaluaciones disponibles.
                    </p>
                  ) : (
                    <ul className="selection-list">
                      {quizzes.map((quiz) => {
                        const isSelected =
                          selectedQuiz?.id === quiz.id

                        return (
                          <li key={quiz.id}>
                            <button
                              type="button"
                              className={
                                isSelected ? 'is-selected' : ''
                              }
                              aria-pressed={isSelected}
                              onClick={() =>
                                handleQuizSelect(quiz)
                              }
                            >
                              <strong>{quiz.title}</strong>

                              <small>
                                {evaluationStatusLabels[quiz.status] ??
                                  'Estado no disponible'}
                                {' · '}
                                {quiz.duration_minutes} min
                              </small>
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </section>

                <section className="dashboard-column evaluation-detail">
                  {selectedQuiz ? (
                    <>
                      <h2>{selectedQuiz.title}</h2>

                      <div className="evaluation-facts">
                        <p>
                          {evaluationStatusLabels[selectedQuiz.status] ??
                            'Estado no disponible'}
                        </p>

                        <p>
                          {deliveryModeLabels[
                            selectedQuiz.delivery_mode
                          ] ?? 'Modalidad no disponible'}
                        </p>

                        <p>
                          {selectedQuiz.duration_minutes
                            ? `${selectedQuiz.duration_minutes} minutos`
                            : 'Duración no definida'}
                        </p>

                        <p>
                          {isSelectedEvaluationOwner
                            ? baseQuestionsSummary
                            : `${selectedQuiz.number_of_slots ?? 0} ${
                                selectedQuiz.number_of_slots === 1
                                  ? 'pregunta'
                                  : 'preguntas'
                              }`}
                        </p>
                      </div>

                      {selectedQuiz.instructions && (
                        <p className="evaluation-instructions">
                          {selectedQuiz.instructions}
                        </p>
                      )}

                      {isSelectedEvaluationOwner &&
                        selectedQuiz.status === 'draft' && (
                          <button
                            type="button"
                            onClick={handlePublishQuiz}
                            disabled={
                              !isSelectedEvaluationEditable ||
                              publishingQuiz ||
                              generatingQuestionId !== null ||
                              savingQuestionId !== null
                            }
                          >
                            {publishingQuiz
                              ? 'Publicando...'
                              : 'Publicar evaluación'}
                          </button>
                        )}

                      {isSelectedEvaluationOwner && (
                        <button
                          type="button"
                          onClick={handleDuplicateQuiz}
                          disabled={duplicatingQuiz}
                        >
                          {duplicatingQuiz
                            ? 'Duplicando...'
                            : 'Duplicar evaluación'}
                        </button>
                      )}

                      {isSelectedEvaluationOwner &&
                        selectedQuiz.delivery_mode === 'in_person' &&
                        selectedQuiz.status === 'published' && (
                          <button
                            type="button"
                            onClick={handleCreateQuizSession}
                          >
                            {quizSession
                              ? 'Regenerar QR de acceso'
                              : 'Abrir acceso por QR'}
                          </button>
                        )}

                      {!isSelectedEvaluationOwner &&
                        selectedQuiz.delivery_mode === 'asynchronous' &&
                        !activeAttempt && (
                          <button
                            type="button"
                            onClick={handleStartAsyncQuiz}
                          >
                            Comenzar evaluación
                          </button>
                        )}
                    </>
                  ) : (
                    <>
                      <h2>Selecciona una evaluación</h2>
                      <p className="empty-state">
                        Aquí verás su información principal.
                      </p>
                    </>
                  )}
                  </section>
                </div>

              {selectedQuiz &&
                isSelectedEvaluationOwner && (
                  <section
                    className="questions-section"
                    aria-labelledby="questions-heading"
                  >
                    <div className="questions-header">
                      <div>
                        <h2 id="questions-heading">Preguntas</h2>
                        <p>{baseQuestionsSummary}</p>
                      </div>

                  {isSelectedEvaluationEditable && !baseQuestionFormOpen && (
                    <button
                      type="button"
                      onClick={() => {
                        setBaseQuestionFormOpen(true)
                        setBaseQuestionsMessage('')
                      }}
                      disabled={savingBaseQuestion}
                    >
                      Agregar pregunta manual
                    </button>
                  )}
                    </div>

                    {baseQuestionFormOpen &&
                      isSelectedEvaluationEditable && (
                        <form
                          className="base-question-form"
                          onSubmit={handleCreateBaseQuestion}
                        >
                          <label>
                            Enunciado
                            <textarea
                              value={baseQuestionDraft.statement}
                              onChange={(event) =>
                                setBaseQuestionDraft((draft) => ({
                                  ...draft,
                                  statement: event.target.value,
                                }))
                              }
                              rows="4"
                              disabled={savingBaseQuestion}
                            />
                          </label>

                          {baseQuestionOptionIds.map((optionId) => (
                            <label key={optionId}>
                              Opción {optionId}
                              <input
                                type="text"
                                value={baseQuestionDraft.options[optionId]}
                                onChange={(event) =>
                                  setBaseQuestionDraft((draft) => ({
                                    ...draft,
                                    options: {
                                      ...draft.options,
                                      [optionId]: event.target.value,
                                    },
                                  }))
                                }
                                disabled={savingBaseQuestion}
                              />
                            </label>
                          ))}

                          <fieldset>
                            <legend>Respuesta correcta</legend>

                            <div className="correct-answer-options">
                              {baseQuestionOptionIds.map((optionId) => (
                                <label key={optionId}>
                                  <input
                                    type="radio"
                                    name="base-question-correct-answer"
                                    value={optionId}
                                    checked={
                                      baseQuestionDraft.correctAnswer === optionId
                                    }
                                    onChange={() =>
                                      setBaseQuestionDraft((draft) => ({
                                        ...draft,
                                        correctAnswer: optionId,
                                      }))
                                    }
                                    disabled={savingBaseQuestion}
                                  />
                                  {optionId}
                                </label>
                              ))}
                            </div>
                          </fieldset>

                          <div className="question-form-actions">
                            <button
                              type="submit"
                              disabled={savingBaseQuestion}
                            >
                              {savingBaseQuestion
                                ? 'Guardando...'
                                : 'Guardar pregunta'}
                            </button>

                            <button
                              type="button"
                              onClick={() => {
                                setBaseQuestionDraft(
                                  createEmptyBaseQuestionDraft()
                                )
                                setBaseQuestionFormOpen(false)
                                setBaseQuestionsMessage('')
                              }}
                              disabled={savingBaseQuestion}
                            >
                              Cancelar
                            </button>
                          </div>
                        </form>
                      )}

                    {baseQuestionsMessage && (
                      <p className="questions-message" role="status">
                        {baseQuestionsMessage}
                      </p>
                    )}

                    {selectedBaseQuestionsLoadStatus === 'loading' ? (
                      <p className="empty-state">Cargando preguntas...</p>
                    ) : selectedBaseQuestionsLoadStatus === 'error' ? (
                      <p className="empty-state">
                        No fue posible cargar las preguntas.
                      </p>
                    ) : selectedBaseQuestionsLoadStatus === 'success' &&
                      baseQuestions.length === 0 ? (
                      <p className="empty-state">
                        No hay preguntas base todavía.
                      </p>
                    ) : selectedBaseQuestionsLoadStatus === 'success' ? (
                      <ol className="base-question-list">
                        {questionGroups.map(({ baseQuestion, variants }) => (
                          <li key={baseQuestion.id}>
                            <h3>Pregunta {baseQuestion.slot_number}</h3>
                            <p>
                              {variants.length}/6 variantes preparadas
                            </p>

                            {variants.map((question) => (
                              <article
                                className="question-variant"
                                key={question.id}
                              >
                                <h4>
                                  {question.variant_number === 1
                                    ? 'Pregunta base'
                                    : `Variante ${question.variant_number}`}
                                </h4>

                                {editingQuestionId === question.id ? (
                                  <form
                                    className="base-question-form"
                                    onSubmit={(event) =>
                                      handleSaveQuestionEdit(event, question)
                                    }
                                  >
                                    <label>
                                      Enunciado
                                      <textarea
                                        value={questionEditDraft.statement}
                                        onChange={(event) =>
                                          setQuestionEditDraft((draft) => ({
                                            ...draft,
                                            statement: event.target.value,
                                          }))
                                        }
                                        rows="4"
                                        disabled={savingQuestionId === question.id}
                                      />
                                    </label>

                                    {baseQuestionOptionIds.map((optionId) => (
                                      <label key={optionId}>
                                        Opción {optionId}
                                        <input
                                          type="text"
                                          value={
                                            questionEditDraft.options[optionId]
                                          }
                                          onChange={(event) =>
                                            setQuestionEditDraft((draft) => ({
                                              ...draft,
                                              options: {
                                                ...draft.options,
                                                [optionId]: event.target.value,
                                              },
                                            }))
                                          }
                                          disabled={
                                            savingQuestionId === question.id
                                          }
                                        />
                                      </label>
                                    ))}

                                    <fieldset>
                                      <legend>Respuesta correcta</legend>
                                      <div className="correct-answer-options">
                                        {baseQuestionOptionIds.map((optionId) => (
                                          <label key={optionId}>
                                            <input
                                              type="radio"
                                              name={`question-correct-${question.id}`}
                                              value={optionId}
                                              checked={
                                                questionEditDraft.correctAnswer ===
                                                optionId
                                              }
                                              onChange={() =>
                                                setQuestionEditDraft((draft) => ({
                                                  ...draft,
                                                  correctAnswer: optionId,
                                                }))
                                              }
                                              disabled={
                                                savingQuestionId === question.id
                                              }
                                            />
                                            {optionId}
                                          </label>
                                        ))}
                                      </div>
                                    </fieldset>

                                    <div className="question-form-actions">
                                      <button
                                        type="submit"
                                        disabled={
                                          savingQuestionId === question.id
                                        }
                                      >
                                        {savingQuestionId === question.id
                                          ? 'Guardando...'
                                          : 'Guardar cambios'}
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setEditingQuestionId(null)
                                          setQuestionEditDraft(
                                            createEmptyBaseQuestionDraft()
                                          )
                                          setBaseQuestionsMessage('')
                                        }}
                                        disabled={
                                          savingQuestionId === question.id
                                        }
                                      >
                                        Cancelar
                                      </button>
                                    </div>
                                  </form>
                                ) : (
                                  <>
                                    <p>{question.statement}</p>

                                    {question.question_type ===
                                      'multiple_choice' &&
                                      Array.isArray(question.options) && (
                                        <ul className="base-question-options">
                                          {question.options.map((option) => (
                                            <li key={option.id}>
                                              <strong>{option.id}.</strong>{' '}
                                              {option.text}
                                              {question.correct_answer
                                                ?.selected_option ===
                                                option.id && (
                                                <span> (correcta)</span>
                                              )}
                                            </li>
                                          ))}
                                        </ul>
                                      )}

                                    {isSelectedEvaluationEditable && (
                                      <div className="question-variant-actions">
                                        <button
                                          type="button"
                                          onClick={() =>
                                            handleStartQuestionEdit(question)
                                          }
                                          disabled={
                                            generatingQuestionId !== null ||
                                            savingQuestionId !== null ||
                                            publishingQuiz
                                          }
                                        >
                                          Editar variante
                                        </button>

                                        {question.variant_number > 1 && (
                                          <button
                                            type="button"
                                            onClick={() =>
                                              handleGenerateVariants(
                                                question,
                                                true
                                              )
                                            }
                                            disabled={
                                              generatingQuestionId !== null ||
                                              savingQuestionId !== null ||
                                              publishingQuiz
                                            }
                                          >
                                            {generatingQuestionId === question.id
                                              ? 'Regenerando...'
                                              : 'Regenerar variante'}
                                          </button>
                                        )}
                                      </div>
                                    )}
                                  </>
                                )}
                              </article>
                            ))}

                            {isSelectedEvaluationEditable &&
                              variants.length === 1 && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleGenerateVariants(baseQuestion)
                                  }
                                  disabled={
                                    generatingQuestionId !== null ||
                                    savingQuestionId !== null ||
                                    publishingQuiz
                                  }
                                >
                                  {generatingQuestionId === baseQuestion.id
                                    ? 'Generando 5 variantes...'
                                    : 'Generar variantes'}
                                </button>
                              )}
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p className="empty-state">
                        Preparando preguntas...
                      </p>
                    )}
                  </section>
                )}

              {selectedQuiz &&
                isSelectedEvaluationOwner && (
                  <section
                    className="results-section"
                    aria-labelledby="results-heading"
                  >
                    <div className="results-header">
                      <div>
                        <h2 id="results-heading">Resultados</h2>
                        <p>
                          {quizResults.length}{' '}
                          {quizResults.length === 1
                            ? 'intento registrado'
                            : 'intentos registrados'}
                        </p>
                      </div>

                      <button
                        type="button"
                        onClick={() => loadQuizResults(selectedQuiz.id)}
                        disabled={quizResultsState.status === 'loading'}
                      >
                        {quizResultsState.status === 'loading'
                          ? 'Actualizando...'
                          : 'Actualizar resultados'}
                      </button>
                    </div>

                    {quizResultsState.status === 'error' ? (
                      <p role="alert">
                        Error cargando resultados:{' '}
                        {quizResultsState.error}
                      </p>
                    ) : quizResultsState.status === 'loading' &&
                      quizResults.length === 0 ? (
                      <p className="empty-state">Cargando resultados...</p>
                    ) : quizResults.length === 0 ? (
                      <p className="empty-state">
                        Todavía no hay intentos para esta evaluación.
                      </p>
                    ) : (
                      <div className="results-table-wrapper">
                        <table className="results-table">
                          <thead>
                            <tr>
                              <th>Participante</th>
                              <th>Intento</th>
                              <th>Estado</th>
                              <th>Puntaje</th>
                              <th>Nota</th>
                              <th>Incidencias</th>
                              <th>Detalle</th>
                              <th>Nuevo intento</th>
                            </tr>
                          </thead>
                          <tbody>
                            {quizResults.map((result) => (
                              <tr key={result.attempt_id}>
                                <td>
                                  <strong>{result.student_name}</strong>
                                  <small>{result.student_email}</small>
                                </td>
                                <td>{result.attempt_number}</td>
                                <td>
                                  {attemptStatusLabels[
                                    result.attempt_status
                                  ] ?? result.attempt_status}
                                </td>
                                <td>
                                  {result.score_points ?? 'Pendiente'}
                                </td>
                                <td>{result.grade ?? 'Pendiente'}</td>
                                <td>{result.focus_violation_count}</td>
                                <td>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleLoadAttemptResultDetail(
                                        result.attempt_id
                                      )
                                    }
                                    disabled={
                                      attemptResultDetailState.status ===
                                        'loading' &&
                                      selectedResultAttemptId ===
                                        result.attempt_id
                                    }
                                  >
                                    {attemptResultDetailState.status ===
                                      'loading' &&
                                    selectedResultAttemptId ===
                                      result.attempt_id
                                      ? 'Cargando...'
                                      : 'Ver detalle'}
                                  </button>
                                </td>
                                <td>
                                  {result.new_attempt_authorization_pending ? (
                                    <span>Autorizado</span>
                                  ) : result.attempt_number ===
                                      latestAttemptNumberByStudent.get(
                                        result.student_id
                                      ) &&
                                    [
                                      'submitted',
                                      'graded',
                                      'expired',
                                      'blocked',
                                    ].includes(result.attempt_status) ? (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setAuthorizingAttemptId(
                                          result.attempt_id
                                        )
                                        setNewAttemptReason('')
                                        setNewAttemptAuthorizationMessage('')
                                      }}
                                      disabled={authorizingNewAttempt}
                                    >
                                      Autorizar nuevo intento
                                    </button>
                                  ) : (
                                    <span>—</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {authorizingAttemptId && (
                      <form
                        className="new-attempt-form"
                        onSubmit={handleAuthorizeNewAttempt}
                      >
                        <h3>Confirmar nuevo intento</h3>
                        <p>
                          Se conservará el historial anterior y la autorización
                          solo podrá usarse una vez.
                        </p>
                        <label>
                          Motivo (opcional)
                          <textarea
                            value={newAttemptReason}
                            onChange={(event) =>
                              setNewAttemptReason(event.target.value)
                            }
                            rows="3"
                            disabled={authorizingNewAttempt}
                          />
                        </label>
                        <div className="question-form-actions">
                          <button
                            type="submit"
                            disabled={authorizingNewAttempt}
                          >
                            {authorizingNewAttempt
                              ? 'Autorizando...'
                              : 'Confirmar autorización'}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setAuthorizingAttemptId(null)
                              setNewAttemptReason('')
                              setNewAttemptAuthorizationMessage('')
                            }}
                            disabled={authorizingNewAttempt}
                          >
                            Cancelar
                          </button>
                        </div>
                      </form>
                    )}

                    {newAttemptAuthorizationMessage && (
                      <p role="status">
                        {newAttemptAuthorizationMessage}
                      </p>
                    )}

                    {selectedResultAttemptId && (
                      <div className="result-detail">
                        <div className="results-header">
                          <h3>Detalle del intento</h3>
                          <button
                            type="button"
                            onClick={() => {
                              attemptResultDetailLoadIdRef.current += 1
                              setSelectedResultAttemptId(null)
                              setAttemptResultDetail([])
                              setAttemptResultDetailState({
                                attemptId: null,
                                status: 'idle',
                                error: '',
                              })
                            }}
                          >
                            Cerrar detalle
                          </button>
                        </div>

                        {attemptResultDetailState.status === 'error' ? (
                          <p role="alert">
                            Error cargando el detalle:{' '}
                            {attemptResultDetailState.error}
                          </p>
                        ) : attemptResultDetailState.status === 'loading' ? (
                          <p className="empty-state">Cargando detalle...</p>
                        ) : attemptResultDetail.length === 0 ? (
                          <p className="empty-state">
                            El intento no tiene respuestas asignadas.
                          </p>
                        ) : (
                          <ol className="result-response-list">
                            {attemptResultDetail.map((response) => (
                              <li key={response.response_id}>
                                <h4>
                                  Pregunta {response.slot_number} · Variante{' '}
                                  {response.variant_number}
                                </h4>
                                <p>{response.question_statement}</p>
                                <dl>
                                  <div>
                                    <dt>Respuesta</dt>
                                    <dd>
                                      {formatAnswerPayload(
                                        response.answer_payload
                                      )}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>Correcta</dt>
                                    <dd>
                                      {formatAnswerPayload(
                                        response.correct_answer
                                      )}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>Puntaje</dt>
                                    <dd>{response.score ?? 'Pendiente'}</dd>
                                  </div>
                                  <div>
                                    <dt>Estado</dt>
                                    <dd>
                                      {attemptStatusLabels[
                                        response.response_status
                                      ] ?? response.response_status}
                                    </dd>
                                  </div>
                                </dl>
                                {response.feedback && (
                                  <p>{response.feedback}</p>
                                )}
                              </li>
                            ))}
                          </ol>
                        )}
                      </div>
                    )}
                  </section>
                )}

              {selectedCourse &&
                isSelectedCourseOwner && (
                  <section
                    className="participants-section"
                    aria-labelledby="participants-heading"
                  >
                    <h2 id="participants-heading">
                      Participantes
                    </h2>

                    <p className="participants-count">
                      {authorizedEmails.length}{' '}
                      {authorizedEmails.length === 1
                        ? 'correo autorizado'
                        : 'correos autorizados'}
                    </p>

                    <label className="participants-input">
                      <span>
                        Correos, o filas con nombre y correo
                      </span>

                      <textarea
                        value={participantsInput}
                        onChange={(event) => {
                          setParticipantsInput(event.target.value)
                          setParticipantsPreview(null)
                          setParticipantsMessage('')
                        }}
                        rows="5"
                        placeholder="Ana Torres&#9;ana@ejemplo.com&#10;luis@ejemplo.com"
                        disabled={
                          addingAuthorizedEmails ||
                          deletingAuthorizedEmailId !== null
                        }
                      />
                    </label>

                    <button
                      type="button"
                      onClick={handlePreviewAuthorizedEmails}
                      disabled={
                        addingAuthorizedEmails ||
                        loadingAuthorizedEmails ||
                        deletingAuthorizedEmailId !== null
                      }
                    >
                      Previsualizar participantes
                    </button>

                    {participantsPreview && (
                      <div className="participants-preview">
                        <h3>Previsualización</h3>

                        {participantsPreview.rows.length > 0 ? (
                          <ul>
                            {participantsPreview.rows.map((participant) => (
                              <li key={participant.email}>
                                <span>
                                  {participant.participantName || 'Sin nombre'}
                                </span>
                                <strong>{participant.email}</strong>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="empty-state">
                            No hay filas válidas para confirmar.
                          </p>
                        )}

                        {participantsPreview.invalidEntries.length > 0 && (
                          <p>
                            Revisa:{' '}
                            {participantsPreview.invalidEntries.join(' · ')}
                          </p>
                        )}

                        <button
                          type="button"
                          onClick={handleAddAuthorizedEmails}
                          disabled={
                            addingAuthorizedEmails ||
                            participantsPreview.rows.length === 0
                          }
                        >
                          {addingAuthorizedEmails
                            ? 'Agregando...'
                            : `Confirmar ${participantsPreview.rows.length} ${
                                participantsPreview.rows.length === 1
                                  ? 'participante'
                                  : 'participantes'
                              }`}
                        </button>
                      </div>
                    )}

                    {participantsMessage && (
                      <p
                        className="participants-message"
                        role="status"
                      >
                        {participantsMessage}
                      </p>
                    )}

                    {loadingAuthorizedEmails ? (
                      <p className="empty-state">
                        Cargando participantes...
                      </p>
                    ) : authorizedEmails.length === 0 ? (
                      <p className="empty-state">
                        No hay correos autorizados todavía.
                      </p>
                    ) : (
                      <ul className="participants-list">
                        {authorizedEmails.map((authorizedEmail) => (
                          <li key={authorizedEmail.id}>
                            <span>
                              {authorizedEmail.participant_name && (
                                <strong>
                                  {authorizedEmail.participant_name}
                                </strong>
                              )}
                              {authorizedEmail.email}
                            </span>

                            <button
                              type="button"
                              onClick={() =>
                                handleDeleteAuthorizedEmail(
                                  authorizedEmail
                                )
                              }
                              disabled={
                                addingAuthorizedEmails ||
                                loadingAuthorizedEmails ||
                                deletingAuthorizedEmailId !== null
                              }
                            >
                              {deletingAuthorizedEmailId ===
                              authorizedEmail.id
                                ? 'Eliminando...'
                                : 'Eliminar'}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                )}
            </>
          )}

          {quizSession &&
            isSelectedEvaluationOwner && (
              <section>
               <h2>Sesión presencial activa</h2>

                  <p>
                    <strong>{selectedCourse?.nickname}</strong>
                  </p>

                  <p>
                    Evaluación: <strong>{selectedQuiz?.title}</strong>
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


                {liveSessionStatusError ? (
                  <p role="alert">
                    Error actualizando la sesión: {liveSessionStatusError}
                  </p>
                ) : liveSessionStatus ? (
                  <dl className="live-session-metrics">
                    <div>
                      <dt>Autorizados</dt>
                      <dd>{liveSessionStatus.authorized_participants}</dd>
                    </div>
                    <div>
                      <dt>Ingresaron</dt>
                      <dd>{liveSessionStatus.participants_entered}</dd>
                    </div>
                    <div>
                      <dt>Dispositivos activos</dt>
                      <dd>{liveSessionStatus.active_devices}</dd>
                    </div>
                    <div>
                      <dt>En curso</dt>
                      <dd>{liveSessionStatus.attempts_in_progress}</dd>
                    </div>
                    <div>
                      <dt>Finalizados</dt>
                      <dd>{liveSessionStatus.attempts_finished}</dd>
                    </div>
                    <div>
                      <dt>Bloqueados</dt>
                      <dd>{liveSessionStatus.attempts_blocked}</dd>
                    </div>
                  </dl>
                ) : (
                  <p className="empty-state">
                    Cargando seguimiento en vivo...
                  </p>
                )}

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
                Resultado de la evaluación
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
                      El tiempo disponible para esta evaluación terminó.
                      Ya no es posible enviar respuestas.
                    </p>

                    {attemptResult.details_status === 'loading' ? (
                      <p>Recuperando la calificación...</p>
                    ) : attemptResult.details_status === 'error' ? (
                      <p>
                        No fue posible recuperar la calificación
                        persistida. Intenta recargar la página.
                      </p>
                    ) : attemptResult.grade === null ||
                      attemptResult.grade === undefined ||
                      attemptResult.score_points === null ||
                      attemptResult.score_points === undefined ? (
                      <p>
                        La calificación todavía no está disponible.
                      </p>
                    ) : (
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
                    )}
                  </>
                ) : (
              <p>
                Tu evaluación fue entregada.
                La calificación definitiva está pendiente.
              </p>
            )}
            </section>
          )}

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
        para finalizar la evaluación.
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

      <div>
        <button
          type="button"
          onClick={() => {
            setAuthMode('login')
            setMessage('')
          }}
          disabled={authMode === 'login'}
        >
          Iniciar sesión
        </button>

        <button
          type="button"
          onClick={() => {
            setAuthMode('signup')
            setMessage('')
          }}
          disabled={authMode === 'signup'}
        >
          Crear cuenta
        </button>
      </div>

      <h2>
        {authMode === 'login'
          ? 'Iniciar sesión'
          : 'Crear cuenta'}
      </h2>

      <form
        onSubmit={
          authMode === 'login'
            ? handleLogin
            : handleSignUp
        }
      >
        {authMode === 'signup' && (
          <div>
            <label>
              Nombre

              <input
                type="text"
                value={fullName}
                onChange={(event) =>
                  setFullName(
                    event.target.value
                  )
                }
                autoComplete="name"
                required
              />
            </label>
          </div>
        )}

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
              autoComplete="email"
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
              autoComplete={
                authMode === 'login'
                  ? 'current-password'
                  : 'new-password'
              }
              required
            />
          </label>
        </div>

        <button type="submit">
          {authMode === 'login'
            ? 'Ingresar'
            : 'Crear cuenta'}
        </button>
      </form>

      <p>o</p>

      <button
        type="button"
        onClick={handleGoogleSignIn}
      >
        Continuar con Google
      </button>

      {message && (
        <p>{message}</p>
      )}
    </main>
  )
}

export default App
