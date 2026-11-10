import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createKnowledgeLibraryStore} from '../app/lib/knowledge-library-store.ts';
import {readPropertySources} from '../app/lib/property-source-store.ts';
import type {KnowledgeChunkDraft} from '../app/lib/knowledge-library-types.ts';

function fixture(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
 for(const file of readdirSync(new URL('../drizzle/',import.meta.url)).filter(x=>x.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(`../drizzle/${file}`,import.meta.url),'utf8'));
 const db={prepare(sql:string){let values:unknown[]=[];return{bind(...args:unknown[]){assert.ok(args.length<=100);values=args;return this;},async first(){return sqlite.prepare(sql).get(...values as never[])??null;},async all(){return{results:sqlite.prepare(sql).all(...values as never[])};},async run(){const statement=sqlite.prepare(sql);return statement.columns().length?{results:statement.all(...values as never[]),meta:{changes:0}}:{results:[],meta:{changes:Number(statement.run(...values as never[]).changes)}};}};},async batch(items:{run:()=>Promise<unknown>}[]){sqlite.exec('BEGIN');try{const result=[];for(const item of items)result.push(await item.run());sqlite.exec('COMMIT');return result;}catch(error){sqlite.exec('ROLLBACK');throw error;}}} as unknown as D1Database;
 return{sqlite,db,store:createKnowledgeLibraryStore(db,'alice'),other:createKnowledgeLibraryStore(db,'bob')};
}
const inventory='## 工作表：空置房源\n第1行：A1=铺号；B1=面积；C1=业态；D1=位置\n第2行：A2=A101；B2=85；C2=餐饮；D2=东区';
const flat=(text:string,ordinal=1,heading='工作表：空置房源'):KnowledgeChunkDraft=>({ordinal,parentOrdinal:null,kind:'flat',text,heading});

test('loads verified parsed originals under the owner, department and library intersection before vector indexing',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());
 const shared=await f.store.createLibrary('空置房源','shared'),zs=await f.store.createLibrary('招商台账','zs'),foreign=await f.store.createLibrary('空置房源','yy'),other=await f.other.createLibrary('空置房源','zs');
 const a=await f.store.upload({libraryId:shared.id,title:'空置铺位',fileName:'空置.xlsx',text:inventory});
 const b=await f.store.upload({libraryId:zs.id,title:'十一月台账',fileName:'台账.xlsx',text:inventory});
 await f.store.upload({libraryId:foreign.id,title:'空置',fileName:'空置.xlsx',text:inventory.replace('A101','SECRET')});
 await f.other.upload({libraryId:other.id,title:'空置',fileName:'空置.xlsx',text:inventory.replace('A101','OTHER')});
 const result=await readPropertySources(f.db,'alice',{departmentId:'zs'});
 assert.equal(result.complete,true);assert.deepEqual(result.issues,[]);
 assert.deepEqual(new Set(result.sources.map(s=>s.documentId)),new Set([a.id,b.id]));
 assert.ok(result.sources.every(s=>s.text===inventory));assert.equal(result.sources.find(s=>s.documentId===a.id)?.libraryName,'空置房源');
 const only=await readPropertySources(f.db,'alice',{departmentId:'zs',libraryIds:[zs.id,foreign.id]});
 assert.deepEqual(only.sources.map(s=>s.documentId),[b.id]);
 assert.deepEqual(await readPropertySources(f.db,'alice',{departmentId:'zs',libraryIds:[]}),{sources:[],complete:true,issues:[]});
 assert.equal((await readPropertySources(f.db,'alice',{departmentId:null})).sources.length,1);
});

test('selects a property worksheet in a mixed document but excludes unrelated knowledge',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const l=await f.store.createLibrary('通用资料','zs');
 const d=await f.store.upload({libraryId:l.id,title:'运营日报',fileName:'日报.xlsx',text:'## 工作表：公告\n今日正常营业。\n'+inventory});
 await f.store.upload({libraryId:l.id,title:'产品说明',fileName:'产品.txt',text:'普通产品使用说明。'});
 const result=await readPropertySources(f.db,'alice',{departmentId:'zs'});
 assert.deepEqual(result.sources.map(s=>s.documentId),[d.id]);assert.ok(result.sources[0].text.includes('第2行：A2=A101'));
});

