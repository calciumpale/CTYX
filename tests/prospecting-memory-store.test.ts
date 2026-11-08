import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createProspectMemoryStore} from '../app/lib/prospecting-memory-store.ts';
function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 for(const file of readdirSync(new URL('../drizzle/',import.meta.url)).filter(x=>x.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(`../drizzle/${file}`,import.meta.url),'utf8'));
 let queue:Promise<unknown>=Promise.resolve();
 const db={prepare(sql:string){let values:unknown[]=[];return{bind(...args:unknown[]){values=args;return this;},async first(){return sqlite.prepare(sql).get(...values as never[])??null;},async all(){return{results:sqlite.prepare(sql).all(...values as never[])};},async run(){return{meta:{changes:Number(sqlite.prepare(sql).run(...values as never[]).changes)}};}};},batch(items:{run:()=>Promise<unknown>}[]){const run=async()=>{sqlite.exec('BEGIN');try{const out=[];for(const i of items)out.push(await i.run());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}};const result=queue.then(run,run);queue=result.catch(()=>{});return result;}} as unknown as D1Database;
 sqlite.exec(`INSERT INTO workbench_member_accounts VALUES ('m','o','login','Member','sales',NULL,1,'salt','hash',100000,'now','now');
 INSERT INTO workbench_prospect_campaigns VALUES ('a','o','m','active','{}','now','now'),('b','o','m','active','{}','now','now');
 INSERT INTO workbench_prospect_conversations (id,owner_id,member_id,campaign_id,lead_id,sender_id,recipient_id,profile_url,nickname,mode,status,version,opened_at,last_message_at,memory_json,updated_at) VALUES ('physical','o','m','a','lead','sender','recipient','','Customer','human','active',1,'now','now','{"contactDeclines":1,"contactAsks":2}','now');`);
 sqlite.exec("UPDATE workbench_prospect_conversations SET last_read_at='2026-11-08T00:00:00Z'");
 const store=createProspectMemoryStore(db,()=>Date.parse('2026-11-08T00:00:00Z'));
 return{sqlite,db,store};
}
test('legacy physical identity survives lazy concurrent session creation and task switch preserves human lock',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const [a,again]=await Promise.all([f.store.getView('o','m','physical'),f.store.getView('o','m','physical')]);
 assert.equal(a.sessionId,again.sessionId);assert.equal(a.threadId,'physical');
 const b=await f.store.switchTask('o','m','physical','b',a.threadVersion,a.bindingVersion);
 assert.notEqual(a.sessionId,b.sessionId);assert.equal(b.isActive,true);
 assert.equal(f.sqlite.prepare('SELECT mode FROM workbench_prospect_conversations').get()?.mode,'human');
 assert.equal(f.sqlite.prepare('SELECT last_snapshot_id FROM workbench_prospect_conversations').get()?.last_snapshot_id,null);
 assert.equal((await f.store.messages('o','m',b.sessionId)).length,0);
});
function insert(f:ReturnType<typeof fixture>,id:string,text='预算8000元/月',direction='inbound',status='received'){
 f.sqlite.prepare(`INSERT INTO workbench_prospect_messages (id,conversation_id,owner_id,member_id,source_key,direction,actor,text,status,created_at) VALUES (?,'physical','o','m',?,?,?, ?,?,'2026-11-08T00:00:00Z')`).run(id,id,direction,direction==='inbound'?'customer':'agent',text,status);
}
test('attribution obeys active binding and reliable guard; A and B model history stays isolated',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());insert(f,'old');const a=await f.store.getView('o','m','physical');
 assert.deepEqual((await f.store.messages('o','m',a.sessionId)).map(m=>m.id),['old']);
 const b=await f.store.switchTask('o','m','physical','b',a.threadVersion,a.bindingVersion);insert(f,'new');
 await f.store.attributeMessage('new',a).run();assert.equal((await f.store.messages('o','m',b.sessionId)).length,0);
 await f.store.attributeMessage('new',b,'?=1',[0]).run();assert.equal((await f.store.messages('o','m',b.sessionId)).length,0);
 await f.store.attributeMessage('new',b,'?=1',[1],{freshAfterBaselineGuard:'?=1',values:[1]}).run();assert.deepEqual((await f.store.messages('o','m',b.sessionId)).map(m=>m.id),['new']);
 assert.deepEqual((await f.store.messages('o','m',a.sessionId)).map(m=>m.id),['old']);
 await assert.rejects(f.store.getView('o','other','physical'),/无权|停用/);
});
test('legacy refusal, invitation budget and capture stay only in the original task',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());f.sqlite.exec(`INSERT INTO workbench_prospect_lead_pool VALUES ('cap','o','physical','key','phone','13812345678','Customer',1,'low','',NULL,NULL,'new','now','now')`);
 const a=await f.store.getView('o','m','physical');assert.equal(a.state.contact.declined,true);assert.equal(a.state.contact.legacyInvites,2);assert.equal(a.state.contact.captured,true);
 const b=await f.store.switchTask('o','m','physical','b',a.threadVersion,a.bindingVersion);assert.equal(b.state.contact.captured,false);assert.equal(b.state.contact.declined,false);assert.equal(b.state.contact.legacyInvites,0);
 assert.deepEqual(f.sqlite.prepare('SELECT session_id FROM workbench_prospect_memory_captures').all().map(r=>r.session_id),[a.sessionId]);
});
test('new source and concurrent extraction defeat stale CAS; extraction failures leave watermark pending',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const a=await f.store.getView('o','m','physical');insert(f,'one');await f.store.attributeMessage('one',a).run();
 assert.equal(await f.store.saveState('o','m',a,a.state),false);
 await assert.rejects(f.store.absorb('o','m','physical',async()=>{throw new Error('offline');}),/offline/);
 assert.equal((await f.store.getView('o','m','physical')).state.sourceWatermark,0);
 const fresh=await f.store.getView('o','m','physical');const state={...fresh.state,sourceWatermark:fresh.sourceWatermark};
 const won=await Promise.all([f.store.saveState('o','m',fresh,state),f.store.saveState('o','m',fresh,state)]);assert.equal(won.filter(Boolean).length,1);
});
test('running and unknown sends block switch without changing campaign or snapshot',async t=>{
 for(const status of ['running','unknown']){
 const f=fixture();t.after(()=>f.sqlite.close());const a=await f.store.getView('o','m','physical');
 f.sqlite.prepare(`INSERT INTO workbench_prospect_jobs (id,owner_id,member_id,device_id,campaign_id,kind,status,input_json,sender_id,created_at,updated_at) VALUES ('job','o','m','dev','a','reply',?,'{"conversationId":"physical","recipientId":"recipient"}','sender','now','now')`).run(status);
 await assert.rejects(f.store.switchTask('o','m','physical','b',a.threadVersion,a.bindingVersion),/更新/);assert.equal(f.sqlite.prepare('SELECT campaign_id FROM workbench_prospect_conversations').get()?.campaign_id,'a');
 }
});
test('absorption processes forty sources at a time independently of reply eligibility',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());for(let i=0;i<90;i++)insert(f,`old-${i}`);
 await f.store.absorb('o','m','physical',async(s,m)=>{assert.ok(m.length<=40);return s;});
 assert.equal((await f.store.getView('o','m','physical')).state.sourceWatermark,40);
 await f.store.absorb('o','m','physical',async(s,m)=>{assert.equal(m.length,40);return s;});
 assert.equal((await f.store.getView('o','m','physical')).state.sourceWatermark,80);
 assert.equal(f.sqlite.prepare('SELECT SUM(eligible)+SUM(processed) AS n FROM workbench_prospect_messages').get()?.n,0);
});
test('outbound status changes invalidate an extraction snapshot even without new message rows',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());insert(f,'out','方便留一个可联系到您的方式吗？','outbound','queued');
 f.sqlite.exec(`INSERT INTO workbench_prospect_jobs (id,owner_id,member_id,device_id,campaign_id,kind,status,input_json,sender_id,created_at,updated_at) VALUES ('job','o','m','dev','a','reply','queued','{"conversationId":"physical","recipientId":"recipient","actor":"agent"}','sender','now','now'); UPDATE workbench_prospect_messages SET job_id='job' WHERE id='out';`);
 const view=await f.store.getView('o','m','physical');f.sqlite.exec("UPDATE workbench_prospect_jobs SET status='done',result_json='{\"outcome\":\"submitted\"}' WHERE id='job'");
 assert.equal(await f.store.saveState('o','m',view,view.state),false);
});
test('empty absorption is idempotent and does not invalidate generation versions',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const a=await f.store.getView('o','m','physical');
 assert.equal(await f.store.absorb('o','m','physical'),false);assert.equal((await f.store.getView('o','m','physical')).sessionVersion,a.sessionVersion);
});
test('unmapped legacy sources keep readiness false until complete bounded backfill and absorption',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());for(let i=0;i<90;i++)insert(f,`legacy-${i}`);
 const a=await f.store.getView('o','m','physical');const consumed={...a.state,sourceWatermark:a.sourceWatermark};await f.store.saveState('o','m',a,consumed);
 // This read maps only another forty; at least ten remain outside mappedMAX.
 const b=await f.store.getView('o','m','physical');await f.store.saveState('o','m',b,{...b.state,sourceWatermark:b.sourceWatermark});
 const row=f.sqlite.prepare('SELECT state_json FROM workbench_prospect_memory_sessions WHERE id=?').get(a.sessionId)!;assert.ok(JSON.parse(row.state_json as string).sourceWatermark<90);
 assert.equal(b.ready,false);
});
test('trusted local absorption recognizes contact in human mode while context hides plaintext',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());insert(f,'phone','我的手机号13812345678');
 await f.store.absorb('o','m','physical');const a=await f.store.getView('o','m','physical');assert.equal(a.state.contact.captured,true);
 assert.ok(!(await f.store.messages('o','m',a.sessionId))[0].text.includes('13812345678'));
});
test('semantic failure keeps watermark and readiness pending',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());insert(f,'semantic','希望安静一些');
 await f.store.absorb('o','m','physical',async state=>({...state,pendingSourceIds:['semantic']}));
 const a=await f.store.getView('o','m','physical');assert.equal(a.state.sourceWatermark,0);assert.equal(a.ready,false);
});
test('ignore persists suppression and audit, cancels old queued jobs, and does not relearn source',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());insert(f,'budget');await f.store.absorb('o','m','physical');const a=await f.store.getView('o','m','physical');assert.ok(a.state.facts.length);
 f.sqlite.exec(`INSERT INTO workbench_prospect_jobs (id,owner_id,member_id,device_id,campaign_id,kind,status,input_json,sender_id,created_at,updated_at) VALUES ('job','o','m','dev','a','reply','queued','{"conversationId":"physical","recipientId":"recipient"}','sender','now','now')`);
 const edited=await f.store.mutate('o','m','physical','a',a.sessionVersion,a.bindingVersion,{factId:a.state.facts[0].id,operation:'ignore',actorId:'m',now:'now'});
 assert.ok(edited.state.ignoredSourceIds.includes('budget'));assert.equal((await f.store.messages('o','m',a.sessionId)).length,0);assert.equal(f.sqlite.prepare("SELECT status FROM workbench_prospect_jobs WHERE id='job'").get()?.status,'cancelled');
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM workbench_prospect_memory_events WHERE session_id=? AND json_extract(data_json,'$.type')='human_edit'").get(a.sessionId)?.n,1);
 assert.ok(edited.threadVersion>a.threadVersion);await f.store.absorb('o','m','physical');assert.ok((await f.store.getView('o','m','physical')).state.facts.every(x=>x.status!=='confirmed'));
});
test('inactive task edit does not cancel the active task queue',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());insert(f,'budget');await f.store.absorb('o','m','physical');const a=await f.store.getView('o','m','physical');const b=await f.store.switchTask('o','m','physical','b',a.threadVersion,a.bindingVersion);
 f.sqlite.exec(`INSERT INTO workbench_prospect_jobs (id,owner_id,member_id,device_id,campaign_id,kind,status,input_json,sender_id,created_at,updated_at) VALUES ('job','o','m','dev','b','reply','queued','{"conversationId":"physical","recipientId":"recipient"}','sender','now','now')`);
 const old=await f.store.getView('o','m','physical','a');await f.store.mutate('o','m','physical','a',old.sessionVersion,old.bindingVersion,{factId:old.state.facts[0].id,operation:'retract',actorId:'m',now:'now'});
 assert.equal(f.sqlite.prepare("SELECT status FROM workbench_prospect_jobs WHERE id='job'").get()?.status,'queued');assert.equal((await f.store.getView('o','m','physical')).threadVersion,b.threadVersion);
});
test('late reliable attribution below consumed row watermark is absorbed exactly once',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const a=await f.store.getView('o','m','physical');insert(f,'late','预算8000元/月');insert(f,'first','你好');await f.store.attributeMessage('first',a).run();await f.store.absorb('o','m','physical');const old=await f.store.getView('o','m','physical');assert.equal(old.state.sourceWatermark,2);
 await f.store.attributeMessage('late',old).run();await f.store.absorb('o','m','physical');const next=await f.store.getView('o','m','physical');assert.ok(next.state.facts.some(x=>x.sourceMessageId==='late'));assert.equal(next.state.sourceWatermark,2);assert.equal(await f.store.absorb('o','m','physical'),false);
});
test('late semantic failure below watermark retries its source and recovers',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const a=await f.store.getView('o','m','physical');insert(f,'semantic-late','希望安静一些');insert(f,'current','你好');await f.store.attributeMessage('current',a).run();await f.store.absorb('o','m','physical');
 const v=await f.store.getView('o','m','physical');await f.store.attributeMessage('semantic-late',v).run();
 await f.store.absorb('o','m','physical',async(s,ms)=>({...s,pendingSourceIds:ms.map(m=>m.id)}));
 let seen:string[]=[];await f.store.absorb('o','m','physical',async(s,ms)=>{seen=ms.map(m=>m.id);return{...s,pendingSourceIds:[]};});assert.ok(seen.includes('semantic-late'));assert.equal((await f.store.getView('o','m','physical')).ready,true);
});
test('legacy invitation evidence does not charge imported budget twice or refund old uncertainty',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());insert(f,'legacy-invite','方便留一个可联系到您的方式吗？','outbound','sent');await f.store.absorb('o','m','physical');const a=await f.store.getView('o','m','physical');
 const {projectTaskMemory}=await import('../app/lib/prospecting-memory.ts');assert.equal(a.state.contact.submittedInvites,1);assert.equal(projectTaskMemory(a.state).contactAsks,2);
 f.sqlite.exec("UPDATE workbench_prospect_messages SET status='unknown' WHERE id='legacy-invite'");await f.store.absorb('o','m','physical');assert.equal(projectTaskMemory((await f.store.getView('o','m','physical')).state).contactAsks,2);
 insert(f,'new-invite','方便留一个可联系到您的方式吗？','outbound','sent');await f.store.attributeMessage('new-invite',await f.store.getView('o','m','physical')).run();await f.store.absorb('o','m','physical');assert.equal(projectTaskMemory((await f.store.getView('o','m','physical')).state).contactAsks,3);
});
test('switch attribution rejects old unassigned and newly observed old transcript rows',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const a=await f.store.getView('o','m','physical');insert(f,'unassigned-old');const b=await f.store.switchTask('o','m','physical','b',a.threadVersion,a.bindingVersion);
 await f.store.attributeMessage('unassigned-old',b).run();await f.store.attributeMessage('unassigned-old',b,'1',[],{freshAfterBaselineGuard:'1'}).run();assert.equal((await f.store.messages('o','m',b.sessionId)).length,0);
 insert(f,'discovered-old');f.sqlite.exec("UPDATE workbench_prospect_messages SET posted_at='2026-11-07T00:00:00Z' WHERE id='discovered-old'");await f.store.attributeMessage('discovered-old',b).run();assert.equal((await f.store.messages('o','m',b.sessionId)).length,0);
 insert(f,'fresh-proven');f.sqlite.exec("UPDATE workbench_prospect_messages SET posted_at='2026-11-08T00:01:00Z' WHERE id='fresh-proven'");await f.store.attributeMessage('fresh-proven',b).run();assert.deepEqual((await f.store.messages('o','m',b.sessionId)).map(m=>m.id),['fresh-proven']);
});
