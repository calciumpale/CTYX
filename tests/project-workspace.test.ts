import test from 'node:test';
import assert from 'node:assert/strict';
import { demoGenerate, DomainError, executeAction, projectState } from '../app/lib/domain.ts';
import { createSeed } from '../app/lib/seed.ts';
import { buildModelMessages } from '../app/lib/model-messages.ts';
import type { CompanyProfile, Deal } from '../app/lib/types.ts';

const now='2026-10-24T08:00:00.000Z';
const context={now};
const rejectsStatus=(status:number)=>(error:unknown)=>error instanceof DomainError&&error.status===status;
const createInput={projectName:'采购协同系统一期',name:'远山科技有限公司',contact:'陈经理',industry:'企业服务'};
const publicProfile=():CompanyProfile=>({companyName:createInput.name,summary:'公司官网介绍其提供企业协同产品。',facts:[{label:'主营业务',value:'企业协同产品',sourceIds:['official']}],sources:[{id:'official',title:'公司官网',url:'https://example.com/about',provider:'web',retrievedAt:now}],provider:'web',status:'ready',warnings:[],updatedAt:now,modelUsed:false});
async function manual(role:'sales'|'manager'='sales') {return executeAction(createSeed(now),role,'deal_create',createInput,context);}

test('new projects keep company and project identities separate and retain earlier records',async()=>{
  const seed=createSeed(now);const original=structuredClone(seed);
  const first=await executeAction(seed,'sales','deal_create',createInput,context);
  const second=await executeAction(first.state,'sales','deal_create',{...createInput,projectName:'采购协同系统二期'},context);
  assert.ok(first.dealId);assert.ok(second.dealId);assert.notEqual(first.dealId,second.dealId);
  assert.deepEqual(second.state.deals.filter(deal=>original.deals.some(old=>old.id===deal.id)),original.deals);
  const created=second.state.deals.find(deal=>deal.id===second.dealId)!;
  assert.equal(created.name,'远山科技有限公司');assert.equal(created.projectName,'采购协同系统二期');
  assert.equal(created.dataOrigin,'manual');assert.equal(created.ownerId,'sales-1');assert.equal(created.health,0);
  assert.equal(created.stage,'线索');assert.equal(created.amount,0);assert.deepEqual(created.notes,[]);assert.equal(created.version,1);
  assert.deepEqual(seed,original);
});

test('project creation validates names, money, stage and protected fields',async()=>{
  for(const bad of [{projectName:''},{name:' '},{amount:-1},{amount:Infinity},{amount:'100'},{stage:'已赢单'},{ownerId:'sales-2'},{owner:'其他人'},{companyProfile:publicProfile()},{notes:[]}]) {
    await assert.rejects(executeAction(createSeed(now),'sales','deal_create',{...createInput,...bad},context),rejectsStatus(400));
  }
  const created=await executeAction(createSeed(now),'sales','deal_create',{...createInput,amount:1200.5,website:'https://example.com',customerProfile:{decisionChain:'采购提出需求，CFO审批',goals:'缩短采购周期',concerns:'迁移成本',budget:'20万以内',timeline:'12月上线'}},context);
  assert.equal(created.state.deals[0].amount,1200.5);assert.equal(created.state.deals[0].customerProfile?.budget,'20万以内');
});

test('project ownership remains scoped and managers can assign only an existing team member',async()=>{
  const manager=await manual('manager');assert.equal(manager.state.deals[0].ownerId,'manager');
  assert.ok(!projectState(manager.state,'sales').deals.some(deal=>deal.id===manager.dealId));
  const assigned=await executeAction(manager.state,'manager','deal_create',{...createInput,ownerId:'sales-2'},context);
  assert.equal(assigned.state.deals[0].owner,'陈澈');
  await assert.rejects(executeAction(manager.state,'manager','deal_create',{...createInput,ownerId:'external-user'},context),rejectsStatus(400));
  await assert.rejects(executeAction(manager.state,'sales','deal_update',{dealId:manager.dealId,version:1,summary:'越权'},context),rejectsStatus(403));
});

