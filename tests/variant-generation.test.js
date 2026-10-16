import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupLocalTestContext,
  createLocalTestContext,
  createQuizWithVariants,
} from './helpers/localSupabase.js'

let context

function buildGeneratedVariants(seed = 'default') {
  return Array.from({ length: 5 }, (_, index) => ({
    statement: `Variante generada ${seed} ${index + 2}`,
    options: [
      { id: 'A', text: `Correcta ${seed} ${index}` },
      { id: 'B', text: `Distractor B ${seed} ${index}` },
      { id: 'C', text: `Distractor C ${seed} ${index}` },
      { id: 'D', text: `Distractor D ${seed} ${index}` },
    ],
    correct_answer: { selected_option: 'A' },
  }))
}

async function reserveGeneration(baseQuestionId, actorUserId = context.teacherId) {
  return context.service.rpc('reserve_variant_generation', {
    p_actor_user_id: actorUserId,
    p_base_question_id: baseQuestionId,
    p_provider: 'mock-local',
    p_model: 'deterministic-v1',
    p_prompt_version: 'v1.1-test',
  })
}

async function failGeneration(runId, message = 'Fallo simulado') {
  return context.service.rpc('fail_variant_generation', {
    p_actor_user_id: context.teacherId,
    p_run_id: runId,
    p_error_message: message,
    p_latency_ms: 5,
    p_result_metadata: {
      provider_status: 'test_failure',
      error_code: 'fixture_failure',
    },
  })
}

async function reserveRegeneration(targetQuestionId) {
  return context.service.rpc('reserve_variant_regeneration', {
    p_actor_user_id: context.teacherId,
    p_target_question_id: targetQuestionId,
    p_provider: 'mock-local',
    p_model: 'deterministic-v1',
    p_prompt_version: 'v1.1-test',
  })
}

