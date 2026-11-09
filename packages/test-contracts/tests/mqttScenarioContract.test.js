import assert from 'node:assert/strict';
import test from 'node:test';
import mqtt from 'mqtt';
import { once } from 'node:events';
import { createElectronHarness } from '../../../tooling/mqtt-load-test/electronHarness.mjs';
import { createTauriHarness } from '../../../tooling/mqtt-load-test/tauriHarness.mjs';
import { startLocalBroker } from '../../../tooling/mqtt-load-test/localBroker.mjs';
import { createScenarioRunner } from '../../workbench/src/workspace/scenarioRunner.js';
import { createSubscriptionLifecycle } from '../../workbench/src/workspace/subscriptionLifecycle.js';
import { scenarioExample } from '../../domain/src/messageScenario.js';

for(const runtime of ['electron','tauri']) test(`${runtime} native broker scenario pass/fail/timeout/stop and saved subscription survival`,{timeout:150000},async t=>{
 const broker=await startLocalBroker();let harness;let device;let runner;let mode='pass';const settings={};const connection={id:`scenario-${runtime}`,name:'Isolated local broker',status:'connected'};
 t.after(async()=>{runner?.stop();if(device)await device.endAsync(true);await harness?.close();await broker.close();assert.equal(broker.openSocketCount,0);});
 const onMessageBatch=messages=>runner?.acceptMessages(messages);
 harness=runtime==='electron'?createElectronHarness({onMessageBatch}):await createTauriHarness({onMessageBatch});
 assert.equal((await harness.command('connect',{id:connection.id,host:broker.host,port:broker.port,protocol:'mqtt',username:broker.username,password:broker.password,autoReconnect:false,cleanSession:true})).ok,true);
 device=mqtt.connect(`mqtt://${broker.host}:${broker.port}`,{username:broker.username,password:broker.password,reconnectPeriod:0});await once(device,'connect');
 await device.subscribeAsync('devices/unit-1/command',{qos:1});
 const saved=[{connId:connection.id,topic:'user/keep',qos:1}];await harness.command('subscribe',connection.id,'user/keep',1);
 const api={subscribe:(...args)=>harness.command('subscribe',...args),unsubscribe:(...args)=>harness.command('unsubscribe',...args),publish:(...args)=>harness.command('publish',...args)};
 const lifecycle=createSubscriptionLifecycle({mqtt:api,db:{saveSetting:async(k,v)=>{settings[k]=v;return {ok:true};}},workspace:{getConnection:()=>connection,getSubscriptions:()=>saved,hasConnection:()=>true,isClosing:()=>false},operations:{run:fn=>fn(0),isCurrent:()=>true},addLog:()=>{}});
 runner=createScenarioRunner({mqtt:api,withResponseSubscription:lifecycle.withResponseSubscription});
 device.on('message',(_topic,payload)=>{const request=JSON.parse(payload.toString());if(mode==='none')return;if(mode==='stop'){runner.stop();return;}void device.publishAsync('devices/unit-1/response',JSON.stringify({...request,status:'ok',temperature:mode==='fail'?99:25}),{qos:1});});
 await device.publishAsync('devices/unit-1/response',JSON.stringify({requestId:'previous-run',status:'ok',temperature:25}),{qos:1,retain:true});
 for(const outcome of ['pass','fail','timeout','stopped']) {
  mode=outcome==='timeout'?'none':outcome==='stopped'?'stop':outcome;
  const report=await runner.start({...scenarioExample(),timeoutMs:outcome==='timeout'?250:3000},connection);assert.equal(report.status,outcome,JSON.stringify(report));await runner.cleanup;
  if(outcome==='pass') {assert.equal(report.evidence.some(e=>e.retained),true,'native retained flag preserved');assert.equal(report.response.raw.includes('temperature'),true);assert.equal(report.evidence.some(e=>e.reason==='matched'&&e.rawHex.length>0),true);}
 }
 const sentinel=`keep-${runtime}`;await device.publishAsync('user/keep',sentinel,{qos:1});await harness.waitMessage(m=>m.topic==='user/keep'&&m.payloadHex===Buffer.from(sentinel).toString('hex'));
 assert.deepEqual(JSON.parse(settings[`mqtt.pendingUnsubscriptions.${connection.id}`]),[]);
});
