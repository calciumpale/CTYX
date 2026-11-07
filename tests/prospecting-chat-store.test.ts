import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createProspectingStore} from '../app/lib/prospecting-store.ts';
import {createProspectingChatStore} from '../app/lib/prospecting-chat-store.ts';
import {normalizeCampaignInput,normalizeComments,scoreComment} from '../app/lib/prospecting-domain.ts';
import {chooseProspectChatAction} from '../app/lib/prospecting-chat-agent.ts';

function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 for(const file of readdirSync(new URL('../drizzle/',import.meta.url)).filter(x=>x.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(`../drizzle/${file}`,import.meta.url),'utf8'));
 sqlite.exec("INSERT INTO workbench_member_accounts VALUES ('member-a','owner-a','sales-a','销售甲','sales','sales-1',1,'salt','hash',100000,'now','now'),('member-b','owner-a','sales-b','销售乙','sales','sales-2',1,'salt','hash',100000,'now','now'),('manager-a','owner-a','manager','管理者','manager',NULL,1,'salt','hash',100000,'now','now'),('member-z','owner-z','sales-z','其他租户','sales','sales-9',1,'salt','hash',100000,'now','now')");
 let queue:Promise<unknown>=Promise.resolve(),beforeBatch:(()=>void)|undefined;
 const db={prepare(sql:string){let values:unknown[]=[];return{bind(...args:unknown[]){values=args;return this;},async first(){return sqlite.prepare(sql).get(...values as never[])??null;},async all(){return{results:sqlite.prepare(sql).all(...values as never[])};},async run(){return{meta:{changes:Number(sqlite.prepare(sql).run(...values as never[]).changes)}};}};},batch(items:{run:()=>Promise<unknown>}[]){const execute=async()=>{const before=beforeBatch;beforeBatch=undefined;before?.();sqlite.exec('BEGIN');try{const out=[];for(const item of items)out.push(await item.run());sqlite.exec('COMMIT');return out;}catch(error){sqlite.exec('ROLLBACK');throw error;}};const next=queue.then(execute,execute);queue=next.catch(()=>{});return next;}} as unknown as D1Database;
 let time=Date.parse('2026-11-06T04:00:00.000Z');return{sqlite,db,store:createProspectingStore(db,()=>time),chat:createProspectingChatStore(db,()=>time),now:()=>new Date(time).toISOString(),advance:(ms:number)=>{time+=ms;},interceptNextBatch:(hook:()=>void)=>{beforeBatch=hook;}};
}
async function prepared(f:ReturnType<typeof fixture>){
 const device=await f.store.connect('owner-a','member-a','本机');await f.store.seen(device.deviceId,{authenticated:true,accountId:'MS4wSender001'});
 const campaign=await f.store.createCampaign('owner-a','member-a',normalizeCampaignInput({requirements:'海盐商铺租赁咨询',keywords:['海盐商铺'],greetingTemplate:'你好，想了解你的找铺需求。'}));
 const comment=normalizeComments([{id:'comment-chat',videoId:'7654321234567890',text:'想租一个商铺',nickname:'客户甲',profileUrl:'https://www.douyin.com/user/MS4wRecipient001'}],'browser')[0];
 await f.store.insertComments('owner-a','member-a',campaign.id,[scoreComment(comment,campaign)]);const lead=(await f.store.leads('owner-a','member-a',campaign.id))[0];
 await f.store.review('owner-a','member-a',campaign.id,lead.id,lead.version,'approve',lead.greeting,'销售甲');const sent=(await f.store.claim(device.deviceId))!;
 await f.store.complete(device.deviceId,sent.id,sent.leaseToken,{outcome:'submitted'});
 await f.chat.materialize('owner-a','member-a');
 const snapshot=await f.chat.snapshot('owner-a','member-a','sales',campaign.id);
 return{device,campaign,lead,conversation:snapshot.conversations[0]};
}
async function readConversation(f:ReturnType<typeof fixture>,x:Awaited<ReturnType<typeof prepared>>,messages:{id:string;direction:'inbound'|'outbound';text:string;postedAt?:string}[],snapshotId='snapshot-1'){
 await f.store.seen(x.device.deviceId,{authenticated:true,accountId:'MS4wSender001'});
 await f.chat.schedule(x.device.deviceId);const job=(await f.store.claim(x.device.deviceId,false,true))!;assert.equal(job.kind,'readConversation');
 await f.store.complete(x.device.deviceId,job.id,job.leaseToken,{senderAccountId:'MS4wSender001',recipientId:'MS4wRecipient001',observedAt:f.now(),snapshotId,reliable:true,messages});
 return job;
}

test('chat is opt-in and only a capable bridge can read a successfully contacted recipient',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);assert.ok(x.conversation);
 await f.chat.schedule(x.device.deviceId);assert.equal(await f.store.claim(x.device.deviceId,false,true),null);
 await f.chat.settings('owner-a','member-a',x.campaign.id,true);await f.chat.schedule(x.device.deviceId);
 assert.equal(await f.store.claim(x.device.deviceId),null);
 const read=(await f.store.claim(x.device.deviceId,false,true))!;assert.equal(read.kind,'readConversation');assert.equal(read.input.conversationId,x.conversation.id);assert.equal(read.input.senderAccountId,'MS4wSender001');
 await assert.rejects(f.chat.snapshot('owner-z','member-z','sales',x.campaign.id),/不存在|无权/);
});

test('routine reads refresh human conversations after thirty seconds without duplicating active work',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);
 await readConversation(f,x,[]);await f.chat.takeover('owner-a','member-a',x.conversation.id,(await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0].version);
 f.advance(29999);await f.chat.schedule(x.device.deviceId);assert.equal(await f.store.claim(x.device.deviceId,false,true),null);
 f.advance(1);await Promise.all([f.chat.schedule(x.device.deviceId),f.chat.schedule(x.device.deviceId)]);
 const read=(await f.store.claim(x.device.deviceId,false,true))!;assert.equal(read.kind,'readConversation');
 await f.chat.schedule(x.device.deviceId);assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM workbench_prospect_jobs WHERE kind='readConversation' AND status IN ('queued','running')").get()?.n,1);
});

for(const outcome of ['failed','unreliable'] as const)test(`${outcome} reads retain the last reliable observation and retry after fifteen seconds`,async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);
 const baseline=f.now();await readConversation(f,x,[],'reliable-baseline');f.advance(61000);await f.store.seen(x.device.deviceId,{authenticated:true,accountId:'MS4wSender001'});
 await f.chat.schedule(x.device.deviceId);const read=(await f.store.claim(x.device.deviceId,false,true))!;
 if(outcome==='failed')await f.store.complete(x.device.deviceId,read.id,read.leaseToken,undefined,'暂未能核实当前账号，请稍后重新同步；专用浏览器保持打开。');
 else await f.store.complete(x.device.deviceId,read.id,read.leaseToken,{senderAccountId:'MS4wSender001',recipientId:'MS4wRecipient001',observedAt:f.now(),snapshotId:'unreliable-attempt',reliable:false,messages:[]});
 assert.equal(f.sqlite.prepare('SELECT last_read_at FROM workbench_prospect_conversations WHERE id=?').get(x.conversation.id)?.last_read_at,baseline);
 const snapshot=await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id,x.conversation.id);assert.equal(snapshot.conversations[0].lastSyncedAt,baseline);
 f.advance(14999);await f.chat.schedule(x.device.deviceId);assert.equal(await f.store.claim(x.device.deviceId,false,true),null);
 f.advance(1);await f.chat.schedule(x.device.deviceId);assert.equal((await f.store.claim(x.device.deviceId,false,true))?.kind,'readConversation');
});

