// @vitest-environment jsdom

import React from 'react'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  cleanupLocalTestContext,
  createAttemptFixture,
  createLocalTestContext,
} from './helpers/localSupabase.js'

let App
let canonicalOptions
let context
let fixture

function readVisibleOptionTexts() {
  return screen.getAllByRole('radio').map((radio) =>
    radio.closest('label').textContent.trim().replace(/^[A-D]\.\s*/, '')
  )
}

describe('orden visual de opciones por respuesta', () => {
  beforeAll(async () => {
    context = await createLocalTestContext()
    fixture = await createAttemptFixture(context, {
      numberOfSlots: 1,
      expiredDeadline: false,
    })

    const response = await context.service
      .from('responses')
      .select('question_id')
      .eq('id', fixture.assignedResponseId)
      .single()
    const question = await context.service
      .from('questions')
      .select('options')
      .eq('id', response.data.question_id)
      .single()

    expect(response.error).toBeNull()
    expect(question.error).toBeNull()
    canonicalOptions = question.data.options

    vi.doMock('../src/supabaseClient.js', () => ({
      supabase: {
        auth: context.student.auth,
        from: (...args) => context.student.from(...args),
        rpc: (...args) => context.student.rpc(...args),
        functions: {
          invoke: vi.fn(async () => ({
            data: null,
            error: new Error('No se esperaba invocar una Edge Function'),
          })),
        },
      },
    }))

    App = (await import('../src/App.jsx')).default
  })

  afterAll(async () => {
    cleanup()
    window.sessionStorage.clear()
    vi.doUnmock('../src/supabaseClient.js')
    await cleanupLocalTestContext(context)
  })

  it('baraja la presentación, la conserva tras F5 y envía el ID interno', async () => {
    window.sessionStorage.setItem(
      'quiza_active_attempt_id',
      fixture.attemptId
    )

    render(<App />)

    await screen.findByRole('heading', { name: 'Pregunta 1 de 1' })
    const firstVisibleOrder = readVisibleOptionTexts()
    const canonicalOrder = canonicalOptions.map((option) => option.text)

    expect(firstVisibleOrder).not.toEqual(canonicalOrder)

    cleanup()
    render(<App />)

    await screen.findByRole('heading', { name: 'Pregunta 1 de 1' })
    expect(readVisibleOptionTexts()).toEqual(firstVisibleOrder)

    const user = userEvent.setup()
    const firstRadio = screen.getAllByRole('radio')[0]
    const selectedText = firstVisibleOrder[0]
    const expectedInternalId = canonicalOptions.find(
      (option) => option.text === selectedText
    ).id

    expect(firstRadio.value).toBe(expectedInternalId)
    await user.click(firstRadio)
    await user.click(screen.getByRole('button', { name: 'Enviar respuesta' }))

    await screen.findByText('Evaluación finalizada y calificada ✅')

    const persistedResponse = await context.service
      .from('responses')
      .select('answer_payload')
      .eq('id', fixture.assignedResponseId)
      .single()

    expect(persistedResponse.error).toBeNull()
    expect(persistedResponse.data.answer_payload).toEqual({
      selected_option: expectedInternalId,
    })
  })
})
