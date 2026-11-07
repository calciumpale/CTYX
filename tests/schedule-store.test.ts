import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import { createScheduleStore } from '../app/lib/schedule-store.ts';
import type { ScheduleActor } from '../app/lib/schedule-store.ts';
import type { ScheduleDraft } from '../app/lib/schedule-types.ts';
const at='2026-11-07T00:00:00.000Z';
const draft:ScheduleDraft={kind:'event',title:'沟通',startAt:'2026-11-07T02:00:00.000Z',endAt:'2026-11-07T03:00:00.000Z',allDay:false,dealId:'p1',location:'',notes:''};
const sales:ScheduleActor={ownerId:'owner-a',accountId:'sales-a',role:'sales',displayName:'小林'};
const manager:ScheduleActor={...sales,accountId:'manager-a',role:'manager',displayName:'管理者'};
const foreign:ScheduleActor={ownerId:'owner-b',accountId:'sales-b',role:'sales',displayName:'外部'};
function fixture(){
  const sqlite=new DatabaseSync(':memory:');
  for(const name of readdirSync(new URL('../drizzle/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(`../drizzle/${name}`,import.meta.url),'utf8'));
  let onRun:(sql:string)=>void=()=>{};
  const db={prepare(sql:string){let values:unknown[]=[];return {bind(...args:unknown[]){values=args;return this;},async first(){return sqlite.prepare(sql).get(...values as never[])??null;},async all(){return {results:sqlite.prepare(sql).all(...values as never[])};},async run(){onRun(sql);const result=sqlite.prepare(sql).run(...values as never[]);return {meta:{changes:Number(result.changes)}};}};}} as unknown as D1Database;
  for(const actor of [sales,manager,foreign])sqlite.prepare('INSERT INTO workbench_member_accounts(account_id,owner_id,username,display_name,role,sales_id,password_salt,password_hash,password_iterations,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(actor.accountId,actor.ownerId,actor.accountId,actor.displayName,actor.role,'sales-1','x','x',1,at,at);
  for(const owner of ['owner-a','owner-b'])sqlite.prepare('INSERT INTO workbench_workspaces(user_id,state_json,revision,created_at,updated_at) VALUES(?,?,1,?,?)').run(owner,JSON.stringify({deals:[{id:'p1',ownerId:'sales-1',name:'我的项目'},{id:'p2',ownerId:'sales-2',name:'其他项目'}]}),at,at);
  return {sqlite,db,store:createScheduleStore(db),beforeRun:(hook:(sql:string)=>void)=>{onRun=hook;}};
}
test('create retries return one durable identity and changed retry payload conflicts',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());
 const one=await f.store.create(sales,'request-1',draft,at);const two=await f.store.create(sales,'request-1',draft,at);
 assert.equal(one.id,two.id);assert.equal(two.version,1);
 await assert.rejects(f.store.create(sales,'request-1',{...draft,title:'另一个活动'},at),{status:409});
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workbench_schedules').get()?.n,1);
 const sameRequestOtherMember=await f.store.create(manager,'request-1',draft,at);assert.notEqual(sameRequestOtherMember.id,one.id);
});
test('queries return overlaps and unscheduled separately, preserving tenant and member visibility',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());
 const crossing=await f.store.create(sales,'crossing',{...draft,startAt:'2026-11-06T15:30:00.000Z',endAt:'2026-11-06T16:30:00.000Z'},at);
 await f.store.create(sales,'ends-before',{...draft,startAt:'2026-11-06T15:00:00.000Z',endAt:'2026-11-06T16:00:00.000Z'},at);
 await f.store.create(sales,'starts-after',{...draft,startAt:'2026-11-07T16:00:00.000Z',endAt:'2026-11-07T17:00:00.000Z'},at);
 await f.store.create(sales,'no-time',{...draft,kind:'visit',startAt:null,endAt:null},at);
 const managed=await f.store.create(manager,'managed',draft,at);await f.store.create(foreign,'other-owner',draft,at);
 const mine=await f.store.list(sales,'2026-11-07','2026-11-08','mine');assert.deepEqual(mine.items.map(i=>i.id),[crossing.id]);assert.equal(mine.unscheduled.length,1);assert.equal(mine.items[0].canEdit,true);
 const team=await f.store.list(manager,'2026-11-07','2026-11-08','team');assert.equal(team.items.length,2);assert.equal(team.items.find(i=>i.id===crossing.id)?.canEdit,false);assert.equal(team.items.find(i=>i.id===managed.id)?.canEdit,true);
 await assert.rejects(f.store.list(sales,'2026-11-07','2026-11-08','team'),{status:403});
});
test('optimistic versions protect update, status, soft delete and restore; managers cannot change others',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const one=await f.store.create(sales,'request-1',draft,at);
 await assert.rejects(f.store.update(manager,one.id,1,{...draft,title:'越权'},at),{status:404});
 await assert.rejects(f.store.update(foreign,one.id,1,draft,at),{status:404});
 const updated=await f.store.update(sales,one.id,1,{...draft,title:'已修改'},at);assert.equal(updated.version,2);
 await assert.rejects(f.store.status(sales,one.id,1,'completed',at),{status:409});
 const completed=await f.store.status(sales,one.id,2,'completed',at);assert.equal(completed.status,'completed');
 const deleted=await f.store.delete(sales,one.id,3,at);assert.equal(deleted.version,4);assert.equal((await f.store.list(sales,'2026-11-07','2026-11-08','mine')).items.length,0);
 await assert.rejects(f.store.restore(sales,one.id,3,at),{status:409});
 const restored=await f.store.restore(sales,one.id,4,at);assert.equal(restored.version,5);assert.equal(restored.status,'completed');
 await assert.rejects(f.store.restore(sales,one.id,5,at),{status:409});
 const replay=await f.store.create(sales,'request-1',draft,at);assert.equal(replay.id,one.id);assert.equal(replay.title,'已修改');assert.equal(replay.version,5);
});
test('project links, disabled members and member ownership fail closed at persistence boundary',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());
 await assert.rejects(f.store.create(sales,'foreign-project',{...draft,dealId:'p2'},at),{status:400});
 await assert.rejects(f.store.create(sales,'missing-project',{...draft,dealId:'missing'},at),{status:400});
 await assert.rejects(f.store.create({...sales,ownerId:'owner-b'},'wrong-owner',draft,at),{status:403});
 const one=await f.store.create(sales,'request-1',draft,at);
 f.sqlite.prepare('UPDATE workbench_member_accounts SET enabled=0 WHERE account_id=?').run(sales.accountId);
 await assert.rejects(f.store.status(sales,one.id,1,'completed',at),{status:403});
 await assert.rejects(f.store.list(sales,'2026-11-07','2026-11-08','mine'),{status:403});
});

