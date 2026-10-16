// @vitest-environment jsdom

import React from 'react'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  cleanupLocalTestContext,
  createAttemptFixture,
  createLocalTestContext,
  expireAttemptDeadline,
  readAttempt,
} from './helpers/localSupabase.js'

let App
let context
let beforeRpc
let afterRpc

function expectRenderedResult(persisted) {
  const gradeLine = screen.getByText('Nota:').closest('p')
  const scoreLine = screen.getByText('Puntos obtenidos:').closest('p')

  expect(gradeLine).toHaveTextContent(
    `Nota: ${Number(persisted.grade)} / 5`
  )
  expect(scoreLine).toHaveTextContent(
    `Puntos obtenidos: ${Number(persisted.score_points)}`
  )
  expect(
    screen.queryByRole('button', { name: 'Enviar respuesta' })
  ).not.toBeInTheDocument()
  expect(
    sessionStorage.getItem('quiza_active_attempt_id')
  ).toBeNull()
}

async function renderActiveAttempt(fixture, questionNumber, totalQuestions) {
  sessionStorage.setItem(
    'quiza_active_attempt_id',
    fixture.attemptId
  )

  render(<App />)

  expect(
    await screen.findByRole('heading', {
      name: `Pregunta ${questionNumber} de ${totalQuestions}`,
    })
  ).toBeInTheDocument()
}

