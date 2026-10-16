import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupLocalTestContext,
  createAttemptFixture,
  createLocalTestContext,
  createQuizWithVariants,
} from './helpers/localSupabase.js'

let context

describe('eliminación segura de evaluaciones con variantes', () => {
  beforeAll(async () => {
    context = await createLocalTestContext()
  })

  afterAll(async () => {
    await cleanupLocalTestContext(context)
  })

  it('elimina un quiz sin intentos y sus seis variantes por cascada', async () => {
    const fixture = await createQuizWithVariants(context)

    const { data, error } = await context.teacher
      .from('quizzes')
      .delete()
      .eq('id', fixture.quizId)
      .select('id')

    expect(error).toBeNull()
    expect(data).toEqual([{ id: fixture.quizId }])

    const { data: remainingQuestions, error: questionsError } =
      await context.service
        .from('questions')
        .select('id')
        .eq('quiz_id', fixture.quizId)

    expect(questionsError).toBeNull()
    expect(remainingQuestions).toEqual([])
  })

  it('impide eliminar directamente una variante generada', async () => {
    const fixture = await createQuizWithVariants(context)
    const generatedVariant = fixture.questions.find(
      ({ variant_number: variantNumber }) => variantNumber === 2
    )

    const { error } = await context.teacher
      .from('questions')
      .delete()
      .eq('id', generatedVariant.id)

    expect(error).not.toBeNull()
    expect(error.message).toContain(
      'Las variantes generadas no pueden eliminarse directamente.'
    )
  })

  it('impide eliminar la pregunta base mientras conserva variantes', async () => {
    const fixture = await createQuizWithVariants(context)
    const baseQuestion = fixture.questions.find(
      ({ variant_number: variantNumber }) => variantNumber === 1
    )

    const { error } = await context.teacher
      .from('questions')
      .delete()
      .eq('id', baseQuestion.id)

    expect(error).not.toBeNull()
    expect(error.message).toContain(
      'La pregunta base no puede eliminarse mientras tenga variantes generadas.'
    )
  })

  it('conserva el quiz, variantes e intento cuando existe historial', async () => {
    const fixture = await createAttemptFixture(context, {
      expiredDeadline: false,
    })

    const { data: teacherDeleteData, error: teacherDeleteError } =
      await context.teacher
        .from('quizzes')
        .delete()
        .eq('id', fixture.quizId)
        .select('id')

    expect(teacherDeleteError).toBeNull()
    expect(teacherDeleteData).toEqual([])

    const { error: serviceDeleteError } = await context.service
      .from('quizzes')
      .delete()
      .eq('id', fixture.quizId)

    expect(serviceDeleteError).not.toBeNull()
    expect(serviceDeleteError.message).toContain(
      'No se puede eliminar una evaluación que ya tiene intentos.'
    )

    const [quizResult, questionsResult, attemptResult] = await Promise.all([
      context.service
        .from('quizzes')
        .select('id')
        .eq('id', fixture.quizId)
        .single(),
      context.service
        .from('questions')
        .select('id')
        .eq('quiz_id', fixture.quizId),
      context.service
        .from('attempts')
        .select('id')
        .eq('id', fixture.attemptId)
        .single(),
    ])

    expect(quizResult.error).toBeNull()
    expect(questionsResult.error).toBeNull()
    expect(questionsResult.data).toHaveLength(12)
    expect(attemptResult.error).toBeNull()
  })
})
