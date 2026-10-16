import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupLocalTestContext,
  createLocalTestContext,
} from './helpers/localSupabase.js'

let context

describe('encuestas QRS anónimas y aisladas', () => {
  beforeAll(async () => {
    context = await createLocalTestContext()
  })

  afterAll(async () => {
    await cleanupLocalTestContext(context)
  })

  it('valida opciones, publica un token opaco y agrega respuestas anónimas', async () => {
    const anonymous = createClient(context.url, context.anonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })
    const invalidSurvey = await context.teacher.rpc('create_survey', {
      p_question: 'Pregunta inválida',
      p_options: ['Sí', ' sí '],
    })

    expect(invalidSurvey.error).not.toBeNull()

    const created = await context.teacher.rpc('create_survey', {
      p_question: '  ¿Cómo calificas el servicio?  ',
      p_options: ['Excelente', 'Aceptable', 'Deficiente'],
    })

    expect(created.error).toBeNull()
    expect(created.data).toEqual(expect.any(String))

    const surveyId = created.data
    const opened = await context.teacher.rpc('open_survey', {
      p_survey_id: surveyId,
    })

    expect(opened.error).toBeNull()
    expect(opened.data).toHaveLength(1)
    expect(opened.data[0].survey_id).toBe(surveyId)
    expect(opened.data[0].qr_token).toMatch(/^[a-f0-9]{64}$/)

    const qrToken = opened.data[0].qr_token
    const publicSurvey = await anonymous.rpc('get_public_survey', {
      p_qr_token: qrToken,
    })

    expect(publicSurvey.error).toBeNull()
    expect(publicSurvey.data).toEqual([
      {
        survey_id: surveyId,
        question: '¿Cómo calificas el servicio?',
        options: ['Excelente', 'Aceptable', 'Deficiente'],
      },
    ])

    const firstRespondentToken = randomUUID()
    const firstResponse = await anonymous.rpc('submit_survey_response', {
      p_qr_token: qrToken,
      p_respondent_token: firstRespondentToken,
      p_selected_option: 'Excelente',
    })
    const duplicateResponse = await anonymous.rpc(
      'submit_survey_response',
      {
        p_qr_token: qrToken,
        p_respondent_token: firstRespondentToken,
        p_selected_option: 'Aceptable',
      }
    )
    const secondResponse = await anonymous.rpc('submit_survey_response', {
      p_qr_token: qrToken,
      p_respondent_token: randomUUID(),
      p_selected_option: 'Aceptable',
    })
    const invalidResponse = await anonymous.rpc('submit_survey_response', {
      p_qr_token: qrToken,
      p_respondent_token: randomUUID(),
      p_selected_option: 'Opción inexistente',
    })

    expect(firstResponse.error).toBeNull()
    expect(firstResponse.data).toBe(true)
    expect(duplicateResponse.error).toBeNull()
    expect(duplicateResponse.data).toBe(false)
    expect(secondResponse.error).toBeNull()
    expect(secondResponse.data).toBe(true)
    expect(invalidResponse.error).not.toBeNull()

    const ownerResults = await context.teacher.rpc('get_survey_results', {
      p_survey_id: surveyId,
    })
    const foreignResults = await context.student.rpc('get_survey_results', {
      p_survey_id: surveyId,
    })

    expect(ownerResults.error).toBeNull()
    expect(ownerResults.data).toEqual([
      { option_number: 1, option_text: 'Excelente', response_count: 1 },
      { option_number: 2, option_text: 'Aceptable', response_count: 1 },
      { option_number: 3, option_text: 'Deficiente', response_count: 0 },
    ])
    expect(foreignResults.error).not.toBeNull()

    const storedResponses = await context.service
      .from('survey_responses')
      .select('*')
      .eq('survey_id', surveyId)
      .order('created_at')

    expect(storedResponses.error).toBeNull()
    expect(storedResponses.data).toHaveLength(2)
    expect(storedResponses.data[0]).not.toHaveProperty('user_id')
    expect(storedResponses.data[0]).not.toHaveProperty('student_id')
    expect(storedResponses.data[0].respondent_token_hash).not.toBe(
      firstRespondentToken
    )

    const studentSurveyRead = await context.student
      .from('surveys')
      .select('id')
      .eq('id', surveyId)

    expect(studentSurveyRead.error).toBeNull()
    expect(studentSurveyRead.data).toEqual([])

    const closed = await context.teacher.rpc('close_survey', {
      p_survey_id: surveyId,
    })
    const closedPublicRead = await anonymous.rpc('get_public_survey', {
      p_qr_token: qrToken,
    })
    const closedResponse = await anonymous.rpc('submit_survey_response', {
      p_qr_token: qrToken,
      p_respondent_token: randomUUID(),
      p_selected_option: 'Excelente',
    })

    expect(closed.error).toBeNull()
    expect(closed.data).toBe(true)
    expect(closedPublicRead.error).not.toBeNull()
    expect(closedResponse.error).not.toBeNull()
  })
})
