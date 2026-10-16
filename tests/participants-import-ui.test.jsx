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
let course

describe('carga masiva de participantes', () => {
  beforeAll(async () => {
    context = await createLocalTestContext()
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

  it('previsualiza nombres, normaliza correos y confirma solo filas válidas', async () => {
    const user = userEvent.setup()

    render(<App />)

    await user.click(
      await screen.findByRole('button', {
        name: new RegExp(course.name),
      })
    )
    await user.type(
      screen.getByLabelText('Correos, o filas con nombre y correo'),
      [
        'Ana Torres\tANA@EXAMPLE.TEST',
        'luis@example.test',
        'Ana repetida\tana@example.test',
        'fila inválida',
      ].join('\n')
    )
    await user.click(
      screen.getByRole('button', { name: 'Previsualizar participantes' })
    )

    expect(
      screen.getByText(
        '2 listos para confirmar · 1 duplicado ignorado · 1 inválido'
      )
    ).toBeInTheDocument()
    expect(screen.getByText('Ana Torres')).toBeInTheDocument()
    expect(screen.getByText('Sin nombre')).toBeInTheDocument()
    expect(screen.getByText(/^Revisa:/)).toHaveTextContent('fila inválida')

    await user.click(
      screen.getByRole('button', { name: 'Confirmar 2 participantes' })
    )

    expect(
      await screen.findByText('2 participantes agregados ✅')
    ).toBeInTheDocument()

    const imported = await context.service
      .from('course_authorized_emails')
      .select('email, participant_name')
      .eq('course_id', context.courseId)
      .order('email')

    expect(imported.error).toBeNull()
    expect(imported.data).toEqual([
      { email: 'ana@example.test', participant_name: 'Ana Torres' },
      { email: 'luis@example.test', participant_name: null },
    ])
  })
})