test('a failed never-synced conversation yields to other due conversations and waits before retrying',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);
 const row=f.sqlite.prepare('SELECT * FROM workbench_prospect_conversations WHERE id=?').get(x.conversation.id)!;
 for(const suffix of ['b','c']){const clone={...row,id:`${x.conversation.id}-${suffix}`,recipient_id:`MS4wRecipient00${suffix}`,profile_url:`https://www.douyin.com/user/MS4wRecipient00${suffix}`};f.sqlite.prepare(`INSERT INTO workbench_prospect_conversations (${Object.keys(clone).join(',')}) VALUES (${Object.keys(clone).map(()=>'?').join(',')})`).run(...Object.values(clone) as never[]);}
 for(const id of [x.conversation.id,`${x.conversation.id}-b`,`${x.conversation.id}-c`]){
  await f.chat.schedule(x.device.deviceId);const read=(await f.store.claim(x.device.deviceId,false,true))!;assert.equal(read.input.conversationId,id);
  await f.store.complete(x.device.deviceId,read.id,read.leaseToken,undefined,'暂未能核实当前账号，请稍后重新同步；专用浏览器保持打开。');
  f.advance(1);
 }
 await f.chat.schedule(x.device.deviceId);assert.equal(await f.store.claim(x.device.deviceId,false,true),null);
 f.advance(15000);await f.chat.schedule(x.device.deviceId);assert.equal((await f.store.claim(x.device.deviceId,false,true))?.input.conversationId,x.conversation.id);
});

for(const outcome of ['failed','unreliable'] as const)test(`${outcome} reads preserve human and business handoff reasons`,async t=>{
 for(const reason of ['已由销售接管','客户要求人工联系，请勿自动回复','需要销售核对价格后继续','上一条回复结果待确认，正在等待可靠的外发消息记录']){
  const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);
  f.sqlite.prepare("UPDATE workbench_prospect_conversations SET mode='human',handoff_reason=? WHERE id=?").run(reason,x.conversation.id);
  await f.chat.schedule(x.device.deviceId);const read=(await f.store.claim(x.device.deviceId,false,true))!;
  if(outcome==='failed')await f.store.complete(x.device.deviceId,read.id,read.leaseToken,undefined,'暂未能核实当前账号，请稍后重新同步；专用浏览器保持打开。');
  else await f.store.complete(x.device.deviceId,read.id,read.leaseToken,{senderAccountId:'MS4wSender001',recipientId:'MS4wRecipient001',observedAt:f.now(),snapshotId:'unreliable-handoff',reliable:false,messages:[]});
  const c=(await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0];assert.equal(c.mode,'human');assert.equal(c.handoffReason,reason);assert.equal(c.lastSyncedAt,undefined);
 }
});

test('manual sync coalesces requests and reads the current conversation without enabling automation',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);
 const sync=()=>f.chat.sync('owner-a','member-a',x.campaign.id,x.conversation.id);
 assert.equal((await Promise.all([sync(),sync()])).filter(Boolean).length,1);
 const snapshot=()=>f.chat.snapshot('owner-a','member-a','sales',x.campaign.id,x.conversation.id);
 assert.equal((await snapshot()).sync?.status,'queued');
 assert.equal(await f.store.claim(x.device.deviceId),null);
 const job=(await f.store.claim(x.device.deviceId,false,true))!;
 assert.equal(job.kind,'readConversation');assert.equal(job.input.conversationId,x.conversation.id);
 assert.equal((await snapshot()).sync?.status,'running');assert.equal(await sync(),false);
 await f.store.renew(x.device.deviceId,job.id,job.leaseToken);
 await f.store.complete(x.device.deviceId,job.id,job.leaseToken,{senderAccountId:'MS4wSender001',recipientId:'MS4wRecipient001',observedAt:f.now(),snapshotId:'manual-read',reliable:true,messages:[{id:'manual-inbound',direction:'inbound',text:'请问怎么预约？',postedAt:f.now()}]});
 const synced=await snapshot();assert.equal(synced.enabled,false);assert.equal(synced.sync?.status,'done');assert.ok(synced.messages.some(item=>item.text==='请问怎么预约？'));
 assert.equal(await sync(),false);
 await f.chat.settings('owner-a','member-a',x.campaign.id,true);
 assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',async()=>({action:'reply',reply:'不应自动回复'})),false);
 f.advance(9000);
 assert.equal(await sync(),true,'operator can read again before the routine 60-second window');
});

test('manual sync enforces conversation ownership, campaign state and connected sender',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);
 await assert.rejects(f.chat.sync('owner-a','member-b',x.campaign.id,x.conversation.id),/无权|不存在/);
 await assert.rejects(f.chat.sync('owner-a','member-a','another-task',x.conversation.id),/无权|不存在/);
 await f.store.setPaused('owner-a','member-a',x.campaign.id,true);
 await assert.rejects(f.chat.sync('owner-a','member-a',x.campaign.id,x.conversation.id),/已暂停/);
 await f.store.setPaused('owner-a','member-a',x.campaign.id,false);
 f.advance(91000);
 await assert.rejects(f.chat.sync('owner-a','member-a',x.campaign.id,x.conversation.id),/启动本机助手/);
});

test('manual sync distinguishes pending account verification from an actual sender mismatch',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);
 await f.store.seen(x.device.deviceId,{authenticated:false});
 await assert.rejects(f.chat.sync('owner-a','member-a',x.campaign.id,x.conversation.id),error=>error instanceof Error&&/核验/.test(error.message)&&!/不一致/.test(error.message));
 f.sqlite.prepare("UPDATE workbench_prospect_devices SET authenticated=1,account_id='MS4wDifferentSender' WHERE id=?").run(x.device.deviceId);
 await assert.rejects(f.chat.sync('owner-a','member-a',x.campaign.id,x.conversation.id),/不一致/);
});

test('an offline assistant hands off with the connection recovery step before queuing a reply',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);
 await readConversation(f,x,[{id:'inbound-ready',direction:'inbound',text:'想了解这里的位置',postedAt:f.now()}]);f.advance(91000);
 await f.chat.processOne('owner-a','member-a','https://example.test',async()=>({action:'reply',reply:'想了解哪个区域？'}));
 const c=(await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0];assert.equal(c.mode,'human');assert.match(c.handoffReason??'',/连接.*本机|本机.*助手/);assert.doesNotMatch(c.handoffReason??'',/账号已改变/);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM workbench_prospect_jobs WHERE kind='reply'").get()?.n,0);
});

