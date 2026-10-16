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
  createQuizWithVariants,
} from './helpers/localSupabase.js'

let App
let context
let course
let editableQuiz
let usedQuiz

describe('edición de datos básicos de la evaluación', () => {
  beforeAll(async () => {
    context = await createLocalTestContext()
    editableQuiz = await createQuizWithVariants(context)
    usedQuiz = await createAttemptFixture(context, {
      numberOfSlots: 1,
      expiredDeadline: false,
    })

    const courseResult = await context.service
      .from('courses')
      .select('id, name, nickname')
      .eq('id', context.courseId)
      .single()

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

  it('guarda borradores sin intentos y oculta la edición al existir historial', async () => {
    const user = userEvent.setup()

    render(<App />)

    await user.click(
      await screen.findByRole('button', {
        name: new RegExp(course.name),
      })
    )
    await user.click(
      await screen.findByRole('button', {
        name: new RegExp(editableQuiz.quizId),
      })
    )
    await user.click(
      await screen.findByRole('button', { name: 'Editar datos' })
    )

    const titleInput = screen.getByLabelText('Título')
    const durationInput = screen.getByLabelText('Duración en minutos')
    const instructionsInput = screen.getByLabelText(
      'Instrucciones (opcional)'
    )

    await user.clear(titleInput)
    await user.type(titleInput, 'Evaluación revisada')
    await user.clear(durationInput)
    await user.type(durationInput, '25')
    await user.type(instructionsInput, 'Lee cada enunciado con atención.')
    await user.click(screen.getByRole('button', { name: 'Guardar datos' }))

    expect(
      await screen.findByText('Datos de la evaluación actualizados ✅')
    ).toBeInTheDocument()

    const savedQuiz = await context.service
      .from('quizzes')
      .select('title, instructions, duration_minutes, status')
      .eq('id', editableQuiz.quizId)
      .single()

    expect(savedQuiz.error).toBeNull()
    expect(savedQuiz.data).toEqual({
      title: 'Evaluación revisada',
      instructions: 'Lee cada enunciado con atención.',
      duration_minutes: 25,
      status: 'draft',
    })

    await user.click(
      screen.getByRole('button', { name: new RegExp(usedQuiz.quizId) })
    )
    await screen.findByText(context.studentEmail)

    expect(
      screen.queryByRole('button', { name: 'Editar datos' })
    ).not.toBeInTheDocument()

    const frozenUpdate = await context.service
      .from('quizzes')
      .update({ duration_minutes: 30 })
      .eq('id', usedQuiz.quizId)

    expect(frozenUpdate.error).not.toBeNull()
  })
})
