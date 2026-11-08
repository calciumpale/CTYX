import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyTaskMemory,advanceTaskMemory,projectTaskMemory,taskMemoryContext,editTaskMemory,understandTaskMemory} from '../app/lib/prospecting-memory.ts';
import type {TaskMemoryMessage} from '../app/lib/prospecting-memory-types.ts';
const now='2026-11-08T08:00:00Z';
const msg=(id:string,text:string,extra:Partial<TaskMemoryMessage>={}):TaskMemoryMessage=>({id,text,conversationId:'c',direction:'inbound',actor:'customer',status:'received',createdAt:now,...extra});
test('typed image placeholders never become customer facts, questions, contacts or invitations',async()=>{
 const image=msg('opaque','预算8000元/月，希望一楼，电话13812345678？',{contentType:'image'});
 const state=await understandTaskMemory(emptyTaskMemory(),[image],{now},async()=>{throw new Error('no image semantic extraction');});
 assert.deepEqual(state.facts,[]);assert.deepEqual(state.events,[]);assert.equal(state.contact.captured,false);
 assert.equal(projectTaskMemory(state).contactAsks,0);assert.ok(state.processedSourceIds?.includes('opaque'));
 assert.deepEqual(state.pendingSourceIds??[],[]);
});
test('new explicit corrections supersede old values and retract category',()=>{
 const first=advanceTaskMemory(emptyTaskMemory(),[msg('1','预算5000元/月，区域在滨江，想做餐饮')],{now});
 const state=advanceTaskMemory(first,[msg('2','预算改成8000元/月，不看滨江了，换到萧山，不做餐饮了')],{now});
 assert.equal(projectTaskMemory(state).needs.budget,'8000元/月');
 assert.equal(projectTaskMemory(state).needs.location,'萧山');
 assert.equal(projectTaskMemory(state).needs.category,undefined);
 assert.ok(state.facts.some(f=>f.value==='5000元/月'&&f.status==='superseded'));
 assert.equal(advanceTaskMemory(state,[msg('2','预算改成8000元/月')],{now}).facts.length,state.facts.length);
});
test('constraints survive long conversation and ignored sources cannot revive',()=>{
 let state=advanceTaskMemory(emptyTaskMemory(),[msg('1','必须一楼，不要转让费')],{now});
 const fact=state.facts.find(f=>f.value.includes('转让费'))!;
 assert.ok(fact);
 state=editTaskMemory(state,{factId:fact.id,operation:'ignore',actorId:'sales',now});
 state=advanceTaskMemory(state,[msg('1','必须一楼，不要转让费'),...Array.from({length:15},(_,i)=>msg('f'+i,'好的'))],{now});
 const context=JSON.stringify(taskMemoryContext(state,[msg('1','必须一楼，不要转让费')],'转让费',now));
 assert.doesNotMatch(context,/不要转让费/);
 assert.match(context,/一楼/);
});
test('third party budgets never become personal facts and ambiguous amounts are tentative',()=>{
 const state=advanceTaskMemory(emptyTaskMemory(),[msg('1','我朋友预算8000元/月'),msg('2','我的预算改成8000')],{now});
 assert.equal(projectTaskMemory(state).needs.budget,undefined);
 assert.ok(state.facts.some(f=>f.key==='budget'&&f.status==='tentative'));
});
test('relative visit date is anchored once and expires without rolling forward',()=>{
 const state=advanceTaskMemory(emptyTaskMemory(),[msg('1','明天想看铺')],{now});
 assert.match(state.facts.find(f=>f.key==='visit')?.value??'',/2026-11-09/);
 const later=advanceTaskMemory(state,[],{now:'2026-11-11T08:00:00Z'});
 assert.equal(later.facts.find(f=>f.key==='visit')?.status,'stale');
});
test('invitation counters distinguish verified submission, pending, unknown and legacy budget',()=>{
 const state=advanceTaskMemory(emptyTaskMemory({needs:{},stage:'contact',contactCaptured:false,contactDeclines:1,contactAsks:1,summary:''}),[
 msg('q','方便留一个可联系到您的方式吗？',{direction:'outbound',actor:'agent',status:'queued'}),
 msg('s','方便留一个可联系到您的方式吗？',{direction:'outbound',actor:'agent',status:'sent'}),
 msg('u','方便留一个可联系到您的方式吗？',{direction:'outbound',actor:'agent',status:'unknown'}),
 ],{now});
 assert.equal(state.contact.submittedInvites,1); assert.equal(state.contact.pendingInvites,1); assert.equal(state.contact.uncertainInvites,1);
 assert.equal(state.contact.legacyInvites,1); assert.equal(projectTaskMemory(state).contactDeclines,1);
 assert.ok(projectTaskMemory(state).contactAsks>=2);
});
test('semantic extraction rejects invented or third party facts and PII',async()=>{
 const state=await understandTaskMemory(emptyTaskMemory(),[msg('1','我朋友想要临街，电话13812345678')],{now},async messages=>{
 assert.doesNotMatch(JSON.stringify(messages),/13812345678/);
 return JSON.stringify({facts:[{key:'constraint',value:'临街',sourceMessageId:'1',sourceText:'临街'},{key:'budget',value:'5000元/月',sourceMessageId:'1',sourceText:'5000元/月'}]});
 });
 assert.equal(state.facts.length,0); assert.doesNotMatch(JSON.stringify(state),/13812345678/);
});
test('semantic conditions are source grounded and context remains bounded',async()=>{
 let calls=0;
 const state=await understandTaskMemory(emptyTaskMemory(),[msg('1','我希望有独立出入口')],{now},async()=>{calls++;return JSON.stringify({facts:[{key:'preference',value:'有独立出入口',sourceMessageId:'1',sourceText:'我希望有独立出入口'},{key:'constraint',value:'免转让费',sourceMessageId:'1',sourceText:'免转让费'}]});});
 assert.equal(calls,1);assert.ok(state.facts.some(f=>f.value==='有独立出入口'));assert.ok(!state.facts.some(f=>f.value==='免转让费'));
 const context=taskMemoryContext(state,Array.from({length:40},(_,i)=>msg(String(i),'闲聊'.repeat(400))),'闲聊',now);
 assert.ok(context.recent.length<=20);assert.ok(context.recalled.length<=5);assert.ok(context.recent.reduce((n,m)=>n+m.text.length,0)<=6000);assert.ok(JSON.stringify(context).length<=9000);
});
test('outbound status transitions replace pending invitations instead of counting retry twice',()=>{
 const queued=msg('q','方便留一个可联系到您的方式吗？',{direction:'outbound',actor:'agent',status:'queued'});
 let state=advanceTaskMemory(emptyTaskMemory(),[queued],{now});
 state=advanceTaskMemory(state,[{...queued,status:'failed'}],{now});assert.equal(state.contact.pendingInvites,0);assert.equal(state.contact.submittedInvites,0);
 state=advanceTaskMemory(state,[{...queued,status:'sent'}],{now});state=advanceTaskMemory(state,[{...queued,status:'sent'}],{now});
 assert.equal(state.contact.submittedInvites,1);assert.equal(state.contact.pendingInvites,0);
});
test('identified sales confirmation is distinct from customer intention and unknown platform sender',()=>{
 const state=advanceTaskMemory(emptyTaskMemory(),[msg('c','周六想看铺'),msg('u','确认周六看铺',{actor:'human',direction:'outbound',status:'sent'}),msg('h','确认周六14点看铺',{actor:'human',actorVerified:true,direction:'outbound',status:'sent'})],{now});
 assert.equal(state.events.filter(e=>e.type==='sales_confirmed').length,1);assert.equal(state.events.find(e=>e.type==='sales_confirmed')?.sourceMessageId,'h');assert.ok(!state.events.some(e=>e.type==='system_verified'));
});
test('late backfill cannot replace newer customer corrections or manual corrections',()=>{
 let state=advanceTaskMemory(emptyTaskMemory(),[msg('new','预算8000元/月',{createdAt:'2026-11-08T08:00:00Z'})],{now});
 state=advanceTaskMemory(state,[msg('old','预算5000元/月',{createdAt:'2026-11-07T08:00:00Z'})],{now});assert.equal(projectTaskMemory(state).needs.budget,'8000元/月');
 state=editTaskMemory(state,{factId:state.facts[0].id,operation:'correct',value:'9000元/月',actorId:'sales',now});
 assert.equal(projectTaskMemory(state).needs.budget,'9000元/月');assert.doesNotMatch(JSON.stringify(taskMemoryContext(state,[msg('new','预算8000元/月')],'预算',now)),/8000/);
});
test('failed semantic understanding preserves pending work and retries the same source',async()=>{
 const m=msg('1','我希望外摆空间够用',{rowOrder:10});
 const failed=await understandTaskMemory(emptyTaskMemory(),[m],{now},async()=>{throw Error('offline');});
 assert.deepEqual(failed.pendingSourceIds,['1']);assert.equal(failed.sourceWatermark,0);
 const retried=await understandTaskMemory(failed,[m],{now},async()=>JSON.stringify({facts:[{key:'constraint',value:'外摆空间够用',sourceMessageId:'1',sourceText:'我希望外摆空间够用'}]}));
 assert.deepEqual(retried.pendingSourceIds,[]);assert.equal(retried.sourceWatermark,10);assert.ok(retried.facts.some(f=>f.value==='外摆空间够用'));
});
test('next month timing and weekday visit anchor to source time',()=>{
 const state=advanceTaskMemory(emptyTaskMemory(),[msg('1','下个月入驻，周六看铺')],{now});
 assert.match(state.facts.find(f=>f.key==='timing')?.value??'',/2026-12/);
 assert.match(state.facts.find(f=>f.key==='visit')?.value??'',/2026-11-14/);
});
test('submitted ordinary questions have verified events while queued questions do not',()=>{
 const state=advanceTaskMemory(emptyTaskMemory(),[msg('1','您大概需要多大面积？',{actor:'agent',direction:'outbound',status:'sent'}),msg('2','您主要打算经营什么业态？',{actor:'agent',direction:'outbound',status:'queued'})],{now});
 assert.ok(state.events.some(e=>e.type==='submitted_verified'&&e.sourceMessageId==='1'));assert.ok(!state.events.some(e=>e.type==='submitted_verified'&&e.sourceMessageId==='2'));
});
test('own bare contacts capture a safe status while third party and negated contacts do not',()=>{
 for(const text of ['13812345678','我的电话13812345678','微信 shop_haiyan','邮箱 buyer@example.com']){
  const state=advanceTaskMemory(emptyTaskMemory(),[msg('1',text)],{now});assert.equal(state.contact.captured,true,text);assert.doesNotMatch(JSON.stringify(state),/13812345678|shop_haiyan|buyer@example.com/);
 }
 for(const text of ['不是我的电话13812345678','我朋友的电话13812345678','你们的邮箱 buyer@example.com','这个是示例13812345678'])assert.equal(advanceTaskMemory(emptyTaskMemory(),[msg('1',text)],{now}).contact.captured,false,text);
});
test('semantic candidate cannot drop a negative condition from its source',async()=>{
 const state=await understandTaskMemory(emptyTaskMemory(),[msg('1','我希望不要朝北')],{now},async()=>JSON.stringify({facts:[{key:'preference',value:'朝北',sourceMessageId:'1',sourceText:'我希望不要朝北'}]}));
 assert.ok(!state.facts.some(f=>f.status==='confirmed'&&f.value==='朝北'));
});
test('a changed floor condition replaces the previous floor while keeping unrelated conditions',()=>{
 let state=advanceTaskMemory(emptyTaskMemory(),[msg('1','必须一楼，不要转让费')],{now});
 state=advanceTaskMemory(state,[msg('2','改成二楼')],{now});
 assert.ok(state.facts.some(f=>f.value==='必须一楼'&&f.status==='superseded'));
 assert.match(state.summary,/二楼/);assert.match(state.summary,/不要转让费/);assert.doesNotMatch(state.summary,/一楼/);
});
test('plain customer search wording yields sourced location category and area',()=>{
 const state=advanceTaskMemory(emptyTaskMemory(),[msg('1','想找海盐60平米餐饮店')],{now});
 assert.deepEqual(projectTaskMemory(state).needs,{area:'60平米',category:'餐饮',location:'海盐'});
 assert.ok(state.facts.every(f=>f.sourceMessageId==='1'&&f.sourceText.includes(f.value)));
 const other=advanceTaskMemory(emptyTaskMemory(),[msg('2','我朋友想找海盐60平米餐饮店')],{now});assert.deepEqual(projectTaskMemory(other).needs,{});
});
test('only verified submitted answer IDs resolve their customer questions, idempotently',()=>{
 const question=msg('q','面积是多少？');
 const outbound=msg('a','可租面积100平。',{direction:'outbound',actor:'agent',status:'queued',answeredMessageIds:['q']});
 let state=advanceTaskMemory(emptyTaskMemory(),[question,outbound],{now});
 assert.equal(state.events.find(e=>e.type==='customer_question')?.status,'open');
 state=advanceTaskMemory(state,[{...outbound,status:'unknown'}],{now});assert.equal(state.events.find(e=>e.type==='customer_question')?.status,'open');
 state=advanceTaskMemory(state,[{...outbound,status:'sent'}],{now});const event=state.events.find(e=>e.type==='customer_question');assert.equal(event?.status,'resolved');assert.equal(event?.resolvedBy,'a');
 const repeated=advanceTaskMemory(state,[question,{...outbound,status:'sent'}],{now});assert.equal(repeated.events.filter(e=>e.type==='customer_question').length,1);assert.equal(repeated.events.find(e=>e.type==='customer_question')?.resolvedBy,'a');
 const unrelated=advanceTaskMemory(emptyTaskMemory(),[question,msg('human','您好',{direction:'outbound',actor:'human',status:'sent'})],{now});assert.equal(unrelated.events.find(e=>e.type==='customer_question')?.status,'open');
});
test('mixed explicit area and a separate free-form constraint still invokes semantic understanding',async()=>{
 let calls=0;const state=await understandTaskMemory(emptyTaskMemory(),[msg('1','需要80平米，我希望有独立出入口')],{now},async()=>{calls++;return JSON.stringify({facts:[{key:'constraint',value:'有独立出入口',sourceMessageId:'1',sourceText:'我希望有独立出入口'}]});});
 assert.equal(calls,1);assert.equal(projectTaskMemory(state).needs.area,'80平米');assert.ok(state.facts.some(f=>f.value==='有独立出入口'));
});
test('next Monday uses the next calendar week when the original source is Sunday',()=>{
 const state=advanceTaskMemory(emptyTaskMemory(),[msg('1','下周一看铺')],{now});assert.match(state.facts.find(f=>f.key==='visit')?.value??'',/2026-11-09/);assert.doesNotMatch(state.summary,/2026-11-16/);
});
test('semantic source clipping cannot reverse a negative original clause',async()=>{
 for(const text of ['我希望不要朝北','我朋友希望不要朝北']){
 const state=await understandTaskMemory(emptyTaskMemory(),[msg('1',text)],{now},async()=>JSON.stringify({facts:[{key:'preference',value:'朝北',sourceMessageId:'1',sourceText:'要朝北'}]}));assert.ok(!state.facts.some(f=>f.value==='朝北'&&f.status==='confirmed'));
 }
});
test('brief refusals persist only in the context of a submitted contact invitation',()=>{
 for(const status of ['sent','queued','unknown'] as const)for(const answer of ['不用了','不方便']){
 const invite=msg('out','方便留一个可联系到您的方式吗？',{direction:'outbound',actor:'agent',status});const state=advanceTaskMemory(emptyTaskMemory(),[invite,msg('in',answer)],{now});assert.equal(state.contact.declined,status==='sent',status+':'+answer);
 }
});
test('verified human scheduling confirmation is derived on queued to sent transition',()=>{
 const human=msg('human','周六14点安排好了',{direction:'outbound',actor:'human',actorVerified:true,status:'queued'});
 let state=advanceTaskMemory(emptyTaskMemory(),[human],{now});assert.equal(state.events.filter(e=>e.type==='sales_confirmed').length,0);
 state=advanceTaskMemory(state,[{...human,status:'sent'}],{now});assert.equal(state.events.filter(e=>e.type==='sales_confirmed').length,1);
 state=advanceTaskMemory(state,[{...human,status:'sent'}],{now});assert.equal(state.events.filter(e=>e.type==='sales_confirmed').length,1);
});