test('racing retries create one item, and racing edits permit exactly one version transition',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());
 const [first,second]=await Promise.all([f.store.create(sales,'racing-request',draft,at),f.store.create(sales,'racing-request',draft,at)]);
 assert.equal(first.id,second.id);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workbench_schedules').get()?.n,1);
 const edits=await Promise.allSettled([f.store.update(sales,first.id,1,{...draft,title:'甲'},at),f.store.update(sales,first.id,1,{...draft,title:'乙'},at)]);
 assert.equal(edits.filter(result=>result.status==='fulfilled').length,1);
 const rejected=edits.find(result=>result.status==='rejected');assert.equal(rejected?.status==='rejected'?rejected.reason.status:0,409);
 assert.equal(f.sqlite.prepare('SELECT version FROM workbench_schedules WHERE id=?').get(first.id)?.version,2);
});
test('SQL write guards close project-deletion and account-disable races after validation',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());
 let changed=false;f.beforeRun(sql=>{if(!changed&&sql.startsWith('INSERT INTO workbench_schedules')){changed=true;f.sqlite.prepare('UPDATE workbench_workspaces SET state_json=? WHERE user_id=?').run(JSON.stringify({deals:[]}),sales.ownerId);}});
 await assert.rejects(f.store.create(sales,'deleted-project',draft,at),{status:409});assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workbench_schedules').get()?.n,0);
 f.beforeRun(()=>{});const one=await f.store.create(sales,'unlinked',{...draft,dealId:null},at);
 f.beforeRun(sql=>{if(sql.startsWith('UPDATE workbench_schedules'))f.sqlite.prepare('UPDATE workbench_member_accounts SET enabled=0 WHERE account_id=?').run(sales.accountId);});
 await assert.rejects(f.store.status(sales,one.id,1,'completed',at),{status:409});assert.equal(f.sqlite.prepare('SELECT status FROM workbench_schedules WHERE id=?').get(one.id)?.status,'pending');
});
test('calendar reads cap persisted rows and explicitly report truncation',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());
 for(let i=0;i<501;i++)await f.store.create(sales,`bounded-${i}`,draft,at);
 const page=await f.store.list(sales,'2026-11-07','2026-11-08');assert.equal(page.items.length,500);assert.equal(page.truncated,true);
 const empty=await f.store.list(foreign,'2026-11-07','2026-11-08');assert.equal(empty.truncated,false);assert.equal(empty.items.length,0);
});

