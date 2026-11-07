import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createProspectingStore} from '../app/lib/prospecting-store.ts';
import {createProspectingService} from '../app/lib/prospecting-service.ts';
import {normalizeCampaignInput,normalizeComments,scoreComment} from '../app/lib/prospecting-domain.ts';
import type {ProspectBridgeJob} from '../app/lib/prospecting-types.ts';

const model={key:'synthetic-only',url:'https://model.example.test/chat/completions',name:'test-model'};
const sender={authenticated:true,accountId:'MS4wPollSender001',accountName:'测试发送账号'};

function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 for(const file of readdirSync(new URL('../drizzle/',import.meta.url)).filter(name=>name.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(`../drizzle/${file}`,import.meta.url),'utf8'));
 sqlite.exec("INSERT INTO workbench_member_accounts VALUES ('member-a','owner-a','sales','销售','sales','sales-1',1,'salt','hash',100000,'now','now')");
 const hooks:{query?:(sql:string)=>void}={};
 let batches:Promise<unknown>=Promise.resolve();
 const db={
  prepare(sql:string){
   let values:unknown[]=[];
   return{
    bind(...args:unknown[]){values=args;return this;},
    async first(){hooks.query?.(sql);return sqlite.prepare(sql).get(...values as never[])??null;},
    async all(){hooks.query?.(sql);return{results:sqlite.prepare(sql).all(...values as never[])};},
    async run(){hooks.query?.(sql);return{meta:{changes:Number(sqlite.prepare(sql).run(...values as never[]).changes)}};},
   };
  },
  batch(statements:{run:()=>Promise<unknown>}[]){
   const execute=async()=>{sqlite.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}};
   const next=batches.then(execute,execute);batches=next.catch(()=>{});return next;
  },
 } as unknown as D1Database;
 const store=createProspectingStore(db);
 const service=createProspectingService({db,readModel:async()=>model});
 async function connect(){const device=await store.connect('owner-a','member-a','poll测试');await store.seen(device.deviceId,sender);return device;}
 async function campaign(suffix:string){
  const c=await store.createCampaign('owner-a','member-a',normalizeCampaignInput({requirements:`销售培训工具，面向中小企业${suffix}`,keywords:['销售培训'],reviewMode:'manual'}));
  const comment=normalizeComments([{id:`comment-${suffix}`,videoId:'7654321234567890',text:'多少钱，可以试用吗？',profileUrl:`https://www.douyin.com/user/MS4wRecipient${suffix}`}],'browser')[0];
  await store.insertComments('owner-a','member-a',c.id,[scoreComment(comment,c)]);
  return{campaign:c,lead:(await store.leads('owner-a','member-a',c.id))[0]};
 }
 function poll(device:{deviceId:string;deviceToken:string},signal?:AbortSignal,conversationVersion?:number){
  return service.bridge(new Request('https://prospecting-poll.test/api/prospecting-bridge/poll',{method:'POST',headers:{Authorization:`Bearer ${device.deviceToken}`,'Content-Type':'application/json'},body:JSON.stringify({...sender,deviceId:device.deviceId,...(conversationVersion?{conversationVersion}:{})}),signal}),'poll');
 }
 return{sqlite,store,hooks,connect,campaign,poll};
}

function modelReply(init?:RequestInit){
 const request=JSON.parse(String(init?.body)) as {messages:{role:string;content:string}[]};
 const payload=JSON.parse(request.messages.find(message=>message.role==='user')!.content) as {comments:{id:string}[]};
 const rows=payload.comments.map(comment=>({id:comment.id,intentScore:95,reason:'询问试用价格',greeting:'你好，可以进一步了解你的培训需求吗？'}));
 return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(rows)}}]});
}

test('each poll analyzes only one campaign and later polls advance the remaining campaigns',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const device=await f.connect();await f.campaign('001');await f.campaign('002');
 let modelCalls=0;
 t.mock.method(globalThis,'fetch',async(url:unknown,init?:RequestInit)=>{assert.equal(url,model.url);modelCalls++;return modelReply(init);});
 const first=await f.poll(device);assert.equal(first.status,200);assert.deepEqual(await first.json(),{job:null});
 assert.equal(modelCalls,1,'a poll must not accumulate multiple 25-second model calls');
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM workbench_prospect_leads WHERE analysis_attempted=1').get()?.n,1);
 const second=await f.poll(device);assert.equal(second.status,200);assert.deepEqual(await second.json(),{job:null});
 assert.equal(modelCalls,2);assert.equal((await f.store.pendingAnalysis('owner-a','member-a')).length,0);
});

