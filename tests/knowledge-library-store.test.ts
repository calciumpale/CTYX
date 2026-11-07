import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createKnowledgeLibraryStore } from '../app/lib/knowledge-library-store.ts';
import type { KnowledgeChunkDraft } from '../app/lib/knowledge-library-types.ts';

const flat=(text:string,ordinal=1):KnowledgeChunkDraft=>({ordinal,parentOrdinal:null,kind:'flat',text,heading:''});
function fixture(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
 for(const file of readdirSync(new URL('../drizzle/',import.meta.url)).filter(x=>x.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(`../drizzle/${file}`,import.meta.url),'utf8'));
 let queue:Promise<unknown>=Promise.resolve();
 const db={prepare(sql:string){let values:unknown[]=[];return{bind(...args:unknown[]){assert.ok(args.length<=100);values=args;return this;},async first(){return sqlite.prepare(sql).get(...values as never[])??null;},async all(){return{results:sqlite.prepare(sql).all(...values as never[])};},async run(){const statement=sqlite.prepare(sql);return statement.columns().length?{results:statement.all(...values as never[]),meta:{changes:0}}:{results:[],meta:{changes:Number(statement.run(...values as never[]).changes)}};}};},batch(items:{run:()=>Promise<unknown>}[]){const execute=async()=>{sqlite.exec('BEGIN');try{const out=[];for(const item of items)out.push(await item.run());sqlite.exec('COMMIT');return out;}catch(error){sqlite.exec('ROLLBACK');throw error;}};const result=queue.then(execute,execute);queue=result.catch(()=>{});return result;}} as unknown as D1Database;
 return{sqlite,store:createKnowledgeLibraryStore(db,'alice'),other:createKnowledgeLibraryStore(db,'bob'),db};
}
async function add(store:ReturnType<typeof createKnowledgeLibraryStore>,texts:string[],name='资料库'){
 const library=await store.createLibrary(name);const document=await store.addDocument({libraryId:library.id,title:'安装指南',fileName:'guide.md',strategy:'flat',chunks:texts.map((text,i)=>flat(text,i+1))});return{library,document};
}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}

test('libraries, documents, chunks and deletes are isolated by owner and lexical search works before embeddings',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const {library,document}=await add(f.store,['安装红色管道时需要关闭阀门。']);
 assert.equal((await f.store.snapshot()).libraries[0].documentCount,1);assert.equal((await f.store.snapshot()).documents[0].status,'pending');assert.equal((await f.store.snapshot('configured-model')).documents[0].error,null);
 assert.deepEqual(await f.other.snapshot(),{libraries:[],documents:[]});
 for(const work of [()=>f.other.renameLibrary(library.id,'窃取'),()=>f.other.chunks(document.id),()=>f.other.removeDocument(document.id),()=>f.other.indexDocument(document.id,'model',async()=>[[1,0]])])await assert.rejects(work,{status:404});
 assert.equal((await f.other.search({query:'红色管道',mode:'bm25'})).hits.length,0);
 const found=await f.store.search({query:'红色管道',mode:'bm25'});assert.equal(found.hits[0].documentId,document.id);assert.match(found.hits[0].context,/关闭阀门/);
 await f.store.renameLibrary(library.id,'产品知识');assert.equal((await f.store.snapshot()).libraries[0].name,'产品知识');
 await f.store.removeDocument(document.id);assert.equal((await f.store.search({query:'红色管道',mode:'bm25'})).hits.length,0);assert.equal((await f.store.snapshot()).libraries[0].documentCount,0);
});

test('parent-child search returns distinct parent context and preserves child evidence',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const library=await f.store.createLibrary('维修');
 const document=await f.store.addDocument({libraryId:library.id,title:'水泵维护',fileName:'泵.md',strategy:'parent-child',chunks:[
  {ordinal:1,parentOrdinal:null,kind:'parent',heading:'保养',text:'水泵保养：先断电，再拆开过滤器。两个步骤必须一起执行。'},
  {ordinal:2,parentOrdinal:1,kind:'child',heading:'保养',text:'水泵保养先断电。'},
  {ordinal:3,parentOrdinal:1,kind:'child',heading:'保养',text:'水泵保养拆开过滤器。'},
 ]});
 assert.equal(document.chunkCount,2);assert.equal((await f.store.chunks(document.id)).length,3);
 const result=await f.store.search({query:'水泵保养',libraryId:library.id,mode:'bm25',limit:5});assert.equal(result.hits.length,1);assert.equal(result.hits[0].parent,true);assert.match(result.hits[0].context,/两个步骤/);assert.notEqual(result.hits[0].matchedText,result.hits[0].context);
 await assert.rejects(f.store.addDocument({libraryId:library.id,title:'无父节点',fileName:'bad.txt',strategy:'parent-child',chunks:[{ordinal:1,parentOrdinal:9,kind:'child',heading:'',text:'无父节点'}]}),{status:400});
});

