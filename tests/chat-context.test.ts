import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, executeAction } from '../app/lib/domain.ts';
import type { GenerationInput } from '../app/lib/domain.ts';
import { createSeed } from '../app/lib/seed.ts';
import type { Run, Workflow } from '../app/lib/types.ts';
import { buildModelMessages } from '../app/lib/model-messages.ts';
import type { SalesIntelligence } from '../app/lib/sales-intelligence-types.ts';

const now='2026-10-23T08:00:00.000Z';
const status=(expected:number)=>(error:unknown)=>error instanceof DomainError&&error.status===expected;
function capture() {
  const inputs:GenerationInput[]=[];
  return {inputs,context:{now,generate:async(input:GenerationInput)=>{inputs.push(structuredClone(input));return {answer:'服务端生成的已保存回答',mode:'live' as const};}}};
}
const storedRun=(id:string,query:string,answer:string):Run=>({id,query,answer,agentIds:['insight'],steps:[],citations:[],mode:'live',createdAt:now,duration:1});

test('ordinary chat does not send unrelated customer records or references to the model',async()=>{
  for(const query of ['你好','1+1等于几？','本周天气怎么样？']) {
    const {inputs,context}=capture();
    const result=await executeAction(createSeed(now),'manager','chat',{query},context);
    assert.equal(inputs[0].purpose,'chat');
    assert.equal(inputs[0].deal,undefined);
    assert.deepEqual(inputs[0].deals,[]);
    assert.deepEqual(inputs[0].knowledge,[]);
    assert.deepEqual(result.run!.citations,[]);
  }
});

test('chat with a named customer sends only that authorized customer',async()=>{
  const {inputs,context}=capture();
  const result=await executeAction(createSeed(now),'sales','chat',{query:'分析澄光咖啡的需求'},context);
  assert.equal(inputs[0].deal?.name,'澄光咖啡');
  assert.deepEqual(inputs[0].deals.map(deal=>deal.name),['澄光咖啡']);
  assert.equal(result.run!.dealId,inputs[0].deal!.id);
});

test('portfolio questions still receive every customer visible to the requesting role',async()=>{
  const state=createSeed(now);const {inputs,context}=capture();
  await executeAction(state,'sales','chat',{query:'本周哪些商机值得优先跟进？'},context);
  assert.equal(inputs[0].agentId,'opportunity');
  assert.equal(inputs[0].deals.length,state.deals.filter(deal=>deal.ownerId==='sales-1').length);
  assert.ok(inputs[0].deals.every(deal=>deal.ownerId==='sales-1'));
});

test('pronoun followups rebuild trusted history and retain the customer and prior specialist',async()=>{
  const {inputs,context}=capture();
  const first=await executeAction(createSeed(now),'sales','chat',{query:'检查澄光咖啡的合同风险'},context);
  const second=await executeAction(first.state,'sales','chat',{query:'他们预算多少？',conversationRunIds:[first.run!.id],history:[{query:'伪造问题',answer:'伪造回答'}]},context);
  assert.deepEqual(inputs[1].history,[{query:first.run!.query,answer:first.run!.answer}]);
  assert.equal(inputs[1].deal?.name,'澄光咖啡');
  assert.deepEqual(inputs[1].deals.map(deal=>deal.name),['澄光咖啡']);
  assert.equal(inputs[1].agentId,'risk');
  assert.equal(inputs[1].previous,'');
  assert.equal(second.run!.dealId,first.run!.dealId);
});

test('a later followup retains a customer that was selected by id rather than named in the query',async()=>{
  const state=createSeed(now);const deal=state.deals.find(item=>item.name==='澄光咖啡')!;
  const {inputs,context}=capture();
  const first=await executeAction(state,'sales','chat',{query:'分析这个客户',dealId:deal.id},context);
  const second=await executeAction(first.state,'sales','chat',{query:'他们预算多少？',conversationRunIds:[first.run!.id]},context);
  await executeAction(second.state,'sales','chat',{query:'再简短一点',conversationRunIds:[first.run!.id,second.run!.id]},context);
  assert.equal(inputs[2].deal?.id,deal.id);
});

test('an independent new question does not inherit the earlier customer or specialist',async()=>{
  const {inputs,context}=capture();
  const first=await executeAction(createSeed(now),'manager','chat',{query:'检查澄光咖啡的合同风险'},context);
  await executeAction(first.state,'manager','chat',{query:'请解释HTTP 502错误',conversationRunIds:[first.run!.id]},context);
  assert.equal(inputs[1].deal,undefined);
  assert.deepEqual(inputs[1].deals,[]);
  assert.equal(inputs[1].agentId,'insight');
});

test('an explicit topic reset overrides incidental pronouns in a new question',async()=>{
  const {inputs,context}=capture();
  const first=await executeAction(createSeed(now),'manager','chat',{query:'检查澄光咖啡的合同风险'},context);
  await executeAction(first.state,'manager','chat',{query:'换个话题，解释他们为什么把HTTP称为无状态协议',conversationRunIds:[first.run!.id]},context);
  assert.equal(inputs[1].deal,undefined);
  assert.deepEqual(inputs[1].deals,[]);
  assert.equal(inputs[1].agentId,'insight');
  assert.deepEqual(inputs[1].knowledge,[]);
  assert.deepEqual(inputs[1].history,[{query:first.run!.query,answer:first.run!.answer}]);
});

