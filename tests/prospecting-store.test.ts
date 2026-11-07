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
const readOnlyAccountId='dy-readonly-0123456789abcdef01234567';
test('device liveness updates only last seen without authorizing an unverified browser',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const credentials=await f.store.connect('owner-a','member-a','本机');
 await f.store.seen(credentials.deviceId,{authenticated:false,accountName:'未核实',message:'需要核实登录'});
 const before=f.sqlite.prepare('SELECT * FROM workbench_prospect_devices WHERE id=?').get(credentials.deviceId)!;
 f.advance(100000);await f.store.touchDevice(credentials.deviceId);
 const after=f.sqlite.prepare('SELECT * FROM workbench_prospect_devices WHERE id=?').get(credentials.deviceId)!;
 assert.notEqual(after.last_seen_at,before.last_seen_at);
 assert.deepEqual({...after,last_seen_at:before.last_seen_at},{...before});
 const view=await f.store.device('owner-a','member-a');assert.equal(view.online,true);assert.equal(view.authenticated,false);
});
test('device liveness refuses revoked pairings and disabled or nonbusiness members',async t=>{
 for(const change of ["UPDATE workbench_prospect_devices SET enabled=0","UPDATE workbench_member_accounts SET enabled=0 WHERE account_id='member-a'","UPDATE workbench_member_accounts SET role='admin' WHERE account_id='member-a'"]){
  const f=fixture();t.after(()=>f.sqlite.close());const credentials=await f.store.connect('owner-a','member-a','本机');
  f.sqlite.exec(change);await assert.rejects(()=>f.store.touchDevice(credentials.deviceId),/停用/);
  assert.equal(f.sqlite.prepare('SELECT last_seen_at FROM workbench_prospect_devices WHERE id=?').get(credentials.deviceId)!.last_seen_at,null);
 }
});
async function prepared(f:ReturnType<typeof fixture>,accountId='MS4wSender001'){
 const device=await f.store.connect('owner-a','member-a','本机');await f.store.seen(device.deviceId,{authenticated:true,accountId,accountName:'发送账号'});
 const campaign=await f.store.createCampaign('owner-a','member-a',campaignInput);
 const comment=normalizeComments([{id:'c1',videoId:'7654321234567890',text:'多少钱？',nickname:'用户甲',profileUrl:'https://www.douyin.com/user/MS4wTarget001'}],'browser')[0];
 await f.store.insertComments('owner-a','member-a',campaign.id,[scoreComment(comment,campaign)]);
 return{device,campaign,lead:(await f.store.leads('owner-a','member-a',campaign.id))[0]};
}
async function collecting(f:ReturnType<typeof fixture>){
 const x=await prepared(f,readOnlyAccountId);
 await f.store.createJob('owner-a','member-a',x.campaign.id,'discover');const discovery=(await f.store.claim(x.device.deviceId))!;
 await f.store.complete(x.device.deviceId,discovery.id,discovery.leaseToken,{candidates:[{profileUrl:'https://www.douyin.com/user/MS4wAuthor001',videos:[{id:'7654321234567890'}]}]});
 await f.store.createJob('owner-a','member-a',x.campaign.id,'collect',['MS4wAuthor001']);
 return{...x,job:(await f.store.claim(x.device.deviceId))!};
}
async function completedSend(f:ReturnType<typeof fixture>,outcome:'failed'|'unknown'|'submitted'='failed'){
 const x=await prepared(f);const message='这条是已审核的原文，请保持完全一致。';
 await f.store.review('owner-a','member-a',x.campaign.id,x.lead.id,x.lead.version,'approve',message,'审核员');
 const job=(await f.store.claim(x.device.deviceId))!;
 await f.store.complete(x.device.deviceId,job.id,job.leaseToken,{outcome,error:outcome==='submitted'?undefined:'原执行结果'});
 return{...x,message,job,lead:(await f.store.leads('owner-a','member-a',x.campaign.id))[0]};
}

