import {test} from 'node:test';
import assert from 'node:assert/strict';
import {redactConversationText,conversationSnapshot,queueConversationLearning} from '../app/lib/conversation-learning.ts';
import {createSeed} from '../app/lib/seed.ts';
const rows=[{id:'1',direction:'inbound',status:'received',actor:'customer',text:'张三想了解具体的预算分期条件，电话13812345678'}, {id:'2',direction:'outbound',status:'sent',actor:'human',text:'可以先确认具体需求再给出方案'}, {id:'3',direction:'inbound',status:'received',actor:'customer',text:'我们担心部署周期影响目前的运营'}, {id:'4',direction:'outbound',status:'sent',actor:'agent',text:'请先列出上线范围，我们逐项核对交付条件'}];
const source={ownerId:'o',memberId:'m',employeeId:'sales-1',employeeName:'销售',departmentId:'zs' as const,conversationId:'c',campaignId:'p',sessionId:'s',capturedAt:'2026-11-08',messages:[]};
test('redacts identifiers before snapshot; ignores drafts and images',async()=>{const s=await conversationSnapshot(source,[...rows,{id:'5',direction:'outbound',status:'queued',actor:'agent',text:'不允许保留的草稿'}, {id:'6',direction:'inbound',status:'received',actor:'customer',text:'[图片]',content_type:'image'}],['张三']);assert.equal(s.messages.length,4);assert.ok(!JSON.stringify(s).includes('13812345678'));assert.ok(!JSON.stringify(s).includes('张三'));assert.match(redactConversationText('邮箱 a@b.com 微信 abcde123 电话 +86 13812345678'),/已隐藏/);});
test('requires two substantive turns each way',async()=>{await assert.rejects(()=>conversationSnapshot(source,rows.slice(1)));});
test('same source creates one durable job and config retry preserves evidence',async()=>{const state=createSeed('2026-11-08');const s=await conversationSnapshot(source,rows);const first=queueConversationLearning(state,s);first.status='waiting_config';const second=queueConversationLearning(state,s);assert.equal(first.id,second.id);assert.equal(state.feedbackJobs?.length,1);assert.equal(second.status,'queued');assert.deepEqual(second.conversationSource?.messages,s.messages);});

import {learnConversation} from '../app/lib/conversation-learning-worker.ts';
import {DomainError} from '../app/lib/domain.ts';
import {handleTalkAction,talkKnowledge} from '../app/lib/talktrack-domain.ts';
test('durable config retry, concurrent replay, exact evidence, manager version gate and lexical publication',async()=>{
 let state=createSeed('2026-11-08');const snapshot=await conversationSnapshot(source,rows);let calls=0;
 const deps={load:async()=>structuredClone(state),save:async(revision:number,next:typeof state)=>{if(state.revision!==revision)throw new DomainError('conflict',409);state=structuredClone(next);}};
 const waiting=await learnConversation(snapshot,deps);assert.equal(waiting.status,'waiting_config');assert.equal(state.feedbackJobs?.[0].conversationSource?.sourceHash,snapshot.sourceHash);
 const generate=async(transcripts:{id:string;text:string}[])=>{calls++;assert.ok(!JSON.stringify(transcripts).includes('13812345678'));await new Promise(r=>setTimeout(r,5));return [{topic:'需求澄清',scenario:'客户提出需求',template:'请先确认{需求范围}',keywords:['需求'],objectionLogic:['澄清范围'],steps:['先核对'],boundaries:['不承诺成单'],leadTypes:['咨询'],confidence:.9,evidence:[{transcriptId:transcripts[0].id,quote:transcripts[0].text.split('\n')[1]}]}];};
 await Promise.all([learnConversation(snapshot,{...deps,generate}),learnConversation(snapshot,{...deps,generate})]);assert.equal(calls,1);assert.equal(state.feedbackJobs?.length,1);assert.equal(state.talkTracks?.length,1);const track=state.talkTracks![0];assert.equal(track.departmentId,'zs');assert.equal(track.status,'candidate');assert.equal(track.dealId,'');
 await assert.rejects(()=>handleTalkAction(state,'sales','talktrack_review',{id:track.id,version:1,decision:'approve'},'now'),/管理者/);
 await assert.rejects(()=>handleTalkAction(state,'manager','talktrack_review',{id:track.id,version:5,decision:'approve'},'now'),/已更新/);
 await handleTalkAction(state,'manager','talktrack_review',{id:track.id,version:1,decision:'approve'},'now');assert.equal(track.status,'published');assert.equal(talkKnowledge(track).departmentId,'zs');assert.match(talkKnowledge(track).source,/对话案例/);
 await learnConversation(snapshot,{...deps,generate});assert.equal(calls,1);
});

