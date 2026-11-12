import test from 'node:test';
import assert from 'node:assert/strict';
import { executeMemberAction, assertMemberApi } from '../app/lib/member-policy.ts';
import { createSeed } from '../app/lib/seed.ts';
import type { Knowledge } from '../app/lib/types.ts';

const policy: Knowledge = {
  id: 'knowledge-document:chunk-17',
  title: '出差管理制度 · 第十二条',
  content: '出差审批须在订票前完成。超出标准时应填写书面说明。',
  category: '内部制度',
  source: '内部制度 / 出差管理制度.docx',
  status: 'published',
  updatedAt: '2026-11-07T00:00:00Z',
};

test('staff can reach the knowledge search endpoint', () => {
  for (const role of ['sales', 'manager', 'admin'] as const) {
    assert.doesNotThrow(() => assertMemberApi(role, '/api/knowledge-library', 'GET'));
    assert.doesNotThrow(() => assertMemberApi(role, '/api/knowledge-library', 'POST'));
    assert.throws(() => assertMemberApi(role, '/api/knowledge-library', 'PATCH'), { status: 403 });
  }
});

test('normal chat passes retrieved document context to the model and records its citation', async () => {
  let passedToModel = false;
  const query = '订票前需要走什么流程？';
  const result = await executeMemberAction(createSeed(), 'sales', 'chat', { query }, {
    retrieveManagedKnowledge: async (text) => {
      assert.equal(text, query);
      return [policy];
    },
    generate: async (input) => {
      passedToModel = input.knowledge.some(item => item.id === policy.id && item.content === policy.content);
      return { answer: '订票前先完成出差审批。', mode: 'live' };
    },
  });
  assert.ok(passedToModel);
  assert.ok(result.run?.citations.some(item => item.id === policy.id && item.title === policy.title));
});

test('unbound workflow knowledge retrieves documents and explicit bindings keep their scope', async () => {
  for (const bound of [false, true]) {
    const state = createSeed();
    const legacy = state.knowledge.find(item => item.status === 'published')!;
    const workflow = {
      id: 'policy-flow', name: '制度检查', description: '', status: 'published' as const,
      version: 1, updatedAt: policy.updatedAt,
      nodes: [
        { id: 'start', type: 'start' as const, label: '开始', x: 0, y: 0 },
        { id: 'library', type: 'knowledge' as const, label: '查制度', x: 200, y: 0, ...(bound ? { knowledgeIds: [legacy.id] } : {}) },
        { id: 'expert', type: 'agent' as const, agentId: 'risk' as const, label: '建议', x: 400, y: 0 },
        { id: 'output', type: 'output' as const, label: '输出', x: 600, y: 0 },
      ],
      edges: [{ from: 'start', to: 'library' }, { from: 'library', to: 'expert' }, { from: 'expert', to: 'output' }],
    };
    state.workflows = [workflow];
    let retrieved = false;
    const result = await executeMemberAction(state, 'sales', 'workflow_run', {
      mode: 'published', workflowId: workflow.id, query: '订票前需要走什么流程？',
    }, {
      retrieveManagedKnowledge: async () => { retrieved = true; return [policy]; },
      generate: async () => ({ answer: '已核对。', mode: 'live' }),
    });
    assert.equal(result.run?.status, 'completed');
    assert.equal(retrieved, !bound);
    assert.equal(result.run?.citations.some(item => item.id === policy.id), !bound);
    if (bound) assert.ok(result.run?.citations.some(item => item.id === legacy.id));
  }
});

test('normal chat invokes shared preparation, skips retrieval for greeting and keeps business citations', async () => {
  const {prepareKnowledgeContext}=await import('../app/lib/knowledge-agent.ts');
  for(const query of ['你好','订票前需要什么流程？']){
    let prepared=false;let lookups=0;
    const result=await executeMemberAction(createSeed(),'sales','chat',{query},{
      prepareKnowledge:async request=>{prepared=true;return prepareKnowledgeContext({...request,intent:query==='你好'?'auto':'business'},{retrieve:async()=>{lookups++;return [policy];}});},
      retrieveManagedKnowledge:async()=>{throw new Error('shared preparation must own lookup');},
      generate:async input=>({answer:input.knowledge.map(k=>k.content).join('')||'您好。',mode:'live'}),
    });
    assert.ok(prepared);assert.equal(lookups,query==='你好'?0:1);
    assert.equal(result.run?.citations.some(c=>c.id===policy.id),query!=='你好');
  }
});

