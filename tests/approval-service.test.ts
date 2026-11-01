import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createSeed } from '../app/lib/seed.ts';
import { createApprovalService, readApprovalIdentity, assertApprovalOrigin } from '../app/lib/approval-service.ts';
import type { ApprovalActor } from '../app/lib/approval-types.ts';
import type { ContractDocument } from '../app/lib/contract-types.ts';

const now='2026-10-24T03:00:00.000Z';
const alice:ApprovalActor={id:'alice',email:'alice@example.com',name:'Alice'};
const finance:ApprovalActor={id:'finance',email:'finance@example.com',name:'Finance'};
const legal:ApprovalActor={id:'legal',email:'legal@example.com',name:'Legal'};
const other:ApprovalActor={id:'mallory',email:'mallory@example.com',name:'Mallory'};
const route=[{id:'finance',label:'财务审批',role:'finance',approverName:'Finance',approverEmail:finance.email},{id:'legal',label:'法务审批',role:'legal',approverName:'Legal',approverEmail:legal.email}];
function fixture(){
  const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
  for(const file of readdirSync(new URL('../drizzle/',import.meta.url)).filter(name=>name.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(`../drizzle/${file}`,import.meta.url),'utf8'));
  const statements:string[]=[];let beforeWrite:((sql:string)=>void)|undefined;
  const db={prepare(sql:string){statements.push(sql);let values:unknown[]=[];return {bind(...bound:unknown[]){values=bound;return this;},async first(){return sqlite.prepare(sql).get(...values as never[])??null;},async all(){return {success:true,results:sqlite.prepare(sql).all(...values as never[])};},async run(){const callback=beforeWrite;beforeWrite=undefined;callback?.(sql);const result=sqlite.prepare(sql).run(...values as never[]);return {success:true,meta:{changes:Number(result.changes)}};}};},async batch(items:{run:()=>Promise<unknown>}[]){sqlite.exec('BEGIN');try{const results=[];for(const item of items)results.push(await item.run());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}} as unknown as D1Database;
  const workspace=createSeed(now);workspace.deals[0].ownerId='sales-1';
  const document:ContractDocument={id:'contract-1',dealId:workspace.deals[0].id,title:'销售合同',text:'合同原文约定付款30天。',contractType:'销售合同',ourParty:'乙方',focus:'付款期限',sourceFormat:'paste',version:1,createdBy:'Alice',createdAt:now,updatedAt:now};workspace.contracts=[document];
  const save=()=>sqlite.prepare('INSERT INTO workbench_workspaces (user_id,state_json,revision,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET state_json=excluded.state_json').run('alice',JSON.stringify(workspace),workspace.revision,now,now);save();
  const payload=(overrides:Record<string,unknown>={})=>({id:crypto.randomUUID(),kind:'business',projectId:workspace.deals[0].id,title:'商务折扣',reason:'促成首期签约',steps:route,conditions:[{id:'condition-1',category:'价格',subject:'折扣',baseline:'原价',proposed:'九折',reason:'首单优惠'}],...overrides});
  return {sqlite,workspace,document,save,payload,statements,beforeWrite:(callback:(sql:string)=>void)=>{beforeWrite=callback;},service:createApprovalService(db,()=>now)};
}

test('trusted identity normalization and origin validation do not use a role cookie',()=>{
  const request=new Request('https://work.example.com/api/approvals',{headers:{'oai-authenticated-user-id':'finance','oai-authenticated-user-email':' FINANCE@EXAMPLE.COM ','x-ctai-member-authenticated':'1','x-ctai-member-role':'manager','x-ctai-member-username':'manager','x-ctai-member-account-id':'member-manager','x-ctai-member-display-name':encodeURIComponent('财务同事'),cookie:'ctai_experience_role=sales',origin:'https://work.example.com'}});
  assert.deepEqual(readApprovalIdentity(request),{id:'finance',email:'finance@example.com',name:'财务同事',workspaceId:'finance',memberRole:'manager'});assertApprovalOrigin(request);
  assert.throws(()=>readApprovalIdentity(new Request(request.url,{headers:{cookie:'ctai_experience_role=manager'}})),{status:401});
  assert.throws(()=>assertApprovalOrigin(new Request(request.url,{headers:{origin:'https://attacker.example.com'}})),{status:403});
  assert.throws(()=>assertApprovalOrigin(new Request(request.url,{headers:{'sec-fetch-site':'cross-site'}})),{status:403});
});

test('workspace member applicants are distinct from the manager and admin has template-only authority',async(t)=>{
  const {sqlite,service,payload}=fixture();t.after(()=>sqlite.close());
  const salesperson={id:'sales-account',email:'sales+sales-account@accounts.ctai.local',name:'销售',workspaceId:alice.id,memberRole:'sales' as const};
  const manager={...alice,workspaceId:alice.id,memberRole:'manager' as const};
  const admin={id:'admin-account',email:'admin+admin-account@accounts.ctai.local',name:'管理员',workspaceId:alice.id,memberRole:'admin' as const};
  const input=payload({steps:[{id:'manager',label:'销售管理者审批',role:'manager',approverName:'Alice',approverEmail:alice.email}]});
  const created=(await service.mutate(salesperson,'sales','submit',input)).request!;
  assert.equal(created.ownerId,alice.id);assert.equal(created.applicant.id,'sales-account');
  assert.equal((await service.list(manager,{scope:'all'})).requests[0].canDecide,true);
  await assert.rejects(service.detail({...salesperson,id:'other-sales'},created.id),{status:404});
  await assert.rejects(service.detail({...manager,id:'different-owner',workspaceId:'different-owner'},created.id),{status:404});
  await assert.rejects(service.mutate(salesperson,'sales','decide',{id:created.id,version:1,decision:'approve'}),{status:403});
  await assert.rejects(service.mutate(admin,'manager','decide',{id:created.id,version:1,decision:'approve'}),{status:403});
  await assert.rejects(service.detail(admin,created.id),{status:403});
  await assert.rejects(service.list(admin),{status:403});
  const approved=await service.mutate(manager,'manager','decide',{id:created.id,version:1,decision:'approve'});assert.equal(approved.request!.status,'approved');
  const template={id:crypto.randomUUID(),name:'销售负责人审批',kind:'business',steps:input.steps,version:0};
  await service.mutate(admin,'manager','template_save',template);
  const templates=await service.templates(admin);assert.equal(templates.templates.length,1);assert.equal('requests' in templates,false);
  assert.equal((await service.list(salesperson)).templates[0].id,template.id);
});

test('canonical submission snapshots stay private and only the exact current approver can decide',async(t)=>{
  const {sqlite,service,payload,statements}=fixture();t.after(()=>sqlite.close());
  const created=await service.mutate(alice,'manager','submit',payload());assert.ok('request' in created);const request=created.request!;
  await assert.rejects(service.detail(other,request.id),{status:404});
  assert.equal((await service.detail(legal,request.id)).request.id,request.id);
  await assert.rejects(service.mutate(other,'manager','decide',{id:request.id,version:1,decision:'approve'}),{status:404});
  await assert.rejects(service.mutate(legal,'manager','decide',{id:request.id,version:1,decision:'approve'}),{status:403});
  assert.equal((await service.list(legal,{scope:'inbox'})).pendingCount,0);
  assert.equal((await service.list(finance,{scope:'inbox'})).pendingCount,1);
  const next=await service.mutate(finance,'sales','decide',{id:request.id,version:1,decision:'approve'});assert.equal(next.request!.currentStep,1);
  await assert.rejects(service.mutate(finance,'manager','decide',{id:request.id,version:1,decision:'approve'}),{status:409});
  const done=await service.mutate(legal,'sales','decide',{id:request.id,version:2,decision:'approve'});assert.equal(done.request!.status,'approved');
  assert.ok(!statements.some(sql=>/^CREATE|^ALTER/i.test(sql)));
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workbench_workspaces').get()?.n,1);
});

test('request IDs are idempotent only for the same owner and original payload, while duplicate active content conflicts',async(t)=>{
  const {sqlite,service,payload}=fixture();t.after(()=>sqlite.close());const input=payload();const first=await service.mutate(alice,'sales','submit',input);
  assert.equal((await service.mutate(alice,'sales','submit',input)).request!.id,first.request!.id);
  await assert.rejects(service.mutate(alice,'sales','submit',{...input,title:'changed'}),{status:409});
  await assert.rejects(service.mutate(other,'manager','submit',input),{status:409});
  await assert.rejects(service.mutate(alice,'sales','submit',{...input,id:crypto.randomUUID()}),{status:409});
});

test('saved contract content is authoritative, finding status alone stays valid, and source changes supersede',async(t)=>{
  const {sqlite,service,payload,document,save}=fixture();t.after(()=>sqlite.close());
  const input=payload({kind:'contract',conditions:undefined,contractId:document.id,contractVersion:1});
  const first=await service.mutate(alice,'sales','submit',input);const request=first.request!;
  assert.equal(request.snapshot.contract!.text,document.text);
  document.version=2;document.updatedAt='2026-10-24T04:00:00.000Z';document.analysis={summary:'初审',findings:[],missingItems:[],coverage:{characters:document.text.length,clauses:1,chunks:1},warnings:[]};save();
  assert.equal((await service.detail(finance,request.id)).request.status,'pending');
  document.text='合同原文已改为付款90天。';save();
  await assert.rejects(service.mutate(finance,'manager','decide',{id:request.id,version:1,decision:'approve'}),{status:409});
  const invalidated=(await service.detail(finance,request.id)).request;assert.equal(invalidated.status,'superseded');assert.equal(invalidated.history.at(-1)?.action,'supersede');assert.equal(invalidated.history.at(-1)?.actor.id,'system:source-validation');assert.equal(invalidated.history.at(-1)?.actor.name,'系统校验');assert.equal(invalidated.history.at(-1)?.actor.email,'');assert.ok(invalidated.history.at(-1)?.note?.includes('合同'));assert.equal(invalidated.snapshot.contract!.text,'合同原文约定付款30天。');
  const list=await service.list(finance,{scope:'all'});assert.equal(list.pendingCount,0);assert.equal(list.requests[0].status,'superseded');
  assert.ok(!JSON.stringify(list).includes('合同原文'));
  assert.equal((await service.mutate(alice,'sales','submit',input)).request!.status,'superseded');
});

test('sales project visibility is checked on submission and applicants alone may withdraw',async(t)=>{
  const {sqlite,service,payload,workspace,save}=fixture();t.after(()=>sqlite.close());workspace.deals[0].ownerId='sales-2';save();
  await assert.rejects(service.mutate(alice,'sales','submit',payload()),{status:404});
  const first=await service.mutate(alice,'manager','submit',payload());
  await assert.rejects(service.mutate(finance,'manager','withdraw',{id:first.request!.id,version:1}),{status:403});
  assert.equal((await service.mutate(alice,'sales','withdraw',{id:first.request!.id,version:1})).request!.status,'withdrawn');
});

test('concurrent service decisions use CAS and advance once',async(t)=>{
  const {sqlite,service,payload}=fixture();t.after(()=>sqlite.close());const first=await service.mutate(alice,'manager','submit',payload());
  const input={id:first.request!.id,version:1,decision:'approve'};
  const results=await Promise.allSettled([service.mutate(finance,'manager','decide',input),service.mutate(finance,'sales','decide',input)]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal((results.find(result=>result.status==='rejected') as PromiseRejectedResult).reason.status,409);
  assert.equal((await service.detail(legal,first.request!.id)).request.currentStep,1);
});

test('flow template CRUD is private and compares expected versions',async(t)=>{
  const {sqlite,service}=fixture();t.after(()=>sqlite.close());const input={id:crypto.randomUUID(),name:'财务法务',kind:'business',steps:route,version:0};
  const saved=await service.mutate(alice,'sales','template_save',input);assert.equal(saved.template!.version,1);
  assert.equal((await service.list(other)).templates.length,0);
  await assert.rejects(service.mutate(other,'manager','template_save',{...input,version:1}),{status:409});
  await assert.rejects(service.mutate(other,'manager','template_delete',{id:input.id,version:1}),{status:409});
  await service.mutate(alice,'sales','template_delete',{id:input.id,version:1});assert.equal((await service.list(alice)).templates.length,0);
});


test('a canonical source edit between validation and CAS cannot be approved',async(t)=>{
  const {sqlite,service,payload,document,save,beforeWrite}=fixture();t.after(()=>sqlite.close());
  const input=payload({kind:'contract',conditions:undefined,contractId:document.id,contractVersion:1});
  const first=await service.mutate(alice,'sales','submit',input);
  beforeWrite(sql=>{if(sql.startsWith('UPDATE workbench_approval_requests')){document.text='并发更新付款条款';save();}});
  await assert.rejects(service.mutate(finance,'manager','decide',{id:first.request!.id,version:1,decision:'approve'}),{status:409});
  const detail=await service.detail(finance,first.request!.id);assert.equal(detail.request.status,'superseded');assert.equal(detail.request.history.filter(event=>event.action!=='supersede').length,1);
});

test('missing workspaces are never initialized and linked resubmission requires an owned terminal request',async(t)=>{
  const {sqlite,service,payload}=fixture();t.after(()=>sqlite.close());
  await assert.rejects(service.mutate(other,'manager','submit',payload()),{status:404});
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workbench_workspaces').get()?.n,1);
  const first=await service.mutate(alice,'manager','submit',payload());
  await assert.rejects(service.mutate(alice,'manager','submit',payload({previousRequestId:first.request!.id})),{status:409});
  await service.mutate(finance,'sales','decide',{id:first.request!.id,version:1,decision:'return',note:'请调整折扣'});
  const second=await service.mutate(alice,'sales','submit',payload({previousRequestId:first.request!.id}));
  assert.equal(second.request!.previousRequestId,first.request!.id);assert.equal((await service.detail(alice,first.request!.id)).request.status,'returned');
});

test('source edits preserve rejected returned and withdrawn human outcomes',async(t)=>{
  const {sqlite,service,payload,document,save}=fixture();t.after(()=>sqlite.close());
  const input=()=>payload({kind:'contract',conditions:undefined,contractId:document.id,contractVersion:document.version});
  for(const decision of ['reject','return','withdraw'] as const){
    const first=await service.mutate(alice,'sales','submit',input());
    if(decision==='withdraw')await service.mutate(alice,'manager','withdraw',{id:first.request!.id,version:1});
    else await service.mutate(finance,'sales','decide',{id:first.request!.id,version:1,decision,note:'需要修改'});
    document.text+=` ${decision}后修改`;document.version++;save();
    assert.equal((await service.detail(alice,first.request!.id)).request.status,decision==='reject'?'rejected':decision==='return'?'returned':'withdrawn');
  }
});

test('summary search includes applicant identity and escapes SQL wildcard characters',async(t)=>{
  const {sqlite,service,payload}=fixture();t.after(()=>sqlite.close());await service.mutate(alice,'manager','submit',payload());
  assert.equal((await service.list(finance,{q:'Alice'})).requests.length,1);
  assert.equal((await service.list(finance,{q:'alice@example.com'})).requests.length,1);
  assert.equal((await service.list(finance,{q:'%'})).requests.length,0);
});

test('the first decision binds participant read access and pending badge to that stable account',async(t)=>{
  const {sqlite,service,payload,document}=fixture();t.after(()=>sqlite.close());
  const repeated=route.map(step=>({...step,approverEmail:finance.email,approverName:finance.name}));
  const first=await service.mutate(alice,'sales','submit',payload({kind:'contract',conditions:undefined,contractId:document.id,contractVersion:1,steps:repeated}));
  await service.mutate(finance,'manager','decide',{id:first.request!.id,version:1,decision:'approve'});
  const replacement={...finance,id:'finance-replacement'};
  await assert.rejects(service.detail(replacement,first.request!.id),{status:404});
  await assert.rejects(service.mutate(replacement,'manager','decide',{id:first.request!.id,version:2,decision:'approve'}),{status:404});
  for(const scope of ['all','inbox'] as const){const list=await service.list(replacement,{scope});assert.equal(list.requests.length,0);assert.equal(list.pendingCount,0);}
  const original=await service.list(finance,{scope:'inbox'});assert.equal(original.requests.length,1);assert.equal(original.pendingCount,1);
  assert.equal((await service.detail(alice,first.request!.id)).request.snapshot.contract!.text,document.text);
});

test('a one-row badge poll does no additional pending-contract metadata traversal',async(t)=>{
  const {sqlite,service,payload,document,statements}=fixture();t.after(()=>sqlite.close());
  await service.mutate(alice,'sales','submit',payload({kind:'contract',conditions:undefined,contractId:document.id,contractVersion:1}));
  statements.length=0;const result=await service.list(finance,{scope:'inbox',limit:1});assert.equal(result.pendingCount,1);
  const requests=statements.filter(sql=>sql.includes('FROM workbench_approval_requests'));
  assert.equal(requests.length,2);assert.equal(requests.filter(sql=>sql.startsWith('SELECT COUNT')).length,1);assert.equal(requests.filter(sql=>sql.includes('LIMIT')).length,1);
});
