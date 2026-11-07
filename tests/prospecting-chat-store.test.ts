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

test('an offline assistant pauses with the connection recovery step before queuing a reply',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);
 await readConversation(f,x,[{id:'inbound-ready',direction:'inbound',text:'想了解这里的位置',postedAt:f.now()}]);f.advance(91000);
 await f.chat.processOne('owner-a','member-a','https://example.test',async()=>({action:'reply',reply:'想了解哪个区域？'}));
 const c=(await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0];assert.equal(c.mode,'agent');assert.match(c.handoffReason??'',/连接.*本机|本机.*助手/);assert.doesNotMatch(c.handoffReason??'',/账号已改变/);
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
 f.advance(31000);await readConversation(f,x,[{id:'next',direction:'inbound',text:'好的',postedAt:f.now()}],'snapshot-after-resume');
 await f.chat.processOne('owner-a','member-a','https://example.test',async()=>({action:'reply',reply:'收到'}));const running=(await f.store.claim(x.device.deviceId,false,true))!;assert.equal(running.kind,'reply');
 snapshot=await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id,x.conversation.id);await f.chat.takeover('owner-a','member-a',x.conversation.id,snapshot.conversations[0].version);
 await assert.rejects(f.store.renew(x.device.deviceId,running.id,running.leaseToken),/接管|会话|停止/);
});

test('agent-mode contact capture is evidence checked, deduplicated and scoped to assigned sales or managers',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);
 await readConversation(f,x,[{id:'contact',direction:'inbound',text:'我手机号是13800138000，可以电话沟通。',postedAt:f.now()}]);
 const decision={action:'wait' as const,reply:'不会自动发出',lead:{contactType:'phone' as const,contactValue:'13800138000',score:85,grade:'high' as const,reason:'客户主动留下手机号'}};
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
 const snapshot=await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id);assert.equal(snapshot.conversations[0].mode,'agent');
 let called=0;await f.chat.processOne('owner-a','member-a','https://example.test',async()=>{called++;return{action:'reply',reply:'不应发送'};});assert.equal(called,0);
 f.advance(61000);await f.store.seen(x.device.deviceId,{authenticated:true,accountId:'MS4wSender001'});
 await readConversation(f,x,[],'recovered');
 const recovered=await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id);
 assert.equal(recovered.conversations[0].mode,'agent');
 assert.equal(recovered.conversations[0].handoffReason,undefined);
});

test('a covered recent window permits an exact manual reply while unreliable messages remain ineligible for automation',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);f.advance(61000);
 await f.store.seen(x.device.deviceId,{authenticated:true,accountId:'MS4wSender001'});await f.chat.schedule(x.device.deviceId);const read=(await f.store.claim(x.device.deviceId,false,true))!;
 await f.store.complete(x.device.deviceId,read.id,read.leaseToken,{senderAccountId:'MS4wSender001',recipientId:'MS4wRecipient001',observedAt:f.now(),snapshotId:'covered-unreliable',reliable:false,covered:true,messages:[{id:'visible-inbound',direction:'inbound',text:'我想找一个店面',postedAt:f.now()}]});
 let decisions=0;assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',async()=>{decisions++;return{action:'reply',reply:'不能自动发送'};}),false);assert.equal(decisions,0);
 const snapshot=await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id,x.conversation.id);assert.equal(snapshot.conversations[0].mode,'agent');assert.ok(snapshot.messages.some(message=>message.text==='我想找一个店面'));
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

test('a temporary read failure revokes an earlier reply snapshot until fresh synchronization',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);
 await readConversation(f,x,[],'verified-before-read-error');f.advance(61000);await f.store.seen(x.device.deviceId,{authenticated:true,accountId:'MS4wSender001'});
 await f.chat.schedule(x.device.deviceId);const read=(await f.store.claim(x.device.deviceId,false,true))!;
 await f.store.complete(x.device.deviceId,read.id,read.leaseToken,undefined,'会话面板未打开或需要人工操作，未发送。');
 const snapshot=await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id,x.conversation.id);assert.equal(snapshot.conversations[0].mode,'agent');
 await assert.rejects(f.chat.reply('owner-a','member-a',x.conversation.id,snapshot.conversations[0].version,'继续人工核对回复'),/同步/);
 assert.match(snapshot.conversations[0].handoffReason??'',/^会话同步暂时失败：/);
 assert.equal(f.sqlite.prepare('SELECT status FROM workbench_prospect_jobs WHERE id=?').get(read.id)?.status,'failed');
});

test('a temporary read failure never invents a manual reply snapshot',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);await f.chat.schedule(x.device.deviceId);const read=(await f.store.claim(x.device.deviceId,false,true))!;
 await f.store.complete(x.device.deviceId,read.id,read.leaseToken,undefined,'会话面板未打开或需要人工操作，未发送。');
 const snapshot=await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id,x.conversation.id);
 await assert.rejects(f.chat.reply('owner-a','member-a',x.conversation.id,snapshot.conversations[0].version,'没有已核实快照不能回复'),/同步/);
});

test('a reliable read restores known technical pauses while preserving explicit human control',async t=>{
 const recovered=undefined;
 const cases:[string,string|undefined][]=[
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
  assert.equal(snapshot.conversations[0].mode,expected===undefined?'agent':'human');assert.equal(snapshot.conversations[0].handoffReason,expected);
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

test('a takeover while a decision is running prevents stale reply and leaves inbound pending for the salesperson',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);
 await readConversation(f,x,[{id:'contact-race',direction:'inbound',text:'我的电话是13800138000',postedAt:f.now()}]);
 let release!:(value:{action:'reply';reply:string})=>void,entered!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;});
 const processing=f.chat.processOne('owner-a','member-a','https://example.test',async()=>{entered();return new Promise(resolve=>{release=resolve;});});await waiting;
 const snapshot=await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id,x.conversation.id);await f.chat.takeover('owner-a','member-a',x.conversation.id,snapshot.conversations[0].version);release({action:'reply',reply:'这条不得发出'});await processing;
 assert.equal((await f.store.jobs('owner-a','member-a',x.campaign.id)).filter(job=>job.kind==='reply').length,0);
 assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',async()=>{assert.fail('human takeover must not invoke the agent');}),false);
 assert.equal((await f.chat.snapshot('owner-a','manager-a','manager')).pool.length,0);
 assert.equal(f.sqlite.prepare("SELECT processed FROM workbench_prospect_messages WHERE source_key='contact-race'").get()?.processed,0);
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
 const policy={libraryIds:['mine'],replyDailyLimit:2,conversationReplyLimit:2,replyHoursEnabled:false,workStart:'08:30',workEnd:'21:30'};
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
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true,{libraryIds:[],replyDailyLimit:30,conversationReplyLimit:12,replyHoursEnabled:true,workStart:'08:30',workEnd:'21:30'});f.advance(61000);await readConversation(f,x,[]);
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


