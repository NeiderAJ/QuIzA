import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupLocalTestContext,
  createAttemptFixture,
  createLocalTestContext,
} from './helpers/localSupabase.js'

let context

describe('incidencias de integridad', () => {
  beforeAll(async () => {
    context = await createLocalTestContext()
  })

  afterAll(async () => {
    await cleanupLocalTestContext(context)
  })

  it('permite cinco reemplazos, bloquea en el sexto y cierra el intento', async () => {
    const fixture = await createAttemptFixture(context, {
      numberOfSlots: 1,
      expiredDeadline: false,
    })
    const eventTypes = [
      'blur',
      'visibility_hidden',
      'fullscreen_exit',
      'reload',
      'visibility_hidden',
    ]
    const shownQuestionIds = new Set()
    let activeResponseId = fixture.assignedResponseId

    const initialResponse = await context.service
      .from('responses')
      .select('question_id')
      .eq('id', fixture.assignedResponseId)
      .single()

    expect(initialResponse.error).toBeNull()
    shownQuestionIds.add(initialResponse.data.question_id)

    for (const [index, eventType] of eventTypes.entries()) {
      const replacement = await context.student.rpc(
        'replace_question_on_focus_loss',
        {
          p_attempt_id: fixture.attemptId,
          p_event_type: eventType,
        }
      )

      expect(replacement.error).toBeNull()
      expect(replacement.data).toHaveLength(1)
      expect(replacement.data[0]).toMatchObject({
        focus_violation_count: index + 1,
        attempt_status: 'in_progress',
      })
      expect(replacement.data[0].response_id).not.toBeNull()
      expect(shownQuestionIds.has(replacement.data[0].question_id)).toBe(false)

      shownQuestionIds.add(replacement.data[0].question_id)
      activeResponseId = replacement.data[0].response_id
    }

    expect(shownQuestionIds).toHaveLength(6)

    const blockingIncident = await context.student.rpc(
      'replace_question_on_focus_loss',
      {
        p_attempt_id: fixture.attemptId,
        p_event_type: 'blur',
      }
    )

    expect(blockingIncident.error).toBeNull()
    expect(blockingIncident.data).toEqual([
      expect.objectContaining({
        response_id: null,
        question_id: null,
        focus_violation_count: 6,
        attempt_status: 'blocked',
      }),
    ])

    const [attempt, responses, events] = await Promise.all([
      context.service
        .from('attempts')
        .select('status, focus_violation_count, current_question_id')
        .eq('id', fixture.attemptId)
        .single(),
      context.service
        .from('responses')
        .select('status')
        .eq('attempt_id', fixture.attemptId),
      context.service
        .from('focus_events')
        .select('event_type, metadata')
        .eq('attempt_id', fixture.attemptId)
        .order('occurred_at'),
    ])

    expect(attempt.error).toBeNull()
    expect(attempt.data).toEqual({
      status: 'blocked',
      focus_violation_count: 6,
      current_question_id: null,
    })
    expect(responses.error).toBeNull()
    expect(responses.data).toHaveLength(6)
    expect(responses.data.every(({ status }) => status === 'invalidated')).toBe(
      true
    )
    expect(events.error).toBeNull()
    expect(events.data).toHaveLength(6)
    expect(events.data.slice(0, 5).every(
      ({ metadata }) => metadata.action === 'question_replaced'
    )).toBe(true)
    expect(events.data[5]).toMatchObject({
      event_type: 'blur',
      metadata: {
        action: 'attempt_blocked',
        limit: 5,
        count: 6,
      },
    })
    expect(JSON.stringify(events.data)).not.toMatch(/fraud|trampa/i)

    const [answerAfterBlock, questionAfterBlock, heartbeatAfterBlock] =
      await Promise.all([
        context.student.rpc('submit_response', {
          p_response_id: activeResponseId,
          p_answer_payload: { selected_option: 'A' },
        }),
        context.student.rpc('get_current_question', {
          p_attempt_id: fixture.attemptId,
        }),
        context.student.rpc('heartbeat_quiz_attempt', {
          p_attempt_id: fixture.attemptId,
        }),
      ])

    expect(answerAfterBlock.error).not.toBeNull()
    expect(questionAfterBlock.error).not.toBeNull()
    expect(heartbeatAfterBlock.error).not.toBeNull()
  })
})
