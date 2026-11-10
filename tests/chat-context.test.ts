import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, executeAction } from '../app/lib/domain.ts';
import type { GenerationInput } from '../app/lib/domain.ts';
import { createSeed } from '../app/lib/seed.ts';
import type { Run, Workflow } from '../app/lib/types.ts';
import { buildModelMessages } from '../app/lib/model-messages.ts';
import { customerInsightEvidence, formatCustomerInsight } from '../app/lib/customer-insight.ts';
import type { SalesIntelligence } from '../app/lib/sales-intelligence-types.ts';
import type { PropertyQuery } from '../app/lib/property-query.ts';

const now='2026-10-23T08:00:00.000Z';
const status=(expected:number)=>(error:unknown)=>error instanceof DomainError&&error.status===expected;

test('customer insight filters unsupported assertions from model suggestions and keeps uncertain source snippets attributed',()=>{
  const deal=createSeed(now).deals[0];
  deal.companyProfile={companyName:deal.name,summary:'只保存了公开网页片段',provider:'web',status:'partial',facts:[],warnings:[],modelUsed:false,updatedAt:now,
    sources:[{id:'web-1',title:'企业公开介绍',url:'https://example.com/company',provider:'web',retrievedAt:now,snippet:'公开网页提及该企业从事设备服务。'}]};
  const evidence=customerInsightEvidence(deal);
  const answer=formatCustomerInsight(JSON.stringify({
    factIds:['source-1'],insights:['建议先核实实际业务线。','每月8000元是本项目报价。','现有三间商铺。'],
    questions:['客户现在的优先事项是什么？'],nextSteps:['联系采购负责人确认对接流程。','客户已经通过采购审批。','该公司是全国最大的供应商。'],
  }),evidence)!;
  assert.match(answer,/公开网页提及该企业从事设备服务。.*企业公开介绍，待核实/);
  assert.match(answer,/联系采购负责人确认对接流程/);
  assert.doesNotMatch(answer,/8000元|现有三间商铺|已通过采购审批|已经通过采购审批|全国最大/);
});
function capture() {
  const inputs:GenerationInput[]=[];
  return {inputs,context:{now,generate:async(input:GenerationInput)=>{inputs.push(structuredClone(input));return {answer:'服务端生成的已保存回答',mode:'live' as const};}}};
}
const storedRun=(id:string,query:string,answer:string):Run=>({id,query,answer,agentIds:['insight'],steps:[],citations:[],mode:'live',createdAt:now,duration:1});

test('property lookup returns original matching rows once and bypasses customer insight for a selected project', async () => {
  const state = createSeed(now);
  const deal = state.deals.find(item => item.ownerId === 'sales-1')!;
  deal.dataOrigin = 'manual';
  delete deal.companyProfile;
  const answer = '找到 2 条符合条件的空置房源。\n\n1. A101｜面积：120㎡｜位置：嘉兴南湖｜业态：餐饮\n2. A103｜面积：140㎡｜位置：嘉兴南湖｜业态：餐饮';
  const sources = [
    { id: 'property:vacant:2', title: '空置房源.xlsx · 南湖 · 第2行', content: 'A101｜面积：120㎡｜位置：嘉兴南湖｜业态：餐饮' },
    { id: 'property:vacant:4', title: '空置房源.xlsx · 南湖 · 第4行', content: 'A103｜面积：140㎡｜位置：嘉兴南湖｜业态：餐饮' },
  ];
  let lookups = 0;
  const result = await executeAction(state, 'sales', 'chat', {
    query: '分析一下嘉兴南湖100到150平的空置商铺，能做餐饮的都给我', dealId: deal.id,
  }, {
    now,
    prepareKnowledge: async () => {
      lookups++;
      return { route: 'retrieved', answer, knowledge: sources, evidenceIds: sources.map(source => source.id), recordLookup: { kind: 'property' as const, total: 2, complete: true } };
    },
    generate: async () => { assert.fail('a row lookup must not ask the model to rewrite inventory'); },
    generateInsight: async () => { assert.fail('selected customer context must not replace property lookup'); },
    enrichCompany: async () => { assert.fail('property search must not enrich the selected company'); },
  });
  assert.equal(lookups, 1);
  assert.equal(result.run?.answer, answer);
  assert.equal(result.run?.answerSource, 'property-records');
  assert.deepEqual(result.run?.citations, sources.map(source => ({ id: source.id, title: source.title, excerpt: source.content })));
  assert.equal(result.run?.dealId, deal.id);
  assert.ok(result.run?.steps.some(step => /房源/.test(step.title)));
  assert.doesNotMatch(result.run!.steps.map(step => step.detail).join('\n'), /演示|外部模型返回|服务端模型生成/);
  assert.equal(result.message, '已完成知识库房源筛选');
  assert.doesNotMatch(result.state.activities[0].detail, /演示/);
});

