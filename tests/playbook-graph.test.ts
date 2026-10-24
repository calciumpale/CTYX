import test from 'node:test';
import assert from 'node:assert/strict';
import { runPlaybookFeedback } from '../app/lib/playbook-graph.ts';
import { cosineSimilarity, deduplicate, validateVectors } from '../app/lib/talktrack-vectors.ts';
import type { CallTranscript, TalkTrackDraft } from '../app/lib/talktrack-types.ts';

const transcript:CallTranscript={id:'transcript-1',dealId:'deal-1',employeeId:'sales-1',employeeName:'林晓',text:'客户：预算不够。销售：可以先核实核心目标，再分阶段交付，避免为暂时用不到的功能买单。客户：这样可行，我们确认采购。',source:'pasted',createdAt:'2026-10-24T03:00:00.000Z'};
const quote='可以先核实核心目标，再分阶段交付，避免为暂时用不到的功能买单。';
const draft:TalkTrackDraft={topic:'预算异议',scenario:'客户预算有限时',template:'先确认{核心目标}，再讨论分阶段交付。',keywords:['核心目标','分阶段交付'],objectionLogic:['澄清目标','缩小首期范围'],steps:['确认目标','协商交付范围'],boundaries:['不得擅自承诺折扣'],leadTypes:['企业采购'],evidence:[{transcriptId:transcript.id,quote}],confidence:0.86};
const screened=JSON.stringify({segments:[{transcriptId:transcript.id,quote,confidence:0.9}]});
function generated(values:unknown[]) {
  let cursor=0;
  return async()=>JSON.stringify(values[cursor++]);
}
function dependencies(candidates:unknown[],vectors:number[][]=candidates.map(()=>[1,0])) {
  return {generate:generated([JSON.parse(screened),{candidates}]),embed:async()=>({model:'semantic-model-1',vectors})};
}

test('feedback returns only evidenced structured candidates with real embeddings',async()=>{
  const result=await runPlaybookFeedback({transcripts:[transcript],existing:[]},dependencies([draft]));
  assert.equal(result.candidates.length,1);assert.deepEqual(result.candidates[0].draft,draft);
  assert.deepEqual(result.candidates[0].vector,[1,0]);assert.equal(result.candidates[0].model,'semantic-model-1');
  assert.deepEqual(result.duplicates,[]);assert.equal(result.screenedOut,0);assert.equal(result.steps.length,4);
});

test('candidate embeddings use the complete canonical text used again at publication and reindex',async()=>{
  let embedded:string[]=[];
  await runPlaybookFeedback({transcripts:[transcript],existing:[]},{...dependencies([draft]),embed:async(texts)=>{embedded=texts;return {model:'semantic-model-1',vectors:[[1,0]]};}});
  assert.deepEqual(embedded,['预算异议\n适用场景：客户预算有限时\n话术模板：先确认{核心目标}，再讨论分阶段交付。\n关键词：核心目标、分阶段交付\n应对逻辑：澄清目标；缩小首期范围\n步骤：确认目标；协商交付范围\n边界：不得擅自承诺折扣\n线索类型：企业采购']);
});

test('fabricated screening quotes cannot reach extraction or embeddings',async()=>{
  const result=await runPlaybookFeedback({transcripts:[transcript],existing:[]},{generate:async()=>JSON.stringify({segments:[{transcriptId:transcript.id,quote:'客户承诺本月采购一千万元',confidence:0.95}]}),embed:async()=>{throw new Error('invalid evidence reached embedding');}});
  assert.equal(result.candidates.length,0);assert.equal(result.screenedOut,1);
});

test('fabricated candidate evidence is screened out even alongside one valid quote',async()=>{
  const result=await runPlaybookFeedback({transcripts:[transcript],existing:[]},dependencies([{...draft,evidence:[...draft.evidence,{transcriptId:transcript.id,quote:'不存在的成交承诺'}]}],[]));
  assert.equal(result.candidates.length,0);assert.equal(result.screenedOut,1);
});

test('missing fields, empty templates and low confidence never enter review queue',async()=>{
  const {scenario:omitted,...missing}=draft;void omitted;
  const result=await runPlaybookFeedback({transcripts:[transcript],existing:[]},dependencies([missing,{...draft,template:''},{...draft,confidence:0.64}],[]));
  assert.equal(result.candidates.length,0);assert.equal(result.screenedOut,3);
});

test('cosine deduplication checks existing pending or published vectors and this batch',async()=>{
  const other={...draft,topic:'价值澄清',template:'确认{目标}之后再判断价值。'};
  const result=await runPlaybookFeedback({transcripts:[transcript],existing:[{id:'published-1',title:'已审核预算话术',model:'semantic-model-1',vector:[1,0]}]},dependencies([draft,other],[ [0.98,0.02],[0,1] ]));
  assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].draft.topic,'价值澄清');assert.equal(result.duplicates.length,1);assert.equal(result.duplicates[0].title,'已审核预算话术');assert.ok(result.duplicates[0].score>0.99);
  const batch=await runPlaybookFeedback({transcripts:[transcript],existing:[]},dependencies([draft,other],[[1,0],[0.99,0.01]]));
  assert.equal(batch.candidates.length,1);assert.equal(batch.duplicates.length,1);
});

test('different embedding models are never compared and same-model dimensions must match',()=>{
  const candidate={title:'新话术',model:'new-model',vector:[1,0]};
  assert.equal(deduplicate([candidate],[{id:'old',title:'旧模型',model:'old-model',vector:[1,0,0]}]).accepted.length,1);
  assert.throws(()=>deduplicate([candidate],[{id:'old',title:'维度已变',model:'new-model',vector:[1,0,0]}]),/维度|dimension/i);
});

test('vectors reject zero, NaN, infinity, mixed dimensions and count mismatches',()=>{
  for(const value of [[[0,0]],[[NaN,1]],[[Infinity,1]],[[1,0],[1,0,0]],[['1',0]],[]])assert.throws(()=>validateVectors(value));
  assert.throws(()=>validateVectors([[1,0]],2));assert.deepEqual(validateVectors([[1,0],[0,1]],2),[[1,0],[0,1]]);
  assert.equal(cosineSimilarity([1,0],[0,1]),0);assert.equal(cosineSimilarity([1,0],[1,0]),1);assert.equal(cosineSimilarity([1,0],[-1,0]),-1);
});

test('invalid embedding batch cannot produce a partially deduplicated review candidate',async()=>{
  await assert.rejects(()=>runPlaybookFeedback({transcripts:[transcript],existing:[]},dependencies([draft],[[NaN,0]])),/向量|embedding/i);
});

test('malformed model JSON fails without echoing untrusted provider content',async()=>{
  await assert.rejects(()=>runPlaybookFeedback({transcripts:[transcript],existing:[]},{generate:async()=>'{PRIVATE_PROVIDER_BODY',embed:async()=>({model:'x',vectors:[]})}),error=>error instanceof Error&&!error.message.includes('PRIVATE_PROVIDER_BODY'));
});

test('at most three evidenced candidates are returned for one closed project',async()=>{
  const drafts=[0,1,2,3].map(i=>({...draft,topic:`场景${i}`,template:`方案${i}：${draft.template}`}));
  const result=await runPlaybookFeedback({transcripts:[transcript],existing:[]},dependencies(drafts,[[1,0,0],[0,1,0],[0,0,1]]));
  assert.equal(result.candidates.length,3);assert.equal(result.screenedOut,1);
});
