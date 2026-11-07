import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import { createScheduleService } from '../app/lib/schedule-service.ts';
import { createScheduleStore } from '../app/lib/schedule-store.ts';
import type { EffectiveModel } from '../app/lib/connection-config.ts';
import { createSeed } from '../app/lib/seed.ts';
import type { ScheduleItem, ScheduleList, ScheduleSuggestion, ScheduleUnscheduledPage } from '../app/lib/schedule-types.ts';
const at='2026-11-07T00:00:00.000Z';
const draft={kind:'event',title:'客户沟通',startAt:'2026-11-07T10:00:00+08:00',endAt:'2026-11-07T11:00:00+08:00',allDay:false,dealId:'p1',location:'',notes:''};
const identity={'oai-authenticated-user-id':'owner-a','oai-authenticated-user-email':'owner@example.com','x-ctai-member-authenticated':'1','x-ctai-member-account-id':'sales-a','x-ctai-member-role':'sales','x-ctai-member-username':'sales-a','x-ctai-member-display-name':encodeURIComponent('小林')};
function request(body?:unknown,extra:Record<string,string>={},query='?from=2026-11-07&to=2026-11-08'){
 return new Request(`https://work.example/api/schedules${body===undefined?query:''}`,{method:body===undefined?'GET':'POST',headers:{...identity,...(body===undefined?{}:{'content-type':'application/json'}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
}
function fixture(options:{model?:EffectiveModel|null;generateText?:(model:EffectiveModel,messages:{role:string;content:string}[])=>Promise<string>}={}){
 const sqlite=new DatabaseSync(':memory:');for(const file of readdirSync(new URL('../drizzle/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(`../drizzle/${file}`,import.meta.url),'utf8'));
 const db={prepare(sql:string){let values:unknown[]=[];return{bind(...args:unknown[]){values=args;return this;},async first(){return sqlite.prepare(sql).get(...values as never[])??null;},async all(){return{results:sqlite.prepare(sql).all(...values as never[])};},async run(){const result=sqlite.prepare(sql).run(...values as never[]);return{meta:{changes:Number(result.changes)}};}};}} as unknown as D1Database;
 for(const [id,role] of [['sales-a','sales'],['manager-a','manager'],['admin-a','admin']])sqlite.prepare('INSERT INTO workbench_member_accounts(account_id,owner_id,username,display_name,role,sales_id,password_salt,password_hash,password_iterations,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,'owner-a',id,id,role,'sales-1','x','x',1,at,at);
 const state=createSeed(at);state.deals=[{...state.deals[0],id:'p1',ownerId:'sales-1',name:'我的项目',dataOrigin:'manual'},{...state.deals[0],id:'p2',ownerId:'sales-2',name:'其他项目',dataOrigin:'manual'}];sqlite.prepare('INSERT INTO workbench_workspaces(user_id,state_json,revision,created_at,updated_at) VALUES(?,?,1,?,?)').run('owner-a',JSON.stringify(state),at,at);
 let modelCalls=0;
 const service=createScheduleService({db,now:()=>at,readModel:async()=>{modelCalls++;return options.model??null;},generateText:options.generateText});
 return{sqlite,db,service,modelCalls:()=>modelCalls};
}
test('verified owner/member and current roles are required; legacy cookies and browser-selected owner cannot grant access',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());
 assert.equal((await f.service.handle(new Request('https://work.example/api/schedules',{headers:{cookie:'ctai_experience_role=manager'}}))).status,401);
 assert.equal((await f.service.handle(request(undefined,{'oai-authenticated-user-email':''}))).status,401);
 assert.equal((await f.service.handle(request(undefined,{'x-ctai-member-role':'admin','x-ctai-member-account-id':'admin-a'}))).status,403);
 assert.equal((await f.service.handle(request(undefined,{'oai-authenticated-user-id':'owner-b'}))).status,403);
 assert.equal((await f.service.handle(request(undefined,{},'?from=2026-11-07&to=2026-11-08&scope=team'))).status,403);
 const team=await f.service.handle(request(undefined,{'x-ctai-member-role':'manager','x-ctai-member-account-id':'manager-a'},'?from=2026-11-07&to=2026-11-08&scope=team'));assert.equal(team.status,200);
});
test('create/update/list persist canonical dates and reject stale, foreign and hidden project writes',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());
 const created=await f.service.handle(request({action:'create',requestId:'save-request',draft}));assert.equal(created.status,200);const {item}=await created.json() as {item:ScheduleItem};assert.equal(item.startAt,'2026-11-07T02:00:00.000Z');
 const retry=await (await f.service.handle(request({action:'create',requestId:'save-request',draft}))).json() as {item:ScheduleItem};assert.equal(retry.item.id,item.id);
 assert.equal((await f.service.handle(request({action:'update',id:item.id,version:1,draft:{...draft,title:'修改'}}))).status,200);
 assert.equal((await f.service.handle(request({action:'delete',id:item.id,version:1}))).status,409);
 assert.equal((await f.service.handle(request({action:'create',requestId:'hidden-project',draft:{...draft,dealId:'p2'}}))).status,400);
 assert.equal((await f.service.handle(request({action:'create',requestId:'missing-project',draft:{...draft,dealId:'foreign'}}))).status,400);
 const page=await (await f.service.handle(request())).json() as ScheduleList;assert.equal(page.items.length,1);assert.equal(page.items[0].title,'修改');assert.match((await f.service.handle(request())).headers.get('cache-control')??'',/no-store/);
});
test('same-origin JSON requests enforce byte caps and reject injected ownership, unsupported actions and query ambiguity',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());
 assert.equal((await f.service.handle(request({action:'create',requestId:'x',draft},{origin:'https://other.example'}))).status,403);
 assert.equal((await f.service.handle(request({action:'create',requestId:'x',draft},{'content-type':'text/plain'}))).status,415);
 assert.equal((await f.service.handle(request({action:'create',requestId:'x',draft,ownerId:'owner-b'}))).status,400);
 assert.equal((await f.service.handle(request({action:'create',requestId:'x',draft:{...draft,ownerAccountId:'manager-a'}}))).status,400);
 assert.equal((await f.service.handle(request({action:'suggest',query:'x'.repeat(17000),anchorDate:'2026-11-07'}))).status,413);
 for(const query of ['?from=2026-11-07&to=2026-11-08&ownerId=owner-b','?from=2026-11-07&from=2026-11-08&to=2026-11-08','?from=2026-02-30&to=2026-03-02','?from=2026-01-01&to=2026-12-01'])assert.equal((await f.service.handle(request(undefined,{},query))).status,400);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workbench_schedules').get()?.n,0);
});
test('AI proposals use visible context, require a configured model and never save until confirmed create',async t=>{
 let generated=0;let sawContext='';const f=fixture({model:{key:'secret-key',url:'https://model.invalid',name:'test-model'},generateText:async(_model,messages)=>{generated++;sawContext=JSON.stringify(messages);return JSON.stringify({drafts:[draft],message:'请确认安排'});}});t.after(()=>f.sqlite.close());
 const result=await f.service.handle(request({action:'suggest',query:'帮我安排明天沟通客户',anchorDate:'2026-11-07'}));assert.equal(result.status,200);const proposal=await result.json() as ScheduleSuggestion;assert.equal(proposal.drafts.length,1);assert.equal(generated,1);assert.ok(sawContext.includes('我的项目'));assert.ok(!sawContext.includes('其他项目'));
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workbench_schedules').get()?.n,0);
 assert.equal((await f.service.handle(request({action:'create',requestId:'confirm-ai',draft:proposal.drafts[0]}))).status,200);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workbench_schedules').get()?.n,1);
 const missing=fixture();t.after(()=>missing.sqlite.close());const noModel=await missing.service.handle(request({action:'suggest',query:'安排拜访',anchorDate:'2026-11-07'}));assert.equal(noModel.status,503);assert.equal(missing.sqlite.prepare('SELECT COUNT(*) n FROM workbench_schedules').get()?.n,0);
});
test('provider failures are sanitized and cannot modify saved schedules',async t=>{
 const f=fixture({model:{key:'sensitive-token',url:'https://model.invalid',name:'test-model'},generateText:async()=>{throw new Error('sensitive-token private-url');}});t.after(()=>f.sqlite.close());
 const result=await f.service.handle(request({action:'suggest',query:'明天安排拜访',anchorDate:'2026-11-07'}));assert.equal(result.status,502);assert.ok(!(await result.text()).includes('sensitive-token'));assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workbench_schedules').get()?.n,0);
});

test('suggestions check overlaps beyond the model context cap without leaking a colleague calendar',async t=>{
 const f=fixture({model:{key:'test-key',url:'https://model.invalid',name:'test'},generateText:async()=>JSON.stringify({drafts:[draft],message:'请确认建议'})});t.after(()=>f.sqlite.close());
 const store=createScheduleStore(f.db),actor={ownerId:'owner-a',accountId:'sales-a',role:'sales' as const,displayName:'小林'};
 for(let i=0;i<120;i++)await store.create(actor,`context-${i}`,{...draft,kind:'event',startAt:'2026-11-01T02:00:00.000Z',endAt:'2026-11-01T03:00:00.000Z'},at);
 await store.create(actor,'last-conflict',{...draft,kind:'event',title:'尾部客户会议'},at);
 await store.create({...actor,accountId:'manager-a',role:'manager'},'private-other',{...draft,kind:'event',title:'同事私人会议'},at);
 const response=await f.service.handle(request({action:'suggest',query:'安排11月7日10点至11点客户沟通',anchorDate:'2026-11-07'}));assert.equal(response.status,200);const result=await response.json() as ScheduleSuggestion;
 assert.ok(result.warnings.some(warning=>warning.includes('尾部客户会议')));assert.ok(!JSON.stringify(result).includes('同事私人会议'));
});

test('GET by ID recovers a moved item after a stale edit and rejects mixed range selectors',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());
 const created=await (await f.service.handle(request({action:'create',requestId:'moved-item',draft}))).json() as {item:ScheduleItem};
 assert.equal((await f.service.handle(request({action:'update',id:created.item.id,version:1,draft:{...draft,title:'已改期',startAt:'2026-11-20T10:00:00+08:00',endAt:'2026-11-20T11:00:00+08:00'}}))).status,200);
 assert.equal((await f.service.handle(request({action:'update',id:created.item.id,version:1,draft}))).status,409);
 const oldRange=await (await f.service.handle(request())).json() as ScheduleList;assert.equal(oldRange.items.length,0);
 const response=await f.service.handle(request(undefined,{},`?id=${created.item.id}`));assert.equal(response.status,200);const latest=await response.json() as {item:ScheduleItem};assert.equal(latest.item.version,2);assert.equal(latest.item.startAt,'2026-11-20T02:00:00.000Z');assert.equal(latest.item.title,'已改期');assert.deepEqual(Object.keys(latest),['item']);
 for(const query of [`?id=${created.item.id}&from=2026-11-07`,`?id=${created.item.id}&to=2026-11-08`,`?id=${created.item.id}&from=2026-11-07&to=2026-11-08`,`?id=${created.item.id}&id=unknown`,`?id=${created.item.id}&scope=all`])assert.equal((await f.service.handle(request(undefined,{},query))).status,400);
});
test('GET by ID preserves tenant/member/project isolation and team read-only projection without disclosing deleted records',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const {item}=await (await f.service.handle(request({action:'create',requestId:'read-access',draft}))).json() as {item:ScheduleItem};
 const managerHeaders={'x-ctai-member-role':'manager','x-ctai-member-account-id':'manager-a'};
 assert.equal((await f.service.handle(request(undefined,managerHeaders,`?id=${item.id}`))).status,404);
 const team=await f.service.handle(request(undefined,managerHeaders,`?id=${item.id}&scope=team`));assert.equal(team.status,200);assert.equal(((await team.json()) as {item:ScheduleItem}).item.canEdit,false);
 assert.equal((await f.service.handle(request(undefined,{},`?id=${item.id}&scope=team`))).status,404);
 const absent=await f.service.handle(request(undefined,{},'?id=unknown'));assert.equal(absent.status,404);
 f.sqlite.prepare('INSERT INTO workbench_member_accounts(account_id,owner_id,username,display_name,role,sales_id,password_salt,password_hash,password_iterations,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('sales-b','owner-b','sales-b','外部成员','sales','sales-1','x','x',1,at,at);
 const foreign=await f.service.handle(request(undefined,{'oai-authenticated-user-id':'owner-b','x-ctai-member-account-id':'sales-b'},`?id=${item.id}`));assert.equal(foreign.status,404);assert.deepEqual(await foreign.json(),await absent.json());
 f.sqlite.prepare('UPDATE workbench_workspaces SET state_json=? WHERE user_id=?').run(JSON.stringify({deals:[{id:'p1',ownerId:'sales-2',name:'已转交项目'}]}),'owner-a');
 assert.equal((await f.service.handle(request(undefined,{},`?id=${item.id}`))).status,404);
 assert.equal((await f.service.handle(request({action:'delete',id:item.id,version:1}))).status,200);
 assert.equal((await f.service.handle(request(undefined,managerHeaders,`?id=${item.id}&scope=team`))).status,404);
});