test('a property lookup with no matches preserves its answer and has no unrelated company citations', async () => {
  const { state, deal } = scopedInsightFixture();
  const answer = '空置房源中没有找到同时符合这些条件的条目。';
  const result = await executeAction(state, 'sales', 'chat', { query: '找1000平以上的空置房源', dealId: deal.id, agentId: 'insight' }, {
    now,
    prepareKnowledge: async () => ({ route: 'no_evidence', answer, knowledge: [], evidenceIds: [], recordLookup: { kind: 'property' as const, total: 0, complete: true } }),
    generateInsight: async () => { assert.fail('an explicit insight selector must not change the source of property inventory'); },
  });
  assert.equal(result.run?.answer, answer);
  assert.equal(result.run?.answerSource, 'property-records');
  assert.deepEqual(result.run?.citations, []);
});

test('property pagination and filter refinements stay on the inventory path in a customer chat', async () => {
  const { state, deal } = scopedInsightFixture();
  const first = await executeAction(state, 'sales', 'chat', { query: '分析空置房源', dealId: deal.id }, {
    now,
    prepareKnowledge: async () => ({ route: 'retrieved', answer: '第1页房源', knowledge: [], evidenceIds: [], recordLookup: { kind: 'property' as const, total: 20, complete: true } }),
  });
  for (const query of ['第2页', '面积改成80到100平', '看看还有没有80到100平的']) {
    let retrieved = false;
    const result = await executeAction(first.state, 'sales', 'chat', { query, dealId: deal.id, conversationRunIds: [first.run!.id] }, {
      now,
      prepareKnowledge: async request => {
        retrieved = true;
        assert.ok(request.history?.some(turn => turn.role === 'user' && turn.content === '分析空置房源'));
        return { route: 'retrieved', answer: '新的房源筛选结果', knowledge: [], evidenceIds: [], recordLookup: { kind: 'property' as const, total: 20, complete: true } };
      },
      generateInsight: async () => { assert.fail('property refinements must not return to customer analysis'); },
    });
    assert.equal(retrieved, true, query);
    assert.equal(result.run?.answerSource, 'property-records');
  }
});

test('chat persists resolved property filters and only forwards the latest server-owned property state',async()=>{
 const state=createSeed(now);const deal=state.deals.find(item=>item.ownerId==='sales-1')!;
 const resolved:PropertyQuery={status:'vacant',minArea:100,maxArea:200,groups:[{field:'location',values:['绮园']}],page:1,pageSize:10};
 const first=await executeAction(state,'sales','chat',{query:'找绮园100-200平空置房源',dealId:deal.id,propertyQuery:{status:'rented'}},{now,prepareKnowledge:async request=>{
  assert.equal(request.propertyQuery,undefined,'client payload must not provide saved query state');
  return {route:'retrieved',answer:'房源首屏',knowledge:[],evidenceIds:[],recordLookup:{kind:'property',total:100,complete:true,query:resolved}};
 }});
 assert.deepEqual(first.run?.propertyQuery,resolved);
 const second=await executeAction(first.state,'sales','chat',{query:'下一页',dealId:deal.id,conversationRunIds:[first.run!.id]},{now,prepareKnowledge:async request=>{
  assert.deepEqual(request.propertyQuery,resolved);
  return {route:'retrieved',answer:'房源第二页',knowledge:[],evidenceIds:[],recordLookup:{kind:'property',total:100,complete:true,query:{...resolved,page:2}}};
 }});
 assert.equal(second.run?.propertyQuery?.page,2);
 const unrelated=second.state.runs.find(run=>run.id===second.run!.id)!;
 unrelated.query='今天怎么准备拜访';delete unrelated.answerSource;
 await executeAction(second.state,'sales','chat',{query:'找空置房源',dealId:deal.id,conversationRunIds:[unrelated.id]},{now,prepareKnowledge:async request=>{
  assert.equal(request.propertyQuery,undefined,'a non-property latest run cannot supply stored filters');
  return {route:'no_evidence',answer:'没有匹配',knowledge:[],evidenceIds:[],recordLookup:{kind:'property',total:0,complete:true}};
 }});
});

