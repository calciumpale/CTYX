import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionRecovery } from '../tools/douyin-bridge/connection-recovery.mjs';

test('temporary unknown identity gets bounded recovery with cooldown, while success resets the outage',()=>{
 let now=0;const policy=createConnectionRecovery({now:()=>now});
 policy.observe({authenticated:false,verificationPending:true});
 now=14999;assert.equal(policy.takeRecovery(),false);
 now=15000;assert.equal(policy.takeRecovery(),true);assert.equal(policy.status().attempts,1);
 policy.observe({authenticated:false,verificationPending:true});
 now=74999;assert.equal(policy.takeRecovery(),false);now=75000;assert.equal(policy.takeRecovery(),true);
 now=900000;assert.equal(policy.takeRecovery(),false);assert.equal(policy.status().manualRequired,true);
 policy.request();assert.equal(policy.takeRecovery(),true);assert.equal(policy.takeRecovery(),false);
 policy.observe({authenticated:true});assert.equal(policy.status().attempts,0);assert.equal(policy.status().pending,false);
 policy.observe({authenticated:false,verificationPending:true});now+=15000;assert.equal(policy.takeRecovery(),true);
});

test('real logout and challenge never become an automatic identity refresh',()=>{
 for(const result of [{authenticated:false},{authenticated:false,verificationPending:false},{humanActionRequired:true}]){
  let now=0;const policy=createConnectionRecovery({now:()=>now});policy.observe(result);now=100000;assert.equal(policy.takeRecovery(),false);
 }
});