for(const outcome of ['failed','unreliable'] as const)test(`${outcome} automatic reads pause without consuming inbound and recover after a reliable same-account read`,async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);f.advance(61000);
 const inbound={id:'recoverable-inbound',direction:'inbound' as const,text:'我想找80到100平的空铺',postedAt:f.now()};
 await readConversation(f,x,[inbound],'before-pause');
 f.advance(31000);await f.store.seen(x.device.deviceId,{authenticated:true,accountId:'MS4wSender001'});await f.chat.schedule(x.device.deviceId);const read=(await f.store.claim(x.device.deviceId,false,true))!;
 if(outcome==='failed')await f.store.complete(x.device.deviceId,read.id,read.leaseToken,undefined,'暂未核实当前账号，请等待页面恢复。');
 else await f.store.complete(x.device.deviceId,read.id,read.leaseToken,{senderAccountId:'MS4wSender001',recipientId:'MS4wRecipient001',observedAt:f.now(),snapshotId:'pause-unreliable',reliable:false,covered:true,messages:[inbound]});
 assert.equal((await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0].mode,'agent');
 let calls=0;const decide=async()=>{calls++;return{action:'reply' as const,reply:'您希望在哪个区域找铺？'};};
 assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',decide),false);assert.equal(calls,0);
 assert.equal(f.sqlite.prepare("SELECT processed FROM workbench_prospect_messages WHERE source_key='recoverable-inbound'").get()?.processed,0);
 f.advance(15000);await readConversation(f,x,[inbound],'recovered-pause');
 assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',decide),true);const reply=(await f.store.claim(x.device.deviceId,false,true))!;assert.equal(reply.kind,'reply');assert.equal(reply.input.actor,'agent');
 assert.equal(calls,1);assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',decide),false);
});

test('a reliable retry admits fresh automatically observed unreliable messages once without replaying old or observe-only messages',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);f.advance(61000);
 const old={id:'old-unreliable',direction:'inbound' as const,text:'以前的问题',postedAt:'2026-11-05T04:00:00.000Z'},fresh={id:'fresh-unreliable',direction:'inbound' as const,text:'想找80到100平的空铺',postedAt:f.now()};
 await f.chat.schedule(x.device.deviceId);const job=(await f.store.claim(x.device.deviceId,false,true))!;
 await f.store.complete(x.device.deviceId,job.id,job.leaseToken,{senderAccountId:'MS4wSender001',recipientId:'MS4wRecipient001',observedAt:f.now(),snapshotId:'unverified-fresh',reliable:false,messages:[old,fresh]});
 f.advance(15000);await readConversation(f,x,[old,fresh],'verified-fresh');
 let inputIds:string[]=[];await f.chat.processOne('owner-a','member-a','https://example.test',async(_o,_r,input)=>{inputIds=input.pending!.map(m=>m.text);return{action:'reply',reply:'您希望在哪个区域找铺？'};});
 assert.deepEqual(inputIds,['想找80到100平的空铺']);assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM workbench_prospect_jobs WHERE kind='reply'").get()?.n,1);
 assert.equal(f.sqlite.prepare("SELECT eligible FROM workbench_prospect_messages WHERE source_key='old-unreliable'").get()?.eligible,0);
 const f2=fixture();t.after(()=>f2.sqlite.close());const y=await prepared(f2);await f2.chat.sync('owner-a','member-a',y.campaign.id,y.conversation.id);const observed=(await f2.store.claim(y.device.deviceId,false,true))!;
 await f2.store.complete(y.device.deviceId,observed.id,observed.leaseToken,{senderAccountId:'MS4wSender001',recipientId:'MS4wRecipient001',observedAt:f2.now(),snapshotId:'observe-unreliable',reliable:false,messages:[{...fresh,postedAt:f2.now()}]});
 await f2.chat.settings('owner-a','member-a',y.campaign.id,true);f2.advance(15000);await readConversation(f2,y,[{...fresh,postedAt:f2.now()}],'observe-reliable');
 assert.equal(await f2.chat.processOne('owner-a','member-a','https://example.test',async()=>{assert.fail('observe-only history cannot become automatic');}),false);
});

test('technical recovery restores only the latest unanswered legacy question without replaying answered history',async t=>{
 for(const answered of [false,true,'external'] as const){
  const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);f.advance(61000);
  const first={id:'legacy-earlier',direction:'inbound' as const,text:'您好',postedAt:f.now()};await readConversation(f,x,[first]);f.advance(1000);
  const latest={id:'legacy-latest',direction:'inbound' as const,text:'80到100平空铺有吗',postedAt:f.now()};
  f.advance(30000);await readConversation(f,x,[first,latest],'legacy-before-failure');
  f.sqlite.prepare("UPDATE workbench_prospect_messages SET processed=1 WHERE direction='inbound'").run();
  if(answered==='external'){f.advance(31000);await readConversation(f,x,[first,latest,{id:'external-human-answer',direction:'outbound',text:'销售在抖音中已回复',postedAt:f.now()}],'external-answer');}
  else if(answered){f.advance(61000);let c=(await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0];await f.chat.reply('owner-a','member-a',c.id,c.version,'销售已回复');const reply=(await f.store.claim(x.device.deviceId,false,true))!;await f.store.complete(x.device.deviceId,reply.id,reply.leaseToken,{outcome:'submitted'});}
  f.sqlite.prepare("UPDATE workbench_prospect_conversations SET mode='human',handoff_reason='会话同步暂时失败：暂未核实当前账号，请等待页面恢复。；请稍后重新同步，核实消息后再继续。' WHERE id=?").run(x.conversation.id);
  f.advance(31000);await readConversation(f,x,[first,latest],'legacy-recovered');
  assert.equal((await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0].mode,'agent');
  const seen:string[]=[];const worked=await f.chat.processOne('owner-a','member-a','https://example.test',async(_o,_r,input)=>{seen.push(...input.pending!.map(m=>m.text));return{action:'reply',reply:'您希望在哪个区域找铺？'};});
  assert.equal(worked,!answered);assert.deepEqual(seen,answered?[]:['80到100平空铺有吗']);
  assert.equal(f.sqlite.prepare("SELECT processed FROM workbench_prospect_messages WHERE source_key='legacy-earlier'").get()?.processed,1);
 }
});

test('manual takeover and business handoff keep unanswered questions pending through technical reads',async t=>{
 for(const reason of ['已由销售接管','客户主动要求人工沟通，请直接跟进。','会话策略已更新，原回复已停止，请销售人工继续跟进','上一条回复结果待确认，正在等待可靠的外发消息记录']){
  const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);f.advance(61000);
  await readConversation(f,x,[{id:'manual-pending',direction:'inbound',text:'希望80到100平',postedAt:f.now()}]);f.sqlite.prepare("UPDATE workbench_prospect_conversations SET mode='human',handoff_reason=? WHERE id=?").run(reason,x.conversation.id);
  await f.chat.processOne('owner-a','member-a','https://example.test',(_o,_r,input)=>chooseProspectChatAction(input,{}));
  assert.equal(f.sqlite.prepare("SELECT processed FROM workbench_prospect_messages WHERE source_key='manual-pending'").get()?.processed,0);
  f.advance(31000);await readConversation(f,x,[],'manual-preserved');const c=(await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0];assert.equal(c.mode,'human');assert.equal(c.handoffReason,reason);
 }
});

