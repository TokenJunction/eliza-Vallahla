import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../os/bridge.js',import.meta.url),'utf8');
function fixture(url='https://brain.example.test/v1///',reply={ok:true,reply:'A real fixture reply',provider:'fixture-model'}) {
  const calls=[], nodes={};
  function element(){return {value:'Explain risk',children:[],disabled:false,addEventListener(type,fn){this[type]=fn;},appendChild(child){this.children.push(child);},setAttribute(){},focus(){},querySelector(){return button;}};}
  const button={};
  for(const id of ['wallet-status','overview-wallet','overview-wallet-detail','wallet-disconnect','chat-form','chat-input','chat-log','chat-status','chat-voice'])nodes[id]=element();
  const context={URL,AbortController,window:{VALHALLA_SITE:{CHAT_URL:url},setTimeout(){return 1;},clearTimeout(){}},document:{getElementById:id=>nodes[id],querySelectorAll:()=>[],createElement:element,createTextNode:text=>({textContent:text})},fetch:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>reply};}};
  vm.runInNewContext(source,context);
  return {calls,nodes,submit:()=>nodes['chat-form'].submit({preventDefault(){}})};
}
test('normalizes URL and submits the expected endpoint',async()=>{
  const f=fixture();await f.submit();assert.equal(f.calls[0].url,'https://brain.example.test/v1/chat');assert.match(f.nodes['chat-status'].textContent,/Reply received/);assert.doesNotMatch(f.nodes['chat-status'].textContent,/Grounded/);
});
test('missing configuration cannot silently invent a backend',async()=>{
  const f=fixture('');await f.submit();assert.equal(f.calls.length,0);assert.match(f.nodes['chat-status'].textContent,/not configured/);
});
test('mnemonic-like inputs are not transmitted',async()=>{
  const f=fixture();f.nodes['chat-input'].value='one two three four five six seven eight nine ten eleven twelve';await f.submit();assert.equal(f.calls.length,0);assert.match(f.nodes['chat-status'].textContent,/not sent/);
});
test('configuration fallback is not presented as a model reply',async()=>{
  const f=fixture(undefined,{reply:'fabricated fixture',provider:'valhalla-fallback',status:'CONFIG_PENDING'});await f.submit();assert.equal(f.nodes['chat-log'].children.length,1);assert.match(f.nodes['chat-status'].textContent,/No model reply/);assert.equal(f.nodes['chat-input'].disabled,false);
});
test('insecure endpoints are refused',async()=>{
  const f=fixture('http://brain.example.test');await f.submit();assert.equal(f.calls.length,0);assert.match(f.nodes['chat-status'].textContent,/invalid/);
});