test('rejects corrupted or incomplete current originals instead of falling back to apparently valid chunks',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const l=await f.store.createLibrary('空置房源');
 const corrupt=await f.store.upload({libraryId:l.id,title:'甲',fileName:'甲.xlsx',text:inventory});
 const missing=await f.store.upload({libraryId:l.id,title:'乙',fileName:'乙.xlsx',text:inventory});
 f.sqlite.prepare("UPDATE workbench_knowledge_sources SET text=text||'伪造' WHERE document_id=?").run(corrupt.id);
 f.sqlite.prepare('UPDATE workbench_knowledge_sources SET ordinal=2 WHERE document_id=?').run(missing.id);
 const result=await readPropertySources(f.db,'alice',{});
 assert.deepEqual(result.sources,[]);assert.equal(result.complete,false);assert.equal(result.issues.length,2);
});

test('reads only the active original version and checks its document hash',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const l=await f.store.createLibrary('空置房源');
 const d=await f.store.upload({libraryId:l.id,title:'库存',fileName:'库存.xlsx',text:inventory});
 const job=await f.store.beginRechunk({documentId:d.id,version:1,requestId:'new',config:{method:'recursive',chunkSize:750,overlapPercent:10,strategy:'flat'},text:inventory.replace('A101','A102'),rebuildIndex:false});
 await f.store.continueRechunk(job.job.id);
 const result=await readPropertySources(f.db,'alice',{});
 assert.equal(result.sources.length,1);assert.ok(result.sources[0].text.includes('A102'));assert.ok(!result.sources[0].text.includes('A101'));
 f.sqlite.prepare("UPDATE workbench_knowledge_documents SET source_hash='incorrect' WHERE id=?").run(d.id);
 assert.equal((await readPropertySources(f.db,'alice',{})).sources.length,0);
});

test('multi-page Unicode originals are joined exactly and every source page must agree on the hash',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const l=await f.store.createLibrary('在租房源');
 const text=inventory+'\n'+ '承租信息'.repeat(50_000);
 const d=await f.store.upload({libraryId:l.id,title:'大表',fileName:'在租.xlsx',text,config:{method:'fixed',chunkSize:6000,overlapPercent:0,strategy:'flat'}});
 const pages=f.sqlite.prepare('SELECT ordinal FROM workbench_knowledge_sources WHERE document_id=?').all(d.id);assert.ok(pages.length>1);
 const result=await readPropertySources(f.db,'alice',{});assert.equal(result.complete,true);assert.equal(result.sources[0].text,text);
 f.sqlite.prepare("UPDATE workbench_knowledge_sources SET hash='bad' WHERE document_id=? AND ordinal=1").run(d.id);
 const corrupt=await readPropertySources(f.db,'alice',{});assert.equal(corrupt.complete,false);assert.deepEqual(corrupt.sources,[]);
});

test('department revocation during a source read removes the now inaccessible result',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const l=await f.store.createLibrary('空置房源','zs');
 await f.store.upload({libraryId:l.id,title:'空置',fileName:'空置.xlsx',text:inventory});
 const raced={...f.db,prepare(sql:string){const statement=f.db.prepare(sql);if(!sql.includes('FROM workbench_knowledge_sources s'))return statement;return{bind(...values:unknown[]){statement.bind(...values as never[]);return this;},async all(){const result=await statement.all();f.sqlite.prepare("UPDATE workbench_knowledge_libraries SET department_id='yy' WHERE id=?").run(l.id);return result;}};}} as unknown as D1Database;
 const result=await readPropertySources(raced,'alice',{departmentId:'zs'});
 assert.equal(result.complete,false);assert.deepEqual(result.sources,[]);assert.ok(result.issues.length);
});