test('reply heartbeat rejects takeover committed after validation and before the lease update',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);
 await f.chat.settings('owner-a','member-a',x.campaign.id,true);
 f.advance(61000);
 await readConversation(f,x,[{id:'new-inbound',direction:'inbound',text:'请问怎么预约？',postedAt:f.now()}]);
 await f.chat.processOne('owner-a','member-a','https://example.test',async()=>({action:'reply',reply:'请问你想约哪天？'}));
 const reply=(await f.store.claim(x.device.deviceId,false,true))!;
 assert.equal(reply.kind,'reply');
 const lease=()=>f.sqlite.prepare('SELECT lease_until FROM workbench_prospect_jobs WHERE id=?').get(reply.id)?.lease_until;
 const oldLease=lease();f.advance(1000);
 f.interceptNextBatch(()=>{
  f.sqlite.prepare("UPDATE workbench_prospect_conversations SET mode='human',version=version+1 WHERE id=?").run(x.conversation.id);
 });
 await assert.rejects(f.store.renew(x.device.deviceId,reply.id,reply.leaseToken),/凭证|停止|接管/);
 assert.equal(lease(),oldLease);
});

test('historical inbox baseline does not trigger a reply and duplicate snapshots do not replay an inbound turn',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);
 await readConversation(f,x,[{id:'old',direction:'inbound',text:'旧消息'},{id:'ancient',direction:'inbound',text:'昨天的咨询',postedAt:'2026-11-05T00:00:00.000Z'}]);
 let decisions=0;const decide=async()=>{decisions++;return{action:'reply' as const,reply:'可以介绍一下你的面积需求吗？'};};
 assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',decide),false);assert.equal(decisions,0);
 f.advance(61000);await readConversation(f,x,[{id:'old',direction:'inbound',text:'旧消息'},{id:'new',direction:'inbound',text:'我想找60平米的店面'}],'snapshot-2');
 const results=await Promise.all([f.chat.processOne('owner-a','member-a','https://example.test',decide),f.chat.processOne('owner-a','member-a','https://example.test',decide)]);
 assert.equal(results.filter(Boolean).length,1);assert.equal(decisions,1);
 const jobs=await f.store.jobs('owner-a','member-a',x.campaign.id);assert.equal(jobs.filter(job=>job.kind==='reply').length,1);
 const reply=(await f.store.claim(x.device.deviceId,false,true))!;assert.equal(reply.kind,'reply');assert.equal(reply.input.expectedSnapshotId,'snapshot-2');assert.equal(reply.input.actor,'agent');
 await f.store.complete(x.device.deviceId,reply.id,reply.leaseToken,{outcome:'submitted'});
 f.advance(61000);await readConversation(f,x,[{id:'old',direction:'inbound',text:'旧消息'},{id:'new',direction:'inbound',text:'我想找60平米的店面'}],'snapshot-2');
 assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',decide),false);assert.equal(decisions,1);
});

test('takeover cancels queued agent replies and invalidates a running agent lease; manual reply remains exact',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);f.advance(61000);
 await readConversation(f,x,[{id:'new',direction:'inbound',text:'可以聊聊吗？',postedAt:f.now()}]);
 await f.chat.processOne('owner-a','member-a','https://example.test',async()=>({action:'reply',reply:'你希望什么时候看铺？'}));
 let snapshot=await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id,x.conversation.id);
 await f.chat.takeover('owner-a','member-a',x.conversation.id,snapshot.conversations[0].version);
 assert.equal(await f.store.claim(x.device.deviceId,false,true),null);assert.ok((await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id,x.conversation.id)).messages.some(message=>message.actor==='agent'&&message.status==='cancelled'));
 snapshot=await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id,x.conversation.id);
 await f.chat.reply('owner-a','member-a',x.conversation.id,snapshot.conversations[0].version,'人工回复原文');
 const manual=(await f.store.claim(x.device.deviceId,false,true))!;assert.equal(manual.kind,'reply');assert.equal(manual.input.actor,'human');assert.equal(manual.input.message,'人工回复原文');
 await f.store.complete(x.device.deviceId,manual.id,manual.leaseToken,{outcome:'submitted'});
 f.advance(61000);await readConversation(f,x,[{id:'next',direction:'inbound',text:'好的',postedAt:f.now()}],'snapshot-3');
 snapshot=await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id,x.conversation.id);await f.chat.resume('owner-a','member-a',x.conversation.id,snapshot.conversations[0].version);
 await f.chat.processOne('owner-a','member-a','https://example.test',async()=>({action:'reply',reply:'收到'}));const running=(await f.store.claim(x.device.deviceId,false,true))!;assert.equal(running.kind,'reply');
 snapshot=await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id,x.conversation.id);await f.chat.takeover('owner-a','member-a',x.conversation.id,snapshot.conversations[0].version);
 await assert.rejects(f.store.renew(x.device.deviceId,running.id,running.leaseToken),/接管|会话|停止/);
});

test('human-mode contact capture is evidence checked, deduplicated and scoped to assigned sales or managers',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);
 await f.chat.takeover('owner-a','member-a',x.conversation.id,x.conversation.version);
 await readConversation(f,x,[{id:'contact',direction:'inbound',text:'我手机号是13800138000，可以电话沟通。',postedAt:f.now()}]);
 const decision={action:'reply' as const,reply:'不会自动发出',lead:{contactType:'phone' as const,contactValue:'13800138000',score:85,grade:'high' as const,reason:'客户主动留下手机号'}};
 await f.chat.processOne('owner-a','member-a','https://example.test',async()=>decision);
 const sales=await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id,x.conversation.id);assert.equal(sales.pool.length,1);assert.equal(sales.pool[0].contactValue,'13800138000');assert.equal(sales.pool[0].assignedMemberId,'member-a');assert.equal(sales.pool[0].grade,'high');
 assert.equal((await f.store.jobs('owner-a','member-a',x.campaign.id)).filter(job=>job.kind==='reply').length,0);
 assert.equal((await f.chat.snapshot('owner-a','member-b','sales')).pool.length,0);assert.equal((await f.chat.snapshot('owner-a','manager-a','manager')).pool.length,1);
 f.advance(61000);await readConversation(f,x,[{id:'contact-again',direction:'inbound',text:'还是13800138000',postedAt:f.now()}],'snapshot-2');
 await f.chat.processOne('owner-a','member-a','https://example.test',async()=>decision);assert.equal((await f.chat.snapshot('owner-a','manager-a','manager')).pool.length,1);
 f.advance(61000);await readConversation(f,x,[{id:'other',direction:'inbound',text:'谢谢',postedAt:f.now()}],'snapshot-3');
 await f.chat.processOne('owner-a','member-a','https://example.test',async()=>({...decision,lead:{...decision.lead,contactValue:'13900139000'}}));
 assert.equal((await f.chat.snapshot('owner-a','manager-a','manager')).pool.length,1,'model-invented contact is not stored');
});

