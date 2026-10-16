import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const EPHEMERAL_PROJECT_PREFIX = 'quiza_ephemeral_'

function ensureLocalUrl(url) {
  const parsedUrl = new URL(url)

  if (!['127.0.0.1', 'localhost'].includes(parsedUrl.hostname)) {
    throw new Error(
      `Las pruebas rechazaron una URL de Supabase no local: ${parsedUrl.hostname}`
    )
  }
}

function assertSuccess(error, operation) {
  if (error) {
    throw new Error(`${operation}: ${error.message}`)
  }
}

function decodeJwtPayload(accessToken) {
  return JSON.parse(
    Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8')
  )
}

export async function createLocalTestContext() {
  if (process.env.TEST_SUPABASE_EPHEMERAL !== '1') {
    throw new Error(
      'Las pruebas de integración solo pueden ejecutarse mediante el entorno Supabase efímero.'
    )
  }

  const projectId = process.env.TEST_SUPABASE_PROJECT_ID
  const url = process.env.TEST_SUPABASE_URL
  const expectedApiPort = Number(process.env.TEST_SUPABASE_API_PORT)
  const anonKey = process.env.TEST_SUPABASE_ANON_KEY
  const serviceRoleKey = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY

  if (!projectId?.startsWith(EPHEMERAL_PROJECT_PREFIX)) {
    throw new Error('El project_id de pruebas no tiene la marca efímera requerida.')
  }

  if (!url || !Number.isInteger(expectedApiPort)) {
    throw new Error('No está definida la URL verificada del Supabase efímero.')
  }

  ensureLocalUrl(url)

  if (Number(new URL(url).port) !== expectedApiPort) {
    throw new Error('La URL de pruebas no coincide con el puerto efímero reservado.')
  }

  if (!anonKey || !serviceRoleKey) {
    throw new Error('No están disponibles las claves del Supabase local.')
  }

  const service = createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })

  const runId = `${Date.now()}-${randomUUID()}`
  const password = `Quiza-${randomUUID()}-Aa1!`
  const teacherEmail = `quiza-expired-teacher-${runId}@example.test`
  const studentEmail = `quiza-expired-student-${runId}@example.test`

  const { data: teacherData, error: teacherError } =
    await service.auth.admin.createUser({
      email: teacherEmail,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: 'Docente prueba expired',
      },
    })

  assertSuccess(teacherError, 'Crear docente de prueba')

  const { data: studentData, error: studentError } =
    await service.auth.admin.createUser({
      email: studentEmail,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: 'Estudiante prueba expired',
      },
    })

  assertSuccess(studentError, 'Crear estudiante de prueba')

  const teacherId = teacherData.user.id
  const studentId = studentData.user.id

  const { data: course, error: courseError } = await service
    .from('courses')
    .insert({
      teacher_id: teacherId,
      name: `Curso expired ${runId}`,
      nickname: `expired-${runId}`,
    })
    .select('id')
    .single()

  assertSuccess(courseError, 'Crear curso de prueba')

  const { error: membershipError } = await service
    .from('course_members')
    .insert({
      course_id: course.id,
      student_id: studentId,
      status: 'active',
    })

  assertSuccess(membershipError, 'Crear membresía de prueba')

  const student = createClient(url, anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })

  const { data: signInData, error: signInError } =
    await student.auth.signInWithPassword({
      email: studentEmail,
      password,
    })

  assertSuccess(signInError, 'Autenticar estudiante de prueba')

  const jwtPayload = decodeJwtPayload(signInData.session.access_token)

  if (!jwtPayload.session_id) {
    throw new Error('La sesión local no contiene session_id.')
  }

  return {
    url,
    anonKey,
    service,
    student,
    teacherId,
    studentId,
    courseId: course.id,
    sessionId: jwtPayload.session_id,
  }
}

function buildQuestion(quizId, slotNumber, variantNumber) {
  return {
    quiz_id: quizId,
    slot_number: slotNumber,
    variant_number: variantNumber,
    question_type: 'multiple_choice',
    statement: `Pregunta de prueba ${slotNumber}, variante ${variantNumber}`,
    options: [
      { id: 'A', text: `Correcta ${variantNumber}` },
      { id: 'B', text: `Distractor B ${variantNumber}` },
      { id: 'C', text: `Distractor C ${variantNumber}` },
      { id: 'D', text: `Distractor D ${variantNumber}` },
    ],
    correct_answer: {
      selected_option: 'A',
    },
    points: 1,
  }
}

