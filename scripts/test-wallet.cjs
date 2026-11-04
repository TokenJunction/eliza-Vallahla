const assert = require('node:assert/strict');
const core = require('../site-build/connect-core.js');
(async () => {
  const address = 'So11111111111111111111111111111111111111112';
  assert.equal(core.isPubkey(address), true);
  assert.equal(core.pickNamed([{name:'Phantom'}], 'backpack'), null);
  assert.equal(core.pickNamed([{name:'Solflare'}], 'solflare').name, 'Solflare');
  const account = {address, chains:['solana:mainnet'], features:['solana:signMessage']};
  const connect = {connect: async function () {assert.equal(this, connect); return {accounts:[account]};}};
  const signing = {signMessage: async function (input) {
    assert.equal(this, signing);
    assert.equal(Array.isArray(input), false);
    assert.equal(input.account, account);
    assert.ok(input.message instanceof Uint8Array);
    return [{signature:new Uint8Array(64)}];
  }};
  const adapter = await core.adapterFromStandard({name:'Solflare',features:{'standard:connect':connect,'solana:signMessage':signing}});
  assert.equal(adapter.address, address);
  assert.equal((await adapter.signMessage(new Uint8Array([1]))).length, 64);
  const provider = {publicKey:{toString:()=>address},connect:async()=>({}),signMessage:async()=>new Uint8Array(64)};
  assert.equal((await core.adapterFromInjected(provider,'solflare')).address,address);
  const step = core.walletStep('solflare',{installed:false,mobile:true,pageUrl:'https://valhalla-app.xyz/app/'});
  assert.equal(step.action,'browse');
  assert.ok(step.url.startsWith('https://solflare.com/ul/v1/browse/'));
  console.log('Wallet adapter regression checks passed');
})().catch(error=>{console.error(error);process.exit(1);});