test('manual retry preserves prior send history and exact approval while transferring one recipient reservation',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await completedSend(f);
 const old=f.sqlite.prepare('SELECT * FROM workbench_prospect_jobs WHERE id=?').get(x.job.id)!;
 await f.store.retrySend('owner-a','member-a',x.campaign.id,x.lead.id,x.lead.version,'重试审核员');
 const lead=(await f.store.leads('owner-a','member-a',x.campaign.id))[0];
 assert.equal(lead.status,'queued');assert.equal(lead.version,x.lead.version+1);assert.equal(lead.greeting,x.message);
 const rows=f.sqlite.prepare('SELECT * FROM workbench_prospect_jobs WHERE campaign_id=?').all(x.campaign.id);
 assert.equal(rows.length,2);const previous=rows.find(row=>row.id===x.job.id)!,next=rows.find(row=>row.id!==x.job.id)!;
 assert.equal(previous.recipient_key,null);assert.equal(next.recipient_key,old.recipient_key);
 for(const field of ['input_json','result_json','error','status','started_at'])assert.equal(previous[field],old[field]);
 const input=JSON.parse(String(next.input_json));assert.equal(input.message,x.message);assert.equal(input.senderAccountId,x.job.input.senderAccountId);
 assert.deepEqual(input.retry,{previousJobId:x.job.id});
 assert.equal(await f.store.claim(x.device.deviceId,true),null,'the prior attempt still consumes the sender cooldown');
 f.advance(61000);
 assert.equal(await f.store.claim(x.device.deviceId),null,'an old bridge cannot claim a retry');
 assert.equal((await f.store.claim(x.device.deviceId,true))?.id,next.id);
 await f.store.complete(x.device.deviceId,x.job.id,x.job.leaseToken,{outcome:'submitted',evidence:'late completion'});
 assert.equal((await f.store.leads('owner-a','member-a',x.campaign.id))[0].status,'sending');
 assert.equal(f.sqlite.prepare('SELECT status FROM workbench_prospect_jobs WHERE id=?').get(x.job.id)?.status,'failed');
});

test('concurrent manual retry clicks queue exactly once and leave the lead revision attached to that job',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await completedSend(f,'unknown');
 const attempts=await Promise.allSettled([1,2].map(()=>f.store.retrySend('owner-a','member-a',x.campaign.id,x.lead.id,x.lead.version,'审核员')));
 assert.equal(attempts.filter(value=>value.status==='fulfilled').length,1);assert.equal(attempts.filter(value=>value.status==='rejected').length,1);
 const rows=f.sqlite.prepare('SELECT * FROM workbench_prospect_jobs WHERE campaign_id=?').all(x.campaign.id);
 assert.equal(rows.length,2);assert.equal(rows.filter(row=>row.recipient_key!==null).length,1);
 const lead=f.sqlite.prepare('SELECT version,job_id FROM workbench_prospect_leads WHERE campaign_id=? AND id=?').get(x.campaign.id,x.lead.id)!;
 assert.equal(lead.version,x.lead.version+1);assert.equal(rows.find(row=>row.status==='queued')?.id,lead.job_id);
});

test('a failed retry reservation transfer rolls back the new job and leaves prior history and lead intact',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await completedSend(f,'unknown');
 const previous=f.sqlite.prepare('SELECT * FROM workbench_prospect_jobs WHERE id=?').get(x.job.id);
 const lead=f.sqlite.prepare('SELECT * FROM workbench_prospect_leads WHERE campaign_id=? AND id=?').get(x.campaign.id,x.lead.id);
 f.sqlite.exec("CREATE TRIGGER fail_retry_reservation BEFORE UPDATE OF recipient_key ON workbench_prospect_jobs WHEN OLD.recipient_key IS NULL AND NEW.recipient_key IS NOT NULL BEGIN SELECT RAISE(ABORT,'injected reservation failure'); END");
 await assert.rejects(f.store.retrySend('owner-a','member-a',x.campaign.id,x.lead.id,x.lead.version,'审核员'),/injected reservation failure/);
 assert.deepEqual(f.sqlite.prepare('SELECT * FROM workbench_prospect_jobs WHERE id=?').get(x.job.id),previous);
 assert.deepEqual(f.sqlite.prepare('SELECT * FROM workbench_prospect_leads WHERE campaign_id=? AND id=?').get(x.campaign.id,x.lead.id),lead);
 assert.equal((await f.store.jobs('owner-a','member-a',x.campaign.id)).length,1);
});

