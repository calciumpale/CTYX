import test from 'node:test';
import assert from 'node:assert/strict';
import {DomainError,executeAction,projectState,routeAgents,validateWorkflow} from '../app/lib/domain.ts';
import {createSeed} from '../app/lib/seed.ts';
import type {GenerationInput} from '../app/lib/domain.ts';
import type {Workflow} from '../app/lib/types.ts';

const now='2026-10-23T08:00:00.000Z';
const context={now,generate:async(input:GenerationInput)=>({answer:`${input.agentId}:${input.instruction??''}`,mode:'demo' as const})};
const status=(code:number)=>(error:unknown)=>error instanceof DomainError&&error.status===code;
function flow():Workflow{return {id:'test-flow',name:'客户准备',description:'自建业务应用',kind:'workflow',version:1,status:'draft',updatedAt:now,nodes:[{id:'s',type:'start',label:'开始',x:0,y:0},{id:'a',type:'agent',label:'洞察',agentId:'insight',instruction:'旧版指令',x:200,y:0},{id:'o',type:'output',label:'输出',x:400,y:0}],edges:[{from:'s',to:'a'},{from:'a',to:'o'}]};}
function reviewFlow():Workflow{const item=flow();item.nodes.splice(2,0,{id:'r',type:'review',label:'管理者确认',x:400,y:0},{id:'b',type:'agent',label:'策略',agentId:'strategy',instruction:'审核后执行',x:600,y:0});item.edges=[{from:'s',to:'a'},{from:'a',to:'r'},{from:'r',to:'b'},{from:'b',to:'o'}];return item;}
function branching():Workflow{const item=flow();item.nodes.splice(1,0,{id:'i',type:'intent',label:'判断意图',x:100,y:0});item.nodes.push({id:'b',type:'agent',label:'风控',agentId:'risk',instruction:'只处理风险',x:200,y:200});item.edges=[{from:'s',to:'i'},{from:'i',to:'a',condition:'default'},{from:'i',to:'b',condition:'risk'},{from:'a',to:'o'},{from:'b',to:'o'}];return item;}

test('draft debug executes the supplied unsaved graph without creating or replacing a saved workflow',async()=>{
  const state=createSeed(now);const original=flow();state.workflows=[original];const draft=flow();draft.nodes[1].instruction='正在编辑的新指令';
  const result=await executeAction(state,'manager','workflow_run',{workflowId:original.id,workflow:draft,mode:'draft',query:'准备拜访'},context);
  assert.match(result.run!.answer,/正在编辑的新指令/);assert.equal(result.run!.workflowSource,'draft');assert.equal(result.run!.status,'completed');
  assert.equal(result.state.workflows[0].nodes[1].instruction,'旧版指令');
  const fresh=flow();fresh.id='';const unsaved=await executeAction(state,'manager','workflow_run',{workflow:fresh,mode:'draft',query:'准备拜访'},context);
  assert.equal(unsaved.state.workflows.length,1);assert.equal(unsaved.run!.workflowSource,'draft');
  await assert.rejects(executeAction(state,'sales','workflow_run',{workflow:draft,mode:'draft',query:'越权'},context),status(403));
});