test('a wrong-identity or unreliable conversation read never authorizes an automated reply',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);
 await f.chat.schedule(x.device.deviceId);const job=(await f.store.claim(x.device.deviceId,false,true))!;
 await assert.rejects(f.store.complete(x.device.deviceId,job.id,job.leaseToken,{senderAccountId:'another-sender',recipientId:'MS4wRecipient001',observedAt:f.now(),snapshotId:'wrong',reliable:true,messages:[{id:'inbound',direction:'inbound',text:'你好',postedAt:f.now()}]}),/身份|账号/);
 await f.store.complete(x.device.deviceId,job.id,job.leaseToken,{senderAccountId:'MS4wSender001',recipientId:'MS4wRecipient001',observedAt:f.now(),snapshotId:'unreliable',reliable:false,messages:[{id:'inbound',direction:'inbound',text:'你好',postedAt:f.now()}]});
 const snapshot=await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id);assert.equal(snapshot.conversations[0].mode,'human');
 let called=0;await f.chat.processOne('owner-a','member-a','https://example.test',async()=>{called++;return{action:'reply',reply:'不应发送'};});assert.equal(called,0);
 f.advance(61000);await f.store.seen(x.device.deviceId,{authenticated:true,accountId:'MS4wSender001'});
 await readConversation(f,x,[],'recovered');
 const recovered=await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id);
 assert.equal(recovered.conversations[0].mode,'human');
 assert.equal(recovered.conversations[0].handoffReason,'会话已恢复同步，可继续人工回复');
});

test('a covered recent window permits an exact manual reply while unreliable messages remain ineligible for automation',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);f.advance(61000);
 await f.store.seen(x.device.deviceId,{authenticated:true,accountId:'MS4wSender001'});await f.chat.schedule(x.device.deviceId);const read=(await f.store.claim(x.device.deviceId,false,true))!;
 await f.store.complete(x.device.deviceId,read.id,read.leaseToken,{senderAccountId:'MS4wSender001',recipientId:'MS4wRecipient001',observedAt:f.now(),snapshotId:'covered-unreliable',reliable:false,covered:true,messages:[{id:'visible-inbound',direction:'inbound',text:'我想找一个店面',postedAt:f.now()}]});
 let decisions=0;assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',async()=>{decisions++;return{action:'reply',reply:'不能自动发送'};}),false);assert.equal(decisions,0);
 const snapshot=await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id,x.conversation.id);assert.equal(snapshot.conversations[0].mode,'human');assert.ok(snapshot.messages.some(message=>message.text==='我想找一个店面'));
 await f.chat.reply('owner-a','member-a',x.conversation.id,snapshot.conversations[0].version,'人工核对后的回复');
 const reply=(await f.store.claim(x.device.deviceId,false,true))!;assert.equal(reply.kind,'reply');assert.equal(reply.input.actor,'human');assert.equal(reply.input.message,'人工核对后的回复');assert.equal(reply.input.expectedSnapshotId,'covered-unreliable');
});

test('an unreliable read without explicit coverage invalidates an earlier manual reply snapshot',async t=>{
 for(const coverage of [{},{covered:false}]){
  const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);
  await readConversation(f,x,[],'reliable-baseline');f.advance(61000);await f.store.seen(x.device.deviceId,{authenticated:true,accountId:'MS4wSender001'});await f.chat.schedule(x.device.deviceId);const read=(await f.store.claim(x.device.deviceId,false,true))!;
  await f.store.complete(x.device.deviceId,read.id,read.leaseToken,{senderAccountId:'MS4wSender001',recipientId:'MS4wRecipient001',observedAt:f.now(),snapshotId:'uncovered',reliable:false,...coverage,messages:[]});
  const snapshot=await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id,x.conversation.id);
  await assert.rejects(f.chat.reply('owner-a','member-a',x.conversation.id,snapshot.conversations[0].version,'尚不能发送'),/同步/);
 }
});

test('a temporary read failure keeps a verified snapshot usable for an exact manual reply',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);
 await readConversation(f,x,[],'verified-before-read-error');f.advance(61000);await f.store.seen(x.device.deviceId,{authenticated:true,accountId:'MS4wSender001'});
 await f.chat.schedule(x.device.deviceId);const read=(await f.store.claim(x.device.deviceId,false,true))!;
 await f.store.complete(x.device.deviceId,read.id,read.leaseToken,undefined,'会话面板未打开或需要人工操作，未发送。');
 const snapshot=await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id,x.conversation.id);assert.equal(snapshot.conversations[0].mode,'human');
 await f.chat.reply('owner-a','member-a',x.conversation.id,snapshot.conversations[0].version,'继续人工核对回复');
 const reply=(await f.store.claim(x.device.deviceId,false,true))!;assert.equal(reply.kind,'reply');assert.equal(reply.input.actor,'human');assert.equal(reply.input.expectedSnapshotId,'verified-before-read-error');assert.equal(reply.input.message,'继续人工核对回复');
 assert.match(snapshot.conversations[0].handoffReason??'',/^会话同步暂时失败：/);
 assert.equal(f.sqlite.prepare('SELECT status FROM workbench_prospect_jobs WHERE id=?').get(read.id)?.status,'failed');
});

test('a temporary read failure never invents a manual reply snapshot',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);await f.chat.schedule(x.device.deviceId);const read=(await f.store.claim(x.device.deviceId,false,true))!;
 await f.store.complete(x.device.deviceId,read.id,read.leaseToken,undefined,'会话面板未打开或需要人工操作，未发送。');
 const snapshot=await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id,x.conversation.id);
 await assert.rejects(f.chat.reply('owner-a','member-a',x.conversation.id,snapshot.conversations[0].version,'没有已核实快照不能回复'),/同步/);
});

test('a reliable read clears only known stale read failures while preserving human control',async t=>{
 const recovered='会话已恢复同步，可继续人工回复';
 const cases=[
  ['会话同步暂时失败：连接超时',recovered],
  ['会话面板未打开或需要人工操作，未发送。',recovered],
  ['会话读取失败，已转交销售',recovered],
  ['会话读取尚不可靠，已暂停自动回复',recovered],
  ['已由销售接管','已由销售接管'],
  ['上一条回复结果待确认，正在等待可靠的外发消息记录','上一条回复结果待确认，正在等待可靠的外发消息记录'],
  ['客户要求人工联系，请勿自动回复','客户要求人工联系，请勿自动回复'],
 ];
 for(const [reason,expected] of cases){
  const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);
  f.sqlite.prepare("UPDATE workbench_prospect_conversations SET mode='human',handoff_reason=? WHERE id=?").run(reason,x.conversation.id);
  await readConversation(f,x,[],'recovered-reliable');const snapshot=await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id,x.conversation.id);
  assert.equal(snapshot.conversations[0].mode,'human');assert.equal(snapshot.conversations[0].handoffReason,expected);
 }
});

test('conversation coverage accepts only an optional boolean before completing a read job',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);await f.chat.schedule(x.device.deviceId);const read=(await f.store.claim(x.device.deviceId,false,true))!;
 for(const covered of ['true',1,null,{},[]]){
  await assert.rejects(f.store.complete(x.device.deviceId,read.id,read.leaseToken,{senderAccountId:'MS4wSender001',recipientId:'MS4wRecipient001',observedAt:f.now(),snapshotId:'invalid-coverage',reliable:false,covered,messages:[]}),/格式/);
 }
 assert.equal(f.sqlite.prepare('SELECT status FROM workbench_prospect_jobs WHERE id=?').get(read.id)?.status,'running');
});

