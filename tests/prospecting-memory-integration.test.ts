import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createProspectingStore} from '../app/lib/prospecting-store.ts';
import {createProspectingChatStore} from '../app/lib/prospecting-chat-store.ts';
import {normalizeCampaignInput,normalizeComments,scoreComment} from '../app/lib/prospecting-domain.ts';
import {createProspectingService} from '../app/lib/prospecting-service.ts';
import {trustedMemberHeaders} from '../app/lib/member-auth.ts';
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

const current=async(f:ReturnType<typeof fixture>,x:Awaited<ReturnType<typeof prepared>>,campaignId=x.campaign.id)=>(await f.chat.snapshot('owner-a','member-a','sales',campaignId,x.conversation.id)).conversations.find(c=>c.id===x.conversation.id)!;

test('reliable conversation memory absorbs corrections and extra constraints across turns',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);
 const first={id:'memory-initial',direction:'inbound' as const,text:'想做餐饮，80-100平，预算5000元/月，希望在杭州滨江，需要一楼，不要转让费',postedAt:f.now()};await readConversation(f,x,[first]);
 await f.chat.rememberOne('owner-a','member-a','https://example.test');
 f.advance(31000);const second={id:'memory-change',direction:'inbound' as const,text:'预算改成8000元/月，不看滨江了，换到萧山。',postedAt:f.now()};await readConversation(f,x,[first,second],'memory-corrected');await f.chat.rememberOne('owner-a','member-a','https://example.test');
 const c=await current(f,x);assert.ok(c.taskMemory);assert.ok(c.taskMemory.ready);const facts=c.taskMemory.state.facts.filter(f=>f.status==='confirmed');
 assert.match(facts.find(f=>f.key==='budget')?.value??'',/8000/);assert.match(facts.find(f=>f.key==='location')?.value??'',/萧山/);assert.ok(facts.some(f=>f.key==='constraint'&&/一楼|转让费/.test(f.value)));
 const decision=await chooseProspectChatAction({campaign:{name:'找铺',requirements:'商铺租赁',minIntentScore:70},conversation:{nickname:'客户',memory:c.memory,taskMemory:c.taskMemory},messages:[],inbound:{id:'ask-previous-area',text:'我之前说的面积是多少？'},now:f.now()},{});
 assert.match(decision.reply??'',/80.{0,3}100/);assert.doesNotMatch(decision.reply??'',/什么时候|留一个/);
});

test('task switching separates memory and pending messages while retaining physical human takeover',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);
 const inbound={id:'task-a-needs',direction:'inbound' as const,text:'预算5000元/月，想做餐饮',postedAt:f.now()};await readConversation(f,x,[inbound]);await f.chat.rememberOne('owner-a','member-a','https://example.test');
 let a=await current(f,x);await f.chat.takeover('owner-a','member-a',a.id,a.version);a=await current(f,x);assert.ok(a.taskMemory);
 const b=await f.store.createCampaign('owner-a','member-a',normalizeCampaignInput({requirements:'办公室租赁，独立任务',keywords:['办公室']}));await f.chat.settings('owner-a','member-a',b.id,true);
 await f.chat.switchTask('owner-a','member-a',a.id,b.id,a.version,a.taskMemory.bindingVersion);
 const selected=await current(f,x,b.id);assert.equal(selected.mode,'human');assert.equal(selected.taskMemory?.campaignId,b.id);assert.equal(selected.taskMemory?.isActive,true);assert.equal(selected.taskMemory?.state.facts.length,0);
 const bSnapshot=await f.chat.snapshot('owner-a','member-a','sales',b.id,a.id);assert.ok(!bSnapshot.messages.some(m=>m.text.includes('预算5000')));
 let calls=0;assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',async()=>{calls++;return{action:'reply',reply:'不应回复任务A'};}),false);assert.equal(calls,0);
 const aSnapshot=await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id,a.id);assert.equal(aSnapshot.conversations.find(c=>c.id===a.id)?.taskMemory?.isActive,false);
});