export async function createAttemptFixture(
  context,
  {
    numberOfSlots = 2,
    expiredDeadline = true,
    previousGradedSlots = Array.from(
      { length: Math.max(0, numberOfSlots - 1) },
      (_, index) => index + 1
    ),
  } = {}
) {
  const quizId = randomUUID()

  const { error: quizError } = await context.service
    .from('quizzes')
    .insert({
      id: quizId,
      course_id: context.courseId,
      created_by: context.teacherId,
      title: `Evaluación expired ${quizId}`,
      status: 'published',
      duration_minutes: 1,
      grade_scale_max: 5,
      number_of_slots: numberOfSlots,
      variants_per_slot: 6,
      max_focus_violations: 5,
      delivery_mode: 'in_person',
      published_at: new Date().toISOString(),
    })

  assertSuccess(quizError, 'Crear evaluación de prueba')

  const { data: questions, error: questionsError } = await context.service
    .from('questions')
    .insert(
      Array.from({ length: numberOfSlots }, (_, index) =>
        Array.from({ length: 6 }, (_, variantIndex) =>
          buildQuestion(quizId, index + 1, variantIndex + 1)
        )
      ).flat()
    )
    .select('id, slot_number, variant_number')
    .order('slot_number')
    .order('variant_number')

  assertSuccess(questionsError, 'Crear preguntas de prueba')

  for (let slotNumber = 1; slotNumber <= numberOfSlots; slotNumber += 1) {
    const variants = questions
      .filter((question) => question.slot_number === slotNumber)
      .map((question) => question.variant_number)

    if (variants.join(',') !== '1,2,3,4,5,6') {
      throw new Error(
        `El slot ${slotNumber} no contiene exactamente las variantes 1-6.`
      )
    }
  }

  const assignedQuestions = questions.filter(
    (question) => question.variant_number === 1
  )

  const now = Date.now()
  const startedAt = new Date(now - 120000).toISOString()
  const deadlineAt = new Date(
    expiredDeadline ? now - 20000 : now + 600000
  ).toISOString()
  const currentQuestion = assignedQuestions[numberOfSlots - 1]

  const { data: attempt, error: attemptError } = await context.service
    .from('attempts')
    .insert({
      quiz_id: quizId,
      student_id: context.studentId,
      status: 'in_progress',
      current_slot: numberOfSlots,
      current_question_id: currentQuestion.id,
      active_session_id: context.sessionId,
      session_started_at: startedAt,
      last_heartbeat_at: startedAt,
      started_at: startedAt,
      deadline_at: deadlineAt,
    })
    .select('id')
    .single()

  assertSuccess(attemptError, 'Crear intento de prueba')

  const responseRows = assignedQuestions.flatMap((question, index) => {
    const isCurrentQuestion = index === assignedQuestions.length - 1

    if (isCurrentQuestion) {
      return [{
        attempt_id: attempt.id,
        question_id: question.id,
        slot_number: question.slot_number,
        status: 'assigned',
      }]
    }

    if (!previousGradedSlots.includes(question.slot_number)) {
      return []
    }

    return [{
      attempt_id: attempt.id,
      question_id: question.id,
      slot_number: question.slot_number,
      status: 'graded',
      answer_payload: {
        selected_option: 'A',
      },
      score: 1,
      grading_method: 'deterministic',
      answered_at: startedAt,
      graded_at: startedAt,
    }]
  })

  const { data: responses, error: responsesError } = await context.service
    .from('responses')
    .insert(responseRows)
    .select('id, slot_number, status')
    .order('slot_number')

  assertSuccess(responsesError, 'Crear respuestas de prueba')

  return {
    quizId,
    attemptId: attempt.id,
    assignedResponseId: responses[responses.length - 1].id,
  }
}

export async function expireAttemptDeadline(context, attemptId) {
  const { error } = await context.service
    .from('attempts')
    .update({
      deadline_at: new Date(Date.now() - 20000).toISOString(),
    })
    .eq('id', attemptId)

  assertSuccess(error, 'Vencer deadline del intento de prueba')
}

export async function readAttempt(context, attemptId) {
  const { data, error } = await context.service
    .from('attempts')
    .select('id, status, score_points, grade, expired_at')
    .eq('id', attemptId)
    .single()

  assertSuccess(error, 'Leer intento persistido')

  return data
}

export async function cleanupLocalTestContext(context) {
  if (!context) {
    return
  }

  await context.student.auth.signOut()
}
