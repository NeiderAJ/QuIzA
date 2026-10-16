import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupLocalTestContext,
  createAttemptFixture,
  createLocalTestContext,
  readAttempt,
} from './helpers/localSupabase.js'

let context

async function expectPersistedExpired(attemptId) {
  const persisted = await readAttempt(context, attemptId)

  expect(persisted.status).toBe('expired')
  expect(Number(persisted.score_points)).toBe(1)
  expect(Number(persisted.grade)).toBe(2.5)
  expect(persisted.expired_at).not.toBeNull()

  return persisted
}

describe('expired contra Supabase local', () => {
  beforeAll(async () => {
    context = await createLocalTestContext()
  })

  afterAll(async () => {
    await cleanupLocalTestContext(context)
  })

  it('expira durante el envío y rechaza respuestas posteriores', async () => {
    const fixture = await createAttemptFixture(context)

    const firstSubmission = await context.student.rpc('submit_response', {
      p_response_id: fixture.assignedResponseId,
      p_answer_payload: { selected_option: 'A' },
    })

    expect(firstSubmission.error).toBeNull()
    expect(firstSubmission.data?.[0]?.status).toBe('expired')
    await expectPersistedExpired(fixture.attemptId)

    const secondSubmission = await context.student.rpc('submit_response', {
      p_response_id: fixture.assignedResponseId,
      p_answer_payload: { selected_option: 'A' },
    })

    expect(secondSubmission.error).toBeNull()
    expect(secondSubmission.data?.[0]?.status).toBe('expired')

    const { data: response, error: responseError } = await context.service
      .from('responses')
      .select('status, answer_payload, score')
      .eq('id', fixture.assignedResponseId)
      .single()

    expect(responseError).toBeNull()
    expect(response.status).toBe('invalidated')
    expect(response.answer_payload).toBeNull()
    expect(response.score).toBeNull()
  })

  it('expira durante el heartbeat', async () => {
    const fixture = await createAttemptFixture(context)

    const heartbeat = await context.student.rpc('heartbeat_quiz_attempt', {
      p_attempt_id: fixture.attemptId,
    })

    expect(heartbeat.error).toBeNull()
    expect(heartbeat.data).toBeNull()
    await expectPersistedExpired(fixture.attemptId)
  })

  it('expira durante la entrega final de un intento incompleto', async () => {
    const fixture = await createAttemptFixture(context)

    const submission = await context.student.rpc('submit_quiz_attempt', {
      p_attempt_id: fixture.attemptId,
    })

    expect(submission.error).toBeNull()
    expect(submission.data?.[0]?.attempt_status).toBe('expired')
    await expectPersistedExpired(fixture.attemptId)
  })

  it('serializa envío, heartbeat y entrega concurrentes', async () => {
    const fixture = await createAttemptFixture(context)

    const [answer, heartbeat, submission] = await Promise.all([
      context.student.rpc('submit_response', {
        p_response_id: fixture.assignedResponseId,
        p_answer_payload: { selected_option: 'A' },
      }),
      context.student.rpc('heartbeat_quiz_attempt', {
        p_attempt_id: fixture.attemptId,
      }),
      context.student.rpc('submit_quiz_attempt', {
        p_attempt_id: fixture.attemptId,
      }),
    ])

    expect(answer.error).toBeNull()
    expect(answer.data?.[0]?.status).toBe('expired')
    expect(heartbeat.error).toBeNull()
    expect(heartbeat.data).toBeNull()
    expect(submission.error).toBeNull()
    expect(submission.data?.[0]?.attempt_status).toBe('expired')
    await expectPersistedExpired(fixture.attemptId)
  })

  it('mantiene la finalización normal de un intento vigente', async () => {
    const fixture = await createAttemptFixture(context, {
      numberOfSlots: 1,
      expiredDeadline: false,
    })

    const answer = await context.student.rpc('submit_response', {
      p_response_id: fixture.assignedResponseId,
      p_answer_payload: { selected_option: 'A' },
    })

    expect(answer.error).toBeNull()
    expect(answer.data?.[0]?.status).toBe('graded')
    expect(Number(answer.data?.[0]?.score)).toBe(1)

    const submission = await context.student.rpc('submit_quiz_attempt', {
      p_attempt_id: fixture.attemptId,
    })

    expect(submission.error).toBeNull()
    expect(submission.data?.[0]?.attempt_status).toBe('graded')

    const persisted = await readAttempt(context, fixture.attemptId)
    expect(persisted.status).toBe('graded')
    expect(Number(persisted.score_points)).toBe(1)
    expect(Number(persisted.grade)).toBe(5)
    expect(persisted.expired_at).toBeNull()
  })
})
