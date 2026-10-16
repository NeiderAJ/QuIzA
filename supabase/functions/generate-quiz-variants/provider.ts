export const VARIANT_PROMPT_VERSION = 'quiza-v1.1-2026-10-16'

const responseSchema = {
  name: 'quiza_variants',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['variants'],
    properties: {
      variants: {
        type: 'array',
        minItems: 5,
        maxItems: 5,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['statement', 'options', 'correct_answer'],
          properties: {
            statement: { type: 'string' },
            options: {
              type: 'array',
              minItems: 4,
              maxItems: 4,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'text'],
                properties: {
                  id: { type: 'string', enum: ['A', 'B', 'C', 'D'] },
                  text: { type: 'string' },
                },
              },
            },
            correct_answer: {
              type: 'object',
              additionalProperties: false,
              required: ['selected_option'],
              properties: {
                selected_option: {
                  type: 'string',
                  enum: ['A', 'B', 'C', 'D'],
                },
              },
            },
          },
        },
      },
    },
  },
}

export class ProviderGenerationError extends Error {
  code: string
  providerStatus: number | null

  constructor(
    message: string,
    code: string,
    providerStatus: number | null = null
  ) {
    super(message)
    this.name = 'ProviderGenerationError'
    this.code = code
    this.providerStatus = providerStatus
  }
}

type BaseQuestion = {
  statement: string
  options: unknown
  correct_answer: unknown
}

type GenerateOptions = {
  apiKey: string
  apiUrl: string
  model: string
  baseQuestion: BaseQuestion
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

type ProviderResult = {
  variants: unknown[]
  inputTokens: number | null
  outputTokens: number | null
}

export function buildProviderRequest(model: string, baseQuestion: BaseQuestion) {
  return {
    model,
    temperature: 0.7,
    messages: [
      {
        role: 'system',
        content:
          'Eres un asistente pedagógico. Genera exactamente cinco variantes de selección múltiple equivalentes a la pregunta base. Conserva el concepto y una dificultad aproximada, usa exactamente cuatro opciones A-D, una sola respuesta correcta y evita copiar literalmente la base o repetir variantes. Devuelve únicamente la estructura solicitada.',
      },
      {
        role: 'user',
        content: JSON.stringify({ base_question: baseQuestion }),
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: responseSchema,
    },
  }
}

export function parseProviderResponse(payload: unknown): ProviderResult {
  if (!payload || typeof payload !== 'object') {
    throw new ProviderGenerationError(
      'El proveedor devolvió una respuesta vacía.',
      'invalid_provider_response'
    )
  }

  const response = payload as {
    choices?: Array<{ message?: { content?: unknown } }>
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }
  }
  const content = response.choices?.[0]?.message?.content

  if (typeof content !== 'string') {
    throw new ProviderGenerationError(
      'El proveedor no devolvió contenido estructurado.',
      'missing_provider_content'
    )
  }

  let parsed: { variants?: unknown }

  try {
    parsed = JSON.parse(content)
  } catch {
    throw new ProviderGenerationError(
      'El proveedor devolvió JSON inválido.',
      'invalid_provider_json'
    )
  }

  if (!Array.isArray(parsed.variants) || parsed.variants.length !== 5) {
    throw new ProviderGenerationError(
      'El proveedor no devolvió exactamente cinco variantes.',
      'invalid_variant_count'
    )
  }

  const inputTokens = Number.isInteger(response.usage?.prompt_tokens)
    ? Number(response.usage?.prompt_tokens)
    : null
  const outputTokens = Number.isInteger(response.usage?.completion_tokens)
    ? Number(response.usage?.completion_tokens)
    : null

  return {
    variants: parsed.variants,
    inputTokens,
    outputTokens,
  }
}

export async function generateVariantsWithProvider({
  apiKey,
  apiUrl,
  model,
  baseQuestion,
  fetchImpl = fetch,
  timeoutMs = 60000,
}: GenerateOptions): Promise<ProviderResult> {
  const abortController = new AbortController()
  const timeout = setTimeout(() => abortController.abort(), timeoutMs)

  try {
    const response = await fetchImpl(apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildProviderRequest(model, baseQuestion)),
      signal: abortController.signal,
    })

    if (!response.ok) {
      throw new ProviderGenerationError(
        'El proveedor rechazó la solicitud de generación.',
        'provider_http_error',
        response.status
      )
    }

    return parseProviderResponse(await response.json())
  } catch (error) {
    if (error instanceof ProviderGenerationError) {
      throw error
    }

    if (error instanceof Error && error.name === 'AbortError') {
      throw new ProviderGenerationError(
        'El proveedor excedió el tiempo máximo de respuesta.',
        'provider_timeout'
      )
    }

    throw new ProviderGenerationError(
      'No fue posible comunicarse con el proveedor.',
      'provider_unavailable'
    )
  } finally {
    clearTimeout(timeout)
  }
}
