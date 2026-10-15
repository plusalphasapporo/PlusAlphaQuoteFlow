import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

const corsHeaders={
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods":"POST, OPTIONS"
};
const json=(status:number,body:unknown)=>new Response(JSON.stringify(body),{
  status,headers:{...corsHeaders,"content-type":"application/json; charset=utf-8","cache-control":"no-store"}
});
const phone=(v:unknown)=>{
  let s=String(v??"").replace(/[^0-9]/g,"");
  if(s.startsWith("81")&&s.length>=10)s="0"+s.slice(2);
  return s;
};
const textv=(v:unknown,n=500)=>String(v??"").trim().slice(0,n);
const allowed=(value:string)=>{
  try{
    const u=new URL(value);
    return u.protocol==="https:" &&
      u.hostname==="nlbhib5563.execute-api.ap-northeast-1.amazonaws.com" &&
      u.pathname.replace(/\/+$/,"")==="/v1/contacts";
  }catch{return false;}
};

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:corsHeaders});
  if(req.method!=="POST")return json(405,{error:"method_not_allowed"});

  const auth=req.headers.get("authorization")||"";
  const jwt=auth.startsWith("Bearer ")?auth.slice(7):"";
  if(!jwt)return json(401,{error:"missing_session"});

  const supabaseUrl=Deno.env.get("SUPABASE_URL");
  const serviceKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!supabaseUrl||!serviceKey)return json(500,{error:"server_not_configured"});
  const admin=createClient(supabaseUrl,serviceKey,{auth:{persistSession:false,autoRefreshToken:false}});

  const {data:userData}=await admin.auth.getUser(jwt);
  if(!userData?.user)return json(401,{error:"invalid_session"});
  const {data:profile}=await admin.from("profiles").select("role,is_active").eq("user_id",userData.user.id).maybeSingle();
  if(!profile||profile.is_active!==true||!["internal_admin","internal_staff"].includes(profile.role)){
    return json(403,{error:"internal_role_required"});
  }

  let payload:any={};
  try{payload=await req.json();}catch{return json(400,{error:"invalid_json"});}
  const customerId=textv(payload.customer_id,80);
  if(!customerId)return json(400,{error:"customer_id_required"});

  const [{data:customer},{data:contacts},{data:cfg},{data:creds}]=await Promise.all([
    admin.from("customers").select("id,customer_code,name,representative_name,phone,mobile,email,postal_code,address1,address2").eq("id",customerId).maybeSingle(),
    admin.from("contacts").select("name,email,phone,mobile_e164,is_primary,active").eq("customer_id",customerId).eq("active",true).order("is_primary",{ascending:false}),
    admin.from("callconnect_config").select("contacts_create_api_url,contacts_api_url").eq("id","default").maybeSingle(),
    admin.rpc("callconnect_service_credentials")
  ]);
  if(!customer)return json(404,{error:"customer_not_found"});
  const apiKey=textv(creds?.api_key,1000);
  const endpoint=textv(cfg?.contacts_create_api_url||cfg?.contacts_api_url,1000);
  if(!apiKey)return json(200,{ok:false,error:"api_key_not_configured"});
  if(!endpoint||!allowed(endpoint))return json(200,{ok:false,error:"contacts_create_url_invalid"});

  const address=[customer.postal_code?("〒"+textv(customer.postal_code,20)):"",textv(customer.address1,250),textv(customer.address2,250)].filter(Boolean).join(" ");
  const entries:any[]=[];
  const push=(num:unknown,name:unknown,email:unknown)=>{
    const p=phone(num); if(!p||entries.some(x=>x.number===p))return;
    entries.push({number:p,name:textv(name,200)||textv(customer.name,200),email:textv(email,320)||textv(customer.email,320)});
  };
  const primary=(contacts||[]).find((x:any)=>x.is_primary)||(contacts||[])[0];
  push(customer.phone,customer.representative_name||customer.name,customer.email);
  push(customer.mobile,customer.representative_name||customer.name,customer.email);
  if(primary){push(primary.phone,primary.name,primary.email);push(primary.mobile_e164,primary.name,primary.email);}
  for(const ct of contacts||[]){push(ct.phone,ct.name,ct.email);push(ct.mobile_e164,ct.name,ct.email);}

  if(!entries.length)return json(200,{ok:true,skipped:true,reason:"no_phone",created_count:0,duplicate_count:0,failed_count:0});

  const results:any[]=[];
  for(const e of entries){
    const form=new URLSearchParams();
    form.set("friendly_number",e.number);
    if(e.name)form.set("name",e.name);
    form.set("company",textv(customer.name,300));
    if(e.email)form.set("email",e.email);
    if(address)form.set("address",address);
    // Customer links never bypass QuoteFlow login, MFA, or role-based data access.
    // For production, configure QUOTEFLOW_CUSTOMER_LINK_ORIGIN explicitly.
    const linkOrigin=textv(
      Deno.env.get("QUOTEFLOW_CUSTOMER_LINK_ORIGIN")||
      "https://quoteflow-cloud-staging-git-5459e1-nijiiroclassflat-s-projects.vercel.app",300
    );
    const customerLink=new URL("/",linkOrigin);
    if(customerLink.protocol!=="https:"||customerLink.username||customerLink.password){
      return json(500,{error:"customer_link_origin_invalid"});
    }
    customerLink.searchParams.set("qf_customer",String(customer.id));
    form.set("memo",
      "QuoteFlow 顧客番号: "+(textv(customer.customer_code,80)||"未採番")+
      "\nQuoteFlow 顧客カルテ: "+customerLink.toString()
    );

    try{
      const res=await fetch(endpoint,{
        method:"POST",
        headers:{"Accept":"application/json","Content-Type":"application/x-www-form-urlencoded","X-Callconnect-Token":apiKey},
        body:form.toString()
      });
      const body=await res.json().catch(()=>null);
      const msg=textv(body?.message||body?.error,300);
      if(res.status===201)results.push({number:e.number,status:"created",id:body?.id??null});
      else if(res.status===400&&msg.includes("登録済み"))results.push({number:e.number,status:"duplicate"});
      else results.push({number:e.number,status:"failed",http_status:res.status,error:msg||"CallConnect API error"});
    }catch(err){
      results.push({number:e.number,status:"failed",error:textv(err instanceof Error?err.message:String(err),300)});
    }
  }

  const created=results.filter(x=>x.status==="created").length;
  const duplicate=results.filter(x=>x.status==="duplicate").length;
  const failed=results.filter(x=>x.status==="failed").length;
  await admin.from("callconnect_config").update({
    last_contacts_sync_at:new Date().toISOString(),
    last_api_check_status:failed?"partial":"connected",
    last_api_error:failed?textv(results.find(x=>x.status==="failed")?.error,500):null,
    updated_at:new Date().toISOString()
  }).eq("id","default");
  await admin.from("audit_logs").insert({
    actor_user_id:userData.user.id,actor_role:profile.role,
    action:"integration.callconnect_customer_sync",target_type:"customer",target_id:customerId,
    after_data:{attempted_count:results.length,created_count:created,duplicate_count:duplicate,failed_count:failed},
    created_at:new Date().toISOString()
  });

  return json(200,{ok:failed===0,created_count:created,duplicate_count:duplicate,failed_count:failed,results});
});