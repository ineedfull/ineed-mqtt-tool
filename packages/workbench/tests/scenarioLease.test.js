import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubscriptionLifecycle } from '../src/workspace/subscriptionLifecycle.js';
function harness(saved=[]) {
 const calls=[]; const settings={}; const connection={id:'c',status:'connected'}; const subscriptions=saved; let ack=async()=>({ok:true});let unsubscribe=async()=>({ok:true});
 const lifecycle=createSubscriptionLifecycle({mqtt:{subscribe:async(...args)=>{calls.push(['subscribe',...args]); return ack();},unsubscribe:async(...args)=>{calls.push(['unsubscribe',...args]);return unsubscribe(...args);}},db:{addSubscription:async()=>({ok:true}),saveSetting:async(k,v)=>{settings[k]=v;return {ok:true};}},workspace:{getConnection:()=>connection,getSubscriptions:()=>subscriptions,hasConnection:()=>true,isClosing:()=>false},operations:{run:fn=>fn(0),isCurrent:()=>true},addLog:()=>{}});
 return {lifecycle,calls,settings,connection,setAck:fn=>{ack=fn;},setUnsubscribe:fn=>{unsubscribe=fn;},subscriptions};
}
test('temporary response subscription is durable before subscribe and removed after work', async()=>{
 const h=harness(); let worked=false;
 await h.lifecycle.withResponseSubscription({connId:'c',topic:'reply',isCancelled:()=>false},async()=>{worked=true;assert.deepEqual(JSON.parse(h.settings['mqtt.pendingUnsubscriptions.c']),['reply']);});
 assert.equal(worked,true);assert.deepEqual(h.calls,[['subscribe','c','reply',1],['unsubscribe','c','reply']]); assert.deepEqual(JSON.parse(h.settings['mqtt.pendingUnsubscriptions.c']),[]);
});
test('saved exact subscription keeps QoS and ownership; temporary lease retains durable intent after loss',async()=>{
 const h=harness([{connId:'c',topic:'reply',qos:2}]); await h.lifecycle.withResponseSubscription({connId:'c',topic:'reply',isCancelled:()=>false},async()=>{}); assert.deepEqual(h.calls,[['subscribe','c','reply',2]]);
 const loss=harness(); await loss.lifecycle.withResponseSubscription({connId:'c',topic:'reply',isCancelled:()=>false},async()=>{loss.lifecycle.updateConnectionStatus('c','disconnected');}); assert.equal(loss.calls.some(c=>c[0]==='unsubscribe'),false); assert.deepEqual(JSON.parse(loss.settings['mqtt.pendingUnsubscriptions.c']),['reply']);
});
test('stop during SUBACK cleans temporary filter without executing work and queues user subscription mutations',async()=>{
 const h=harness(); let ack;h.setAck(()=>new Promise(r=>{ack=r;}));let cancelled=false;let worked=false;
 const lease=h.lifecycle.withResponseSubscription({connId:'c',topic:'reply',isCancelled:()=>cancelled},async()=>{worked=true;});
 await new Promise(r=>setImmediate(r));cancelled=true;ack({ok:true});await lease;assert.equal(worked,false);assert.equal(h.calls.at(-1)[0],'unsubscribe');
});
test('new saved filter mutation waits until scenario lease releases the connection queue',async()=>{
 const h=harness();let release;let entered;const ready=new Promise(r=>{entered=r;});
 const lease=h.lifecycle.withResponseSubscription({connId:'c',topic:'reply',isCancelled:()=>false},async()=>{entered();await new Promise(r=>{release=r;});});await ready;
 const added=h.lifecycle.addSubscription({id:'new',connId:'c',topic:'user/new',qos:0},0);await new Promise(r=>setImmediate(r));assert.equal(h.calls.some(c=>c[2]==='user/new'),false);
 release();await lease;assert.equal(await added,true);assert.equal(h.calls.some(c=>c[2]==='user/new'),true);
});
test('cleanup ACK failure keeps durable intent and reconnect never removes a newly saved identical filter',async()=>{
 const h=harness();h.setUnsubscribe(async()=>({ok:false,error:'broker cleanup failure'}));
 await assert.rejects(h.lifecycle.withResponseSubscription({connId:'c',topic:'reply',isCancelled:()=>false},async()=>{}),/broker cleanup failure/);
 assert.deepEqual(JSON.parse(h.settings['mqtt.pendingUnsubscriptions.c']),['reply']);
 h.subscriptions.push({id:'user',connId:'c',topic:'reply',qos:2});h.calls.length=0;h.setUnsubscribe(async()=>{throw new Error('must not remove saved filter');});
 assert.equal(await h.lifecycle.restoreConnectionSubscriptions('c'),true);assert.equal(h.calls.some(c=>c[0]==='unsubscribe'),false);assert.deepEqual(h.calls,[['subscribe','c','reply',2]]);assert.deepEqual(JSON.parse(h.settings['mqtt.pendingUnsubscriptions.c']),[]);
});