test('project updates enforce versions and never overwrite notes, owners or company research',async()=>{
  const created=await manual();const id=created.dealId!;
  const noted=await executeAction(created.state,'sales','deal_note',{dealId:id,text:'已确认采购负责人'},context);
  const updated=await executeAction(noted.state,'sales','deal_update',{dealId:id,version:2,summary:'客户已确认需求',customerProfile:{budget:'20万'}},context);
  const deal=updated.state.deals.find(item=>item.id===id)!;
  assert.equal(deal.summary,'客户已确认需求');assert.equal(deal.notes[0].text,'已确认采购负责人');assert.equal(deal.version,3);
  assert.equal(deal.customerProfile?.budget,'20万');assert.equal(deal.customerProfile?.goals,'');
  await assert.rejects(executeAction(updated.state,'sales','deal_update',{dealId:id,version:2,summary:'过时内容'},context),rejectsStatus(409));
  for(const fields of [{ownerId:'manager'},{notes:[]},{companyProfile:publicProfile()},{health:99}])await assert.rejects(executeAction(updated.state,'sales','deal_update',{dealId:id,version:3,...fields},context),rejectsStatus(400));
});

test('same-company project selection respects explicit ids without choosing a sibling project',async()=>{
  const first=await manual();
  const second=await executeAction(first.state,'manager','deal_create',{...createInput,projectName:'管理者独立项目'},context);
  let selected:Deal|undefined;
  const result=await executeAction(second.state,'sales','chat',{dealId:first.dealId,query:`分析${createInput.name}的需求`,agentId:'strategy'},{now,generate:async(input)=>{selected=input.deal;return {answer:'按当前项目分析',mode:'live'};}});
  assert.equal(selected?.id,first.dealId);assert.equal(result.run?.dealId,first.dealId);
  const third=await executeAction(second.state,'sales','deal_create',{...createInput,projectName:'采购协同系统二期'},context);
  await executeAction(third.state,'sales','chat',{query:`分析${createInput.name}的需求`,agentId:'strategy'},{now,generate:async(input)=>{selected=input.deal;return {answer:'请先选择项目',mode:'live'};}});
  assert.equal(selected,undefined);
});

test('explicit project ids select the authorized project when another owner has the same company and project name',async()=>{
  const first=await manual();const other=await executeAction(first.state,'manager','deal_create',createInput,context);
  let received:Deal|undefined;let receivedDeals:Deal[]=[];
  const result=await executeAction(other.state,'sales','chat',{dealId:first.dealId,query:`分析${createInput.name}的${createInput.projectName}`,agentId:'strategy'},{now,generate:async(input)=>{received=input.deal;receivedDeals=input.deals;return {answer:'基于当前授权项目整理',mode:'live'};}});
  assert.equal(result.run?.dealId,first.dealId);assert.equal(received?.id,first.dealId);assert.deepEqual(receivedDeals.map(deal=>deal.id),[first.dealId]);
});

test('renaming the client clears research for the previous company while keeping manual records',async()=>{
  const created=await manual();const enriched=await executeAction(created.state,'sales','deal_enrich',{dealId:created.dealId,version:1},{now,enrichCompany:async()=>publicProfile()});
  const result=await executeAction(enriched.state,'sales','deal_update',{dealId:created.dealId,version:2,name:'新客户有限公司'},context);
  assert.equal(result.state.deals[0].companyProfile,undefined);assert.equal(result.state.deals[0].projectName,createInput.projectName);
});

test('trusted company enrichment saves sourced insight without changing manual profile or notes',async()=>{
  const created=await manual();const id=created.dealId!;
  const updated=await executeAction(created.state,'sales','deal_update',{dealId:id,version:1,customerProfile:{budget:'客户确认20万'},needs:['采购审批线上化']},context);
  const result=await executeAction(updated.state,'sales','deal_enrich',{dealId:id,version:2},{now,enrichCompany:async()=>publicProfile()});
  const deal=result.state.deals.find(item=>item.id===id)!;
  assert.equal(deal.customerProfile?.budget,'客户确认20万');assert.deepEqual(deal.needs,['采购审批线上化']);
  assert.equal(deal.companyProfile?.sources[0].url,'https://example.com/about');assert.equal(deal.version,3);
  assert.equal(result.run?.dealId,id);assert.deepEqual(result.run?.agentIds,['insight']);
  assert.ok(result.run?.citations.some(citation=>citation.excerpt.includes('https://example.com/about')));
  assert.ok(projectState(result.state,'sales').runs.some(run=>run.id===result.run?.id));
});

