import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupLocalTestContext,
  createAttemptFixture,
  createLocalTestContext,
  createQuizWithVariants,
} from './helpers/localSupabase.js'

let context

describe('publicación segura de evaluaciones V1.1', () => {
  beforeAll(async () => {
    context = await createLocalTestContext()
  })

  afterAll(async () => {
    await cleanupLocalTestContext(context)
  })

  it('publica únicamente un quiz completo y persiste seis variantes por slot', async () => {
    const fixture = await createQuizWithVariants(context, {
      numberOfSlots: 2,
    })

    const { data, error } = await context.teacher.rpc('publish_quiz', {
      p_quiz_id: fixture.quizId,
    })

    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data[0]).toMatchObject({
      quiz_id: fixture.quizId,
      status: 'published',
      number_of_slots: 2,
      variants_per_slot: 6,
    })
    expect(data[0].published_at).toBeTruthy()
  })

  it('rechaza publicar un slot con solo cinco variantes', async () => {
    const fixture = await createQuizWithVariants(context, {
      variantNumbers: [1, 2, 3, 4, 5],
    })

    const { error } = await context.teacher.rpc('publish_quiz', {
      p_quiz_id: fixture.quizId,
    })

    expect(error).not.toBeNull()
    expect(error.message).toContain(
      'Cada pregunta debe tener exactamente las variantes 1 a 6'
    )
  })

  it('impide evadir la validación actualizando status directamente', async () => {
    const fixture = await createQuizWithVariants(context, {
      variantNumbers: [1, 2, 3, 4, 5],
    })

    const { error } = await context.teacher
      .from('quizzes')
      .update({ status: 'published' })
      .eq('id', fixture.quizId)

    expect(error).not.toBeNull()
    expect(error.message).toContain(
      'Cada pregunta debe tener exactamente las variantes 1 a 6'
    )
  })

  it('rechaza una variante con contenido inválido', async () => {
    const fixture = await createQuizWithVariants(context, {
      questionOverrides: ({ variantNumber }) =>
        variantNumber === 6
          ? {
              options: [
                { id: 'A', text: 'Duplicada' },
                { id: 'B', text: 'Duplicada' },
                { id: 'C', text: 'Tercera' },
                { id: 'D', text: 'Cuarta' },
              ],
            }
          : {},
    })

    const { error } = await context.teacher.rpc('publish_quiz', {
      p_quiz_id: fixture.quizId,
    })

    expect(error).not.toBeNull()
    expect(error.message).toContain('contiene opciones duplicadas')
  })

  it('devuelve automáticamente a borrador un quiz publicado que se edita', async () => {
    const fixture = await createQuizWithVariants(context)
    const variant = fixture.questions.find(
      ({ variant_number: variantNumber }) => variantNumber === 2
    )

    const { error: publishError } = await context.teacher.rpc('publish_quiz', {
      p_quiz_id: fixture.quizId,
    })

    expect(publishError).toBeNull()

    const { error: updateError } = await context.teacher
      .from('questions')
      .update({ statement: 'Contenido revisado antes de aplicar' })
      .eq('id', variant.id)

    expect(updateError).toBeNull()

    const { data: quiz, error: quizError } = await context.service
      .from('quizzes')
      .select('status, published_at')
      .eq('id', fixture.quizId)
      .single()

    expect(quizError).toBeNull()
    expect(quiz).toEqual({
      status: 'draft',
      published_at: null,
    })
  })

  it('mantiene congelado el contenido desde el primer intento', async () => {
    const fixture = await createAttemptFixture(context, {
      expiredDeadline: false,
    })
    const { data: questions, error: questionsError } = await context.service
      .from('questions')
      .select('id, statement')
      .eq('quiz_id', fixture.quizId)
      .eq('variant_number', 2)
      .order('slot_number')
      .limit(1)

    expect(questionsError).toBeNull()

    const originalQuestion = questions[0]
    const { data: teacherUpdateData, error: teacherUpdateError } =
      await context.teacher
        .from('questions')
        .update({ statement: 'Cambio prohibido' })
        .eq('id', originalQuestion.id)
        .select('id')

    expect(teacherUpdateError).toBeNull()
    expect(teacherUpdateData).toEqual([])

    const { error: serviceUpdateError } = await context.service
      .from('questions')
      .update({ statement: 'Cambio prohibido' })
      .eq('id', originalQuestion.id)

    expect(serviceUpdateError).not.toBeNull()

    const { data: preservedQuestion, error: preservedError } =
      await context.service
        .from('questions')
        .select('statement')
        .eq('id', originalQuestion.id)
        .single()

    expect(preservedError).toBeNull()
    expect(preservedQuestion.statement).toBe(originalQuestion.statement)
  })

  it('rechaza publicar una evaluación ajena', async () => {
    const fixture = await createQuizWithVariants(context)

    const { error } = await context.student.rpc('publish_quiz', {
      p_quiz_id: fixture.quizId,
    })

    expect(error).not.toBeNull()
    expect(error.message).toContain(
      'No tienes permiso para publicar esta evaluación.'
    )
  })
})