test('unknown retries use creation time when start is absent and retain the earliest unknown across later attempts',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await completedSend(f,'unknown');
 f.sqlite.prepare('UPDATE workbench_prospect_jobs SET started_at=NULL WHERE id=?').run(x.job.id);
 const original=String(f.sqlite.prepare('SELECT created_at FROM workbench_prospect_jobs WHERE id=?').get(x.job.id)?.created_at);
 await f.store.retrySend('owner-a','member-a',x.campaign.id,x.lead.id,x.lead.version,'审核员');
 const firstRetry=(await f.store.claim(x.device.deviceId,true))!;assert.equal(firstRetry.input.retry?.checkSince,original);
 await f.store.complete(x.device.deviceId,firstRetry.id,firstRetry.leaseToken,{outcome:'unknown'});f.advance(61000);
 await f.store.seen(x.device.deviceId,{authenticated:true,accountId:'MS4wSender001'});
 const lead=(await f.store.leads('owner-a','member-a',x.campaign.id))[0];
 await f.store.retrySend('owner-a','member-a',x.campaign.id,lead.id,lead.version,'审核员');
 const next=(await f.store.claim(x.device.deviceId,true))!;assert.equal(next.input.retry?.checkSince,original);
});

test('an unresolved unknown ancestor survives a later failed preflight and cannot be silently retried automatically',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await completedSend(f,'unknown');
 const since=String(f.sqlite.prepare('SELECT started_at FROM workbench_prospect_jobs WHERE id=?').get(x.job.id)?.started_at);
 await f.store.retrySend('owner-a','member-a',x.campaign.id,x.lead.id,x.lead.version,'审核员');f.advance(61000);
 const retry=(await f.store.claim(x.device.deviceId,true))!;
 assert.deepEqual(retry.input.retry,{previousJobId:x.job.id,checkSince:since});
 await f.store.complete(x.device.deviceId,retry.id,retry.leaseToken,{outcome:'failed',error:'页面尚未准备好'});
 await f.store.seen(x.device.deviceId,{authenticated:true,accountId:'MS4wSender001'});
 const before=(await f.store.leads('owner-a','member-a',x.campaign.id))[0];
 await f.store.enqueueAutomatic('owner-a','member-a');assert.equal((await f.store.jobs('owner-a','member-a',x.campaign.id)).length,2);
 await f.store.retrySend('owner-a','member-a',x.campaign.id,before.id,before.version,'审核员');
 const next=f.sqlite.prepare("SELECT input_json FROM workbench_prospect_jobs WHERE campaign_id=? AND status='queued'").get(x.campaign.id)!;
 assert.deepEqual(JSON.parse(String(next.input_json)).retry,{previousJobId:retry.id,checkSince:since});
});

