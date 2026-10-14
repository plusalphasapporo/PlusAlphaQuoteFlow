import { withSupabase } from 'npm:@supabase/server'

// Server-side Web research for one support ticket. Never sends customer records
// or attachment contents to the public web search provider.
const reply = (payload: unknown, status = 200) =>
  Response.json(payload, { status, headers: { 'cache-control': 'no-store' } })

const isUuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)

function safeQuery(value: unknown): string {
  return String(value ?? '').normalize('NFKC')
    .replace(/https?:\/\/[^\s]+/gi, '[URL省略]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[メール省略]')
    .replace(/(?:\d{1,3}\.){3}\d{1,3}/g, '[IP省略]')
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\s]+/g, '[パス省略]')
    .replace(/\b(?:\+?\d[\d ()-]{8,}\d)\b/g, '[番号省略]')
    .replace(/\b[A-Za-z0-9]{24,}\b/g, '[識別子省略]')
    .replace(/\s+/g, ' ').trim().slice(0, 300)
}

function outputText(payload: any): string {
  if (typeof payload?.output_text === 'string') return payload.output_text.trim()
  return (payload?.output ?? [])
    .flatMap((x: any) => x.type === 'message' ? (x.content ?? []) : [])
    .filter((x: any) => x.type === 'output_text')
    .map((x: any) => String(x.text ?? ''))
    .join('\n\n').trim()
}

type Source = { title: string; url: string }
function cleanSources(entries: Array<{ title?: unknown; url?: unknown }>): Source[] {
  const seen = new Set<string>()
  const sources: Source[] = []
  for (const entry of entries) {
    const urlString = String(entry?.url ?? '')
    try {
      const u = new URL(urlString)
      if (u.protocol !== 'https:' || urlString.length > 2048 || seen.has(u.href)) continue
      seen.add(u.href)
      sources.push({ title: String(entry?.title || u.hostname).slice(0, 200), url: u.href })
      if (sources.length >= 12) break
    } catch { /* ignore invalid links */ }
  }
  return sources
}

function responseSources(payload: any): Source[] {
  const items: Array<{ title?: unknown; url?: unknown }> = []
  for (const item of payload?.output ?? []) {
    if (item?.type === 'web_search_call') {
      for (const x of item?.action?.sources ?? []) items.push(x)
    }
    if (item?.type === 'message') {
      for (const c of item?.content ?? []) {
        for (const x of c?.annotations ?? []) {
          if (x?.type === 'url_citation') items.push({ url: x.url, title: x.title })
        }
      }
    }
  }
  return cleanSources(items)
}

function cachedParts(body: string) {
  const text = body.match(/(?:^|\n)対応手順\s*[:：]\s*\n([\s\S]*?)(?:\n確認結果\s*[:：]|$)/)?.[1]?.trim() || body
  const refs = body.match(/(?:^|\n)出典\s*[:：]\s*\n([\s\S]*)$/)?.[1] || ''
  const sources = cleanSources(refs.split('\n').map(line => {
    const match = line.match(/^-\s*(.*?)\s+\|\s+(https:\/\/\S+)$/)
    return { title: match?.[1], url: match?.[2] }
  }))
  return { text, sources }
}

