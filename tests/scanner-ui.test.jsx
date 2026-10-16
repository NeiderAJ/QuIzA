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
let surveyToken

describe('escáner interno de QR', () => {
  beforeAll(async () => {
    context = await createLocalTestContext()
    const created = await context.teacher.rpc('create_survey', {
      p_question: 'Encuesta abierta desde el escáner',
      p_options: ['Uno', 'Dos'],
    })
    const opened = await context.teacher.rpc('open_survey', {
      p_survey_id: created.data,
    })

    expect(created.error).toBeNull()
    expect(opened.error).toBeNull()
    surveyToken = opened.data[0].qr_token

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
    vi.doUnmock('../src/supabaseClient.js')
    await cleanupLocalTestContext(context)
  })

  it('rechaza otros orígenes y abre un QRS pegado cuando no hay cámara', async () => {
    const user = userEvent.setup()

    window.history.replaceState({}, '', '/')
    render(<App />)

    await user.click(
      await screen.findByRole('button', { name: 'Escanear QR' })
    )
    expect(
      await screen.findByRole('heading', { name: 'Escanear QR' })
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Pega el enlace como alternativa/)
    ).toBeInTheDocument()

    const input = screen.getByLabelText('Enlace QRR o QRS')

    await user.type(input, `https://otro.example/?survey=${surveyToken}`)
    await user.click(screen.getByRole('button', { name: 'Abrir código' }))

    expect(
      screen.getByText('El código no pertenece a esta instalación de QuIzA.')
    ).toBeInTheDocument()

    await user.clear(input)
    await user.type(
      input,
      `${window.location.origin}/?survey=${surveyToken}`
    )
    await user.click(screen.getByRole('button', { name: 'Abrir código' }))

    expect(
      await screen.findByText('Encuesta abierta desde el escáner')
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Encuesta rápida' })
    ).toBeInTheDocument()
  })
})
