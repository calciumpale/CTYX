import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createKnowledgeLibraryStore } from '../app/lib/knowledge-library-store.ts';
import type { KnowledgeChunkDraft } from '../app/lib/knowledge-library-types.ts';
import type { PropertyQuery } from '../app/lib/property-query.ts';

const flat=(text:string,ordinal=1):KnowledgeChunkDraft=>({ordinal,parentOrdinal:null,kind:'flat',text,heading:''});
function fixture(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
 for(const file of readdirSync(new URL('../drizzle/',import.meta.url)).filter(x=>x.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(`../drizzle/${file}`,import.meta.url),'utf8'));
 let queue:Promise<unknown>=Promise.resolve();
 const db={prepare(sql:string){let values:unknown[]=[];return{bind(...args:unknown[]){assert.ok(args.length<=100);values=args;return this;},async first(){return sqlite.prepare(sql).get(...values as never[])??null;},async all(){return{results:sqlite.prepare(sql).all(...values as never[])};},async run(){const statement=sqlite.prepare(sql);return statement.columns().length?{results:statement.all(...values as never[]),meta:{changes:0}}:{results:[],meta:{changes:Number(statement.run(...values as never[]).changes)}};}};},batch(items:{run:()=>Promise<unknown>}[]){const execute=async()=>{sqlite.exec('BEGIN');try{const out=[];for(const item of items)out.push(await item.run());sqlite.exec('COMMIT');return out;}catch(error){sqlite.exec('ROLLBACK');throw error;}};const result=queue.then(execute,execute);queue=result.catch(()=>{});return result;}} as unknown as D1Database;
 return{sqlite,store:createKnowledgeLibraryStore(db,'alice'),other:createKnowledgeLibraryStore(db,'bob'),db};
}

import {createWorkbenchKnowledgeAgent} from '../app/lib/knowledge-agent-runtime.ts';
import {chooseProspectChatAction} from '../app/lib/prospecting-chat-agent.ts';
import {createSeed} from '../app/lib/seed.ts';
test('production retrieval ignores empty or tampered selection and isolates documents, legacy and lexical tracks',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());
 const ids:Record<string,string>={};
 for(const department of ['zs','yy','shared'] as const){const library=await f.store.createLibrary(department,department);ids[department]=library.id;await f.store.addDocument({libraryId:library.id,title:department+'预约',fileName:'test.txt',strategy:'flat',chunks:[flat(department+'预约请联系顾问。')]});}
 const foreign=await f.other.createLibrary('other','zs');await f.other.addDocument({libraryId:foreign.id,title:'外租户预约',fileName:'test.txt',strategy:'flat',chunks:[flat('外租户预约秘密')]});
 const state=createSeed();state.skills=[];state.knowledge=[];
 state.talkTracks=['zs','yy','shared'].map(department=>({id:'track-'+department,title:department+'预约话术',departmentId:department,employeeId:department==='yy'?'sales-yy':'sales-1',employeeName:'销售',dealId:'case',status:'published',version:1,weight:1,createdAt:'now',updatedAt:'now',topic:'预约',scenario:'预约',template:department+'预约请联系顾问。',keywords:['预约'],objectionLogic:[],steps:[],boundaries:[],leadTypes:[],evidence:[],confidence:1})) as typeof state.talkTracks;
 state.talkTracks!.push(...(['candidate','rejected'] as const).map(status=>({...state.talkTracks![0],id:'excluded-'+status,title:'预约'+status,status})));
 f.sqlite.prepare('INSERT INTO workbench_workspaces(user_id,state_json,created_at,updated_at) VALUES (?,?,?,?)').run('alice',JSON.stringify(state),'now','now');
 for(const selection of [[],[ids.yy,foreign.id]]){
  const agent=createWorkbenchKnowledgeAgent(f.db,'alice','https://example.test',{departmentId:'zs',libraryIds:selection});
  const audit=await agent.preflight('预约');assert.deepEqual(new Set(audit.libraryIds),new Set([ids.zs,ids.shared]));
  const result=await agent.prepare({question:'预约',intent:'business'});const content=JSON.stringify(result.knowledge);
  assert.match(content,/zs预约/);assert.match(content,/shared预约/);assert.match(content,/track-zs/);assert.doesNotMatch(content,/yy预约|外租户|track-yy|excluded-candidate|excluded-rejected/);
  f.sqlite.prepare('UPDATE workbench_knowledge_libraries SET name=name WHERE owner_id=?').run('alice');
 }
 const otherAgent=createWorkbenchKnowledgeAgent(f.db,'bob','https://example.test',{departmentId:'zs'});const other=await otherAgent.preflight('预约');assert.deepEqual(other.libraryIds,[foreign.id]);
});