async function fingerprint(value: string): Promise<string> {
  const data = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export default {
  fetch: withSupabase({ auth: 'user' }, async (req, ctx) => {
    if (req.method !== 'POST') return reply({ error: 'METHOD_NOT_ALLOWED' }, 405)
    const userId = String(ctx.jwtClaims?.sub || '')
    if (!isUuid(userId)) return reply({ error: 'UNAUTHENTICATED' }, 401)
    const { data: profile, error: profileError } = await ctx.supabase
      .from('profiles').select('role,is_active').eq('user_id', userId).single()
    if (profileError || !profile?.is_active ||
      !['internal_admin', 'internal_staff', 'support_staff'].includes(profile.role)) {
      return reply({ error: 'NOT_ALLOWED' }, 403)
    }

    let body: Record<string, unknown>
    try { body = await req.json() } catch { return reply({ error: 'INVALID_JSON' }, 400) }
    const ticketId = body.ticketId
    if (!isUuid(ticketId)) return reply({ error: 'INVALID_TICKET_ID' }, 400)

    // Query ticket as the signed-in user. A service-role lookup here would
    // permit callers to ask the AI to inspect a ticket they cannot access.
    const { data: ticket, error: ticketError } = await ctx.supabase
      .from('support_tickets')
      .select('id,customer_id')
      .eq('id', ticketId).single()
    if (ticketError || !ticket) return reply({ error: 'TICKET_NOT_FOUND_OR_FORBIDDEN' }, 404)

    // Read-only connection diagnostics for authenticated support users.
    // This never calls a paid AI model and never inserts/updates a record.
    // Do not return the API key, customer data, document IDs or error details.
    if (body.diagnostics === true) {
      const results = await Promise.allSettled([
        ctx.supabaseAdmin.from('knowledge_articles').select('id')
          .eq('category', 'Web詳細調査').limit(1),
        ctx.supabaseAdmin.rpc('openai_service_credentials'),
      ])
      const knowledgeReady = results[0].status === 'fulfilled' && !results[0].value.error
      const aiConfigured = results[1].status === 'fulfilled' &&
        !results[1].value.error && !!String(results[1].value.data?.api_key || '').trim()
      // Optional, non-generating access check against OpenAI's GET /models/{model}.
      // It cannot verify billing credit, rate-limit availability or successful
      // Responses/web_search requests. No API key or raw provider body is returned.
      const checkProvider = body.checkProvider === true
      let modelAccessible: boolean | null = null
      let modelStatus = checkProvider ? 'not_configured' : 'not_checked'
      if (checkProvider && aiConfigured) {
        const creds = results[1].status === 'fulfilled' ? results[1].value.data : null
        const model = String(creds?.analysis_model || '').trim()
        if (!/^[a-zA-Z0-9_.:-]{1,100}$/.test(model)) {
          modelAccessible = false
          modelStatus = 'invalid_model_setting'
        } else {
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 9000)
          try {
            const upstream = await fetch('https://api.openai.com/v1/models/' + encodeURIComponent(model), {
              method: 'GET',
              headers: { Authorization: 'Bearer ' + String(creds?.api_key || '') },
              cache: 'no-store',
              signal: controller.signal,
            })
            modelAccessible = upstream.ok
            modelStatus = upstream.ok ? 'ok' : upstream.status === 401 ? 'invalid_api_key'
              : upstream.status === 403 ? 'model_forbidden'
              : upstream.status === 404 ? 'model_not_found'
              : upstream.status === 429 ? 'provider_limited'
              : upstream.status >= 500 ? 'provider_unavailable'
              : 'provider_error'
          } catch (_err) {
            modelAccessible = false
            modelStatus = 'connection_failed'
          } finally {
            clearTimeout(timeout)
          }
        }
      }
      return reply({
        diagnostics: true,
        ready: knowledgeReady && aiConfigured && (!checkProvider || modelAccessible === true),
        checkedAt: new Date().toISOString(),
        checks: {
          authentication: true,
          ticketAccess: true,
          knowledgeRead: knowledgeReady,
          aiConfigured,
          modelAccessible,
          modelStatus,
        },
        // Explicitly do not imply that model lookup proves billing or generation.
        billingVerified: false,
        generationVerified: false,
      })
    }

    // Reopen previously researched steps even when OpenAI is unavailable.
    // Both read paths are scoped to a ticket that RLS already allowed and to
    // that ticket's customer. Never expose other customers' private drafts.
    const customerTag = 'customer:' + String(ticket.customer_id)
    const savedQuery = (record: any): string => {
      const content = String(record?.body || '')
      const line = content.match(/(?:^|\n)症状・依頼\s*[:：]\s*([^\r\n]*)/)?.[1] || ''
      const title = String(record?.title || '').replace(/^Web調査\s*[:：]\s*/, '')
      return safeQuery(line || title)
    }
    if (body.listRecent === true) {
      const { data: history, error: historyError } = await ctx.supabaseAdmin
        .from('knowledge_articles')
        .select('id,title,body,tags,created_at,is_active')
        .eq('category', 'Web詳細調査')
        .contains('tags', [customerTag])
        .order('created_at', { ascending: false }).limit(24)
      if (historyError) return reply({ error: 'SAVED_GUIDES_UNAVAILABLE' }, 503)
      const seen = new Set<string>()
      const articles: Array<{ id: string; query: string; checkedAt: string; published: boolean }> = []
      for (const item of history || []) {
        if ((item.tags || []).includes('却下')) continue
        const query = savedQuery(item)
        if (query.length < 4) continue
        const normalized = query.toLowerCase()
        if (seen.has(normalized)) continue
        seen.add(normalized)
        articles.push({
          id: String(item.id), query, checkedAt: String(item.created_at || ''),
          published: item.is_active === true,
        })
        if (articles.length >= 8) break
      }
      return reply({ recent: true, articles, noExternalCall: true })
    }
    if (body.reopenId !== undefined) {
      if (!isUuid(body.reopenId)) return reply({ error: 'INVALID_SAVED_GUIDE_ID' }, 400)
      const { data: article, error: articleError } = await ctx.supabaseAdmin
        .from('knowledge_articles')
        .select('id,title,body,tags,created_at,is_active')
        .eq('id', body.reopenId)
        .eq('category', 'Web詳細調査')
        .contains('tags', [customerTag])
        .maybeSingle()
      if (articleError) return reply({ error: 'SAVED_GUIDES_UNAVAILABLE' }, 503)
      if (!article || (article.tags || []).includes('却下')) {
        return reply({ error: 'SAVED_GUIDE_NOT_FOUND' }, 404)
      }
      const lastChecked = new Date(article.created_at).getTime()
      const needsRefresh = !Number.isFinite(lastChecked) ||
        Date.now() - lastChecked > 30 * 24 * 60 * 60 * 1000
      const parts = cachedParts(String(article.body || ''))
      return reply({
        ...parts, query: savedQuery(article), fromCache: true, saved: true,
        needsRefresh, knowledgeId: article.id, checkedAt: article.created_at,
        verifiedByStaff: article.is_active === true, noExternalCall: true,
      })
    }

    // Public web search must require an explicit technical query. Never use
    // the ticket subject, customer name, asset record, internal notes, calls,
    // credentials or attachments as an automatic search fallback.
    if (typeof body.query !== 'string') return reply({ error: 'TECHNICAL_QUERY_REQUIRED' }, 400)
    const query = safeQuery(body.query)
    const meaningful = query.replace(/\[[^\]]+省略\]/g, '').trim()
    if (meaningful.length < 4) return reply({ error: 'TECHNICAL_QUERY_REQUIRED' }, 400)
    const normalized = query.toLowerCase().replace(/\s+/g, ' ')
    const cacheKey = 'web-cache:' + (await fingerprint(String(ticket.customer_id) + '\n' + normalized)).slice(0, 32)

    const { data: found, error: cacheError } = await ctx.supabaseAdmin
      .from('knowledge_articles')
      .select('id,title,body,tags,created_at,is_active')
      .eq('category', 'Web詳細調査')
      .contains('tags', [cacheKey])
      .order('created_at', { ascending: false }).limit(10)
    if (cacheError) return reply({ error: 'CACHE_UNAVAILABLE' }, 503)
    const cached = (found || []).find((x: any) => !(x.tags || []).includes('却下'))
    if (cached && body.refresh !== true) {
      const lastChecked = new Date(cached.created_at).getTime()
      const needsRefresh = !Number.isFinite(lastChecked) ||
        Date.now() - lastChecked > 30 * 24 * 60 * 60 * 1000
      const parts = cachedParts(String(cached.body || ''))
      return reply({
        ...parts, query, fromCache: true, saved: true,
        needsRefresh, knowledgeId: cached.id, checkedAt: cached.created_at,
        verifiedByStaff: cached.is_active === true,
      })
    }

    const { data: creds, error: credsError } =
      await ctx.supabaseAdmin.rpc('openai_service_credentials')
    const apiKey = String(creds?.api_key || '').trim()
    if (credsError || !apiKey) return reply({ error: 'AI_NOT_CONFIGURED' }, 503)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 70000)
    try {
      const upstream = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: String(creds?.analysis_model || 'gpt-5.5'),
          store: false,
          tools: [{ type: 'web_search', search_context_size: 'medium' }],
          tool_choice: 'required',
          include: ['web_search_call.action.sources'],
          reasoning: { effort: 'low' },
          max_output_tokens: 3000,
          input: [
            { role: 'system', content: [{
              type: 'input_text',
              text: 'あなたは企業ITサポート向け技術調査員です。必ず実際にWeb検索してから回答してください。メーカー・OSベンダーの公式資料を優先してください。操作手順は画面名、クリック位置、事前条件、確認結果、うまくいかない時の分岐、注意事項まで日本語で具体的に説明してください。確認できない操作や型番固有の手順は作らず「確認できません」と明記してください。作業の実行を代行したと書かないでください。パスワード、秘密情報、顧客名などを尋ねないでください。回答中に参照資料と確認日を示し、危険な変更や共有印刷ジョブの削除は事前に承認を求めてください。',
            }] },
            { role: 'user', content: [{ type: 'input_text', text: '技術的な症状・検索キーワード: ' + query }] },
          ],
        }),
        signal: controller.signal,
      })
      if (!upstream.ok) {
        // 429 is ambiguous: rate-limited and depleted API credit can share it.
        // Classify only the documented allowlisted error codes; never expose
        // the provider response body, credentials, or user search text in errors.
        if (upstream.status === 429) {
          const providerError = await upstream.json().catch(() => null)
          const code = String(providerError?.error?.code || providerError?.error?.type || '').toLowerCase()
          const quotaCodes = new Set([
            'insufficient_quota', 'credit_balance_exhausted',
            'organization_spend_limit_exceeded', 'project_spend_limit_exceeded',
            'organization_usage_limit_exceeded',
          ])
          const reason = quotaCodes.has(code) ? 'WEB_QUOTA_EXCEEDED'
            : code === 'rate_limit_exceeded' ? 'WEB_RATE_LIMITED'
            : 'WEB_PROVIDER_LIMITED'
          return reply({ error: reason }, 429)
        }
        if (upstream.status === 401 || upstream.status === 403) {
          return reply({ error: 'WEB_PROVIDER_AUTH_ERROR' }, 503)
        }
        if (upstream.status === 404) return reply({ error: 'WEB_MODEL_UNAVAILABLE' }, 503)
        if (upstream.status >= 500) return reply({ error: 'WEB_PROVIDER_UNAVAILABLE' }, 503)
        return reply({ error: 'WEB_RESEARCH_FAILED' }, 502)
      }
      const response = await upstream.json()
      const text = outputText(response).slice(0, 14000)
      const sources = responseSources(response)
      const searched = (response.output || []).some((x: any) => x?.type === 'web_search_call')
      if (!text || !searched || sources.length === 0) {
        return reply({ error: 'NO_VERIFIABLE_WEB_SOURCES' }, 502)
      }

      const checkedAt = new Date().toISOString()
      const formatted = [
        '症状・依頼: ' + query,
        '原因・確認事項: Web検索による技術調査。現場の機器状態は未確認。',
        '対応手順:\n' + text,
        '確認結果: ' + checkedAt.slice(0, 10) + ' にWeb資料を確認。実機での動作確認は未実施。',
        '出典:\n' + sources.map(s => '- ' + s.title.replace(/\|/g, ' ') + ' | ' + s.url).join('\n'),
      ].join('\n\n')
      const { data: saved, error: saveError } = await ctx.supabaseAdmin
        .from('knowledge_articles').insert({
          title: ('Web調査: ' + query).slice(0, 190),
          category: 'Web詳細調査',
          body: formatted,
          audience: 'support',
          tags: ['候補', 'Web調査', 'AI仮保存', cacheKey, 'customer:' + ticket.customer_id],
          is_active: false,
          created_by: userId,
          updated_by: userId,
        }).select('id').single()

      return reply({
        text, sources, query, checkedAt, fromCache: false,
        saved: !saveError, knowledgeId: saved?.id || null,
        saveError: saveError ? 'DRAFT_SAVE_FAILED' : null,
        verifiedByStaff: false, needsRefresh: false,
      })
    } catch (err) {
      const timedOut = err instanceof DOMException && err.name === 'AbortError'
      return reply({ error: timedOut ? 'WEB_RESEARCH_TIMEOUT' : 'WEB_RESEARCH_FAILED' }, 503)
    } finally {
      clearTimeout(timeout)
    }
  }),
}
