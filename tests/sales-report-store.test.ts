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

for (const origin of ['imported','converted'] as const) test(`${origin} public prospect counts only subsequent saved human evidence, with CAS and owner isolation`,async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());
 let initial=structuredClone(f.state);
 if(origin==='imported'){
  const {departmentState}=await import('../app/lib/workspace-departments.ts');
  const dataset=JSON.parse(readFileSync(new URL('../data/prospect-companies/2026-11-08.json',import.meta.url),'utf8'));
  initial=await departmentState(initial,dataset);
 }else{
  const {createWebProspectStore}=await import('../app/lib/web-prospect-store.ts');const web=createWebProspectStore(f.db);
  f.sqlite.prepare('INSERT INTO workbench_member_accounts(account_id,owner_id,username,display_name,role,sales_id,enabled,password_salt,password_hash,password_iterations,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('member','alice','zs','ZS','sales','sales-1',1,'salt','hash',1,at,at);
  const task={id:'task',ownerId:'alice',memberId:'member',requestId:'req',payloadHash:'hash',status:'running' as const,createdAt:at,updatedAt:at,keywords:['企业'],region:'',platform:'all' as const,resultCount:0,errors:[]};await web.insert(task);
  await web.finish({...task,status:'completed'},[{id:'lead',ownerId:'alice',memberId:'member',taskId:'task',version:1,status:'new',sourceUrl:'https://example.com/public',title:'公开资料',excerpt:'待核实',platform:'other',query:'企业',region:'',regionMatch:'unverified',regionEvidence:'',retrievedAt:at}]);await web.review('alice','member','lead',1,'qualified');await web.convert(await web.getLead('alice','member','lead'),'合成企业','合成项目','sales-1');initial=await f.store.workspace('alice');
 }
 assert.deepEqual(salesMutationEvents(f.state,initial,'setup',{},at),[]);
 const prospect=initial.deals.find(d=>d.dataOrigin==='research')!;initial.deals=[prospect];
 f.sqlite.prepare('UPDATE workbench_workspaces SET state_json=?,revision=? WHERE user_id=?').run(JSON.stringify(initial),initial.revision,'alice');
 const service=createSalesReportService(f.db,{now:()=>at,modelFor:async()=>null});
 f.sqlite.prepare('INSERT INTO workbench_approval_requests(id,owner_id,project_id,kind,status,version,created_at,updated_at,data_json) VALUES(?,?,?,?,?,?,?,?,?)').run('approval','alice',prospect.id,'discount','pending',1,at,at,'{}');
 assert.equal(await f.store.pendingApprovals('alice'),0);
 assert.equal((await service.generate('alice','2026-10-24')).report.snapshot.metrics.openProjects,0);
 const {executeAction}=await import('../app/lib/domain.ts');const scope={salesId:prospect.ownerId,displayName:prospect.owner};
 await assert.rejects(executeAction(initial,'sales','deal_note',{dealId:prospect.id,text:'不能越权'},{now:at,salesScope:{salesId:'other',displayName:'other'}}),{status:403});
 const follow=(await executeAction(initial,'sales','deal_note',{dealId:prospect.id,text:'实际沟通：确认下一次交流日期'},{now:at,salesScope:scope})).state;
 const events=salesMutationEvents(initial,follow,'deal_note',{},at);assert.equal(events.length,1);assert.equal(events[0].kind,'followup');
 await persistSalesWorkspace(f.db,'alice',initial.revision,follow,events);assert.equal(await f.store.pendingApprovals('alice'),1);
 await assert.rejects(persistSalesWorkspace(f.db,'alice',initial.revision,follow,events),{status:409});
 const won=(await executeAction(follow,'sales','deal_outcome',{dealId:prospect.id,version:follow.deals[0].version,outcome:'won',confirmed:true},{now:at,salesScope:scope})).state;
 await persistSalesWorkspace(f.db,'alice',follow.revision,won,salesMutationEvents(follow,won,'deal_outcome',{},at));
 assert.equal(won.deals[0].dataOrigin,'research');assert.equal(won.deals[0].companyProfile?.sources[0].url,prospect.companyProfile?.sources[0].url);
 const report=(await service.generate('alice','2026-10-24','regenerate')).report;assert.equal(report.snapshot.metrics.followups,1);assert.equal(report.snapshot.metrics.won,1);assert.equal(report.snapshot.metrics.newProjects,0);assert.equal(report.snapshot.excludedSampleProjects,0);
 assert.deepEqual(salesMutationEvents(won,won,'deal_outcome',{},at),[]);assert.equal((await f.store.events('bob','2026-10-24',at)).events.length,0);
});

