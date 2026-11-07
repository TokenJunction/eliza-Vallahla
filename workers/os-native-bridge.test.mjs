import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(process.env.BRIDGE_UNDER_TEST || new URL('../os/bridge.js',import.meta.url),'utf8');
const base='https://valhalla-chat.valhalla-app.workers.dev';
class Element {
  constructor(tag='div'){this.tag=tag;this.textContent='';this.value='';this.children=[];this.handlers={};this.attrs={};this.disabled=false;}
  addEventListener(name,fn){this.handlers[name]=fn;}
  appendChild(node){this.children.push(node);return node;}
  setAttribute(name,value){this.attrs[name]=value;}
  querySelector(selector){return selector==='button'?this.button:null;}
  focus(){this.focused=true;}
}
function reply(body={reply:'Hello.'},status=200,headers={}){return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json',...headers}});}
function harness(options={}){
  const ids=Object.fromEntries(['wallet-status','overview-wallet','overview-wallet-detail','wallet-disconnect','chat-form','chat-input','chat-log','chat-status','chat-voice'].map(id=>[id,new Element()]));
  ids['chat-form'].button=new Element('button');
  const requests=[],timers=new Map();let nextTimer=1;
  const window={VALHALLA_SITE:{CHAT_URL:options.base===undefined?base:options.base},setTimeout:fn=>{const id=nextTimer++;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id)};
  if(options.voice){window.speechSynthesis={cancel(){},speak(){if(options.speechError)throw Error('speech failed');}};window.SpeechSynthesisUtterance=class {constructor(text){this.text=text;}};}
  const document={getElementById:id=>ids[id],querySelectorAll:()=>[],createElement:tag=>new Element(tag),createTextNode:text=>({nodeType:3,textContent:text})};
  const fetch=async(url,init)=>{const record={url,init,body:JSON.parse(init.body)};requests.push(record);return options.fetch?options.fetch(record,requests.length):reply();};
  vm.runInNewContext(source,{window,document,fetch,URL,AbortController,console},{timeout:2000});
  return {ids,requests,timers,submit(text='Hello.'){ids['chat-input'].value=text;return ids['chat-form'].handlers.submit({preventDefault(){}});},clickVoice(){ids['chat-voice'].handlers.click();},restored(){assert.equal(ids['chat-input'].disabled,false);assert.equal(ids['chat-form'].button.disabled,false);assert.equal(timers.size,0);},assistantRows(){return ids['chat-log'].children.filter(row=>row.children[0]?.textContent==='ASSISTANT');}};
}
test('root config uses the canonical chat API and native JSON contract',async()=>{const h=harness();await h.submit();assert.equal(h.requests[0].url,base+'/chat');assert.deepEqual(h.requests[0].body,{text:'Hello.',history:[],stream:false});h.restored();});
test('second turn sends the history field read by the deployed Worker',async()=>{const h=harness();await h.submit('First.');await h.submit('Second.');assert.deepEqual(h.requests[1].body.history,[{role:'user',content:'First.'},{role:'assistant',content:'Hello.'}]);assert.equal('messages' in h.requests[1].body,false);});
test('assistant history is capped at 500 characters',async()=>{const h=harness({fetch:()=>reply({reply:'x'.repeat(700)})});await h.submit();await h.submit('Next.');assert.equal(h.requests[1].body.history[1].content.length,500);});
test('conversation history retains the last four completed turns',async()=>{const h=harness();for(let i=0;i<10;i++)await h.submit('Turn '+i+'.');assert.equal(h.requests[9].body.history.length,8);assert.equal(h.requests[9].body.history[0].content,'Turn 5.');});
test('1,000 concurrent repeat submissions issue only one mocked request',async()=>{let resolve;const pending=new Promise(r=>resolve=r);const h=harness({fetch:()=>pending});const first=h.submit();await Promise.all(Array.from({length:1000},()=>h.submit('Duplicate.')));assert.equal(h.requests.length,1);resolve(reply());await first;h.restored();});
test('2,000 mocked sequential turns keep bounded history and restore controls',async()=>{const h=harness();for(let i=0;i<2000;i++){await h.submit('Turn '+i+'.');assert.ok(h.requests.at(-1).body.history.length<=8);h.restored();}assert.equal(h.requests.length,2000);assert.equal(h.assistantRows().length,2000);});
for(const [name,baseValue] of [['missing',''],['insecure','http://example.test'],['invalid','not a URL']])test(name+' chat configuration makes no request',async()=>{const h=harness({base:baseValue});await h.submit();assert.equal(h.requests.length,0);assert.match(h.ids['chat-status'].textContent,/not configured|invalid/);});
for(const [name,value] of [['empty','  '],['seed-like','one two three four five six seven eight nine ten eleven twelve'],['private-key-like','1'.repeat(64)]])test(name+' input makes no request',async()=>{const h=harness();await h.submit(value);assert.equal(h.requests.length,0);});
for(const [name,body,status] of [['rate limit',{error:'Too many requests.'},429],['configuration failure',{error:'Native chat inference is not configured.'},503],['empty reply',{reply:''},200],['fallback',{reply:'fake',provider:'valhalla-fallback'},200],['pending',{reply:'fake',status:'CONFIG_PENDING'},200],['not ok',{reply:'fake',ok:false},200]])test(name+' is not presented as a model reply',async()=>{const h=harness({fetch:()=>reply(body,status)});await h.submit();assert.equal(h.assistantRows().length,0);assert.match(h.ids['chat-status'].textContent,/^Chat:/);h.restored();});
test('network failure restores controls and failed turn is not added to history',async()=>{const h=harness({fetch:(_r,n)=>{if(n===1)throw new TypeError('Failed to fetch');return reply();}});await h.submit('Failed.');assert.match(h.ids['chat-status'].textContent,/Failed to fetch/);h.restored();await h.submit('Retry.');assert.deepEqual(h.requests[1].body.history,[]);assert.equal(h.assistantRows().length,1);});
test('abort restores controls and gives timeout status',async()=>{const h=harness({fetch:()=>{const e=new Error('aborted');e.name='AbortError';throw e;}});await h.submit();assert.match(h.ids['chat-status'].textContent,/timed out/);h.restored();});
test('invalid JSON restores controls without creating an assistant row',async()=>{const h=harness({fetch:()=>new Response('<html>Denied</html>',{status:403})});await h.submit();assert.equal(h.assistantRows().length,0);h.restored();});
test('native provider header is shown when response body omits provider',async()=>{const h=harness({fetch:()=>reply({reply:'Hello.'},200,{'x-valhalla-provider':'workers-ai'})});await h.submit();assert.match(h.ids['chat-status'].textContent,/workers-ai/);});
test('provider body field remains compatible',async()=>{const h=harness({fetch:()=>reply({reply:'Hello.',provider:'test-provider'})});await h.submit();assert.match(h.ids['chat-status'].textContent,/test-provider/);});
test('reply HTML is inserted as a text node, not markup',async()=>{const value='<img src=x onerror=alert(1)>';const h=harness({fetch:()=>reply({reply:value})});await h.submit();assert.equal(h.assistantRows()[0].children.at(-1).nodeType,3);assert.equal(h.assistantRows()[0].children.at(-1).textContent,value);});
test('speech failure preserves the reply and its conversation history',async()=>{const h=harness({voice:true,speechError:true});h.clickVoice();await h.submit('First.');assert.match(h.ids['chat-status'].textContent,/browser speech failed/);assert.equal(h.ids['chat-voice'].attrs['aria-pressed'],'false');await h.submit('Next.');assert.equal(h.requests[1].body.history.length,2);h.restored();});
test('voice unavailable does not prevent text chat',async()=>{const h=harness();assert.equal(h.ids['chat-voice'].disabled,true);await h.submit();assert.equal(h.assistantRows().length,1);});
for(const [suffix,path] of [['/','/chat'],['/v1','/v1/chat'],['/v1/','/v1/chat'],['/v1///','/v1/chat'],['/gateway/v2///','/gateway/v2/chat']])test('preserves configured API prefix and trims trailing slashes '+suffix,async()=>{const h=harness({base:base+suffix});await h.submit();assert.equal(h.requests[0].url,base+path);});