for(const outcome of ['failed','unknown'] as const)for(const cancellation of ['pause','disconnect'] as const)test(`cancelling a queued ${outcome} retry by ${cancellation} preserves its reservation and manual retry lineage`,async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await completedSend(f,outcome);
 await f.store.retrySend('owner-a','member-a',x.campaign.id,x.lead.id,x.lead.version,'审核员');
 const queued=f.sqlite.prepare("SELECT * FROM workbench_prospect_jobs WHERE campaign_id=? AND status='queued'").get(x.campaign.id)!;
 const oldVersion=(await f.store.leads('owner-a','member-a',x.campaign.id))[0].version;
 if(cancellation==='pause')await f.store.setPaused('owner-a','member-a',x.campaign.id,true);else await f.store.disconnect('owner-a','member-a');
 const cancelled=f.sqlite.prepare('SELECT * FROM workbench_prospect_jobs WHERE id=?').get(queued.id as string)!;
 assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.recipient_key,queued.recipient_key);
 const lead=(await f.store.leads('owner-a','member-a',x.campaign.id))[0];assert.equal(lead.status,outcome);assert.ok(lead.version>oldVersion);
 assert.equal(f.sqlite.prepare('SELECT job_id FROM workbench_prospect_leads WHERE campaign_id=? AND id=?').get(x.campaign.id,x.lead.id)?.job_id,queued.id);
 if(cancellation==='pause')await f.store.setPaused('owner-a','member-a',x.campaign.id,false);
 else {const replacement=await f.store.connect('owner-a','member-a','新配对');await f.store.seen(replacement.deviceId,{authenticated:true,accountId:'MS4wSender001'});}
 await f.store.retrySend('owner-a','member-a',x.campaign.id,lead.id,lead.version,'审核员');
 const next=f.sqlite.prepare("SELECT input_json FROM workbench_prospect_jobs WHERE campaign_id=? AND status='queued'").get(x.campaign.id)!;
 const previousInput=JSON.parse(String(queued.input_json));
 assert.equal(previousInput.retry.previousJobId,x.job.id);
 assert.deepEqual(JSON.parse(String(next.input_json)).retry,{previousJobId:x.job.id,...(previousInput.retry.checkSince?{checkSince:previousInput.retry.checkSince}:{})},'a never-claimed cancelled retry must not become the bridge journal parent');
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS total FROM workbench_prospect_jobs WHERE campaign_id=? AND recipient_key IS NOT NULL').get(x.campaign.id)?.total,1);
});

test('manual retry keeps tenant, sender, submitted-result, revision and daily quota boundaries',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await completedSend(f);
 await assert.rejects(f.store.retrySend('owner-a','member-b',x.campaign.id,x.lead.id,x.lead.version,'审核员'),/不存在|无权/);
 await assert.rejects(f.store.retrySend('owner-b','member-c',x.campaign.id,x.lead.id,x.lead.version,'审核员'),/不存在|无权/);
 await assert.rejects(f.store.retrySend('owner-a','member-a',x.campaign.id,x.lead.id,x.lead.version-1,'审核员'),/已更新|状态/);
 f.sqlite.prepare('UPDATE workbench_prospect_devices SET account_id=? WHERE id=?').run('MS4wOtherSender',x.device.deviceId);
 await assert.rejects(f.store.retrySend('owner-a','member-a',x.campaign.id,x.lead.id,x.lead.version,'审核员'),/账号/);
 f.sqlite.prepare('UPDATE workbench_prospect_devices SET account_id=? WHERE id=?').run('MS4wSender001',x.device.deviceId);
 f.sqlite.prepare("UPDATE workbench_prospect_campaigns SET data_json=json_set(data_json,'$.dailyLimit',1) WHERE id=?").run(x.campaign.id);
 await f.store.retrySend('owner-a','member-a',x.campaign.id,x.lead.id,x.lead.version,'审核员');f.advance(61000);
 assert.equal(await f.store.claim(x.device.deviceId,true),null,'the previous failed attempt still consumes the daily quota');
 const submitted=fixture();t.after(()=>submitted.sqlite.close());const other=await completedSend(submitted,'submitted');
 await assert.rejects(submitted.store.retrySend('owner-a','member-a',other.campaign.id,other.lead.id,other.lead.version,'审核员'),/已更新|状态|重试/);
});

