// @vitest-environment jsdom

import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import React from 'react'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  cleanupLocalTestContext,
  createLocalTestContext,
  createQuizWithVariants,
} from './helpers/localSupabase.js'

let App
let browserClient
let context
let participantEmail
let participantPassword
let qrToken

describe('retorno al QRR después del registro', () => {
  beforeAll(async () => {
    context = await createLocalTestContext()
    const fixture = await createQuizWithVariants(context)
    const publish = await context.teacher.rpc('publish_quiz', {
      p_quiz_id: fixture.quizId,
    })

    participantEmail = `registro-qrr-${randomUUID()}@example.test`
    participantPassword = `Quiza-${randomUUID()}-Aa1!`

    const authorization = await context.teacher
      .from('course_authorized_emails')
      .insert({
        course_id: context.courseId,
        email: participantEmail,
        participant_name: 'Registro desde QRR',
      })
    const session = await context.teacher.rpc('create_quiz_session', {
      p_quiz_id: fixture.quizId,
      p_access_minutes: 5,
    })

    expect(publish.error).toBeNull()
    expect(authorization.error).toBeNull()
    expect(session.error).toBeNull()
    qrToken = session.data[0].qr_token

    browserClient = createClient(context.url, context.anonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })

    vi.doMock('../src/supabaseClient.js', () => ({
      supabase: {
        auth: browserClient.auth,
        from: (...args) => browserClient.from(...args),
        rpc: (...args) => browserClient.rpc(...args),
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
    window.sessionStorage.clear()
    await browserClient.auth.signOut()
    vi.doUnmock('../src/supabaseClient.js')
    await cleanupLocalTestContext(context)
  })

  it('conserva el token, registra la cuenta e ingresa automáticamente', async () => {
    const user = userEvent.setup()

    window.history.replaceState({}, '', `/?join=${qrToken}`)
    render(<App />)

    await user.click(
      await screen.findByRole('button', { name: 'Crear cuenta' })
    )
    await user.type(screen.getByLabelText('Nombre'), 'Participante QRR')
    await user.type(screen.getByLabelText('Correo'), participantEmail)
    await user.type(screen.getByLabelText('Contraseña'), participantPassword)

    const submitButton = screen
      .getAllByRole('button', { name: 'Crear cuenta' })
      .find((button) => !button.disabled)

    expect(submitButton).toBeDefined()
    await user.click(submitButton)

    expect(
      await screen.findByText('Acceso a la evaluación autorizado ✅', {}, {
        timeout: 5000,
      })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Pregunta 1 de 1' })
    ).toBeInTheDocument()
    expect(
      window.sessionStorage.getItem('quiza_active_attempt_id')
    ).toEqual(expect.any(String))
  })
})