test('indexing commits at most sixteen vectors per call and complete repeated calls do not embed again',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const {document}=await add(f.store,Array.from({length:17},(_,i)=>`片段${i} 安装指南`));const sizes:number[]=[];
 const embed=async(texts:string[])=>{sizes.push(texts.length);return texts.map(()=>[1,0]);};
 const first=await f.store.indexDocument(document.id,'model-v1',embed);assert.equal(first.indexedCount,16);assert.equal(first.status,'pending');
 const second=await f.store.indexDocument(document.id,'model-v1',embed);assert.equal(second.indexedCount,17);assert.equal(second.status,'ready');
 await f.store.indexDocument(document.id,'model-v1',embed);assert.deepEqual(sizes,[16,1]);
 const outdated=await f.store.snapshot('model-v2');assert.equal(outdated.documents[0].status,'pending');assert.equal(outdated.documents[0].indexedCount,0);assert.equal((await f.store.snapshot()).documents[0].status,'ready');
});

test('invalid vector batches are atomic, marked failed and remain searchable by keyword',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const {document}=await add(f.store,['维护保养','维护周期']);
 const failed=await f.store.indexDocument(document.id,'model',async()=>[[1,0],[0,0]]);assert.equal(failed.status,'error');assert.equal(failed.indexedCount,0);assert.ok(failed.error);
 assert.equal((await f.store.search({query:'维护',mode:'bm25'})).hits.length,2);
 const recovered=await f.store.indexDocument(document.id,'model',async texts=>texts.map(()=>[1,0]));assert.equal(recovered.status,'ready');assert.equal(recovered.error,null);
});

test('a stale model indexing completion or failure cannot overwrite a newer generation',async t=>{
 for(const fail of [false,true]){
  const f=fixture();t.after(()=>f.sqlite.close());const {document}=await add(f.store,['预算方案']);const started=deferred<void>(),finish=deferred<number[][]>();
  const previous=f.store.indexDocument(document.id,'old-model',async()=>{started.resolve();const vectors=await finish.promise;if(fail)throw Error('old failure secret');return vectors;});await started.promise;
  await f.store.indexDocument(document.id,'new-model',async()=>[[0,1]]);finish.resolve([[1,0]]);await previous;
  assert.equal((await f.store.snapshot('new-model')).documents[0].status,'ready');
  const result=await f.store.search({query:'查询',mode:'vector',modelKey:'new-model',embed:async()=>[0,1]});assert.equal(result.hits[0].vector,1);
  assert.equal((await f.store.search({query:'预算',mode:'vector',modelKey:'old-model',embed:async()=>[1,0]})).hits.length,0);
 }
});

test('concurrent same-model requests lease one batch and deletion during embedding cannot resurrect a document',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const {document}=await add(f.store,['合同条款']);const started=deferred<void>(),finish=deferred<number[][]>();let calls=0;
 const inFlight=f.store.indexDocument(document.id,'model',async()=>{calls++;started.resolve();return finish.promise;});await started.promise;
 await f.store.indexDocument(document.id,'model',async()=>{calls++;return[[0,1]];});assert.equal(calls,1);
 await f.store.removeDocument(document.id);finish.resolve([[1,0]]);await assert.rejects(inFlight,{status:404});assert.deepEqual((await f.store.snapshot()).documents,[]);
});

test('hybrid degrades with notice while explicit vector mode never silently supplies keyword hits',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const {document}=await add(f.store,['空调产品 AB-12 安装说明']);
 const hybrid=await f.store.search({query:'ＡＢ－１２',mode:'hybrid'});assert.equal(hybrid.mode,'bm25');assert.equal(hybrid.hits.length,1);assert.ok(hybrid.notice);
 const vector=await f.store.search({query:'AB-12',mode:'vector'});assert.equal(vector.mode,'vector');assert.equal(vector.hits.length,0);assert.ok(vector.notice);
 await f.store.indexDocument(document.id,'model',async()=>[[1,0]]);
 const failure=await f.store.search({query:'AB-12',mode:'hybrid',modelKey:'model',embed:async()=>{throw Error('private API token');}});assert.equal(failure.hits.length,1);assert.ok(!failure.notice?.includes('private API token'));
 assert.equal((await f.store.search({query:'" OR * (',mode:'bm25'})).hits.length,0);
});

