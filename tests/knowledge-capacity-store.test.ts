import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createKnowledgeLibraryStore } from '../app/lib/knowledge-library-store.ts';
import { splitKnowledgeText } from '../app/lib/knowledge-library-chunks.ts';
import type { KnowledgeChunkDraft } from '../app/lib/knowledge-library-types.ts';

function fixture({forbidVectorReads=false,forbidRepeatedFts=false}={}){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
 for(const file of readdirSync(new URL('../drizzle/',import.meta.url)).filter(file=>file.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(`../drizzle/${file}`,import.meta.url),'utf8'));
 const stats={requests:0,largestVectorPage:0,largestVectorBatch:0};let inBatch=false;
 const db={prepare(sql:string){
  assert.ok(Buffer.byteLength(sql)<=100_000,'SQL exceeds the D1 statement limit');let values:unknown[]=[];
  const execute=()=>{
   if(!inBatch)stats.requests++;
   if(forbidRepeatedFts&&sql.includes('workbench_knowledge_fts MATCH')){
    const plan=sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values as never[]);
    const outer=plan.find(row=>/^(SCAN|SEARCH) /.test(String(row.detail)));
    if(!String(outer?.detail).startsWith('SCAN workbench_knowledge_fts'))throw new Error('FTS must be filtered before joining each chunk');
   }
   const statement=sqlite.prepare(sql);
   if(forbidVectorReads&&statement.columns().some(column=>column.name==='vector_json'))throw new Error('Vector payloads must not be loaded for a document preview');
   const results=statement.columns().length?statement.all(...values as never[]):[];
   const changes=statement.columns().length?0:Number(statement.run(...values as never[]).changes);
   if(/SELECT[\s\S]*vector_json/.test(sql)){stats.largestVectorPage=Math.max(stats.largestVectorPage,results.length);}
   return{success:true,results,meta:{changes}};
  };
  return{bind(...args:unknown[]){
   assert.ok(args.length<=100,'too many D1 parameters');
   for(const arg of args)if(typeof arg==='string')assert.ok(Buffer.byteLength(arg)<2_000_000,'bound value exceeds D1 size limit');
   values=args;return this;
  },async first(){return execute().results[0]??null;},async all(){return execute();},async run(){return execute();}};
 },async batch(items:{run:()=>Promise<{results:Record<string,unknown>[];meta:{changes:number}}>}[]){
  stats.requests++;inBatch=true;sqlite.exec('BEGIN');
  try{const out=[];for(const item of items)out.push(await item.run());sqlite.exec('COMMIT');
   const vectorCount=out.reduce((sum,result)=>sum+result.results.filter(row=>typeof row.vector_json==='string').length,0);
   stats.largestVectorBatch=Math.max(stats.largestVectorBatch,vectorCount);return out;
  }catch(error){sqlite.exec('ROLLBACK');throw error;}finally{inBatch=false;}
 }} as unknown as D1Database;
 return{sqlite,stats,store:createKnowledgeLibraryStore(db,'alice')};
}
const flat=(text:string,ordinal:number):KnowledgeChunkDraft=>({ordinal,parentOrdinal:null,kind:'flat',text,heading:''});

test('one million source characters persist completely and the tail is searchable for both chunk strategies',async t=>{
 const tail=' FINALCAPACITY9';const source='capacity '.repeat(112_000).slice(0,1_000_000-tail.length)+tail;
 assert.equal(source.length,1_000_000);
 for(const strategy of ['flat','parent-child'] as const){
  const f=fixture();t.after(()=>f.sqlite.close());const library=await f.store.createLibrary(strategy);
  const chunks=splitKnowledgeText(source,strategy);assert.ok(chunks.length>1_000);
  const document=await f.store.addDocument({libraryId:library.id,title:'大资料',fileName:'large.txt',strategy,chunks});
  const persisted=await f.store.chunks(document.id);assert.deepEqual(persisted.map(chunk=>({ordinal:chunk.ordinal,parentOrdinal:chunk.parentOrdinal,kind:chunk.kind,text:chunk.text,heading:chunk.heading})),chunks);
  const result=await f.store.search({query:'FINALCAPACITY9',mode:'bm25',libraryId:library.id});
  assert.equal(result.hits.length,1);assert.match(result.hits[0].matchedText,/FINALCAPACITY9/);assert.equal(result.hits[0].parent,strategy==='parent-child');assert.equal(result.notice,null);
 }
});