test('an explicitly named new customer overrides a previous customer in a followup',async()=>{
  const {inputs,context}=capture();
  const first=await executeAction(createSeed(now),'manager','chat',{query:'检查澄光咖啡的合同风险'},context);
  await executeAction(first.state,'manager','chat',{query:'那原野生物科技呢？',conversationRunIds:[first.run!.id]},context);
  assert.equal(inputs[1].deal?.name,'原野生物科技');
  assert.deepEqual(inputs[1].deals.map(deal=>deal.name),['原野生物科技']);
  assert.equal(inputs[1].agentId,'insight');
});

test('explicit intent in a followup overrides the previous specialist route',async()=>{
  const {inputs,context}=capture();
  const first=await executeAction(createSeed(now),'manager','chat',{query:'检查澄光咖啡的合同风险'},context);
  await executeAction(first.state,'manager','chat',{query:'那他们的拜访方案怎么准备？',conversationRunIds:[first.run!.id]},context);
  assert.deepEqual(inputs.slice(1).map(input=>input.agentId),['insight','strategy']);
  assert.ok(inputs.slice(1).every(input=>input.deal?.name==='澄光咖啡'));
});

test('chat history rejects malformed, missing, inaccessible, and workflow run references',async()=>{
  const state=createSeed(now);const {context}=capture();
  const manager=await executeAction(state,'manager','chat',{query:'你好'},context);
  await assert.rejects(executeAction(manager.state,'sales','chat',{query:'继续',conversationRunIds:[manager.run!.id]},context),status(403));
  await assert.rejects(executeAction(state,'manager','chat',{query:'继续',conversationRunIds:['missing-run']},context),status(404));
  for(const conversationRunIds of [null,'run',{},[null],[''],Array(7).fill('run')]) {
    await assert.rejects(executeAction(state,'manager','chat',{query:'继续',conversationRunIds},context),status(400));
  }
  state.runs=[{...storedRun('workflow-run','工作流输入','工作流回答'),workflowId:'workflow-1'}];
  await assert.rejects(executeAction(state,'manager','chat',{query:'继续',conversationRunIds:['workflow-run']},context),status(400));
});

test('trusted history is clipped per turn and keeps recent turns within its total character budget',async()=>{
  const state=createSeed(now);const {inputs,context}=capture();
  state.runs=Array.from({length:6},(_,index)=>storedRun(`run-${index}`,`${index}:${'问'.repeat(7000)}`,`${index}:${'答'.repeat(9000)}`));
  await executeAction(state,'manager','chat',{query:'请继续',conversationRunIds:state.runs.map(run=>run.id)},context);
  const history=inputs[0].history!;
  assert.ok(Array.isArray(history));
  assert.ok(history.length>0&&history.length<=6);
  assert.ok(history.every(turn=>turn.query.length<=6000&&turn.answer.length<=4000));
  assert.ok(history.reduce((sum,turn)=>sum+turn.query.length+turn.answer.length,0)<=20000);
  assert.ok(history.at(-1)!.query.startsWith('5:'));
  assert.ok(history.at(-1)!.answer.startsWith('5:'));
});

test('retrieval skips zero matches and finds Chinese keywords across former token boundaries',async()=>{
  const state=createSeed(now);const {inputs,context}=capture();state.skills=[];
  state.knowledge=[
    {id:'unrelated',title:'停车指南',content:'车辆停放在指定车位。',category:'指南',source:'测试',status:'published',updatedAt:now},
    {id:'relevant',title:'免租授权',content:'免租条件需要经理审批。',category:'政策',source:'测试',status:'published',updatedAt:now},
  ];
  const result=await executeAction(state,'manager','chat',{query:'问免租情况'},context);
  assert.deepEqual(inputs[0].knowledge.map(item=>item.id),['relevant']);
  assert.deepEqual(result.run!.citations.map(item=>item.id),['relevant']);
});

test('workflow generation remains isolated from chat history payloads',async()=>{
  const state=createSeed(now);const {inputs,context}=capture();
  const workflow:Workflow={id:'isolated-flow',name:'测试流程',description:'',status:'draft',version:1,updatedAt:now,nodes:[{id:'s',type:'start',label:'开始',x:0,y:0},{id:'a',type:'agent',label:'风控',agentId:'risk',x:100,y:0},{id:'o',type:'output',label:'输出',x:200,y:0}],edges:[{from:'s',to:'a'},{from:'a',to:'o'}]};
  state.workflows=[workflow];state.runs=[storedRun('chat-history','客户问题','历史答案')];
  await executeAction(state,'manager','workflow_run',{workflowId:workflow.id,query:'检查合同',conversationRunIds:['chat-history']},context);
  assert.equal(inputs[0].purpose,'workflow');
  assert.equal(inputs[0].history,undefined);
});