test('restoring a deleted item revalidates project visibility before bringing its link back',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const one=await f.store.create(sales,'restore-link',draft,at);await f.store.delete(sales,one.id,1,at);
 f.sqlite.prepare('UPDATE workbench_workspaces SET state_json=? WHERE user_id=?').run(JSON.stringify({deals:[{id:'p1',ownerId:'sales-2',name:'已转交项目'}]}),sales.ownerId);
 await assert.rejects(f.store.restore(sales,one.id,2,at),{status:400});
 assert.equal(f.sqlite.prepare('SELECT deleted_at,version FROM workbench_schedules WHERE id=?').get(one.id)?.version,2);
 assert.equal((await f.store.list(sales,'2026-11-07','2026-11-08')).items.length,0);
});

test('exact ID reads recover the latest version after a concurrent move outside the stale date range',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const one=await f.store.create(sales,'moved-item',draft,at);
 await f.store.update(sales,one.id,1,{...draft,title:'已改期',startAt:'2026-11-20T02:00:00.000Z',endAt:'2026-11-20T03:00:00.000Z'},at);
 await assert.rejects(f.store.update(sales,one.id,1,{...draft,title:'过期修改'},at),{status:409});
 assert.equal((await f.store.list(sales,'2026-11-07','2026-11-08')).items.length,0);
 const latest=await f.store.get(sales,one.id);assert.equal(latest.version,2);assert.equal(latest.startAt,'2026-11-20T02:00:00.000Z');assert.equal(latest.title,'已改期');assert.equal(latest.canEdit,true);
});
test('exact ID reads hide foreign, deleted and invisible-project records; managers can read team items without editing',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const one=await f.store.create(sales,'id-access',draft,at);
 await assert.rejects(f.store.get(foreign,one.id),{status:404});
 await assert.rejects(f.store.get(manager,one.id),{status:404});
 await assert.rejects(f.store.get(sales,'unknown'),{status:404});
 await assert.rejects(f.store.get(sales,one.id,'team'),{status:404});
 const team=await f.store.get(manager,one.id,'team');assert.equal(team.id,one.id);assert.equal(team.canEdit,false);
 f.sqlite.prepare('UPDATE workbench_workspaces SET state_json=? WHERE user_id=?').run(JSON.stringify({deals:[{id:'p1',ownerId:'sales-2',name:'已转交项目'}]}),sales.ownerId);
 await assert.rejects(f.store.get(sales,one.id),{status:404});
 assert.equal((await f.store.get(manager,one.id,'team')).canEdit,false);
 await f.store.delete(sales,one.id,1,at);
 await assert.rejects(f.store.get(manager,one.id,'team'),{status:404});
 await assert.rejects(f.store.get(sales,one.id),{status:404});
});

