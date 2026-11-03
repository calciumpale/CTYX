import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createMeetingStore} from '../app/lib/meeting-import-store.ts';
import {assertMeetingProject,validateMeetingRecord,validateMeetingSource} from '../app/lib/meeting-import-validation.ts';
import {createSeed} from '../app/lib/seed.ts';
import type {MeetingImport} from '../app/lib/meeting-import-types.ts';

function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 for(const file of readdirSync(new URL('../drizzle/',import.meta.url)).filter(x=>x.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(`../drizzle/${file}`,import.meta.url),'utf8'));
 sqlite.exec("INSERT INTO workbench_member_accounts VALUES ('sales-a','owner-a','sales','销售','sales','sales-1',1,'salt','hash',100000,'now','now'),('sales-b','owner-b','sales','销售','sales','sales-2',1,'salt','hash',100000,'now','now')");
 const db={prepare(sql:string){let values:unknown[]=[];return{bind(...args:unknown[]){values=args;return this;},async first(){return sqlite.prepare(sql).get(...values as never[])??null;},async all(){return{results:sqlite.prepare(sql).all(...values as never[])};},async run(){return{meta:{changes:Number(sqlite.prepare(sql).run(...values as never[]).changes)}};}};},async batch(items:{run:()=>Promise<unknown>}[]){sqlite.exec('BEGIN');try{const out=[];for(const x of items)out.push(await x.run());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}}} as unknown as D1Database;
 let time=Date.parse('2026-11-04T02:00:00Z');
 return{sqlite,store:createMeetingStore(db,()=>time),advance:(ms:number)=>{time+=ms;}};
}
const record={key:'f1',meetingRecordId:'r1',recordFileId:'f1',subject:'需求沟通',state:'ready',kind:'audio' as const};

test('device credentials are hashed and bound to an enabled business member',async(t)=>{
 const f=fixture();t.after(()=>f.sqlite.close());const device=await f.store.createDevice('owner-a','sales-a','这台Mac');
 assert.ok(device.token);const row=f.sqlite.prepare('SELECT * FROM workbench_meeting_devices').get();assert.notEqual(row?.token_hash,device.token);
 assert.equal((await f.store.authenticate(device.id,device.token)).ownerId,'owner-a');
 await assert.rejects(f.store.authenticate(device.id,'bad'),{status:401});
 await assert.rejects(f.store.createDevice('owner-a','sales-b','跨租户'),{status:403});
 f.sqlite.exec("UPDATE workbench_member_accounts SET enabled=0 WHERE account_id='sales-a'");
 await assert.rejects(f.store.authenticate(device.id,device.token),{status:401});
});

test('claim is atomic, account-scoped, and old leases cannot commit after reclaim',async(t)=>{
 const f=fixture();t.after(()=>f.sqlite.close());const d=await f.store.createDevice('owner-a','sales-a','Mac');
 await f.store.createJob('owner-a','sales-a',d.id,'search',{});
 const claims=await Promise.all([f.store.claim(d.id),f.store.claim(d.id)]);const first=claims.find(Boolean)!;assert.equal(claims.filter(Boolean).length,1);
 assert.equal((await f.store.jobs('owner-b','sales-b')).length,0);
 f.advance(181000);const next=await f.store.claim(d.id);assert.ok(next);assert.notEqual(next.leaseToken,first.leaseToken);
 await assert.rejects(f.store.complete(d.id,first.id,first.leaseToken,{records:[]}),{status:409});
 await f.store.complete(d.id,next!.id,next!.leaseToken,{records:[record]});
 assert.equal((await f.store.jobs('owner-a','sales-a'))[0].status,'done');
 await assert.rejects(f.store.complete(d.id,next!.id,next!.leaseToken,{records:[]}),{status:409});
});

