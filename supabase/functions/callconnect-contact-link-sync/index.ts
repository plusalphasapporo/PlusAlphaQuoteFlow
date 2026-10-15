import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createClient} from "https://esm.sh/@supabase/supabase-js@2.95.0";
import {buildPlan,publicPlanItem,summarize,STAGING_ORIGIN,parseContactsPage} from "./logic.mjs";
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
 if(input.mode!=="preview")return json(400,{error:"preview_only_no_writes"});
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
   const n=Number(raw?.total??raw?.total_count??raw?.pagination?.total??raw?.meta?.total);
   const countKnown=Number.isInteger(n)&&n>=0;
   const hasNext=Boolean(raw?.next_page||raw?.has_more===true||raw?.pagination?.next_page||raw?.pagination?.has_next);
   if(batch.length<100&&!hasNext){
     if(countKnown&&list.length<n)return json(409,{error:"contacts_pagination_incomplete",expected_total:n,received:list.length});
     finished=true;
     break;
   }
 }
 if(!finished)return json(409,{error:"contacts_exceed_safe_scan_limit",limit:1000});
 const origin=Deno.env.get("QUOTEFLOW_CUSTOMER_LINK_ORIGIN")||STAGING_ORIGIN;
 let plan;
 try{plan=buildPlan(list,customers,contacts,origin);}catch{return json(422,{error:"contact_preview_validation_failed"});}
 return json(200,{ok:true,mode:"preview",write_enabled:false,contact_count:list.length,counts:summarize(plan),items:plan.map(publicPlanItem)});
});
