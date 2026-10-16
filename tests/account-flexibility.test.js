import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupLocalTestContext,
  createAttemptFixture,
  createLocalTestContext,
} from './helpers/localSupabase.js'

let context

describe('cuenta sin rol académico rígido', () => {
  beforeAll(async () => {
    context = await createLocalTestContext()
  })

  afterAll(async () => {
    await cleanupLocalTestContext(context)
  })

  it('permite que la misma cuenta cree una evaluación y responda otra', async () => {
    const profile = await context.student
      .from('profiles')
      .select('is_teacher')
      .eq('id', context.studentId)
      .single()

    expect(profile.error).toBeNull()
    expect(profile.data.is_teacher).toBe(false)

    const resourceId = randomUUID()
    const ownCourse = await context.student
      .from('courses')
      .insert({
        teacher_id: context.studentId,
        name: `Curso creado por participante ${resourceId}`,
        nickname: `participante-${resourceId}`,
      })
      .select('id')
      .single()

    expect(ownCourse.error).toBeNull()

    const ownQuiz = await context.student
      .from('quizzes')
      .insert({
        course_id: ownCourse.data.id,
        created_by: context.studentId,
        title: `Evaluación creada por participante ${resourceId}`,
        status: 'draft',
        duration_minutes: 10,
        grade_scale_max: 5,
        number_of_slots: 1,
        variants_per_slot: 6,
        max_focus_violations: 5,
        delivery_mode: 'in_person',
      })
      .select('id')
      .single()

    expect(ownQuiz.error).toBeNull()

    const ownQuestion = await context.student
      .from('questions')
      .insert({
        quiz_id: ownQuiz.data.id,
        slot_number: 1,
        variant_number: 1,
        question_type: 'multiple_choice',
        statement: 'Pregunta canónica creada por una cuenta común',
        options: [
          { id: 'A', text: 'Correcta' },
          { id: 'B', text: 'Distractor B' },
          { id: 'C', text: 'Distractor C' },
          { id: 'D', text: 'Distractor D' },
        ],
        correct_answer: { selected_option: 'A' },
        points: 1,
      })
      .select('id')
      .single()

    expect(ownQuestion.error).toBeNull()
    expect(ownQuestion.data.id).toBeTruthy()

    const otherQuiz = await createAttemptFixture(context, {
      numberOfSlots: 1,
      expiredDeadline: false,
    })
    const answer = await context.student.rpc('submit_response', {
      p_response_id: otherQuiz.assignedResponseId,
      p_answer_payload: { selected_option: 'A' },
    })

    expect(answer.error).toBeNull()
    expect(answer.data?.[0]).toMatchObject({
      status: 'graded',
      score: 1,
    })

    const submission = await context.student.rpc('submit_quiz_attempt', {
      p_attempt_id: otherQuiz.attemptId,
    })

    expect(submission.error).toBeNull()
    expect(submission.data?.[0]).toMatchObject({
      attempt_status: 'graded',
      total_score: 1,
    })
  })
})
