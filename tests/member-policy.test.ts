import test from 'node:test';
import assert from 'node:assert/strict';
import {assertMemberApi,assertMemberAction,assertMemberApprovalAction,executeMemberAction,projectAccountState,projectAccountResult,readMemberDisplayName,requireMemberRole} from '../app/lib/member-policy.ts';
import {createSeed} from '../app/lib/seed.ts';

test('digital-human business uploads stay separate from admin connection maintenance', () => {
  for (const role of ['sales', 'manager'] as const) {
    for (const method of ['GET', 'POST']) assert.doesNotThrow(() => assertMemberApi(role, '/api/digital-humans', method));
    for (const method of ['GET', 'HEAD', 'PUT']) assert.doesNotThrow(() => assertMemberApi(role, '/api/digital-humans/source', method));
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) assert.throws(() => assertMemberApi(role, '/api/zego-connection', method), {status:403});
    assert.throws(() => assertMemberApi(role, '/api/digital-humans', 'DELETE'), {status:403});
    assert.throws(() => assertMemberApi(role, '/api/digital-humans/source', 'POST'), {status:403});
  }
  for (const method of ['GET', 'POST']) assert.doesNotThrow(() => assertMemberApi('admin', '/api/zego-connection', method));
  for (const method of ['GET', 'POST', 'PUT', 'HEAD']) {
    assert.throws(() => assertMemberApi('admin', '/api/digital-humans', method), {status:403});
    assert.throws(() => assertMemberApi('admin', '/api/digital-humans/source', method), {status:403});
  }
  assert.throws(() => assertMemberApi('admin', '/api/zego-connection', 'PUT'), {status:403});
  assert.throws(() => assertMemberApi('sales', '/api/digital-humans/source/foreign', 'GET'), {status:403});
});

test('API authorization protects settings, customer data, reports, and unknown endpoints independently of navigation',()=>{
  for(const role of ['sales','manager'] as const)for(const path of ['/api/connections','/api/embedding-connection','/api/company-connection','/api/workspace-members'])assert.throws(()=>assertMemberApi(role,path,'GET'),{status:403});
  for(const path of ['/api/deal-recordings','/api/recording-transcriptions','/api/training-voice','/api/sales-reports'])assert.throws(()=>assertMemberApi('admin',path,'GET'),{status:403});
  assert.throws(()=>assertMemberApi('sales','/api/business-settings','POST'),{status:403});
  assert.throws(()=>assertMemberApi('sales','/api/speech-settings','POST'),{status:403});
  assert.throws(()=>assertMemberApi('sales','/api/sales-reports','GET'),{status:403});
  assert.throws(()=>assertMemberApi('admin','/api/not-registered','POST'),{status:403});
  for(const role of ['sales','manager','admin'] as const)assert.doesNotThrow(()=>assertMemberApi(role,'/api/business-settings','GET'));
  assert.doesNotThrow(()=>assertMemberApi('admin','/api/workspace-members','PATCH'));
  assert.doesNotThrow(()=>assertMemberApi('manager','/api/sales-reports','POST'));
  assert.doesNotThrow(()=>assertMemberApi('sales','/api/deal-recordings','HEAD'));
});

test('admin workflow debugging never injects customer records into a model or deletes existing sales data',async()=>{
  const state=createSeed(),customer=state.deals[0].name;let called=false;
  const workflow={id:'system-flow',name:'系统调试',description:'',status:'draft' as const,version:1,updatedAt:'2026-11-01T00:00:00Z',nodes:[{id:'start',type:'start' as const,label:'开始',x:0,y:0},{id:'expert',type:'agent' as const,label:'专家',agentId:'insight' as const,x:200,y:0},{id:'output',type:'output' as const,label:'结果',x:400,y:0}],edges:[{from:'start',to:'expert'},{from:'expert',to:'output'}]};
  const result=await executeMemberAction(state,'admin','workflow_run',{mode:'draft',workflow,query:`分析${customer}`},{generate:async input=>{called=true;assert.equal(input.deal,undefined);assert.deepEqual(input.deals,[]);return {answer:'仅根据调试输入生成',mode:'live'};}});
  assert.equal(called,true);assert.equal(result.run?.dealId,undefined);assert.deepEqual(result.state.deals,state.deals);
  assert.match(projectAccountResult('admin',result).run?.answer??'',/仅根据调试输入生成/);
  await assert.rejects(executeMemberAction(result.state,'manager','chat',{query:'继续刚才的内容',conversationRunIds:[result.run!.id]}),{status:400});
  state.runs=[{...result.run!,id:'old-team-draft'}];delete (state.runs[0] as unknown as Record<string,unknown>).systemTask;
  assert.throws(()=>assertMemberAction('admin','workflow_review',{runId:'old-team-draft'},state),{status:403});
});