test('a read failure invalidates a queued reply and an in-flight decision before either can send',async t=>{
 for(const queued of [false,true]){
  const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);f.advance(61000);
  await readConversation(f,x,[{id:'pause-race',direction:'inbound',text:'想找80平',postedAt:f.now()}]);
  let release!:(value:{action:'reply';reply:string})=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
  const processing=f.chat.processOne('owner-a','member-a','https://example.test',async()=>{entered();if(queued)return{action:'reply',reply:'旧回复'};return new Promise(resolve=>{release=resolve;});});await started;if(queued)await processing;
  f.advance(31000);await f.store.seen(x.device.deviceId,{authenticated:true,accountId:'MS4wSender001'});await f.chat.sync('owner-a','member-a',x.campaign.id,x.conversation.id);const read=(await f.store.claim(x.device.deviceId,false,true))!;assert.equal(read.kind,'readConversation');
  await f.store.complete(x.device.deviceId,read.id,read.leaseToken,undefined,'暂未核实当前账号');if(!queued){release({action:'reply',reply:'旧回复'});await processing;}
  assert.equal(await f.store.claim(x.device.deviceId,false,true),null);
  if(!queued)assert.equal(f.sqlite.prepare("SELECT processed FROM workbench_prospect_messages WHERE source_key='pause-race'").get()?.processed,0);
  f.advance(15000);await readConversation(f,x,[{id:'pause-race',direction:'inbound',text:'想找80平',postedAt:'2026-11-06T04:01:01.000Z'}],'race-recovered');
  assert.equal(f.sqlite.prepare("SELECT processed FROM workbench_prospect_messages WHERE source_key='pause-race'").get()?.processed,0);
 }
});

for(const hours of [{replyHoursEnabled:false,workStart:'08:30',workEnd:'21:30',allowed:true},{replyHoursEnabled:true,workStart:'08:30',workEnd:'21:30',allowed:false},{workStart:'08:30',workEnd:'21:30',allowed:true},{workStart:'09:00',workEnd:'18:00',allowed:false},{workStart:'25:00',workEnd:'21:30',allowed:true},{workStart:'09:00',allowed:true}])test(`reply lease honors optional hour switch ${JSON.stringify(hours)}`,async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);f.advance(61000);await readConversation(f,x,[]);
 f.sqlite.prepare("UPDATE workbench_prospect_conversations SET last_snapshot_id='hours-snapshot'").run();
 f.sqlite.prepare("UPDATE workbench_prospect_campaigns SET data_json=json_set(data_json,'$.chatPolicy',json(?))").run(JSON.stringify({libraryIds:[],replyDailyLimit:30,conversationReplyLimit:12,...hours}));
 f.sqlite.prepare("INSERT INTO workbench_prospect_jobs(id,owner_id,member_id,device_id,campaign_id,lead_id,kind,status,input_json,active_key,sender_id,created_at,updated_at) VALUES ('hours-job','owner-a','member-a',?,?,?,'reply','queued',?,'hours-job','MS4wSender001',?,?)").run(x.device.deviceId,x.campaign.id,x.lead.id,JSON.stringify({senderAccountId:'MS4wSender001',recipientId:'MS4wRecipient001',profileUrl:x.conversation.profileUrl,conversationId:x.conversation.id,actor:'agent',message:'您好',replyId:'hours-reply',expectedSnapshotId:'hours-snapshot',policyVersion:0}),f.now(),f.now());
 f.advance(13*3600000);await f.store.seen(x.device.deviceId,{authenticated:true,accountId:'MS4wSender001'});
 assert.equal(Boolean(await f.store.claim(x.device.deviceId,false,true)),hours.allowed);
});


test('a verified pre-dispatch account interruption retries the unanswered turn only after fresh reliable synchronization',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);f.advance(61000);
 const inbound={id:'pre-dispatch-inbound',direction:'inbound' as const,text:'想找80到100平空铺',postedAt:f.now()};await readConversation(f,x,[inbound]);
 const decide=async()=>({action:'reply' as const,reply:'您希望在哪个区域找铺？'});await f.chat.processOne('owner-a','member-a','https://example.test',decide);const first=(await f.store.claim(x.device.deviceId,false,true))!;
 await f.store.complete(x.device.deviceId,first.id,first.leaseToken,{outcome:'failed',retryable:true,errorCode:'ACCOUNT_VERIFICATION_PENDING',error:'暂未核实当前账号，请等待页面恢复。'});
 assert.equal(f.sqlite.prepare('SELECT status FROM workbench_prospect_jobs WHERE id=?').get(first.id)?.status,'failed');
 assert.equal((await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0].mode,'agent');
 assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',decide),false);assert.equal(await f.store.claim(x.device.deviceId,false,true),null);
 f.advance(61000);await readConversation(f,x,[inbound],'snapshot-1');assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',decide),false);
 const second=(await f.store.claim(x.device.deviceId,false,true))!;assert.equal(second.kind,'reply');assert.notEqual(second.id,first.id);assert.equal(second.input.replyId,first.input.replyId);await f.store.complete(x.device.deviceId,second.id,second.leaseToken,{outcome:'submitted'});
 assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',decide),false);
});


test('a takeover committed while a technical recovery is saving keeps manual control',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);
 f.sqlite.prepare("UPDATE workbench_prospect_conversations SET mode='human',handoff_reason='会话同步暂时失败：连接超时' WHERE id=?").run(x.conversation.id);
 await f.chat.schedule(x.device.deviceId);const read=(await f.store.claim(x.device.deviceId,false,true))!;
 f.interceptNextBatch(()=>f.sqlite.prepare("UPDATE workbench_prospect_conversations SET mode='human',handoff_reason='已由销售接管',version=version+1 WHERE id=?").run(x.conversation.id));
 await f.store.complete(x.device.deviceId,read.id,read.leaseToken,{senderAccountId:'MS4wSender001',recipientId:'MS4wRecipient001',observedAt:f.now(),snapshotId:'racing-recovery',reliable:true,messages:[]});
 const c=(await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0];assert.equal(c.mode,'human');assert.equal(c.handoffReason,'已由销售接管');
});

test('a successful manual reply handles only earlier pending questions before automation is resumed',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);f.advance(61000);
 await f.chat.takeover('owner-a','member-a',x.conversation.id,x.conversation.version);
 await readConversation(f,x,[{id:'human-answered',direction:'inbound',text:'80平有吗',postedAt:f.now()}]);
 let c=(await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0];await f.chat.reply('owner-a','member-a',c.id,c.version,'销售已答复您的问题');const job=(await f.store.claim(x.device.deviceId,false,true))!;
 await f.store.complete(x.device.deviceId,job.id,job.leaseToken,{outcome:'submitted'});c=(await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0];await f.chat.resume('owner-a','member-a',c.id,c.version);
 assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',async()=>{assert.fail('manual answer must not replay');}),false);
});


