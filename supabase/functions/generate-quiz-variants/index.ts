/* global Deno */

import { createClient } from 'npm:@supabase/supabase-js@2.112.3'
import {
  generateVariantsWithProvider,
  ProviderGenerationError,
  VARIANT_PROMPT_VERSION,
} from './provider.ts'

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  corsHeaders: Record<string, string>
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  })
}

function getCorsHeaders(request: Request) {
  const origin = request.headers.get('Origin')

  if (!origin) {
    return {}
  }

  const allowedOrigins = (Deno.env.get('QUIZA_ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((allowedOrigin) => allowedOrigin.trim())
    .filter(Boolean)

  if (!allowedOrigins.includes(origin)) {
    return null
  }

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers':
      'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}

function requireEnvironment(name: string) {
  const value = Deno.env.get(name)?.trim()

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }

  return value
}

Deno.serve(async (request: Request) => {
  const corsHeaders = getCorsHeaders(request)

  if (!corsHeaders) {
    return jsonResponse({ error: 'Origen no autorizado.' }, 403, {})
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Método no permitido.' }, 405, corsHeaders)
  }

  const authorization = request.headers.get('Authorization')

  if (!authorization?.startsWith('Bearer ')) {
    return jsonResponse({ error: 'Autenticación requerida.' }, 401, corsHeaders)
  }

  let requestBody: {
    baseQuestionId?: unknown
    variantQuestionId?: unknown
  }

  try {
    const rawBody = await request.text()

    if (rawBody.length > 4096) {
      return jsonResponse(
        { error: 'Solicitud demasiado grande.' },
        413,
        corsHeaders
      )
    }

    requestBody = JSON.parse(rawBody)
  } catch {
    return jsonResponse({ error: 'Solicitud JSON inválida.' }, 400, corsHeaders)
  }

  const baseQuestionId =
    typeof requestBody.baseQuestionId === 'string' &&
    uuidPattern.test(requestBody.baseQuestionId)
      ? requestBody.baseQuestionId
      : null
  const variantQuestionId =
    typeof requestBody.variantQuestionId === 'string' &&
    uuidPattern.test(requestBody.variantQuestionId)
      ? requestBody.variantQuestionId
      : null

  if (
    Number(Boolean(baseQuestionId)) + Number(Boolean(variantQuestionId)) !== 1
  ) {
    return jsonResponse(
      { error: 'Envía una pregunta base o una variante válida, no ambas.' },
      400,
      corsHeaders
    )
  }

  let runId: string | null = null
  let actorUserId: string | null = null
  const startedAt = Date.now()

  try {
    const supabaseUrl = requireEnvironment('SUPABASE_URL')
    const anonKey = requireEnvironment('SUPABASE_ANON_KEY')
    const serviceRoleKey = requireEnvironment('SUPABASE_SERVICE_ROLE_KEY')
    const provider = Deno.env.get('QUIZA_LLM_PROVIDER')?.trim() || 'openai'
    const model = requireEnvironment('QUIZA_LLM_MODEL')
    const apiUrl = requireEnvironment('QUIZA_LLM_API_URL')
    const apiKey = requireEnvironment('QUIZA_LLM_API_KEY')

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser()

    if (userError || !user) {
      return jsonResponse({ error: 'Sesión no válida.' }, 401, corsHeaders)
    }

    actorUserId = user.id

    const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const isRegeneration = Boolean(variantQuestionId)
    const reservationRpc = isRegeneration
      ? 'reserve_variant_regeneration'
      : 'reserve_variant_generation'
    const reservationParameters = isRegeneration
      ? {
          p_actor_user_id: actorUserId,
          p_target_question_id: variantQuestionId,
          p_provider: provider,
          p_model: model,
          p_prompt_version: VARIANT_PROMPT_VERSION,
        }
      : {
          p_actor_user_id: actorUserId,
          p_base_question_id: baseQuestionId,
          p_provider: provider,
          p_model: model,
          p_prompt_version: VARIANT_PROMPT_VERSION,
        }
    const { data: reservationRows, error: reservationError } =
      await serviceClient.rpc(reservationRpc, reservationParameters)

    if (reservationError || !reservationRows?.[0]) {
      return jsonResponse(
        {
          error:
            reservationError?.message ??
            'No fue posible reservar la generación de variantes.',
        },
        409,
        corsHeaders
      )
    }

    const reservation = reservationRows[0]
    runId = reservation.run_id
    const providerResult = await generateVariantsWithProvider({
      apiKey,
      apiUrl,
      model,
      baseQuestion: {
        statement: reservation.statement,
        options: reservation.options,
        correct_answer: reservation.correct_answer,
      },
      existingVariants: reservation.existing_variants ?? [],
      variantCount: isRegeneration ? 1 : 5,
    })
    const latencyMs = Date.now() - startedAt
    const completionRpc = isRegeneration
      ? 'complete_variant_regeneration'
      : 'complete_variant_generation'
    const { data: completionRows, error: completionError } =
      await serviceClient.rpc(completionRpc, {
        p_actor_user_id: actorUserId,
        p_run_id: runId,
        p_variants: providerResult.variants,
        p_input_tokens: providerResult.inputTokens,
        p_output_tokens: providerResult.outputTokens,
        p_latency_ms: latencyMs,
        p_result_metadata: { provider_status: 'success' },
      })

    if (completionError || !completionRows?.[0]) {
      throw new ProviderGenerationError(
        completionError?.message ??
          'No fue posible validar y guardar las variantes.',
        'variant_persistence_failed'
      )
    }

    return jsonResponse(
      {
        runId,
        quizId: completionRows[0].quiz_id,
        slotNumber: completionRows[0].slot_number,
        variantsInserted: isRegeneration
          ? 1
          : completionRows[0].variants_inserted,
        variantNumber: completionRows[0].variant_number ?? null,
      },
      200,
      corsHeaders
    )
  } catch (error) {
    const latencyMs = Date.now() - startedAt
    const errorCode =
      error instanceof ProviderGenerationError
        ? error.code
        : 'variant_generation_failed'
    const safeMessage =
      error instanceof ProviderGenerationError
        ? error.message
        : 'La generación de variantes no está configurada o no está disponible.'

    if (runId && actorUserId) {
      try {
        const serviceClient = createClient(
          requireEnvironment('SUPABASE_URL'),
          requireEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
          { auth: { autoRefreshToken: false, persistSession: false } }
        )

        await serviceClient.rpc('fail_variant_generation', {
          p_actor_user_id: actorUserId,
          p_run_id: runId,
          p_error_message: safeMessage,
          p_latency_ms: latencyMs,
          p_result_metadata: {
            provider_status: 'error',
            error_code: errorCode,
          },
        })
      } catch {
        // The original failure is returned; no credential or provider payload
        // is logged if closing the reservation also fails.
      }
    }

    const status =
      error instanceof ProviderGenerationError &&
      error.code === 'variant_persistence_failed'
        ? 422
        : 502

    return jsonResponse({ error: safeMessage, code: errorCode }, status, corsHeaders)
  }
})
