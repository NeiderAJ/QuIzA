// @vitest-environment jsdom

import React from 'react'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  cleanupLocalTestContext,
  createAttemptFixture,
  createLocalTestContext,
} from './helpers/localSupabase.js'

let App
let context
let course
let fixture

describe('panel docente de seguimiento y resultados', () => {
  beforeAll(async () => {
    context = await createLocalTestContext()
    fixture = await createAttemptFixture(context, {
      numberOfSlots: 1,
      expiredDeadline: false,
    })

    const answer = await context.student.rpc('submit_response', {
      p_response_id: fixture.assignedResponseId,
      p_answer_payload: { selected_option: 'A' },
    })
    const submission = await context.student.rpc('submit_quiz_attempt', {
      p_attempt_id: fixture.attemptId,
    })
    const courseResult = await context.service
      .from('courses')
      .select('id, name, nickname')
      .eq('id', context.courseId)
      .single()
    const authorizedResult = await context.service
      .from('course_authorized_emails')
      .insert({
        course_id: context.courseId,
        email: context.studentEmail,
      })

    expect(answer.error).toBeNull()
    expect(submission.error).toBeNull()
    expect(courseResult.error).toBeNull()
    expect(authorizedResult.error).toBeNull()
    course = courseResult.data

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
    vi.doUnmock('../src/supabaseClient.js')
    await cleanupLocalTestContext(context)
  })

  it('muestra resultados persistidos, detalle y métricas de sesión', async () => {
    const user = userEvent.setup()

    render(<App />)

    await user.click(
      await screen.findByRole('button', {
        name: new RegExp(course.name),
      })
    )
    await user.click(
      await screen.findByRole('button', {
        name: new RegExp(fixture.quizId),
      })
    )

    const resultsSection = (
      await screen.findByRole('heading', { name: 'Resultados' })
    ).closest('section')

    expect(resultsSection).not.toBeNull()
    expect(
      await within(resultsSection).findByText(context.studentEmail)
    ).toBeInTheDocument()
    expect(within(resultsSection).getByText('Calificado')).toBeInTheDocument()
    expect(within(resultsSection).getByText('5')).toBeInTheDocument()

    await user.click(
      within(resultsSection).getByRole('button', { name: 'Ver detalle' })
    )

    expect(
      await within(resultsSection).findByRole('heading', {
        name: 'Detalle del intento',
      })
    ).toBeInTheDocument()
    expect(within(resultsSection).getByText(/Pregunta de prueba 1/)).toBeInTheDocument()
    expect(within(resultsSection).getByText('Correcta')).toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: 'Abrir acceso por QR' })
    )

    const liveSection = (
      await screen.findByRole('heading', {
        name: 'Sesión presencial activa',
      })
    ).closest('section')

    expect(liveSection).not.toBeNull()
    expect(
      await within(liveSection).findByText('Autorizados')
    ).toBeInTheDocument()
    expect(within(liveSection).getByText('Dispositivos activos')).toBeInTheDocument()
  })
})