test('technical synchronization never resumes a closed or unresolved conversation',async t=>{
 for(const blocked of ['closed','unknown'] as const){
  const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);
  await f.chat.schedule(x.device.deviceId);const read=(await f.store.claim(x.device.deviceId,false,true))!;
  f.sqlite.prepare("UPDATE workbench_prospect_conversations SET mode='human',handoff_reason='会话同步暂时失败：连接超时',status=? WHERE id=?").run(blocked==='closed'?'closed':'active',x.conversation.id);
  if(blocked==='unknown')f.sqlite.prepare("INSERT INTO workbench_prospect_jobs(id,owner_id,member_id,device_id,campaign_id,lead_id,kind,status,input_json,sender_id,created_at,updated_at) VALUES ('unknown-before-recovery','owner-a','member-a',?,?,?,'reply','unknown',?,'MS4wSender001',?,?)").run(x.device.deviceId,x.campaign.id,x.lead.id,JSON.stringify({conversationId:x.conversation.id,recipientId:'MS4wRecipient001'}),f.now(),f.now());
  await f.store.complete(x.device.deviceId,read.id,read.leaseToken,{senderAccountId:'MS4wSender001',recipientId:'MS4wRecipient001',observedAt:f.now(),snapshotId:`blocked-${blocked}`,reliable:true,messages:[]});
  const c=(await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0];assert.equal(c.mode,'human');assert.equal(c.status,blocked==='closed'?'closed':'active');
 }
});


test('human mode never enters a normal automatic decision and keeps the question pending',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);await readConversation(f,x,[{id:'human-no-decision',direction:'inbound',text:'想找80平空铺',postedAt:f.now()}]);
 let c=(await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0];await f.chat.takeover('owner-a','member-a',c.id,c.version);
 let calls=0;assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',async()=>{calls++;return{action:'reply',reply:'不应判断'};}),false);assert.equal(calls,0);
 assert.equal(f.sqlite.prepare("SELECT processed FROM workbench_prospect_messages WHERE source_key='human-no-decision'").get()?.processed,0);
});

for(const issue of ['offline','unverified'] as const)test(`${issue} readiness pauses the agent without swallowing its unanswered turn`,async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);f.advance(61000);
 const inbound={id:'ready-pending',direction:'inbound' as const,text:'想找80到100平空铺',postedAt:f.now()};await readConversation(f,x,[inbound]);
 if(issue==='offline')f.advance(91000);else f.sqlite.prepare('UPDATE workbench_prospect_devices SET authenticated=0 WHERE id=?').run(x.device.deviceId);
 const decide=async()=>({action:'reply' as const,reply:'您希望在哪个区域找铺？'});await f.chat.processOne('owner-a','member-a','https://example.test',decide);
 const c=(await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0];assert.equal(c.mode,'agent');assert.equal(f.sqlite.prepare("SELECT processed FROM workbench_prospect_messages WHERE source_key='ready-pending'").get()?.processed,0);
 assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',decide),false);
 f.advance(31000);await readConversation(f,x,[inbound],'ready-now-reliable');assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',decide),true);const reply=(await f.store.claim(x.device.deviceId,false,true))!;assert.equal(reply.kind,'reply');
});

test('explicit resume waits for a fresh reliable read then authorizes only the latest unanswered observed question once',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);const first={id:'resume-earlier',direction:'inbound' as const,text:'您好',postedAt:f.now()};f.advance(1000);const latest={id:'resume-latest',direction:'inbound' as const,text:'想找80到100平空铺',postedAt:f.now()};
 await f.chat.sync('owner-a','member-a',x.campaign.id,x.conversation.id);const initial=(await f.store.claim(x.device.deviceId,false,true))!;await f.store.complete(x.device.deviceId,initial.id,initial.leaseToken,{senderAccountId:'MS4wSender001',recipientId:'MS4wRecipient001',observedAt:f.now(),snapshotId:'resume-observe-only',reliable:true,messages:[first,latest]});
 await f.chat.settings('owner-a','member-a',x.campaign.id,true);let c=(await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0];await f.chat.takeover('owner-a','member-a',c.id,c.version);c=(await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0];await f.chat.resume('owner-a','member-a',c.id,c.version);
 c=(await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0];assert.equal(c.handoffReason,'已恢复AI，等待同步核实最新未回复消息');
 const seen:string[]=[];const decide=async(_o:string,_r:string,input:Parameters<typeof chooseProspectChatAction>[0])=>{seen.push(...input.pending!.map(m=>m.text));return{action:'reply' as const,reply:'您希望在哪个区域找铺？'};};assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',decide),false);
 f.advance(31000);await readConversation(f,x,[first,latest],'resume-verified-now');assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',decide),true);assert.deepEqual(seen,['想找80到100平空铺']);
 assert.equal(f.sqlite.prepare("SELECT eligible FROM workbench_prospect_messages WHERE source_key='resume-earlier'").get()?.eligible,0);assert.equal(f.sqlite.prepare("SELECT eligible FROM workbench_prospect_messages WHERE source_key='resume-latest'").get()?.eligible,1);
 f.advance(61000);const reply=(await f.store.claim(x.device.deviceId,false,true))!;await f.store.complete(x.device.deviceId,reply.id,reply.leaseToken,{outcome:'submitted'});f.advance(31000);await readConversation(f,x,[first,latest],'resume-verified-again');assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',decide),false);
});

