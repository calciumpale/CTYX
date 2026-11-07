import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionRecovery } from '../tools/douyin-bridge/connection-recovery.mjs';

test('automatic recovery waits one minute, spaces refreshes five minutes apart, and stops after two attempts',()=>{
 let now=0;const policy=createConnectionRecovery({now:()=>now});
 policy.observe({authenticated:false,verificationPending:true});
 assert.equal(policy.status().nextAt,60000);
 now=59999;assert.equal(policy.takeRecovery(),false);
 now=60000;assert.equal(policy.takeRecovery(),true);assert.equal(policy.status().attempts,1);
 assert.equal(policy.status().nextAt,360000);
 policy.observe({authenticated:false,verificationPending:true});
 now=359999;assert.equal(policy.takeRecovery(),false);now=360000;assert.equal(policy.takeRecovery(),true);
 now=900000;assert.equal(policy.takeRecovery(),false);assert.equal(policy.status().manualRequired,true);
 assert.equal(policy.status().nextAt,null);
});

test('brief authentication resets the outage budget without clearing the last refresh cooldown',()=>{
 let now=0;const policy=createConnectionRecovery({now:()=>now});
 policy.observe({authenticated:false,verificationPending:true});
 now=60000;assert.equal(policy.takeRecovery(),true);
 now=61000;policy.observe({authenticated:true});
 assert.equal(policy.status().attempts,0);assert.equal(policy.status().pending,false);assert.equal(policy.status().nextAt,null);
 now=62000;policy.observe({authenticated:false,verificationPending:true});
 assert.equal(policy.status().nextAt,360000);
 now=122000;assert.equal(policy.takeRecovery(),false,'A fresh outage delay must not bypass the global cooldown');
 now=359999;assert.equal(policy.takeRecovery(),false);
 now=360000;assert.equal(policy.takeRecovery(),true);assert.equal(policy.status().attempts,1);
});

test('an explicit manual retry grants one immediate attempt and leaves later automatic retries bounded',()=>{
 let now=0;const policy=createConnectionRecovery({now:()=>now});
 policy.observe({authenticated:false,verificationPending:true});
 policy.request();policy.request();assert.equal(policy.takeRecovery(),true);assert.equal(policy.takeRecovery(),false);
 assert.equal(policy.status().attempts,1);assert.equal(policy.status().nextAt,300000);
 now=299999;assert.equal(policy.takeRecovery(),false);
 now=300000;assert.equal(policy.takeRecovery(),true);assert.equal(policy.status().manualRequired,true);
 now=900000;assert.equal(policy.takeRecovery(),false);
 policy.request();assert.equal(policy.takeRecovery(),true);assert.equal(policy.takeRecovery(),false);
 assert.equal(policy.status().attempts,1);assert.equal(policy.status().nextAt,1200000);
});

test('manual requests while not pending cannot authorize a later automatic refresh',()=>{
 let now=0;const policy=createConnectionRecovery({now:()=>now});
 policy.request();policy.observe({authenticated:false,verificationPending:true});
 now=59999;assert.equal(policy.takeRecovery(),false);
});

test('real logout and challenge never become an automatic identity refresh',()=>{
 for(const result of [{authenticated:false},{authenticated:false,verificationPending:false},{humanActionRequired:true}]){
  let now=0;const policy=createConnectionRecovery({now:()=>now});policy.observe(result);now=100000;assert.equal(policy.takeRecovery(),false);
 }
});