test('queued import requests deduplicate and a same source snapshot is stored once',async(t)=>{
 const f=fixture();t.after(()=>f.sqlite.close());const d=await f.store.createDevice('owner-a','sales-a','Mac');
 const a=await f.store.createJob('owner-a','sales-a',d.id,'import',{record,dealId:'deal-1',includeAudio:true},'deal-1');
 const b=await f.store.createJob('owner-a','sales-a',d.id,'import',{record,dealId:'deal-1',includeAudio:true},'deal-1');assert.equal(a.id,b.id);
 const imported={id:'source-1',dealId:'deal-1',record,createdAt:'2026-11-04T02:00:00Z',createdBy:'销售',sourceHash:'hash',minutes:'纪要',transcript:'原文',complete:true,warnings:[],analysis:{status:'pending',summary:'',companies:[],people:[],nextSteps:[]}} as MeetingImport;
 const lease=(await f.store.claim(d.id))!;
 await f.store.insertImport('owner-a','sales-a',d.id,lease.id,lease.leaseToken,imported);
 await f.store.insertImport('owner-a','sales-a',d.id,lease.id,lease.leaseToken,imported);
 assert.equal((await f.store.imports('owner-a',['deal-1'])).length,1);
 assert.equal((await f.store.imports('owner-b',['deal-1'])).length,0);
 await assert.rejects(f.store.insertImport('owner-b','sales-b',d.id,lease.id,lease.leaseToken,imported),{status:403});
});

test('project ownership and source formats fail closed without overwriting client data',()=>{
 const state=createSeed('2026-11-04T02:00:00Z');const deal=state.deals[0];
 assert.throws(()=>assertMeetingProject(state,{accountId:'a',role:'admin',username:'admin',displayName:'管理员'},deal.id),{status:403});
 assert.throws(()=>assertMeetingProject(state,{accountId:'a',role:'sales',username:'s',displayName:'s',salesId:'other'},deal.id),{status:403});
 assert.equal(assertMeetingProject(state,{accountId:'a',role:'manager',username:'m',displayName:'m'},deal.id).id,deal.id);
 assert.throws(()=>validateMeetingRecord({...record,recordFileId:'--help'}));
 assert.throws(()=>validateMeetingSource({minutes:'',transcript:'',complete:true,warnings:[]}));
 const partial=validateMeetingSource({minutes:'仅纪要',transcript:'',complete:false,warnings:['无转写']});assert.equal(partial.transcript,'');assert.equal(partial.complete,false);
});

test('first setup is consumed atomically even when two installations race',async(t)=>{
 const f=fixture();t.after(()=>f.sqlite.close());
 const results=await Promise.allSettled([f.store.createDevice('owner-a','sales-a','Mac',true),f.store.createDevice('owner-a','sales-a','Mac',true)]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM workbench_meeting_devices').get()?.n,1);
});

test('retrying an identical source can attach newly available audio without replacing its analysis',async(t)=>{
 const f=fixture();t.after(()=>f.sqlite.close());const d=await f.store.createDevice('owner-a','sales-a','Mac');
 await f.store.createJob('owner-a','sales-a',d.id,'import',{record,dealId:'deal-1'},'deal-1');const lease=(await f.store.claim(d.id))!;
 const imported={id:'source-1',dealId:'deal-1',record,createdAt:'2026-11-04T02:00:00Z',createdBy:'销售',sourceHash:'hash',minutes:'纪要',transcript:'原文',complete:true,warnings:['录音暂未取得'],analysis:{status:'ready',summary:'已分析',companies:[],people:[],nextSteps:[]}} as MeetingImport;
 await f.store.insertImport('owner-a','sales-a',d.id,lease.id,lease.leaseToken,imported);
 const retry={...imported,warnings:[],analysis:{...imported.analysis,status:'pending' as const},media:{id:'audio-1',name:'音频.m4a',contentType:'audio/mp4',size:10}};
 const merged=await f.store.insertImport('owner-a','sales-a',d.id,lease.id,lease.leaseToken,retry);
 assert.equal(merged.media?.id,'audio-1');assert.equal(merged.analysis.status,'ready');assert.deepEqual(merged.warnings,[]);
 await f.store.updateAnalysis('owner-a','source-1','hash',{...imported.analysis,summary:'重新分析'});assert.equal((await f.store.getImport('owner-a','source-1'))?.media?.id,'audio-1');
});

test('upload retries reuse the first task audio receipt instead of orphaning its object',async(t)=>{
 const f=fixture();t.after(()=>f.sqlite.close());const d=await f.store.createDevice('owner-a','sales-a','Mac');
 await f.store.createJob('owner-a','sales-a',d.id,'import',{record,dealId:'deal-1'},'deal-1');const lease=(await f.store.claim(d.id))!;
 const media={id:'audio-1',name:'音频.m4a',contentType:'audio/mp4',size:10};
 assert.equal((await f.store.saveMedia(d.id,lease.id,lease.leaseToken,media)).id,'audio-1');
 assert.equal((await f.store.saveMedia(d.id,lease.id,lease.leaseToken,{...media,id:'audio-2'})).id,'audio-1');
});