test('manager can release published business review gates while draft debugging stays with admin',async()=>{
  const state=createSeed();
  const workflow={id:'business-flow',name:'业务审核',description:'',status:'published' as const,version:1,updatedAt:'2026-11-01T00:00:00Z',nodes:[{id:'start',type:'start' as const,label:'开始',x:0,y:0},{id:'review',type:'review' as const,label:'人工确认',x:200,y:0},{id:'output',type:'output' as const,label:'结果',x:400,y:0}],edges:[{from:'start',to:'review'},{from:'review',to:'output'}]};state.workflows=[workflow];
  const paused=await executeMemberAction(state,'sales','workflow_run',{mode:'published',workflowId:'business-flow',query:'继续已发布业务流程'});assert.equal(paused.run!.status,'paused');
  const next=await executeMemberAction(paused.state,'manager','workflow_review',{runId:paused.run!.id,decision:'approve',note:'已确认可以继续'});assert.equal(next.run!.status,'completed');
  paused.state.runs[0].workflowSource='draft';
  await assert.rejects(executeMemberAction(paused.state,'manager','workflow_review',{runId:paused.run!.id,decision:'approve',note:'尝试调试'}),{status:403});
});

test('roles cannot promote themselves or cross workflow, customer, and human review boundaries',()=>{
  for(const role of ['sales','manager','admin'] as const)assert.throws(()=>assertMemberAction(role,'switch_role',{role:'manager'}),{status:403});
  for(const action of ['workflow_save','workflow_publish','knowledge_add','skill_review','talktrack_review'])assert.throws(()=>assertMemberAction('sales',action,{}),{status:403});
  assert.throws(()=>assertMemberAction('manager','workflow_save',{}),{status:403});
  assert.throws(()=>assertMemberAction('manager','workflow_run',{mode:'draft',workflow:{}}),{status:403});
  for(const action of ['chat','deal_create','deal_note','contract_save','contract_review','skill_candidate','training_start','skill_review','talktrack_review'])assert.throws(()=>assertMemberAction('admin',action,{}),{status:403});
  assert.doesNotThrow(()=>assertMemberAction('manager','skill_review',{}));
  assert.doesNotThrow(()=>assertMemberAction('manager','talktrack_review',{}));
  assert.doesNotThrow(()=>assertMemberAction('admin','knowledge_add',{}));
  assert.doesNotThrow(()=>assertMemberAction('admin','workflow_run',{mode:'draft'}));
  assert.throws(()=>assertMemberAction('admin','workflow_run',{mode:'draft',dealId:'private-project'}),{status:403});
  assert.doesNotThrow(()=>assertMemberAction('admin','talktrack_archive',{}));
});

test('business approvals separate template operation from actual assigned-person decisions',()=>{
  assert.throws(()=>assertMemberApprovalAction('sales','decide'),{status:403});
  assert.throws(()=>assertMemberApprovalAction('sales','template_save'),{status:403});
  for(const action of ['submit','withdraw','decide'])assert.throws(()=>assertMemberApprovalAction('admin',action),{status:403});
  assert.doesNotThrow(()=>assertMemberApprovalAction('admin','template_save'));
  assert.doesNotThrow(()=>assertMemberApprovalAction('manager','decide'));
});

