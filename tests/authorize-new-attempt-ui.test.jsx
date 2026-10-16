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

describe('autorización de nuevo intento desde resultados', () => {
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

    expect(answer.error).toBeNull()
    expect(submission.error).toBeNull()
    expect(courseResult.error).toBeNull()
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

  it('confirma, audita y refleja una autorización de un solo uso', async () => {
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
    await user.click(
      await within(resultsSection).findByRole('button', {
        name: 'Autorizar nuevo intento',
      })
    )

    await user.type(
      within(resultsSection).getByLabelText('Motivo (opcional)'),
      'Interrupción eléctrica documentada'
    )
    await user.click(
      within(resultsSection).getByRole('button', {
        name: 'Confirmar autorización',
      })
    )

    expect(
      await within(resultsSection).findByText(
        /Nuevo intento autorizado\. La autorización se consumirá/
      )
    ).toBeInTheDocument()
    expect(
      within(resultsSection).getByText('Autorizado')
    ).toBeInTheDocument()
    expect(
      within(resultsSection).queryByRole('button', {
        name: 'Autorizar nuevo intento',
      })
    ).not.toBeInTheDocument()

    const authorization = await context.service
      .from('attempt_authorizations')
      .select('previous_attempt_id, authorized_by, reason, used_at')
      .eq('previous_attempt_id', fixture.attemptId)
      .single()

    expect(authorization.error).toBeNull()
    expect(authorization.data).toEqual({
      previous_attempt_id: fixture.attemptId,
      authorized_by: context.teacherId,
      reason: 'Interrupción eléctrica documentada',
      used_at: null,
    })
  })
})
