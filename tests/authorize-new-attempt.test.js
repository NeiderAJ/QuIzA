import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupLocalTestContext,
  createAdditionalStudentSession,
  createAttemptFixture,
  createLocalTestContext,
} from './helpers/localSupabase.js'

let context

describe('autorización auditada de un nuevo intento', () => {
  beforeAll(async () => {
    context = await createLocalTestContext()
  })

  afterAll(async () => {
    await cleanupLocalTestContext(context)
  })

  it('conserva el historial y consume una sola autorización bajo concurrencia', async () => {
    const fixture = await createAttemptFixture(context, {
      numberOfSlots: 1,
      expiredDeadline: false,
    })

    const activeAuthorization = await context.teacher.rpc(
      'authorize_new_attempt',
      {
        p_previous_attempt_id: fixture.attemptId,
        p_reason: 'No debe aceptarse mientras está activo',
      }
    )
    const unauthorized = await context.student.rpc('authorize_new_attempt', {
      p_previous_attempt_id: fixture.attemptId,
      p_reason: 'Intento del estudiante',
    })

    expect(activeAuthorization.error).not.toBeNull()
    expect(unauthorized.error).not.toBeNull()

    const answer = await context.student.rpc('submit_response', {
      p_response_id: fixture.assignedResponseId,
      p_answer_payload: { selected_option: 'A' },
    })
    const submission = await context.student.rpc('submit_quiz_attempt', {
      p_attempt_id: fixture.attemptId,
    })
    const session = await context.teacher.rpc('create_quiz_session', {
      p_quiz_id: fixture.quizId,
      p_access_minutes: 5,
    })

    expect(answer.error).toBeNull()
    expect(submission.error).toBeNull()
    expect(session.error).toBeNull()

    const qrToken = session.data[0].qr_token
    const rejectedJoin = await context.student.rpc('join_quiz_session', {
      p_qr_token: qrToken,
    })

    expect(rejectedJoin.error).not.toBeNull()

    const authorization = await context.teacher.rpc(
      'authorize_new_attempt',
      {
        p_previous_attempt_id: fixture.attemptId,
        p_reason: 'Interrupción técnica verificada',
      }
    )
    const duplicateAuthorization = await context.teacher.rpc(
      'authorize_new_attempt',
      {
        p_previous_attempt_id: fixture.attemptId,
        p_reason: 'No debe duplicarse',
      }
    )

    expect(authorization.error).toBeNull()
    expect(authorization.data).toHaveLength(1)
    expect(duplicateAuthorization.error).not.toBeNull()

    const resultsBeforeUse = await context.teacher.rpc('get_quiz_results', {
      p_quiz_id: fixture.quizId,
    })

    expect(resultsBeforeUse.error).toBeNull()
    expect(resultsBeforeUse.data[0]).toMatchObject({
      attempt_id: fixture.attemptId,
      attempt_number: 1,
      new_attempt_authorization_pending: true,
    })

    const joins = await Promise.all([
      context.student.rpc('join_quiz_session', { p_qr_token: qrToken }),
      context.student.rpc('join_quiz_session', { p_qr_token: qrToken }),
    ])

    expect(joins[0].error).toBeNull()
    expect(joins[1].error).toBeNull()
    expect(joins[0].data[0].attempt_id).toBe(joins[1].data[0].attempt_id)
    expect(joins[0].data[0].attempt_id).not.toBe(fixture.attemptId)

    const newAttemptId = joins[0].data[0].attempt_id
    const [attempts, authorizations] = await Promise.all([
      context.service
        .from('attempts')
        .select('id, attempt_number, status, active_session_id')
        .eq('quiz_id', fixture.quizId)
        .eq('student_id', context.studentId)
        .order('attempt_number'),
      context.service
        .from('attempt_authorizations')
        .select(`
          previous_attempt_id,
          new_attempt_id,
          authorized_by,
          reason,
          used_at
        `)
        .eq('quiz_id', fixture.quizId),
    ])

    expect(attempts.error).toBeNull()
    expect(attempts.data).toEqual([
      {
        id: fixture.attemptId,
        attempt_number: 1,
        status: 'graded',
        active_session_id: context.sessionId,
      },
      {
        id: newAttemptId,
        attempt_number: 2,
        status: 'in_progress',
        active_session_id: context.sessionId,
      },
    ])
    expect(authorizations.error).toBeNull()
    expect(authorizations.data).toHaveLength(1)
    expect(authorizations.data[0]).toMatchObject({
      previous_attempt_id: fixture.attemptId,
      new_attempt_id: newAttemptId,
      authorized_by: context.teacherId,
      reason: 'Interrupción técnica verificada',
    })
    expect(authorizations.data[0].used_at).not.toBeNull()

    const secondSession = await createAdditionalStudentSession(context)

    try {
      const foreignJoin = await secondSession.student.rpc(
        'join_quiz_session',
        { p_qr_token: qrToken }
      )

      expect(foreignJoin.error).not.toBeNull()
    } finally {
      await secondSession.student.auth.signOut()
    }
  })
})