test('vector retrieval reaches the six thousandth chunk within D1 request limits and bounded vector pages',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const library=await f.store.createLibrary('向量资料');
 const document=await f.store.addDocument({libraryId:library.id,title:'向量资料',fileName:'vectors.txt',strategy:'flat',chunks:Array.from({length:6_000},(_,i)=>flat(`vector evidence ${i+1}`,i+1))});
 f.sqlite.prepare("UPDATE workbench_knowledge_documents SET model_key='model',status='ready',indexed_count=6000,dimension=2 WHERE id=?").run(document.id);
 f.sqlite.prepare("UPDATE workbench_knowledge_chunks SET vector_model='model',vector_json=CASE WHEN ordinal=6000 THEN '[1,0]' ELSE '[0,1]' END WHERE document_id=?").run(document.id);
 for(const mode of ['vector','hybrid'] as const){
  f.stats.requests=0;
  const result=await f.store.search({query:'TAILSEMANTIC9',libraryId:library.id,mode,modelKey:'model',embed:async()=>[1,0]});
  assert.equal(result.hits.length,1);assert.equal(result.hits[0].ordinal,6_000);assert.equal(result.notice,null);
  assert.ok(f.stats.requests<=50,`search used ${f.stats.requests} D1 requests`);
 }
 assert.ok(f.stats.largestVectorPage<=40);assert.ok(f.stats.largestVectorBatch<=160);
 await f.store.addDocument({libraryId:library.id,title:'新资料',fileName:'new.txt',strategy:'flat',chunks:[flat('new evidence',1)]});
 const overflow=await f.store.search({query:'尾部资料',libraryId:library.id,mode:'vector',modelKey:'model',embed:async()=>[1,0]});
 assert.match(overflow.notice??'',/超过6000个检索片段/);assert.match(overflow.notice??'',/仅扫描最近6000个/);
});

test('CJK bulk payloads are split by UTF-8 bytes before reaching the D1 string limit',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const library=await f.store.createLibrary('中文资料');
 const document=await f.store.addDocument({libraryId:library.id,title:'中文资料',fileName:'cjk.txt',strategy:'flat',chunks:Array.from({length:400},(_,i)=>flat('汉'.repeat(2_000),i+1))});
 assert.equal(document.chunkCount,400);assert.equal((await f.store.chunks(document.id)).length,400);
});

test('document previews load public chunk columns without loading stored vector payloads',async t=>{
 const f=fixture({forbidVectorReads:true});t.after(()=>f.sqlite.close());const library=await f.store.createLibrary('预览资料');
 const document=await f.store.addDocument({libraryId:library.id,title:'预览资料',fileName:'preview.txt',strategy:'flat',chunks:[flat('可预览的完整正文',1)]});
 f.sqlite.prepare("UPDATE workbench_knowledge_chunks SET vector_json='[1,0]',vector_model='model' WHERE document_id=?").run(document.id);
 const chunks=await f.store.chunks(document.id);assert.equal(chunks.length,1);assert.equal(chunks[0].text,'可预览的完整正文');
});

test('common keyword retrieval filters FTS once before joining matching chunks',async t=>{
 const f=fixture({forbidRepeatedFts:true});t.after(()=>f.sqlite.close());const library=await f.store.createLibrary('共用关键词');
 await f.store.addDocument({libraryId:library.id,title:'产品资料',fileName:'common.txt',strategy:'flat',chunks:Array.from({length:20},(_,i)=>flat(`common evidence ${i}`,i+1))});
 const result=await f.store.search({query:'common',mode:'bm25',libraryId:library.id});assert.equal(result.hits.length,5);
});

test('a failed bulk import leaves no document, chunk or FTS residue and can be retried',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const library=await f.store.createLibrary('原子导入');
 const input={libraryId:library.id,title:'恢复测试',fileName:'recovery.txt',strategy:'flat' as const,chunks:Array.from({length:700},(_,i)=>flat('recovery '.repeat(150),i+1))};
 f.sqlite.exec("CREATE TRIGGER reject_chunk BEFORE INSERT ON workbench_knowledge_chunks WHEN NEW.ordinal=650 BEGIN SELECT RAISE(ABORT,'injected write failure'); END");
 await assert.rejects(f.store.addDocument(input),/injected write failure/);
 for(const table of ['workbench_knowledge_documents','workbench_knowledge_chunks','workbench_knowledge_fts'])assert.equal((f.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {count:number}).count,0);
 f.sqlite.exec('DROP TRIGGER reject_chunk');
 const document=await f.store.addDocument(input);assert.equal(document.chunkCount,700);assert.equal((await f.store.chunks(document.id)).length,700);
});
