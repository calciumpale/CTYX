import test from 'node:test';
import assert from 'node:assert/strict';
import { createKnowledgeRequestIdentity } from '../app/components/knowledge-request-identity.ts';
test('ambiguous accepted upload/rechunk retry retains identity; changed intent gets a new identity',()=>{let next=0;const identity=createKnowledgeRequestIdentity(()=>String(++next));const intent={action:'upload',text:'原文',config:{chunkSize:750}};assert.equal(identity(intent),identity(structuredClone(intent)));assert.notEqual(identity(intent),identity({...intent,text:'修改'}));assert.notEqual(identity(intent),identity({...intent,action:'beginRechunk'}));});
test('accepted response retires identity while ambiguous failure leaves retry identity intact',()=>{let next=0;const identity=createKnowledgeRequestIdentity(()=>String(++next));const intent={action:'upload',text:'原文'};const first=identity(intent);assert.equal(identity(intent),first);identity.retire(intent);assert.notEqual(identity(intent),first);});

test('cancelled or superseded document intents retire while unknown retries remain stable',()=>{
 let n=0;const identity=createKnowledgeRequestIdentity(()=>String(++n));const a={action:'beginRechunk',documentId:'a',version:1},b={...a,documentId:'b'};
 const first=identity(a),other=identity(b);assert.equal(identity(a),first);identity.retireDocument('a');assert.notEqual(identity(a),first);assert.equal(identity(b),other);
});

import { driveRechunk, documentWithRechunkJob } from '../app/components/knowledge-rechunk-driver.ts';
import type { KnowledgeDocument, KnowledgeRechunkJob } from '../app/lib/knowledge-library-types.ts';
const doc={id:'a',contentVersion:1} as KnowledgeDocument;
const job={id:'j',documentId:'a',status:'indexing',chunkCount:33,indexedCount:0} as KnowledgeRechunkJob;
test('actual sibling job response drives 33 chunks across three batches and clears completed metadata',async()=>{
 let calls=0;const seen:KnowledgeDocument[]=[];
 const result=await driveRechunk({document:doc,job},async()=>{calls++;return {document:doc,job:{...job,indexedCount:Math.min(calls*16,33),status:calls===3?'completed':'indexing'}};},r=>seen.push(documentWithRechunkJob(r)));
 assert.equal(calls,3);assert.equal(seen[1].rechunkJob?.indexedCount,16);assert.equal(result.reason,'completed');assert.equal(seen.at(-1)?.rechunkJob,undefined);
});
for(const status of ['indexing','ready'] as const)test(`unchanged ${status} yields immediately without timers or hammering`,async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0;
 const initial={document:doc,job:{...job,status}};
 const result=await driveRechunk(initial,async()=>{calls++;return initial;},()=>{});
 t.mock.timers.tick(120000);assert.equal(calls,1);assert.equal(result.reason,'waiting');
});
test('race errors remain visible, accepted progress survives a thrown response, cancelled is not completed',async()=>{
 const seen:KnowledgeDocument[]=[];const observe=(r:Parameters<typeof documentWithRechunkJob>[0])=>seen.push(documentWithRechunkJob(r));
 const error=await driveRechunk({document:doc,job},async()=>({document:doc,job:{...job,status:'error',error:'race'}}),observe);assert.equal(error.reason,'error');assert.equal(seen.at(-1)?.rechunkJob?.error,'race');
 await assert.rejects(()=>driveRechunk({document:doc,job:{...job,indexedCount:16}},async()=>{throw Error('lost response');},observe));assert.equal(seen.at(-1)?.rechunkJob?.indexedCount,16);
 const cancelled=await driveRechunk({document:doc,job},async()=>({document:doc,job:{...job,status:'cancelled'}}),observe);assert.equal(cancelled.reason,'cancelled');assert.equal(seen.at(-1)?.rechunkJob,undefined);
});
test('driver caps progressing work and pauses only between accepted requests',async()=>{
 let calls=0;const initial={document:doc,job:{...job,chunkCount:6000}};
 const next=async()=>({document:doc,job:{...initial.job,indexedCount:++calls*16}});
 assert.equal((await driveRechunk(initial,next,()=>{})).reason,'paused');assert.equal(calls,8);
 calls=0;assert.equal((await driveRechunk(initial,next,()=>{},()=>calls===1)).reason,'paused');assert.equal(calls,1);
});