test('chat recalls bounded memory for its resolved project and presents it as reference', async () => {
  const state = createSeed(now);
  const deal = state.deals.find(item => item.ownerId === 'sales-1')!;
  const requests: Array<{ query: string; projectId?: string }> = [];
  const result = await executeAction(state, 'sales', 'chat', { query: '按我的惯例梳理本次沟通', dealId: deal.id }, {
    now,
    recallAgentMemory: async (query: string, projectId?: string) => {
      requests.push({ query, projectId });
      return { index: ['沟通格式'], topics: [{ title: '沟通格式', body: '用户偏好先给结论。' }] };
    },
    generateInsight: async (input: GenerationInput) => {
      const prompt = buildModelMessages(input).map(message => message.content).join('\n');
      assert.match(prompt, /用户偏好先给结论/);
      assert.match(prompt, /记忆.*参考/);
      return { answer: JSON.stringify({ factIds: [], insights: ['先说明沟通目标'], questions: ['需要确认哪些情况？'], nextSteps: ['整理跟进清单'] }), mode: 'live' };
    },
  });
  assert.deepEqual(requests, [{ query: '按我的惯例梳理本次沟通', projectId: deal.id }]);
  assert.ok(result.run?.steps.some(step => /Agent 记忆/.test(step.title)));
});

test('an explicit preference recall uses memory when there is no matching shared knowledge', async () => {
  const state = createSeed(now);
  let modelCalls = 0;
  const context = {
    now,
    prepareKnowledge: async () => ({ route: 'conflict' as const, knowledge: [], evidenceIds: [] }),
    recallAgentMemory: async () => ({ index: ['汇报格式'], topics: [{ title: '汇报格式', body: '先给结论，再列行动项。' }] }),
    generate: async () => { modelCalls++; return { answer: '你习惯先给结论，再列行动项。', mode: 'live' as const }; },
  };
  const answer = await executeAction(state, 'sales', 'chat', { query: '你记得我平时的汇报格式吗？' }, context);
  assert.equal(answer.run?.mode, 'live');
  assert.equal(modelCalls, 1);
  const price = await executeAction(state, 'sales', 'chat', { query: '你记得客户的月租报价吗？' }, context);
  assert.equal(price.run?.mode, 'demo');
  assert.equal(modelCalls, 1);
});

function scopedInsightFixture() {
  const state=createSeed(now);
  const deal=state.deals.find(item=>item.ownerId==='sales-1')!;
  deal.name='百川医疗设备测试公司';
  deal.dataOrigin='manual';
  deal.companyProfile={companyName:deal.name,summary:'企业公开资料待进一步核实。',
    facts:[{label:'主营业务',value:'医疗器械的研发与制造',sourceIds:['registry']},
      {label:'采购预算',value:'未验证的采购预算500万元',sourceIds:['missing']}],
    sources:[{id:'registry',title:'企业公开登记信息',url:'https://registry.example/company',provider:'jinghai',retrievedAt:now}],
    provider:'jinghai',status:'ready',warnings:[],updatedAt:now,modelUsed:false};
  const query=`我要对接${deal.name}，帮我看看这家公司怎么样`;
  const unrelated={id:'sales-manual',title:'销售方法与话术实用手册120条',content:'这是一段与该企业无关的通用话术。'};
  return {state,deal,query,unrelated};
}