for(const blocked of ['history','answered','unknown','running','takeover','read-error'] as const)test(`explicit resume preserves the ${blocked} boundary before admitting observe-only history`,async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);f.advance(61000);
 const inbound={id:'resume-boundary',direction:'inbound' as const,text:'想找80到100平空铺',postedAt:blocked==='history'?'2026-11-05T04:00:00.000Z':f.now()};
 await f.chat.sync('owner-a','member-a',x.campaign.id,x.conversation.id);const initial=(await f.store.claim(x.device.deviceId,false,true))!;await f.store.complete(x.device.deviceId,initial.id,initial.leaseToken,{senderAccountId:'MS4wSender001',recipientId:'MS4wRecipient001',observedAt:f.now(),snapshotId:'resume-boundary-before',reliable:true,messages:[inbound]});
 await f.chat.settings('owner-a','member-a',x.campaign.id,true);let c=(await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0];await f.chat.takeover('owner-a','member-a',c.id,c.version);c=(await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0];
 if(blocked==='unknown'||blocked==='running'){
  f.sqlite.prepare("INSERT INTO workbench_prospect_jobs(id,owner_id,member_id,device_id,campaign_id,lead_id,kind,status,input_json,sender_id,created_at,updated_at,lease_until) VALUES ('blocked-resume','owner-a','member-a',?,?,?,'reply',?,?,'MS4wSender001',?,?,?)").run(x.device.deviceId,x.campaign.id,x.lead.id,blocked,JSON.stringify({conversationId:c.id,recipientId:'MS4wRecipient001'}),f.now(),f.now(),'2026-12-01T04:00:00.000Z');
  await assert.rejects(f.chat.resume('owner-a','member-a',c.id,c.version),/执行|待确认/);return;
 }
 await f.chat.resume('owner-a','member-a',c.id,c.version);c=(await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0];
 if(blocked==='takeover')await f.chat.takeover('owner-a','member-a',c.id,c.version);
 f.advance(31000);
 if(blocked==='read-error'){
  await f.store.seen(x.device.deviceId,{authenticated:true,accountId:'MS4wSender001'});await f.chat.schedule(x.device.deviceId);const failed=(await f.store.claim(x.device.deviceId,false,true))!;await f.store.complete(x.device.deviceId,failed.id,failed.leaseToken,undefined,'暂未核实当前账号');
  assert.equal((await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0].handoffReason,'已恢复AI，等待同步核实最新未回复消息');f.advance(15000);
 }
 await readConversation(f,x,blocked==='answered'?[inbound,{id:'human-after-question',direction:'outbound',text:'销售已回复',postedAt:f.now()}]:[inbound],`resume-boundary-${blocked}`);
 let calls=0;const worked=await f.chat.processOne('owner-a','member-a','https://example.test',async()=>{calls++;return{action:'reply',reply:'您希望在哪个区域找铺？'};});assert.equal(worked,blocked==='read-error');assert.equal(calls,blocked==='read-error'?1:0);
});


test('an account change while a resume read is running cannot authorize the old sender question',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);f.advance(61000);const inbound={id:'resume-account-check',direction:'inbound' as const,text:'想找80平空铺',postedAt:f.now()};
 await f.chat.sync('owner-a','member-a',x.campaign.id,x.conversation.id);const first=(await f.store.claim(x.device.deviceId,false,true))!;await f.store.complete(x.device.deviceId,first.id,first.leaseToken,{senderAccountId:'MS4wSender001',recipientId:'MS4wRecipient001',observedAt:f.now(),snapshotId:'resume-old-sender',reliable:true,messages:[inbound]});
 await f.chat.settings('owner-a','member-a',x.campaign.id,true);let c=(await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0];await f.chat.resume('owner-a','member-a',c.id,c.version);f.advance(31000);await f.chat.schedule(x.device.deviceId);const read=(await f.store.claim(x.device.deviceId,false,true))!;
 f.sqlite.prepare("UPDATE workbench_prospect_devices SET account_id='MS4wDifferentSender' WHERE id=?").run(x.device.deviceId);
 await f.store.complete(x.device.deviceId,read.id,read.leaseToken,{senderAccountId:'MS4wSender001',recipientId:'MS4wRecipient001',observedAt:f.now(),snapshotId:'resume-account-changed',reliable:true,messages:[inbound]});
 assert.equal(f.sqlite.prepare("SELECT eligible FROM workbench_prospect_messages WHERE source_key='resume-account-check'").get()?.eligible,0);assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',async()=>{assert.fail('old sender must remain paused');}),false);
});


test('explicit resume does not replay an already eligible question answered directly in Douyin',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);f.advance(61000);
 const inbound={id:'resume-eligible-answered',direction:'inbound' as const,text:'80平空铺有吗',postedAt:f.now()};await readConversation(f,x,[inbound]);let c=(await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0];await f.chat.takeover('owner-a','member-a',c.id,c.version);c=(await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0];await f.chat.resume('owner-a','member-a',c.id,c.version);
 f.advance(31000);await readConversation(f,x,[inbound,{id:'resume-direct-answer',direction:'outbound',text:'销售已在抖音中答复',postedAt:f.now()}],'resume-with-human-answer');
 assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',async()=>{assert.fail('an eligible but answered question must not replay');}),false);
});


function addSendRetryLineage(f:ReturnType<typeof fixture>,x:Awaited<ReturnType<typeof prepared>>,variant='direct'){
 const original=f.sqlite.prepare("SELECT * FROM workbench_prospect_jobs WHERE kind='send' AND campaign_id=? LIMIT 1").get(x.campaign.id)!;
 f.sqlite.prepare("UPDATE workbench_prospect_jobs SET status=? WHERE id=?").run(variant==='running'?'running':'unknown',original.id);
 const base=JSON.parse(String(original.input_json));
 const insert=(id:string,parent:string|undefined,status='done',changes:Record<string,unknown>={},inputChanges:Record<string,unknown>={})=>{
  const input={...base,...inputChanges,...(parent?{retry:{previousJobId:parent}}:{})};
  const clone={...original,id,status,input_json:JSON.stringify(input),active_key:null,recipient_key:null,lease_hash:null,lease_until:null,...changes};
  f.sqlite.prepare(`INSERT INTO workbench_prospect_jobs (${Object.keys(clone).join(',')}) VALUES (${Object.keys(clone).map(()=>'?').join(',')})`).run(...Object.values(clone) as never[]);
 };
 let parent=String(original.id);
 if(variant==='indirect'){insert('retry-middle',parent,'failed');parent='retry-middle';}
 if(variant==='too-deep')for(let i=0;i<101;i++){const id=`retry-depth-${i}`;insert(id,parent,'failed');parent=id;}
 const changes:Record<string,unknown>={};
 if(variant==='other-owner')changes.owner_id='owner-z';if(variant==='other-member')changes.member_id='member-b';if(variant==='other-sender')changes.sender_id='MS4wDifferentSender';if(variant==='other-campaign')changes.campaign_id='other-campaign';
 insert('retry-completed',variant==='ordinary-done'?undefined:parent,'done',changes,variant==='changed-message'?{message:'更改后的招呼'}:variant==='other-recipient'?{recipientId:'MS4wOtherRecipient'}:{});
 if(variant==='missing-parent'||variant==='cycle')f.sqlite.prepare('UPDATE workbench_prospect_jobs SET input_json=? WHERE id=?').run(JSON.stringify({...base,retry:{previousJobId:variant==='cycle'?'retry-completed':'missing-parent'}}),original.id);
 return String(original.id);
}

