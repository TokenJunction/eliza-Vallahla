import test from "node:test";
import assert from "node:assert/strict";
import { createAuthBoundary } from "./auth-boundary.js";
const ORIGIN="https://valhalla-app.xyz";
function fixture() {
  const calls=[];
  const worker=createAuthBoundary({fetch:async request=>{calls.push({path:new URL(request.url).pathname,method:request.method,body:request.method==="POST"?await request.json():null});return new Response(JSON.stringify({ok:true,nonce:"fixture"}),{headers:{"Set-Cookie":"fixture=value; Secure; HttpOnly"}});}});
  return {worker,calls};
}
function request(path,method="GET",origin=ORIGIN,body) {
  const headers={}; if(origin)headers.Origin=origin;
  if(body!==undefined)headers["Content-Type"]="application/json";
  return new Request("https://auth.example.test"+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
}
test("nonce rejects hostile and absent origins before delegation",async()=>{
  const {worker,calls}=fixture();
  for(const origin of ["https://evil.example",null])assert.equal((await worker.fetch(request("/auth/nonce","GET",origin))).status,403);
  assert.equal(calls.length,0);
});
test("trusted nonce remains compatible and cannot be cached",async()=>{
  const {worker,calls}=fixture();const response=await worker.fetch(request("/auth/nonce"));
  assert.equal(response.status,200);assert.equal(calls.length,1);
  assert.match(response.headers.get("Cache-Control"),/no-store/);
  assert.equal(response.headers.get("Set-Cookie"),"fixture=value; Secure; HttpOnly");
});
test("unauthenticated sign-in cannot change either preference value",async()=>{
  const {worker,calls}=fixture();
  for(const path of ["/auth/google","/auth/email/start"])for(const alwaysAsk of [true,false]){
    assert.equal((await worker.fetch(request(path,"POST",ORIGIN,{alwaysAsk,nonce:"n",human:"h",credential:"fixture"}))).status,200);
  }
  for(const call of calls){assert.equal(Object.hasOwn(call.body,"alwaysAsk"),false);assert.equal(call.body.nonce,"n");assert.equal(call.body.human,"h");}
});
test("authenticated settings request is left to existing session authorization",async()=>{
  const {worker,calls}=fixture();await worker.fetch(request("/auth/security","POST",ORIGIN,{alwaysAsk:false}));
  assert.deepEqual(calls[0].body,{alwaysAsk:false});
});
test("mutation and preflight reject hostile origins",async()=>{
  const {worker,calls}=fixture();
  assert.equal((await worker.fetch(request("/auth/email/start","POST","https://evil.example",{email:"user@example.test"}))).status,403);
  assert.equal((await worker.fetch(request("/auth/google","OPTIONS","https://evil.example"))).status,403);assert.equal(calls.length,0);
});
test("sign-in rejects invalid JSON shape and oversized bodies",async()=>{
  const {worker,calls}=fixture();
  for(const body of [null,[],"string"])assert.equal((await worker.fetch(request("/auth/google","POST",ORIGIN,body))).status,400);
  assert.equal((await worker.fetch(request("/auth/google","POST",ORIGIN,{credential:"x".repeat(17000)}))).status,413);
  assert.equal(calls.length,0);
});
test("missing JSON content type is refused",async()=>{
  const {worker,calls}=fixture();assert.equal((await worker.fetch(request("/auth/google","POST"))).status,415);assert.equal(calls.length,0);
});
