import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createBusinessSettingsStore,validateBusinessSettings} from '../app/lib/business-settings.ts';

function fixture(){
  const sqlite=new DatabaseSync(':memory:');sqlite.exec('CREATE TABLE workbench_business_settings (user_id TEXT PRIMARY KEY,version INTEGER NOT NULL,updated_at TEXT NOT NULL,data_json TEXT NOT NULL)');
  const DB={prepare(sql:string){let values:unknown[]=[];return {bind(...bound:unknown[]){values=bound;return this;},async first(){return sqlite.prepare(sql).get(...values as never[])??null;},async run(){const result=sqlite.prepare(sql).run(...values as never[]);return {success:true,meta:{changes:Number(result.changes)}};}};}} as unknown as D1Database;
  return {sqlite,store:createBusinessSettingsStore({DB})};
}
test('business deadline thresholds validate strict ordering, supported bounds, and fields',()=>{
  for(const value of [{version:0,urgentDays:0,warningDays:5},{version:0,urgentDays:5,warningDays:5},{version:0,urgentDays:2,warningDays:31},{version:0,urgentDays:1.5,warningDays:5},{version:0,urgentDays:2,warningDays:5,role:'admin'}])assert.throws(()=>validateBusinessSettings(value),{status:400});
  assert.deepEqual(validateBusinessSettings({version:0,urgentDays:3,warningDays:7}),{version:0,urgentDays:3,warningDays:7});
});
test('business rules persist separately per owner and reject stale or concurrent saves',async(t)=>{
  const {sqlite,store}=fixture();t.after(()=>sqlite.close());
  assert.deepEqual(await store.read('owner-a'),{version:0,urgentDays:2,warningDays:5});
  const first=await store.save('owner-a',{version:0,urgentDays:3,warningDays:7});assert.equal(first.version,1);
  assert.deepEqual(await store.read('owner-a'),{version:1,urgentDays:3,warningDays:7});
  assert.deepEqual(await store.read('owner-b'),{version:0,urgentDays:2,warningDays:5});
  await assert.rejects(store.save('owner-a',{version:0,urgentDays:1,warningDays:4}),{status:409});
  const results=await Promise.allSettled([store.save('owner-a',{version:1,urgentDays:1,warningDays:4}),store.save('owner-a',{version:1,urgentDays:2,warningDays:6})]);
  assert.equal(results.filter(item=>item.status==='fulfilled').length,1);
  assert.equal((results.find(item=>item.status==='rejected') as PromiseRejectedResult).reason.status,409);
  assert.equal((await store.read('owner-a')).version,2);
});
