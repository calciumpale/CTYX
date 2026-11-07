import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createCompanyConnectionStore, QCC_ENDPOINT } from '../app/lib/company-connection.ts';

function fixture() {
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE workbench_api_connections (user_id TEXT NOT NULL, kind TEXT NOT NULL, enabled INTEGER NOT NULL, base_url TEXT NOT NULL, model_name TEXT NOT NULL, secret_ciphertext TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id,kind))');
  const DB={prepare(sql:string){let values:(string|number)[]=[];return {bind(...args:(string|number)[]){values=args;return this;},async first(){return sqlite.prepare(sql).get(...values)??null;},async run(){const result=sqlite.prepare(sql).run(...values);return {meta:{changes:Number(result.changes)}};}};}} as unknown as D1Database;
  const environment={DB,CONFIG_ENCRYPTION_KEY:'bc'.repeat(32)};
  return {sqlite,store:createCompanyConnectionStore(environment),jinghai:createCompanyConnectionStore(environment,'jinghai')};
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

const jinghaiDraft={action:'save',version:0,enabled:true,appKey:'jinghai-app-private',secretKey:'jinghai-api-private'};
const jinghaiEndpoint='https://www.kqdaas.com/DataService/api/v3/company/detail';
test('Jinghai and QCC credentials remain independent for the same user',async()=>{
  const {store,jinghai,sqlite}=fixture();
  const qccSaved=await store.execute('alice',draft);
  const jinghaiSaved=await jinghai.execute('alice',jinghaiDraft);
  assert.equal(qccSaved.connection.provider,'qcc');
  assert.equal(jinghaiSaved.connection.provider,'jinghai');
  assert.deepEqual(await store.effective('alice'),{endpoint:QCC_ENDPOINT,appKey:draft.appKey,secretKey:draft.secretKey});
  assert.deepEqual(await jinghai.effective('alice'),{endpoint:jinghaiEndpoint,appKey:jinghaiDraft.appKey,secretKey:jinghaiDraft.secretKey});
  assert.equal(await jinghai.effective('bob'),null);
  assert.equal((await store.snapshot('alice')).connection.version,qccSaved.connection.version);
  assert.ok(!JSON.stringify(jinghaiSaved).includes('private'));
  assert.ok(!JSON.stringify(await jinghai.snapshot('alice')).includes('private'));
  assert.ok(!JSON.stringify(sqlite.prepare("SELECT * FROM workbench_api_connections WHERE kind='jinghai'").get()).includes('private'));
});
test('Jinghai blank fields retain its own credentials while disabling and reenabling',async()=>{
  const {jinghai}=fixture();
  const saved=await jinghai.execute('alice',jinghaiDraft);
  const disabled=await jinghai.execute('alice',{action:'save',version:saved.connection.version,enabled:false,appKey:'',secretKey:''});
  assert.equal(await jinghai.effective('alice'),null);
  const enabled=await jinghai.execute('alice',{action:'save',version:disabled.connection.version,enabled:true});
  assert.equal(enabled.connection.provider,'jinghai');
  assert.deepEqual(await jinghai.effective('alice'),{endpoint:jinghaiEndpoint,appKey:jinghaiDraft.appKey,secretKey:jinghaiDraft.secretKey});
  await assert.rejects(jinghai.execute('alice',{...jinghaiDraft,version:saved.connection.version}),{status:409});
});
test('rotating a Jinghai AppID requires a matching API Key without echoing submitted secrets',async()=>{
  const {jinghai}=fixture();const saved=await jinghai.execute('alice',jinghaiDraft);
  await assert.rejects(jinghai.execute('alice',{action:'save',version:saved.connection.version,appKey:'rotated-private-app'}),error=>{
    assert.match((error as Error).message,/AppID.*API Key/);
    assert.ok(!(error as Error).message.includes('private'));
    return true;
  });
  const rotated=await jinghai.execute('alice',{...jinghaiDraft,version:saved.connection.version,appKey:'rotated-private-app',secretKey:'rotated-private-api'});
  assert.ok(!JSON.stringify(rotated).includes('private'));
  assert.deepEqual(await jinghai.effective('alice'),{endpoint:jinghaiEndpoint,appKey:'rotated-private-app',secretKey:'rotated-private-api'});
});
test('Jinghai only accepts its fixed official endpoint and never trusts a stored alternate URL',async()=>{
  const {jinghai,sqlite}=fixture();
  assert.equal((await jinghai.snapshot('alice')).connection.endpoint,jinghaiEndpoint);
  await assert.rejects(jinghai.execute('alice',{...jinghaiDraft,endpoint:QCC_ENDPOINT}),{status:400});
  await assert.rejects(jinghai.execute('alice',{...jinghaiDraft,endpoint:'https://example.com/company'}),{status:400});
  await jinghai.execute('alice',{...jinghaiDraft,endpoint:jinghaiEndpoint});
  sqlite.prepare("UPDATE workbench_api_connections SET base_url='https://example.com/company' WHERE kind='jinghai'").run();
  assert.equal((await jinghai.effective('alice'))?.endpoint,jinghaiEndpoint);
  assert.equal((await jinghai.snapshot('alice')).connection.endpoint,jinghaiEndpoint);
});
test('ciphertext cannot be copied between QCC and Jinghai for the same user',async()=>{
  const {store,jinghai,sqlite}=fixture();
  await store.execute('alice',draft);await jinghai.execute('alice',jinghaiDraft);
  sqlite.prepare("UPDATE workbench_api_connections SET secret_ciphertext=(SELECT secret_ciphertext FROM workbench_api_connections WHERE user_id='alice' AND kind='qcc') WHERE user_id='alice' AND kind='jinghai'").run();
  await assert.rejects(jinghai.effective('alice'),{status:503});
  assert.deepEqual(await store.effective('alice'),{endpoint:QCC_ENDPOINT,appKey:draft.appKey,secretKey:draft.secretKey});
});
test('Jinghai requires a complete replacement to repair unreadable ciphertext',async()=>{
  const {jinghai,sqlite}=fixture();const saved=await jinghai.execute('alice',jinghaiDraft);
  sqlite.prepare("UPDATE workbench_api_connections SET secret_ciphertext='broken' WHERE user_id='alice' AND kind='jinghai'").run();
  await assert.rejects(jinghai.execute('alice',{action:'save',version:saved.connection.version,appKey:'replacement-private-app'}),{status:503});
  const repaired=await jinghai.execute('alice',{...jinghaiDraft,version:saved.connection.version,appKey:'replacement-private-app',secretKey:'replacement-private-api'});
  assert.ok(!JSON.stringify(repaired).includes('private'));
  assert.deepEqual(await jinghai.effective('alice'),{endpoint:jinghaiEndpoint,appKey:'replacement-private-app',secretKey:'replacement-private-api'});
});
test('removing Jinghai preserves QCC and other users',async()=>{
  const {store,jinghai}=fixture();await store.execute('alice',draft);
  const saved=await jinghai.execute('alice',jinghaiDraft);await jinghai.execute('bob',jinghaiDraft);
  const removed=await jinghai.execute('alice',{action:'remove',version:saved.connection.version});
  assert.equal(removed.connection.configured,false);
  assert.equal(removed.connection.provider,'jinghai');
  assert.equal(await jinghai.effective('alice'),null);
  assert.ok(await store.effective('alice'));
  assert.ok(await jinghai.effective('bob'));
});
