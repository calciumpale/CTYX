import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRevision, DomainError, executeAction, projectState, validateWorkflow } from '../app/lib/domain.ts';
import { createSeed } from '../app/lib/seed.ts';
import type { Workflow } from '../app/lib/types.ts';

const context = { now: '2026-10-23T08:00:00.000Z' };
const rejectsStatus = (status: number) => (error: unknown) => error instanceof DomainError && error.status === status;
const flow = (): Workflow => ({id:'test',name:'测试',description:'',status:'draft',version:1,updatedAt:context.now,nodes:[{id:'s',type:'start',label:'开始',x:0,y:0},{id:'a',type:'agent',agentId:'risk',label:'风控',x:1,y:0},{id:'o',type:'output',label:'输出',x:2,y:0}],edges:[{from:'s',to:'a'},{from:'a',to:'o'}]});

test('training openings match the selected first-visit and competitor scenarios', async () => {
  const state = createSeed(context.now);
  const firstVisit = await executeAction(state, 'sales', 'training_start', { scenario: '首访剧本' }, context);
  assert.match(firstVisit.session!.messages[0].content, /办公地点|面积/);
  const competitor = await executeAction(state, 'sales', 'training_start', { scenario: '竞品比较' }, context);
  assert.match(competitor.session!.messages[0].content, /比较|报价/);
});

test('sales projection excludes colleagues deals and manager activity', () => {
  const state = createSeed(context.now);
  const sales = projectState(state, 'sales');
  assert.ok(sales.deals.length > 0 && sales.deals.length < state.deals.length);
  assert.ok(sales.deals.every(deal => deal.ownerId === 'sales-1'));
  assert.equal(sales.role, 'sales');
});

test('stale workspace revision is rejected', () => {
  assert.throws(() => assertRevision(createSeed(context.now), -1), rejectsStatus(409));
});

test('sales cannot add knowledge or review skills', async () => {
  const state = createSeed(context.now);
  await assert.rejects(executeAction(state, 'sales', 'knowledge_add', {title:'越权',content:'内容'}, context), rejectsStatus(403));
  await assert.rejects(executeAction(state, 'sales', 'skill_review', {skillId:state.skills.find(skill => skill.status==='candidate')!.id,decision:'publish',note:'通过',version:1},context), rejectsStatus(403));
});

test('sales cannot mutate or query another salespersons deal', async () => {
  const state = createSeed(context.now);
  const other = state.deals.find(deal => deal.ownerId !== 'sales-1')!;
  await assert.rejects(executeAction(state, 'sales', 'deal_note', {dealId:other.id,text:'越权'},context), rejectsStatus(403));
  await assert.rejects(executeAction(state, 'sales', 'chat', {dealId:other.id,query:'分析客户'},context), rejectsStatus(403));
});

test('candidate skills are excluded until explicit manager review and stale review is rejected', async () => {
  let state = createSeed(context.now);
  const skill = state.skills.find(item => item.status === 'candidate')!;
  const before = await executeAction(state,'manager','chat',{query:skill.title},context);
  assert.ok(before.run!.citations.every(item => item.id !== skill.id && item.id !== `knowledge-${skill.id}`));
  const reviewed = await executeAction(state,'manager','skill_review',{skillId:skill.id,decision:'publish',note:'已核对边界和证据，可用于演示训练',version:skill.version},context);
  state = reviewed.state;
  assert.equal(state.skills.find(item=>item.id===skill.id)!.status,'published');
  assert.ok(state.knowledge.some(item=>item.id===`knowledge-${skill.id}`));
  const after = await executeAction(state,'manager','chat',{query:skill.title},context);
  assert.ok(after.run!.citations.some(item=>item.id===`knowledge-${skill.id}`));
  await assert.rejects(executeAction(state,'manager','skill_review',{skillId:skill.id,decision:'reject',note:'重复审核',version:skill.version},context),rejectsStatus(409));
});

test('workflow publication rejects cycles, missing output and unreachable nodes', () => {
  const valid = flow();
  assert.doesNotThrow(()=>validateWorkflow(valid,true));
  const cycle = flow(); cycle.edges.push({from:'a',to:'s'});
  assert.throws(()=>validateWorkflow(cycle,true),rejectsStatus(400));
  const noOutput=flow();noOutput.nodes=noOutput.nodes.filter(item=>item.id!=='o');noOutput.edges=noOutput.edges.slice(0,1);
  assert.throws(()=>validateWorkflow(noOutput,true),rejectsStatus(400));
  const detached=flow();detached.nodes.push({id:'x',type:'intent',label:'孤立',x:0,y:1});
  assert.throws(()=>validateWorkflow(detached,true),rejectsStatus(400));
});

