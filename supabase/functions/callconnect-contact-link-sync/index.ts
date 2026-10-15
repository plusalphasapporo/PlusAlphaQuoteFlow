import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createClient} from "https://esm.sh/@supabase/supabase-js@2.95.0";
import {buildPlan,publicPlanItem,summarize,STAGING_ORIGIN,parseContactsPage,decideContactsPage,fingerprintPlanItem,remotePhones,prepareMemo} from "./logic.mjs";
const headers={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS","Cache-Control":"no-store"};
const json=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers:{...headers,"Content-Type":"application/json"}});
Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers});
 if(req.method!=="POST")return json(405,{error:"method_not_allowed"});
 const jwt=(req.headers.get("authorization")||"").replace(/^Bearer /,"");
 if(!jwt)return json(401,{error:"missing_session"});
 const url=Deno.env.get("SUPABASE_URL"),secret=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
 if(!url||!secret)return json(503,{error:"server_not_configured"});
 const admin=createClient(url,secret,{auth:{persistSession:false,autoRefreshToken:false}});
 const {data:{user},error:userError}=await admin.auth.getUser(jwt);
 if(userError||!user)return json(401,{error:"invalid_session"});
 const {data:profile}=await admin.from("profiles").select("role,is_active").eq("user_id",user.id).maybeSingle();
 if(!profile?.is_active||profile.role!=="internal_admin")return json(403,{error:"administrator_required"});
 // The user's verified MFA level is read from their signed JWT, not profile metadata.
 let claim:any={};try{claim=JSON.parse(atob(jwt.split(".")[1].replace(/-/g,"+").replace(/_/g,"/")));}catch{return json(401,{error:"invalid_session"});}
 if(claim.aal!=="aal2")return json(403,{error:"aal2_required"});
 let input:any={};try{input=await req.json();}catch{return json(400,{error:"invalid_json"});}
 if(!["preview","apply"].includes(input.mode))return json(400,{error:"invalid_mode"});
 // Never allow a remote write from the page load, poller or an implicit action.
 // Only an internal administrator with MFA, an explicit selection and a
 // separate user confirmation can reach the update code below.
 if(input.mode==="apply" && Deno.env.get("CALLCONNECT_CONTACT_WRITES_ENABLED")!=="true")return json(403,{error:"contact_writes_disabled_pending_vendor_verification"});
 if(input.mode==="apply" && (
   input.confirmed!==true||!Array.isArray(input.targets)||
   input.targets.length<1||input.targets.length>20
 ))return json(400,{error:"explicit_confirmation_and_1_to_20_targets_required"});
 const [{data:cfg},{data:creds},{data:customers,error:ce},{data:contacts,error:pe}]=await Promise.all([
   admin.from("callconnect_config").select("contacts_api_url").eq("id","default").maybeSingle(),
   admin.rpc("callconnect_service_credentials"),
   admin.from("customers").select("id,customer_code,name,phone,mobile").limit(1000),
   admin.from("contacts").select("customer_id,phone,mobile_e164,active").eq("active",true).limit(2000)
 ]);
 if(ce||pe||!cfg||!creds?.api_key)return json(503,{error:"matching_data_unavailable"});
 // A truncated customer list makes one-to-one matching unsafe.
 if((customers||[]).length>=1000||(contacts||[]).length>=2000)return json(409,{error:"local_data_limit_review_required"});
 let endpoint:URL;
 try{
   endpoint=new URL(cfg.contacts_api_url);
   if(endpoint.protocol!=="https:"||endpoint.hostname!=="nlbhib5563.execute-api.ap-northeast-1.amazonaws.com"||endpoint.pathname.replace(/\/+$/,"")!=="/v1/contacts")
     throw Error("invalid_host");
 }catch{return json(400,{error:"contacts_url_invalid"});}
 // Preview is intentionally bounded and read-only until complete, reliable
 // pagination and the vendor's non-destructive update API have been verified.
 // The CallConnect REST API supports per_page/page for contacts.
 // Scan every page; never show a partial match result as a complete inventory.
 // Keep a hard cap to bound the request and fail closed if it is exceeded.
 const list:any[]=[];
 const ids=new Set<string>();
 let finished=false;
 for(let page=1;page<=10;page++){
   const pageUrl=new URL(endpoint.toString());
   pageUrl.searchParams.set("per_page","100");
   pageUrl.searchParams.set("page",String(page));
   const response=await fetch(pageUrl.toString(),{
     headers:{"Accept":"application/json","X-Callconnect-Token":String(creds.api_key)},
     signal:AbortSignal.timeout(15000)
   }).catch(()=>null);
   if(!response)return json(502,{error:"contacts_lookup_timeout",page});
   if(!response.ok)return json(502,{error:"contacts_lookup_failed",http_status:response.status,page});
   const raw:any=await response.json().catch(()=>null);
   const batch=parseContactsPage(raw);
   if(!batch)return json(422,{error:"unknown_contacts_response_shape",page});
   if(batch.length>100)return json(422,{error:"unexpected_contacts_page_size",page});
   for(const row of batch){
     const id=String(row?.id??'').trim();
     if(!/^[1-9][0-9]{0,17}$/.test(id))return json(422,{error:"contact_id_format_unverified",page});
     if(ids.has(id))return json(409,{error:"contact_pagination_duplicate",page});
     ids.add(id);
     list.push(row);
   }
   const decision=decideContactsPage(raw,batch.length,list.length);
   if(decision.error)return json(409,{error:decision.error,page,received:list.length});
   if(decision.done){
     finished=true;
     break;
   }
 }
 if(!finished)return json(409,{error:"contacts_exceed_safe_scan_limit",limit:1000});
 const origin=Deno.env.get("QUOTEFLOW_CUSTOMER_LINK_ORIGIN")||STAGING_ORIGIN;
 let plan;
 try{plan=buildPlan(list,customers,contacts,origin);}catch{return json(422,{error:"contact_preview_validation_failed"});}

 if(input.mode==="preview"){
   const items=await Promise.all(plan.map(async item=>{
     const base=publicPlanItem(item);
     return item.status==="eligible"
       ? {...base,confirmation_token:await fingerprintPlanItem(item)}
       : base;
   }));
   return json(200,{
     ok:true,mode:"preview",write_enabled:true,requires_explicit_confirmation:true,
     contact_count:list.length,counts:summarize(plan),items
   });
 }

 // Approved contact IDs and hashes are untrusted hints. Recompute matches
 // against fresh local and remote data, and re-GET each selected contact.
 const selected=new Set<string>();
 for(const target of input.targets){
   const id=String(target?.contact_id??"").trim();
   if(!/^[1-9][0-9]{0,17}$/.test(id)||
      !/^[0-9a-f]{64}$/.test(String(target?.confirmation_token??""))||
      selected.has(id))return json(400,{error:"invalid_or_duplicate_confirmation_target"});
   selected.add(id);
 }
 const byId=new Map(plan.map(item=>[item.contact_id,item]));
 const results:any[]=[];
 const apiHeaders={
   "Accept":"application/json",
   "X-Callconnect-Token":String(creds.api_key)
 };
 for(const target of input.targets){
   const id=String(target.contact_id);
   const item=byId.get(id);
   if(!item||item.status!=="eligible"||!item.next_memo||!item.customer_id){
     results.push({contact_id:id,status:"not_eligible"});
     continue;
   }
   const actualToken=await fingerprintPlanItem(item);
   if(actualToken!==String(target.confirmation_token)){
     results.push({contact_id:id,status:"preview_expired"});
     continue;
   }
   const detailUrl=new URL(endpoint.origin+endpoint.pathname.replace(/\/+$/,"")+"/"+encodeURIComponent(id));
   const readDetail=async()=>{
     const response=await fetch(detailUrl.toString(),{
       headers:apiHeaders,signal:AbortSignal.timeout(15000)
     }).catch(()=>null);
     if(!response?.ok)return null;
     const raw:any=await response.json().catch(()=>null);
     const obj=raw?.contact??raw?.data??raw;
     return obj&&typeof obj==="object"&&!Array.isArray(obj)&&String(obj.id)===id ? obj:null;
   };
   const before=await readDetail();
   if(!before){
     results.push({contact_id:id,status:"verification_failed"});
     continue;
   }
   // Race/conflict check: only update if memo, phone and remote timestamp
   // still match the full-inventory preview.
   const currentPhones=remotePhones(before).sort();
   const approvedPhones=[...(item.phones||[])].sort();
   if(String(before.memo??"")!==String(item.existing_memo)||
      JSON.stringify(currentPhones)!==JSON.stringify(approvedPhones)||
      (item.remote_updated_at&&String(before.updated_at??"")!==item.remote_updated_at)){
     results.push({contact_id:id,status:"remote_changed"});
     continue;
   }
   if(prepareMemo(before.memo,{id:item.customer_id,customer_code:item.customer_code},item.link).status!=="eligible"){
     results.push({contact_id:id,status:"memo_conflict"});
     continue;
   }
   const form=new URLSearchParams();
   form.set("memo",item.next_memo);
   const response=await fetch(detailUrl.toString(),{
     method:"PUT",
     headers:{...apiHeaders,"Content-Type":"application/x-www-form-urlencoded"},
     body:form.toString(),
     signal:AbortSignal.timeout(15000)
   }).catch(()=>null);
   if(!response?.ok){
     results.push({contact_id:id,status:"update_failed",http_status:response?.status||null});
     continue;
   }
   const verified=await readDetail();
   results.push({contact_id:id,status:verified&&String(verified.memo??"")===item.next_memo
     ? "updated":"verification_pending"});
 }
 const counts:Record<string,number>={};
 for(const item of results) counts[item.status]=(counts[item.status]||0)+1;
 return json(200,{
   ok:true,mode:"apply",contact_count:list.length,
   updated_count:counts.updated||0,attempted_count:results.length,
   counts,items:results
 });

});