test('the first reliable greeting anchor admits a newer untimed reply and keeps the greeting display once',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);
 await readConversation(f,x,[{id:'greeting-dom',direction:'outbound',text:x.lead.greeting},{id:'first-reply',direction:'inbound',text:'我想找60平米的店面'}]);
 let received='';await f.chat.processOne('owner-a','member-a','https://example.test',async(_owner,_origin,input)=>{received=input.inbound.text;return{action:'wait'};});
 assert.equal(received,'我想找60平米的店面');
 const snapshot=await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id,x.conversation.id);
 assert.equal(snapshot.messages.filter(message=>message.direction==='outbound'&&message.text===x.lead.greeting).length,1);
});

test('unknown replies do not match old outgoing text and only later timestamped evidence unblocks the conversation',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);f.advance(61000);
 const old={id:'old-outgoing',direction:'outbound' as const,text:'同一条回复',postedAt:'2026-11-05T12:00:00.000Z'};
 await readConversation(f,x,[old]);let snapshot=await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id,x.conversation.id);
 await f.chat.reply('owner-a','member-a',x.conversation.id,snapshot.conversations[0].version,'同一条回复');const job=(await f.store.claim(x.device.deviceId,false,true))!;
 await f.store.complete(x.device.deviceId,job.id,job.leaseToken,{outcome:'unknown',error:'未观察到结果'});
 f.advance(61000);await readConversation(f,x,[old],'snapshot-2');
 assert.equal(f.sqlite.prepare('SELECT status FROM workbench_prospect_jobs WHERE id=?').get(job.id)?.status,'unknown');
 snapshot=await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id,x.conversation.id);
 await assert.rejects(f.chat.reply('owner-a','member-a',x.conversation.id,snapshot.conversations[0].version,'新的回复'),/待确认/);
 await assert.rejects(f.chat.resume('owner-a','member-a',x.conversation.id,snapshot.conversations[0].version),/待确认/);
 f.advance(61000);await readConversation(f,x,[{id:'new-outgoing',direction:'outbound',text:'同一条回复',postedAt:f.now()}],'snapshot-3');
 assert.equal(f.sqlite.prepare('SELECT status FROM workbench_prospect_jobs WHERE id=?').get(job.id)?.status,'done');
 snapshot=await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id,x.conversation.id);
 assert.equal(snapshot.messages.filter(message=>message.text==='同一条回复').length,2,'one historic message and one actual new reply, with no duplicate echo row');
 await f.chat.reply('owner-a','member-a',x.conversation.id,snapshot.conversations[0].version,'新的回复');
});

test('a pre-click failed manual reply may be explicitly queued again without automatic replay',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);f.advance(61000);await readConversation(f,x,[]);
 let snapshot=await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id,x.conversation.id);await f.chat.reply('owner-a','member-a',x.conversation.id,snapshot.conversations[0].version,'人工原文');
 const first=(await f.store.claim(x.device.deviceId,false,true))!;await f.store.complete(x.device.deviceId,first.id,first.leaseToken,{outcome:'failed',error:'发送前页面发生变化'});
 assert.equal((await f.store.jobs('owner-a','member-a',x.campaign.id)).filter(job=>job.kind==='reply').length,1);
 snapshot=await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id,x.conversation.id);await f.chat.reply('owner-a','member-a',x.conversation.id,snapshot.conversations[0].version,'人工原文');
 assert.equal((await f.store.jobs('owner-a','member-a',x.campaign.id)).filter(job=>job.kind==='reply').length,2);assert.equal(await f.store.claim(x.device.deviceId,false,true),null,'retry preserves send cooldown');
});

test('a takeover while a decision is running prevents stale reply and leaves inbound available to capture in human mode',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);
 await readConversation(f,x,[{id:'contact-race',direction:'inbound',text:'我的电话是13800138000',postedAt:f.now()}]);
 let release!:(value:{action:'reply';reply:string})=>void,entered!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;});
 const processing=f.chat.processOne('owner-a','member-a','https://example.test',async()=>{entered();return new Promise(resolve=>{release=resolve;});});await waiting;
 const snapshot=await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id,x.conversation.id);await f.chat.takeover('owner-a','member-a',x.conversation.id,snapshot.conversations[0].version);release({action:'reply',reply:'这条不得发出'});await processing;
 assert.equal((await f.store.jobs('owner-a','member-a',x.campaign.id)).filter(job=>job.kind==='reply').length,0);
 await f.chat.processOne('owner-a','member-a','https://example.test',(owner,origin,input)=>chooseProspectChatAction(input,{}));
 assert.equal((await f.chat.snapshot('owner-a','manager-a','manager')).pool.length,1);
});

test('policy-to-store sensitive multi-message capture hands off and assigns an evidence-backed lead without calling the model',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);
 await readConversation(f,x,[{id:'contact-first',direction:'inbound',text:'我的手机号是13800138000，想预约明天看铺，也想问合同能否改。',postedAt:f.now()},{id:'polite-last',direction:'inbound',text:'谢谢',postedAt:f.now()}]);
 let generated=0;
 await f.chat.processOne('owner-a','member-a','https://example.test',(_owner,_origin,input)=>chooseProspectChatAction(input,{generate:async()=>{generated++;return '{"action":"reply","reply":"不应调用"}';}}));
 const snapshot=await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id,x.conversation.id);
 assert.equal(generated,0);assert.equal(snapshot.conversations[0].mode,'human');assert.equal(snapshot.pool.length,1);assert.equal(snapshot.pool[0].contactValue,'13800138000');assert.equal(snapshot.pool[0].grade,'high');assert.equal(snapshot.pool[0].assignedMemberId,'member-a');
 assert.equal(snapshot.messages.filter(message=>message.actor==='agent').length,0);
});

test('additional contact methods keep the same enabled assignee and assigned sales can read a foreign conversation but not control it',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);
 // Preloading another active customer gives B the lower assignment load.
 f.sqlite.prepare("INSERT INTO workbench_prospect_lead_pool(id,owner_id,conversation_id,contact_key,contact_type,contact_value,nickname,score,grade,reason,assigned_member_id,assigned_name,status,created_at,updated_at) VALUES ('existing-load','owner-a','other-conversation','load','phone','13900139000','已有客户',70,'medium','已有联系','member-a','销售甲','assigned',?,?)").run(f.now(),f.now());
 await readConversation(f,x,[{id:'phone',direction:'inbound',text:'我的手机号是13800138000',postedAt:f.now()}]);await f.chat.processOne('owner-a','member-a','https://example.test',(_owner,_origin,input)=>chooseProspectChatAction(input,{}));
 let assigned=await f.chat.snapshot('owner-a','member-b','sales',undefined,x.conversation.id);assert.equal(assigned.pool[0].assignedMemberId,'member-b');assert.equal(assigned.messages.some(message=>message.text.includes('13800138000')),true);
 await assert.rejects(f.chat.takeover('owner-a','member-b',x.conversation.id,assigned.conversations[0].version),/不存在|无权/);
 // Contact acknowledgement is now a safe reply; complete it before another read.
 f.advance(61000);await f.store.seen(x.device.deviceId,{authenticated:true,accountId:'MS4wSender001'});const acknowledgement=await f.store.claim(x.device.deviceId,false,true);if(acknowledgement?.kind==='reply')await f.store.complete(x.device.deviceId,acknowledgement.id,acknowledgement.leaseToken,{outcome:'submitted'});
 f.advance(61000);await readConversation(f,x,[{id:'email',direction:'inbound',text:'我的邮箱是PERSON@Example.com',postedAt:f.now()}],'snapshot-2');await f.chat.processOne('owner-a','member-a','https://example.test',(_owner,_origin,input)=>chooseProspectChatAction(input,{}));
 assigned=await f.chat.snapshot('owner-a','member-b','sales');assert.equal(assigned.pool.length,2);assert.ok(assigned.pool.every(lead=>lead.assignedMemberId==='member-b'));
});