test('provider failure retains source, safe retry rejects invented evidence and new snapshots produce later jobs',async()=>{
 let state=createSeed('2026-11-08');const snapshot=await conversationSnapshot(source,rows);
 const deps={load:async()=>structuredClone(state),save:async(revision:number,next:typeof state)=>{if(revision!==state.revision)throw new DomainError('conflict',409);state=structuredClone(next);}};
 const failed=await learnConversation(snapshot,{...deps,generate:async()=>{throw Error('provider secret');}});assert.equal(failed.status,'failed');assert.ok(!failed.message.includes('secret'));assert.equal(failed.conversationSource?.messages.length,4);
 const screened=await learnConversation(snapshot,{...deps,generate:async()=>[{topic:'主题',scenario:'场景',template:'模板',keywords:[],objectionLogic:[],steps:[],boundaries:[],leadTypes:[],confidence:1,evidence:[{transcriptId:'fake',quote:'未发生的成交'}]}]});assert.equal(screened.status,'screened_out');assert.equal(state.talkTracks?.length??0,0);
 const newer=await conversationSnapshot(source,[...rows,{id:'later',direction:'inbound',actor:'customer',status:'received',text:'我们需要确认后续具体培训安排'}]);await learnConversation(newer,deps);assert.equal(state.feedbackJobs?.length,2);
});

import {executeMemberAction} from '../app/lib/member-policy.ts';
import type {TalkTrack} from '../app/lib/talktrack-types.ts';
const reviewedTrack:TalkTrack={id:'foreign-reviewed',title:'外部话术',employeeId:'sales-yy',employeeName:'销售',departmentId:'yy',dealId:'',status:'published',weight:1,version:1,createdAt:'now',updatedAt:'now',topic:'需求',scenario:'需求',template:'FOREIGN_DEPARTMENT_SECRET',keywords:['需求'],objectionLogic:['澄清'],steps:['澄清'],boundaries:['核对'],leadTypes:['咨询'],confidence:1,evidence:[]};
test('canonical manager state cannot bypass authenticated sales explicit-track department access',async()=>{
 const state=createSeed('2026-11-08');state.talkTracks=[reviewedTrack];assert.equal(state.role,'manager');let calls=0;
 const context={salesScope:{salesId:'sales-1',displayName:'招商销售'},generate:async()=>{calls++;return {answer:'ok',mode:'live' as const};}};
 await assert.rejects(()=>executeMemberAction(state,'sales','chat',{query:'帮我准备开场话术',agentId:'strategy',talkTrackIds:['foreign-reviewed']},context));assert.equal(calls,0);
 const legacy={...reviewedTrack,id:'legacy-foreign',departmentId:undefined,employeeId:undefined} as unknown as TalkTrack;state.talkTracks=[legacy];Object.assign(state,{_access:{'legacy-foreign':'sales-yy'}});
 await assert.rejects(()=>executeMemberAction(state,'sales','chat',{query:'帮我准备开场话术',agentId:'strategy',talkTrackIds:['legacy-foreign']},context));assert.equal(calls,0);
 state.talkTracks=[{...reviewedTrack,id:'own-reviewed',departmentId:'zs',employeeId:'sales-1'}];const own=await executeMemberAction(state,'sales','chat',{query:'帮我准备开场话术',agentId:'strategy',talkTrackIds:['own-reviewed']},context);assert.ok(own.run?.citations.some(c=>c.id==='own-reviewed'));assert.equal(calls,1);
});
const contacts=['联系人：Alice','姓名：Alice Smith','微信号是 abcdef123','微信号： ghijkl456','vx: contact789','v信是 user12345','wx号为 abc_5678','手机号：13812345678','电话 +65 9123 4567','联系电话010-6255-1234'];
test('labelled accounts and formatted phones are redacted before storage, model and candidate; evidence stays exact',async()=>{
 const raw='请联系我详细沟通需求，'+contacts.join('，');const redacted=redactConversationText(raw);for(const value of ['Alice','Smith','abcdef123','ghijkl456','contact789','user12345','abc_5678','13812345678','9123','6255'])assert.ok(!redacted.includes(value),value);
 assert.equal(redactConversationText('产品型号 12345678，预算 9123 4567，版本 010-6255-1234'),'产品型号 12345678，预算 9123 4567，版本 010-6255-1234');
 let state=createSeed('2026-11-08');const snapshot=await conversationSnapshot(source,[{...rows[0],text:raw},...rows.slice(1)]);
 await learnConversation(snapshot,{load:async()=>structuredClone(state),save:async(_revision,next)=>{assert.ok(!JSON.stringify(next).includes('Alice'));assert.ok(!JSON.stringify(next).includes('abcdef123'));state=structuredClone(next);},generate:async transcripts=>{assert.ok(!JSON.stringify(transcripts).includes('Alice'));assert.ok(!JSON.stringify(transcripts).includes('abcdef123'));return [{...reviewedTrack,template:raw,evidence:[{transcriptId:transcripts[0].id,quote:transcripts[0].text.split('\n')[0]}]}];}});
 assert.equal(state.talkTracks?.[0].template,redacted);assert.ok(state.talkTracks?.[0].evidence[0].quote.includes(redacted));
});
for(const configured of [true,false])test(`unrelated claim/status CAS conflict retries with configured=${configured}`,async()=>{
 let state=createSeed('2026-11-08'),saves=0,calls=0;const snapshot=await conversationSnapshot(source,rows);
 const job=await learnConversation(snapshot,{load:async()=>structuredClone(state),save:async(revision,next)=>{saves++;if(saves===2){state.revision++;throw new DomainError('unrelated write',409);}if(revision!==state.revision)throw new DomainError('conflict',409);state=structuredClone(next);},generate:configured?async()=>{calls++;return [];}:undefined});
 assert.equal(job.status,configured?'screened_out':'waiting_config');assert.equal(calls,configured?1:0);assert.ok(saves>=3);
});
