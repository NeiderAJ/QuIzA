// @vitest-environment jsdom

import React from 'react'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  cleanupLocalTestContext,
  createLocalTestContext,
  createQuizWithVariants,
} from './helpers/localSupabase.js'

let App
let context
let course
let fixture
let invokeFunction

function buildGeneratedVariants() {
  return Array.from({ length: 5 }, (_, index) => ({
    statement: `Variante UI ${index + 2}`,
    options: [
      { id: 'A', text: `Correcta UI ${index + 2}` },
      { id: 'B', text: `Distractor B UI ${index + 2}` },
      { id: 'C', text: `Distractor C UI ${index + 2}` },
      { id: 'D', text: `Distractor D UI ${index + 2}` },
    ],
    correct_answer: { selected_option: 'A' },
  }))
}

function buildRegeneratedVariant(variantNumber) {
  return {
    statement: `Variante regenerada UI ${variantNumber}`,
    options: [
      { id: 'A', text: `Correcta regenerada ${variantNumber}` },
      { id: 'B', text: `Distractor B regenerado ${variantNumber}` },
      { id: 'C', text: `Distractor C regenerado ${variantNumber}` },
      { id: 'D', text: `Distractor D regenerado ${variantNumber}` },
    ],
    correct_answer: { selected_option: 'A' },
  }
}

describe('editor y publicación de seis variantes', () => {
  beforeAll(async () => {
    context = await createLocalTestContext()
    fixture = await createQuizWithVariants(context, {
      variantNumbers: [1],
    })

    const { data: courseData, error: courseError } = await context.service
      .from('courses')
      .select('id, name, nickname')
      .eq('id', context.courseId)
      .single()

    expect(courseError).toBeNull()
    course = courseData

    invokeFunction = vi.fn(async (functionName, { body }) => {
      if (functionName !== 'generate-quiz-variants') {
        return { data: null, error: new Error('Función inesperada') }
      }

      const isRegeneration = Boolean(body.variantQuestionId)
      const reservation = await context.service.rpc(
        isRegeneration
          ? 'reserve_variant_regeneration'
          : 'reserve_variant_generation',
        isRegeneration
          ? {
              p_actor_user_id: context.teacherId,
              p_target_question_id: body.variantQuestionId,
              p_provider: 'mock-ui',
              p_model: 'deterministic-ui',
              p_prompt_version: 'v1.1-ui-test',
            }
          : {
              p_actor_user_id: context.teacherId,
              p_base_question_id: body.baseQuestionId,
              p_provider: 'mock-ui',
              p_model: 'deterministic-ui',
              p_prompt_version: 'v1.1-ui-test',
            }
      )

      if (reservation.error) {
        return { data: null, error: reservation.error }
      }

      const completion = await context.service.rpc(
        isRegeneration
          ? 'complete_variant_regeneration'
          : 'complete_variant_generation',
        {
          p_actor_user_id: context.teacherId,
          p_run_id: reservation.data[0].run_id,
          p_variants: isRegeneration
            ? [
                buildRegeneratedVariant(
                  reservation.data[0].target_variant_number
                ),
              ]
            : buildGeneratedVariants(),
          p_input_tokens: 10,
          p_output_tokens: 20,
          p_latency_ms: 5,
          p_result_metadata: { provider_status: 'mock_success' },
        }
      )

      return {
        data: completion.data?.[0] ?? null,
        error: completion.error,
      }
    })

    vi.doMock('../src/supabaseClient.js', () => ({
      supabase: {
        auth: context.teacher.auth,
        from: (...args) => context.teacher.from(...args),
        rpc: (...args) => context.teacher.rpc(...args),
        functions: { invoke: invokeFunction },
      },
    }))

    App = (await import('../src/App.jsx')).default
  })

  afterAll(async () => {
    cleanup()
    vi.doUnmock('../src/supabaseClient.js')
    await cleanupLocalTestContext(context)
  })

  it('genera, revisa, edita y publica una pregunta completa', async () => {
    const user = userEvent.setup()

    render(<App />)

    const courseButton = await screen.findByRole('button', {
      name: new RegExp(course.name),
    })
    await user.click(courseButton)

    const quizButton = await screen.findByRole('button', {
      name: new RegExp(fixture.quizId),
    })
    await user.click(quizButton)

    expect(
      await screen.findByText('1/6 variantes preparadas')
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Generar variantes' }))

    expect(
      await screen.findByText('6/6 variantes preparadas')
    ).toBeInTheDocument()
    expect(invokeFunction).toHaveBeenCalledOnce()

    const variantThreeCard = screen
      .getByRole('heading', { name: 'Variante 3' })
      .closest('article')

    expect(variantThreeCard).not.toBeNull()
    await user.click(
      within(variantThreeCard).getByRole('button', {
        name: 'Regenerar variante',
      })
    )

    expect(
      await screen.findByText('Variante regenerada UI 3')
    ).toBeInTheDocument()
    expect(invokeFunction).toHaveBeenCalledTimes(2)

    const variantHeading = screen.getByRole('heading', {
      name: 'Variante 2',
    })
    const variantCard = variantHeading.closest('article')

    expect(variantCard).not.toBeNull()
    await user.click(
      within(variantCard).getByRole('button', { name: 'Editar variante' })
    )

    const statementInput = within(variantCard).getByLabelText('Enunciado')
    await user.clear(statementInput)
    await user.type(statementInput, 'Variante revisada por el evaluador')
    await user.click(
      within(variantCard).getByRole('button', { name: 'Guardar cambios' })
    )

    expect(
      await screen.findByText('Variante revisada por el evaluador')
    ).toBeInTheDocument()
    expect(
      await screen.findByText('Variante 2 de la pregunta 1 guardada.')
    ).toBeInTheDocument()

    const publishButton = screen.getByRole('button', {
      name: 'Publicar evaluación',
    })

    expect(publishButton).toBeEnabled()
    await user.click(publishButton)

    expect(
      await screen.findByText(
        'Evaluación publicada y lista para abrir por QR ✅'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Abrir acceso por QR' })
    ).toBeInTheDocument()

    const [quizResult, questionResult] = await Promise.all([
      context.service
        .from('quizzes')
        .select('status, number_of_slots, variants_per_slot')
        .eq('id', fixture.quizId)
        .single(),
      context.service
        .from('questions')
        .select('statement')
        .eq('quiz_id', fixture.quizId)
        .eq('slot_number', 1)
        .eq('variant_number', 2)
        .single(),
    ])

    expect(quizResult.error).toBeNull()
    expect(quizResult.data).toEqual({
      status: 'published',
      number_of_slots: 1,
      variants_per_slot: 6,
    })
    expect(questionResult.error).toBeNull()
    expect(questionResult.data.statement).toBe(
      'Variante revisada por el evaluador'
    )
  })
})
