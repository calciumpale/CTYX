import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeed } from '../app/lib/seed.ts';
import { analyzeSalesIntelligence, salesFingerprint, salesInput } from '../app/lib/sales-intelligence.ts';
import type { Deal } from '../app/lib/types.ts';
import type { SalesGenerate } from '../app/lib/sales-intelligence-types.ts';

const now='2026-10-24T09:00:00.000Z';
function deal():Deal {return {...createSeed(now).deals[0],dataOrigin:'manual',summary:'客户确认需要采购系统并希望一个月内上线。',needs:['采购审批线上化'],customerProfile:{decisionChain:'总经理负责最终采购决策',goals:'减少人工审批',concerns:'迁移期间业务不能中断',budget:'预算20万元已经批准',timeline:'一个月内完成采购'},notes:[{id:'note-new',text:'客户已约定周五与总经理讨论合同，确认本月采购。',author:'林晓',date:now}]};}
function modelPayload(scores=[25,20,20,20,15]) {return {insight:{summary:'客户有明确采购目标，预算与决策链已记录。',dimensions:['need','budget','decision','timeline','engagement'].map((key,index)=>({key,score:scores[index] as number|null,reason:'客户记录提供了对应依据',evidence:[{refId:key==='engagement'?'note:note-new':key==='need'?'project:needs':`profile:${key==='decision'?'decisionChain':key}`,quote:key==='engagement'?'客户已约定周五与总经理讨论合同，确认本月采购。':key==='need'?'采购审批线上化':key==='budget'?'预算20万元已经批准':key==='decision'?'总经理负责最终采购决策':'一个月内完成采购'}]})),nextActions:[{action:'周五与总经理确认合同范围和签署时间',reason:'将已约定的采购沟通落实为签约计划',evidence:[{refId:'note:note-new',quote:'客户已约定周五与总经理讨论合同，确认本月采购。'}]}],missingInfo:['待确认签署人及付款节点']},forecast:{probability:72,range:{low:55,high:85},confidence:'medium',summary:'根据已记录采购进展估计，仍需核实签署安排。',factors:[{direction:'positive',reason:'客户主动约定决策人沟通',evidence:[{refId:'note:note-new',quote:'客户已约定周五与总经理讨论合同，确认本月采购。'}]}],nextActions:[{action:'在周五会议确认签署人和付款节点',reason:'解决合同签署的剩余不确定性',evidence:[{refId:'note:note-new',quote:'客户已约定周五与总经理讨论合同，确认本月采购。'}]}]}};}
type ModelPayload=ReturnType<typeof modelPayload>;
function response(scores=[25,20,20,20,15]){return JSON.stringify(modelPayload(scores));}
const generate:SalesGenerate=async()=>response();

