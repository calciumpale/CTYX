import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createProspectingStore} from '../app/lib/prospecting-store.ts';
import {createProspectingChatStore} from '../app/lib/prospecting-chat-store.ts';
import {normalizeCampaignInput,normalizeComments,scoreComment} from '../app/lib/prospecting-domain.ts';
import {captureConversation} from '../app/lib/conversation-learning.ts';

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
test('source capture enforces owner, member, task session and original department',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const x=await prepared(f);
 const view=await f.chat.memoryView('owner-a','member-a',x.conversation.id,x.campaign.id);
 const texts=['我希望先确认我们门店的具体预算范围','请先说明门店位置和需要的面积范围','我们还担心目前的交付时间太长','我们可以逐项核对交付条件再安排下一步'];
 for(let i=0;i<4;i++){
 f.sqlite.prepare("INSERT INTO workbench_prospect_messages (id,conversation_id,owner_id,member_id,source_key,direction,actor,text,status,created_at) VALUES (?,?,'owner-a','member-a',?,?,?,?,?,'now')").run('learn-'+i,x.conversation.id,'learn-'+i,i%2?'outbound':'inbound',i%2?'human':'customer',texts[i],i%2?'sent':'received');
 f.sqlite.prepare("INSERT INTO workbench_prospect_memory_sources (message_id,session_id,binding_version,row_order,created_at) VALUES (?,?,1,?,'now')").run('learn-'+i,view.sessionId,100+i);
 }
 f.sqlite.prepare("INSERT INTO workbench_prospect_messages (id,conversation_id,owner_id,member_id,source_key,direction,actor,text,status,created_at) VALUES ('unbound',?,'owner-a','member-a','unbound','inbound','customer','其他任务未绑定文本不能进入案例','received','now')").run(x.conversation.id);
 const own=await captureConversation(f.db,'owner-a','member-a',x.conversation.id,x.campaign.id);assert.equal(own.messages.filter(m=>m.id.startsWith('learn-')).length,4);assert.equal(own.departmentId,'zs');assert.ok(!JSON.stringify(own).includes('其他任务'));
 const manager=await captureConversation(f.db,'owner-a','manager-a',x.conversation.id,x.campaign.id);assert.equal(manager.memberId,'member-a');assert.equal(manager.employeeId,'sales-1');
 await assert.rejects(()=>captureConversation(f.db,'owner-a','member-b',x.conversation.id,x.campaign.id));
 await assert.rejects(()=>captureConversation(f.db,'owner-z','member-z',x.conversation.id,x.campaign.id));
 await assert.rejects(()=>captureConversation(f.db,'owner-a','member-a',x.conversation.id,'foreign-task'));
 f.sqlite.prepare("UPDATE workbench_prospect_memory_sources SET session_id='other-session' WHERE message_id='learn-0'").run();
 await assert.rejects(()=>captureConversation(f.db,'owner-a','member-a',x.conversation.id,x.campaign.id),/至少需要/);
});
