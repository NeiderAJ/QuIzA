import { describe, expect, it, vi } from 'vitest'
import {
  buildProviderRequest,
  generateVariantsWithProvider,
  parseProviderResponse,
  ProviderGenerationError,
} from '../supabase/functions/generate-quiz-variants/provider.ts'

const baseQuestion = {
  statement: '¿Cuál es la respuesta?',
  options: [
    { id: 'A', text: 'Uno' },
    { id: 'B', text: 'Dos' },
    { id: 'C', text: 'Tres' },
    { id: 'D', text: 'Cuatro' },
  ],
  correct_answer: { selected_option: 'A' },
}

function buildVariants() {
  return Array.from({ length: 5 }, (_, index) => ({
    statement: `Variante ${index + 2}`,
    options: baseQuestion.options,
    correct_answer: baseQuestion.correct_answer,
  }))
}

function buildProviderPayload(content, usage = undefined) {
  return {
    choices: [{ message: { content } }],
    usage,
  }
}

describe('adaptador del proveedor de variantes', () => {
  it('solicita JSON Schema estricto con exactamente cinco variantes', () => {
    const request = buildProviderRequest('modelo-prueba', baseQuestion)
    const schema = request.response_format.json_schema.schema

    expect(request.model).toBe('modelo-prueba')
    expect(schema.additionalProperties).toBe(false)
    expect(schema.properties.variants.minItems).toBe(5)
    expect(schema.properties.variants.maxItems).toBe(5)
    expect(request.messages[1].content).toContain(baseQuestion.statement)
  })

  it('devuelve variantes y métricas sin transformar contenido académico', () => {
    const variants = buildVariants()
    const result = parseProviderResponse(
      buildProviderPayload(JSON.stringify({ variants }), {
        prompt_tokens: 21,
        completion_tokens: 34,
      })
    )

    expect(result).toEqual({
      variants,
      inputTokens: 21,
      outputTokens: 34,
    })
  })

  it('rechaza JSON inválido y cantidades distintas de cinco', () => {
    expect(() => parseProviderResponse(buildProviderPayload('{'))).toThrowError(
      expect.objectContaining({ code: 'invalid_provider_json' })
    )
    expect(() =>
      parseProviderResponse(
        buildProviderPayload(JSON.stringify({ variants: buildVariants().slice(1) }))
      )
    ).toThrowError(expect.objectContaining({ code: 'invalid_variant_count' }))
  })

  it('no incorpora el cuerpo ni la clave en errores HTTP', async () => {
    const apiKey = 'sk-test-secret-value'
    const fetchImpl = vi.fn(async () =>
      new Response(`error del proveedor con ${apiKey}`, { status: 429 })
    )

    let capturedError

    try {
      await generateVariantsWithProvider({
        apiKey,
        apiUrl: 'https://provider.example.test/chat/completions',
        model: 'modelo-prueba',
        baseQuestion,
        fetchImpl,
      })
    } catch (error) {
      capturedError = error
    }

    expect(capturedError).toBeInstanceOf(ProviderGenerationError)
    expect(capturedError).toMatchObject({
      code: 'provider_http_error',
      providerStatus: 429,
    })
    expect(capturedError.message).not.toContain(apiKey)
    expect(capturedError.message).not.toContain('error del proveedor')
  })

  it('envía la credencial solo en Authorization y parsea una respuesta válida', async () => {
    const variants = buildVariants()
    const fetchImpl = vi.fn(async (_url, request) => {
      expect(request.headers.Authorization).toBe('Bearer secret-local')
      expect(request.body).not.toContain('secret-local')

      return Response.json(
        buildProviderPayload(JSON.stringify({ variants }))
      )
    })

    const result = await generateVariantsWithProvider({
      apiKey: 'secret-local',
      apiUrl: 'https://provider.example.test/chat/completions',
      model: 'modelo-prueba',
      baseQuestion,
      fetchImpl,
    })

    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(result.variants).toEqual(variants)
  })
})