describe('generación transaccional de variantes', () => {
  beforeAll(async () => {
    context = await createLocalTestContext()
  })

  afterAll(async () => {
    await cleanupLocalTestContext(context)
  })

  it('reserva y persiste atómicamente las variantes 2 a 6', async () => {
    const fixture = await createQuizWithVariants(context, {
      variantNumbers: [1],
    })
    const reservation = await reserveGeneration(fixture.questions[0].id)

    expect(reservation.error).toBeNull()
    expect(reservation.data).toHaveLength(1)

    const completion = await context.service.rpc(
      'complete_variant_generation',
      {
        p_actor_user_id: context.teacherId,
        p_run_id: reservation.data[0].run_id,
        p_variants: buildGeneratedVariants('success'),
        p_input_tokens: 120,
        p_output_tokens: 300,
        p_latency_ms: 25,
        p_result_metadata: { provider_status: 'success' },
      }
    )

    expect(completion.error).toBeNull()
    expect(completion.data?.[0]).toMatchObject({
      status: 'success',
      variants_inserted: 5,
    })

    const { data: questions, error: questionsError } = await context.service
      .from('questions')
      .select('variant_number')
      .eq('quiz_id', fixture.quizId)
      .order('variant_number')

    expect(questionsError).toBeNull()
    expect(questions.map(({ variant_number: number }) => number)).toEqual([
      1, 2, 3, 4, 5, 6,
    ])

    const { data: deletedQuiz, error: deleteError } = await context.teacher
      .from('quizzes')
      .delete()
      .eq('id', fixture.quizId)
      .select('id')

    expect(deleteError).toBeNull()
    expect(deletedQuiz).toEqual([{ id: fixture.quizId }])
  })

  it('rechaza salida incompleta sin insertar variantes parciales', async () => {
    const fixture = await createQuizWithVariants(context, {
      variantNumbers: [1],
    })
    const reservation = await reserveGeneration(fixture.questions[0].id)

    expect(reservation.error).toBeNull()

    const completion = await context.service.rpc(
      'complete_variant_generation',
      {
        p_actor_user_id: context.teacherId,
        p_run_id: reservation.data[0].run_id,
        p_variants: buildGeneratedVariants('incomplete').slice(0, 4),
        p_input_tokens: null,
        p_output_tokens: null,
        p_latency_ms: 10,
        p_result_metadata: null,
      }
    )

    expect(completion.error).not.toBeNull()
    expect(completion.error.message).toContain(
      'Se requieren exactamente cinco variantes.'
    )

    const { count, error: countError } = await context.service
      .from('questions')
      .select('id', { count: 'exact', head: true })
      .eq('quiz_id', fixture.quizId)

    expect(countError).toBeNull()
    expect(count).toBe(1)

    const failure = await failGeneration(
      reservation.data[0].run_id,
      'Authorization Bearer sk-secret-no-debe-persistir'
    )

    expect(failure.error).toBeNull()

    const { data: run, error: runError } = await context.service
      .from('llm_runs')
      .select('status, error_message')
      .eq('id', reservation.data[0].run_id)
      .single()

    expect(runError).toBeNull()
    expect(run.status).toBe('error')
    expect(run.error_message).toBe(
      'La generación de variantes falló; se omitió un detalle potencialmente sensible.'
    )
    expect(run.error_message).not.toContain('sk-secret')
  })

  it('rechaza variantes duplicadas', async () => {
    const fixture = await createQuizWithVariants(context, {
      variantNumbers: [1],
    })
    const reservation = await reserveGeneration(fixture.questions[0].id)
    const variants = buildGeneratedVariants('duplicate')
    variants[1] = structuredClone(variants[0])

    expect(reservation.error).toBeNull()

    const completion = await context.service.rpc(
      'complete_variant_generation',
      {
        p_actor_user_id: context.teacherId,
        p_run_id: reservation.data[0].run_id,
        p_variants: variants,
        p_input_tokens: null,
        p_output_tokens: null,
        p_latency_ms: 10,
        p_result_metadata: null,
      }
    )

    expect(completion.error).not.toBeNull()
    expect(completion.error.message).toContain('está duplicada')
    await failGeneration(reservation.data[0].run_id)
  })

  it('serializa reservas concurrentes para la misma pregunta', async () => {
    const fixture = await createQuizWithVariants(context, {
      variantNumbers: [1],
    })
    const [first, second] = await Promise.all([
      reserveGeneration(fixture.questions[0].id),
      reserveGeneration(fixture.questions[0].id),
    ])
    const results = [first, second]
    const successful = results.filter(({ error }) => error === null)
    const rejected = results.filter(({ error }) => error !== null)

    expect(successful).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0].error.message).toContain(
      'Ya existe una generación de variantes en curso'
    )

    await failGeneration(successful[0].data[0].run_id)
  })

  it('recupera una reserva vencida y rechaza completar la anterior', async () => {
    const fixture = await createQuizWithVariants(context, {
      variantNumbers: [1],
    })
    const firstReservation = await reserveGeneration(fixture.questions[0].id)

    expect(firstReservation.error).toBeNull()

    const { error: expireError } = await context.service
      .from('llm_runs')
      .update({
        created_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        lease_expires_at: new Date(Date.now() - 60 * 1000).toISOString(),
      })
      .eq('id', firstReservation.data[0].run_id)

    expect(expireError).toBeNull()

    const staleCompletion = await context.service.rpc(
      'complete_variant_generation',
      {
        p_actor_user_id: context.teacherId,
        p_run_id: firstReservation.data[0].run_id,
        p_variants: buildGeneratedVariants('stale'),
        p_input_tokens: null,
        p_output_tokens: null,
        p_latency_ms: 10,
        p_result_metadata: null,
      }
    )

    expect(staleCompletion.error).not.toBeNull()
    expect(staleCompletion.error.message).toContain(
      'La reserva de generación expiró'
    )

    const secondReservation = await reserveGeneration(fixture.questions[0].id)

    expect(secondReservation.error).toBeNull()
    expect(secondReservation.data[0].run_id).not.toBe(
      firstReservation.data[0].run_id
    )

    const { data: firstRun, error: firstRunError } = await context.service
      .from('llm_runs')
      .select('status')
      .eq('id', firstReservation.data[0].run_id)
      .single()

    expect(firstRunError).toBeNull()
    expect(firstRun.status).toBe('error')
    await failGeneration(secondReservation.data[0].run_id)
  })

  it('rechaza actores que no son propietarios', async () => {
    const fixture = await createQuizWithVariants(context, {
      variantNumbers: [1],
    })
    const reservation = await reserveGeneration(
      fixture.questions[0].id,
      context.studentId
    )

    expect(reservation.error).not.toBeNull()
    expect(reservation.error.message).toContain(
      'No tienes permiso para generar variantes'
    )
  })

  it('regenera únicamente la variante seleccionada', async () => {
    const fixture = await createQuizWithVariants(context)
    const target = fixture.questions.find(
      ({ variant_number: variantNumber }) => variantNumber === 2
    )
    const { data: before, error: beforeError } = await context.service
      .from('questions')
      .select('id, variant_number, statement')
      .eq('quiz_id', fixture.quizId)
      .order('variant_number')

    expect(beforeError).toBeNull()

    const reservation = await reserveRegeneration(target.id)

    expect(reservation.error).toBeNull()
    expect(reservation.data?.[0]).toMatchObject({
      target_variant_number: 2,
      slot_number: 1,
    })
    expect(reservation.data[0].existing_variants).toHaveLength(5)

    const regenerated = buildGeneratedVariants('single-regeneration')[0]
    const completion = await context.service.rpc(
      'complete_variant_regeneration',
      {
        p_actor_user_id: context.teacherId,
        p_run_id: reservation.data[0].run_id,
        p_variants: [regenerated],
        p_input_tokens: 30,
        p_output_tokens: 40,
        p_latency_ms: 15,
        p_result_metadata: { provider_status: 'success' },
      }
    )

    expect(completion.error).toBeNull()
    expect(completion.data?.[0]).toMatchObject({
      variant_number: 2,
      status: 'success',
    })

    const { data: after, error: afterError } = await context.service
      .from('questions')
      .select('id, variant_number, statement')
      .eq('quiz_id', fixture.quizId)
      .order('variant_number')

    expect(afterError).toBeNull()
    expect(after).toHaveLength(6)
    expect(after.find(({ variant_number: number }) => number === 2)).toEqual({
      id: target.id,
      variant_number: 2,
      statement: regenerated.statement,
    })
    expect(
      after.filter(({ variant_number: number }) => number !== 2)
    ).toEqual(before.filter(({ variant_number: number }) => number !== 2))
  })

  it('rechaza una regeneración duplicada y conserva la variante original', async () => {
    const fixture = await createQuizWithVariants(context)
    const target = fixture.questions.find(
      ({ variant_number: variantNumber }) => variantNumber === 3
    )
    const { data: existingVariant, error: existingError } =
      await context.service
        .from('questions')
        .select('statement, options, correct_answer')
        .eq('quiz_id', fixture.quizId)
        .eq('variant_number', 2)
        .single()

    expect(existingError).toBeNull()

    const reservation = await reserveRegeneration(target.id)

    expect(reservation.error).toBeNull()

    const completion = await context.service.rpc(
      'complete_variant_regeneration',
      {
        p_actor_user_id: context.teacherId,
        p_run_id: reservation.data[0].run_id,
        p_variants: [existingVariant],
        p_input_tokens: null,
        p_output_tokens: null,
        p_latency_ms: 10,
        p_result_metadata: null,
      }
    )

    expect(completion.error).not.toBeNull()
    expect(completion.error.message).toContain(
      'duplica otra variante del slot'
    )

    const { data: preserved, error: preservedError } = await context.service
      .from('questions')
      .select('statement')
      .eq('id', target.id)
      .single()

    expect(preservedError).toBeNull()
    expect(preserved.statement).toBe('Pregunta de prueba 1, variante 3')
    await failGeneration(reservation.data[0].run_id)
  })
})