test('empty or unindexed scopes never call the query embedding provider',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const {library}=await add(f.store,['待索引资料']);let calls=0;
 for(const mode of ['vector','hybrid'] as const){const result=await f.store.search({query:'资料',libraryId:library.id,mode,modelKey:'model',embed:async()=>{calls++;return[1,0];}});assert.ok(result.notice);}
 await f.other.search({query:'资料',mode:'vector',modelKey:'model',embed:async()=>{calls++;return[1,0];}});assert.equal(calls,0);
});

test('a dimension change between batches preserves committed vectors and marks the remaining batch failed',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const {document}=await add(f.store,Array.from({length:17},(_,i)=>`参数片段${i}`));
 await f.store.indexDocument(document.id,'model',async texts=>texts.map(()=>[1,0]));const failed=await f.store.indexDocument(document.id,'model',async()=>[[1,0,0]]);
 assert.equal(failed.status,'error');assert.equal(failed.indexedCount,16);assert.ok((await f.store.search({query:'参数',mode:'hybrid',modelKey:'model',embed:async()=>[1,0]})).notice);
});

test('hybrid fusion rewards lexical and vector consensus and honors library filters',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const {library,document}=await add(f.store,['保修 保修 保修','保修服务条款','完全无关内容']);
 await f.store.indexDocument(document.id,'model',async()=>[[0,1],[0.9,0.1],[1,0]]);
 const result=await f.store.search({query:'保修',mode:'hybrid',modelKey:'model',embed:async()=>[1,0],limit:3});assert.equal(result.hits[0].matchedText,'保修服务条款');assert.ok(result.hits[0].bm25!==null&&result.hits[0].vector!==null);
 const isolated=await f.store.createLibrary('空库');assert.equal((await f.store.search({query:'保修',libraryId:isolated.id,mode:'hybrid',modelKey:'model',embed:async()=>[1,0]})).hits.length,0);
 assert.equal((await f.store.search({query:'保修',libraryId:library.id,mode:'bm25'})).hits.length,2);
});

test('real Excel import survives persistence, both chunk strategies and all retrieval modes with source evidence',async t=>{
 const xlsx=await import('xlsx');const {importKnowledgeFile}=await import('../app/lib/knowledge-library-import.ts');const {splitKnowledgeText}=await import('../app/lib/knowledge-library-chunks.ts');
 const workbook=xlsx.utils.book_new();
 xlsx.utils.book_append_sheet(workbook,xlsx.utils.aoa_to_sheet([['型号','安装要求'],['AB-12','仅限室内使用']]),'产品');
 xlsx.utils.book_append_sheet(workbook,xlsx.utils.aoa_to_sheet([['型号','保修期'],[],['AB-12','保修三年']]),'售后');
 const imported=await importKnowledgeFile(new File([xlsx.write(workbook,{bookType:'xlsx',type:'array'})],'产品与售后.xlsx'));
 for(const strategy of ['flat','parent-child'] as const){
  const f=fixture();t.after(()=>f.sqlite.close());const library=await f.store.createLibrary(`Excel ${strategy}`);
  const document=await f.store.addDocument({libraryId:library.id,title:'产品与售后',fileName:imported.fileName,strategy,chunks:splitKnowledgeText(imported.text,strategy)});
  for(const mode of ['bm25','hybrid'] as const){
   const result=await f.store.search({query:'保修三年',mode,libraryId:library.id});
   const found=result.hits.find(hit=>hit.heading==='工作表：售后');assert.ok(found);assert.equal(found.fileName,'产品与售后.xlsx');assert.match(found.context,/第3行：A3=AB-12；B3=保修三年/);assert.equal(found.parent,strategy==='parent-child');
   if(mode==='hybrid'){assert.equal(result.mode,'bm25');assert.ok(result.notice);}
  }
  await f.store.indexDocument(document.id,'synthetic-model',async texts=>texts.map(text=>text.includes('保修三年')?[1,0]:[0,1]));
  for(const mode of ['vector','hybrid'] as const){
   const result=await f.store.search({query:'保修三年',mode,libraryId:library.id,modelKey:'synthetic-model',embed:async()=>[1,0]});
   assert.equal(result.hits[0].heading,'工作表：售后');assert.equal(result.hits[0].fileName,'产品与售后.xlsx');assert.match(result.hits[0].context,/第3行/);
  }
  assert.equal((await f.other.search({query:'保修三年',mode:'bm25'})).hits.length,0);
  await assert.rejects(f.other.chunks(document.id),{status:404});
 }
});