test('unscheduled visit counts and independent pages survive a newer completed-task backlog',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const visit=await f.store.create(sales,'old-visit',{...draft,kind:'visit',startAt:null,endAt:null},'2026-11-01T00:00:00.000Z');
 for(let i=0;i<200;i++){const task=await f.store.create(sales,`done-task-${i}`,{...draft,kind:'task',startAt:null,endAt:null},at);await f.store.status(sales,task.id,1,'completed',at);}
 const list=await f.store.list(sales,'2026-11-07','2026-11-08');assert.deepEqual(list.unscheduledCounts,{task:200,visit:1});assert.equal(list.pendingVisitCount,1);assert.equal(list.scheduledTruncated,false);assert.equal(list.truncated,true);
 const visits=await f.store.unscheduled(sales,'visit');assert.equal(visits.totalCount,1);assert.equal(visits.pendingCount,1);assert.deepEqual(visits.items.map(item=>item.id),[visit.id]);assert.equal(visits.nextCursor,undefined);
});
test('independent unscheduled keyset pages traverse tied timestamps without losing or repeating items',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const expected=new Set<string>();
 for(let i=0;i<201;i++)expected.add((await f.store.create(sales,`page-task-${i}`,{...draft,kind:'task',startAt:null,endAt:null},at)).id);
 const seen:string[]=[];const sizes:number[]=[];let cursor:string|undefined;let pages=0;
 do{const page=await f.store.unscheduled(sales,'task','mine',cursor);pages++;sizes.push(page.items.length);assert.equal(page.totalCount,201);assert.equal(page.pendingCount,201);seen.push(...page.items.map(item=>item.id));cursor=page.nextCursor;if(pages>3)assert.fail('pagination failed to terminate');}while(cursor);
 assert.deepEqual(sizes,[100,100,1]);assert.equal(new Set(seen).size,201);assert.deepEqual(new Set(seen),expected);assert.deepEqual(seen,[...seen].sort().reverse());
});
test('unscheduled cursors cannot cross kind, scope, member or tenant boundaries and reject malformed pointers',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());for(let i=0;i<101;i++)await f.store.create(sales,`cursor-${i}`,{...draft,kind:'visit',startAt:null,endAt:null},at);
 const own=await f.store.unscheduled(sales,'visit');assert.ok(own.nextCursor);
 await assert.rejects(f.store.unscheduled(sales,'task','mine',own.nextCursor),{status:400});
 await assert.rejects(f.store.unscheduled(foreign,'visit','mine',own.nextCursor),{status:400});
 await assert.rejects(f.store.unscheduled(manager,'visit','mine',own.nextCursor),{status:400});
 const team=await f.store.unscheduled(manager,'visit','team');assert.equal(team.items.length,100);assert.equal(team.items.every(item=>item.canEdit===false),true);assert.ok(team.nextCursor);
 await assert.rejects(f.store.unscheduled(manager,'visit','mine',team.nextCursor),{status:400});
 await assert.rejects(f.store.unscheduled(sales,'visit','team'),{status:403});
 for(const bad of ['', 'not-a-cursor', 'x'.repeat(2100),btoa('[]'),btoa('{"v":1,"context":"x","at":"2026-02-30T00:00:00.000Z","id":"x"}')])await assert.rejects(f.store.unscheduled(sales,'visit','mine',bad),{status:400});
 const decoded=JSON.parse(Buffer.from(own.nextCursor!, 'base64url').toString('utf8')) as Record<string,unknown>;
 for(const changed of [{...decoded,v:2},{...decoded,at:'2026-02-30T00:00:00.000Z'},{...decoded,at:'2026-11-07T00:00:00Z'},{...decoded,id:"' OR 1=1"},{...decoded,extra:'unexpected'},{...decoded,context:'0'.repeat(64)}])await assert.rejects(f.store.unscheduled(sales,'visit','mine',Buffer.from(JSON.stringify(changed)).toString('base64url')),{status:400});
 assert.equal((await f.store.unscheduled(foreign,'visit')).totalCount,0);
});
test('calendar lists, unscheduled pages and exact reads share current project visibility and accurate counts',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const scheduled=await f.store.create(sales,'linked-schedule',draft,at);const visit=await f.store.create(sales,'linked-visit',{...draft,kind:'visit',startAt:null,endAt:null},at);await f.store.create(sales,'unlinked-task',{...draft,kind:'task',dealId:null,startAt:null,endAt:null},at);
 f.sqlite.prepare('UPDATE workbench_workspaces SET state_json=? WHERE user_id=?').run(JSON.stringify({deals:[{id:'p1',ownerId:'sales-2',name:'已转交项目'}]}),sales.ownerId);
 const mine=await f.store.list(sales,'2026-11-07','2026-11-08');assert.equal(mine.items.length,0);assert.equal(mine.unscheduled.length,1);assert.deepEqual(mine.unscheduledCounts,{task:1,visit:0});assert.equal(mine.pendingVisitCount,0);assert.equal((await f.store.unscheduled(sales,'visit')).totalCount,0);
 await assert.rejects(f.store.get(sales,scheduled.id),{status:404});await assert.rejects(f.store.get(sales,visit.id),{status:404});
 const team=await f.store.list(manager,'2026-11-07','2026-11-08','team');assert.equal(team.items.length,1);assert.equal(team.pendingVisitCount,1);assert.equal((await f.store.unscheduled(manager,'visit','team')).totalCount,1);
 f.sqlite.prepare('UPDATE workbench_workspaces SET state_json=? WHERE user_id=?').run(JSON.stringify({deals:[]}),sales.ownerId);
 const deletedProject=await f.store.list(manager,'2026-11-07','2026-11-08','team');assert.equal(deletedProject.items.length,0);assert.deepEqual(deletedProject.unscheduledCounts,{task:1,visit:0});assert.equal((await f.store.unscheduled(manager,'visit','team')).totalCount,0);
});