for(const variant of ['direct','indirect'])test(`a valid ${variant} completed greeting retry unblocks the same conversation without rewriting its unknown ancestor`,async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);const oldId=addSendRetryLineage(f,x,variant);await f.chat.settings('owner-a','member-a',x.campaign.id,true);f.advance(61000);
 const inbound={id:'resolved-send-question',direction:'inbound' as const,text:'80到100平空铺有吗',postedAt:f.now()};await readConversation(f,x,[inbound]);let c=(await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations.find(c=>c.id===x.conversation.id)!;await f.chat.takeover('owner-a','member-a',c.id,c.version);c=(await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations.find(c=>c.id===x.conversation.id)!;
 await f.chat.resume('owner-a','member-a',c.id,c.version);f.advance(31000);await readConversation(f,x,[inbound],'resolved-send-reliable');assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',async()=>({action:'reply',reply:'您希望在哪个区域找铺？'})),true);
 const next=(await f.store.claim(x.device.deviceId,false,true))!;assert.equal(next.kind,'reply');assert.equal(f.sqlite.prepare('SELECT status FROM workbench_prospect_jobs WHERE id=?').get(oldId)?.status,'unknown');assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM workbench_prospect_jobs WHERE kind='send'").get()?.n,variant==='direct'?2:3);
});

for(const variant of ['ordinary-done','changed-message','other-owner','other-member','other-sender','other-campaign','other-recipient','missing-parent','cycle','too-deep','running'])test(`a ${variant} greeting lineage never clears the unresolved sending boundary`,async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);addSendRetryLineage(f,x,variant);await f.chat.settings('owner-a','member-a',x.campaign.id,true);let c=(await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations.find(c=>c.id===x.conversation.id)!;await f.chat.takeover('owner-a','member-a',c.id,c.version);c=(await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations.find(c=>c.id===x.conversation.id)!;
 await assert.rejects(f.chat.resume('owner-a','member-a',c.id,c.version),/执行|待确认/);
});

test('a retry lineage changed before the control transaction cannot authorize a stale resume',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);addSendRetryLineage(f,x);await f.chat.settings('owner-a','member-a',x.campaign.id,true);let c=(await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations.find(c=>c.id===x.conversation.id)!;await f.chat.takeover('owner-a','member-a',c.id,c.version);c=(await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations.find(c=>c.id===x.conversation.id)!;
 f.interceptNextBatch(()=>f.sqlite.prepare("UPDATE workbench_prospect_jobs SET input_json=json_set(input_json,'$.message','已变更批准内容') WHERE id='retry-completed'").run());
 await assert.rejects(f.chat.resume('owner-a','member-a',c.id,c.version),/更新|改变/);assert.equal((await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations.find(c=>c.id===x.conversation.id)!.mode,'human');
});


test('an outbound-only resume snapshot cannot replay a question outside its visible window',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);f.advance(61000);
 await readConversation(f,x,[{id:'omitted-resume-question',direction:'inbound',text:'80平有吗',postedAt:f.now()}]);let c=(await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0];await f.chat.takeover('owner-a','member-a',c.id,c.version);c=(await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0];await f.chat.resume('owner-a','member-a',c.id,c.version);
 f.advance(31000);await readConversation(f,x,[{id:'outbound-only-answer',direction:'outbound',text:'销售已在抖音中答复',postedAt:f.now()}],'outbound-only-resume');
 assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',async()=>{assert.fail('a partial window must not replay its omitted pending question');}),false);
 assert.equal((await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0].handoffReason,'已恢复AI，等待同步核实最新未回复消息');
});


test('a readiness pause commits neither per-turn memory nor lead capture before the turn can be queued',async t=>{
 for(const contact of [false,true]){
  const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);f.advance(61000);
  const inbound={id:'memory-once',direction:'inbound' as const,text:contact?'我的手机号是13800138000，可以电话沟通。':'暂不留联系方式',postedAt:f.now()};await readConversation(f,x,[inbound]);f.sqlite.prepare('UPDATE workbench_prospect_devices SET authenticated=0 WHERE id=?').run(x.device.deviceId);
  const decide=(_o:string,_r:string,input:Parameters<typeof chooseProspectChatAction>[0])=>chooseProspectChatAction(input,{});await f.chat.processOne('owner-a','member-a','https://example.test',decide);
  let c=(await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0];assert.equal(c.memory!.contactDeclines,0);assert.equal(c.memory!.contactAsks,0);assert.equal((await f.chat.snapshot('owner-a','manager-a','manager')).pool.length,0);
  f.advance(31000);await readConversation(f,x,[inbound],'memory-once-reliable');await f.chat.processOne('owner-a','member-a','https://example.test',decide);
  c=(await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0];assert.equal(c.memory!.contactDeclines,contact?0:1);assert.equal((await f.chat.snapshot('owner-a','manager-a','manager')).pool.length,contact?1:0);
 }
});

test('a retry chain invalidated before queue insertion cannot authorize a reply',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);addSendRetryLineage(f,x);await f.chat.settings('owner-a','member-a',x.campaign.id,true);f.advance(61000);await readConversation(f,x,[{id:'atomic-lineage-question',direction:'inbound',text:'80平有吗',postedAt:f.now()}]);
 f.interceptNextBatch(()=>f.sqlite.prepare("UPDATE workbench_prospect_jobs SET input_json=json_set(input_json,'$.message','已变更批准内容') WHERE id='retry-completed'").run());
 await f.chat.processOne('owner-a','member-a','https://example.test',async()=>({action:'reply',reply:'您希望在哪个区域找铺？'}));assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM workbench_prospect_jobs WHERE kind='reply' AND status='queued'").get()?.n,0);
});


async function waitingReply(f:ReturnType<typeof fixture>){
 const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true,{libraryIds:[],replyDailyLimit:1,conversationReplyLimit:1,replyHoursEnabled:false,workStart:'08:30',workEnd:'21:30'});f.advance(61000);
 const inbound={id:'waiting-turn',direction:'inbound' as const,text:'想找80到100平空铺',postedAt:f.now()};await readConversation(f,x,[inbound],'waiting-original');let decisions=0;
 const decide=async()=>{decisions++;return{action:'reply' as const,reply:'您希望在哪个区域找铺？',memory:{needs:{},stage:'qualifying' as const,contactCaptured:false,contactDeclines:1,contactAsks:1,summary:'同一轮只更新一次'}};};
 await f.chat.processOne('owner-a','member-a','https://example.test',decide);const first=(await f.store.claim(x.device.deviceId,false,true))!;
 const failed=async(job:typeof first)=>f.store.complete(x.device.deviceId,job.id,job.leaseToken,{outcome:'failed',retryable:true,errorCode:'ACCOUNT_VERIFICATION_PENDING',error:'暂未核实当前账号，请等待页面恢复。'});await failed(first);
 return{x,inbound,first,decide,failed,decisions:()=>decisions};
}