test('archival removes present pipeline and approvals while preserving requested-date historical events',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const {executeAction}=await import('../app/lib/domain.ts');
 const followed=(await executeAction(f.state,'sales','deal_note',{dealId:'p1',text:'历史真实跟进'},{now:at})).state;
 await persistSalesWorkspace(f.db,'alice',1,followed,salesMutationEvents(f.state,followed,'deal_note',{},at));
 f.sqlite.prepare('INSERT INTO workbench_approval_requests(id,owner_id,project_id,kind,status,version,created_at,updated_at,data_json) VALUES(?,?,?,?,?,?,?,?,?)').run('old-approval','alice','p1','discount','pending',1,at,at,'{}');assert.equal(await f.store.pendingApprovals('alice'),1);
 const archived=structuredClone(followed);archived.revision++;archived.deals[0].archive={at,reason:'历史',migrationKey:'test'};archived.deals[0].deadline='2026-10-01T00:00:00Z';
 await persistSalesWorkspace(f.db,'alice',followed.revision,archived,[]);
 const report=(await createSalesReportService(f.db,{now:()=>at,modelFor:async()=>null}).generate('alice','2026-10-24')).report;
 assert.equal(report.snapshot.metrics.pendingApprovals,0);assert.equal(report.snapshot.metrics.followups,1);assert.equal(report.snapshot.metrics.openProjects,0);assert.equal(report.snapshot.metrics.openAmount,0);assert.equal(report.snapshot.metrics.overdue,0);assert.equal(report.snapshot.metrics.urgent,0);assert.deepEqual(report.snapshot.priorities,[]);assert.deepEqual(report.snapshot.stages,[]);assert.ok(report.snapshot.owners.every(o=>o.openProjects===0&&o.openAmount===0));assert.ok(report.snapshot.evidence.some(e=>e.text.includes('历史真实跟进')));assert.ok(report.snapshot.evidence.every(e=>e.kind!=='snapshot'));
 assert.equal((await f.store.workspace('alice')).deals[0].archive?.reason,'历史');
});

for(const action of ['deal_update','deal_stage','transcript_add'] as const)test(`first research ${action} establishes reporting eligibility without replaying old evidence`,async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const {executeAction}=await import('../app/lib/domain.ts');f.state.deals[0].dataOrigin='research';f.state.deals[0].notes=[{id:'legacy',text:'既有记录不回填',date:at,author:'ZS'}];
 f.sqlite.prepare('UPDATE workbench_workspaces SET state_json=? WHERE user_id=?').run(JSON.stringify(f.state),'alice');
 const payload=action==='deal_update'?{contact:'人工联系人'}:action==='deal_stage'?{stage:'合同',confirmed:true}:{text:'实际保存的通话转写',source:'pasted'};
 const next=(await executeAction(f.state,'sales',action,{dealId:'p1',version:f.state.deals[0].version,...payload},{now:at})).state;
 const events=salesMutationEvents(f.state,next,action,{},at);assert.equal(events.length,1);assert.equal(events[0].kind,action==='deal_update'?'update':action==='deal_stage'?'stage':'transcript');
 await persistSalesWorkspace(f.db,'alice',f.state.revision,next,events);const page=await f.store.events('alice','2026-10-24',at);assert.equal(page.events.length,1);assert.equal(next.deals[0].businessRecordedAt,at);assert.equal(next.deals[0].dataOrigin,'research');
});

