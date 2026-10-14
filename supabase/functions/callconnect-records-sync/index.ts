import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (status:number, body:unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers:{...corsHeaders,"content-type":"application/json; charset=utf-8","cache-control":"no-store"},
  });

const textv=(v:unknown,n=1000)=>String(v??"").trim().slice(0,n);
const intv=(v:unknown)=>{ const n=Number.parseInt(String(v??""),10); return Number.isFinite(n)?n:null; };
const normalizePhone=(v:unknown)=>{
  let s=String(v??"").replace(/[^0-9]/g,"");
  if(!s) return null;
  if(s.startsWith("81")&&s.length>=10) s="0"+s.slice(2);
  return s;
};
const inferDirection=(status:number|null)=>{
  if(status===200||status===400) return "outbound";
  if(status===201||status===401||status===402) return "inbound";
  return null;
};
const parseDate=(v:unknown)=>{
  const s=textv(v,100);
  if(!s) return null;
  const d=new Date(s);
  return Number.isNaN(d.getTime())?null:d.toISOString();
};
const tagsText=(v:unknown)=>{
  if(Array.isArray(v)) return v.map(x=>String(x)).join(", ");
  if(v==null) return null;
  if(typeof v==="object") return JSON.stringify(v).slice(0,4000);
  return textv(v,4000)||null;
};

const transcriptToText=(transcribes:any,direction:string|null)=>{
  if(!transcribes||typeof transcribes!=="object"||Array.isArray(transcribes)) return null;
  const whoIsAgent:Record<string,[string,string]>={
    outbound_operator_right:["channel-0","channel-1"],
    outbound_operator_left:["channel-1","channel-0"],
    inbound_operator_right:["channel-0","channel-0"],
    inbound_operator_left:["channel-1","channel-1"],
  };
  const channelMap=direction?whoIsAgent[direction]:undefined;
  const lines:string[]=[];
  let recordingIndex=0;
  for(const [,speech] of Object.entries(transcribes)){
    const phrases=Array.isArray(speech)?speech:[];
    const agentChannel=channelMap?channelMap[recordingIndex===0?0:1]:null;
    for(const phrase of phrases){
      if(!Array.isArray(phrase)||phrase.length<2) continue;
      const body=textv(phrase[1],10000);
      if(!body) continue;
      const speaker=agentChannel?(String(phrase[0])===agentChannel?"担当者":"顧客"):"話者";
      const seconds=Number(phrase[2]);
      const suffix=Number.isFinite(seconds)?" ["+seconds+"秒]":"";
      lines.push(speaker+": "+body+suffix);
    }
    recordingIndex++;
  }
  return lines.length?lines.join("\n"):null;
};