test('human-mode reliable messages continue to become task-local memory',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);await readConversation(f,x,[]);
 const c=await current(f,x);await f.chat.takeover('owner-a','member-a',c.id,c.version);f.advance(31000);
 await readConversation(f,x,[{id:'human-memory-needs',direction:'inbound',text:'要一楼，不要转让费，预算8000元/月',postedAt:f.now()}],'human-memory');
 await f.chat.rememberOne('owner-a','member-a','https://example.test');const updated=await current(f,x);assert.equal(updated.mode,'human');assert.ok(updated.taskMemory?.state.facts.some(f=>f.key==='constraint'&&/一楼|转让费/.test(f.value)));assert.match(updated.taskMemory?.state.facts.find(f=>f.key==='budget'&&f.status==='confirmed')?.value??'',/8000/);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM workbench_prospect_jobs WHERE kind='reply'").get()?.n,0);
});

test('manual memory correction invalidates a response still being generated',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);await readConversation(f,x,[]);f.advance(31000);
 await readConversation(f,x,[{id:'generation-memory',direction:'inbound',text:'想做餐饮，预算5000元/月',postedAt:f.now()}],'memory-generation');await f.chat.rememberOne('owner-a','member-a','https://example.test');
 let ready!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>ready=r),gate=new Promise<void>(r=>release=r);
 const generating=f.chat.processOne('owner-a','member-a','https://example.test',async()=>{ready();await gate;return{action:'reply',reply:'您的预算是5000元/月。'};});await entered;
 const c=await current(f,x);assert.ok(c.taskMemory);const fact=c.taskMemory.state.facts.find(f=>f.key==='budget'&&f.status==='confirmed')!;assert.ok(fact);
 await f.chat.memoryEdit('owner-a','member-a',c.id,x.campaign.id,c.taskMemory.sessionVersion,c.taskMemory.bindingVersion,{factId:fact.id,operation:'correct',value:'8000元/月',actorId:'ignored-client-value',now:f.now()});release();await generating;
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM workbench_prospect_jobs WHERE kind='reply' AND status='queued'").get()?.n,0);const corrected=await current(f,x);assert.match(corrected.taskMemory?.state.facts.find(f=>f.key==='budget'&&f.status==='confirmed')?.value??'',/8000/);
});

test('submitted grounded answers resolve their source question, while queued drafts do not',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);
 const need={id:'need-known',direction:'inbound' as const,text:'想做餐饮，80-100平',postedAt:f.now()};await readConversation(f,x,[need]);await f.chat.rememberOne('owner-a','member-a','https://example.test');f.advance(61000);
 const q={id:'memory-area-question',direction:'inbound' as const,text:'我之前说的面积是多少？',postedAt:f.now()};await readConversation(f,x,[need,q],'question-source');await f.chat.rememberOne('owner-a','member-a','https://example.test');
 const decide=(_o:string,_r:string,input:Parameters<typeof chooseProspectChatAction>[0])=>chooseProspectChatAction(input,{});assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',decide),true);
 let c=await current(f,x);const before=c.taskMemory!.state.events.find(e=>e.type==='customer_question'&&e.sourceText.includes('之前说的面积'))!;assert.ok(before);assert.notEqual(before.status,'resolved');
 const reply=(await f.store.claim(x.device.deviceId,false,true))!;assert.equal(reply.kind,'reply');assert.ok(Array.isArray(reply.input.answeredMessageIds));await f.store.complete(x.device.deviceId,reply.id,reply.leaseToken,{outcome:'submitted'});await f.chat.rememberOne('owner-a','member-a','https://example.test');
 c=await current(f,x);const after=c.taskMemory!.state.events.find(e=>e.id===before.id)!;assert.equal(after.status,'resolved');assert.ok(after.resolvedBy);
});