test('scoped customer insight uses the configured model despite unrelated shared knowledge conflicts',async()=>{
  const {state,deal,query,unrelated}=scopedInsightFixture();
  for(const agentId of [undefined,'insight'] as const){
    let calls=0;
    const result=await executeAction(state,'sales','chat',{query,dealId:deal.id,...(agentId?{agentId}:{})},{
      now,
      prepareKnowledge:async()=>({route:'conflict',knowledge:[unrelated],evidenceIds:[unrelated.id]}),
      generateInsight:async(input:GenerationInput)=>{
        calls++;
        assert.equal(input.deal?.id,deal.id);
        const prompt=buildModelMessages(input).map(message=>message.content).join('\n');
        assert.match(prompt,/factIds|fact-1/);
        assert.match(prompt,/医疗器械的研发与制造/);
        assert.doesNotMatch(prompt,/通用话术|未验证的采购预算500万元/);
        return {answer:JSON.stringify({factIds:['fact-1','unknown-fact'],insights:['可以从现有工作流程和协作难点切入。'],questions:['谁负责评估现有流程？'],nextSteps:['先约一次需求沟通。']}),mode:'live' as const};
      },
    });
    assert.equal(calls,1);
    const run=result.run!;
    assert.equal(run.mode,'live');
    assert.deepEqual(run.agentIds,['insight']);
    for(const content of ['已知信息','对接分析','待核实','下一步','医疗器械的研发与制造','可以从现有工作流程和协作难点切入','谁负责评估现有流程','先约一次需求沟通'])assert.ok(run.answer.includes(content),content);
    assert.doesNotMatch(run.answer,/unknown-fact|未验证的采购预算500万元|未调用外部模型/);
    assert.ok(run.citations.some(citation=>citation.title==='企业公开登记信息'));
    assert.ok(run.citations.every(citation=>citation.id!==unrelated.id));
  }
});

test('scoped customer insight reports missing model configuration rather than saving a local answer',async()=>{
  const {state,deal,query}=scopedInsightFixture();
  await assert.rejects(executeAction(state,'sales','chat',{query,dealId:deal.id},{
    now,
    prepareKnowledge:async()=>({route:'no_evidence',knowledge:[],evidenceIds:[]}),
    generateInsight:async()=>({answer:'不可展示的本地演示',mode:'demo' as const}),
  }),status(503));
  assert.equal(state.runs.length,0);
});

test('a customer violation-record question calls the model and stays inconclusive without verified records',async()=>{
  const {state,deal,unrelated}=scopedInsightFixture();
  deal.name='安徽老乡鸡餐饮有限公司';
  deal.dataOrigin='research';
  const inputs:GenerationInput[]=[];
  const context={now,
    prepareKnowledge:async()=>({route:'conflict' as const,knowledge:[unrelated],evidenceIds:[unrelated.id]}),
    generateInsight:async(input:GenerationInput)=>{
      inputs.push(input);
      assert.match(buildModelMessages(input).map(message=>message.content).join('\n'),/行政处罚|经营异常/);
      return {answer:JSON.stringify({checks:['penalties','registry','该企业从未违规','该企业已经被处罚'],verdict:'已被罚款'}),mode:'live' as const};
    },
  };
  const first=await executeAction(state,'sales','chat',{query:'他有没有违规记录',dealId:deal.id},context);
  const followup=await executeAction(first.state,'sales','chat',{query:'去哪查',conversationRunIds:[first.run!.id]},context);
  const continued=await executeAction(followup.state,'sales','chat',{query:'怎么核实',conversationRunIds:[first.run!.id,followup.run!.id]},context);
  const another=await executeAction(state,'sales','chat',{query:'这家公司的合规记录里有没有经营异常？',dealId:deal.id},context);
  for(const {run} of [first,followup,continued,another]){
    assert.equal(run?.mode,'live');
    assert.deepEqual(run?.agentIds,['insight']);
    assert.match(run!.answer,/现有资料无法确认/);
    assert.match(run!.answer,/国家企业信用信息公示系统|信用中国/);
    assert.doesNotMatch(run!.answer,/从未违规|已经被处罚|已被罚款|资料存在冲突/);
    assert.deepEqual(run?.citations,[]);
  }
  assert.deepEqual(inputs.map(input=>input.query),['他有没有违规记录','去哪查','怎么核实','这家公司的合规记录里有没有经营异常？']);
  assert.ok(inputs.every(input=>input.deal?.id===deal.id&&input.knowledge.length===0));
  assert.equal(inputs[2].history?.[0].query,'他有没有违规记录');

  for(const query of ['这份合同有没有违规？','行政处罚的申诉流程是什么？']){
    const other=await executeAction(first.state,'sales','chat',{query,dealId:deal.id,conversationRunIds:[first.run!.id]},context);
    assert.match(other.run!.answer,/资料存在冲突/);
  }
  assert.equal(inputs.length,4);
});