test('a verified pre-dispatch wait retains one reply, memory and processed turn without consuming reply quota',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const w=await waitingReply(f);const chat=await f.chat.snapshot('owner-a','member-a','sales',w.x.campaign.id,w.x.conversation.id);const out=chat.messages.filter(m=>m.actor==='agent');
 assert.equal(out.length,1);assert.equal(out[0].status,'waiting');assert.equal(out[0].retryable,true);assert.equal(out[0].retryExhausted,false);assert.equal(out[0].retryAt,new Date(Date.parse(f.now())+60000).toISOString());assert.equal(chat.conversations[0].memory!.contactDeclines,1);
 assert.equal(f.sqlite.prepare("SELECT processed FROM workbench_prospect_messages WHERE source_key='waiting-turn'").get()?.processed,1);assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',w.decide),false);assert.equal(w.decisions(),1);
 f.advance(31000);await readConversation(f,w.x,[w.inbound],'waiting-original');assert.equal(await f.store.claim(w.x.device.deviceId,false,true),null);
 f.advance(31000);await readConversation(f,w.x,[w.inbound],'waiting-original');const retry=(await f.store.claim(w.x.device.deviceId,false,true))!;assert.equal(retry.kind,'reply');assert.notEqual(retry.id,w.first.id);assert.equal(retry.input.replyId,w.first.input.replyId);assert.deepEqual(retry.input,w.first.input);
 await f.store.complete(w.x.device.deviceId,w.first.id,w.first.leaseToken,{outcome:'submitted'});assert.equal(f.sqlite.prepare('SELECT job_id FROM workbench_prospect_messages WHERE id=?').get(String(w.first.input.replyId))?.job_id,retry.id);
 await f.store.complete(w.x.device.deviceId,retry.id,retry.leaseToken,{outcome:'submitted'});assert.equal((await f.chat.snapshot('owner-a','member-a','sales',w.x.campaign.id,w.x.conversation.id)).messages.filter(m=>m.actor==='agent').length,1);assert.equal(w.decisions(),1);
});

test('a logical reply automatically retries twice then needs one manual sync authorization after cooldown',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const w=await waitingReply(f);
 f.advance(61000);await readConversation(f,w.x,[w.inbound],'waiting-original');const second=(await f.store.claim(w.x.device.deviceId,false,true))!;assert.equal(second.input.replyId,w.first.input.replyId);await w.failed(second);
 f.advance(61000);await readConversation(f,w.x,[w.inbound],'waiting-original');assert.equal(await f.store.claim(w.x.device.deviceId,false,true),null);
 f.advance(240000);await readConversation(f,w.x,[w.inbound],'waiting-original');const third=(await f.store.claim(w.x.device.deviceId,false,true))!;assert.equal(third.input.replyId,w.first.input.replyId);await w.failed(third);
 f.advance(31000);await readConversation(f,w.x,[w.inbound],'waiting-original');assert.equal(await f.store.claim(w.x.device.deviceId,false,true),null);assert.equal((await f.chat.snapshot('owner-a','member-a','sales',w.x.campaign.id,w.x.conversation.id)).messages.find(m=>m.id===w.first.input.replyId)!.retryExhausted,true);
 f.advance(9000);await f.chat.sync('owner-a','member-a',w.x.campaign.id,w.x.conversation.id);const manual=(await f.store.claim(w.x.device.deviceId,false,true))!;assert.equal(manual.kind,'readConversation');await f.store.complete(w.x.device.deviceId,manual.id,manual.leaseToken,{senderAccountId:'MS4wSender001',recipientId:'MS4wRecipient001',observedAt:f.now(),snapshotId:'waiting-original',reliable:true,messages:[w.inbound]});assert.equal(await f.store.claim(w.x.device.deviceId,false,true),null);
 f.advance(260000);await readConversation(f,w.x,[w.inbound],'waiting-original');const fourth=(await f.store.claim(w.x.device.deviceId,false,true))!;assert.equal(fourth.input.replyId,w.first.input.replyId);await w.failed(fourth);
 f.advance(600000);await readConversation(f,w.x,[w.inbound],'waiting-original');assert.equal(await f.store.claim(w.x.device.deviceId,false,true),null);assert.equal(w.decisions(),1);assert.equal((await f.chat.snapshot('owner-a','member-a','sales',w.x.campaign.id,w.x.conversation.id)).messages.filter(m=>m.actor==='agent').length,1);
});

for(const change of ['snapshot','new-inbound','new-outbound','takeover','pause','disable','policy','disconnect'] as const)test(`a ${change} change cancels a waiting logical reply instead of resending its old draft`,async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const w=await waitingReply(f);f.advance(61000);
 if(change==='takeover'){const c=(await f.chat.snapshot('owner-a','member-a','sales',w.x.campaign.id)).conversations[0];await f.chat.takeover('owner-a','member-a',c.id,c.version);}
 else if(change==='pause')await f.store.setPaused('owner-a','member-a',w.x.campaign.id,true);
 else if(change==='disable')await f.chat.settings('owner-a','member-a',w.x.campaign.id,false);
 else if(change==='policy')await f.chat.settings('owner-a','member-a',w.x.campaign.id,true,{libraryIds:[],replyDailyLimit:2,conversationReplyLimit:1,replyHoursEnabled:false,workStart:'08:30',workEnd:'21:30'});
 else if(change==='disconnect')await f.store.disconnect('owner-a','member-a');
 else await readConversation(f,w.x,change==='new-inbound'?[w.inbound,{id:'new-turn-after-wait',direction:'inbound',text:'还有其他区域吗',postedAt:f.now()}]:change==='new-outbound'?[w.inbound,{id:'external-after-wait',direction:'outbound',text:'销售已在抖音答复',postedAt:f.now()}]:[w.inbound],change==='snapshot'?'changed-waiting-snapshot':'waiting-original');
 const m=(await f.chat.snapshot('owner-a','member-a','sales',w.x.campaign.id,w.x.conversation.id)).messages.find(m=>m.id===w.first.input.replyId)!;assert.equal(m.status,'cancelled');if(change==='disconnect')await assert.rejects(f.store.claim(w.x.device.deviceId,false,true),/停用/);else assert.equal(await f.store.claim(w.x.device.deviceId,false,true),null);
 if(change==='new-inbound'){assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',w.decide),true);const next=(await f.store.claim(w.x.device.deviceId,false,true))!;assert.equal(next.kind,'reply');assert.notEqual(next.input.replyId,w.first.input.replyId);}
});


test('a policy-cancelled waiting draft cannot be rearmed by later technical recovery of the old question',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const w=await waitingReply(f);await f.chat.settings('owner-a','member-a',w.x.campaign.id,true,{libraryIds:[],replyDailyLimit:2,conversationReplyLimit:1,replyHoursEnabled:false,workStart:'08:30',workEnd:'21:30'});
 f.advance(61000);await readConversation(f,w.x,[w.inbound],'waiting-original');assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',w.decide),false);assert.equal(w.decisions(),1);
});

