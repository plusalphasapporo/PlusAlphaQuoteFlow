import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

const corsHeaders={
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods":"POST, OPTIONS"
};

const json=(status:number,body:unknown)=>new Response(JSON.stringify(body),{
  status,
  headers:{...corsHeaders,"content-type":"application/json; charset=utf-8","cache-control":"no-store"}
});

const allowedVoiceUrl=(value:string)=>{
  try{
    const u=new URL(value);
    if(u.protocol!=="https:") return false;
    return [
      "callcloud.s3-ap-northeast-1.amazonaws.com",
      "callcloud.s3.ap-northeast-1.amazonaws.com"
    ].includes(u.hostname);
  }catch{return false;}
};

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS") return new Response(null,{status:204,headers:corsHeaders});
  if(req.method!=="POST") return json(405,{error:"method_not_allowed"});

  const supabaseUrl=Deno.env.get("SUPABASE_URL")||"";
  const serviceRoleKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
  if(!supabaseUrl||!serviceRoleKey) return json(500,{error:"server_not_configured"});

  const admin=createClient(supabaseUrl,serviceRoleKey,{auth:{persistSession:false,autoRefreshToken:false}});
  const authHeader=req.headers.get("authorization")||"";
  const token=authHeader.startsWith("Bearer ")?authHeader.slice(7):"";
  if(!token) return json(401,{error:"missing_authorization"});

  const systemCall=token===serviceRoleKey;
  let actorUserId:string|null=null;
  let actorRole="system";

  if(!systemCall){
    const {data:userData,error:userError}=await admin.auth.getUser(token);
    if(userError||!userData?.user) return json(401,{error:"invalid_session"});
    actorUserId=userData.user.id;

    const {data:profile}=await admin.from("profiles")
      .select("role,is_active")
      .eq("user_id",actorUserId)
      .maybeSingle();

    if(!profile||profile.is_active!==true||!["internal_admin","internal_staff"].includes(profile.role)){
      return json(403,{error:"internal_role_required"});
    }
    actorRole=profile.role;
  }

  let input:any={};
  try{input=await req.json();}catch{return json(400,{error:"invalid_json"});}

  const callId=String(input.call_id||"").trim();
  const recordId=String(input.record_id||"").trim();
  const useLatest=input.latest===true;
  if(!callId&&!recordId&&!useLatest) return json(400,{error:"call_id_or_record_id_required"});

  let query=admin.from("callconnect_calls")
    .select("id,record_id,voice_url,duration_seconds,transcript_text,support_ticket_id,received_at,call_ended_at");

  if(callId) query=query.eq("id",callId);
  else if(recordId) query=query.eq("record_id",recordId);
  else query=query.not("voice_url","is",null).order("call_ended_at",{ascending:false}).limit(1);

  const {data:call,error:callError}=useLatest
    ? await query.maybeSingle()
    : await query.maybeSingle();
  if(callError||!call) return json(404,{error:"call_not_found"});

  if(call.transcript_text && !input.force){
    return json(200,{ok:true,skipped:true,reason:"already_transcribed",call_id:call.id,record_id:call.record_id});
  }

  const voiceUrl=String(call.voice_url||"").trim();
  if(!voiceUrl) return json(409,{error:"voice_url_missing"});
  if(!allowedVoiceUrl(voiceUrl)) return json(400,{error:"voice_url_not_allowed"});

  const {data:creds,error:credsError}=await admin.rpc("openai_service_credentials");
  if(credsError) return json(500,{error:"openai_credentials_unavailable"});

  const apiKey=String(creds?.api_key||"").trim();
  const model=String(creds?.transcription_model||"gpt-4o-mini-transcribe").trim();
  if(!apiKey){
    await admin.from("openai_config").update({
      last_api_check_at:new Date().toISOString(),
      last_api_check_status:"not_configured",
      last_api_error:"OpenAI API key is not configured",
      updated_at:new Date().toISOString()
    }).eq("id","default");
    return json(409,{error:"openai_api_key_not_configured"});
  }

  const attemptedAt=new Date().toISOString();
  await admin.from("callconnect_calls").update({
    transcription_attempted_at:attemptedAt,
    transcription_error:null,
    updated_at:attemptedAt
  }).eq("id",call.id);

  try{
    const audioRes=await fetch(voiceUrl,{method:"GET",redirect:"follow"});
    if(!audioRes.ok) throw new Error("recording_download_http_"+audioRes.status);

    const headerSize=Number(audioRes.headers.get("content-length")||"0");
    if(Number.isFinite(headerSize)&&headerSize>25*1024*1024) throw new Error("recording_exceeds_25mb");

    const audioBlob=await audioRes.blob();
    if(audioBlob.size===0) throw new Error("recording_empty");
    if(audioBlob.size>25*1024*1024) throw new Error("recording_exceeds_25mb");

    const form=new FormData();
    form.append("file",audioBlob,"callconnect-"+String(call.record_id||call.id)+".wav");
    form.append("model",model);

    const openaiRes=await fetch("https://api.openai.com/v1/audio/transcriptions",{
      method:"POST",
      headers:{Authorization:"Bearer "+apiKey},
      body:form
    });

    const responseText=await openaiRes.text();
    let result:any=null;
    try{result=JSON.parse(responseText);}catch{result={text:responseText};}

    if(!openaiRes.ok){
      const message=String(result?.error?.message||("OpenAI HTTP "+openaiRes.status)).slice(0,1000);
      throw new Error(message);
    }

    const transcript=String(result?.text||"").trim();
    if(!transcript) throw new Error("openai_empty_transcript");

    const now=new Date().toISOString();
    const usage=result?.usage??null;

    const {error:updateError}=await admin.from("callconnect_calls").update({
      transcript_text:transcript,
      transcript_synced_at:now,
      transcription_provider:"openai",
      transcription_model:model,
      transcription_attempted_at:attemptedAt,
      transcription_error:null,
      transcription_usage:usage,
      updated_at:now
    }).eq("id",call.id);
    if(updateError) throw updateError;

    await admin.from("openai_config").update({
      last_api_check_at:now,
      last_api_check_status:"connected",
      last_api_error:null,
      last_transcription_at:now,
      updated_at:now
    }).eq("id","default");

    await admin.from("audit_logs").insert({
      actor_user_id:actorUserId,
      actor_role:actorRole,
      action:"integration.openai_call_transcribed",
      target_type:"callconnect_call",
      target_id:String(call.id),
      after_data:{
        record_id:call.record_id,
        model,
        duration_seconds:call.duration_seconds,
        transcript_length:transcript.length
      },
      created_at:now
    }).catch(()=>{});

    return json(200,{
      ok:true,
      call_id:call.id,
      record_id:call.record_id,
      model,
      transcript_length:transcript.length,
      transcript_synced_at:now
    });
  }catch(err){
    const message=String(err instanceof Error?err.message:err).slice(0,1000);
    const now=new Date().toISOString();

    await admin.from("callconnect_calls").update({
      transcription_attempted_at:attemptedAt,
      transcription_error:message,
      updated_at:now
    }).eq("id",call.id);

    await admin.from("openai_config").update({
      last_api_check_at:now,
      last_api_check_status:"failed",
      last_api_error:message,
      updated_at:now
    }).eq("id","default");

    return json(502,{error:"transcription_failed",message});
  }
});
