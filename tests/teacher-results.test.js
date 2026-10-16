import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupLocalTestContext,
  createAttemptFixture,
  createLocalTestContext,
} from './helpers/localSupabase.js'

let context

describe('panel y resultados del evaluador', () => {
  beforeAll(async () => {
    context = await createLocalTestContext()
  })

  afterAll(async () => {
    await cleanupLocalTestContext(context)
  })

  it('muestra resultados y detalle únicamente al propietario', async () => {
    const fixture = await createAttemptFixture(context, {
      numberOfSlots: 1,
      expiredDeadline: false,
    })
    const answer = await context.student.rpc('submit_response', {
      p_response_id: fixture.assignedResponseId,
      p_answer_payload: { selected_option: 'A' },
    })
    const submission = await context.student.rpc('submit_quiz_attempt', {
      p_attempt_id: fixture.attemptId,
    })

    expect(answer.error).toBeNull()
    expect(submission.error).toBeNull()

    const results = await context.teacher.rpc('get_quiz_results', {
      p_quiz_id: fixture.quizId,
    })

    expect(results.error).toBeNull()
    expect(results.data).toHaveLength(1)
    expect(results.data[0]).toMatchObject({
      attempt_id: fixture.attemptId,
      student_id: context.studentId,
      attempt_status: 'graded',
    })
    expect(Number(results.data[0].grade)).toBe(5)

    const detail = await context.teacher.rpc('get_attempt_result_detail', {
      p_attempt_id: fixture.attemptId,
    })

    expect(detail.error).toBeNull()
    expect(detail.data).toHaveLength(1)
    expect(detail.data[0]).toMatchObject({
      response_id: fixture.assignedResponseId,
      slot_number: 1,
      variant_number: 1,
      response_status: 'graded',
      answer_payload: { selected_option: 'A' },
      correct_answer: { selected_option: 'A' },
    })

    const unauthorizedResults = await context.student.rpc(
      'get_quiz_results',
      { p_quiz_id: fixture.quizId }
    )

    expect(unauthorizedResults.error).not.toBeNull()
  })

  it('calcula los cinco estados operativos de una sesión presencial', async () => {
    const fixture = await createAttemptFixture(context, {
      numberOfSlots: 1,
      expiredDeadline: false,
    })
    const session = await context.teacher.rpc('create_quiz_session', {
      p_quiz_id: fixture.quizId,
      p_access_minutes: 5,
    })

    expect(session.error).toBeNull()

    const sessionId = session.data[0].quiz_session_id
    const { error: authorizedError } = await context.service
      .from('course_authorized_emails')
      .insert([
        { course_id: context.courseId, email: 'uno@example.test' },
        { course_id: context.courseId, email: 'dos@example.test' },
      ])
    const { error: attemptUpdateError } = await context.service
      .from('attempts')
      .update({
        quiz_session_id: sessionId,
        last_heartbeat_at: new Date().toISOString(),
      })
      .eq('id', fixture.attemptId)

    expect(authorizedError).toBeNull()
    expect(attemptUpdateError).toBeNull()

    const live = await context.teacher.rpc('get_quiz_session_live_status', {
      p_quiz_session_id: sessionId,
    })

    expect(live.error).toBeNull()
    expect(live.data[0]).toEqual({
      authorized_participants: 2,
      participants_entered: 1,
      active_devices: 1,
      attempts_in_progress: 1,
      attempts_finished: 0,
      attempts_blocked: 0,
    })

    const { error: blockError } = await context.service
      .from('attempts')
      .update({ status: 'blocked' })
      .eq('id', fixture.attemptId)

    expect(blockError).toBeNull()

    const blockedLive = await context.teacher.rpc(
      'get_quiz_session_live_status',
      { p_quiz_session_id: sessionId }
    )

    expect(blockedLive.error).toBeNull()
    expect(blockedLive.data[0]).toMatchObject({
      participants_entered: 1,
      active_devices: 0,
      attempts_in_progress: 0,
      attempts_finished: 0,
      attempts_blocked: 1,
    })
  })
})