test('reply policy validates owned libraries and persists memory across store instances',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);
 f.sqlite.prepare("INSERT INTO workbench_knowledge_libraries(id,owner_id,name,created_at) VALUES ('mine','owner-a','招商资料',?),('foreign','owner-z','私有资料',?)").run(f.now(),f.now());
 const policy={libraryIds:['mine'],replyDailyLimit:2,conversationReplyLimit:2,workStart:'08:30',workEnd:'21:30'};
 await assert.rejects(f.chat.settings('owner-a','member-a',x.campaign.id,true,{...policy,libraryIds:['foreign']}),/知识库/);
 await f.chat.settings('owner-a','member-a',x.campaign.id,true,policy);
 await readConversation(f,x,[{id:'needs',direction:'inbound',text:'想找海盐60平米餐饮店',postedAt:f.now()}]);
 const memory={needs:{area:'60平米',category:'餐饮',location:'海盐'},stage:'qualifying' as const,contactCaptured:false,contactDeclines:0,contactAsks:0,summary:'海盐餐饮需求'};
 await f.chat.processOne('owner-a','member-a','https://example.test',async(_owner,_origin,input)=>{assert.deepEqual(input.policy,policy);return{action:'wait',memory};});
 const fresh=createProspectingChatStore(f.db,()=>Date.parse(f.now()));const snapshot=await fresh.snapshot('owner-a','member-a','sales',x.campaign.id);
 assert.deepEqual(snapshot.policy,policy);assert.deepEqual(snapshot.libraries,[{id:'mine',name:'招商资料'}]);assert.deepEqual(snapshot.conversations[0].memory,memory);
});

test('stop requests close durably outside work hours and prevent future greetings across campaigns',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);
 f.advance(12*3600000);await readConversation(f,x,[{id:'stop',direction:'inbound',text:'不要再给我发消息了',postedAt:f.now()}]);
 let calls=0;assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',async()=>{calls++;return{action:'reply',reply:'不应回复'};}),false);assert.equal(calls,0);
 const snapshot=await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id);assert.equal(snapshot.conversations[0].status,'closed');assert.ok(snapshot.conversations[0].closeReason);assert.equal(snapshot.conversations[0].memory?.stage,'closed');
 await assert.rejects(f.chat.resume('owner-a','member-a',x.conversation.id,snapshot.conversations[0].version),/更新|关闭|停止/);
 const campaign=await f.store.createCampaign('owner-a','member-a',normalizeCampaignInput({requirements:'商铺出租咨询服务',keywords:['商铺'],greetingTemplate:'你好'}));
 const comment=normalizeComments([{id:'stop-again',videoId:'7654321234567890',text:'想租商铺',profileUrl:'https://www.douyin.com/user/MS4wRecipient001'}],'browser')[0];
 await f.store.insertComments('owner-a','member-a',campaign.id,[scoreComment(comment,campaign)]);const lead=(await f.store.leads('owner-a','member-a',campaign.id))[0];
 await assert.rejects(f.store.review('owner-a','member-a',campaign.id,lead.id,lead.version,'approve',lead.greeting,'销售甲'),/停止|拒绝|联系/);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS total FROM workbench_prospect_contact_optouts WHERE owner_id=? AND sender_id=? AND recipient_id=?').get('owner-a','MS4wSender001','MS4wRecipient001')?.total,1);
});

test('outside hours inbound remains pending until eligible and queued agent reply rechecks current hours',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true,{libraryIds:[],replyDailyLimit:30,conversationReplyLimit:12,workStart:'13:00',workEnd:'14:00'});
 await readConversation(f,x,[{id:'wait-hours',direction:'inbound',text:'60平米有合适的吗',postedAt:f.now()}]);let calls=0;
 const decide=async()=>{calls++;return{action:'reply' as const,reply:'想做什么业态？'};};
 assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',decide),false);assert.equal(calls,0);assert.equal(f.sqlite.prepare("SELECT processed FROM workbench_prospect_messages WHERE source_key='wait-hours'").get()?.processed,0);
 f.advance(3600000);await f.store.seen(x.device.deviceId,{authenticated:true,accountId:'MS4wSender001'});assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',decide),true);assert.equal(calls,1);
 f.advance(3600000);assert.equal(await f.store.claim(x.device.deviceId,false,true),null,'14:00 end boundary is exclusive');
});

function replyHistory(f:ReturnType<typeof fixture>,x:Awaited<ReturnType<typeof prepared>>,count:number,startedAt:string,campaignId=x.campaign.id){
 for(let i=0;i<count;i++)f.sqlite.prepare("INSERT INTO workbench_prospect_jobs(id,owner_id,member_id,device_id,campaign_id,lead_id,kind,status,input_json,sender_id,started_at,created_at,updated_at) VALUES (?,?,?,?,?,?,'reply','done',?,?,?,?,?)").run(`history-${campaignId}-${i}`,'owner-a','member-a',x.device.deviceId,campaignId,x.lead.id,JSON.stringify({conversationId:x.conversation.id,actor:'agent',recipientId:'MS4wRecipient001'}),'MS4wSender001',startedAt,startedAt,startedAt);
}

test('reply daily cap aggregates across campaigns without consuming the greeting daily limit',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true,{libraryIds:[],replyDailyLimit:1,conversationReplyLimit:12,workStart:'00:00',workEnd:'23:59'});
 f.advance(61000);replyHistory(f,x,1,'2026-11-06T01:00:00.000Z','other-campaign');await readConversation(f,x,[{id:'capped',direction:'inbound',text:'想问下位置',postedAt:f.now()}]);let calls=0;
 assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',async()=>{calls++;return{action:'reply',reply:'在哪里找？'};}),false);assert.equal(calls,0);
 f.sqlite.prepare('UPDATE workbench_prospect_jobs SET started_at=? WHERE id LIKE ?').run('2026-11-05T15:59:59.999Z','history-%');
 assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',async()=>({action:'reply',reply:'在哪里找？'})),true);
 const job=(await f.store.claim(x.device.deviceId,false,true))!;assert.equal(job.kind,'reply');
 f.sqlite.prepare("UPDATE workbench_prospect_campaigns SET data_json=json_set(data_json,'$.chatPolicy.replyDailyLimit',1)").run();
 replyHistory(f,x,1,'2026-11-06T02:00:00.000Z','racing-campaign');await assert.rejects(f.store.renew(x.device.deviceId,job.id,job.leaseToken),/额度|上限|停止|凭证/);
});

