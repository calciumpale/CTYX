import test from 'node:test';
import assert from 'node:assert/strict';
import {runCliLoop} from '../tools/douyin-bridge/bridge.mjs';
import {BridgeError} from '../tools/douyin-bridge/bridge-core.mjs';

for(const [label,result,throws] of [
 ['challenge',{humanActionRequired:true},false],['logout',{authenticated:false},false],
 ['account mismatch',new BridgeError('account changed','ACCOUNT_CHANGED'),true],
 ['login failure',new BridgeError('login required','UNAUTHENTICATED'),true],
])test(`CLI ${label} requires an explicit restart without continued polling or heartbeat`,async()=>{
 let runs=0,sleeps=0,beats=0,tick,cleared=false;
 const outcome=await runCliLoop({}, {adapter:{},journal:{},run:async()=>{runs++;if(throws)throw result;return result;},heartbeat:async()=>{beats++;return{ok:true};},schedule:cb=>{tick=cb;return{unref(){}};},cancel:()=>{cleared=true;},sleep:async()=>{sleeps++;},logger(){},errorLogger(){}});
 assert.equal(outcome.manualRequired,true);assert.equal(runs,1);assert.equal(sleeps,0);assert.equal(cleared,true);await tick();assert.equal(beats,0);
});

test('CLI passive stalls recover in place using the same bounded policy as the desktop',async()=>{
 let now=0,runs=0,recoveries=0;const controller=new AbortController();
 const outcome=await runCliLoop({}, {adapter:{},journal:{},signal:controller.signal,now:()=>now,run:async(_config,options)=>{runs++;if(options.recoverAccount){recoveries++;controller.abort();return{authenticated:true};}return{authenticated:false,verificationPending:true};},heartbeat:async()=>({ok:true}),schedule:()=>({unref(){}}),cancel(){},sleep:async ms=>{now+=ms;},logger(){},errorLogger(){}});
 assert.equal(outcome.manualRequired,false);assert.equal(runs,13);assert.equal(now,60000);assert.equal(recoveries,1);
});