test('only middleware-marked member roles are accepted and role cookies never grant authority',()=>{
  assert.throws(()=>requireMemberRole(new Request('https://app.test/api/workbench',{headers:{cookie:'ctai_experience_role=manager','x-ctai-member-role':'manager'}})),{status:401});
  assert.equal(requireMemberRole(new Request('https://app.test/api/workbench',{headers:{'x-ctai-member-authenticated':'1','x-ctai-member-role':'sales','x-ctai-member-username':'sales','x-ctai-member-account-id':'member-sales',cookie:'ctai_experience_role=manager'}})),'sales');
});

test('admin operational responses preserve counters and status without exposing customer content, including mutation side channels',()=>{
  const state=createSeed();const source=structuredClone(state);
  state.runs=[{id:'private-run',query:'私人客户输入',answer:'敏感报价',agentIds:['risk'],steps:[{id:'s',title:'客户合同',detail:'保密条件',input:'合同全文',output:'客户姓名',status:'success',duration:30}],citations:[{id:'customer','title':'客户姓名','excerpt':'客户证据'}],dealId:'customer',createdAt:'2026-11-01T00:00:00Z',duration:30,mode:'live',status:'completed'}];
  state.skills[0].status='candidate';
  const projected=projectAccountState('admin',state);
  assert.equal(projected.deals.length,0);assert.equal(projected.trainingSessions.length,0);assert.equal(projected.activities.length,0);
  assert.equal(projected.skills.some(skill=>skill.status==='candidate'),false);
  assert.equal(projected.runs[0].duration,30);assert.equal(projected.runs[0].status,'completed');
  const result=projectAccountResult('admin',{state,run:state.runs[0],dealId:'customer',message:'客户姓名已完成'});
  const serialized=JSON.stringify(result);for(const sensitive of ['私人客户输入','敏感报价','保密条件','合同全文','客户姓名','客户证据','"dealId":"customer"'])assert.equal(serialized.includes(sensitive),false,sensitive);
  assert.equal(source.deals.length,state.deals.length);
  assert.equal(state.runs[0].answer,'敏感报价');
});

test('account projection scopes canonical sales projects and removes private execution metadata',()=>{
  const state=createSeed();const other=state.deals.find(item=>item.ownerId!=='sales-1')!;
  const projected=projectAccountState('sales',state);
  assert.ok(projected.deals.length>0);assert.equal(projected.deals.some(item=>item.id===other.id),false);
  assert.equal(projectAccountResult('sales',{state}).state.deals.some(item=>item.id===other.id),false);
});

test('trusted display names identify knowledge operators and followup authors without rewriting previous owners',async()=>{
  const request=new Request('https://app.test/api/workbench',{headers:{'x-ctai-member-authenticated':'1','x-ctai-member-role':'admin','x-ctai-member-username':'admin','x-ctai-member-account-id':'admin-account','x-ctai-member-display-name':encodeURIComponent('管理员')}});
  const actorName=readMemberDisplayName(request),state=createSeed();
  const imported=await executeMemberAction(state,'admin','knowledge_add',{title:'新资料',content:'知识正文',actorName:'周予安'},{actorName});
  assert.match(imported.state.knowledge[0].source,/管理员/);assert.doesNotMatch(imported.state.knowledge[0].source,/周予安/);
  const originalOwner=state.deals[0].owner;
  const created=await executeMemberAction(state,'sales','deal_create',{name:'新客户',projectName:'新商机'},{actorName:'陈销售'});
  assert.equal(created.state.deals[0].owner,'陈销售');assert.equal(created.state.deals.find(deal=>deal.id===state.deals[0].id)!.owner,originalOwner);
  const followed=await executeMemberAction(created.state,'sales','deal_note',{dealId:created.dealId,text:'跟进说明'},{actorName:'陈销售'});
  assert.equal(followed.state.deals[0].notes[0].author,'陈销售');
});


test('calendar API permits authenticated business roles and excludes administration', () => {
  for (const role of ['sales','manager'] as const) {
    for (const method of ['GET','POST']) assert.doesNotThrow(()=>assertMemberApi(role,'/api/schedules',method));
    assert.throws(()=>assertMemberApi(role,'/api/schedules','DELETE'),{status:403});
  }
  for (const method of ['GET','POST']) assert.throws(()=>assertMemberApi('admin','/api/schedules',method),{status:403});
});
