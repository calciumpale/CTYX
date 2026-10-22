import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createConnectionStore } from '../app/lib/connection-store.ts';
const encryptionKey='ab'.repeat(32);
function fixture() {
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE workbench_api_connections (user_id TEXT NOT NULL, kind TEXT NOT NULL, enabled INTEGER NOT NULL, base_url TEXT NOT NULL, model_name TEXT NOT NULL, secret_ciphertext TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id, kind))');
  const db={prepare(sql:string){let values:unknown[]=[];return {bind(...bound:unknown[]){values=bound;return this;},async first(){return sqlite.prepare(sql).get(...values as (string|number)[])??null;},async run(){const result=sqlite.prepare(sql).run(...values as (string|number)[]);return {success:true,meta:{changes:Number(result.changes)}};}};}} as unknown as D1Database;
  const environment={DB:db,CONFIG_ENCRYPTION_KEY:encryptionKey,MODEL_API_KEY:'environment-secret',MODEL_BASE_URL:'https://environment.example.com/v1',MODEL_NAME:'environment-model'};
  return {sqlite,environment,store:createConnectionStore(environment)};
}
const input={action:'save',kind:'model',version:0,enabled:true,baseUrl:'https://provider.example.com/v1',modelName:'account-model',secret:'sk-account-private'};
test('account overrides are encrypted, user-isolated, redacted, disabled independently, and removable',async()=>{
  const {store,sqlite}=fixture();
  assert.equal((await store.snapshot('alice')).model.source,'environment');
  const saved=await store.execute('alice',input);
  assert.equal(saved.connection?.source,'account');assert.equal(saved.connection?.hasSecret,true);
  assert.ok(!JSON.stringify(saved).includes('sk-account-private'));
  assert.equal((await store.snapshot('bob')).model.source,'environment');
  assert.deepEqual(await store.effectiveModel('alice'),{key:'sk-account-private',url:'https://provider.example.com/v1/chat/completions',name:'account-model'});
  const raw=sqlite.prepare('SELECT * FROM workbench_api_connections').get();assert.ok(!JSON.stringify(raw).includes('sk-account-private'));
  const disabled=await store.execute('alice',{...input,version:saved.connection!.version,secret:' ',enabled:false});
  assert.equal(await store.effectiveModel('alice'),null);
  assert.equal((await store.snapshot('bob')).model.enabled,true);
  const removed=await store.execute('alice',{action:'remove',kind:'model',version:disabled.connection!.version});
  assert.equal(removed.connection?.source,'environment');
  assert.equal((await store.effectiveModel('alice'))?.key,'environment-secret');
});
test('stale writes and removals fail without clobbering account settings',async()=>{
  const {store}=fixture();const first=await store.execute('alice',input);
  const updated=await store.execute('alice',{...input,version:first.connection!.version,modelName:'changed',secret:''});
  await assert.rejects(store.execute('alice',{...input,version:first.connection!.version}),{status:409});
  await assert.rejects(store.execute('alice',{action:'remove',kind:'model',version:first.connection!.version}),{status:409});
  assert.equal((await store.snapshot('alice')).model.version,updated.connection!.version);
  assert.equal((await store.effectiveModel('alice'))?.name,'changed');
});
test('blank secret keeps the stored secret while cross-origin retargeting requires a new key',async()=>{
  const {store}=fixture();const first=await store.execute('alice',input);
  await assert.rejects(store.execute('alice',{...input,version:first.connection!.version,baseUrl:'https://other.example.com/v1',secret:''}),{status:400});
  const next=await store.execute('alice',{...input,version:first.connection!.version,baseUrl:'https://provider.example.com/v2',secret:' '});
  assert.equal((await store.effectiveModel('alice'))?.key,'sk-account-private');
  const changed=await store.execute('alice',{...input,version:next.connection!.version,baseUrl:'https://other.example.com/v1',secret:'sk-other'});
  assert.equal(changed.connection?.baseUrl,'https://other.example.com/v1');
});
test('missing encryption key leaves environment fallback available and forbids writes',async()=>{
  const {environment}=fixture();delete (environment as {CONFIG_ENCRYPTION_KEY?:string}).CONFIG_ENCRYPTION_KEY;
  const store=createConnectionStore(environment);
  assert.equal((await store.snapshot('alice')).storageReady,false);
  assert.equal((await store.effectiveModel('alice'))?.key,'environment-secret');
  await assert.rejects(store.execute('alice',input),{status:503});
});
test('ciphertext copied across accounts cannot be used as a bearer credential',async()=>{
  const {store,sqlite}=fixture();await store.execute('alice',input);
  sqlite.exec("INSERT INTO workbench_api_connections SELECT 'bob',kind,enabled,base_url,model_name,secret_ciphertext,version,updated_at FROM workbench_api_connections WHERE user_id='alice'");
  await assert.rejects(store.effectiveModel('bob'),(error:unknown)=>error instanceof Error&&!error.message.includes('sk-account-private'));
});
test('test action uses draft settings and saved credentials without persisting or exposing provider text',async()=>{
  const {store}=fixture();const first=await store.execute('alice',input);
  const result=await store.execute('alice',{...input,action:'test',version:first.connection!.version,modelName:'draft',secret:''},'https://work.example.com',async(_url,options)=>{
    const body=JSON.parse(String(options.body));assert.equal(body.model,'draft');return Response.json({choices:[{message:{content:'sk-account-private'}}]});
  });
  assert.equal(result.test?.ok,true);assert.ok(!JSON.stringify(result).includes('sk-account-private'));
  assert.equal((await store.effectiveModel('alice'))?.name,'account-model');
});
test('unauthenticated account identities cannot read, test, save, or remove any settings',async()=>{
  const {store,sqlite}=fixture();
  for(const id of ['', 'x'.repeat(513)]) {
    await assert.rejects(store.snapshot(id),{status:401});
    await assert.rejects(store.effectiveModel(id),{status:401});
    for(const action of ['save','test','remove'])await assert.rejects(store.execute(id,{...input,action}),{status:401});
  }
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM workbench_api_connections').get()?.total,0);
});
test('simultaneous saves use database compare-and-swap so only one update wins',async()=>{
  const {store}=fixture();const first=await store.execute('alice',input);
  const results=await Promise.allSettled([
    store.execute('alice',{...input,version:first.connection!.version,modelName:'winner-a'}),
    store.execute('alice',{...input,version:first.connection!.version,modelName:'winner-b'}),
  ]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  const rejection=results.find(result=>result.status==='rejected');assert.equal(rejection?.status==='rejected'?rejection.reason.status:null,409);
  assert.ok(['winner-a','winner-b'].includes((await store.effectiveModel('alice'))!.name));
});
