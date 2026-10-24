import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createSeed } from '../app/lib/seed.ts';
import { salesMutationEvents } from '../app/lib/sales-report-domain.ts';
import { persistSalesWorkspace, createSalesReportStore } from '../app/lib/sales-report-store.ts';
import { createSalesReportService } from '../app/lib/sales-report-service.ts';

const at='2026-10-24T10:30:00.000Z';
function fixture(){
  const sqlite=new DatabaseSync(':memory:');for(const name of readdirSync(new URL('../drizzle/',import.meta.url)).filter(name=>name.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(`../drizzle/${name}`,import.meta.url),'utf8'));
  let onRead:(sql:string)=>void=()=>{};
  const db={prepare(sql:string){let values:unknown[]=[];return {bind(...items:unknown[]){values=items;return this;},async first(){onRead(sql);return sqlite.prepare(sql).get(...values as never[])??null;},async all(){onRead(sql);return {results:sqlite.prepare(sql).all(...values as never[]),success:true};},async run(){const result=sqlite.prepare(sql).run(...values as never[]);return {meta:{changes:Number(result.changes)},success:true};}};},async batch(items:{run:()=>Promise<unknown>}[]){sqlite.exec('BEGIN');try{const results=[];for(const item of items)results.push(await item.run());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}} as unknown as D1Database;
  const state=createSeed(at);state.deals=[{...state.deals[0],id:'p1',dataOrigin:'manual',notes:[],amount:1000,outcome:'open'}];
  const insert=(owner='alice')=>sqlite.prepare('INSERT INTO workbench_workspaces(user_id,state_json,revision,created_at,updated_at) VALUES(?,?,?,?,?)').run(owner,JSON.stringify(state),state.revision,at,at);insert();
  return {sqlite,db,state,insert,store:createSalesReportStore(db),onRead:(callback:(sql:string)=>void)=>{onRead=callback;}};
}
test('workspace CAS and real events commit atomically; stale and replayed saves cannot append events',async t=>{
  const f=fixture();t.after(()=>f.sqlite.close());const after=structuredClone(f.state);after.revision++;after.deals[0].version++;after.deals[0].stage='合同';const events=salesMutationEvents(f.state,after,'deal_stage',{dealId:'p1'},at);
  await persistSalesWorkspace(f.db,'alice',1,after,events);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM workbench_sales_events').get()?.n,1);
  await assert.rejects(persistSalesWorkspace(f.db,'alice',1,after,[{...events[0],id:'rogue'}]),{status:409});assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM workbench_sales_events').get()?.n,1);
  const page=await f.store.events('alice','2026-10-24',at);assert.equal(page.counts.stage,1);assert.equal((await f.store.events('bob','2026-10-24',at)).events.length,0);
});
test('daily generation is account scoped and date idempotent; missing model remains factual and retry succeeds',async t=>{
  const f=fixture();t.after(()=>f.sqlite.close());const after=structuredClone(f.state);after.revision++;after.deals[0].notes=[{id:'n1',text:'请确认交付日期',date:at,author:'林晓'}];after.deals[0].version++;await persistSalesWorkspace(f.db,'alice',1,after,salesMutationEvents(f.state,after,'deal_note',{dealId:'p1'},at));
  let enabled=false;let calls=0;const service=createSalesReportService(f.db,{now:()=>at,modelFor:async()=>enabled?{key:'synthetic',url:'https://model.invalid',name:'test'}:null,generateText:async(_model,messages)=>{calls++;const context=JSON.parse(messages[1].content);return JSON.stringify({summary:'交付事项待确认',observations:[{text:'核对客户交付日期',evidenceIds:[context.evidence[0].id]}]});}});
  const first=await service.generate('alice','2026-10-24');assert.equal(first.report.status,'waiting_config');assert.equal(first.report.mode,'facts');assert.equal(first.report.snapshot.metrics.followups,1);assert.equal(calls,0);
  assert.equal((await service.generate('alice','2026-10-24')).report.version,first.report.version);
  enabled=true;const retried=await service.generate('alice','2026-10-24','retry');assert.equal(retried.report.status,'completed');assert.equal(retried.report.mode,'model');assert.equal(calls,1);
  assert.equal((await service.generate('alice','2026-10-24')).report.version,retried.report.version);assert.equal(calls,1);assert.equal((await service.list('bob','2026-10-24')).report,null);
});
test('empty days are truthful completed fact reports, and dispatcher account enumeration is bounded',async t=>{
  const f=fixture();t.after(()=>f.sqlite.close());for(let i=0;i<6;i++)f.insert(`user-${i}`);
  const service=createSalesReportService(f.db,{now:()=>at,modelFor:async()=>null});const result=await service.generate('alice','2026-10-24');assert.equal(result.report.status,'completed');assert.equal(result.report.mode,'facts');assert.equal(result.report.snapshot.metrics.newProjects,0);
  const dispatched=await service.dispatch();assert.equal(dispatched.processed,5);assert.equal(dispatched.hasMore,true);assert.equal(dispatched.readback.verified,5);assert.equal(dispatched.readback.statuses.completed,5);assert.ok(dispatched.nextCursor);const next=await service.dispatch(dispatched.nextCursor);assert.equal(next.processed,2);assert.equal(next.hasMore,false);
});
test('provider failure saves a retryable factual report, and a stale lease cannot overwrite a completed report',async t=>{
  const f=fixture();t.after(()=>f.sqlite.close());const after=structuredClone(f.state);after.revision++;after.deals[0].version++;after.deals[0].stage='合同';await persistSalesWorkspace(f.db,'alice',1,after,salesMutationEvents(f.state,after,'deal_stage',{dealId:'p1'},at));
  const service=createSalesReportService(f.db,{now:()=>at,modelFor:async()=>({key:'synthetic',url:'https://model.invalid',name:'test'}),generateText:async()=>{throw new Error('credential must not surface');}});
  const failed=await service.generate('alice','2026-10-24');assert.equal(failed.report.status,'failed');assert.ok(!JSON.stringify(failed.report).includes('credential'));
  await assert.rejects(f.store.finish('alice','2026-10-24','wrong-token',{...failed.report,status:'completed'}),{status:409});
});

test('a workspace edit during source capture is reloaded before freezing the report',async t=>{
  const f=fixture();t.after(()=>f.sqlite.close());let changed=false;f.onRead(sql=>{if(!changed&&sql.startsWith('SELECT data_json FROM workbench_sales_events')){changed=true;const next=structuredClone(f.state);next.revision=2;next.deals[0].stage='合同';next.deals[0].version=2;f.sqlite.prepare('UPDATE workbench_workspaces SET revision=2,state_json=? WHERE user_id=?').run(JSON.stringify(next),'alice');}});
  const result=await createSalesReportService(f.db,{now:()=>at,modelFor:async()=>null}).generate('alice','2026-10-24');assert.equal(result.report.snapshot.sourceRevision,2);assert.equal(result.report.snapshot.priorities[0].stage,'合同');assert.match(result.report.sourceHash,/^[a-f0-9]{64}$/);
});

test('concurrent date requests hold one generation lease and frozen retry inputs survive later project edits',async t=>{
  const f=fixture();t.after(()=>f.sqlite.close());const next=structuredClone(f.state);next.revision++;next.deals[0].version++;next.deals[0].stage='合同';await persistSalesWorkspace(f.db,'alice',1,next,salesMutationEvents(f.state,next,'deal_stage',{},at));
  let release:()=>void=()=>{};const barrier=new Promise<void>(resolve=>{release=resolve;});let calls=0;const service=createSalesReportService(f.db,{now:()=>at,modelFor:async()=>({key:'synthetic',url:'https://model.invalid',name:'test'}),generateText:async()=>{calls++;await barrier;return JSON.stringify({summary:'阶段记录已更新',observations:[]});}});
  const first=service.generate('alice','2026-10-24');await new Promise(resolve=>setTimeout(resolve,5));const second=await service.generate('alice','2026-10-24');assert.equal(second.report.status,'running');release();const completed=await first;assert.equal(completed.report.status,'completed');assert.equal(calls,1);
  const originalHash=completed.report.sourceHash;const newer=structuredClone(next);newer.revision++;newer.deals[0].amount=9000;newer.deals[0].version++;await persistSalesWorkspace(f.db,'alice',2,newer,salesMutationEvents(next,newer,'deal_update',{},at));assert.equal((await service.generate('alice','2026-10-24','retry')).report.sourceHash,originalHash);assert.equal((await service.generate('alice','2026-10-24','regenerate')).report.snapshot.metrics.openAmount,9000);
});

test('event insertion failure rolls back the workspace CAS and coverage together',async t=>{
  const f=fixture();t.after(()=>f.sqlite.close());f.sqlite.exec("CREATE TRIGGER reject_sales_event BEFORE INSERT ON workbench_sales_events BEGIN SELECT RAISE(ABORT,'synthetic event failure'); END;");const next=structuredClone(f.state);next.revision++;next.deals[0].version++;next.deals[0].stage='合同';await assert.rejects(persistSalesWorkspace(f.db,'alice',1,next,salesMutationEvents(f.state,next,'deal_stage',{},at)));assert.equal(f.sqlite.prepare('SELECT revision FROM workbench_workspaces WHERE user_id=?').get('alice')?.revision,1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM workbench_sales_coverage').get()?.n,0);
});

test('expired running reports expose a retry action and can be reclaimed without accepting a stale worker',async t=>{
  const f=fixture();t.after(()=>f.sqlite.close());const service=createSalesReportService(f.db,{now:()=>at,modelFor:async()=>null});const result=await service.generate('alice','2026-10-24');
  f.sqlite.prepare("UPDATE workbench_sales_reports SET status='running',lease_token='abandoned',lease_until='2026-10-24T09:00:00.000Z' WHERE user_id=?").run('alice');
  assert.equal((await service.list('alice','2026-10-24')).report?.retryable,true);
  const retry=await service.generate('alice','2026-10-24','retry');assert.equal(retry.report.status,'completed');assert.equal(retry.report.version,result.report.version+1);
  await assert.rejects(f.store.finish('alice','2026-10-24','abandoned',{...result.report,status:'completed'}),{status:409});
});