test('legacy parent chunks preserve sheet identity while child duplicates are excluded',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const l=await f.store.createLibrary('空置房源');
 const d=await f.store.addDocument({libraryId:l.id,title:'旧库存',fileName:'旧.xlsx',strategy:'parent-child',chunks:[
  {ordinal:1,parentOrdinal:null,kind:'parent',heading:'工作表：空置房源',text:inventory},
  {ordinal:2,parentOrdinal:1,kind:'child',heading:'工作表：空置房源',text:inventory},
 ]});
 const result=await readPropertySources(f.db,'alice',{});
 assert.equal(result.complete,true);assert.equal(result.sources[0].documentId,d.id);
 assert.equal(result.sources[0].text.match(/第2行/g)?.length,1);
});

test('legacy complete addressed cell continuations and exact overlaps do not lose or duplicate rows',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const l=await f.store.createLibrary('空置房源');
 const first=inventory+'\n第3行：A3=A102；',second='B3=110；C3=零售；D3=西区\n第4行：A4=A103；B4=120；C4=餐饮；D4=南区';
 await f.store.addDocument({libraryId:l.id,title:'旧库存',fileName:'旧.xlsx',strategy:'flat',chunks:[flat(first),flat(second,2),flat(second.slice(-30)+'\n第5行：A5=A104；B5=99；C5=餐饮；D5=北区',3)]});
 const result=await readPropertySources(f.db,'alice',{});
 assert.equal(result.complete,true);assert.match(result.sources[0].text,/第3行：A3=A102；B3=110；C3=零售；D3=西区/);
 assert.equal(result.sources[0].text.match(/A4=A103/g)?.length,1);assert.ok(result.sources[0].text.includes('第5行：A5=A104'));
});

test('legacy ambiguous mid-cell fragments reject the entire document instead of exposing partial rows',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const l=await f.store.createLibrary('空置房源');
 await f.store.addDocument({libraryId:l.id,title:'旧库存',fileName:'旧.xlsx',strategy:'flat',chunks:[flat(inventory+'\n第3行：A3=A102；B3=1'),flat('10；C3=零售；D3=西区\n第4行：A4=A103；B4=120',2)]});
 const result=await readPropertySources(f.db,'alice',{});
 assert.equal(result.complete,false);assert.ok(result.issues.length);assert.deepEqual(result.sources,[]);
});

test('missing middle legacy chunks never turn a truncated area into a complete inventory row',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const l=await f.store.createLibrary('空置房源');
 const d=await f.store.addDocument({libraryId:l.id,title:'旧库存',fileName:'旧.xlsx',strategy:'flat',chunks:[
  flat('## 工作表：空置房源\n第1行：A1=铺号；B1=面积；C1=业态；D1=位置\n第2行：A2=A101；B2=1'),
  flat('10；C2=餐饮；D2=东区',2),flat('第3行：A3=A102；B3=180；C3=零售；D3=西区',3),
 ]});
 f.sqlite.prepare('DELETE FROM workbench_knowledge_chunks WHERE document_id=? AND ordinal=2').run(d.id);
 const result=await readPropertySources(f.db,'alice',{});
 assert.equal(result.complete,false);assert.deepEqual(result.sources,[]);assert.ok(result.issues.length);
});

test('legacy ordinal gaps are rejected even if a stale count happens to equal the available chunks',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const l=await f.store.createLibrary('空置房源');
 await f.store.addDocument({libraryId:l.id,title:'旧库存',fileName:'旧.xlsx',strategy:'flat',chunks:[flat(inventory,1),flat('第3行：A3=A102；B3=180；C3=零售；D3=西区',3)]});
 const result=await readPropertySources(f.db,'alice',{});
 assert.equal(result.complete,false);assert.deepEqual(result.sources,[]);
});