test('property lookup enumerates all authorized original rows before generic top-k and numeric conflict rules',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());
 for(const [department,title] of [['zs','空置房源'],['zs','在租房源'],['yy','空置房源']] as const){
  const library=await f.store.createLibrary(title,department);
  await f.store.upload({libraryId:library.id,title,fileName:title+'.xlsx',text:'## 工作表：'+title+'表\n第1行：A1=区块；B1=地址；C1=面积；D1=建议业态\n'+Array.from({length:25},(_,i)=>`第${i+2}行：A${i+2}=绮园商业街；B${i+2}=${department}-${title}-${i}号商铺；C${i+2}=${100+i}；D${i+2}=轻餐饮`).join('\n'),requestId:crypto.randomUUID(),strategy:'flat'});
 }
 const agent=createWorkbenchKnowledgeAgent(f.db,'alice','https://example.test',{departmentId:'zs',generate:async()=>{throw new Error('provider unavailable');}});
 const result=await agent.prepare({question:'找绮园100-200平轻餐饮空置房源'});
 assert.equal(result.recordLookup?.kind,'property');assert.equal(result.recordLookup?.total,25);assert.match(result.answer!,/zs-空置房源-0号商铺/);assert.doesNotMatch(result.answer!,/yy-空置|zs-在租/);assert.equal(result.route,'retrieved');
 const next=await agent.prepare({question:'第2页',history:[{role:'user',content:'找绮园100-200平轻餐饮空置房源'},{role:'assistant',content:result.answer!}]});
 assert.match(next.answer!,/zs-空置房源-10号商铺/);assert.doesNotMatch(next.answer!,/zs-空置房源-0号商铺/);
 const none=await agent.prepare({question:'找绮园1000平以上空置房源'});assert.equal(none.recordLookup?.total,0);assert.match(none.answer!,/未找到/);
});

async function inventoryFixture(f:ReturnType<typeof fixture>){
 for(const title of ['空置房源','在租房源']){
  const library=await f.store.createLibrary(title,'zs');
  const text='## 工作表：'+title+'表\n第1行：A1=铺号；B1=面积（㎡）；C1=业态；D1=位置；E1=备注\n'+Array.from({length:25},(_,i)=>{
   const row=i+2,area=i===20?90:i===21?250:i===24?135:150,usage=i===23?'零售':'轻餐饮',location=i===22?'东门商业街':'绮园商业街';
   return `第${row}行：A${row}=${title}-${i}号商铺；B${row}=${area}；C${row}=${usage}；D${row}=${location}；E${row}=${'需核对维护及水电情况。'.repeat(12)}`;
  }).join('\n');
  await f.store.upload({libraryId:library.id,title,fileName:title+'.xlsx',text,requestId:crypto.randomUUID(),strategy:'flat'});
 }
 return createWorkbenchKnowledgeAgent(f.db,'alice','https://example.test',{departmentId:'zs'});
}
const userHistory=(...questions:string[])=>questions.map(content=>({role:'user' as const,content}));

