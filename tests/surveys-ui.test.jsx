// @vitest-environment jsdom

import React from 'react'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  cleanupLocalTestContext,
  createLocalTestContext,
} from './helpers/localSupabase.js'

let App
let context

describe('flujo UI de encuestas QRS', () => {
  beforeAll(async () => {
    context = await createLocalTestContext()

    vi.doMock('../src/supabaseClient.js', () => ({
      supabase: {
        auth: context.teacher.auth,
        from: (...args) => context.teacher.from(...args),
        rpc: (...args) => context.teacher.rpc(...args),
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
    window.history.replaceState({}, '', '/')
    window.localStorage.clear()
    vi.doUnmock('../src/supabaseClient.js')
    await cleanupLocalTestContext(context)
  })

  it('crea una encuesta, define opciones y genera el QRS', async () => {
    const user = userEvent.setup()

    window.history.replaceState({}, '', '/')
    render(<App />)

    await user.click(
      await screen.findByRole('button', { name: 'Crear encuesta rápida' })
    )
    await user.type(screen.getByLabelText('Pregunta'), '¿Cuál prefieres?')
    await user.type(screen.getByLabelText('Opción 1'), 'Opción roja')
    await user.type(screen.getByLabelText('Opción 2'), 'Opción azul')
    await user.click(screen.getByRole('button', { name: 'Agregar opción' }))
    await user.type(screen.getByLabelText('Opción 3'), 'Opción verde')
    await user.click(
      screen.getByRole('button', { name: 'Crear y abrir QRS' })
    )

    expect(
      await screen.findByText('Encuesta creada y QRS activo ✅')
    ).toBeInTheDocument()
    expect(screen.getByText('Resultados agregados')).toBeInTheDocument()
    expect(screen.getByText('Regenerar QRS')).toBeInTheDocument()

    const survey = await context.service
      .from('surveys')
      .select('id, creator_id, question, options, status')
      .eq('question', '¿Cuál prefieres?')
      .single()

    expect(survey.error).toBeNull()
    expect(survey.data).toMatchObject({
      creator_id: context.teacherId,
      question: '¿Cuál prefieres?',
      options: ['Opción roja', 'Opción azul', 'Opción verde'],
      status: 'active',
    })

    cleanup()
  })

  it('responde por la ruta pública sin asociar la sesión autenticada', async () => {
    const user = userEvent.setup()
    const created = await context.teacher.rpc('create_survey', {
      p_question: '¿Recomendarías QuIzA?',
      p_options: ['Sí', 'No'],
    })
    const opened = await context.teacher.rpc('open_survey', {
      p_survey_id: created.data,
    })

    expect(created.error).toBeNull()
    expect(opened.error).toBeNull()

    window.history.replaceState(
      {},
      '',
      `/?survey=${opened.data[0].qr_token}`
    )
    render(<App />)

    expect(
      await screen.findByText('¿Recomendarías QuIzA?')
    ).toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: 'Sí' }))
    await user.click(screen.getByRole('button', { name: 'Enviar respuesta' }))

    expect(
      await screen.findByText('Respuesta registrada. Gracias por participar ✅')
    ).toBeInTheDocument()

    const responses = await context.service
      .from('survey_responses')
      .select('*')
      .eq('survey_id', created.data)

    expect(responses.error).toBeNull()
    expect(responses.data).toHaveLength(1)
    expect(responses.data[0]).not.toHaveProperty('user_id')
    expect(responses.data[0]).not.toHaveProperty('creator_id')
    expect(responses.data[0]).not.toHaveProperty('student_id')
  })
})
