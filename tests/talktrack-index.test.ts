import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createTalkIndex } from '../app/lib/talktrack-index.ts';
import type { TalkTrack } from '../app/lib/talktrack-types.ts';

const model='https://embeddings.example.com/v1#semantic-model';
function track(id:string,overrides:Partial<TalkTrack>={}):TalkTrack {
  return {id,title:`林晓${id}话术 v1.0`,topic:id,scenario:'预算异议处理',template:'先确认{目标}，再讨论分阶段交付。',keywords:['核心目标'],objectionLogic:['明确首期范围'],steps:['确认目标','匹配方案'],boundaries:['不能承诺未授权折扣'],leadTypes:['企业采购'],evidence:[{transcriptId:'transcript-1',quote:'先确认核心目标'}],confidence:0.85,employeeId:'sales-1',employeeName:'林晓',dealId:'deal-1',status:'published',version:1,weight:1,createdAt:'2026-10-24T03:00:00.000Z',updatedAt:'2026-10-24T03:00:00.000Z',...overrides};
}
function fixture() {
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../drizzle/0002_lowly_pet_avengers.sql',import.meta.url),'utf8'));
  const queries:{sql:string;bindings:number}[]=[];
  const db={prepare(sql:string){let values:(string|number)[]=[];return {
    bind(...bound:(string|number)[]){values=bound;queries.push({sql,bindings:values.length});if(values.length>100)throw new Error('D1 binding limit exceeded');return this;},
    async all(){return {success:true,results:sqlite.prepare(sql).all(...values)};},
    async run(){const result=sqlite.prepare(sql).run(...values);return {success:true,meta:{changes:Number(result.changes)}};},
  };}} as unknown as D1Database;
  return {sqlite,queries,index:createTalkIndex(db,'alice'),db};
}

test('failed optimistic text edits retain separate vectors and canonical text selects its own embedding',async(t)=>{
  const {sqlite,index}=fixture();t.after(()=>sqlite.close());
  const winning=track('same-track');const losing={...winning,template:'另一位审核者尚未提交成功的模板。'};
  await index.upsert(winning,[1,0],model);await index.upsert(losing,[0,1],model);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM workbench_talk_vectors').get()?.count,2);
  assert.deepEqual((await index.all([winning],model))[0].vector,[1,0]);
  assert.deepEqual((await index.all([losing],model))[0].vector,[0,1]);
  assert.deepEqual((await index.search([1,0],model,[winning])).map(item=>item.id),['same-track']);
  assert.deepEqual(await index.search([1,0],model,[losing]),[]);
  await index.upsert(winning,[0.8,0.2],model);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM workbench_talk_vectors').get()?.count,2);
  assert.deepEqual((await index.all([winning],model))[0].vector,[0.8,0.2]);
});

test('model changes select only that model cache and missing current models fail without partial retrieval',async(t)=>{
  const {sqlite,index}=fixture();t.after(()=>sqlite.close());const first=track('first');const second=track('second');
  await index.upsert(first,[1,0],model);await index.upsert(first,[0,1],`${model}-new`);await index.upsert(second,[1,0],model);
  assert.deepEqual((await index.all([first],model))[0].vector,[1,0]);assert.deepEqual((await index.all([first],`${model}-new`))[0].vector,[0,1]);
  await assert.rejects(index.all([first,second],`${model}-new`),{status:409});
  await assert.rejects(index.search([1,0],`${model}-new`,[first,second]),{status:409});
  await assert.rejects(index.all([first],`${model}-absent`),{status:409});
});

test('41 canonical tracks are completely read with each D1 statement below its parameter limit',async(t)=>{
  const {sqlite,index,queries}=fixture();t.after(()=>sqlite.close());const tracks=Array.from({length:41},(_,i)=>track(`track-${i}`));
  for(const item of tracks)await index.upsert(item,[1,0],model);
  const results=await index.all(tracks,model);assert.equal(results.length,41);
  assert.deepEqual(new Set(results.map(item=>item.id)),new Set(tracks.map(item=>item.id)));
  const reads=queries.filter(query=>query.sql.startsWith('SELECT'));
  assert.ok(reads.length>1);assert.ok(reads.every(query=>query.bindings<100));
});

test('RAG eligibility follows canonical publication and weight rather than stale cached statuses',async(t)=>{
  const {sqlite,index}=fixture();t.after(()=>sqlite.close());
  const approved=track('approved');const pending=track('pending',{status:'candidate'});const archived=track('archived',{status:'archived'});const rejected=track('rejected',{status:'rejected'});const disabled=track('disabled',{weight:0});
  await index.upsert(approved,[1,0],model,'candidate');
  for(const item of [pending,archived,rejected,disabled])await index.upsert(item,[1,0],model,'published');
  const canonical=[pending,archived,approved,rejected,disabled];
  assert.deepEqual((await index.search([1,0],model,canonical)).map(item=>item.id),['approved']);
  assert.deepEqual(await index.search([1,0],model,[pending,archived,rejected,disabled]),[]);
});

test('search ranks actual cosine times canonical weight and returns only the top three relevant tracks',async(t)=>{
  const {sqlite,index}=fixture();t.after(()=>sqlite.close());
  const exact=track('exact-downweighted',{weight:0.5});const near=track('near');const partial=track('partial');const fourth=track('fourth',{weight:0.4});const weak=track('weak',{weight:0.3});const opposite=track('opposite');
  for(const [item,vector] of [[exact,[1,0]],[near,[4,3]],[partial,[3,4]],[fourth,[1,0]],[weak,[1,0]],[opposite,[-1,0]]] as [TalkTrack,number[]][])await index.upsert(item,vector,model);
  const result=await index.search([1,0],model,[weak,exact,fourth,opposite,partial,near]);
  assert.deepEqual(result.map(item=>item.id),['near','partial','exact-downweighted']);
});

test('workspace identity is included in both vector writes and canonical reads',async(t)=>{
  const {sqlite,index,db}=fixture();t.after(()=>sqlite.close());const other=createTalkIndex(db,'bob');const item=track('shared-id');
  await index.upsert(item,[1,0],model);await other.upsert(item,[0,1],model);
  assert.deepEqual((await index.all([item],model))[0].vector,[1,0]);assert.deepEqual((await other.all([item],model))[0].vector,[0,1]);
  assert.equal((await index.search([1,0],model,[item])).length,1);assert.equal((await other.search([1,0],model,[item])).length,0);
});