test('unscheduled counts include every status but only current visible undeleted records of that kind',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());await f.store.create(sales,'count-pending',{...draft,kind:'visit',startAt:null,endAt:null},at);
 const completed=await f.store.create(sales,'count-completed',{...draft,kind:'visit',startAt:null,endAt:null},at);await f.store.status(sales,completed.id,1,'completed',at);
 const cancelled=await f.store.create(sales,'count-cancelled',{...draft,kind:'visit',startAt:null,endAt:null},at);await f.store.status(sales,cancelled.id,1,'cancelled',at);
 const removed=await f.store.create(sales,'count-deleted',{...draft,kind:'visit',startAt:null,endAt:null},at);await f.store.delete(sales,removed.id,1,at);
 await f.store.create(sales,'count-scheduled-visit',{...draft,kind:'visit'},at);await f.store.create(manager,'count-other-member',{...draft,kind:'visit',startAt:null,endAt:null},at);
 const mine=await f.store.unscheduled(sales,'visit');assert.equal(mine.totalCount,3);assert.equal(mine.pendingCount,1);
 const list=await f.store.list(sales,'2026-11-07','2026-11-08');assert.deepEqual(list.unscheduledCounts,{task:0,visit:3});assert.equal(list.pendingVisitCount,1);
 const team=await f.store.unscheduled(manager,'visit','team');assert.equal(team.totalCount,4);assert.equal(team.pendingCount,2);
});
