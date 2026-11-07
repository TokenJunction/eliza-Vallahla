const ORIGINS = new Set(["https://valhalla-app.xyz", "https://www.valhalla-app.xyz"]);
const LEGACY_KEYS = { deepseek: "DEEPSEEK_API_KEY", openai: "OPENAI_API_KEY", together: "TOGETHER_API_KEY", groq: "GROQ_API_KEY" };
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
function configured(value) { return typeof value === "string" && value.trim().length > 0 && !/your_|placeholder|NOT_SET/i.test(value); }
function geminiKey(env) { return env.GEMINI_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY || ""; }
function json(request, status, body) {
  const headers = {"Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store", Vary:"Origin", "Access-Control-Allow-Methods":"POST, OPTIONS", "Access-Control-Allow-Headers":"content-type, authorization", "Access-Control-Expose-Headers":"x-valhalla-provider, x-valhalla-model"};
  const origin = request.headers.get("Origin"); if (ORIGINS.has(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return new Response(JSON.stringify(body), {status,headers});
}
function secretLike(text) {
  const words=text.trim().split(/\s+/);return /[1-9A-HJ-NP-Za-km-z]{64,}/.test(text)||(words.length>=12&&words.length<=24&&words.every(word=>/^[a-z]+$/i.test(word)));
}
async function readBody(request) {
  const reader=request.body?.getReader();if(!reader)throw Error("input");let size=0;const chunks=[];
  try { while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>16384){await reader.cancel();throw Error("size");}chunks.push(value);} }
  finally { reader.releaseLock(); }
  const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
  return JSON.parse(new TextDecoder().decode(bytes));
}
function streamText(body) {
  const decoder=new TextDecoder(), encoder=new TextEncoder();let reader;
  return new ReadableStream({
    async start(controller) {
      reader=body.getReader();let buffer="",length=0;
      try {
        while(true){const step=await reader.read();buffer+=decoder.decode(step.value||new Uint8Array(),{stream:!step.done});if(buffer.length>65536)throw Error("stream-size");
          const lines=buffer.split(/\r?\n/);buffer=lines.pop()||"";if(step.done&&buffer){lines.push(buffer);buffer="";}
          for(const line of lines){if(!line.startsWith("data:"))continue;const raw=line.slice(5).trim();if(raw==="[DONE]"){controller.close();await reader.cancel();return;}if(!raw)continue;
            const event=JSON.parse(raw);if(event.error)throw Error("provider-stream");const text=event.choices?.[0]?.delta?.content;
            if(typeof text==="string"){length+=text.length;if(length>32000)throw Error("response-size");controller.enqueue(encoder.encode(text));}
          }
          if(step.done){controller.close();return;}
        }
      } catch(error){try{controller.error(error);}catch{}try{await reader.cancel();}catch{}}
      finally {reader.releaseLock();}
    },
    async cancel(){try{await reader?.cancel();}catch{}}
  });
}
export function createChatRouter(legacy, fetcher=globalThis.fetch) {
  return {async fetch(request,env,context){
    const path=new URL(request.url).pathname;
    if(!ORIGINS.has(request.headers.get("Origin")))return json(request,403,{error:"Origin not allowed.",code:"V-CHAT-ORIGIN"});
    if(request.method==="OPTIONS")return new Response(null,{status:204,headers:json(request,200,{}).headers});
    if(request.method!=="POST"||!["/chat","/v1/chat","/api/chat","/v1/voice/token"].includes(path))return json(request,404,{error:"Not found."});
    if(!env.CHAT_LIMITER?.limit)return json(request,503,{error:"Chat rate limiting is not configured.",code:"V-CHAT-CONFIG"});
    try{const rate=await env.CHAT_LIMITER.limit({key:"ip:"+(request.headers.get("CF-Connecting-IP")||"unknown")});if(!rate?.success)return json(request,429,{error:"Too many requests.",code:"V-CHAT-RATE"});}catch{return json(request,503,{error:"Rate limiter unavailable."});}
    if(path==="/v1/voice/token"){
      if(env.ENABLE_GEMINI_LIVE!=="true"||!configured(geminiKey(env))||!configured(env.GEMINI_LIVE_MODEL))return json(request,503,{error:"Live Gemini voice is not configured.",code:"V-VOICE-CONFIG"});
      const auth=request.headers.get("Authorization")||"";if(!/^Bearer \S+$/.test(auth))return json(request,401,{error:"Sign in before starting live voice."});
      try{
        const authBase=new URL(env.AUTH_CONFIG_URL);if(authBase.protocol!=="https:")throw Error("auth-config");
        const verified=await fetcher(new URL("/auth/access",authBase),{headers:{Authorization:auth},signal:AbortSignal.timeout(5000)});
        const identity=await verified.json();if(!verified.ok||identity.ok!==true||typeof identity.subject!=="string"||typeof identity.sessionId!=="string")return json(request,401,{error:"A verified live session is required."});
        const expireTime=new Date(Date.now()+5*60000).toISOString();const model=String(env.GEMINI_LIVE_MODEL).replace(/^models\//,"");
        const minted=await fetcher("https://generativelanguage.googleapis.com/v1beta/auth_tokens",{method:"POST",headers:{"x-goog-api-key":geminiKey(env),"Content-Type":"application/json"},body:JSON.stringify({uses:1,expireTime,newSessionExpireTime:new Date(Date.now()+60000).toISOString(),liveConnectConstraints:{model:"models/"+model,config:{responseModalities:["AUDIO"]}}}),signal:AbortSignal.timeout(10000)});
        const token=await minted.json();if(!minted.ok||typeof token.name!=="string")throw Error("voice-provider");
        return json(request,200,{token:token.name,model,expireTime,websocketEndpoint:"wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained"});
      }catch{return json(request,502,{error:"Could not establish a live voice session.",code:"V-VOICE-UPSTREAM"});}
    }
    if(!(request.headers.get("Content-Type")||"").toLowerCase().startsWith("application/json"))return json(request,415,{error:"Send JSON."});
    let body;try{body=await readBody(request);}catch(error){return json(request,error.message==="size"?413:400,{error:"Invalid or oversized chat request."});}
    if(!body||typeof body!=="object"||Array.isArray(body))return json(request,400,{error:"Invalid chat request."});
    const items=body.messages;const last=Array.isArray(items)?items.at(-1):null;
    const input=body.text??body.prompt??(last?.role==="user"?last.content:"");
    if(typeof input!=="string"||!input.trim()||input.length>500||secretLike(input))return json(request,400,{error:"Enter a question under 500 characters. Do not send private keys or seed phrases."});
    const text=input.trim();let history=body.history??(Array.isArray(items)?items.slice(0,last?.role==="user"?-1:undefined).slice(-8):[]);
    if(!Array.isArray(history)||history.length>8||history.some(row=>!row||!["user","assistant"].includes(row.role)||typeof row.content!=="string"||row.content.length>500||secretLike(row.content)))return json(request,400,{error:"Invalid conversation history."});
    const primary=String(env.CHAT_PROVIDER||"deepseek").toLowerCase();
    const names=[...new Set([primary,...String(env.CHAT_FALLBACK_PROVIDERS||"").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean)])].slice(0,3);
    const available=names.filter(name=>configured(name==="gemini"?geminiKey(env):env[LEGACY_KEYS[name]]));
    if(!available.length)return json(request,503,{error:"No configured chat provider is available. An administrator must configure a server-side provider credential.",code:"V-CHAT-CONFIG"});
    for(const name of available){
      if(name!=="gemini"){
        const headers=new Headers(request.headers);headers.delete("Content-Length");
        const forwarded=new Request(request.url,{method:"POST",headers,body:JSON.stringify({text,history,stream:body.stream===true}),signal:request.signal});
        const response=await legacy.fetch(forwarded,{...env,CHAT_PROVIDER:name,CHAT_MODEL:name===primary?env.CHAT_MODEL:env[name.toUpperCase()+"_MODEL"],CHAT_LIMITER:{limit:async()=>({success:true})}},context);
        if(response.status<500)return response;continue;
      }
      try{
        const model=env.GEMINI_MODEL||(primary==="gemini"?env.CHAT_MODEL:"")||"gemini-3.8-flash";
        const messages=[{role:"system",content:"You are the Valhalla assistant. Provide helpful concise answers. Never claim current prices, network health, repairs, or agent collaboration without measured evidence. Do not request secrets or execute financial transactions. State when current information is unavailable."},...history,{role:"user",content:text}];
        const upstream=await fetcher(GEMINI_URL,{method:"POST",headers:{Authorization:"Bearer "+geminiKey(env),"Content-Type":"application/json"},body:JSON.stringify({model,messages,stream:body.stream===true,max_tokens:1024}),signal:AbortSignal.timeout(30000)});
        if(!upstream.ok)continue;
        const headers=new Headers(json(request,200,{}).headers);headers.set("x-valhalla-provider","gemini");headers.set("x-valhalla-model",model);
        if(body.stream===true){if(!upstream.body)continue;headers.set("Content-Type","text/plain; charset=utf-8");return new Response(streamText(upstream.body),{headers});}
        const result=await upstream.json();const reply=result?.choices?.[0]?.message?.content;if(typeof reply!=="string"||!reply.trim()||reply.length>32000)continue;
        return new Response(JSON.stringify({ok:true,reply,provider:"gemini",model}),{headers});
      }catch{}
    }
    return json(request,502,{error:"Configured model providers are unavailable. Please retry shortly.",code:"V-CHAT-UPSTREAM"});
  }};
}