test('memory mutation API enforces owner, source versions, origin and active-task reply scope',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);await readConversation(f,x,[{id:'api-needs',direction:'inbound',text:'预算5000元/月',postedAt:f.now()}]);await f.chat.rememberOne('owner-a','member-a','https://example.test');
 const service=createProspectingService({db:f.db,readModel:async()=>null});
 const post=(input:Record<string,unknown>,member='member-a',source='https://example.test')=>service.handle(new Request('https://example.test/api/prospecting',{method:'POST',headers:trustedMemberHeaders(new Headers({'content-type':'application/json',origin:source,'oai-authenticated-user-id':'owner-a','oai-authenticated-user-email':'offline@example.test'}),{accountId:member,username:member,displayName:'离线夹具',role:'sales'}),body:JSON.stringify(input)}));
 let c=await current(f,x);const v=c.taskMemory!,fact=v.state.facts.find(f=>f.key==='budget')!;
 const edit={action:'chatMemoryEdit',conversationId:c.id,campaignId:x.campaign.id,sessionVersion:v.sessionVersion,bindingVersion:v.bindingVersion,factId:fact.id,operation:'correct',value:'8000元/月'};
 assert.equal((await post(edit,'member-b')).status,404);assert.equal((await post(edit,'member-a','https://other.test')).status,403);assert.equal((await post(edit)).status,200);assert.equal((await post(edit)).status,409);
 c=await current(f,x);assert.match(c.taskMemory!.state.facts.find(f=>f.key==='budget'&&f.status==='confirmed')?.value??'',/8000/);
 const b=await f.store.createCampaign('owner-a','member-a',normalizeCampaignInput({requirements:'新的办公室任务',keywords:['办公室']}));await f.chat.settings('owner-a','member-a',b.id,true);
 const switched=await post({action:'chatSwitchTask',conversationId:c.id,campaignId:x.campaign.id,targetCampaignId:b.id,version:c.version,bindingVersion:c.taskMemory!.bindingVersion});assert.equal(switched.status,200);const body=await switched.json() as {chat:{conversations:{campaignId:string}[]}};assert.equal(body.chat.conversations[0].campaignId,b.id);
 assert.equal((await post({action:'chatReply',conversationId:c.id,campaignId:x.campaign.id,version:(await current(f,x,b.id)).version,message:'旧任务不能发出'})).status,409);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM workbench_prospect_jobs WHERE kind='reply'").get()?.n,0);
});

test('generation cannot consume semantic work from a second conversation without the configured extractor',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);
 await readConversation(f,x,[{id:'human-first',direction:'inbound',text:'预算5000元/月',postedAt:f.now()}]);const a=await current(f,x);await f.chat.takeover('owner-a','member-a',a.id,a.version);
 f.advance(1);const row=f.sqlite.prepare('SELECT * FROM workbench_prospect_conversations WHERE id=?').get(x.conversation.id)!;const clone={...row,id:'pcv-semantic-second',recipient_id:'MS4wSemantic002',profile_url:'https://www.douyin.com/user/MS4wSemantic002',mode:'agent',handoff_reason:null,processing_token:null,processing_until:null,memory_json:'{}',last_checked_at:null,last_read_at:f.now(),last_snapshot_id:'semantic-second-proof',has_baseline:1};f.sqlite.prepare(`INSERT INTO workbench_prospect_conversations (${Object.keys(clone).join(',')}) VALUES (${Object.keys(clone).map(()=>'?').join(',')})`).run(...Object.values(clone) as never[]);
 f.sqlite.prepare("INSERT INTO workbench_prospect_messages(id,conversation_id,owner_id,member_id,source_key,direction,actor,text,status,posted_at,created_at,eligible) VALUES('semantic-second-source','pcv-semantic-second','owner-a','member-a','semantic-second-source','inbound','customer','需要80平米，我希望有独立出入口','received',?,?,1)").run(f.now(),f.now());
 await f.chat.materialize('owner-a','member-a');await f.chat.rememberOne('owner-a','member-a','https://example.test');let calls=0;
 assert.equal(await f.chat.processOne('owner-a','member-a','https://example.test',async()=>{calls++;return{action:'reply',reply:'您希望在哪个区域？'};}),false);assert.equal(calls,0);
 const pending=await f.chat.memoryView('owner-a','member-a','pcv-semantic-second');assert.ok(pending.state.pendingSourceIds?.includes('semantic-second-source'));assert.equal(pending.ready,false);
 let extracted=false;await f.chat.rememberOne('owner-a','member-a','https://example.test',async(_owner,_origin,state,messages,options)=>{extracted=true;const {understandTaskMemory}=await import('../app/lib/prospecting-memory.ts');return understandTaskMemory(state,messages,options,async()=>JSON.stringify({facts:[{key:'constraint',value:'我希望有独立出入口',sourceMessageId:'semantic-second-source',sourceText:'我希望有独立出入口'}]}));});assert.equal(extracted,true);
 const ready=await f.chat.memoryView('owner-a','member-a','pcv-semantic-second');assert.ok(ready.state.facts.some(f=>f.key==='constraint'&&f.value.includes('独立出入口')));assert.equal(ready.ready,true);
});