test('saved rule scores refresh in the list without changing review data or model scores', async t => {
 const f = fixture();
 t.after(() => f.sqlite.close());
 const campaign = await f.store.createCampaign('owner-a', 'member-a', {
  ...campaignInput, requirements: '寻找海盐有商铺求租意向的人', keywords: ['海盐商铺出租'],
 });
 const [rental, modeled] = normalizeComments([
  { id: 'old-rule', videoId: '7654321234567890', text: '在海盐想租个店面，预算3000，最近能看铺吗？' },
  { id: 'old-model', videoId: '7654321234567890', text: '还有空铺吗？' },
 ], 'browser');
 await f.store.insertComments('owner-a', 'member-a', campaign.id, [
  { ...scoreComment(rental, campaign), intentScore: 20, reason: '旧规则评分', greeting: '保留已保存的草稿' },
  { ...scoreComment(modeled, campaign), analysisSource: 'model', intentScore: 50, reason: '保留模型判断' },
 ]);

 const rows = await f.store.leads('owner-a', 'member-a', campaign.id);
 assert.deepEqual(rows.map(lead => lead.id), ['old-rule', 'old-model']);
 assert.ok(rows[0].intentScore >= campaign.minIntentScore);
 assert.equal(rows[0].status, 'unreachable');
 assert.equal(rows[0].greeting, '保留已保存的草稿');
 assert.equal(rows[1].intentScore, 50);
 assert.equal(rows[1].reason, '保留模型判断');
 assert.equal((await f.store.jobs('owner-a', 'member-a', campaign.id)).length, 0);
 const stored = f.sqlite.prepare('SELECT data_json FROM workbench_prospect_leads WHERE id=?').get('old-rule');
 assert.equal(JSON.parse(String(stored?.data_json)).intentScore, 20);
});

