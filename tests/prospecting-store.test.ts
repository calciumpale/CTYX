import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createProspectingStore} from '../app/lib/prospecting-store.ts';
import {normalizeCampaignInput,normalizeComments,scoreComment} from '../app/lib/prospecting-domain.ts';

function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 for(const file of readdirSync(new URL('../drizzle/',import.meta.url)).filter(x=>x.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(`../drizzle/${file}`,import.meta.url),'utf8'));
 sqlite.exec("INSERT INTO workbench_member_accounts VALUES ('member-a','owner-a','sales','销售','sales','sales-1',1,'salt','hash',100000,'now','now'),('member-b','owner-a','manager','管理者','manager',NULL,1,'salt','hash',100000,'now','now'),('member-c','owner-b','sales','销售','sales','sales-2',1,'salt','hash',100000,'now','now')");
 let batches:Promise<unknown>=Promise.resolve();
 const db={prepare(sql:string){let values:unknown[]=[];return{bind(...args:unknown[]){values=args;return this;},async first(){return sqlite.prepare(sql).get(...values as never[])??null;},async all(){return{results:sqlite.prepare(sql).all(...values as never[])};},async run(){return{meta:{changes:Number(sqlite.prepare(sql).run(...values as never[]).changes)}};}};},batch(items:{run:()=>Promise<unknown>}[]){const execute=async()=>{sqlite.exec('BEGIN');try{const out=[];for(const x of items)out.push(await x.run());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}};const next=batches.then(execute,execute);batches=next.catch(()=>{});return next;}} as unknown as D1Database;
 let time=Date.parse('2026-11-05T02:00:00Z');return{sqlite,store:createProspectingStore(db,()=>time),advance:(ms:number)=>{time+=ms;}};
}
const campaignInput=normalizeCampaignInput({requirements:'为中小企业提供销售培训工具',keywords:['销售培训'],greetingTemplate:'你好，可以介绍产品的试用方式。'});
async function prepared(f:ReturnType<typeof fixture>){
 const device=await f.store.connect('owner-a','member-a','本机');await f.store.seen(device.deviceId,{authenticated:true,accountId:'MS4wSender001',accountName:'发送账号'});
 const campaign=await f.store.createCampaign('owner-a','member-a',campaignInput);
 const comment=normalizeComments([{id:'c1',videoId:'7654321234567890',text:'多少钱？',nickname:'用户甲',profileUrl:'https://www.douyin.com/user/MS4wTarget001'}],'browser')[0];
 await f.store.insertComments('owner-a','member-a',campaign.id,[scoreComment(comment,campaign)]);
 return{device,campaign,lead:(await f.store.leads('owner-a','member-a',campaign.id))[0]};
}
test('campaigns and hashed devices are isolated by owner and member',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);
 assert.equal((await f.store.campaigns('owner-b','member-c')).length,0);
 await assert.rejects(f.store.campaign('owner-a','member-b',x.campaign.id),/不存在/);
 await assert.rejects(f.store.authenticate(x.device.deviceId,'0'.repeat(64)),/凭证/);
 const row=f.sqlite.prepare('SELECT token_hash FROM workbench_prospect_devices').get()!;assert.notEqual(row.token_hash,x.device.deviceToken);
});
test('approval binds exact revision and message; duplicate recipient cannot be scheduled in another campaign',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);
 await f.store.review('owner-a','member-a',x.campaign.id,x.lead.id,x.lead.version,'approve','你好，想了解你的需求','销售');
 await assert.rejects(f.store.review('owner-a','member-a',x.campaign.id,x.lead.id,x.lead.version,'approve','不同文案','销售'),/已更新|状态/);
 const job=await f.store.claim(x.device.deviceId);assert.equal(job?.input.message,'你好，想了解你的需求');
 const second=await f.store.createCampaign('owner-a','member-a',campaignInput);await f.store.insertComments('owner-a','member-a',second.id,[scoreComment(x.lead,second)]);
 const lead=(await f.store.leads('owner-a','member-a',second.id))[0];
 await assert.rejects(f.store.review('owner-a','member-a',second.id,lead.id,lead.version,'approve','再打招呼','销售'),/已安排|已触达/);
});
test('parallel claims dispatch once and expired send lease becomes unknown without replay',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.store.review('owner-a','member-a',x.campaign.id,x.lead.id,1,'approve',x.lead.greeting,'销售');
 const claimed=await Promise.all([f.store.claim(x.device.deviceId),f.store.claim(x.device.deviceId)]);assert.equal(claimed.filter(Boolean).length,1);
 f.advance(181000);assert.equal(await f.store.claim(x.device.deviceId),null);
 assert.equal((await f.store.leads('owner-a','member-a',x.campaign.id))[0].status,'unknown');
});
test('successful completion is idempotent and records submitted rather than delivered',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.store.review('owner-a','member-a',x.campaign.id,x.lead.id,1,'approve',x.lead.greeting,'销售');
 const job=(await f.store.claim(x.device.deviceId))!;await f.store.complete(x.device.deviceId,job.id,job.leaseToken,{outcome:'submitted',evidence:'已观察到新消息'});
 await f.store.complete(x.device.deviceId,job.id,job.leaseToken,{outcome:'submitted',evidence:'已观察到新消息'});
 assert.equal((await f.store.leads('owner-a','member-a',x.campaign.id))[0].status,'submitted');assert.equal(await f.store.claim(x.device.deviceId),null);
});
test('pause cancels queued greetings and changed login account cannot send as the old account',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.store.review('owner-a','member-a',x.campaign.id,x.lead.id,1,'approve',x.lead.greeting,'销售');
 await f.store.setPaused('owner-a','member-a',x.campaign.id,true);assert.equal(await f.store.claim(x.device.deviceId),null);assert.equal((await f.store.leads('owner-a','member-a',x.campaign.id))[0].status,'pending');
 await f.store.setPaused('owner-a','member-a',x.campaign.id,false);
 await f.store.seen(x.device.deviceId,{authenticated:true,accountId:'MS4wDifferent',accountName:'另一账号'});
 assert.equal((await f.store.device('owner-a','member-a')).authenticated,false);
 const current=(await f.store.leads('owner-a','member-a',x.campaign.id))[0];
 await assert.rejects(f.store.review('owner-a','member-a',x.campaign.id,x.lead.id,current.version,'approve',x.lead.greeting,'销售'),/登录|账号|设备/);
});
test('anonymous source cannot be approved and rule results never auto-queue',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);
 const comment=normalizeComments([{comment_id:'anonymous',aweme_id:'7654321234567890',content:'想购买',creator_hash:'0123456789abcdef'}],'mediacrawler')[0];
 await f.store.insertComments('owner-a','member-a',x.campaign.id,[scoreComment(comment,x.campaign)]);
 const lead=(await f.store.leads('owner-a','member-a',x.campaign.id)).find(x=>x.source==='mediacrawler')!;
 await assert.rejects(f.store.review('owner-a','member-a',x.campaign.id,lead.id,1,'approve','你好','销售'),/身份|私信/);
 assert.equal((await f.store.jobs('owner-a','member-a',x.campaign.id)).length,0);
});
test('one sender is rate limited across campaigns and daily quotas survive failed submissions',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);
 await f.store.review('owner-a','member-a',x.campaign.id,x.lead.id,1,'approve',x.lead.greeting,'销售');const first=(await f.store.claim(x.device.deviceId))!;
 await f.store.complete(x.device.deviceId,first.id,first.leaseToken,{outcome:'failed',error:'对方关闭私信'});
 const c=await f.store.createCampaign('owner-a','member-a',{...campaignInput,dailyLimit:1});
 const comment=normalizeComments([{id:'c2',videoId:'7654321234567890',text:'想购买',profileUrl:'https://www.douyin.com/user/MS4wTarget002'}],'browser')[0];
 await f.store.insertComments('owner-a','member-a',c.id,[scoreComment(comment,c)]);const l=(await f.store.leads('owner-a','member-a',c.id))[0];
 await f.store.review('owner-a','member-a',c.id,l.id,1,'approve',l.greeting,'销售');assert.equal(await f.store.claim(x.device.deviceId),null);f.advance(61000);assert.equal(await f.store.claim(x.device.deviceId),null);
});
test('concurrent comment imports enforce the stored capacity without hidden overflow',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);
 const batch=(prefix:string)=>Array.from({length:300},(_,i)=>scoreComment({...x.lead,id:`${prefix}-${i}`},x.campaign));
 await Promise.all([f.store.insertComments('owner-a','member-a',x.campaign.id,batch('a')),f.store.insertComments('owner-a','member-a',x.campaign.id,batch('b'))]);
 assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM workbench_prospect_leads WHERE campaign_id=?').get(x.campaign.id)?.n,300);
});
test('automatic model-qualified leads resume when device reconnects without repeating analysis',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);
 const c=await f.store.createCampaign('owner-a','member-a',{...campaignInput,reviewMode:'automatic'});
 await f.store.insertComments('owner-a','member-a',c.id,[scoreComment(x.lead,c)]);const lead=(await f.store.leads('owner-a','member-a',c.id))[0];
 await f.store.seen(x.device.deviceId,{authenticated:false});
 await f.store.saveAnalysis('owner-a','member-a',lead,{...lead,analysisSource:'model',intentScore:95});
 await f.store.seen(x.device.deviceId,{authenticated:true,accountId:'MS4wSender001'});
 await f.store.enqueueAutomatic('owner-a','member-a');assert.equal((await f.store.claim(x.device.deviceId))?.kind,'send');
});
test('low-score model results do not starve eligible automatic recovery behind the batch limit',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);
 const c=await f.store.createCampaign('owner-a','member-a',{...campaignInput,reviewMode:'automatic'});
 const comments=Array.from({length:31},(_,i)=>scoreComment({...x.lead,id:`recovery-${String(i).padStart(2,'0')}`,recipientId:`MS4wRecovery${i}`,profileUrl:`https://www.douyin.com/user/MS4wRecovery${i}`},c));
 await f.store.insertComments('owner-a','member-a',c.id,comments);await f.store.seen(x.device.deviceId,{authenticated:false});
 const leads=await f.store.leads('owner-a','member-a',c.id);
 for(const lead of leads){f.advance(1);await f.store.saveAnalysis('owner-a','member-a',lead,{...lead,analysisSource:'model',intentScore:lead.id==='recovery-30'?95:10});}
 await f.store.seen(x.device.deviceId,{authenticated:true,accountId:'MS4wSender001'});
 await f.store.enqueueAutomatic('owner-a','member-a');
 const job=await f.store.claim(x.device.deviceId);assert.equal(job?.kind,'send');assert.equal(job?.input.recipientId,'MS4wRecovery30');
});
for(const stop of ['pause','disconnect'] as const)test(`${stop} cancellation survives model reanalysis and requires fresh manual approval`,async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);let device=x.device;
 const c=await f.store.createCampaign('owner-a','member-a',{...campaignInput,reviewMode:'automatic'});
 await f.store.insertComments('owner-a','member-a',c.id,[scoreComment(x.lead,c)]);
 const original=(await f.store.leads('owner-a','member-a',c.id))[0];
 await f.store.saveAnalysis('owner-a','member-a',original,{...original,analysisSource:'model',intentScore:95});
 assert.equal((await f.store.leads('owner-a','member-a',c.id))[0].status,'queued');
 if(stop==='pause'){await f.store.setPaused('owner-a','member-a',c.id,true);await f.store.setPaused('owner-a','member-a',c.id,false);}
 else{await f.store.disconnect('owner-a','member-a');device=await f.store.connect('owner-a','member-a','重新绑定');await f.store.seen(device.deviceId,{authenticated:true,accountId:'MS4wSender001'});}
 await f.store.retryAnalysis('owner-a','member-a',c.id);
 const lead=(await f.store.pendingAnalysis('owner-a','member-a',c.id))[0];assert.ok(lead);
 const refreshed=scoreComment(normalizeComments([lead],'browser')[0],c);
 await f.store.saveAnalysis('owner-a','member-a',lead,{...refreshed,analysisSource:'model',intentScore:99});
 await f.store.enqueueAutomatic('owner-a','member-a');
 assert.equal(await f.store.claim(device.deviceId),null,'reanalysis must not restore cancelled automatic outreach');
 const current=(await f.store.leads('owner-a','member-a',c.id))[0];assert.equal(current.status,'pending');
 await assert.rejects(f.store.review('owner-a','member-a',c.id,current.id,current.version,'approve',current.greeting,'自动策略',true),/自动审核/);
 await f.store.review('owner-a','member-a',c.id,current.id,current.version,'approve','重新审核后的招呼','销售');
 assert.equal((await f.store.claim(device.deviceId))?.input.message,'重新审核后的招呼');
});
