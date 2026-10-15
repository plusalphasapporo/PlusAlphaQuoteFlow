import { withSupabase } from 'npm:@supabase/server'

const corsHeaders={
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods':'POST, OPTIONS'
}

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: corsHeaders })
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

async function checkModel(apiKey: string, model: string, signal: AbortSignal) {
  const response = await fetch('https://api.openai.com/v1/models/' + encodeURIComponent(model), {
    method: 'GET',
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
    signal,
  })

  let payload: any = null
  const text = await response.text()
  try { payload = text ? JSON.parse(text) : null } catch { payload = null }

  if (!response.ok) {
    const message = String(payload?.error?.message || ('OpenAI HTTP ' + response.status)).slice(0, 800)
    const error = new Error(message) as Error & { status?: number }
    error.status = response.status
    throw error
  }

  return {
    id: String(payload?.id || model),
    object: String(payload?.object || 'model'),
  }
}

export default {
  fetch: async (req: Request) => {
    if(req.method==='OPTIONS') return new Response(null,{status:204,headers:corsHeaders});
    return withSupabase({ auth: 'user' }, async (req, ctx) => {
    if (req.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405)

    const actorUserId = String(ctx.jwtClaims?.sub ?? '')
    if (!isUuid(actorUserId)) return json({ error: 'UNAUTHENTICATED' }, 401)

    const { data: profile, error: profileError } = await ctx.supabase
      .from('profiles')
      .select('role,is_active')
      .eq('user_id', actorUserId)
      .single()

    if (profileError || !profile || profile.is_active !== true) {
      return json({ error: 'ACCOUNT_DISABLED_OR_MISSING' }, 403)
    }
    if (profile.role !== 'internal_admin') {
      return json({ error: 'INTERNAL_ADMIN_REQUIRED' }, 403)
    }

    const { data: creds, error: credsError } = await ctx.supabaseAdmin.rpc('openai_service_credentials')
    const apiKey = String(creds?.api_key ?? '').trim()
    const analysisModel = String(creds?.analysis_model ?? 'gpt-5.6-terra').trim()
    const transcriptionModel = String(creds?.transcription_model ?? 'gpt-transcribe').trim()

    if (credsError || !apiKey) {
      return json({ error: 'OPENAI_API_KEY_NOT_CONFIGURED' }, 409)
    }

    const checkedAt = new Date().toISOString()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)

    try {
      const [analysis, transcription] = await Promise.all([
        checkModel(apiKey, analysisModel, controller.signal),
        checkModel(apiKey, transcriptionModel, controller.signal),
      ])

      await ctx.supabaseAdmin.from('openai_config').update({
        last_api_check_at: checkedAt,
        last_api_check_status: 'connected',
        last_api_error: null,
        updated_at: checkedAt,
      }).eq('id', 'default')

      await ctx.supabaseAdmin.from('integration_status').update({
        state: 'connected',
        note: 'OpenAI API connected / analysis and transcription models available',
        updated_by: actorUserId,
        updated_at: checkedAt,
      }).eq('integration_name', 'ai')

      await ctx.supabaseAdmin.from('audit_logs').insert({
        actor_user_id: actorUserId,
        actor_role: profile.role,
        action: 'integration.openai_api_tested',
        target_type: 'integration',
        target_id: 'openai',
        after_data: {
          status: 'connected',
          analysis_model: analysis.id,
          transcription_model: transcription.id,
        },
        created_at: checkedAt,
      })

      return json({
        ok: true,
        status: 'connected',
        analysis_model: analysis.id,
        transcription_model: transcription.id,
        checked_at: checkedAt,
      })
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === 'AbortError'
      const status = Number((error as any)?.status || 0)
      const message = timedOut
        ? 'OpenAI connection test timed out'
        : String(error instanceof Error ? error.message : error).slice(0, 800)
      const failedAt = new Date().toISOString()

      await ctx.supabaseAdmin.from('openai_config').update({
        last_api_check_at: failedAt,
        last_api_check_status: 'failed',
        last_api_error: message,
        updated_at: failedAt,
      }).eq('id', 'default')

      await ctx.supabaseAdmin.from('integration_status').update({
        state: 'manual',
        note: 'OpenAI API connection test failed',
        updated_by: actorUserId,
        updated_at: failedAt,
      }).eq('integration_name', 'ai')

      await ctx.supabaseAdmin.from('audit_logs').insert({
        actor_user_id: actorUserId,
        actor_role: profile.role,
        action: 'integration.openai_api_test_failed',
        target_type: 'integration',
        target_id: 'openai',
        after_data: { status: 'failed', http_status: status || null },
        created_at: failedAt,
      })

      if (status === 401 || status === 403) {
        return json({ error: 'OPENAI_AUTH_FAILED', message }, 502)
      }
      if (status === 404) {
        return json({ error: 'OPENAI_MODEL_UNAVAILABLE', message }, 502)
      }
      return json({ error: timedOut ? 'OPENAI_TEST_TIMEOUT' : 'OPENAI_TEST_FAILED', message }, 502)
    } finally {
      clearTimeout(timeout)
    }
    })(req)
  },
}