test('a takeover while a waiting draft is being requeued prevents the child lease',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const w=await waitingReply(f);f.advance(61000);await f.store.seen(w.x.device.deviceId,{authenticated:true,accountId:'MS4wSender001'});await f.chat.schedule(w.x.device.deviceId);const read=(await f.store.claim(w.x.device.deviceId,false,true))!;
 f.interceptNextBatch(()=>f.sqlite.prepare("UPDATE workbench_prospect_conversations SET mode='human',handoff_reason='已由销售接管',version=version+1 WHERE id=?").run(w.x.conversation.id));
 await f.store.complete(w.x.device.deviceId,read.id,read.leaseToken,{senderAccountId:'MS4wSender001',recipientId:'MS4wRecipient001',observedAt:f.now(),snapshotId:'waiting-original',reliable:true,messages:[w.inbound]});assert.equal(await f.store.claim(w.x.device.deviceId,false,true),null);assert.equal(w.decisions(),1);
});

test('a reliably observed stop cancels a waiting draft and can never authorize a retry',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const w=await waitingReply(f);f.advance(61000);await readConversation(f,w.x,[w.inbound,{id:'stop-after-wait',direction:'inbound',text:'不要再联系我',postedAt:f.now()}],'waiting-stop');
 const chat=await f.chat.snapshot('owner-a','member-a','sales',w.x.campaign.id,w.x.conversation.id);assert.equal(chat.conversations[0].status,'closed');assert.equal(chat.messages.find(m=>m.id===w.first.input.replyId)!.status,'cancelled');assert.equal(await f.store.claim(w.x.device.deviceId,false,true),null);assert.equal(w.decisions(),1);
});

test('a failed manual reply stays an auditable failure without automatic retry enrollment',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);f.advance(61000);await readConversation(f,x,[],'manual-retry-proof');const c=(await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0];await f.chat.reply('owner-a','member-a',c.id,c.version,'人工明确回复');const job=(await f.store.claim(x.device.deviceId,false,true))!;
 await f.store.complete(x.device.deviceId,job.id,job.leaseToken,{outcome:'failed',retryable:true,errorCode:'ACCOUNT_VERIFICATION_PENDING',error:'暂未核实账号'});let m=(await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id,x.conversation.id)).messages.find(m=>m.id===job.input.replyId)!;assert.equal(m.status,'failed');assert.equal(m.retryable,true);
 f.advance(61000);await readConversation(f,x,[],'manual-retry-proof');assert.equal(await f.store.claim(x.device.deviceId,false,true),null);
});


for(const action of ['takeover','pause','takeover-race'] as const)test(`a late pre-dispatch completion after ${action} cannot recreate a waiting reply`,async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);f.advance(61000);await readConversation(f,x,[{id:'late-pre-dispatch',direction:'inbound',text:'想找80平空铺',postedAt:f.now()}]);await f.chat.processOne('owner-a','member-a','https://example.test',async()=>({action:'reply',reply:'您希望在哪个区域找铺？'}));const job=(await f.store.claim(x.device.deviceId,false,true))!;
 if(action==='takeover'){const c=(await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).conversations[0];await f.chat.takeover('owner-a','member-a',c.id,c.version);}
 else if(action==='pause')await f.store.setPaused('owner-a','member-a',x.campaign.id,true);
 else f.interceptNextBatch(()=>f.sqlite.prepare("UPDATE workbench_prospect_conversations SET mode='human',handoff_reason='已由销售接管',version=version+1 WHERE id=?").run(x.conversation.id));
 await f.store.complete(x.device.deviceId,job.id,job.leaseToken,{outcome:'failed',retryable:true,errorCode:'ACCOUNT_VERIFICATION_PENDING',error:'账号待核验'});const chat=await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id,x.conversation.id);assert.equal(chat.messages.find(m=>m.id===job.input.replyId)!.status,'cancelled');if(action!=='pause'){assert.equal(chat.conversations[0].mode,'human');assert.equal(chat.conversations[0].handoffReason,'已由销售接管');}
});


test('a confirmed delayed retry reconciles its platform echo against the latest attempt without a duplicate bubble',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const w=await waitingReply(f);
 f.advance(61000);await readConversation(f,w.x,[w.inbound],'waiting-original');const second=(await f.store.claim(w.x.device.deviceId,false,true))!;await w.failed(second);
 f.advance(301000);await readConversation(f,w.x,[w.inbound],'waiting-original');const third=(await f.store.claim(w.x.device.deviceId,false,true))!;await f.store.complete(w.x.device.deviceId,third.id,third.leaseToken,{outcome:'submitted'});
 const postedAt=new Date(Date.parse(f.now())+1000).toISOString();f.advance(31000);await readConversation(f,w.x,[w.inbound,{id:'platform-confirmed-delayed-reply',direction:'outbound',text:String(third.input.message),postedAt}],'delayed-reply-observed');
 const chat=await f.chat.snapshot('owner-a','member-a','sales',w.x.campaign.id,w.x.conversation.id);assert.equal(chat.messages.filter(m=>m.text===third.input.message).length,1);assert.equal(chat.messages.find(m=>m.id===w.first.input.replyId)!.status,'sent');assert.equal(f.sqlite.prepare('SELECT source_key FROM workbench_prospect_messages WHERE id=?').get(String(w.first.input.replyId))?.source_key,'platform-confirmed-delayed-reply');assert.equal(w.decisions(),1);
});


test('a completed durable reply cannot block recovery of a later ordinary unanswered turn',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const w=await waitingReply(f);f.advance(61000);await readConversation(f,w.x,[w.inbound],'waiting-original');const recovered=(await f.store.claim(w.x.device.deviceId,false,true))!;await f.store.complete(w.x.device.deviceId,recovered.id,recovered.leaseToken,{outcome:'submitted'});
 await f.chat.settings('owner-a','member-a',w.x.campaign.id,true,{libraryIds:[],replyDailyLimit:5,conversationReplyLimit:5,replyHoursEnabled:false,workStart:'08:30',workEnd:'21:30'});f.advance(31000);const later={id:'later-ordinary-turn',direction:'inbound' as const,text:'想了解第二个区域',postedAt:f.now()};await readConversation(f,w.x,[w.inbound,later],'later-ordinary-snapshot');
 assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',w.decide),true);const queued=f.sqlite.prepare("SELECT id FROM workbench_prospect_jobs WHERE kind='reply' AND status='queued'").get()!.id;
 f.advance(31000);await f.chat.sync('owner-a','member-a',w.x.campaign.id,w.x.conversation.id);const failed=(await f.store.claim(w.x.device.deviceId,false,true))!;assert.equal(failed.kind,'readConversation');await f.store.complete(w.x.device.deviceId,failed.id,failed.leaseToken,undefined,'暂未核实当前账号');assert.equal(f.sqlite.prepare('SELECT status FROM workbench_prospect_jobs WHERE id=?').get(queued)?.status,'cancelled');
 f.advance(15000);await readConversation(f,w.x,[w.inbound,later],'later-ordinary-snapshot');assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',w.decide),true);const next=(await f.store.claim(w.x.device.deviceId,false,true))!;assert.equal(next.kind,'reply');assert.notEqual(next.id,queued);assert.notEqual(next.input.replyId,w.first.input.replyId);assert.equal(w.decisions(),3);
 assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',w.decide),false);assert.equal(w.decisions(),3);
});