test('explicit workflow knowledge prepares within bound published IDs only',async()=>{
 const {prepareKnowledgeContext}=await import('../app/lib/knowledge-agent.ts');
 const state=createSeed();const legacy=state.knowledge.find(k=>k.status==='published')!;
 state.workflows=[{id:'shared-bound',name:'scope',description:'',status:'published',version:1,updatedAt:policy.updatedAt,nodes:[{id:'start',type:'start',label:'开始',x:0,y:0},{id:'kb',type:'knowledge',label:'知识',x:100,y:0,knowledgeIds:[legacy.id]},{id:'out',type:'output',label:'输出',x:200,y:0}],edges:[{from:'start',to:'kb'},{from:'kb',to:'out'}]}];
 let called=false;
 const result=await executeMemberAction(state,'sales','workflow_run',{mode:'published',workflowId:'shared-bound',query:'你好'},{prepareKnowledge:async(request,scope)=>{called=true;assert.equal(request.intent,'business');assert.deepEqual(scope?.knowledgeIds,[legacy.id]);return prepareKnowledgeContext(request,{retrieve:async()=>[legacy]});}});
 assert.ok(called);assert.ok(result.run?.citations.some(c=>c.id===legacy.id));
});

test('shared preparation gates common chat and failed business answers without a specialist call',async()=>{
 for(const route of ['direct','conflict','failed','no_evidence'] as const){
  let generated=0;
  const result=await executeMemberAction(createSeed(),'sales','chat',{query:route==='direct'?'你好':'商铺月租多少？'},{prepareKnowledge:async()=>({route,knowledge:[],evidenceIds:[],...(route==='direct'?{answer:'您好，有什么想了解的？'}:{})}),generate:async()=>{generated++;return {answer:'月租8000元。',mode:'live'};}});
  assert.equal(generated,0);assert.ok(!result.run?.answer.includes('8000'));assert.match(result.run!.answer,route==='conflict'?/冲突/:route==='failed'?/暂时/:route==='no_evidence'?/资料/:/您好/);
 }
});

test('shared lookup runs once and specialist product claims stay grounded',async()=>{
 let prepared=0;let extra=0;
 const result=await executeMemberAction(createSeed(),'sales','chat',{query:'给我商铺价格方案',agentId:'strategy'},{prepareKnowledge:async()=>{prepared++;return {route:'retrieved',knowledge:[policy],evidenceIds:[]};},retrieveTalkTracks:async()=>{extra++;throw new Error('second lookup');},generate:async()=>({answer:'商铺月租8000元。',mode:'live'})});
 assert.equal(prepared,1);assert.equal(extra,0);assert.ok(!result.run?.answer.includes('8000'));
});

test('workflow conflict propagates to specialist and stops unsupported price generation',async()=>{
 const state=createSeed();state.workflows=[{id:'guarded',name:'guarded',description:'',status:'published',version:1,updatedAt:policy.updatedAt,nodes:[{id:'s',type:'start',label:'开始',x:0,y:0},{id:'k',type:'knowledge',label:'资料',x:100,y:0},{id:'a',type:'agent',agentId:'strategy',label:'回答',x:200,y:0},{id:'o',type:'output',label:'输出',x:300,y:0}],edges:[{from:'s',to:'k'},{from:'k',to:'a'},{from:'a',to:'o'}]}];
 let generated=0;
 const result=await executeMemberAction(state,'sales','workflow_run',{workflowId:'guarded',mode:'published',query:'月租多少？'},{prepareKnowledge:async()=>({route:'conflict',knowledge:[policy],evidenceIds:[]}),generate:async()=>{generated++;return {answer:'月租8000元。',mode:'live'};}});
 assert.equal(generated,0);assert.match(result.run!.answer,/冲突/);assert.ok(!result.run!.answer.includes('8000'));
});

test('legitimate customer strategy advice can still generate with a failed knowledge boundary',async()=>{
 const state=createSeed();const deal=state.deals.find(d=>d.ownerId==='sales-1')!;let seen=false;
 const result=await executeMemberAction(state,'sales','chat',{query:'请根据客户需求给推进建议',dealId:deal.id,agentId:'strategy'},{prepareKnowledge:async()=>({route:'failed',knowledge:[],evidenceIds:[]}),generate:async input=>{seen=true;assert.match(input.instruction!,/资料暂时/);return {answer:'建议先确认客户的决策时间，再约定下一次沟通。',mode:'live'};}});
 assert.ok(seen);assert.match(result.run!.answer,/建议先确认/);
});