test('capturing a different contact in a new task never links the previous task contact',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);f.advance(61000);
 await readConversation(f,x,[{id:'contact-task-a',direction:'inbound',text:'我的手机号是13800138000',postedAt:f.now()}],'contact-a');await f.chat.rememberOne('owner-a','member-a','https://example.test');
 const decide=(_o:string,_r:string,input:Parameters<typeof chooseProspectChatAction>[0])=>chooseProspectChatAction(input,{});await f.chat.processOne('owner-a','member-a','https://example.test',decide);const sent=(await f.store.claim(x.device.deviceId,false,true))!;assert.equal(sent.kind,'reply');await f.store.complete(x.device.deviceId,sent.id,sent.leaseToken,{outcome:'submitted'});
 const b=await f.store.createCampaign('owner-a','member-a',normalizeCampaignInput({requirements:'另一个办公室任务',keywords:['办公室']}));await f.chat.settings('owner-a','member-a',b.id,true);const c=await current(f,x);await f.chat.switchTask('owner-a','member-a',c.id,b.id,c.version,c.taskMemory!.bindingVersion);const bx={...x,campaign:b};f.advance(31000);await readConversation(f,bx,[],'task-b-baseline');f.advance(61000);
 await readConversation(f,bx,[{id:'contact-task-b',direction:'inbound',text:'我的手机号是13900139000',postedAt:f.now()}],'contact-b');await f.chat.rememberOne('owner-a','member-a','https://example.test');await f.chat.processOne('owner-a','member-a','https://example.test',decide);
 const aPool=(await f.chat.snapshot('owner-a','member-a','sales',x.campaign.id)).pool;const bPool=(await f.chat.snapshot('owner-a','member-a','sales',b.id)).pool;assert.deepEqual(aPool.map(p=>p.contactValue),['13800138000']);assert.deepEqual(bPool.map(p=>p.contactValue),['13900139000']);
});

test('short contextual contact refusal survives subsequent replies and turns without opting out globally',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);await f.chat.settings('owner-a','member-a',x.campaign.id,true);f.advance(61000);
 const needs={id:'refusal-needs',direction:'inbound' as const,text:'我做餐饮，需要80平米',postedAt:f.now()};await readConversation(f,x,[needs],'refusal-need');await f.chat.rememberOne('owner-a','member-a','https://example.test');
 const decide=(_o:string,_r:string,input:Parameters<typeof chooseProspectChatAction>[0])=>chooseProspectChatAction(input,{});await f.chat.processOne('owner-a','member-a','https://example.test',decide);const invite=(await f.store.claim(x.device.deviceId,false,true))!;assert.match(String(invite.input.message),/可联系到您的方式/);await f.store.complete(x.device.deviceId,invite.id,invite.leaseToken,{outcome:'submitted'});
 const inviteText={id:'refusal-invite',direction:'outbound' as const,text:String(invite.input.message),postedAt:f.now()};f.advance(61000);const decline={id:'refusal-short',direction:'inbound' as const,text:'不方便',postedAt:f.now()};await readConversation(f,x,[needs,inviteText,decline],'short-refusal');await f.chat.rememberOne('owner-a','member-a','https://example.test');await f.chat.processOne('owner-a','member-a','https://example.test',decide);
 const ack=(await f.store.claim(x.device.deviceId,false,true))!;assert.equal(ack.kind,'reply');assert.doesNotMatch(String(ack.input.message),/可联系到您的方式/);await f.store.complete(x.device.deviceId,ack.id,ack.leaseToken,{outcome:'submitted'});const ackText={id:'refusal-ack',direction:'outbound' as const,text:String(ack.input.message),postedAt:f.now()};f.advance(61000);
 const follow={id:'refusal-follow',direction:'inbound' as const,text:'区域在海盐',postedAt:f.now()};await readConversation(f,x,[needs,inviteText,decline,ackText,follow],'after-short-refusal');await f.chat.rememberOne('owner-a','member-a','https://example.test');await f.chat.processOne('owner-a','member-a','https://example.test',decide);const c=await current(f,x);assert.equal(c.status,'active');assert.equal(c.taskMemory?.state.contact.declined,true);const queued=f.sqlite.prepare("SELECT input_json FROM workbench_prospect_jobs WHERE kind='reply' AND status='queued' ORDER BY rowid DESC LIMIT 1").get();assert.ok(queued);assert.doesNotMatch(String(JSON.parse(String(queued.input_json)).message),/可联系到您的方式/);
});