test('legacy CSV fragments cannot invent a smaller area or a new row at a chunk boundary',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const l=await f.store.createLibrary('空置房源');
 await f.store.addDocument({libraryId:l.id,title:'旧库存',fileName:'旧.csv',strategy:'flat',chunks:[flat('房号,面积,地址\nA1,1',1,''),flat('20,东街\nA2,180,西街',2,'')]});
 const result=await readPropertySources(f.db,'alice',{});
 assert.equal(result.complete,false);assert.deepEqual(result.sources,[]);assert.ok(result.issues.length);
});

test('legacy parent coverage rejects missing chunks, orphan references and conflicting child text',async t=>{
 for(const mutation of ['missing parent','missing child','orphan child','conflicting child']){
  const f=fixture();t.after(()=>f.sqlite.close());const l=await f.store.createLibrary('空置房源');
  const d=await f.store.addDocument({libraryId:l.id,title:'旧库存',fileName:'旧.xlsx',strategy:'parent-child',chunks:[
   {ordinal:1,parentOrdinal:null,kind:'parent',heading:'工作表：空置房源',text:inventory},
   {ordinal:2,parentOrdinal:1,kind:'child',heading:'工作表：空置房源',text:inventory},
   {ordinal:3,parentOrdinal:null,kind:'parent',heading:'工作表：在租房源',text:inventory.replace('空置房源','在租房源')},
   {ordinal:4,parentOrdinal:3,kind:'child',heading:'工作表：在租房源',text:inventory.replace('空置房源','在租房源')},
  ]});
  if(mutation==='missing parent')f.sqlite.prepare('DELETE FROM workbench_knowledge_chunks WHERE document_id=? AND ordinal=3').run(d.id);
  if(mutation==='missing child')f.sqlite.prepare('DELETE FROM workbench_knowledge_chunks WHERE document_id=? AND ordinal=4').run(d.id);
  if(mutation==='orphan child')f.sqlite.prepare('UPDATE workbench_knowledge_chunks SET parent_ordinal=99 WHERE document_id=? AND ordinal=4').run(d.id);
  if(mutation==='conflicting child')f.sqlite.prepare("UPDATE workbench_knowledge_chunks SET text='第2行：A2=伪造铺号；B2=1' WHERE document_id=? AND ordinal=4").run(d.id);
  const result=await readPropertySources(f.db,'alice',{});
  assert.equal(result.complete,false,mutation);assert.deepEqual(result.sources,[],mutation);
 }
});

test('complete historical parent-child splits still preserve every real spreadsheet record',async t=>{
 const {splitKnowledgeText}=await import('../app/lib/knowledge-library-chunks.ts');const {parsePropertySources}=await import('../app/lib/property-records.ts');
 const f=fixture();t.after(()=>f.sqlite.close());const l=await f.store.createLibrary('空置房源');
 const text='## 工作表：空置房源\n第1行：A1=铺号；B1=面积；C1=业态；D1=位置\n'+Array.from({length:30},(_,i)=>{const row=i+2;return`第${row}行：A${row}=A${row}；B${row}=${row*10}；C${row}=餐饮；D${row}=商业街东区`;}).join('\n');
 const chunks=splitKnowledgeText(text,'parent-child');assert.ok(chunks.length>3);
 await f.store.addDocument({libraryId:l.id,title:'旧库存',fileName:'旧.xlsx',strategy:'parent-child',chunks});
 const result=await readPropertySources(f.db,'alice',{});assert.equal(result.complete,true);assert.equal(result.sources.length,1);
 const rows=parsePropertySources(result.sources);assert.equal(rows.length,30);assert.equal(rows[0].area?.min,20);assert.equal(rows.at(-1)?.area?.min,310);
});

test('document safety limits report incomplete coverage instead of a false exhaustive answer',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const l=await f.store.createLibrary('空置房源');
 for(let i=0;i<25;i++)await f.store.addDocument({libraryId:l.id,title:`库存${i}`,fileName:`${i}.xlsx`,strategy:'flat',chunks:[flat(inventory)]});
 const result=await readPropertySources(f.db,'alice',{});
 assert.ok(result.sources.length>0&&result.sources.length<25);assert.equal(result.complete,false);assert.ok(result.issues.length);
});