test('collection job views expose redacted warnings alongside successful partial results',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await collecting(f);
 await f.store.complete(x.device.deviceId,x.job.id,x.job.leaseToken,{comments:[{id:'partial',videoId:'7654321234567890',text:'想试用'}],warnings:['部分评论正文无法识别，详情 https://example.invalid/private','诊断 token=warning-secret']});
 const job=(await f.store.jobs('owner-a','member-a',x.campaign.id)).find(job=>job.id===x.job.id)!;
 assert.equal(job.status,'done');assert.match(job.summary!,/^读取1条评论/);
 assert.deepEqual(job.warnings,['部分评论正文无法识别，详情 [链接]','诊断 [凭证已隐藏]']);
});
test('job views bound and sanitize historical warning data before exposing it',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await collecting(f);
 const warnings=['诊断 token=old-secret https://example.invalid/private',null,' ',('token=a ').repeat(100),...Array.from({length:6},(_,i)=>`历史警告${i}`),'超额警告'];
 f.sqlite.prepare("UPDATE workbench_prospect_jobs SET status='done',result_json=? WHERE id=?").run(JSON.stringify({summary:'读取0条评论',warnings}),x.job.id);
 const job=(await f.store.jobs('owner-a','member-a',x.campaign.id)).find(job=>job.id===x.job.id)!;
 assert.ok(job.warnings?.length);assert.ok(job.warnings.length<=10);
 assert.ok(job.warnings.every(warning=>typeof warning==='string'&&warning.length>0&&warning.length<=500));
 assert.equal(job.warnings[0],'诊断 [凭证已隐藏] [链接]');assert.ok(!job.warnings.includes('超额警告'));
 assert.ok(!JSON.stringify(job.warnings).includes('old-secret'));assert.ok(!JSON.stringify(job.warnings).includes('token='));
});
for(const unreadable of [false,true])test(`collection ${unreadable?'structure failure':'genuinely empty comments'} remains distinguishable in job history`,async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await collecting(f);
 await f.store.complete(x.device.deviceId,x.job.id,x.job.leaseToken,{comments:[],warnings:[]},unreadable?'评论正文结构无法识别，请检查页面后重试':undefined);
 const job=(await f.store.jobs('owner-a','member-a',x.campaign.id)).find(job=>job.id===x.job.id)!;
 assert.equal(job.status,unreadable?'failed':'done');assert.equal(job.warnings,undefined);
 if(unreadable){assert.match(job.error!,/评论正文结构无法识别/);assert.ok(!job.summary);}
 else{assert.match(job.summary!,/^读取0条评论/);assert.equal(job.error,undefined);}
});
test('read-only accounts cannot approve private messages but can reject a lead',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f,readOnlyAccountId);
 await assert.rejects(f.store.review('owner-a','member-a',x.campaign.id,x.lead.id,x.lead.version,'approve',x.lead.greeting,'销售'),/仅支持.*采集.*私信/);
 assert.equal((await f.store.jobs('owner-a','member-a',x.campaign.id)).length,0);
 const current=(await f.store.leads('owner-a','member-a',x.campaign.id))[0];assert.equal(current.status,'pending');assert.equal(current.version,x.lead.version);
 await f.store.review('owner-a','member-a',x.campaign.id,x.lead.id,x.lead.version,'reject','','销售');
 assert.equal((await f.store.leads('owner-a','member-a',x.campaign.id))[0].status,'rejected');
});
test('matching verified self identity upgrades the same device once without weakening self-send rejection',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f,readOnlyAccountId);
 const before=f.sqlite.prepare('SELECT id,token_hash FROM workbench_prospect_devices WHERE id=?').get(x.device.deviceId);
 const proof={authenticated:true,accountId:x.lead.recipientId!,accountName:'已核实账号',verifiedReadOnlyAccountId:readOnlyAccountId};
 await f.store.seen(x.device.deviceId,proof);await f.store.seen(x.device.deviceId,proof);
 const device=await f.store.device('owner-a','member-a');assert.equal(device.id,x.device.deviceId);assert.equal(device.accountId,x.lead.recipientId);assert.equal(device.authenticated,true);
 assert.deepEqual(f.sqlite.prepare('SELECT id,token_hash FROM workbench_prospect_devices WHERE id=?').get(x.device.deviceId),before);
 await assert.rejects(f.store.review('owner-a','member-a',x.campaign.id,x.lead.id,x.lead.version,'approve',x.lead.greeting,'销售'),/当前登录账号/);
 assert.equal((await f.store.jobs('owner-a','member-a',x.campaign.id)).length,0);
});
for(const scenario of [
 {name:'missing proof',old:readOnlyAccountId,next:'MS4wVerified001',authenticated:true,proof:undefined},
 {name:'different alias',old:readOnlyAccountId,next:'MS4wVerified001',authenticated:true,proof:'dy-readonly-ffffffffffffffffffffffff'},
 {name:'unauthenticated proof',old:readOnlyAccountId,next:'MS4wVerified001',authenticated:false,proof:readOnlyAccountId},
 {name:'malformed existing alias',old:'dy-readonly-invalid',next:'MS4wVerified001',authenticated:true,proof:'dy-readonly-invalid'},
 {name:'another read-only identity',old:readOnlyAccountId,next:'dy-readonly-ffffffffffffffffffffffff',authenticated:true,proof:readOnlyAccountId},
 {name:'ordinary canonical account switch',old:'MS4wOriginal001',next:'MS4wVerified001',authenticated:true,proof:readOnlyAccountId},
 {name:'invalid canonical identity',old:readOnlyAccountId,next:'self',authenticated:true,proof:readOnlyAccountId},
])test(`identity upgrade rejects ${scenario.name}`,async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f,scenario.old);
 await f.store.seen(x.device.deviceId,{authenticated:scenario.authenticated,accountId:scenario.next,verifiedReadOnlyAccountId:scenario.proof});
 const device=await f.store.device('owner-a','member-a');assert.equal(device.accountId,scenario.old);assert.equal(device.authenticated,false);
});
test('concurrent identity upgrades cannot overwrite the first canonical binding',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f,readOnlyAccountId);
 await Promise.all(['MS4wVerified001','MS4wVerified002'].map(accountId=>f.store.seen(x.device.deviceId,{authenticated:true,accountId,verifiedReadOnlyAccountId:readOnlyAccountId})));
 const device=await f.store.device('owner-a','member-a');assert.equal(device.accountId,'MS4wVerified001');assert.equal(device.authenticated,false);
});
test('read-only accounts can discover and collect with renewable leases',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f,readOnlyAccountId);
 await f.store.createJob('owner-a','member-a',x.campaign.id,'discover');const discover=(await f.store.claim(x.device.deviceId))!;assert.equal(discover.kind,'discover');
 await f.store.renew(x.device.deviceId,discover.id,discover.leaseToken);
 await f.store.complete(x.device.deviceId,discover.id,discover.leaseToken,{candidates:[{profileUrl:'https://www.douyin.com/user/MS4wAuthor001',videos:[{id:'7654321234567890'}]}]});
 await f.store.createJob('owner-a','member-a',x.campaign.id,'collect',['MS4wAuthor001']);const collect=(await f.store.claim(x.device.deviceId))!;assert.equal(collect.kind,'collect');
 await f.store.renew(x.device.deviceId,collect.id,collect.leaseToken);
 await f.store.complete(x.device.deviceId,collect.id,collect.leaseToken,{comments:[{id:'collected',videoId:'7654321234567890',text:'想试用',profileUrl:'https://www.douyin.com/user/MS4wTarget002'}]});
 assert.ok((await f.store.leads('owner-a','member-a',x.campaign.id)).some(lead=>lead.id==='collected'));
});