test('scoped customer insight can plan discovery without evidence and rejects malformed model output',async()=>{
  const {state,deal,query}=scopedInsightFixture();
  Object.assign(deal,{companyProfile:undefined,customerProfile:undefined,summary:'',needs:[],notes:[],nextAction:''});
  let calls=0;
  const context={now,generateInsight:async(input:GenerationInput)=>{
    calls++;
    assert.deepEqual(input.customerInsightEvidence,[]);
    assert.match(buildModelMessages(input).at(-1)!.content,/百川医疗设备测试公司/);
    return {answer:JSON.stringify({factIds:['fact-1'],insights:['可从了解医疗设备使用场景切入。'],questions:['负责设备选型的是哪个部门？'],nextSteps:['先约一次使用场景访谈。']}),mode:'live' as const};
  }};
  const result=await executeAction(state,'sales','chat',{query,dealId:deal.id},context);
  assert.equal(calls,1);
  assert.equal(result.run?.mode,'live');
  assert.deepEqual(result.run?.citations,[]);
  assert.match(result.run!.answer,/资料.*不足/);
  assert.match(result.run!.answer,/负责设备选型的是哪个部门/);
  assert.match(result.run!.answer,/先约一次使用场景访谈/);
  assert.doesNotMatch(result.run!.answer,/fact-1|未验证的采购预算/);
  await assert.rejects(executeAction(state,'sales','chat',{query,dealId:deal.id},{
    now,generateInsight:async()=>({answer:'{"factIds": [',mode:'live' as const}),
  }),error=>status(502)(error)&&/重试/.test((error as DomainError).message));
});

test('scoped insight follows up for the same deal while explicit price questions remain guarded',async()=>{
  const {state,deal,query}=scopedInsightFixture();
  const modelInputs:GenerationInput[]=[];
  const context={
    now,
    prepareKnowledge:async()=>({route:'no_evidence' as const,knowledge:[],evidenceIds:[]}),
    generate:async()=>{assert.fail('缺少价格依据时不能生成业务答案');},
    generateInsight:async(input:GenerationInput)=>{
      modelInputs.push(input);
      return {answer:JSON.stringify({factIds:['fact-1'],insights:['可以先梳理现有使用场景。'],questions:['目前哪个环节最耗时？'],nextSteps:['请使用部门讲解一次典型流程。']}),mode:'live' as const};
    },
  };
  const first=await executeAction(state,'sales','chat',{query,dealId:deal.id},context);
  const detail=await executeAction(first.state,'sales','chat',{query:'再具体一点',dealId:deal.id,conversationRunIds:[first.run!.id]},context);
  assert.equal(detail.run?.mode,'live');
  assert.equal(detail.run?.dealId,deal.id);
  assert.deepEqual(modelInputs.map(input=>input.query),[query,'再具体一点']);
  assert.deepEqual(modelInputs[1].history,[{query,answer:first.run!.answer}]);
  const result=await executeAction(detail.state,'sales','chat',{query:'这个项目的商铺月租多少？',dealId:deal.id,agentId:'insight',conversationRunIds:[first.run!.id,detail.run!.id]},context);
  assert.equal(modelInputs.length,2);
  assert.match(result.run!.answer,/资料不足/);
});

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