test('ordinary resets and all-customer requests never become property searches through current or older history',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const agent=await inventoryFixture(f);
 for(const question of ['所有客户本周怎么推进？','重新写一版开场白','商铺合同有没有违约风险？']){
  for(const history of [[],userHistory('找绮园100-200平轻餐饮空置房源')]){
   const result=await agent.prepare({question,intent:'business',history});
   assert.equal(result.recordLookup,undefined,question);
  }
 }
 const resumed=await agent.prepare({question:'还有吗',intent:'business',history:userHistory('找绮园100-200平轻餐饮空置房源','所有客户本周怎么推进？')});
 assert.equal(resumed.recordLookup,undefined,'a followup of a different topic must not revive older property filters');
});

test('area replacement, rented-status refinement and a third-turn page retain the original place and usage',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const agent=await inventoryFixture(f);
 const initial='找绮园120-200平轻餐饮空置房源';
 const first=await agent.prepare({question:initial});assert.equal(first.recordLookup?.total,21);
 const refine='面积改成140-160平';
 const second=await agent.prepare({question:refine,history:userHistory(initial)});assert.equal(second.recordLookup?.total,20);
 const status='那在租房源呢';
 const third=await agent.prepare({question:status,history:userHistory(initial,refine)});assert.equal(third.recordLookup?.total,20);
 const fourth=await agent.prepare({question:'下一页',history:userHistory(initial,refine,status)});
 assert.equal(fourth.recordLookup?.total,20);assert.equal(fourth.knowledge.length,10);
 assert.match(fourth.answer!,/在租房源-10号商铺/);assert.doesNotMatch(fourth.answer!,/空置房源-|在租房源-20号|在租房源-21号|在租房源-22号|在租房源-23号|在租房源-24号/);
});

test('pagination cannot erase an unresolved approximate-area clarification',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const agent=await inventoryFixture(f);
 const initial='找100平左右空置房源';
 const first=await agent.prepare({question:initial});assert.match(first.answer!,/范围|明确/);assert.equal(first.knowledge.length,0);
 const next=await agent.prepare({question:'下一页',history:userHistory(initial)});
 assert.match(next.answer!,/范围|明确/);assert.equal(next.knowledge.length,0);assert.equal(next.recordLookup?.total,0);
});

test('adding an upper area bound keeps the existing lower bound',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const agent=await inventoryFixture(f);
 const first='找绮园100平以上轻餐饮空置房源';
 for(const question of ['200平以下','再加个条件，200平以下']){
  const result=await agent.prepare({question,history:userHistory(first)});
  assert.equal(result.recordLookup?.total,21,question+'\n'+result.answer);
  assert.doesNotMatch(result.answer!,/空置房源-20号商铺|空置房源-21号商铺/);
 }
});

test('the reusable property answer uses its default answer budget before paging and generation',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const agent=await inventoryFixture(f);
 const result=await agent.answer({question:'所有空置房源'});
 assert.equal(result.action,'answer');assert.equal(result.recordLookup?.total,25);
 assert.ok(result.answer&&result.answer.length<=2000);assert.match(result.answer!,/下一页/);
});

test('an explicitly routed request for the customers own shop requirements recalls facts rather than inventory',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const agent=await inventoryFixture(f);
 const result=await agent.answer({question:'我之前说想找多少面积的商铺？',intent:'customer_memory',context:[{id:'need-1',kind:'customer_fact',text:'客户想找120平方米商铺。'}]});
 assert.equal(result.action,'answer');assert.match(result.answer!,/120平方米/);assert.doesNotMatch(result.answer!,/未找到|第1\/|空置房源/);
});