test('an authenticated heartbeat keeps a device online during long browser work',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await collecting(f);
 const previous=await f.store.device('owner-a','member-a');
 f.advance(100000);
 assert.equal((await f.store.device('owner-a','member-a')).online,false);
 await assert.rejects(f.store.renew(x.device.deviceId,x.job.id,'invalid-lease'),/凭证无效/);
 assert.equal((await f.store.device('owner-a','member-a')).online,false);
 await f.store.renew(x.device.deviceId,x.job.id,x.job.leaseToken);
 const current=await f.store.device('owner-a','member-a');
 assert.equal(current.online,true);
 assert.equal(current.authenticated,true);
 assert.ok(Date.parse(current.lastSeenAt!)>Date.parse(previous.lastSeenAt!));
});
test('read-only accounts save qualified model analysis without automatic outreach or an approval error',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f,readOnlyAccountId);
 const c=await f.store.createCampaign('owner-a','member-a',{...campaignInput,reviewMode:'automatic'});
 await f.store.insertComments('owner-a','member-a',c.id,[scoreComment(x.lead,c)]);const lead=(await f.store.leads('owner-a','member-a',c.id))[0];
 await f.store.saveAnalysis('owner-a','member-a',lead,{...lead,analysisSource:'model',intentScore:95});
 assert.equal((await f.store.jobs('owner-a','member-a',c.id)).length,0);
 const saved=(await f.store.leads('owner-a','member-a',c.id))[0];assert.equal(saved.status,'pending');assert.equal(saved.analysisSource,'model');assert.equal(saved.intentScore,95);assert.equal(saved.error,undefined);
});
test('read-only accounts skip recovery of previously analyzed automatic leads',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f,readOnlyAccountId);
 const c=await f.store.createCampaign('owner-a','member-a',{...campaignInput,reviewMode:'automatic'});
 await f.store.insertComments('owner-a','member-a',c.id,[{...scoreComment(x.lead,c),analysisSource:'model',intentScore:95}]);
 const before=(await f.store.leads('owner-a','member-a',c.id))[0];await f.store.enqueueAutomatic('owner-a','member-a');
 assert.equal((await f.store.jobs('owner-a','member-a',c.id)).length,0);
 assert.deepEqual((await f.store.leads('owner-a','member-a',c.id))[0],before);
});
test('read-only accounts cannot claim an existing private-message job',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);
 await f.store.review('owner-a','member-a',x.campaign.id,x.lead.id,x.lead.version,'approve',x.lead.greeting,'销售');
 // Model a historical job written before the capability restriction existed.
 f.sqlite.prepare('UPDATE workbench_prospect_devices SET account_id=? WHERE id=?').run(readOnlyAccountId,x.device.deviceId);
 f.sqlite.prepare("UPDATE workbench_prospect_jobs SET sender_id=?,input_json=json_set(input_json,'$.senderAccountId',?) WHERE device_id=?").run(readOnlyAccountId,readOnlyAccountId,x.device.deviceId);
 assert.equal(await f.store.claim(x.device.deviceId),null);
 assert.equal((await f.store.jobs('owner-a','member-a',x.campaign.id))[0].status,'queued');
});
test('a running private-message lease cannot renew under a read-only account',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);
 await f.store.review('owner-a','member-a',x.campaign.id,x.lead.id,x.lead.version,'approve',x.lead.greeting,'销售');const job=(await f.store.claim(x.device.deviceId))!;
 f.sqlite.prepare('UPDATE workbench_prospect_devices SET account_id=? WHERE id=?').run(readOnlyAccountId,x.device.deviceId);
 await assert.rejects(f.store.renew(x.device.deviceId,job.id,job.leaseToken),/仅支持.*采集.*私信/);
});
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