describe('expired en la interfaz', () => {
  beforeAll(async () => {
    context = await createLocalTestContext()

    const frontendSupabase = {
      auth: context.student.auth,
      from: (...args) => context.student.from(...args),
      rpc: async (...args) => {
        if (beforeRpc) {
          await beforeRpc(args[0])
        }

        const result = await context.student.rpc(...args)

        if (afterRpc) {
          await afterRpc(args[0], result)
        }

        return result
      },
    }

    vi.doMock('../src/supabaseClient.js', () => ({
      supabase: frontendSupabase,
    }))

    App = (await import('../src/App.jsx')).default
  })

  afterEach(() => {
    beforeRpc = null
    afterRpc = null
    cleanup()
    sessionStorage.clear()
  })

  afterAll(async () => {
    vi.doUnmock('../src/supabaseClient.js')
    await cleanupLocalTestContext(context)
  })

  it('muestra exactamente la nota parcial persistida y no inventa cero', async () => {
    const fixture = await createAttemptFixture(context)

    const heartbeat = await context.student.rpc('heartbeat_quiz_attempt', {
      p_attempt_id: fixture.attemptId,
    })

    expect(heartbeat.error).toBeNull()

    const persisted = await readAttempt(context, fixture.attemptId)
    expect(persisted.status).toBe('expired')

    sessionStorage.setItem(
      'quiza_active_attempt_id',
      fixture.attemptId
    )

    render(<App />)

    expect(await screen.findByText('Tiempo agotado.')).toBeInTheDocument()

    expectRenderedResult(persisted)
    expect(screen.getByText('Nota:').closest('p')).not.toHaveTextContent(
      'Nota: 0 / 5'
    )
  })

  it('muestra la nota persistida cuando expira durante el envío', async () => {
    const user = userEvent.setup()
    let expiredBySubmit = false
    const fixture = await createAttemptFixture(context, {
      expiredDeadline: false,
    })

    beforeRpc = async (rpcName) => {
      if (rpcName === 'submit_response') {
        beforeRpc = null
        await expireAttemptDeadline(context, fixture.attemptId)
      }
    }

    afterRpc = async (rpcName, result) => {
      if (rpcName === 'submit_response') {
        expiredBySubmit = result.data?.[0]?.status === 'expired'
      }
    }

    await renderActiveAttempt(fixture, 2, 2)

    await user.click(screen.getByRole('radio', { name: /A\./ }))
    await user.click(screen.getByRole('button', { name: 'Enviar respuesta' }))

    expect(await screen.findByText('Tiempo agotado.')).toBeInTheDocument()
    expect(expiredBySubmit).toBe(true)

    const persisted = await readAttempt(context, fixture.attemptId)
    expectRenderedResult(persisted)
  })

  it('muestra la nota persistida cuando expira durante el heartbeat', async () => {
    let expiredByHeartbeat = false
    const fixture = await createAttemptFixture(context, {
      expiredDeadline: false,
    })

    afterRpc = async (rpcName, result) => {
      if (rpcName === 'heartbeat_quiz_attempt' && result.data === null) {
        expiredByHeartbeat = true
      }
    }

    await renderActiveAttempt(fixture, 2, 2)
    await expireAttemptDeadline(context, fixture.attemptId)

    expect(
      await screen.findByText('Tiempo agotado.', {}, { timeout: 10000 })
    ).toBeInTheDocument()
    expect(expiredByHeartbeat).toBe(true)

    const persisted = await readAttempt(context, fixture.attemptId)
    expectRenderedResult(persisted)
  })

  it('muestra la nota persistida cuando expira durante la entrega final', async () => {
    const user = userEvent.setup()
    let deadlineMoved = false
    let expiredByFinalSubmission = false
    const fixture = await createAttemptFixture(context, {
      numberOfSlots: 3,
      expiredDeadline: false,
      previousGradedSlots: [1],
    })

    afterRpc = async (rpcName, result) => {
      if (
        rpcName === 'submit_response' &&
        result.data?.[0]?.status === 'graded' &&
        !deadlineMoved
      ) {
        deadlineMoved = true
        await expireAttemptDeadline(context, fixture.attemptId)
      } else if (rpcName === 'submit_quiz_attempt') {
        expiredByFinalSubmission =
          result.data?.[0]?.attempt_status === 'expired'
      }
    }

    await renderActiveAttempt(fixture, 3, 3)

    await user.click(screen.getByRole('radio', { name: /A\./ }))
    await user.click(screen.getByRole('button', { name: 'Enviar respuesta' }))

    expect(await screen.findByText('Tiempo agotado.')).toBeInTheDocument()
    expect(expiredByFinalSubmission).toBe(true)

    const persisted = await readAttempt(context, fixture.attemptId)
    expect(persisted.status).toBe('expired')
    expect(Number(persisted.score_points)).toBe(2)
    expect(Number(persisted.grade)).toBe(3.33)
    expectRenderedResult(persisted)
  })

  it('mantiene la finalización normal en la interfaz', async () => {
    const user = userEvent.setup()
    const fixture = await createAttemptFixture(context, {
      numberOfSlots: 1,
      expiredDeadline: false,
    })

    await renderActiveAttempt(fixture, 1, 1)

    await user.click(screen.getByRole('radio', { name: /A\./ }))
    await user.click(screen.getByRole('button', { name: 'Enviar respuesta' }))

    expect(
      await screen.findByText('Evaluación finalizada y calificada ✅')
    ).toBeInTheDocument()

    const persisted = await readAttempt(context, fixture.attemptId)
    expect(persisted.status).toBe('graded')
    expect(Number(persisted.score_points)).toBe(1)
    expect(Number(persisted.grade)).toBe(5)
    expectRenderedResult(persisted)
    expect(screen.queryByText('Tiempo agotado.')).not.toBeInTheDocument()
  })

  it('restaura un intento tras F5 sin registrar incidencia ni cambiar pregunta', async () => {
    const fixture = await createAttemptFixture(context, {
      numberOfSlots: 1,
      expiredDeadline: false,
    })
    const { data: attemptBefore, error: attemptBeforeError } =
      await context.service
        .from('attempts')
        .select('current_question_id, focus_violation_count')
        .eq('id', fixture.attemptId)
        .single()

    expect(attemptBeforeError).toBeNull()

    const navigationSpy = vi
      .spyOn(performance, 'getEntriesByType')
      .mockReturnValue([{ type: 'reload' }])

    try {
      await renderActiveAttempt(fixture, 1, 1)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))

      const [attemptAfter, focusEvents] = await Promise.all([
        context.service
          .from('attempts')
          .select('current_question_id, focus_violation_count')
          .eq('id', fixture.attemptId)
          .single(),
        context.service
          .from('focus_events')
          .select('id')
          .eq('attempt_id', fixture.attemptId),
      ])

      expect(attemptAfter.error).toBeNull()
      expect(attemptAfter.data).toEqual(attemptBefore)
      expect(focusEvents.error).toBeNull()
      expect(focusEvents.data).toEqual([])
      expect(
        screen.queryByText(/Incidencia de integridad/i)
      ).not.toBeInTheDocument()
    } finally {
      navigationSpy.mockRestore()
    }
  })
})
