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

import {createWorkbenchKnowledgeAgent} from '../app/lib/knowledge-agent-runtime.ts';
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