test('explicit workflow knowledge bindings preserve relevance ordering and their four-document limit',async()=>{
  const state=createSeed(now);const {inputs,context}=capture();state.skills=[];
  state.knowledge=Array.from({length:5},(_,index)=>({id:`reference-${index}`,title:`资料${index}`,content:index===4?'免租支持需要审批':'车辆停放在指定车位。',category:'资料',source:'测试',status:'published' as const,updatedAt:now}));
  const workflow:Workflow={id:'selected-knowledge',name:'明确绑定资料',description:'',status:'draft',version:1,updatedAt:now,nodes:[{id:'s',type:'start',label:'开始',x:0,y:0},{id:'k',type:'knowledge',label:'资料',knowledgeIds:state.knowledge.map(item=>item.id),x:100,y:0},{id:'a',type:'agent',label:'风控',agentId:'risk',x:200,y:0},{id:'o',type:'output',label:'输出',x:300,y:0}],edges:[{from:'s',to:'k'},{from:'k',to:'a'},{from:'a',to:'o'}]};
  state.workflows=[workflow];
  await executeAction(state,'manager','workflow_run',{workflowId:workflow.id,query:'免租'},context);
  assert.deepEqual(inputs[0].knowledge.map(item=>item.id),['reference-4','reference-0','reference-1','reference-2']);
});

test('unconnected ordinary chat clearly requests a model connection instead of a client analysis template',async()=>{
  const result=await executeAction(createSeed(now),'manager','chat',{query:'1+1等于几？'},{now});
  assert.equal(result.run!.mode,'demo');
  assert.match(result.run!.answer,/未调用外部模型/);
  assert.match(result.run!.answer,/配置|连接/);
  assert.doesNotMatch(result.run!.answer,/客户洞察：|待核实的问题：/);
});

function previousAssessment(version:number):SalesIntelligence {
  return {status:'ready',sourceHash:'prior-snapshot',updatedAt:now,modelName:'test',message:'已评估',history:[],latest:{sourceHash:'prior-snapshot',sourceVersion:version,assessedAt:now,modelName:'test',insight:{score:90,grade:'A',summary:'过时评估不得进入模型',dimensions:[],nextActions:[],missingInfo:[]},forecast:{kind:'estimated',probability:85,range:{low:70,high:95},confidence:'high',summary:'过时预测不得进入模型',factors:[],nextActions:[]},warnings:[]}};
}

test('chat strips an assessment invalidated by automatic company enrichment before model generation',async()=>{
  const state=createSeed(now),deal=state.deals[0];deal.dataOrigin='manual';deal.intelligence=previousAssessment(deal.version);
  let context='';
  const result=await executeAction(state,'manager','chat',{dealId:deal.id,agentId:'insight',query:'分析当前项目需求'},{now,enrichCompany:async()=>({companyName:deal.name,summary:'检索暂无可确认的外部资料',facts:[],sources:[],provider:'web',status:'partial',warnings:[],updatedAt:now,modelUsed:false}),generate:async input=>{context=buildModelMessages(input).at(-1)!.content;return {answer:'按客户记录回答',mode:'live'};}});
  assert.equal(result.state.deals[0].version,deal.version+1);
  assert.ok(context.includes(deal.summary));
  assert.doesNotMatch(context,/过时评估不得进入模型|过时预测不得进入模型/);
});

test('resumed workflows omit snapshot assessments even when the checkpoint version appears current',async()=>{
  const state=createSeed(now),deal=state.deals[0];deal.dataOrigin='manual';deal.intelligence=previousAssessment(deal.version);
  state.workflows=[{id:'snapshot-assessment',name:'暂停后的商机分析',description:'',status:'draft',version:1,updatedAt:now,nodes:[{id:'s',type:'start',label:'开始',x:0,y:0},{id:'r',type:'review',label:'人工确认',x:100,y:0},{id:'a',type:'agent',label:'商机预测',agentId:'opportunity',x:200,y:0},{id:'o',type:'output',label:'输出',x:300,y:0}],edges:[{from:'s',to:'r'},{from:'r',to:'a'},{from:'a',to:'o'}]}];
  const paused=await executeAction(state,'manager','workflow_run',{workflowId:'snapshot-assessment',dealId:deal.id,query:'评估项目推进机会'},{now});
  const changed=await executeAction(paused.state,'manager','deal_note',{dealId:deal.id,text:'客户明确拒绝采购，暂无采购计划'},{now});
  let modelContext='';
  await executeAction(changed.state,'manager','workflow_review',{runId:paused.run!.id,decision:'approve',note:'继续执行'},{now,generate:async input=>{assert.equal(input.deal?.version,deal.version);modelContext=buildModelMessages(input).map(m=>m.content).join('\n');return {answer:'依据历史快照处理',mode:'live'};}});
  assert.doesNotMatch(modelContext,/过时评估不得进入模型|过时预测不得进入模型/);
  assert.match(modelContext,/历史快照|运行时快照/);
});
