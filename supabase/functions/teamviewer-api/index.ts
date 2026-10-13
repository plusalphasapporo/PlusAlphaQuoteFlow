import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (status:number, body:unknown) => new Response(JSON.stringify(body), {
  status,
  headers:{...corsHeaders,"content-type":"application/json; charset=utf-8","cache-control":"no-store"},
});

const textv=(v:unknown,n=4000)=>String(v??"").trim().slice(0,n);

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS") return new Response("ok",{status:200,headers:corsHeaders});
  if(req.method!=="POST") return json(405,{error:"method_not_allowed"});

  const authHeader=req.headers.get("authorization")||"";
  const jwt=authHeader.startsWith("Bearer ")?authHeader.slice(7):"";
  if(!jwt) return json(401,{error:"missing_session"});

  const supabaseUrl=Deno.env.get("SUPABASE_URL");
  const serviceRoleKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!supabaseUrl||!serviceRoleKey) return json(500,{error:"server_not_configured"});

  const admin=createClient(supabaseUrl,serviceRoleKey,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:userData,error:userError}=await admin.auth.getUser(jwt);
  if(userError||!userData?.user) return json(401,{error:"invalid_session"});

  // Enforce MFA on the server, independently of the client and table RLS.
  // Claims are signature-verified by Supabase Auth, not decoded untrusted text.
  const {data:claimsData,error:claimsError}=await admin.auth.getClaims(jwt);
  if(claimsError||String(claimsData?.claims?.sub||"")!==String(userData.user.id)){
    return json(401,{error:"invalid_session"});
  }
  if(claimsData?.claims?.aal!=="aal2"){
    return json(403,{error:"mfa_aal2_required"});
  }

  const {data:profile,error:profileError}=await admin.from("profiles")
    .select("role,is_active,company_id,display_name")
    .eq("user_id",userData.user.id)
    .maybeSingle();
  if(profileError||!profile||profile.is_active!==true) return json(403,{error:"active_user_required"});

  const allowedRoles=["internal_admin","internal_staff","support_staff","customer_user"];
  if(!allowedRoles.includes(profile.role)) return json(403,{error:"unsupported_role"});

  // Service-role queries bypass RLS; verify the profile's company is active.
  if(!profile.company_id) return json(403,{error:"active_company_required"});
  const {data:company,error:companyError}=await admin.from("companies")
    .select("is_active").eq("id",profile.company_id).maybeSingle();
  if(companyError||company?.is_active!==true){
    return json(403,{error:"active_company_required"});
  }

  let input:any={};
  try{input=await req.json();}catch{input={};}
  const action=textv(input?.action,50)||"create_session";

  const {data:creds,error:credsError}=await admin.rpc("teamviewer_service_credentials");
  if(credsError) return json(500,{error:"teamviewer_credentials_unavailable"});
  const token=textv(creds?.token,5000);
  const groupName=textv(creds?.group_name,100)||"QuoteFlow Cloud";
  const apiBase=textv(creds?.api_base_url,500)||"https://webapi.teamviewer.com/api/v1";

  let parsedBase:URL;
  try{parsedBase=new URL(apiBase);}catch{return json(500,{error:"teamviewer_api_url_invalid"});}
  if(parsedBase.protocol!=="https:"||parsedBase.hostname!=="webapi.teamviewer.com"||parsedBase.pathname.replace(/\/$/,"")!=="/api/v1"){
    return json(500,{error:"teamviewer_api_url_not_allowed"});
  }

  const tvFetch=async(path:string,init:RequestInit={})=>{
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),15000);
    try{
      const res=await fetch(apiBase.replace(/\/$/,"")+path,{
        ...init,
        headers:{
          "Accept":"application/json",
          "Authorization":"Bearer "+token,
          ...(init.body?{"Content-Type":"application/json"}:{}),
          ...(init.headers||{}),
        },
        signal:controller.signal,
      });
      const raw=await res.text();
      let body:any=null;
      try{body=raw?JSON.parse(raw):null;}catch{body=raw.slice(0,1000);}
      return {res,body};
    }finally{clearTimeout(timeout);}
  };

  if(action==="test"){
    if(profile.role!=="internal_admin") return json(403,{error:"internal_admin_required"});
    if(!token) return json(400,{error:"teamviewer_token_not_configured"});
    try{
      const {res,body}=await tvFetch("/sessions");
      const ok=res.ok;
      const now=new Date().toISOString();
      await admin.from("teamviewer_config").update({
        last_api_check_at:now,
        last_api_check_status:ok?"connected":"failed",
        last_api_error:ok?null:("HTTP "+res.status),
        updated_by:userData.user.id,
        updated_at:now,
      }).eq("id","default");
      await admin.from("integration_status").upsert({
        integration_name:"teamviewer",
        state:ok?"connected":"degraded",
        note:ok?"TeamViewer API connected":"TeamViewer API test failed: HTTP "+res.status,
        updated_by:userData.user.id,
        updated_at:now,
      },{onConflict:"integration_name"});
      if(!ok) return json(502,{ok:false,status:res.status,error:"teamviewer_api_error",details:body});
      return json(200,{ok:true,status:res.status});
    }catch(err){
      const msg=textv(err instanceof Error?err.message:String(err),500);
      const now=new Date().toISOString();
      await admin.from("teamviewer_config").update({
        last_api_check_at:now,last_api_check_status:"failed",last_api_error:msg,
        updated_by:userData.user.id,updated_at:now,
      }).eq("id","default");
      await admin.from("integration_status").upsert({
        integration_name:"teamviewer",state:"degraded",note:"TeamViewer API unreachable",
        updated_by:userData.user.id,updated_at:now,
      },{onConflict:"integration_name"});
      return json(502,{ok:false,error:"teamviewer_api_unreachable"});
    }
  }

  if(!["status","create_session","refresh_session","finish_session","record_result"].includes(action)) return json(400,{error:"unsupported_action"});

  const ticketId=textv(input?.ticket_id,100);
  if(!ticketId) return json(400,{error:"ticket_id_required"});

  const {data:ticket,error:ticketError}=await admin.from("support_tickets")
    .select("id,ticket_number,customer_id,subject,description,status,support_stage")
    .eq("id",ticketId)
    .maybeSingle();
  if(ticketError||!ticket) return json(404,{error:"ticket_not_found"});

  const {data:customer,error:customerError}=await admin.from("customers")
    .select("id,name,email,company_id")
    .eq("id",ticket.customer_id)
    .maybeSingle();
  if(customerError||!customer) return json(404,{error:"customer_not_found"});

  if(profile.role==="customer_user"){
    if(!profile.company_id||String(customer.company_id)!==String(profile.company_id)){
      return json(403,{error:"ticket_not_accessible"});
    }
  }else if(profile.role==="support_staff"){
    const {data:assignment}=await admin.from("support_assignments")
      .select("id")
      .eq("customer_id",ticket.customer_id)
      .eq("support_company_id",profile.company_id)
      .eq("is_active",true)
      .limit(1)
      .maybeSingle();
    if(!assignment) return json(403,{error:"ticket_not_accessible"});
  }

  const {data:latest}=await admin.from("teamviewer_sessions")
    .select("id,session_code,state,end_customer_link,supporter_link,valid_until,end_customer_name,end_customer_email,closed_at,outcome,work_note,completed_at,created_at")
    .eq("ticket_id",ticket.id)
    .order("created_at",{ascending:false})
    .limit(1)
    .maybeSingle();

  const isUsable=(s:any)=>{
    if(!s?.end_customer_link) return false;
    const state=String(s.state||"").toLowerCase();
    if(["closed","expired","ended","deleted"].includes(state)) return false;
    if(s.valid_until){
      const expiry=new Date(s.valid_until).getTime();
      if(Number.isFinite(expiry)&&expiry<=Date.now()) return false;
    }else{
      const created=new Date(s.created_at||0).getTime();
      if(Number.isFinite(created)&&Date.now()-created>30*60*1000) return false;
    }
    return true;
  };

  const safeSession=(s:any)=>{
    if(!s) return null;
    const customerFields={
      id:s.id,
      state:s.state,
      end_customer_link:s.end_customer_link,
      valid_until:s.valid_until,
      created_at:s.created_at,
    };
    // Never expose staff-only session codes, notes or resolution details
    // through customer endpoints. The customer app uses end_customer_link.
    if(profile.role==="customer_user") return customerFields;
    return {
      ...customerFields,
      session_code:s.session_code,
      supporter_link:s.supporter_link,
      end_customer_name:s.end_customer_name,
      end_customer_email:s.end_customer_email,
      closed_at:s.closed_at,
      outcome:s.outcome,
      work_note:s.work_note,
      completed_at:s.completed_at,
    };
  };

  if(action==="status"){
    return json(200,{
      ok:true,
      available:!!token,
      session:isUsable(latest)?safeSession(latest):null,
    });
  }

  if(action==="refresh_session" || action==="finish_session"){
    if(profile.role==="customer_user") return json(403,{error:"support_or_internal_role_required"});
    if(!latest?.session_code) return json(404,{error:"teamviewer_session_not_found"});
    if(!token) return json(400,{error:"teamviewer_token_not_configured"});

    try{
      if(action==="finish_session"){
        const {res:closeRes,body:closeBody}=await tvFetch("/sessions/"+encodeURIComponent(latest.session_code),{
          method:"PUT",
          body:JSON.stringify({state:"Closed"})
        });
        if(!closeRes.ok && closeRes.status!==204){
          return json(502,{ok:false,status:closeRes.status,error:"teamviewer_session_close_failed",details:closeBody});
        }
      }

      const {res,body}=await tvFetch("/sessions/"+encodeURIComponent(latest.session_code));
      if(!res.ok) return json(502,{ok:false,status:res.status,error:"teamviewer_session_refresh_failed",details:body});

      const nextState=textv(body?.state,50)||latest.state||null;
      const isClosed=["closed","ended","expired","deleted"].includes(String(nextState||"").toLowerCase());
      const now=new Date().toISOString();
      const patch:any={
        state:nextState,
        raw_payload:body||{},
        updated_at:now,
      };
      if(isClosed && !latest.closed_at) patch.closed_at=now;

      const {data:updated,error:updateError}=await admin.from("teamviewer_sessions")
        .update(patch)
        .eq("id",latest.id)
        .select("id,session_code,state,end_customer_link,supporter_link,valid_until,end_customer_name,end_customer_email,closed_at,outcome,work_note,completed_at,created_at")
        .single();
      if(updateError) return json(500,{ok:false,error:"teamviewer_session_update_failed"});

      return json(200,{ok:true,session:safeSession(updated)});
    }catch(err){
      return json(502,{ok:false,error:"teamviewer_api_unreachable",message:textv(err instanceof Error?err.message:String(err),500)});
    }
  }

  if(action==="record_result"){
    if(profile.role==="customer_user") return json(403,{error:"support_or_internal_role_required"});
    if(!latest?.id) return json(404,{error:"teamviewer_session_not_found"});

    const outcome=textv(input?.outcome,30);
    const workNote=textv(input?.work_note,4000);
    if(!["resolved","continue","escalate"].includes(outcome)) return json(400,{error:"invalid_outcome"});
    if(!workNote) return json(400,{error:"work_note_required"});

    const now=new Date().toISOString();
    const {data:updated,error:updateError}=await admin.from("teamviewer_sessions")
      .update({
        outcome,
        work_note:workNote,
        completed_by:userData.user.id,
        completed_at:now,
        updated_at:now,
      })
      .eq("id",latest.id)
      .select("id,session_code,state,end_customer_link,supporter_link,valid_until,end_customer_name,end_customer_email,closed_at,outcome,work_note,completed_at,created_at")
      .single();
    if(updateError) return json(500,{ok:false,error:"teamviewer_result_save_failed"});

    await admin.from("audit_logs").insert({
      actor_user_id:userData.user.id,
      actor_role:profile.role,
      action:"integration.teamviewer_result_recorded",
      target_type:"support_ticket",
      target_id:ticket.id,
      after_data:{session_code:latest.session_code,outcome,work_note},
      created_at:now,
    });

    return json(200,{ok:true,session:safeSession(updated)});
  }

  if(ticket.status==="closed") return json(400,{error:"ticket_closed"});
  if(!token) return json(400,{error:"teamviewer_token_not_configured"});

  if(isUsable(latest)&&input?.force_new!==true){
    return json(200,{ok:true,reused:true,session:safeSession(latest)});
  }

  const {data:contact}=await admin.from("contacts")
    .select("name,email,is_primary,active")
    .eq("customer_id",ticket.customer_id)
    .eq("active",true)
    .order("is_primary",{ascending:false})
    .limit(1)
    .maybeSingle();

  const endName=textv(contact?.name||customer.name||profile.display_name||"Customer",100);
  const endEmail=textv(contact?.email||customer.email||userData.user.email||"",254);
  const actionText=textv(input?.action_text,1000);
  const description=textv(
    (ticket.ticket_number?ticket.ticket_number+" / ":"")+
    (ticket.subject||"QuoteFlow support")+
    (actionText?" / "+actionText:""),
    1000
  );

  const payload:any={
    groupname:groupName,
    description,
    end_customer:{name:endName},
  };
  if(endEmail) payload.end_customer.email=endEmail;

  try{
    const {res,body}=await tvFetch("/sessions",{method:"POST",body:JSON.stringify(payload)});
    if(!res.ok){
      await admin.from("teamviewer_config").update({
        last_api_check_at:new Date().toISOString(),
        last_api_check_status:"failed",
        last_api_error:"HTTP "+res.status,
        updated_by:userData.user.id,
        updated_at:new Date().toISOString(),
      }).eq("id","default");
      return json(502,{ok:false,status:res.status,error:"teamviewer_session_create_failed",details:body});
    }

    const code=textv(body?.code||body?.session_code||body?.id,100);
    if(!code) return json(502,{ok:false,error:"teamviewer_session_code_missing"});

    const endCustomerLink=textv(body?.end_customer_link||body?.customer_link||body?.endCustomerLink,4000)||null;
    const supporterLink=textv(body?.supporter_link||body?.supporterLink||body?.supporter_link_web||body?.webclient_link,4000)||null;

    const row={
      ticket_id:ticket.id,
      session_code:code,
      state:textv(body?.state,50)||null,
      group_id:textv(body?.groupid||body?.group_id,100)||null,
      group_name:groupName,
      description:textv(body?.description,2000)||description,
      end_customer_name:textv(body?.end_customer?.name,100)||endName,
      end_customer_email:textv(body?.end_customer?.email,254)||endEmail||null,
      end_customer_link:endCustomerLink,
      supporter_link:supporterLink,
      valid_until:textv(body?.valid_until||body?.validUntil,100)||null,
      created_by:userData.user.id,
      raw_payload:body||{},
      updated_at:new Date().toISOString(),
    };
    const {data:saved,error:saveError}=await admin.from("teamviewer_sessions")
      .upsert(row,{onConflict:"session_code"})
      .select("*")
      .single();
    if(saveError) return json(500,{ok:false,error:"teamviewer_session_save_failed"});

    const now=new Date().toISOString();

    if(profile.role==="customer_user"){
      await admin.from("support_ticket_reads").delete().eq("ticket_id",ticket.id);
      await admin.from("support_messages").insert({
        ticket_id:ticket.id,
        author_user_id:userData.user.id,
        visibility:"customer",
        body:"遠隔サポートを開始しました。担当者の接続をお待ちください。",
        created_at:now,
        updated_at:now,
      });
    }

    await admin.from("support_tickets").update({
      support_stage:"teamviewer_waiting",
      updated_at:now,
    }).eq("id",ticket.id);

    await admin.from("teamviewer_config").update({
      last_api_check_at:now,last_api_check_status:"connected",last_api_error:null,
      updated_by:userData.user.id,updated_at:now,
    }).eq("id","default");
    await admin.from("integration_status").upsert({
      integration_name:"teamviewer",state:"connected",note:"TeamViewer API session created",
      updated_by:userData.user.id,updated_at:now,
    },{onConflict:"integration_name"});
    await admin.from("audit_logs").insert({
      actor_user_id:userData.user.id,
      actor_role:profile.role,
      action:profile.role==="customer_user"?"integration.teamviewer_customer_started":"integration.teamviewer_session_created",
      target_type:"support_ticket",
      target_id:ticket.id,
      after_data:{
        session_code:code,
        group_id:row.group_id,
        valid_until:row.valid_until,
        end_customer_name:row.end_customer_name,
      },
      created_at:now,
    });

    return json(200,{
      ok:true,
      reused:false,
      session:safeSession(saved),
    });
  }catch(err){
    return json(502,{ok:false,error:"teamviewer_api_unreachable",message:textv(err instanceof Error?err.message:String(err),500)});
  }
});