test('conversation rolling cap rechecks claim and resumes only after a full 24 hours',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true,{libraryIds:[],replyDailyLimit:30,conversationReplyLimit:1,workStart:'00:00',workEnd:'23:59'});
 f.advance(61000);await readConversation(f,x,[{id:'cap-race',direction:'inbound',text:'想找50平米',postedAt:f.now()}]);await f.chat.processOne('owner-a','member-a','https://example.test',async()=>({action:'reply',reply:'有位置偏好吗？'}));
 replyHistory(f,x,1,'2026-11-05T05:00:00.000Z');assert.equal(await f.store.claim(x.device.deviceId,false,true),null);
 f.advance(3600000);const job=(await f.store.claim(x.device.deviceId,false,true))!;assert.equal(job.kind,'reply');
});

test('saving a narrowed library policy during a decision prevents the stale reply and memory from committing',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);
 await readConversation(f,x,[{id:'policy-race',direction:'inbound',text:'具体租金多少',postedAt:f.now()}]);
 let release!:(value:{action:'reply';reply:string})=>void,entered!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;});
 const processing=f.chat.processOne('owner-a','member-a','https://example.test',async()=>{entered();return new Promise(resolve=>{release=resolve;});});await waiting;
 await f.chat.settings('owner-a','member-a',x.campaign.id,true,{libraryIds:[],replyDailyLimit:29,conversationReplyLimit:12,workStart:'08:30',workEnd:'21:30'});
 release({action:'reply',reply:'旧知识库中的具体租金'});await processing;
 assert.equal((await f.store.jobs('owner-a','member-a',x.campaign.id)).filter(job=>job.kind==='reply').length,0);
 assert.equal(f.sqlite.prepare("SELECT processed FROM workbench_prospect_messages WHERE source_key='policy-race'").get()?.processed,0);
});

test('saving policy cancels queued agent replies and blocks the lease of a running prior policy',async t=>{
 for(const running of [false,true]){
  const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);f.advance(61000);
  await readConversation(f,x,[{id:'policy-old',direction:'inbound',text:'想了解这里租金',postedAt:f.now()}]);await f.chat.processOne('owner-a','member-a','https://example.test',async()=>({action:'reply',reply:'请问你想了解哪个位置？'}));
  const queued=(await f.store.jobs('owner-a','member-a',x.campaign.id)).find(j=>j.kind==='reply')!;const claimed=running?(await f.store.claim(x.device.deviceId,false,true))!:undefined;
  await f.chat.settings('owner-a','member-a',x.campaign.id,true,{libraryIds:[],replyDailyLimit:29,conversationReplyLimit:12,workStart:'08:30',workEnd:'21:30'});
  if(claimed)await assert.rejects(f.store.renew(x.device.deviceId,claimed.id,claimed.leaseToken),/策略|停止|凭证/);
  else {assert.equal(f.sqlite.prepare('SELECT status FROM workbench_prospect_jobs WHERE id=?').get(queued.id)?.status,'cancelled');const snapshot=await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id);assert.equal(snapshot.conversations[0].mode,'human');assert.equal(snapshot.conversations[0].memory?.stage,'handoff');assert.match(snapshot.conversations[0].handoffReason??'',/策略.*销售|策略.*人工/);}
 }
});

test('a policy change between reply validation and renewal is rejected by the atomic lease write',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);f.advance(61000);
 await readConversation(f,x,[{id:'policy-renew',direction:'inbound',text:'附近位置有吗',postedAt:f.now()}]);await f.chat.processOne('owner-a','member-a','https://example.test',async()=>({action:'reply',reply:'想在哪条路附近找？'}));const job=(await f.store.claim(x.device.deviceId,false,true))!;
 f.interceptNextBatch(()=>{f.sqlite.prepare("UPDATE workbench_prospect_campaigns SET data_json=json_set(data_json,'$.chatPolicyVersion',1) WHERE id=?").run(x.campaign.id);});
 await assert.rejects(f.store.renew(x.device.deviceId,job.id,job.leaseToken),/凭证|停止|策略/);
});

test('a reliably observed stop is durable even when manual sync observes a disabled chat',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.sync('owner-a','member-a',x.campaign.id,x.conversation.id);
 const read=(await f.store.claim(x.device.deviceId,false,true))!;await f.store.complete(x.device.deviceId,read.id,read.leaseToken,{senderAccountId:'MS4wSender001',recipientId:'MS4wRecipient001',observedAt:f.now(),snapshotId:'manual-stop',reliable:true,messages:[{id:'manual-stop',direction:'inbound',text:'请不要再联系我',postedAt:f.now()}]});
 assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',async()=>{assert.fail('stop needs no model');}),false);
 assert.equal((await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0].status,'closed');
});

test('stop closes queued jobs across campaigns without rewriting completed history or another owner',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);
 const original=f.sqlite.prepare('SELECT * FROM workbench_prospect_jobs WHERE kind=\'send\'').get();
 const insert=f.sqlite.prepare("INSERT INTO workbench_prospect_jobs(id,owner_id,member_id,device_id,campaign_id,lead_id,kind,status,input_json,sender_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'queued',?,?,?,?)");
 for(const [id,owner,kind] of [['queued-greeting','owner-a','send'],['queued-reply','owner-a','reply'],['other-owner','owner-z','send']])insert.run(id,owner,'member-a',x.device.deviceId,'other-campaign',x.lead.id,kind,JSON.stringify({recipientId:'MS4wRecipient001',conversationId:x.conversation.id,actor:'agent'}),'MS4wSender001',f.now(),f.now());
 await readConversation(f,x,[{id:'stop-all',direction:'inbound',text:'别再发消息了',postedAt:f.now()}]);
 await f.chat.processOne('owner-a','member-a','https://example.test',async()=>{assert.fail('stop needs no model');});
 assert.equal(f.sqlite.prepare("SELECT status FROM workbench_prospect_jobs WHERE id='queued-greeting'").get()?.status,'cancelled');assert.equal(f.sqlite.prepare("SELECT status FROM workbench_prospect_jobs WHERE id='queued-reply'").get()?.status,'cancelled');assert.equal(f.sqlite.prepare("SELECT status FROM workbench_prospect_jobs WHERE id='other-owner'").get()?.status,'queued');
 assert.deepEqual(f.sqlite.prepare('SELECT * FROM workbench_prospect_jobs WHERE id=?').get(original!.id),original);
});

test('the last outbound question disambiguates a visit refusal from a global stop before workhours gating',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);f.advance(61000);await readConversation(f,x,[]);
 let snapshot=await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id,x.conversation.id);await f.chat.reply('owner-a','member-a',x.conversation.id,snapshot.conversations[0].version,'是否需要实地看场？');const reply=(await f.store.claim(x.device.deviceId,false,true))!;await f.store.complete(x.device.deviceId,reply.id,reply.leaseToken,{outcome:'submitted'});
 f.advance(61000);await readConversation(f,x,[{id:'no-visit',direction:'inbound',text:'不需要',postedAt:f.now()}],'no-visit');f.advance(12*3600000);
 assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',async()=>{assert.fail('outside hours must preserve inbound');}),false);
 snapshot=await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id);assert.equal(snapshot.conversations[0].status,'active');assert.equal(f.sqlite.prepare("SELECT processed FROM workbench_prospect_messages WHERE source_key='no-visit'").get()?.processed,0);
});