test('sales input excludes public registry evidence and audio content, and fingerprints all saved followups',async()=>{
  const d=deal();d.companyProfile={companyName:d.name,summary:'注册资本巨大，采购意向非常强',facts:[{label:'注册资本',value:'100亿元',sourceIds:['external']}],sources:[{id:'external',title:'登记资料',url:'https://example.com',provider:'web',retrievedAt:now}],provider:'web',status:'ready',warnings:[],updatedAt:now,modelUsed:true};
  d.notes.push({id:'audio',text:'',author:'林晓',date:now,recording:{id:'recording-1',name:'购买意向很高.mp3',size:99,mimeType:'audio/mpeg'}});
  const input=salesInput(d,[]);assert.ok(!JSON.stringify(input.sources).includes('100亿元'));assert.ok(!JSON.stringify(input.sources).includes('购买意向很高'));assert.ok(input.warnings.some(w=>/录音/.test(w)));
  const hash=await salesFingerprint(d,[]);d.notes.push({id:'old',text:'较早记录：客户未确认预算',author:'林晓',date:'2026-01-01'});assert.notEqual(await salesFingerprint(d,[]),hash);
  const many=deal();many.notes=Array.from({length:100},(_,i)=>({id:`n-${i}`,text:`跟进${i}：`+'字'.repeat(3000),author:'林晓',date:now}));const bounded=salesInput(many,[]);assert.ok(JSON.stringify(bounded).length<50000);assert.ok(bounded.coverage.truncated);const before=await salesFingerprint(many,[]);many.notes[99].text+='新增更正';assert.notEqual(await salesFingerprint(many,[]),before);
});
test('grade uses five bounded dimension scores and forecast remains a distinct uncalibrated estimate',async()=>{
  for(const [scores,wantScore,wantGrade] of [[[25,20,15,10,5],75,'A'],[[10,10,5,5,0],30,'B'],[[5,5,5,5,5],25,'C']] as const){const result=await analyzeSalesIntelligence(deal(),[],async()=>response([...scores]),now,'test-model');assert.equal(result.latest?.insight.score,wantScore);assert.equal(result.latest?.insight.grade,wantGrade);assert.equal(result.latest?.forecast.probability,72);assert.equal(result.latest?.forecast.kind,'estimated');assert.ok(result.latest?.warnings.some(w=>/校准/.test(w)));}
});
test('large baseline fields cannot exclude the latest followup and transcript from analysis',()=>{
  const d=deal();d.summary='需求背景'.repeat(1200);d.needs=Array.from({length:20},()=> '详细需求'.repeat(500));d.customerProfile={decisionChain:'链'.repeat(2000),goals:'目'.repeat(2000),concerns:'虑'.repeat(2000),budget:'款'.repeat(2000),timeline:'时'.repeat(2000)};
  const input=salesInput(d,[{id:'call-latest',dealId:d.id,employeeId:'sales-1',employeeName:'林晓',text:'客户最新答复：采购预算仍未批准，我们下周再确认。',createdAt:now,source:'pasted'}]);assert.ok(input.sources.some(s=>s.id==='note:note-new'));assert.ok(input.sources.some(s=>s.id==='transcript:call-latest'));
});
test('fabricated evidence, external intent evidence, oversized scores and invalid intervals fail closed',async()=>{
  for(const change of [(v:ModelPayload)=>{v.insight.dimensions[0].evidence[0].quote='客户保证会签约';},(v:ModelPayload)=>{v.insight.dimensions[0].evidence[0].refId='company:external';},(v:ModelPayload)=>{v.insight.dimensions[0].score=26;},(v:ModelPayload)=>{v.forecast.range={low:90,high:40};},(v:ModelPayload)=>{v.forecast.probability=NaN;},(v:ModelPayload)=>{v.forecast.nextActions[0].evidence[0].quote='不存在的原话';}]) {const raw=modelPayload();change(raw);await assert.rejects(()=>analyzeSalesIntelligence(deal(),[],async()=>JSON.stringify(raw),now,'test-model'),/证据|格式|评分|概率|区间/);}
  await assert.rejects(()=>analyzeSalesIntelligence(deal(),[],async()=>'{bad secret-provider-text',now,'test-model'),e=>e instanceof Error&&!e.message.includes('secret-provider-text'));
});
test('sparse records stay unknown with useful followup actions without a model call',async()=>{
  const d=deal();d.summary='';d.needs=[];d.customerProfile=undefined;d.notes=[];let calls=0;const out=await analyzeSalesIntelligence(d,[],async()=>{calls++;return response();},now,'test-model');assert.equal(calls,0);assert.equal(out.status,'needs_info');assert.equal(out.latest?.insight.grade,null);assert.equal(out.latest?.insight.score,null);assert.equal(out.latest?.forecast.probability,null);assert.ok(out.latest?.insight.nextActions.length);assert.ok(out.latest?.forecast.nextActions.length);
});
test('insufficient known rubric dimensions cannot fabricate a total score or probability',async()=>{
  const raw=modelPayload();raw.insight.dimensions=raw.insight.dimensions.map(d=>d.key==='need'?d:{...d,score:null,evidence:[],reason:'尚未确认'});const out=await analyzeSalesIntelligence(deal(),[],async()=>JSON.stringify(raw),now,'test-model');assert.equal(out.status,'needs_info');assert.equal(out.latest?.insight.score,null);assert.equal(out.latest?.forecast.probability,null);
});
test('explicit customer rejection cannot produce an A grade and must be represented as negative evidence',async()=>{
  const d=deal();d.notes.unshift({id:'refusal',text:'客户明确拒绝采购，表示今年没有采购计划。',author:'林晓',date:now});await assert.rejects(()=>analyzeSalesIntelligence(d,[],generate,now,'test-model'),/拒绝|负面|冲突/);
  const raw=JSON.parse(response([5,5,5,5,0]));raw.forecast.probability=10;raw.forecast.range={low:0,high:20};raw.forecast.factors.push({direction:'negative',reason:'最新记录说明采购被拒绝',evidence:[{refId:'note:refusal',quote:'客户明确拒绝采购，表示今年没有采购计划。'}]});const out=await analyzeSalesIntelligence(d,[],async()=>JSON.stringify(raw),now,'test-model');assert.equal(out.latest?.insight.grade,'C');assert.ok(out.latest?.forecast.factors.some(f=>f.direction==='negative'));
});
test('won and lost are observed outcomes without calling a forecast model',async()=>{
  for(const [outcome,probability] of [['won',100],['lost',0]] as const){const d=deal();d.outcome=outcome;const out=await analyzeSalesIntelligence(d,[],async()=>{throw new Error('observed outcome must not invoke model');},now,'test-model');assert.equal(out.latest?.forecast.probability,probability);assert.equal(out.latest?.forecast.kind,'observed');assert.equal(out.latest?.insight.score,null);assert.equal(out.latest?.insight.grade,null);}
});