test('saving a changed publication preserves its previous sales version and ignores a forged snapshot',async()=>{
  const state=createSeed(now);state.workflows=[flow()];const published=await executeAction(state,'manager','workflow_publish',{workflowId:'test-flow',version:1},context);
  const current=published.state.workflows[0];const changed=structuredClone(current);changed.name='仍在编辑';changed.nodes[1].instruction='新版未发布';changed.published!.nodes[1].instruction='伪造发布';
  const saved=await executeAction(published.state,'manager','workflow_save',{workflow:changed},context);
  assert.equal(saved.state.workflows[0].status,'published');assert.equal(saved.state.workflows[0].published!.nodes[1].instruction,'旧版指令');
  const sales=projectState(saved.state,'sales').workflows[0];assert.equal(sales.name,'客户准备');assert.equal(sales.nodes[1].instruction,'旧版指令');assert.equal(sales.published,undefined);
  const run=await executeAction(saved.state,'sales','workflow_run',{workflowId:'test-flow',query:'准备拜访'},context);assert.match(run.run!.answer,/旧版指令/);assert.doesNotMatch(run.run!.answer,/新版未发布|伪造发布/);
  const republished=await executeAction(saved.state,'manager','workflow_publish',{workflowId:'test-flow',version:saved.state.workflows[0].version},context);
  assert.equal(projectState(republished.state,'sales').workflows[0].name,'仍在编辑');assert.equal(republished.state.workflows[0].published!.nodes[1].instruction,'新版未发布');
  await assert.rejects(executeAction(republished.state,'manager','workflow_publish',{workflowId:'test-flow',version:republished.state.workflows[0].version},context),status(409));
});

test('legacy published graphs gain a snapshot before editing and legacy manager runs remain valid',async()=>{
  const state=createSeed(now);const old=flow();old.status='published';state.workflows=[old];const changed=structuredClone(old);changed.nodes[1].instruction='未发布新稿';
  const saved=await executeAction(state,'manager','workflow_save',{workflow:changed},context);
  assert.equal(projectState(saved.state,'sales').workflows[0].nodes[1].instruction,'旧版指令');
  const legacy=await executeAction(state,'manager','workflow_run',{workflowId:old.id,query:'准备拜访'},context);assert.match(legacy.run!.answer,/旧版指令/);
});

test('intent routing executes only the matching branch and output receives only reached frames',async()=>{
  const state=createSeed(now);state.workflows=[branching()];const result=await executeAction(state,'manager','workflow_run',{workflowId:'test-flow',query:'检查合同风险'},context);
  assert.deepEqual(result.run!.agentIds,['risk']);assert.match(result.run!.answer,/只处理风险/);assert.doesNotMatch(result.run!.answer,/旧版指令/);
  assert.equal(result.run!.steps.find(step=>step.nodeId==='a')!.status,'skipped');
  const output=result.run!.steps.find(step=>step.nodeId==='o')!;assert.match(output.input!,/只处理风险/);assert.equal(output.output,result.run!.answer);
  const fallback=await executeAction(state,'manager','workflow_run',{workflowId:'test-flow',query:'客户需求是什么'},context);assert.deepEqual(fallback.run!.agentIds,['insight']);
});

test('workflow keyword routing can select each expert condition without changing main-agent collaboration',async()=>{
  const state=createSeed(now);const item=branching();
  const experts=['insight','strategy','opportunity','risk','coach'] as const;
  item.nodes=[item.nodes.find(node=>node.id==='s')!,item.nodes.find(node=>node.id==='i')!,...experts.map((agentId,index)=>({id:`branch-${agentId}`,type:'agent' as const,label:agentId,agentId,x:200,y:index*100})),{id:'fallback',type:'agent',label:'默认洞察',agentId:'insight',x:200,y:600},item.nodes.find(node=>node.id==='o')!];
  item.edges=[{from:'s',to:'i'},...experts.map(condition=>({from:'i',to:`branch-${condition}`,condition})),{from:'i',to:'fallback',condition:'default'},...experts.map(agentId=>({from:`branch-${agentId}`,to:'o'})),{from:'fallback',to:'o'}];state.workflows=[item];
  const cases=[['分析客户需求','insight'],['准备客户拜访方案','strategy'],['预测本周商机','opportunity'],['检查合同风险','risk'],['培训练习合同风险回应','coach']] as const;
  for(const [query,expected] of cases){const result=await executeAction(state,'manager','workflow_run',{workflowId:item.id,query},context);assert.deepEqual(result.run!.agentIds,[expected],`错误分流：${query}`);assert.equal(result.run!.steps.find(step=>step.nodeId===`branch-${expected}`)!.status,'success');}
  assert.deepEqual(routeAgents('准备客户拜访方案'),['insight','strategy']);
});

