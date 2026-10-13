
import { withSupabase } from 'npm:@supabase/server'

type AiAction =
  | 'summarize'
  | 'cause_candidates'
  | 'check_steps'
  | 'reply_draft'
  | 'handoff_draft'
  | 'classify'
  | 'call_summary'
  | 'call_classify'
  | 'incident_diagnose'

const ALLOWED_ACTIONS = new Set<AiAction>([
  'summarize','cause_candidates','check_steps','reply_draft','handoff_draft',
  'classify','call_summary','call_classify','incident_diagnose',
])

function json(body: unknown, status = 200) {
  return Response.json(body, { status })
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function actionInstruction(action: AiAction) {
  switch (action) {
    case 'summarize':
      return '問い合わせ内容を、事実・現在の状態・未確認点に分けて簡潔に要約してください。'
    case 'cause_candidates':
      return '断定せず、原因候補を最大3件、根拠と確認方法つきで提示してください。'
    case 'check_steps':
      return '担当者が安全に確認できる順序で、確認手順を箇条書きで提示してください。'
    case 'reply_draft':
      return '顧客向け返信文案を、断定を避け、次に確認する内容が分かる形で作成してください。自動送信を前提にしないでください。'
    case 'handoff_draft':
      return 'サポート会社から社内担当へ渡す引継ぎ文案を、事実・実施済み確認・残課題に分けて作成してください。'
    case 'classify':
      return '問い合わせ分類と優先度候補を提示してください。最終判断ではなく候補として示してください。'
    case 'call_summary':
      return 'CallConnectの通話文字起こしを中心に、【要件】【顧客が話した事実】【担当者が案内・対応した内容】【未確認・未解決】【次にやること】の5項目で整理してください。文字起こしにない内容は推測で補わず「確認できません」としてください。'
    case 'call_classify':
      return 'CallConnectの通話文字起こしをもとに案件登録候補を作成してください。必ずJSONだけを返してください。形式は {"request_type":"incident|setting_request|inquiry","subject":"短い件名","summary":"問い合わせ内容の要約","error_message":"障害なら確認できた症状・エラー。なければ空文字","requested_setting":"設定依頼なら依頼内容。なければ空文字","current_state":"現在の状態","attempted_actions":"すでに実施・案内した内容","next_action":"次に確認または実施すること","reason":"この分類候補にした根拠"}。文字起こしにない内容は推測せず空文字または「確認できません」としてください。'
    case 'incident_diagnose':
      return '障害案件を写真・案件情報・機器情報・会話履歴・社内ナレッジから解析してください。写真に写っていないことや確認できないことは断定しないでください。必ずJSONだけを返してください。形式は {"observed":["写真や記録から確認できる事実"],"summary":"障害の整理","causes":[{"cause":"原因候補","confidence":"high|medium|low","evidence":"根拠","check":"切り分け方法"}],"steps":[{"step":"実施する確認・対応","why":"理由","stop_if":"中止・自社引継ぎ条件"}],"additional_info":["追加で確認したい情報"],"escalation":"解決しない場合の次の対応","safety":["安全上の注意"]}。危険な分解、感電・火災リスクがある操作、資格やメーカー保守が必要な作業は案内せず、自社担当またはメーカー保守への引継ぎを明示してください。'
  }
}

function extractOutputText(payload: any) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) return payload.output_text.trim()
  const chunks: string[] = []
  for (const item of payload?.output ?? []) {
    for (const content of item?.content ?? []) {
      if (typeof content?.text === 'string' && content.text.trim()) chunks.push(content.text.trim())
    }
  }
  return chunks.join('\n\n').trim()
}