test('project workflow outputs retain the selected project and its company source citations',async()=>{
  const created=await manual('manager');const enriched=await executeAction(created.state,'manager','deal_enrich',{dealId:created.dealId,version:1},{now,enrichCompany:async()=>publicProfile()});
  const result=await executeAction(enriched.state,'manager','workflow_run',{workflowId:enriched.state.workflows[0].id,dealId:created.dealId,query:'为当前项目准备拜访方案'},{now,generate:async()=>({answer:'核对采购目标和预算。',mode:'live'})});
  assert.equal(result.run?.dealId,created.dealId);assert.ok(result.run?.citations.some(citation=>citation.excerpt.includes('https://example.com/about')));
});

test('failed, stale and unsourced enrichment preserve earlier company and manual information',async()=>{
  const created=await manual();const id=created.dealId!;
  const enriched=await executeAction(created.state,'sales','deal_enrich',{dealId:id,version:1},{now,enrichCompany:async()=>publicProfile()});
  const before=structuredClone(enriched.state);
  await assert.rejects(executeAction(enriched.state,'sales','deal_enrich',{dealId:id,version:1},{now,enrichCompany:async()=>publicProfile()}),rejectsStatus(409));
  await assert.rejects(executeAction(enriched.state,'sales','deal_enrich',{dealId:id,version:2},{now,enrichCompany:async()=>{throw new DomainError('检索不可用',502);}}),rejectsStatus(502));
  for(const invalid of [
    {...publicProfile(),sources:[{...publicProfile().sources[0],url:'http://127.0.0.1/admin'}]},
    {...publicProfile(),facts:[{label:'注册资本',value:'10亿元',sourceIds:['imagined']}]},
    {...publicProfile(),companyName:'其他企业'},
    {...publicProfile(),status:'ready',sources:[],facts:[]},
  ])await assert.rejects(executeAction(enriched.state,'sales','deal_enrich',{dealId:id,version:2},{now,enrichCompany:async()=>invalid as CompanyProfile}),rejectsStatus(502));
  assert.deepEqual(enriched.state,before);
  await assert.rejects(executeAction(enriched.state,'sales','deal_enrich',{dealId:id,version:2,companyProfile:publicProfile()},context),rejectsStatus(400));
});

test('enrichment cannot research a colleague project and partial research stores uncertainty only',async()=>{
  const seed=createSeed(now);const other=seed.deals.find(deal=>deal.ownerId!=='sales-1')!;
  await assert.rejects(executeAction(seed,'sales','deal_enrich',{dealId:other.id,version:1},{now,enrichCompany:async()=>publicProfile()}),rejectsStatus(403));
  const created=await manual();
  const result=await executeAction(created.state,'sales','deal_enrich',{dealId:created.dealId,version:1},{now,enrichCompany:async()=>({...publicProfile(),status:'partial',summary:'公开来源尚未确认，请人工核实。',sources:[],facts:[],warnings:['未检索到可核验资料']})});
  assert.equal(result.state.deals[0].companyProfile?.status,'partial');assert.equal(result.run?.citations.length,0);
  assert.ok(result.run?.steps.some(step=>step.status==='warning'));
});

test('an empty research retry cannot replace an earlier sourced company profile',async()=>{
  const created=await manual();const enriched=await executeAction(created.state,'sales','deal_enrich',{dealId:created.dealId,version:1},{now,enrichCompany:async()=>publicProfile()});
  const before=structuredClone(enriched.state);
  await assert.rejects(executeAction(enriched.state,'sales','deal_enrich',{dealId:created.dealId,version:2},{now,enrichCompany:async()=>({...publicProfile(),status:'partial',summary:'暂无可核验资料',sources:[],facts:[],warnings:['公开检索暂时不可用']})}),rejectsStatus(503));
  assert.deepEqual(enriched.state,before);
});