const recordDetailUrl=(recordsUrl:string,recordId:string)=>{
  const u=new URL(recordsUrl);
  u.pathname="/v1/records/"+encodeURIComponent(recordId);
  u.search="";
  u.hash="";
  return u.toString();
};
const allowedRecords=(value:string)=>{
  try{
    const u=new URL(value);
    return u.protocol==="https:" &&
      u.hostname==="nlbhib5563.execute-api.ap-northeast-1.amazonaws.com" &&
      u.pathname.replace(/\/+$/,"")==="/v1/records/search";
  }catch{return false;}
};
const allowedContacts=(value:string)=>{
  try{
    const u=new URL(value);
    return u.protocol==="https:" &&
      u.hostname==="nlbhib5563.execute-api.ap-northeast-1.amazonaws.com" &&
      u.pathname.replace(/\/+$/,"")==="/v1/contacts";
  }catch{return false;}
};

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS") return new Response("ok",{status:200,headers:corsHeaders});
  if(req.method!=="POST") return json(405,{error:"method_not_allowed"});

  const authHeader=req.headers.get("authorization")||"";
  const jwt=authHeader.startsWith("Bearer ")?authHeader.slice(7):"";
  const cronToken=req.headers.get("x-cron-token")||"";

  const supabaseUrl=Deno.env.get("SUPABASE_URL");
  const serviceRoleKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!supabaseUrl||!serviceRoleKey) return json(500,{error:"server_not_configured"});

  const admin=createClient(supabaseUrl,serviceRoleKey,{auth:{persistSession:false,autoRefreshToken:false}});

  let input:any={};
  try{ input=await req.json(); }catch{ input={}; }

  const {data:cfg}=await admin.from("callconnect_config").select("*").eq("id","default").maybeSingle();
  if(!cfg) return json(500,{error:"config_unavailable"});

  const enc=new TextEncoder();
  const digest=async(value:string)=>{
    const bytes=await crypto.subtle.digest("SHA-256",enc.encode(value));
    return Array.from(new Uint8Array(bytes)).map(b=>b.toString(16).padStart(2,"0")).join("");
  };

  const isCron=Boolean(cronToken) && Boolean(cfg.cron_token_hash) &&
    (await digest(cronToken))===String(cfg.cron_token_hash);

  let userData:any={user:null};
  let profile:any={role:"system",is_active:true};

  if(!isCron){
    if(!jwt) return json(401,{error:"missing_session"});
    const {data,error}=await admin.auth.getUser(jwt);
    if(error||!data?.user) return json(401,{error:"invalid_session"});
    userData=data;
    const {data:profileData}=await admin.from("profiles")
      .select("role,is_active")
      .eq("user_id",userData.user.id)
      .maybeSingle();
    if(!profileData||profileData.is_active!==true||!["internal_admin","internal_staff","support_staff"].includes(profileData.role)){
      return json(403,{error:"internal_role_required"});
    }
    profile=profileData;
  }
  const {data:creds,error:credsError}=await admin.rpc("callconnect_service_credentials");
  if(credsError||!cfg) return json(500,{error:"config_unavailable"});

  const apiKey=textv(creds?.api_key,2000);
  const recordsUrl=textv(creds?.records_api_url,2000);
  const contactsUrl=textv(creds?.contacts_api_url,2000);
  if(!apiKey) return json(400,{error:"api_key_not_configured"});
  if(!recordsUrl||!allowedRecords(recordsUrl)) return json(400,{error:"records_api_url_invalid"});
  if(!contactsUrl||!allowedContacts(contactsUrl)) return json(400,{error:"contacts_api_url_invalid"});

  if(isCron||input.mode==="transcript_pending"){
    const cutoff=new Date(Date.now()-24*60*60*1000).toISOString();
    const {data:pending,error:pendingError}=await admin.from("callconnect_calls")
      .select("id,record_id,support_ticket_id,call_ended_at,received_at")
      .is("transcript_text",null)
      .gte("received_at",cutoff)
      .order("received_at",{ascending:false})
      .limit(50);
    if(pendingError) return json(500,{error:"pending_transcripts_unavailable"});

    let saved=0,pendingCount=0,failedCount=0;
    for(const row of pending||[]){
      try{
        const detailRes=await fetch(recordDetailUrl(recordsUrl,String(row.record_id)),{
          method:"GET",
          headers:{"Accept":"application/json","X-Callconnect-Token":apiKey},
        });
        if(!detailRes.ok){ failedCount++; continue; }
        const detail=await detailRes.json().catch(()=>null);
        const transcribes=detail?.transcribes??null;
        const transcribeDirection=textv(detail?.transcribe_direction,100)||null;
        const readableTranscript=transcriptToText(transcribes,transcribeDirection);
        if(!readableTranscript){ pendingCount++; continue; }

        const now=new Date().toISOString();
        const {error:updateError}=await admin.from("callconnect_calls").update({
          transcribes_raw:transcribes,
          transcribe_direction:transcribeDirection,
          transcript_text:readableTranscript,
          transcribes_text:JSON.stringify(transcribes),
          transcript_synced_at:now,
          updated_at:now,
        }).eq("id",row.id);
        if(updateError){ failedCount++; continue; }
        saved++;
      }catch{
        failedCount++;
      }
    }

    const now=new Date().toISOString();
    await admin.from("callconnect_config").update({
      last_records_sync_at:now,
      last_api_check_status:failedCount?"partial":"connected",
      last_api_error:failedCount?("Transcript cron failed for "+failedCount+" record(s)"):null,
      updated_at:now,
    }).eq("id","default");

    const {error: auditError} = await admin.from("audit_logs").insert({
      actor_user_id:null,
      actor_role:"system",
      action:"integration.callconnect_transcript_cron",
      target_type:"integration",
      target_id:"callconnect",
      after_data:{
        checked_count:(pending||[]).length,
        transcript_saved_count:saved,
        transcript_pending_count:pendingCount,
        failed_count:failedCount
      },
      created_at:now,
    });
    if (auditError) {
      console.error("callconnect_transcript_cron_audit_failed", {
        code: auditError.code,
        message: auditError.message,
        hint: auditError.hint,
      });
    }

    return json(200,{
      ok:failedCount===0,
      mode:isCron?"cron_transcript_sync":"authenticated_transcript_sync",
      checked_count:(pending||[]).length,
      transcript_saved_count:saved,
      transcript_pending_count:pendingCount,
      failed_count:failedCount,
      synced_at:now,
    });
  }

  const url=new URL(recordsUrl);
  if(textv(input.word,200)) url.searchParams.set("word",textv(input.word,200));
  if(textv(input.daterange,100)) url.searchParams.set("daterange",textv(input.daterange,100));
  if(textv(input.tel_id,30)) url.searchParams.set("tel_id",textv(input.tel_id,30));
  if(textv(input.user_id,30)) url.searchParams.set("user_id",textv(input.user_id,30));
  if(textv(input.tags,200)) url.searchParams.set("tags",textv(input.tags,200));
  if(textv(input.statuses,100)) url.searchParams.set("statuses",textv(input.statuses,100));

  let records:any[]=[];
  try{
    const res=await fetch(url.toString(),{
      method:"GET",
      headers:{"Accept":"application/json","X-Callconnect-Token":apiKey},
    });
    const body=await res.json().catch(()=>null);
    if(!res.ok){
      await admin.from("callconnect_config").update({
        last_api_check_status:"failed",last_api_error:"Records HTTP "+res.status,updated_at:new Date().toISOString()
      }).eq("id","default");
      return json(502,{error:"callconnect_records_api_error",status:res.status});
    }
    records=Array.isArray(body)?body:(Array.isArray(body?.records)?body.records:[]);
  }catch(err){
    const msg=textv(err instanceof Error?err.message:String(err),500);
    await admin.from("callconnect_config").update({
      last_api_check_status:"failed",last_api_error:msg,updated_at:new Date().toISOString()
    }).eq("id","default");
    return json(502,{error:"callconnect_records_unreachable"});
  }

  const recordIds=records.map(r=>textv(r?.id,100)).filter(Boolean);
  let existingMap=new Map<string,any>();
  if(recordIds.length){
    const {data:existing}=await admin.from("callconnect_calls")
      .select("id,record_id,match_state,matched_customer_id,support_ticket_id,transcript_text,transcript_synced_at")
      .in("record_id",recordIds);
    for(const row of existing||[]) existingMap.set(String(row.record_id),row);
  }

  const [{data:customers},{data:localContacts}]=await Promise.all([
    admin.from("customers").select("id,phone,mobile"),
    admin.from("contacts").select("customer_id,phone,mobile_e164,active").eq("active",true),
  ]);
  const phoneToCustomer=new Map<string,Set<string>>();
  const addLocal=(p:unknown,id:string)=>{
    const n=normalizePhone(p); if(!n) return;
    if(!phoneToCustomer.has(n)) phoneToCustomer.set(n,new Set());
    phoneToCustomer.get(n)!.add(id);
  };
  for(const c of customers||[]){ addLocal(c.phone,c.id); addLocal(c.mobile,c.id); }
  for(const c of localContacts||[]){ addLocal(c.phone,c.customer_id); addLocal(c.mobile_e164,c.customer_id); }

  const contactCache=new Map<string,any>();
  const getContact=async(contactId:string)=>{
    if(!contactId) return null;
    if(contactCache.has(contactId)) return contactCache.get(contactId);
    try{
      const res=await fetch(contactsUrl.replace(/\/+$/,"")+"/"+encodeURIComponent(contactId),{
        method:"GET",
        headers:{"Accept":"application/json","X-Callconnect-Token":apiKey},
      });
      const body=res.ok?await res.json().catch(()=>null):null;
      contactCache.set(contactId,body);
      return body;
    }catch{
      contactCache.set(contactId,null);
      return null;
    }
  };

  let created=0,updated=0,matched=0,unmatched=0,ambiguous=0,failed=0,ticketsCreated=0,transcriptsSaved=0,transcriptsPending=0;
  for(const r of records){
    const recordId=textv(r?.id,100);
    if(!recordId) continue;
    const existing=existingMap.get(recordId)||null;
    const status=intv(r?.status);
    const direction=inferDirection(status);
    const contactId=textv(r?.contact_id,100);
    const contact=contactId?await getContact(contactId):null;

    let transcribes:any=r?.transcribes??null;
    let transcribeDirection=textv(r?.transcribe_direction,100)||null;
    let readableTranscript=transcriptToText(transcribes,transcribeDirection);
    const needsTranscript=Boolean(input.force_transcript)||!textv(existing?.transcript_text,200000);
    if(needsTranscript&&!readableTranscript){
      try{
        const detailRes=await fetch(recordDetailUrl(recordsUrl,recordId),{
          method:"GET",
          headers:{"Accept":"application/json","X-Callconnect-Token":apiKey},
        });
        if(detailRes.ok){
          const detail=await detailRes.json().catch(()=>null);
          transcribes=detail?.transcribes??transcribes;
          transcribeDirection=textv(detail?.transcribe_direction,100)||transcribeDirection;
          readableTranscript=transcriptToText(transcribes,transcribeDirection);
        }
      }catch(_){
        // Transcript conversion can still be pending for several minutes. Keep prior saved text.
      }
    }

    let remotePhone=normalizePhone(contact?.friendly_number)||normalizePhone(contact?.number);
    if(!remotePhone && direction==="outbound") remotePhone=normalizePhone(r?.to);

    let matchState="unmatched";
    let matchedCustomerId:string|null=null;
    if(remotePhone){
      const ids=phoneToCustomer.get(remotePhone);
      if(ids?.size===1){ matchedCustomerId=[...ids][0]; matchState="matched"; }
      else if(ids&&ids.size>1){ matchState="ambiguous"; }
    }
    if(existing?.match_state==="matched_manual"){
      matchState="matched_manual";
      matchedCustomerId=existing.matched_customer_id;
    }

    const callRow:any={
      record_id:recordId,
      record_status:status,
      direction,
      contact_id:contactId||null,
      contact_number:remotePhone||contact?.friendly_number||contact?.number||null,
      contact_name:textv(contact?.name,300)||null,
      contact_company:textv(contact?.company,300)||null,
      contact_email:textv(contact?.email,320)||null,
      used_number:null,
      used_friendly_name:null,
      callconnect_user_id:textv(r?.user_id,100)||null,
      duration_seconds:intv(r?.duration),
      wait_time_seconds:intv(r?.wait_time),
      post_process_duration_seconds:intv(r?.post_process_duration),
      memo:textv(r?.memo,10000)||null,
      tags_text:tagsText(r?.tags),
      voice_url:textv(r?.voice_url,4000)||null,
      call_ended_at:parseDate(r?.created_at),
      matched_customer_id:matchedCustomerId,
      match_state:matchState,
      support_ticket_id:existing?.support_ticket_id||null,
      raw_payload:{source:"records_search",record:r,contact:contact||null},
      received_at:existing?undefined:new Date().toISOString(),
      updated_at:new Date().toISOString(),
    };
    if(callRow.received_at===undefined) delete callRow.received_at;
    if(readableTranscript){
      callRow.transcribes_raw=transcribes;
      callRow.transcribe_direction=transcribeDirection;
      callRow.transcript_text=readableTranscript;
      callRow.transcribes_text=JSON.stringify(transcribes);
      callRow.transcript_synced_at=new Date().toISOString();
    }

    const {error}=await admin.from("callconnect_calls").upsert(callRow,{onConflict:"record_id"});
    if(error){ failed++; continue; }
    if(readableTranscript) transcriptsSaved++;
    else if([200,201].includes(status??-1)) transcriptsPending++;

    if(
      cfg.auto_create_tickets===true &&
      matchedCustomerId &&
      [201,401,402].includes(status??-1) &&
      !existing?.support_ticket_id
    ){
      const {data:assignment}=await admin.from("support_assignments")
        .select("id")
        .eq("customer_id",matchedCustomerId)
        .eq("is_active",true)
        .limit(1)
        .maybeSingle();

      if(assignment){
        const statusLabel=status===201?"着信通話":status===401?"不在着信":"営業時間外着信";
        const ticketNumber="TKT-CC-"+recordId.replace(/[^0-9A-Za-z_-]/g,"");
        const subject="CallConnect "+statusLabel+": "+(
          textv(contact?.company,300)||
          textv(contact?.name,300)||
          remotePhone||
          "電話"
        );
        const description=
          "【受付経路】CallConnect 通話履歴同期\n\n"+
          "通話種別: "+statusLabel+"\n"+
          "電話番号: "+(remotePhone||"未取得")+"\n"+
          "CallConnect Record ID: "+recordId+"\n"+
          "通話時間: "+String(intv(r?.duration)??0)+"秒"+
          (textv(r?.memo,10000)?"\n\nメモ:\n"+textv(r?.memo,10000):"")+
          (tagsText(r?.tags)?"\n\nタグ: "+tagsText(r?.tags):"");

        const {data:ticket,error:ticketError}=await admin.from("support_tickets")
          .upsert({
            customer_id:matchedCustomerId,
            ticket_number:ticketNumber,
            request_type:"inquiry",
            request_details:{
              callconnect_record_id:recordId,
              call_status:status,
              direction,
              contact_number:remotePhone,
              duration_seconds:intv(r?.duration),
              source:"records_search"
            },
            subject,
            description,
            status:"open",
            priority:"normal",
            created_by:userData.user?.id||null
          },{onConflict:"ticket_number"})
          .select("id,ticket_number")
          .single();

        if(!ticketError&&ticket){
          await admin.from("callconnect_calls").update({
            support_ticket_id:ticket.id,
            updated_at:new Date().toISOString()
          }).eq("record_id",recordId);
          ticketsCreated++;
        }
      }
    }

    if(existing) updated++; else created++;
    if(matchState==="matched"||matchState==="matched_manual") matched++;
    else if(matchState==="ambiguous") ambiguous++;
    else unmatched++;
  }

  const now=new Date().toISOString();
  await admin.from("callconnect_config").update({
    last_records_sync_at:now,
    last_api_check_status:failed?"partial":"connected",
    last_api_error:failed?("Records sync failed for "+failed+" record(s)"):null,
    updated_at:now,
  }).eq("id","default");

  await admin.from("audit_logs").insert({
    actor_user_id:userData.user?.id||null,
    actor_role:profile.role,
    action:"integration.callconnect_records_sync",
    target_type:"integration",
    target_id:"callconnect",
    after_data:{
      fetched_count:records.length,created_count:created,updated_count:updated,
      matched_count:matched,unmatched_count:unmatched,ambiguous_count:ambiguous,
      ticket_created_count:ticketsCreated,failed_count:failed,
      transcript_saved_count:transcriptsSaved,transcript_pending_count:transcriptsPending
    },
    created_at:now,
  });

  return json(200,{
    ok:failed===0,
    fetched_count:records.length,
    created_count:created,
    updated_count:updated,
    matched_count:matched,
    unmatched_count:unmatched,
    ambiguous_count:ambiguous,
    ticket_created_count:ticketsCreated,
    transcript_saved_count:transcriptsSaved,
    transcript_pending_count:transcriptsPending,
    failed_count:failed,
    last_records_sync_at:now,
  });
});