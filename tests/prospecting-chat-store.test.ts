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
 f.advance(61000);await readConversation(f,x,[{id:'email',direction:'inbound',text:'我的邮箱是PERSON@Example.com',postedAt:f.now()}],'snapshot-2');await f.chat.processOne('owner-a','member-a','https://example.test',(_owner,_origin,input)=>chooseProspectChatAction(input,{}));
 assigned=await f.chat.snapshot('owner-a','member-b','sales');assert.equal(assigned.pool.length,2);assert.ok(assigned.pool.every(lead=>lead.assignedMemberId==='member-b'));
});