test('branch conditions reject ambiguity and invalid placement while linear intent stays compatible',()=>{
  const missing=branching();missing.edges=missing.edges.filter(edge=>edge.condition!=='default');assert.throws(()=>validateWorkflow(missing,true),status(400));
  const duplicate=branching();duplicate.edges.push({from:'i',to:'o',condition:'risk'});assert.throws(()=>validateWorkflow(duplicate,true),status(400));
  const misplaced=flow();misplaced.edges[0].condition='risk';assert.throws(()=>validateWorkflow(misplaced,true),status(400));
  const mixed=branching();mixed.edges.push({from:'i',to:'o'});assert.throws(()=>validateWorkflow(mixed,true),status(400));
  const linear=branching();linear.edges=linear.edges.map(({from,to})=>({from,to}));assert.doesNotThrow(()=>validateWorkflow(linear,true));
});

test('knowledge selectors support empty, selected published entries, and approved skills only',async()=>{
  const state=createSeed(now);const item=flow();item.nodes.splice(1,0,{id:'k',type:'knowledge',label:'选择知识',knowledgeIds:['knowledge-2'],x:100,y:0});item.edges=[{from:'s',to:'k'},{from:'k',to:'a'},{from:'a',to:'o'}];state.workflows=[item];
  const selected=await executeAction(state,'manager','workflow_run',{workflowId:item.id,query:'合同'},context);assert.deepEqual(selected.run!.citations.map(entry=>entry.id),['knowledge-2']);
  item.nodes[1].knowledgeIds=[];const empty=await executeAction(state,'manager','workflow_run',{workflowId:item.id,query:'合同'},context);assert.equal(empty.run!.citations.length,0);
  item.nodes[1].knowledgeIds=['knowledge-skill-1'];const approved=await executeAction(state,'manager','workflow_run',{workflowId:item.id,query:'免租'},context);assert.equal(approved.run!.citations[0].id,'knowledge-skill-1');
  item.nodes[1].knowledgeIds=['knowledge-skill-5'];await assert.rejects(executeAction(state,'manager','workflow_publish',{workflowId:item.id,version:1},context),status(400));
  const unavailable=await executeAction(state,'manager','workflow_run',{workflowId:item.id,query:'免租'},context);assert.equal(unavailable.run!.status,'failed');assert.equal(unavailable.run!.agentIds.length,0);
});

test('review continues the original graph once with the original sales data scope',async()=>{
  const state=createSeed(now);const item=reviewFlow();item.status='published';state.workflows=[item];
  const calls:GenerationInput[]=[];const scoped={now,generate:async(input:GenerationInput)=>{calls.push(input);return {answer:`已完成${input.agentId}`,mode:'demo' as const};}};
  const paused=await executeAction(state,'sales','workflow_run',{workflowId:item.id,query:'准备拜访'},scoped);assert.equal(paused.run!.status,'paused');assert.equal(paused.run!.awaitingNodeId,'r');assert.equal(calls.length,1);
  assert.equal('_workflowRuns' in projectState(paused.state,'sales'),false);assert.equal(projectState(paused.state,'manager').runs[0].id,paused.run!.id);
  paused.state.workflows[0].nodes.find(node=>node.id==='b')!.agentId='opportunity';
  await assert.rejects(executeAction(paused.state,'sales','workflow_review',{runId:paused.run!.id,decision:'approve',note:'已核对'},scoped),status(403));
  const resumed=await executeAction(paused.state,'manager','workflow_review',{runId:paused.run!.id,decision:'approve',note:'已核对边界'},scoped);
  assert.equal(resumed.run!.id,paused.run!.id);assert.equal(resumed.run!.status,'completed');assert.deepEqual(resumed.run!.agentIds,['insight','strategy']);assert.equal(calls.length,2);assert.ok(calls[1].deals.every(deal=>deal.ownerId==='sales-1'));assert.match(calls[1].previous!,/已完成insight/);
  assert.equal(resumed.run!.review!.decision,'approve');assert.equal(resumed.run!.awaitingNodeId,undefined);assert.equal(projectState(resumed.state,'sales').runs.length,1);
  await assert.rejects(executeAction(resumed.state,'manager','workflow_review',{runId:paused.run!.id,decision:'approve',note:'再次确认'},scoped),status(409));
});