test('retrieved business answer cannot bypass grounding with spelled-out prices or lose applicability',async()=>{
 for(const answer of ['每月八千，随时都有。','月租8000元。']){
  const result=await executeMemberAction(createSeed(),'sales','chat',{query:'商铺月租多少？'},{prepareKnowledge:async()=>({route:'retrieved',knowledge:[{id:'rent',title:'年度价格',content:'以下报价仅适用于年度合同。月租8000元。'}],evidenceIds:[]}),generate:async()=>({answer,mode:'live'})});
  assert.ok(!result.run?.answer.includes(answer));assert.match(result.run!.answer,/缺少完整资料依据/);
 }
});

test('customer strategy retains an owned numeric budget when knowledge is unavailable',async()=>{
 const state=createSeed();const deal=state.deals.find(d=>d.ownerId==='sales-1')!;
 deal.customerProfile={decisionChain:'',goals:'',concerns:'',budget:'8000元/月',timeline:''};
 const answer='客户预算8000元/月，建议先确认决策时间。';
 const result=await executeMemberAction(state,'sales','chat',{query:'请根据客户预算给推进建议',dealId:deal.id,agentId:'strategy'},{prepareKnowledge:async()=>({route:'failed',knowledge:[],evidenceIds:[]}),generate:async()=>({answer,mode:'live'})});
 assert.ok(result.run!.answer.includes(answer));assert.equal(result.run!.mode,'live');
});

test('customer facts never authorize fabricated budgets, inventory, or a current product price',async()=>{
 for(const answer of ['8000元/月，建议先确认决策时间。','客户预算九千元/月，建议先确认决策时间。','客户预算9000元/月，建议先确认决策时间。','客户预算8000元/月，商铺月租8000元/月。','客户预算8000元/月，现有3间商铺。','客户预算8000元/月的商铺均有货。']){
  const state=createSeed();const deal=state.deals.find(d=>d.ownerId==='sales-1')!;
  deal.customerProfile={decisionChain:'',goals:'',concerns:'',budget:'8000元/月',timeline:''};
  const result=await executeMemberAction(state,'sales','chat',{query:'请根据客户预算给推进建议',dealId:deal.id,agentId:'strategy'},{prepareKnowledge:async()=>({route:'failed',knowledge:[],evidenceIds:[]}),generate:async()=>({answer,mode:'live'})});
  assert.ok(!result.run!.answer.includes(answer));assert.match(result.run!.answer,/资料暂时不可用/);
 }
});

test('customer profile and needs facts are admitted with their field and source attribution',async()=>{
 const state=createSeed();const deal=state.deals.find(d=>d.ownerId==='sales-1')!;
 deal.customerProfile={decisionChain:'',goals:'',concerns:'',budget:'8000元/月',timeline:'2026年12月'};deal.needs=['80平米餐饮店'];
 const answer='客户需要80平米餐饮店，客户计划时间2026年12月，建议先确认决策时间。';
 const result=await executeMemberAction(state,'sales','chat',{query:'请根据客户需求给推进建议',dealId:deal.id,agentId:'strategy'},{prepareKnowledge:async()=>({route:'failed',knowledge:[],evidenceIds:[]}),generate:async()=>({answer,mode:'live'})});
 assert.ok(result.run!.answer.includes(answer));
});

test('ordinary workspace questions on the direct route reach the configured model', async () => {
  const query = '解释一下 HTTPS 和 HTTP 有什么区别';
  let called = false;
  const result = await executeMemberAction(createSeed(), 'sales', 'chat', { query }, {
    prepareKnowledge: async () => ({ route: 'direct', knowledge: [], evidenceIds: [] }),
    generate: async input => {
      called = true;
      assert.equal(input.query, query);
      assert.deepEqual(input.knowledge, []);
      return { answer: 'HTTPS 使用 TLS 保护传输。', mode: 'live' };
    },
  });
  assert.equal(called, true);
  assert.equal(result.run?.mode, 'live');
  assert.match(result.run!.answer, /HTTPS 使用 TLS/);
  assert.doesNotMatch(result.run!.answer, /有什么想了解的/);
});

test('grounded answers can organize current evidence and offer a next step', async () => {
  const result = await executeMemberAction(createSeed(), 'sales', 'chat', { query: '订票前要完成哪一步？' }, {
    prepareKnowledge: async () => ({ route: 'retrieved', knowledge: [policy], evidenceIds: [] }),
    generate: async input => {
      assert.deepEqual(input.knowledge.map(item => item.id), [policy.id]);
      return { answer: '## 结论\n出差审批须在订票前完成。\n建议先确认负责受理的人。', mode: 'live' };
    },
  });
  assert.equal(result.run?.mode, 'live');
  assert.match(result.run!.answer, /出差审批须在订票前完成。/);
  assert.match(result.run!.answer, /建议先确认负责受理的人。/);
  assert.deepEqual(result.run!.citations.map(item => item.id), [policy.id]);
});
