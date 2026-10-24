import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createApprovalStore } from '../app/lib/approval-store.ts';
import type { ApprovalRecord } from '../app/lib/approval-store.ts';

function fixture(){
  const sqlite=new DatabaseSync(':memory:');
  for(const file of readdirSync(new URL('../drizzle/',import.meta.url)).filter(name=>name.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(`../drizzle/${file}`,import.meta.url),'utf8'));
  const queries:string[]=[];
  const db={prepare(sql:string){queries.push(sql);let values:unknown[]=[];return {bind(...bound:unknown[]){values=bound;return this;},async first(){return sqlite.prepare(sql).get(...values as never[])??null;},async all(){return {success:true,results:sqlite.prepare(sql).all(...values as never[])};},async run(){const result=sqlite.prepare(sql).run(...values as never[]);return {success:true,meta:{changes:Number(result.changes)}};}};},async batch(statements:{run:()=>Promise<unknown>}[]){sqlite.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}} as unknown as D1Database;
  return {sqlite,queries,db,store:createApprovalStore(db)};
}
function record(id='approval-1',ownerId='alice',overrides:Partial<ApprovalRecord>={}):ApprovalRecord{
  return {id,ownerId,projectId:'deal-1',kind:'business',status:'pending',version:1,currentApproverEmail:'finance@example.com',activeKey:`${ownerId}:unique`,inputHash:'input-1',createdAt:'2026-10-24T03:00:00.000Z',updatedAt:'2026-10-24T03:00:00.000Z',request:{id,title:'折扣申请',applicant:{id:ownerId,email:`${ownerId}@example.com`,name:ownerId},steps:[]} as unknown as ApprovalRecord['request'],...overrides};
}
const alice={id:'alice',email:'alice@example.com',name:'Alice'};
const finance={id:'finance',email:'finance@example.com',name:'Finance'};

test('requests and participants are inserted atomically and details stay account or email scoped',async(t)=>{
  const {sqlite,store}=fixture();t.after(()=>sqlite.close());await store.insert(record(),['finance@example.com','legal@example.com']);
  assert.equal((await store.visible('approval-1',alice))?.id,'approval-1');
  assert.equal((await store.visible('approval-1',finance))?.id,'approval-1');
  assert.equal(await store.visible('approval-1',{id:'mallory',email:'mallory@example.com'}),null);
  assert.equal((await store.list(finance,{scope:'inbox'})).records.length,1);
  assert.equal((await store.list({id:'legal',email:'legal@example.com'},{scope:'inbox'})).records.length,0);
  assert.equal((await store.list({id:'legal',email:'legal@example.com'},{scope:'all'})).records.length,1);
  assert.equal((await store.list({id:'mallory',email:'mallory@example.com'},{scope:'all'})).records.length,0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workbench_approval_participants').get()?.n,2);
});

test('duplicate active content and colliding request IDs fail without orphan participants',async(t)=>{
  const {sqlite,store}=fixture();t.after(()=>sqlite.close());await store.insert(record(),['finance@example.com']);
  await assert.rejects(store.insert(record('approval-2'),['legal@example.com']),{status:409});
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workbench_approval_participants').get()?.n,1);
  assert.equal(await store.get('approval-2'),null);
  await store.insert(record('other-owner','bob',{activeKey:'bob:unique'}),['legal@example.com']);
  assert.equal((await store.list(alice,{scope:'mine'})).records.length,1);
});

test('compare and swap allows one concurrent transition and releases the active key after completion',async(t)=>{
  const {sqlite,store}=fixture();t.after(()=>sqlite.close());const initial=record();await store.insert(initial,['finance@example.com']);
  const next={...initial,status:'approved',version:2,currentApproverEmail:null,activeKey:null,updatedAt:'2026-10-24T04:00:00.000Z'};
  const results=await Promise.allSettled([store.update(next,1,'pending'),store.update({...next,status:'rejected'},1,'pending')]);
  assert.equal(results.filter(item=>item.status==='fulfilled').length,1);
  assert.equal((results.find(item=>item.status==='rejected') as PromiseRejectedResult).reason.status,409);
  await store.insert(record('approval-2'),['finance@example.com']);
  assert.equal((await store.get('approval-2'))?.status,'pending');
});

test('list pages are stable, scoped, bounded and cursor errors are rejected',async(t)=>{
  const {sqlite,store,queries}=fixture();t.after(()=>sqlite.close());
  for(let i=0;i<55;i++)await store.insert(record(`request-${String(i).padStart(2,'0')}`,'alice',{activeKey:`key-${i}`}),['finance@example.com']);
  const first=await store.list(alice,{scope:'mine',limit:50});assert.equal(first.records.length,50);assert.ok(first.nextCursor);
  const second=await store.list(alice,{scope:'mine',limit:50,cursor:first.nextCursor});assert.equal(second.records.length,5);assert.equal(second.nextCursor,undefined);
  assert.equal(new Set([...first.records,...second.records].map(item=>item.id)).size,55);
  assert.ok(queries.filter(sql=>sql.startsWith('SELECT')&&sql.includes('data_json')&&!sql.includes('WHERE id')).every(sql=>sql.includes('LIMIT')));
  await assert.rejects(store.list(alice,{cursor:'not-valid'}),{status:400});
  await assert.rejects(store.list(alice,{limit:51}),{status:400});
});

test('template writes and deletes require owning identity and expected version',async(t)=>{
  const {sqlite,store}=fixture();t.after(()=>sqlite.close());
  const template={id:'template-1',ownerId:'alice',version:1,updatedAt:'2026-10-24T03:00:00.000Z',name:'财务法务',kind:'business' as const,steps:[]};
  await store.saveTemplate(template,0);assert.equal((await store.templates('alice')).length,1);assert.equal((await store.templates('bob')).length,0);
  await assert.rejects(store.saveTemplate({...template,ownerId:'bob',version:2},1),{status:409});
  await assert.rejects(store.deleteTemplate('template-1','bob',1),{status:409});
  await store.saveTemplate({...template,version:2,name:'新名称'},1);
  await assert.rejects(store.deleteTemplate('template-1','alice',1),{status:409});
  await store.deleteTemplate('template-1','alice',2);assert.equal((await store.templates('alice')).length,0);
});