test('persistent contact stops block approval, queued claim and running renewal while keeping owner boundaries',async t=>{
 for(const stage of ['approval','queued','running'] as const){
  const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);let running:Awaited<ReturnType<typeof f.store.claim>>;
  if(stage!=='approval'){await f.store.review('owner-a','member-a',x.campaign.id,x.lead.id,x.lead.version,'approve',x.lead.greeting,'审核员');if(stage==='running')running=(await f.store.claim(x.device.deviceId))!;}
  // A stop by another workspace cannot suppress this workspace's customer.
  f.sqlite.prepare('INSERT INTO workbench_prospect_contact_optouts VALUES (?,?,?,?,?)').run('owner-b','MS4wSender001','MS4wTarget001','停止联系','2026-11-05T02:00:00.000Z');
  if(stage==='approval'){await f.store.review('owner-a','member-a',x.campaign.id,x.lead.id,x.lead.version,'approve',x.lead.greeting,'审核员');}
  f.sqlite.prepare('INSERT INTO workbench_prospect_contact_optouts VALUES (?,?,?,?,?)').run('owner-a','MS4wSender001','MS4wTarget001','停止联系','2026-11-05T02:00:00.000Z');
  if(stage==='running')await assert.rejects(f.store.renew(x.device.deviceId,running!.id,running!.leaseToken),/凭证|停止/);
  else assert.equal(await f.store.claim(x.device.deviceId),null);
 }
});

test('an opted out recipient cannot be explicitly retried and failed history remains untouched',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await completedSend(f);const prior=f.sqlite.prepare('SELECT * FROM workbench_prospect_jobs WHERE id=?').get(x.job.id);
 f.sqlite.prepare('INSERT INTO workbench_prospect_contact_optouts VALUES (?,?,?,?,?)').run('owner-a','MS4wSender001','MS4wTarget001','停止联系','2026-11-05T02:00:00.000Z');
 await assert.rejects(f.store.retrySend('owner-a','member-a',x.campaign.id,x.lead.id,x.lead.version,'审核员'),/停止联系/);assert.deepEqual(f.sqlite.prepare('SELECT * FROM workbench_prospect_jobs WHERE id=?').get(x.job.id),prior);assert.equal((await f.store.jobs('owner-a','member-a',x.campaign.id)).length,1);
});