test('workflow runs selected graph and pauses at review before downstream output', async () => {
  const state=createSeed(context.now);const workflow=flow();workflow.nodes.splice(2,0,{id:'r',type:'review',label:'经理审核',x:2,y:0});workflow.edges=[{from:'s',to:'a'},{from:'a',to:'r'},{from:'r',to:'o'}];state.workflows=[workflow];
  const result=await executeAction(state,'manager','workflow_run',{workflowId:workflow.id,query:'检查免租期诉求'},context);
  assert.deepEqual(result.run!.agentIds,['risk']);
  assert.ok(result.run!.steps.some(step=>step.title.includes('经理审核')&&step.status==='warning'));
  assert.ok(!result.run!.steps.some(step=>step.title.includes('输出')));
  assert.match(result.run!.answer,/暂停|等待/);
});

test('draft saves cannot retain published status and sales cannot execute drafts', async () => {
  const state=createSeed(context.now);const workflow=flow();workflow.status='published';
  const saved=await executeAction(state,'manager','workflow_save',{workflow},context);
  assert.equal(saved.state.workflows.find(item=>item.id==='test')!.status,'draft');
  await assert.rejects(executeAction(saved.state,'sales','workflow_run',{workflowId:'test',query:'测试'},context),rejectsStatus(403));
});

test('training is multi-turn, scores observed answers and rejects replies after finish', async () => {
  const state=createSeed(context.now);
  const started=await executeAction(state,'sales','training_start',{scenario:'免租期谈判'},context);
  const replied=await executeAction(started.state,'sales','training_reply',{sessionId:started.session!.id,text:'理解您的顾虑，预计什么时候开业？我整理装修期和预算，明天下午一起确认；免租政策还需要审批。'},context);
  assert.equal(replied.session!.messages.length,3);
  const finished=await executeAction(replied.state,'sales','training_finish',{sessionId:replied.session!.id},context);
  assert.equal(finished.session!.status,'completed');assert.ok(finished.session!.feedback!.every(item=>item.evidence.length>0));
  assert.ok(finished.session!.score!>=0&&finished.session!.score!<=100);
  await assert.rejects(executeAction(finished.state,'sales','training_reply',{sessionId:finished.session!.id,text:'继续'},context),rejectsStatus(409));
});

test('query cannot name a colleague deal even alongside an authorized customer', async () => {
  const state=createSeed(context.now);
  await assert.rejects(executeAction(state,'sales','chat',{query:'比较澄光咖啡和知行机器人的需求'},context),rejectsStatus(403));
});

test('rejected skills cannot be retrieved and manager runs do not leak to sales history', async () => {
  const state=createSeed(context.now);const rejected=state.skills.find(item=>item.status==='rejected')!;
  const result=await executeAction(state,'manager','chat',{query:rejected.title},context);
  assert.ok(result.run!.citations.every(item=>item.id!==`knowledge-${rejected.id}`));
  assert.equal(projectState(result.state,'sales').runs.length,0);
});

test('graph branches only receive their own upstream knowledge and expert results', async () => {
  const state=createSeed(context.now);const workflow=flow();workflow.nodes=[{id:'s',type:'start',label:'开始',x:0,y:0},{id:'k',type:'knowledge',label:'知识',x:1,y:0},{id:'a',type:'agent',label:'洞察',agentId:'insight',x:2,y:0},{id:'b',type:'agent',label:'风控',agentId:'risk',x:1,y:1},{id:'o',type:'output',label:'汇总',x:3,y:0}];workflow.edges=[{from:'s',to:'k'},{from:'k',to:'a'},{from:'s',to:'b'},{from:'a',to:'o'},{from:'b',to:'o'}];state.workflows=[workflow];
  const contexts: {agentId:string;knowledge:number;previous:string}[]=[];
  await executeAction(state,'manager','workflow_run',{workflowId:workflow.id,query:'准备拜访'}, {...context,generate:async(input)=>{contexts.push({agentId:input.agentId,knowledge:input.knowledge.length,previous:input.previous??''});return {answer:`${input.agentId}已处理`,mode:'demo'};}});
  assert.equal(contexts.find(item=>item.agentId==='risk')!.knowledge,0);
  assert.equal(contexts.find(item=>item.agentId==='insight')!.previous,'');
  assert.ok(contexts.find(item=>item.agentId==='insight')!.knowledge>0);
});