test('resolved property state survives more than six page turns after the original question leaves history',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const library=await f.store.createLibrary('空置房源','zs');
 await f.store.upload({libraryId:library.id,title:'空置房源',fileName:'空置房源.xlsx',text:'## 工作表：空置房源\n第1行：A1=铺号；B1=面积（㎡）；C1=业态；D1=位置\n'+Array.from({length:80},(_,i)=>{const n=i+2;return `第${n}行：A${n}=A-${i}号商铺；B${n}=150；C${n}=轻餐饮；D${n}=绮园商业街`;}).join('\n'),strategy:'flat'});
 const agent=createWorkbenchKnowledgeAgent(f.db,'alice','https://example.test',{departmentId:'zs'});
 const question='找绮园140-160平轻餐饮空置房源';
 let previous=await agent.prepare({question});let previousQuestion=question;
 const history:{role:'user'|'assistant';content:string}[]=[];
 assert.ok(previous.recordLookup?.query,'the first run must return resolved filters');
 for(let page=2;page<=8;page++){
  history.push({role:'user',content:previousQuestion},{role:'assistant',content:previous.answer!});
  previous=await agent.prepare({question:'下一页',history:history.slice(-12),propertyQuery:previous.recordLookup!.query});
  previousQuestion='下一页';
  assert.equal(previous.recordLookup?.query?.page,page);
  assert.equal(previous.recordLookup?.total,80);
  assert.match(previous.answer!,new RegExp(`A-${(page-1)*10}号商铺`));
 }
 assert.equal(history.slice(-12).some(turn=>turn.content===question),false);
});

test('fresh property searches and topic resets ignore saved filters while saved state cannot change source permissions',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const agent=await inventoryFixture(f);
 const first=await agent.prepare({question:'找绮园140-160平轻餐饮空置房源'});
 const saved=first.recordLookup?.query;assert.ok(saved);
 const fresh=await agent.prepare({question:'所有在租房源',propertyQuery:saved});
 assert.equal(fresh.recordLookup?.query?.status,'rented');assert.equal(fresh.recordLookup?.total,25);
 const reset=await agent.prepare({question:'换个话题，所有客户本周怎么推进？',propertyQuery:saved});
 assert.equal(reset.recordLookup,undefined);
 const secretLibrary=await f.store.createLibrary('空置房源','yy');
 await f.store.upload({libraryId:secretLibrary.id,title:'空置房源',fileName:'secret.xlsx',text:'## 工作表：空置房源\n第1行：A1=铺号；B1=面积（㎡）；C1=业态；D1=位置\n第2行：A2=PRIVATE-YY；B2=150；C2=轻餐饮；D2=绮园商业街',strategy:'flat'});
 const tampered={...saved,libraryIds:[secretLibrary.id],departmentId:'yy',ownerId:'bob'} as unknown as PropertyQuery;
 const result=await agent.prepare({question:'下一页',propertyQuery:tampered});
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE-YY|secret\.xlsx/);
 assert.equal(result.knowledge.length,0,'scope fields are rejected rather than interpreted as filters');
});

test('customer inventory lookup answers the reported private message with matching vacant rows within 500 characters', async t => {
 const f = fixture();
 t.after(() => f.sqlite.close());
 for (const [department, title, address, area] of [
  ['zs', '空置房源', '3-3-2号商铺', '86'],
  ['zs', '空置房源', '5-3-4号商铺', '86.28'],
  ['zs', '在租房源', '在租专用地址', '92'],
  ['yy', '空置房源', '他部门地址', '88'],
 ] as const) {
  const library = await f.store.createLibrary(title, department);
  await f.store.upload({
   libraryId: library.id, title, fileName: title + '.xlsx', strategy: 'flat',
   text: '## 工作表：' + title + '\n第1行：A1=区块；B1=地址；C1=面积；D1=建议业态；E1=备注\n' +
    '第2行：A2=绮园商业街；B2=' + address + '；C2=' + area + '；D2=轻餐饮；E2=内部备注 13800138000',
  });
 }
 const agent = createWorkbenchKnowledgeAgent(f.db, 'alice', 'https://example.test', {departmentId:'zs'});
 const question = '现在80-100平的空置商铺还有吗';
 const answer = await agent.answer({question, intent:'business', audience:'customer'});
 assert.equal(answer.action, 'answer');
 assert.equal(answer.recordLookup?.total, 2);
 assert.equal(answer.route, 'retrieved');
 assert.ok(answer.answer && answer.answer.length > 60 && answer.answer.length <= 500);
 assert.match(answer.answer, /绮园商业街.*(?:3-3-2|5-3-4)号商铺/);
 assert.match(answer.answer, /面积86(?:\.28)?/);
 assert.match(answer.answer, /单位未标/);
 assert.match(answer.answer, /3-3-2号商铺/);
 assert.match(answer.answer, /5-3-4号商铺/);
 assert.doesNotMatch(answer.answer, /内部备注|13800138000|在租专用地址|他部门地址|\.xlsx|第2行/);
 assert.ok(answer.evidenceIds.length);
 assert.ok(answer.evidenceIds.every(id => answer.knowledge.some(source => source.id === id)));
 const unmatched = await agent.answer({question:'现在800-1000平的空置商铺还有吗', intent:'business', audience:'customer'});
 assert.equal(unmatched.action, 'handoff');
 assert.equal(unmatched.route, 'no_evidence');
 assert.equal(unmatched.answer, undefined);
});