function cleanJsonText(text: string) {
  return text.replace(/^\s*\`\`\`json\s*/i, '').replace(/\s*\`\`\`\s*$/,'').trim()
}

function imageMime(fileName: string) {
  const n=fileName.toLowerCase()
  if(n.endsWith('.png')) return 'image/png'
  if(n.endsWith('.jpg')||n.endsWith('.jpeg')) return 'image/jpeg'
  if(n.endsWith('.webp')) return 'image/webp'
  if(n.endsWith('.gif')) return 'image/gif'
  return null
}

export default {
  fetch: withSupabase({ auth: 'user' }, async (req, ctx) => {
    if (req.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405)

    const actorUserId = String(ctx.jwtClaims?.sub ?? '')
    if (!isUuid(actorUserId)) return json({ error: 'UNAUTHENTICATED' }, 401)

    const { data: profile, error: profileError } = await ctx.supabase
      .from('profiles').select('role,is_active').eq('user_id', actorUserId).single()

    if (profileError || !profile || profile.is_active !== true) return json({ error: 'ACCOUNT_DISABLED_OR_MISSING' }, 403)
    if (!['internal_admin','internal_staff','support_staff'].includes(profile.role)) return json({ error: 'AI_ROLE_NOT_ALLOWED' }, 403)

    let body: Record<string, unknown>
    try { body = await req.json() } catch { return json({ error: 'INVALID_JSON' }, 400) }

    const ticketId = body.ticketId
    const action = body.action as AiAction
    const additionalContext = String(body.additionalContext ?? '').trim().slice(0,8000)

    if (!isUuid(ticketId)) return json({ error: 'INVALID_TICKET_ID' }, 400)
    if (!ALLOWED_ACTIONS.has(action)) return json({ error: 'ACTION_NOT_ALLOWED' }, 400)

    const { data: creds, error: credsError } = await ctx.supabaseAdmin.rpc('openai_service_credentials')
    const apiKey = String(creds?.api_key ?? '').trim()
    const analysisModel = String(creds?.analysis_model ?? 'gpt-5.6-terra').trim()
    if (credsError || !apiKey) return json({ error: 'AI_NOT_CONFIGURED' }, 503)

    const { data: ticket, error: ticketError } = await ctx.supabase
      .from('support_tickets')
      .select('id,ticket_number,subject,description,status,priority,request_type,request_details,customer_id,asset_id,contract_id,created_at,updated_at')
      .eq('id', ticketId).single()

    if (ticketError || !ticket) return json({ error: 'TICKET_NOT_FOUND_OR_FORBIDDEN' }, 404)

    const [customerResult,assetResult,contractResult,messagesResult,callTranscriptResult,knowledgeResult] = await Promise.all([
      ctx.supabase.from('customers').select('id,customer_code,name,status').eq('id', ticket.customer_id).single(),
      ticket.asset_id
        ? ctx.supabase.from('assets').select('id,asset_number,serial_number,model_name,status,warranty_until,installation_location').eq('id', ticket.asset_id).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      ticket.contract_id
        ? ctx.supabase.from('contracts').select('id,contract_number,status,start_date,end_date').eq('id', ticket.contract_id).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      ctx.supabase.from('support_messages').select('id,author_user_id,visibility,body,created_at').eq('ticket_id', ticketId).order('created_at',{ascending:true}).limit(80),
      ctx.supabase.rpc('support_ticket_callconnect_transcripts',{p_ticket_id:ticketId}),
      ctx.supabase.rpc('role_knowledge_articles'),
    ])

    if (customerResult.error) return json({ error: 'CUSTOMER_CONTEXT_UNAVAILABLE' }, 500)

    const safeContext: any = {
      ticket,
      customer: customerResult.data,
      asset: assetResult.data,
      contract: contractResult.data,
      messages: messagesResult.data ?? [],
      callconnect_transcripts: callTranscriptResult.data ?? [],
      additional_context: additionalContext || null,
    }

    let imageInputs: any[] = []
    if(action==='incident_diagnose'){
      // Read attachment metadata as the signed-in user, not as service_role.
      // This enforces support_attachments RLS and prevents support staff from
      // sending internal-only files to the AI provider.
      const allowedVisibility = profile.role==='support_staff'
        ? ['customer','support']
        : ['customer','support','internal']
      const { data: attachments, error: attachmentError } = await ctx.supabase
        .from('support_attachments')
        .select('id,storage_path,file_name,size_bytes,visibility,created_at')
        .eq('ticket_id',ticketId)
        .in('visibility',allowedVisibility)
        .order('created_at',{ascending:false})
        .limit(12)
      if (attachmentError) return json({error:'ATTACHMENT_CONTEXT_UNAVAILABLE'},500)

      const usable=(attachments??[]).filter((a:any)=>imageMime(String(a.file_name||''))).slice(0,4)
      const imageMeta:any[]=[]
      for(const a of usable){
        const signed=await ctx.supabaseAdmin.storage.from('support-attachments').createSignedUrl(a.storage_path,900)
        if(signed.error || !signed.data?.signedUrl) continue
        imageInputs.push({type:'input_image',image_url:signed.data.signedUrl,detail:'high'})
        imageMeta.push({file_name:a.file_name,created_at:a.created_at})
      }
      safeContext.images=imageMeta

      const articles=Array.isArray(knowledgeResult.data)?knowledgeResult.data:[]
      const baseText=[
        ticket.subject||'',ticket.description||'',
        JSON.stringify(ticket.request_details||{}),
        assetResult.data?.model_name||'',additionalContext
      ].join(' ').toLowerCase()
      const scored=articles.map((k:any)=>{
        const hay=[k.title,k.category,(k.tags||[]).join(' '),k.body].join(' ').toLowerCase()
        const terms=baseText.split(/[\s　、。・,\/\\\-:：()（）【】\[\]]+/).filter((x:string)=>x.length>=2).slice(0,30)
        let score=0
        for(const term of terms) if(hay.includes(term)) score++
        return {k,score}
      }).sort((a:any,b:any)=>b.score-a.score).slice(0,8)

      safeContext.knowledge=scored.map((v:any)=>({
        title:v.k.title,category:v.k.category,tags:v.k.tags,body:String(v.k.body||'').slice(0,5000)
      }))
    }

    const requestId=req.headers.get('x-request-id')||crypto.randomUUID()
    const controller=new AbortController()
    const timeout=setTimeout(()=>controller.abort(), action==='incident_diagnose'?45000:25000)

    try{
      const userContent:any[]=[
        {type:'input_text',text:actionInstruction(action)+'\n\n安全な案件コンテキスト:\n'+JSON.stringify(safeContext)}
      ]
      if(action==='incident_diagnose') userContent.push(...imageInputs)

      const response=await fetch('https://api.openai.com/v1/responses',{
        method:'POST',
        headers:{
          Authorization:'Bearer '+apiKey,
          'Content-Type':'application/json',
          'X-Client-Request-Id':requestId,
        },
        body:JSON.stringify({
          model:analysisModel,
          store:false,
          reasoning:{effort: action==='incident_diagnose'?'medium':'low'},
          max_output_tokens: action==='incident_diagnose'?2200:1400,
          input:[
            {role:'system',content:[{type:'input_text',text:
              'あなたはQuoteFlow Cloudの業務サポートAIです。事実と推測を明確に分け、担当者の判断を補助してください。'+
              '写真の内容を過信せず、見えない箇所は見えないと述べてください。顧客への自動送信、解決済み確定、危険作業の実行指示は行いません。'+
              '社内ナレッジが与えられた場合は優先して参照し、案件コンテキストにない情報は断定しないでください。'
            }]},
            {role:'user',content:userContent},
          ],
        }),
        signal:controller.signal,
      })

      if(response.status===429 || response.status>=500){
        await ctx.supabaseAdmin.from('integration_events').insert({
          integration_name:'openai',event_type:'ai_assistant',status:'temporary_unavailable',
          payload:{action,ticket_id:ticketId,model:analysisModel,request_id:requestId},error_message:'HTTP '+response.status,created_by:actorUserId,
        })
        return json({error:'AI_TEMPORARILY_UNAVAILABLE',requestId},503)
      }

      if(!response.ok){
        const errorBody=await response.text()
        await ctx.supabaseAdmin.from('integration_events').insert({
          integration_name:'openai',event_type:'ai_assistant',status:'failed',
          payload:{action,ticket_id:ticketId,model:analysisModel,request_id:requestId},error_message:errorBody.slice(0,500),created_by:actorUserId,
        })
        return json({error:'AI_REQUEST_FAILED',requestId},502)
      }

      const payload=await response.json()
      const text=extractOutputText(payload)
      if(!text) return json({error:'AI_EMPTY_RESPONSE',requestId},502)

      if(action==='call_classify'){
        try{
          const candidate=JSON.parse(cleanJsonText(text))
          const allowedTypes=new Set(['incident','setting_request','inquiry'])
          if(!allowedTypes.has(candidate?.request_type)) throw new Error('invalid request_type')
          return json({candidate:{
            request_type:candidate.request_type,
            subject:String(candidate.subject??'').slice(0,200),
            summary:String(candidate.summary??'').slice(0,5000),
            error_message:String(candidate.error_message??'').slice(0,3000),
            requested_setting:String(candidate.requested_setting??'').slice(0,3000),
            current_state:String(candidate.current_state??'').slice(0,3000),
            attempted_actions:String(candidate.attempted_actions??'').slice(0,3000),
            next_action:String(candidate.next_action??'').slice(0,3000),
            reason:String(candidate.reason??'').slice(0,2000),
          },model:analysisModel,generatedAt:new Date().toISOString(),requestId})
        }catch{return json({error:'AI_INVALID_STRUCTURED_RESPONSE',requestId},502)}
      }

      if(action==='incident_diagnose'){
        try{
          const candidate=JSON.parse(cleanJsonText(text))
          const result={
            observed:Array.isArray(candidate.observed)?candidate.observed.slice(0,12).map((x:any)=>String(x).slice(0,1000)):[],
            summary:String(candidate.summary??'').slice(0,5000),
            causes:Array.isArray(candidate.causes)?candidate.causes.slice(0,5).map((x:any)=>({
              cause:String(x?.cause??'').slice(0,1200),
              confidence:['high','medium','low'].includes(x?.confidence)?x.confidence:'low',
              evidence:String(x?.evidence??'').slice(0,2000),
              check:String(x?.check??'').slice(0,2000),
            })):[],
            steps:Array.isArray(candidate.steps)?candidate.steps.slice(0,10).map((x:any)=>({
              step:String(x?.step??'').slice(0,2000),
              why:String(x?.why??'').slice(0,1500),
              stop_if:String(x?.stop_if??'').slice(0,1500),
            })):[],
            additional_info:Array.isArray(candidate.additional_info)?candidate.additional_info.slice(0,10).map((x:any)=>String(x).slice(0,1200)):[],
            escalation:String(candidate.escalation??'').slice(0,3000),
            safety:Array.isArray(candidate.safety)?candidate.safety.slice(0,10).map((x:any)=>String(x).slice(0,1200)):[],
            image_count:imageInputs.length,
          }

          const now=new Date().toISOString()
          await ctx.supabaseAdmin.from('openai_config').update({
            last_api_check_at:now,last_api_check_status:'connected',last_api_error:null,last_analysis_at:now,updated_at:now
          }).eq('id','default')
          await ctx.supabaseAdmin.from('integration_status').update({
            state:'connected',note:'OpenAI connected / incident analysis active',updated_by:actorUserId,updated_at:now
          }).eq('integration_name','ai')
          await ctx.supabaseAdmin.from('integration_events').insert({
            integration_name:'openai',event_type:'incident_diagnose',status:'success',
            payload:{ticket_id:ticketId,model:analysisModel,request_id:requestId,image_count:imageInputs.length},created_by:actorUserId,
          })

          const { error: saveAnalysisError } = await ctx.supabaseAdmin.rpc('store_ai_incident_analysis',{
            p_ticket_id:ticketId,
            p_result:result,
            p_model:analysisModel,
            p_request_id:requestId,
            p_actor_user_id:actorUserId,
          })
          if(saveAnalysisError){
            await ctx.supabaseAdmin.from('integration_events').insert({
              integration_name:'openai',event_type:'incident_analysis_save',status:'failed',
              payload:{ticket_id:ticketId,model:analysisModel,request_id:requestId},
              error_message:saveAnalysisError.message.slice(0,500),created_by:actorUserId,
            })
          }

          return json({result,model:analysisModel,generatedAt:now,requestId,saved:!saveAnalysisError})
        }catch{
          return json({error:'AI_INVALID_STRUCTURED_RESPONSE',requestId},502)
        }
      }

      await ctx.supabaseAdmin.from('integration_events').insert({
        integration_name:'openai',event_type:'ai_assistant',status:'success',
        payload:{action,ticket_id:ticketId,model:analysisModel,request_id:requestId},created_by:actorUserId,
      })

      return json({text,model:analysisModel,generatedAt:new Date().toISOString(),requestId})
    }catch(error){
      const timedOut=error instanceof DOMException && error.name==='AbortError'
      await ctx.supabaseAdmin.from('integration_events').insert({
        integration_name:'openai',event_type:'ai_assistant',status:timedOut?'timeout':'failed',
        payload:{action,ticket_id:ticketId,model:analysisModel,request_id:requestId},
        error_message:error instanceof Error?error.message.slice(0,500):'unknown error',created_by:actorUserId,
      })
      return json({error:timedOut?'AI_TEMPORARILY_UNAVAILABLE':'AI_REQUEST_FAILED',requestId},503)
    }finally{clearTimeout(timeout)}
  }),
}
