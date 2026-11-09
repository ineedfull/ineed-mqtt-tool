import test from 'node:test';
import assert from 'node:assert/strict';
import { createScenarioRunner } from '../src/workspace/scenarioRunner.js';
import { scenarioExample } from '../../domain/src/messageScenario.js';
const conn = {id:'c',name:'lab',status:'connected',password:'secret'};
const scenario = () => ({...scenarioExample(),timeoutMs:80});
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness({gate = Promise.resolve(), publish} = {}) {
  let runner; const calls=[];
  runner = createScenarioRunner({mqtt:{publish: async (...args) => { calls.push(args); return publish ? publish(...args) : {ok:true}; }},
    withResponseSubscription: async (_lease,work) => { await gate; if (!_lease.isCancelled()) await work(); },
  });
  const send = (payload,extra={}) => runner.acceptMessages([{connId:'c',topic:'devices/unit-1/response',payloadText:JSON.stringify(payload),timestamp:Date.now(),...extra}]);
  return {runner,calls,send};
}
test('waits for SUBACK and QoS ACK alone times out', async () => {
  let ack; const h=harness({gate:new Promise(r => {ack=r;})}); const done=h.runner.start(scenario(),conn);
  await tick(); assert.equal(h.calls.length,0); ack(); await tick(); assert.equal(h.calls.length,1);
  assert.equal((await done).status,'timeout');
});
test('response arriving during publish before PUBACK wins, evidence and snapshot remain immutable', async () => {
  let h; h=harness({publish:async (_id,_topic,payload) => { h.send({...JSON.parse(payload),status:'ok',temperature:25}); return {ok:false,error:'late ack failure'}; }});
  const input=scenario(); const done=h.runner.start(input,conn); input.name='changed'; const report=await done;
  assert.equal(report.status,'pass'); assert.equal(report.scenario.name,'设备指令响应');
  assert.equal(report.assertions.every(r=>r.passed),true); assert.equal(JSON.stringify(report).includes('secret'),false);
  const snapshot=JSON.stringify(report); h.send({requestId:report.requestId,status:'bad'}); assert.equal(JSON.stringify(report),snapshot);
});
test('retained, wrong ID, other connection, old timestamps and invalid JSON cannot prove success', async () => {
  const h=harness(); const done=h.runner.start(scenario(),conn); await tick(); const request=JSON.parse(h.calls[0][2]);
  h.send({...request,status:'ok',temperature:25},{retained:true}); h.send({...request,status:'ok',temperature:25},{connId:'other'});
  h.send({...request,status:'ok',temperature:25},{timestamp:0}); h.send({requestId:'old',status:'ok'}); h.send({}, {payloadText:'invalid'});
  const report=await done; assert.equal(report.status,'timeout'); assert.equal(report.evidence.some(e=>e.reason==='retained'),true); assert.equal(report.evidence.some(e=>e.reason==='invalid-json'),true);
});
test('correlated bad business value fails; stop before ACK never publishes; reconnect cannot revive run', async () => {
  const h=harness(); const done=h.runner.start(scenario(),conn); await tick(); h.send({...JSON.parse(h.calls[0][2]),status:'ok',temperature:99}); assert.equal((await done).status,'fail'); await h.runner.cleanup;
  let ack; const stopped=harness({gate:new Promise(r => {ack=r;})}); const pending=stopped.runner.start(scenario(),conn); stopped.runner.stop(); assert.equal((await pending).status,'stopped'); ack(); await stopped.runner.cleanup; assert.equal(stopped.calls.length,0);
  const loss=harness(); const lost=loss.runner.start(scenario(),conn); loss.runner.connectionStatus('c','disconnected'); loss.runner.connectionStatus('c','connected'); assert.equal((await lost).status,'connection-loss'); await loss.runner.cleanup;
});
test('stopped late response is ignored and new run gets a fresh request identity', async () => {
  const h=harness(); const first=h.runner.start(scenario(),conn); await tick(); const previous=JSON.parse(h.calls[0][2]); h.runner.stop(); assert.equal((await first).status,'stopped'); await h.runner.cleanup;
  const second=h.runner.start(scenario(),conn); await tick(); h.send({...previous,status:'ok',temperature:25}); const current=JSON.parse(h.calls[1][2]); assert.notEqual(current.requestId,previous.requestId); h.send({...current,status:'ok',temperature:25}); assert.equal((await second).status,'pass'); await h.runner.cleanup;
});
test('production byte payloads decode losslessly and malformed UTF8 never passes',async()=>{
 const h=harness();const done=h.runner.start(scenario(),conn);await tick();const request=JSON.parse(h.calls[0][2]);
 h.send({}, {payloadText:undefined,payload:Uint8Array.from([0xff,0x7b])});
 h.send({}, {payloadText:undefined,payload:new TextEncoder().encode(JSON.stringify({...request,status:'ok',temperature:25}))});
 const report=await done;assert.equal(report.status,'pass');assert.equal(report.evidence[0].reason,'invalid-utf8');assert.equal(typeof report.evidence[1].rawHex,'string');await h.runner.cleanup;
});
test('ignored traffic has a total evidence byte budget while matched response still produces verdict',async()=>{
 const h=harness();const done=h.runner.start({...scenario(),timeoutMs:2000},conn);await tick();const current=JSON.parse(h.calls[0][2]);
 for(let i=0;i<12;i++)h.send({requestId:'old',padding:'x'.repeat(60000)});
 h.send({...current,status:'ok',temperature:25});const report=await done;assert.equal(report.status,'pass');assert.ok(report.evidence.reduce((n,e)=>n+e.raw.length,0)<=262144);assert.ok(report.droppedEvidence>0);assert.ok(report.response.raw.includes(current.requestId));await h.runner.cleanup;
});
test('late response cannot pass when event loop delays the timeout callback',async()=>{
 const h=harness();const done=h.runner.start({...scenario(),timeoutMs:50},conn);await tick();const request=JSON.parse(h.calls[0][2]);
 const until=performance.now()+65;while(performance.now()<until) { /* model an occupied renderer event loop */ }
 h.send({...request,status:'ok',temperature:25});assert.equal((await done).status,'timeout');await h.runner.cleanup;
});
test('close drain tracks the complete cleanup including the final report callback',async()=>{
 const tracked=[];const emitted=[];const runner=createScenarioRunner({mqtt:{publish:async()=>({ok:true})},withResponseSubscription:async(lease,work)=>{if(!lease.isCancelled())await work();},trackCleanup:task=>{tracked.push(task);},onReport:r=>emitted.push(r)});
 const done=runner.start(scenario(),conn);runner.stop();await done;assert.equal(tracked.length,1);await tracked[0];assert.equal(emitted.at(-1).cleanup,'released-or-deferred');assert.equal(runner.busy,false);
});