test('rejecting review finishes the paused run without executing downstream nodes',async()=>{
  const state=createSeed(now);state.workflows=[reviewFlow()];const paused=await executeAction(state,'manager','workflow_run',{workflowId:'test-flow',query:'准备拜访'},context);
  const result=await executeAction(paused.state,'manager','workflow_review',{runId:paused.run!.id,decision:'reject',note:'需补充依据'},context);
  assert.equal(result.run!.status,'rejected');assert.deepEqual(result.run!.agentIds,['insight']);assert.equal(result.run!.review!.note,'需补充依据');
  await assert.rejects(executeAction(result.state,'manager','workflow_review',{runId:paused.run!.id,decision:'approve',note:'重复'},context),status(409));
});

test('workflow generation failures persist a safe node trace while normal chat keeps its error behavior',async()=>{
  const state=createSeed(now);state.workflows=[flow()];const broken={now,generate:async()=>{throw new Error('provider-secret-do-not-expose');}};
  const result=await executeAction(state,'manager','workflow_run',{workflowId:'test-flow',query:'准备拜访'},broken);
  assert.equal(result.run!.status,'failed');assert.equal(result.state.runs[0].id,result.run!.id);assert.equal(result.run!.steps.find(step=>step.nodeId==='a')!.status,'error');assert.doesNotMatch(JSON.stringify(result.run),/provider-secret/);
  await assert.rejects(executeAction(state,'manager','chat',{query:'准备拜访'},broken),/provider-secret-do-not-expose/);
});

test('long node output is bounded and does not repeat nested upstream payloads in traces',async()=>{
  const state=createSeed(now);const item=reviewFlow();state.workflows=[item];const long={now,generate:async()=>({answer:'界'.repeat(200000),mode:'demo' as const})};
  const result=await executeAction(state,'manager','workflow_run',{workflowId:item.id,query:'准备拜访'},long);
  assert.equal(result.run!.status,'paused');assert.ok(new TextEncoder().encode(JSON.stringify(result.state)).byteLength<500000);
});

test('reserved object-property node identifiers cannot corrupt persisted execution frames',()=>{
  const item=flow();item.nodes[1].id='__proto__';item.edges=[{from:'s',to:'__proto__'},{from:'__proto__',to:'o'}];
  assert.throws(()=>validateWorkflow(item,true),status(400));
});

test('multiple review gates pause separately and never rerun completed expert nodes',async()=>{
  const state=createSeed(now);const item=reviewFlow();item.nodes.splice(4,0,{id:'r2',type:'review',label:'再次确认',x:700,y:0});item.edges=[{from:'s',to:'a'},{from:'a',to:'r'},{from:'r',to:'b'},{from:'b',to:'r2'},{from:'r2',to:'o'}];state.workflows=[item];
  const first=await executeAction(state,'manager','workflow_run',{workflowId:item.id,query:'准备拜访'},context);
  const second=await executeAction(first.state,'manager','workflow_review',{runId:first.run!.id,decision:'approve',note:'第一项通过'},context);
  assert.equal(second.run!.status,'paused');assert.equal(second.run!.awaitingNodeId,'r2');assert.deepEqual(second.run!.agentIds,['insight','strategy']);
  const last=await executeAction(second.state,'manager','workflow_review',{runId:first.run!.id,decision:'approve',note:'第二项通过'},context);
  assert.equal(last.run!.status,'completed');assert.equal(last.run!.steps.filter(step=>step.agent).length,2);assert.equal(last.run!.steps.filter(step=>step.title.includes('输出')).length,1);
});
