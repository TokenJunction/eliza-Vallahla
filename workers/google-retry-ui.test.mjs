import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
const source=readFileSync(new URL("../errors.js",import.meta.url),"utf8");
function fixture(blockStorage=false){
  let reloads=0, oldRetries=0;const capture=[];
  function element(){return {children:[],textContent:"",appendChild(child){this.children.push(child);},addEventListener(type,handler){this[type]=handler;}};}
  const context={console:{debug(){}},location:{pathname:"/",reload(){reloads++;}},sessionStorage:{getItem(){if(blockStorage)throw Error("blocked");return null;},setItem(){if(blockStorage)throw Error("blocked");}},document:{addEventListener(type,handler,isCapture){if(type==="click"&&isCapture)capture.push(handler);},createElement:element,createTextNode:text=>({textContent:text})},fetch:async()=>new Response("{}")};
  vm.runInNewContext(source,context);
  const host=element();
  return {context,host,capture,reloads:()=>reloads,oldRetries:()=>oldRetries,show(detail,code="V-AUTH"){context.ValhallaErrors.show(host,{code,detail,public:"Unavailable",retry(){oldRetries++;}});}};
}
test("mail delivery errors restart Google instead of replaying the credential",()=>{
  for(const detail of ["google worker email","google worker email-not-configured","google worker replay"]){
    const f=fixture();f.show(detail);f.host.children.find(child=>child.type==="button").click();
    assert.equal(f.reloads(),1);assert.equal(f.oldRetries(),0);
  }
});
test("full-screen retry is intercepted before its old credential closure",()=>{
  const f=fixture();f.show("google worker email");let prevented=false,stopped=false;
  f.capture[0]({target:{closest:selector=>selector==="#mechaRetry"?{}:null},preventDefault(){prevented=true;},stopImmediatePropagation(){stopped=true;}});
  assert.equal(f.reloads(),1);assert.equal(prevented,true);assert.equal(stopped,true);assert.equal(f.oldRetries(),0);
});
test("unrelated retries retain their original behavior",()=>{
  const f=fixture();f.show("balance lookup failed","V-DESK");f.host.children.find(child=>child.type==="button").click();
  assert.equal(f.oldRetries(),1);assert.equal(f.reloads(),0);
});
test("blocked session storage cannot break the recovery UI",()=>{
  const f=fixture(true);assert.doesNotThrow(()=>f.show("google worker replay"));
  f.host.children.find(child=>child.type==="button").click();assert.equal(f.reloads(),1);
});
test("other clicks do not force a reload",()=>{
  const f=fixture();f.show("google worker email");f.capture[0]({target:{closest:()=>null}});assert.equal(f.reloads(),0);
});
