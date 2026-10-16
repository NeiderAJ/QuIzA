import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupLocalTestContext,
  createAttemptFixture,
  createLocalTestContext,
  createQuizWithVariants,
} from './helpers/localSupabase.js'

let context

describe('duplicación segura de evaluaciones', () => {
  beforeAll(async () => {
    context = await createLocalTestContext()
  })

  afterAll(async () => {
    await cleanupLocalTestContext(context)
  })

  it('copia reglas y seis variantes sin copiar historial', async () => {
    const source = await createAttemptFixture(context, {
      numberOfSlots: 2,
      expiredDeadline: false,
    })

    const { data: copyId, error } = await context.teacher.rpc(
      'duplicate_quiz',
      {
        p_source_quiz_id: source.quizId,
        p_title: 'Copia editable verificada',
      }
    )

    expect(error).toBeNull()
    expect(copyId).not.toBe(source.quizId)

    const [sourceQuiz, copyQuiz, sourceQuestions, copyQuestions, copyAttempts] =
      await Promise.all([
        context.service
          .from('quizzes')
          .select('status, duration_minutes, number_of_slots, variants_per_slot')
          .eq('id', source.quizId)
          .single(),
        context.service
          .from('quizzes')
          .select(
            'title, status, published_at, duration_minutes, number_of_slots, variants_per_slot'
          )
          .eq('id', copyId)
          .single(),
        context.service
          .from('questions')
          .select(
            'slot_number, variant_number, question_type, statement, options, correct_answer, points'
          )
          .eq('quiz_id', source.quizId)
          .order('slot_number')
          .order('variant_number'),
        context.service
          .from('questions')
          .select(
            'slot_number, variant_number, question_type, statement, options, correct_answer, points'
          )
          .eq('quiz_id', copyId)
          .order('slot_number')
          .order('variant_number'),
        context.service
          .from('attempts')
          .select('id')
          .eq('quiz_id', copyId),
      ])

    expect(sourceQuiz.error).toBeNull()
    expect(sourceQuiz.data.status).toBe('published')
    expect(copyQuiz.error).toBeNull()
    expect(copyQuiz.data).toEqual({
      title: 'Copia editable verificada',
      status: 'draft',
      published_at: null,
      duration_minutes: sourceQuiz.data.duration_minutes,
      number_of_slots: sourceQuiz.data.number_of_slots,
      variants_per_slot: sourceQuiz.data.variants_per_slot,
    })
    expect(sourceQuestions.error).toBeNull()
    expect(copyQuestions.error).toBeNull()
    expect(copyQuestions.data).toEqual(sourceQuestions.data)
    expect(copyQuestions.data).toHaveLength(12)
    expect(copyAttempts.error).toBeNull()
    expect(copyAttempts.data).toEqual([])
  })

  it('rechaza duplicar una evaluación ajena', async () => {
    const source = await createQuizWithVariants(context)
    const { error } = await context.student.rpc('duplicate_quiz', {
      p_source_quiz_id: source.quizId,
      p_title: null,
    })

    expect(error).not.toBeNull()
    expect(error.message).toContain(
      'No tienes permiso para duplicar esta evaluación.'
    )
  })
})