test('cancellation during model analysis leaves queued sends claimable by a later poll',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const device=await f.connect();await f.campaign('001');const send=await f.campaign('002');
 await f.store.review('owner-a','member-a',send.campaign.id,send.lead.id,send.lead.version,'approve',send.lead.greeting,'销售');
 const controller=new AbortController();let calls=0;
 t.mock.method(globalThis,'fetch',async(url:unknown,init?:RequestInit)=>{assert.equal(url,model.url);calls++;controller.abort();return modelReply(init);});
 const response=await f.poll(device,controller.signal);assert.equal(response.status,409);assert.match((await response.json() as {error:string}).error,/取消/);
 const queued=f.sqlite.prepare("SELECT id,status,started_at FROM workbench_prospect_jobs WHERE kind='send'").get()!;
 assert.equal(queued.status,'queued');assert.equal(queued.started_at,null);
 const resumed=await f.poll(device);assert.equal(resumed.status,200);const result=await resumed.json() as {job:ProspectBridgeJob};
 assert.equal(result.job.id,queued.id);assert.equal(result.job.kind,'send');assert.equal(calls,1,'completed analysis must not be repeated');
});

test('cancellation during automatic queue preparation does not claim an existing send',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const device=await f.connect();const send=await f.campaign('001');
 await f.store.review('owner-a','member-a',send.campaign.id,send.lead.id,send.lead.version,'approve',send.lead.greeting,'销售');
 t.mock.method(globalThis,'fetch',async()=>{assert.fail('reviewed sends do not need model analysis');});
 const controller=new AbortController();
 f.hooks.query=sql=>{if(sql.includes("'$.reviewMode'")&&sql.includes("='automatic'"))controller.abort();};
 const response=await f.poll(device,controller.signal);
 assert.equal(controller.signal.aborted,true,'the request is cancelled after analysis, while automatic candidates are being read');
 assert.equal(response.status,409);
 const job=f.sqlite.prepare("SELECT status,started_at FROM workbench_prospect_jobs WHERE kind='send'").get()!;
 assert.equal(job.status,'queued');assert.equal(job.started_at,null);
});

test('queued ongoing conversation work is claimed before new prospect model analysis',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const device=await f.connect();const ongoing=await f.campaign('ongoing');
 await f.store.review('owner-a','member-a',ongoing.campaign.id,ongoing.lead.id,ongoing.lead.version,'approve',ongoing.lead.greeting,'销售');const greeting=(await f.store.claim(device.deviceId))!;await f.store.complete(device.deviceId,greeting.id,greeting.leaseToken,{outcome:'submitted'});
 await f.store.chat.settings('owner-a','member-a',ongoing.campaign.id,true);await f.store.chat.schedule(device.deviceId);await f.campaign('backlog');
 let modelCalls=0;t.mock.method(globalThis,'fetch',async(_url:unknown,init?:RequestInit)=>{modelCalls++;return modelReply(init);});
 const response=await f.poll(device,undefined,1);assert.equal(response.status,200);assert.equal((await response.json() as {job:ProspectBridgeJob}).job.kind,'readConversation');assert.equal(modelCalls,0);
});

test('a reliable customer stop closes immediately before a manual reply can be queued',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const device=await f.connect();const ongoing=await f.campaign('stop');
 await f.store.review('owner-a','member-a',ongoing.campaign.id,ongoing.lead.id,ongoing.lead.version,'approve',ongoing.lead.greeting,'销售');const greeting=(await f.store.claim(device.deviceId))!;await f.store.complete(device.deviceId,greeting.id,greeting.leaseToken,{outcome:'submitted'});
 await f.store.chat.settings('owner-a','member-a',ongoing.campaign.id,true);await f.store.chat.schedule(device.deviceId);const read=(await f.store.claim(device.deviceId,false,true))!;
 await f.store.complete(device.deviceId,read.id,read.leaseToken,{senderAccountId:sender.accountId,recipientId:ongoing.lead.recipientId,observedAt:new Date().toISOString(),snapshotId:'stop-before-manual-reply',reliable:true,messages:[{id:'stop-now',direction:'inbound',text:'不要再联系我了',postedAt:new Date().toISOString()}]});
 const snapshot=await f.store.chat.snapshot('owner-a','member-a','sales',ongoing.campaign.id);const c=snapshot.conversations[0];await assert.rejects(f.store.chat.reply('owner-a','member-a',c.id,c.version,'人工不应越过客户停止请求'),/关闭|更新|停止/);
 f.sqlite.prepare('UPDATE workbench_prospect_jobs SET started_at=? WHERE id=?').run(new Date(Date.now()-61000).toISOString(),greeting.id);
 const response=await f.poll(device,undefined,1);assert.equal(response.status,200);assert.equal((await response.json() as {job:ProspectBridgeJob|null}).job,null);assert.equal((await f.store.chat.snapshot('owner-a','member-a','sales',ongoing.campaign.id)).conversations[0].status,'closed');
});