test('unscheduled GET pages are kind-specific with accurate counts and reject mixed or unscoped cursor selectors',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const store=createScheduleStore(f.db),actor={ownerId:'owner-a',accountId:'sales-a',role:'sales' as const,displayName:'小林'};
 const visit=await store.create(actor,'older-pending-visit',{...draft,kind:'visit',startAt:null,endAt:null},'2026-11-01T00:00:00.000Z');
 for(let i=0;i<201;i++){const task=await store.create(actor,`page-${i}`,{...draft,kind:'task',startAt:null,endAt:null},at);await store.status(actor,task.id,1,'completed',at);}
 const calendar=await (await f.service.handle(request())).json() as ScheduleList;assert.equal(calendar.pendingVisitCount,1);assert.deepEqual(calendar.unscheduledCounts,{task:201,visit:1});assert.equal(calendar.scheduledTruncated,false);
 const visitsResponse=await f.service.handle(request(undefined,{},'?unscheduled=visit'));assert.equal(visitsResponse.status,200);const visits=await visitsResponse.json() as ScheduleUnscheduledPage;assert.deepEqual(visits.items.map(item=>item.id),[visit.id]);assert.equal(visits.pendingCount,1);assert.equal(visits.totalCount,1);
 const firstResponse=await f.service.handle(request(undefined,{},'?unscheduled=task'));assert.equal(firstResponse.status,200);const first=await firstResponse.json() as ScheduleUnscheduledPage;assert.equal(first.items.length,100);assert.equal(first.totalCount,201);assert.equal(first.pendingCount,0);assert.ok(first.nextCursor);
 const secondResponse=await f.service.handle(request(undefined,{},`?unscheduled=task&cursor=${first.nextCursor}`));assert.equal(secondResponse.status,200);const second=await secondResponse.json() as ScheduleUnscheduledPage;assert.equal(second.items.length,100);assert.equal(new Set([...first.items,...second.items].map(item=>item.id)).size,200);
 for(const query of ['?unscheduled=event','?unscheduled=visit&from=2026-11-07','?unscheduled=task&to=2026-11-08',`?unscheduled=visit&id=${visit.id}`,'?unscheduled=visit&unscheduled=task','?cursor=anything&from=2026-11-07&to=2026-11-08',`?unscheduled=visit&cursor=${first.nextCursor}`,'?unscheduled=task&cursor=invalid'])assert.equal((await f.service.handle(request(undefined,{},query))).status,400);
 const managerHeaders={'x-ctai-member-role':'manager','x-ctai-member-account-id':'manager-a'};
 assert.equal((await f.service.handle(request(undefined,managerHeaders,`?unscheduled=task&scope=team&cursor=${first.nextCursor}`))).status,400);
 const managerPage=await (await f.service.handle(request(undefined,managerHeaders,'?unscheduled=visit&scope=team'))).json() as ScheduleUnscheduledPage;assert.equal(managerPage.items[0].canEdit,false);
});