test('first research meeting link persists attributed business events once and reports only the current save date',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const {linkMeetingToWorkspace}=await import('../app/lib/meeting-analysis.ts');
 f.state.deals[0].dataOrigin='research';f.state.deals[0].notes=[{id:'old-note',text:'此前已保存资料，不回填',author:'ZS',date:'2026-10-23T01:00:00Z'}];f.state.deals[0].source='公开名录';
 f.sqlite.prepare('UPDATE workbench_workspaces SET state_json=? WHERE user_id=?').run(JSON.stringify(f.state),'alice');
 const imported={id:'first-research-meeting',dealId:'p1',createdAt:'2026-10-23T02:00:00Z',createdBy:'实际关联销售',sourceHash:'a'.repeat(64),record:{key:'record',meetingRecordId:'record',recordFileId:'file',subject:'合成业务交流',state:'ready',kind:'audio' as const,startedAt:'2026-10-23T01:00:00Z'},minutes:'合成企业希望确认下一次交流时间。',transcript:'合成参会人：下一次交流时间尚待双方确认。',complete:true,warnings:[],analysis:{status:'needs_model' as const,summary:'',companies:[],people:[],nextSteps:[]}};
 const linked=linkMeetingToWorkspace(f.state,imported,at);assert.equal(linked.changed,true);
 const events=salesMutationEvents(f.state,linked.state,'transcript_add',{dealId:'p1'},at);
 assert.deepEqual(events.map(e=>e.kind).sort(),['followup','transcript']);assert.ok(events.every(e=>e.ownerId==='sales-1'&&e.occurredAt===at));assert.equal(linked.state.deals[0].businessRecordedAt,at);assert.equal(linked.state.deals[0].dataOrigin,'research');assert.equal(linked.state.deals[0].source,'公开名录');
 assert.equal(linked.state.deals[0].notes[0].author,imported.createdBy);assert.equal(linked.state.transcripts?.[0].employeeId,'sales-1');
 await persistSalesWorkspace(f.db,'alice',f.state.revision,linked.state,events);
 await assert.rejects(persistSalesWorkspace(f.db,'alice',f.state.revision,linked.state,events),{status:409});
 const latest=await f.store.workspace('alice');const retry=linkMeetingToWorkspace(latest,imported);assert.equal(retry.changed,false);assert.deepEqual(retry.state,latest);assert.deepEqual(salesMutationEvents(latest,retry.state,'transcript_add',{},at),[]);
 const page=await f.store.events('alice','2026-10-24',at);assert.equal(page.events.length,2);assert.equal(page.counts.followup,1);assert.equal(page.counts.transcript,1);assert.equal(page.counts.create??0,0);assert.equal((await f.store.events('alice','2026-10-23',at)).events.length,0);assert.equal((await f.store.events('other-owner','2026-10-24',at)).events.length,0);
 const report=(await createSalesReportService(f.db,{now:()=>at,modelFor:async()=>null}).generate('alice','2026-10-24')).report;assert.equal(report.snapshot.metrics.followups,1);assert.equal(report.snapshot.metrics.transcripts,1);assert.equal(report.snapshot.excludedSampleProjects,0);assert.equal(report.snapshot.metrics.openProjects,1);assert.ok(report.snapshot.evidence.some(e=>e.kind==='transcript'&&e.text.includes('合成参会人')));
 const legacy=structuredClone(latest);delete legacy.deals[0].businessRecordedAt;const legacyReplay=linkMeetingToWorkspace(legacy,imported);assert.equal(legacyReplay.changed,false);assert.equal(legacyReplay.state.deals[0].businessRecordedAt,undefined);assert.deepEqual(salesMutationEvents(legacy,legacyReplay.state,'transcript_add',{},at),[]);
});

test('first research recording transcript uses the same new-business boundary without backfilling its recording note',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const {linkSpeechTranscript}=await import('../app/lib/speech-transcription.ts');const recording={id:'recording-9a83c9a6-61ce-489c-bd7a-a6dba42ee69a',name:'合成录音.m4a',size:4,mimeType:'audio/mp4'};
 f.state.deals[0].dataOrigin='research';f.state.deals[0].notes=[{id:'prior-recording',text:'',author:'ZS',date:at,recording}];f.sqlite.prepare('UPDATE workbench_workspaces SET state_json=? WHERE user_id=?').run(JSON.stringify(f.state),'alice');
 const result={text:'实际保存的合成转写',rawText:'实际保存的合成转写',segments:[],speakers:[],corrections:[],model:'test',durationSeconds:3,dialectHint:'auto' as const,diarization:false,hotwordVersion:0};
 const linked=await linkSpeechTranscript(f.state,'p1',recording.id,result,at);const events=salesMutationEvents(f.state,linked.state,'transcript_add',{},at);assert.equal(events.length,1);assert.equal(events[0].kind,'transcript');assert.equal(linked.state.deals[0].businessRecordedAt,at);
 await persistSalesWorkspace(f.db,'alice',f.state.revision,linked.state,events);const latest=await f.store.workspace('alice');const retry=await linkSpeechTranscript(latest,'p1',recording.id,result,at);assert.equal(retry.changed,false);assert.deepEqual(salesMutationEvents(latest,retry.state,'transcript_add',{},at),[]);assert.equal((await f.store.events('alice','2026-10-24',at)).events.length,1);
});

test('public profile enrichment alone does not establish business eligibility or backfill existing sources',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const {executeAction}=await import('../app/lib/domain.ts');f.state.deals[0].dataOrigin='research';f.state.deals[0].notes=[{id:'old-note',text:'历史记录',author:'ZS',date:at}];
 const next=(await executeAction(f.state,'sales','deal_enrich',{dealId:'p1',version:f.state.deals[0].version},{now:at,enrichCompany:async()=>({companyName:f.state.deals[0].name,summary:'公开资料',provider:'web',status:'ready',modelUsed:false,updatedAt:at,facts:[],sources:[{id:'public-source',title:'公开名录',url:'https://example.com/public',provider:'web',retrievedAt:at,snippet:'公开资料'}],warnings:[]})})).state;
 assert.equal(next.deals[0].businessRecordedAt,undefined);assert.deepEqual(salesMutationEvents(f.state,next,'deal_enrich',{},at),[]);
});