test('an informal shop inquiry searches authorized vacancies by the requested city', async t => {
 const f = fixture();
 t.after(() => f.sqlite.close());
 for(const [department,title,table] of [
  ['zs','空置房源','嘉兴中山路1号,90,普通\n嘉兴中山路2号,100,普通\n海盐城东路3号,95,嘉兴总部'],
  ['zs','在租房源','嘉兴在租路4号,92,普通'],
  ['yy','空置房源','嘉兴其他部门5号,88,普通'],
 ] as const){
  const library=await f.store.createLibrary(title,department);
  await f.store.upload({libraryId:library.id,title,fileName:title+'.csv',strategy:'flat',text:'地址,面积（㎡）,备注\n'+table});
 }
 const agent=createWorkbenchKnowledgeAgent(f.db,'alice','https://example.test',{departmentId:'zs'});
 const ask=(text:string)=>chooseProspectChatAction({campaign:{name:'嘉兴',requirements:'嘉兴商铺租赁',minIntentScore:70},conversation:{nickname:'测试客户'},messages:[],inbound:{id:'test-inbound',text}}, {preflightKnowledge:agent.preflight,answerKnowledge:agent.answer});
 const result=await ask('是的，我在嘉兴找店铺，你有？');
 assert.equal(result.action,'reply');
 assert.match(result.reply!,/嘉兴中山路1号/);
 assert.match(result.reply!,/嘉兴中山路2号/);
 assert.doesNotMatch(result.reply!,/海盐|在租路|其他部门/);
 assert.equal(result.evidenceIds?.length,2);
 assert.ok(result.evidenceIds?.every(id=>id.startsWith('property-record:')));
 assert.deepEqual(result.answeredMessageIds,['test-inbound']);
 const availability=await ask('嘉兴有店铺出租吗？');
 assert.deepEqual(availability.evidenceIds,result.evidenceIds);
 const missing=await ask('我在杭州找店铺，你有？');
 assert.equal(missing.action,'handoff');
 assert.equal(missing.reply,undefined);
 const remarkOnly=await ask('嘉兴总部有店铺吗？');
 assert.equal(remarkOnly.action,'handoff');
});

test('customer inventory pages keep complete distinct rows within the reply limit', async t => {
 const f = fixture();
 t.after(() => f.sqlite.close());
 const agent = await inventoryFixture(f);
 const question = '所有空置房源';
 const first = await agent.answer({question,intent:'business',audience:'customer',maxAnswerChars:900});
 assert.equal(first.action,'answer');
 assert.ok(first.answer && first.answer.length > 60 && first.answer.length <= 500);
 assert.match(first.answer,/下一页/);
 assert.ok(first.evidenceIds.length > 1);
 const second = await agent.answer({
  question:'下一页',intent:'business',audience:'customer',
  history:[{role:'user',content:question},{role:'assistant',content:first.answer}],
 });
 assert.equal(second.action,'answer');
 assert.ok(second.answer && second.answer.length <= 500);
 assert.ok(second.evidenceIds.length > 0);
 assert.ok(second.evidenceIds.every(id => !first.evidenceIds.includes(id)));
});
