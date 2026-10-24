import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createCompanyConnectionStore, QCC_ENDPOINT } from '../app/lib/company-connection.ts';

function fixture() {
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE workbench_api_connections (user_id TEXT NOT NULL, kind TEXT NOT NULL, enabled INTEGER NOT NULL, base_url TEXT NOT NULL, model_name TEXT NOT NULL, secret_ciphertext TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id,kind))');
  const DB={prepare(sql:string){let values:(string|number)[]=[];return {bind(...args:(string|number)[]){values=args;return this;},async first(){return sqlite.prepare(sql).get(...values)??null;},async run(){const result=sqlite.prepare(sql).run(...values);return {meta:{changes:Number(result.changes)}};}};}} as unknown as D1Database;
  return {sqlite,store:createCompanyConnectionStore({DB,CONFIG_ENCRYPTION_KEY:'bc'.repeat(32)})};
}
const draft={action:'save',version:0,enabled:true,appKey:'qcc-app-private',secretKey:'qcc-secret-private'};
test('company credentials are encrypted and separate from model settings and other users',async()=>{
  const {store,sqlite}=fixture();
  sqlite.prepare('INSERT INTO workbench_api_connections VALUES (?,?,?,?,?,?,?,?)').run('alice','model',1,'https://model.example.com','deepseek','model-cipher',7,'now');
  const saved=await store.execute('alice',draft);
  assert.equal(saved.connection.configured,true);assert.equal(saved.connection.enabled,true);
  assert.ok(!JSON.stringify(saved).includes('private'));
  assert.ok(!JSON.stringify(sqlite.prepare("SELECT * FROM workbench_api_connections WHERE kind='qcc'").get()).includes('qcc-secret-private'));
  assert.deepEqual(await store.effective('alice'),{endpoint:QCC_ENDPOINT,appKey:draft.appKey,secretKey:draft.secretKey});
  assert.equal(await store.effective('bob'),null);
  assert.equal(sqlite.prepare("SELECT version FROM workbench_api_connections WHERE kind='model'").get()?.version,7);
});
test('blank fields retain stored credentials, stale writes fail, and disabled configuration falls back',async()=>{
  const {store}=fixture();const saved=await store.execute('alice',draft);
  const next=await store.execute('alice',{action:'save',version:saved.connection.version,enabled:false,appKey:'',secretKey:''});
  assert.equal(await store.effective('alice'),null);
  await assert.rejects(store.execute('alice',{...draft,version:saved.connection.version}),{status:409});
  await store.execute('alice',{action:'save',version:next.connection.version,enabled:true});
  assert.equal((await store.effective('alice'))?.appKey,draft.appKey);
});
test('changed AppKey requires its SecretKey and arbitrary destinations are rejected',async()=>{
  const {store}=fixture();const saved=await store.execute('alice',draft);
  await assert.rejects(store.execute('alice',{action:'save',version:saved.connection.version,enabled:true,appKey:'other-app'}),{status:400});
  await assert.rejects(store.execute('alice',{...draft,version:saved.connection.version,endpoint:'https://evil.example.com'}),{status:400});
  assert.equal((await store.effective('alice'))?.appKey,draft.appKey);
});
test('remove affects only the current user and old versions cannot match a recreated row',async()=>{
  const {store}=fixture();const saved=await store.execute('alice',draft);await store.execute('bob',draft);
  await store.execute('alice',{action:'remove',version:saved.connection.version});
  assert.equal((await store.snapshot('alice')).connection.configured,false);
  assert.ok(await store.effective('bob'));
  const recreated=await store.execute('alice',draft);assert.notEqual(recreated.connection.version,saved.connection.version);
  await assert.rejects(store.execute('alice',{action:'remove',version:saved.connection.version}),{status:409});
});
test('missing identity or encryption cannot save credentials',async()=>{
  const {store}=fixture();await assert.rejects(store.execute('',draft),{status:401});
  await assert.rejects(createCompanyConnectionStore({}).execute('alice',draft),{status:503});
});
test('a complete credential replacement repairs unreadable previous ciphertext',async()=>{
  const {store,sqlite}=fixture();const saved=await store.execute('alice',draft);
  sqlite.prepare("UPDATE workbench_api_connections SET secret_ciphertext='broken' WHERE user_id='alice' AND kind='qcc'").run();
  await store.execute('alice',{...draft,version:saved.connection.version,appKey:'replacement-app',secretKey:'replacement-secret'});
  assert.equal((await store.effective('alice'))?.appKey,'replacement-app');
});