test('bounded scanning advances past 100 held conversations to an eligible conversation and stop request',async t=>{
 for(const stop of [false,true]){
  const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);
  const held=await f.store.createCampaign('owner-a','member-a',normalizeCampaignInput({requirements:'暂时等待工作时间的会话',keywords:['商铺']}));
  const conversation=f.sqlite.prepare("INSERT INTO workbench_prospect_conversations(id,owner_id,member_id,campaign_id,lead_id,sender_id,recipient_id,profile_url,nickname,opened_at,last_message_at,updated_at) VALUES (?,'owner-a','member-a',?,'held-lead','MS4wSender001',?,'https://www.douyin.com/user/held','等待客户',?,?,?)");
  const inbound=f.sqlite.prepare("INSERT INTO workbench_prospect_messages(id,conversation_id,owner_id,member_id,source_key,direction,actor,text,status,created_at,eligible) VALUES (?,?,'owner-a','member-a',?,'inbound','customer',?,'received',?,1)");
  for(let i=0;i<100;i++){const id=`held-${String(i).padStart(3,'0')}`;conversation.run(id,held.id,id,'2026-11-05T01:00:00.000Z','2026-11-05T01:00:00.000Z',f.now());inbound.run(`msg-${id}`,id,`src-${id}`,'想咨询一下',f.now());}
  if(stop)inbound.run('scan-stop',x.conversation.id,'scan-stop','不要联系我了',f.now());else await readConversation(f,x,[{id:'scan-target',direction:'inbound',text:'想找50平米',postedAt:f.now()}]);let calls=0;
  const decide=async()=>{calls++;return{action:'wait' as const};};
  assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',decide),false);
  assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',decide),true);assert.equal(calls,stop?0:1);
  assert.equal((await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0].status,stop?'closed':'active');
 }
});

test('an old refusal in a first reliable baseline does not opt out a newly opened conversation',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);
 await readConversation(f,x,[{id:'historic-stop',direction:'inbound',text:'不要联系我',postedAt:'2026-11-05T04:00:00.000Z'}]);
 assert.equal((await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0].status,'active');assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM workbench_prospect_contact_optouts').get()?.n,0);
});

test('saving identical normalized policy keeps a queued reply and its policy revision',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);const policy={libraryIds:[],replyDailyLimit:5,conversationReplyLimit:2,workStart:'08:30',workEnd:'21:30'};await f.chat.settings('owner-a','member-a',x.campaign.id,true,policy);
 await readConversation(f,x,[{id:'same-policy',direction:'inbound',text:'想找合适面积',postedAt:f.now()}]);await f.chat.processOne('owner-a','member-a','https://example.test',async()=>({action:'reply',reply:'大概需要多大面积？'}));
 const queued=(await f.store.jobs('owner-a','member-a',x.campaign.id)).find(j=>j.kind==='reply')!;const before=f.sqlite.prepare('SELECT data_json FROM workbench_prospect_campaigns WHERE id=?').get(x.campaign.id)!.data_json;
 await f.chat.settings('owner-a','member-a',x.campaign.id,true,policy);
 assert.equal(f.sqlite.prepare('SELECT data_json FROM workbench_prospect_campaigns WHERE id=?').get(x.campaign.id)!.data_json,before);assert.equal(f.sqlite.prepare('SELECT status FROM workbench_prospect_jobs WHERE id=?').get(queued.id)?.status,'queued');
});

test('legacy contact pool evidence hydrates memory even after contact messages leave the recent history window',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);
 f.sqlite.prepare("INSERT INTO workbench_prospect_lead_pool(id,owner_id,conversation_id,contact_key,contact_type,contact_value,nickname,score,grade,reason,status,created_at,updated_at) VALUES ('legacy-contact','owner-a',?,'legacy-phone','phone','13800138000','已留资客户',80,'high','旧版已捕获联系方式','unassigned',?,?)").run(x.conversation.id,f.now(),f.now());
 const before=await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id);assert.equal(before.conversations[0].memory?.contactCaptured,true);
 await readConversation(f,x,[{id:'legacy-followup',direction:'inbound',text:'还是想找60平米的',postedAt:f.now()}]);let called=false;
 await f.chat.processOne('owner-a','member-a','https://example.test',async(_owner,_origin,input)=>{called=true;assert.equal(input.conversation.memory?.contactCaptured,true);assert.ok(input.messages.every(m=>!m.text.includes('13800138000')));return{action:'wait'};});assert.equal(called,true);
 assert.equal((await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0].memory?.contactCaptured,true);
});

test('a reliably reobserved stop closes after an unreliable read while pre-open history stays unchanged',async t=>{
 for(const historic of [false,true]){
  const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);
  const inbound={id:'reobserved-stop',direction:'inbound' as const,text:'别再联系我',postedAt:historic?'2026-11-05T04:00:00.000Z':f.now()};
  await f.chat.schedule(x.device.deviceId);const first=(await f.store.claim(x.device.deviceId,false,true))!;
  await f.store.complete(x.device.deviceId,first.id,first.leaseToken,{senderAccountId:'MS4wSender001',recipientId:'MS4wRecipient001',observedAt:f.now(),snapshotId:'stop-unreliable',reliable:false,messages:[inbound]});
  assert.equal((await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0].status,'active');assert.notEqual(f.sqlite.prepare("SELECT eligible FROM workbench_prospect_messages WHERE source_key='reobserved-stop'").get()?.eligible,1);
  f.advance(61000);await readConversation(f,x,[inbound],'stop-reliably-confirmed');
  const c=(await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0];assert.equal(c.status,historic?'active':'closed');assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM workbench_prospect_contact_optouts').get()?.n,historic?0:1);
  if(!historic)await assert.rejects(f.chat.resume('owner-a','member-a',c.id,c.version),/关闭|更新|停止/);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM workbench_prospect_messages WHERE source_key='reobserved-stop'").get()?.n,1,'reliable reobservation does not duplicate or replay an inbound row');
 }
});

test('untimed baseline stops stay historical while a new untimed stop after baseline can recover reliability',async t=>{
 for(const historical of [true,false]){
  const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);
  const stop={id:'untimed-stop',direction:'inbound' as const,text:'别再联系我'};
  await readConversation(f,x,historical?[stop]:[],'initial-baseline');
  if(!historical){
   f.advance(61000);await f.store.seen(x.device.deviceId,{authenticated:true,accountId:'MS4wSender001'});await f.chat.schedule(x.device.deviceId);const job=(await f.store.claim(x.device.deviceId,false,true))!;
   await f.store.complete(x.device.deviceId,job.id,job.leaseToken,{senderAccountId:'MS4wSender001',recipientId:'MS4wRecipient001',observedAt:f.now(),snapshotId:'unreliable-after-baseline',reliable:false,messages:[stop]});
  }
  f.advance(61000);await readConversation(f,x,[stop],historical?'initial-baseline':'reliable-after-baseline');
  assert.equal((await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0].status,historical?'active':'closed');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM workbench_prospect_contact_optouts').get()?.n,historical?0:1);
 }
});
