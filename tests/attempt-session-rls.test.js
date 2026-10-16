import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupLocalTestContext,
  createAdditionalStudentSession,
  createAttemptFixture,
  createLocalTestContext,
} from './helpers/localSupabase.js'

let context

describe('aislamiento de lectura por sesión del intento', () => {
  beforeAll(async () => {
    context = await createLocalTestContext()
  })

  afterAll(async () => {
    await cleanupLocalTestContext(context)
  })

  it('oculta un intento activo a otro login y conserva el historial terminado', async () => {
    const fixture = await createAttemptFixture(context, {
      numberOfSlots: 1,
      expiredDeadline: false,
    })

    const { error: focusEventError } = await context.service
      .from('focus_events')
      .insert({
        attempt_id: fixture.attemptId,
        event_type: 'visibility_hidden',
        metadata: { source: 'session-isolation-test' },
      })

    expect(focusEventError).toBeNull()

    const secondSession = await createAdditionalStudentSession(context)

    try {
      const [ownerAttempt, ownerResponses, ownerFocusEvents] =
        await Promise.all([
          context.student
            .from('attempts')
            .select('id')
            .eq('id', fixture.attemptId),
          context.student
            .from('responses')
            .select('id')
            .eq('attempt_id', fixture.attemptId),
          context.student
            .from('focus_events')
            .select('id')
            .eq('attempt_id', fixture.attemptId),
        ])

      expect(ownerAttempt.error).toBeNull()
      expect(ownerAttempt.data).toHaveLength(1)
      expect(ownerResponses.error).toBeNull()
      expect(ownerResponses.data).toHaveLength(1)
      expect(ownerFocusEvents.error).toBeNull()
      expect(ownerFocusEvents.data).toHaveLength(1)

      const [foreignAttempt, foreignResponses, foreignFocusEvents] =
        await Promise.all([
          secondSession.student
            .from('attempts')
            .select('id')
            .eq('id', fixture.attemptId),
          secondSession.student
            .from('responses')
            .select('id')
            .eq('attempt_id', fixture.attemptId),
          secondSession.student
            .from('focus_events')
            .select('id')
            .eq('attempt_id', fixture.attemptId),
        ])

      expect(foreignAttempt.error).toBeNull()
      expect(foreignAttempt.data).toEqual([])
      expect(foreignResponses.error).toBeNull()
      expect(foreignResponses.data).toEqual([])
      expect(foreignFocusEvents.error).toBeNull()
      expect(foreignFocusEvents.data).toEqual([])

      const foreignQuestion = await secondSession.student.rpc(
        'get_current_question',
        { p_attempt_id: fixture.attemptId }
      )

      expect(foreignQuestion.error).not.toBeNull()

      const [foreignAnswer, foreignHeartbeat, foreignIntegrityEvent] =
        await Promise.all([
          secondSession.student.rpc('submit_response', {
            p_response_id: fixture.assignedResponseId,
            p_answer_payload: { selected_option: 'A' },
          }),
          secondSession.student.rpc('heartbeat_quiz_attempt', {
            p_attempt_id: fixture.attemptId,
          }),
          secondSession.student.rpc('replace_question_on_focus_loss', {
            p_attempt_id: fixture.attemptId,
            p_event_type: 'visibility_hidden',
          }),
        ])

      expect(foreignAnswer.error).not.toBeNull()
      expect(foreignHeartbeat.error).not.toBeNull()
      expect(foreignIntegrityEvent.error).not.toBeNull()

      const answer = await context.student.rpc('submit_response', {
        p_response_id: fixture.assignedResponseId,
        p_answer_payload: { selected_option: 'A' },
      })

      expect(answer.error).toBeNull()

      const submission = await context.student.rpc('submit_quiz_attempt', {
        p_attempt_id: fixture.attemptId,
      })

      expect(submission.error).toBeNull()
      expect(submission.data?.[0]?.attempt_status).toBe('graded')

      const [historicalAttempt, historicalResponses, historicalFocusEvents] =
        await Promise.all([
          secondSession.student
            .from('attempts')
            .select('id, status')
            .eq('id', fixture.attemptId),
          secondSession.student
            .from('responses')
            .select('id')
            .eq('attempt_id', fixture.attemptId),
          secondSession.student
            .from('focus_events')
            .select('id')
            .eq('attempt_id', fixture.attemptId),
        ])

      expect(historicalAttempt.error).toBeNull()
      expect(historicalAttempt.data).toEqual([
        { id: fixture.attemptId, status: 'graded' },
      ])
      expect(historicalResponses.error).toBeNull()
      expect(historicalResponses.data).toHaveLength(1)
      expect(historicalFocusEvents.error).toBeNull()
      expect(historicalFocusEvents.data).toHaveLength(1)
    } finally {
      await secondSession.student.auth.signOut()
    }
  })
})
