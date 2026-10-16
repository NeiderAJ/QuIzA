import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupLocalTestContext,
  createLocalTestContext,
  createQuizWithVariants,
} from './helpers/localSupabase.js'

let context

function createUnsignedClient() {
  return createClient(context.url, context.anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}

async function signUpParticipant(email) {
  const client = createUnsignedClient()
  const password = `Quiza-${randomUUID()}-Aa1!`
  const result = await client.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: `Participante ${email}` },
    },
  })

  expect(result.error).toBeNull()
  expect(result.data.session).not.toBeNull()
  return client
}

describe('registro posterior a la autorización QRR', () => {
  beforeAll(async () => {
    context = await createLocalTestContext()
  })

  afterAll(async () => {
    await cleanupLocalTestContext(context)
  })

  it('vincula el correo preautorizado y separa acceso QRR de duración', async () => {
    const fixture = await createQuizWithVariants(context)
    const publish = await context.teacher.rpc('publish_quiz', {
      p_quiz_id: fixture.quizId,
    })
    const authorizedEmail = `autorizado-${randomUUID()}@example.test`
    const unauthorizedEmail = `no-autorizado-${randomUUID()}@example.test`
    const authorization = await context.teacher
      .from('course_authorized_emails')
      .insert({
        course_id: context.courseId,
        email: authorizedEmail,
        participant_name: 'Persona aún no registrada',
      })
    const session = await context.teacher.rpc('create_quiz_session', {
      p_quiz_id: fixture.quizId,
      p_access_minutes: 5,
    })

    expect(publish.error).toBeNull()
    expect(authorization.error).toBeNull()
    expect(session.error).toBeNull()

    const qrToken = session.data[0].qr_token
    const authorizedParticipant = await signUpParticipant(authorizedEmail)
    const unauthorizedParticipant = await signUpParticipant(unauthorizedEmail)

    try {
      const rejected = await unauthorizedParticipant.rpc(
        'join_quiz_session',
        { p_qr_token: qrToken }
      )
      const joined = await authorizedParticipant.rpc('join_quiz_session', {
        p_qr_token: qrToken,
      })

      expect(rejected.error).not.toBeNull()
      expect(rejected.error.message).toContain('no está matriculado')
      expect(joined.error).toBeNull()
      expect(joined.data).toHaveLength(1)

      const attemptId = joined.data[0].attempt_id
      const question = await authorizedParticipant.rpc(
        'get_current_question',
        { p_attempt_id: attemptId }
      )

      expect(question.error).toBeNull()
      expect(question.data).toHaveLength(1)

      const closed = await context.teacher.rpc('close_quiz_session', {
        p_quiz_session_id: session.data[0].quiz_session_id,
      })
      const heartbeatAfterClose = await authorizedParticipant.rpc(
        'heartbeat_quiz_attempt',
        { p_attempt_id: attemptId }
      )
      const rejectedAfterClose = await unauthorizedParticipant.rpc(
        'join_quiz_session',
        { p_qr_token: qrToken }
      )

      expect(closed.error).toBeNull()
      expect(closed.data).toBe(true)
      expect(heartbeatAfterClose.error).toBeNull()
      expect(rejectedAfterClose.error).not.toBeNull()
      expect(rejectedAfterClose.error.message).toContain('QR inválido o expirado')

      const reopened = await context.teacher.rpc('create_quiz_session', {
        p_quiz_id: fixture.quizId,
        p_access_minutes: 5,
      })

      expect(reopened.error).toBeNull()

      const expiredEmail = `expirado-${randomUUID()}@example.test`
      const expiredAuthorization = await context.teacher
        .from('course_authorized_emails')
        .insert({ course_id: context.courseId, email: expiredEmail })
      const expiredParticipant = await signUpParticipant(expiredEmail)

      try {
        const { error: expireError } = await context.service
          .from('quiz_sessions')
          .update({
            starts_at: new Date(Date.now() - 120000).toISOString(),
            expires_at: new Date(Date.now() - 60000).toISOString(),
          })
          .eq('id', reopened.data[0].quiz_session_id)
        const expiredJoin = await expiredParticipant.rpc(
          'join_quiz_session',
          { p_qr_token: reopened.data[0].qr_token }
        )

        expect(expiredAuthorization.error).toBeNull()
        expect(expireError).toBeNull()
        expect(expiredJoin.error).not.toBeNull()
        expect(expiredJoin.error.message).toContain('QR inválido o expirado')
      } finally {
        await expiredParticipant.auth.signOut()
      }
    } finally {
      await authorizedParticipant.auth.signOut()
      await unauthorizedParticipant.auth.signOut()
    }
  })
})