test('customer insight retries an earlier partial profile that has no public sources',async()=>{
  const created=await manual();
  const empty=await executeAction(created.state,'sales','deal_enrich',{dealId:created.dealId,version:1},{now,enrichCompany:async()=>({...publicProfile(),status:'partial',summary:'暂无可核验资料',sources:[],facts:[],warnings:['公开检索暂时不可用']})});
  const result=await executeAction(empty.state,'sales','chat',{dealId:created.dealId,agentId:'insight',query:'重新补全企业并分析需求'},{now,enrichCompany:async()=>publicProfile(),generate:async()=>({answer:'根据已核验来源分析',mode:'live'})});
  assert.equal(result.state.deals[0].companyProfile?.status,'ready');assert.equal(result.state.deals[0].companyProfile?.sources[0].url,'https://example.com/about');
  assert.ok(result.run?.citations.some(citation=>citation.excerpt.includes('https://example.com/about')));
});

test('customer insight enriches a new manual project once and keeps source citations on later runs',async()=>{
  const created=await manual();let requests=0;let received:Deal|undefined;
  const enrichCompany=async()=>{requests++;return publicProfile();};
  const generate=async(input:{deal?:Deal})=>{received=input.deal;return {answer:'根据已核验来源分析需求。',mode:'live' as const};};
  const first=await executeAction(created.state,'sales','chat',{dealId:created.dealId,agentId:'insight',query:'补全企业画像并分析客户需求'},{now,enrichCompany,generate});
  assert.equal(requests,1);assert.ok(received?.companyProfile);assert.ok(first.run?.citations.some(citation=>citation.excerpt.includes('https://example.com/about')));
  const second=await executeAction(first.state,'sales','chat',{dealId:created.dealId,agentId:'insight',query:'再分析一次'},{now,enrichCompany,generate});
  assert.equal(requests,1);assert.ok(second.run?.citations.some(citation=>citation.excerpt.includes('https://example.com/about')));
});

test('automatic research failure adds a warning while answering from manual facts',async()=>{
  const created=await manual();let received:Deal|undefined;
  const result=await executeAction(created.state,'sales','chat',{dealId:created.dealId,agentId:'insight',query:'分析客户需求'},{now,enrichCompany:async()=>{throw new Error('provider unreachable');},generate:async(input)=>{received=input.deal;return {answer:'仅根据用户记录，预算未知。',mode:'live'};}});
  assert.equal(received?.companyProfile,undefined);assert.match(result.run!.answer,/预算未知/);
  assert.ok(result.run?.steps.some(step=>step.status==='warning'&&/未完成|失败|暂时/.test(step.detail)));
  assert.ok(!result.run?.citations.some(citation=>citation.excerpt.includes('example.com')));
});

test('generic local sales answers do not inject park, space or rent assumptions',()=>{
  for(const agentId of ['insight','strategy','risk','coach'] as const) {
    const result=demoGenerate({query:'分析企业采购机会',agentId,deals:[],knowledge:[],purpose:'workflow'});
    assert.doesNotMatch(result.answer,/园区|空间用途|免租|装修|面积/);
  }
});

test('model context distinguishes manual projects, samples and sourced public facts',async()=>{
  const created=await manual();const deal={...created.state.deals[0],companyProfile:publicProfile()};
  const messages=buildModelMessages({query:'根据企业画像分析',agentId:'insight',deal,deals:[],knowledge:[],purpose:'chat'});
  assert.doesNotMatch(messages[0].content,/资料全部为合成示例/);
  assert.match(messages[0].content,/人工|用户输入/);assert.match(messages[0].content,/外部|公开/);
  assert.match(messages[0].content,/未知|待核实/);assert.match(messages.at(-1)!.content,/https:\/\/example.com\/about/);
});
