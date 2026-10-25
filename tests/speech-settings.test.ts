import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createSpeechSettingsStore,parseSpeechSettings,speechGateway,speechCapabilities} from '../app/lib/speech-settings.ts';

const input={version:0,dialect:'auto',diarization:true,speakerCount:null,hotwords:[{id:'word-1',term:'企查查',aliases:['气查查'],enabled:true}]};
function fixture(){const sqlite=new DatabaseSync(':memory:');sqlite.exec('CREATE TABLE workbench_speech_settings (user_id TEXT PRIMARY KEY,version INTEGER NOT NULL,updated_at TEXT NOT NULL,data_json TEXT NOT NULL)');const db={prepare(sql:string){let values:unknown[]=[];return {bind(...args:unknown[]){values=args;return this;},async first(){return sqlite.prepare(sql).get(...values as (string|number)[])??null;},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values as (string|number)[]).changes)}};}};}} as unknown as D1Database;return {store:createSpeechSettingsStore({DB:db}),sqlite};}
test('hotwords validate conflicts, alias length and dialect settings without silently guessing corrections',()=>{
  assert.deepEqual(parseSpeechSettings(input),input);
  for(const override of [{speakerCount:11},{dialect:'unsupported'},{hotwords:[{...input.hotwords[0],aliases:['查']}]},{hotwords:[input.hotwords[0],{id:'word-2',term:'其他',aliases:['气查查'],enabled:true}]},{hotwords:[input.hotwords[0],{id:'word-2',term:'气查查',aliases:[],enabled:true}]},{hotwords:[input.hotwords[0],{...input.hotwords[0],id:'word-2'}]}])assert.throws(()=>parseSpeechSettings({...input,...override}));
  assert.throws(()=>parseSpeechSettings({...input,version:-1}),{status:409});
});
test('speech settings persist per authenticated account and stale concurrent writes cannot overwrite',async()=>{
  const {store}=fixture();assert.equal((await store.read('alice')).version,0);const saved=await store.save('alice',input);assert.equal(saved.version,1);assert.equal((await store.read('bob')).hotwords.length,0);assert.equal((await store.read('alice')).hotwords[0].term,'企查查');
  const concurrent=await Promise.allSettled([store.save('alice',{...input,version:1,dialect:'wu'}),store.save('alice',{...input,version:1,dialect:'cantonese'})]);assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1);assert.equal((await store.read('alice')).version,2);await assert.rejects(store.save('alice',input),{status:409});await assert.rejects(store.read(''),{status:401});
});
test('gateway HTTP endpoints use validated fixed service origins and refuse production loopback, IP and credentials',()=>{
  const secret='a'.repeat(32);assert.equal(speechGateway({VOICE_GATEWAY_URL:'wss://voice.example.com/ws',VOICE_GATEWAY_SECRET:secret},'https://app.example.com')?.url,'https://voice.example.com');assert.equal(speechGateway({VOICE_GATEWAY_URL:'ws://127.0.0.1:8001/ws',VOICE_GATEWAY_SECRET:secret},'http://127.0.0.1:5173')?.url,'http://127.0.0.1:8001');
  for(const url of ['wss://127.0.0.1/ws','wss://169.254.169.254/ws','wss://service.internal/ws','wss://user:password@voice.example.com/ws','ws://voice.example.com/ws'])assert.throws(()=>speechGateway({VOICE_GATEWAY_URL:url,VOICE_GATEWAY_SECRET:secret},'https://app.example.com'));
});
test('capability probes never disclose provider bodies or secrets and prohibit redirects',async()=>{
  const environment={VOICE_GATEWAY_URL:'wss://voice.example.com/ws',VOICE_GATEWAY_SECRET:'secret'.repeat(8)};const failed=await speechCapabilities(environment,'https://app.example.com',async(_url,options)=>{assert.equal(options?.redirect,'manual');return new Response('internal-secret-provider-body',{status:500});});assert.equal(failed.available,false);assert.ok(!JSON.stringify(failed).includes('internal-secret'));const success=await speechCapabilities(environment,'https://app.example.com',async()=>Response.json({available:true,model:'FunASR-Nano',dialects:['cantonese'],diarization:true,hotwords:true,secret:'not-for-client'}));assert.equal(success.available,true);assert.equal(success.diarization,true);assert.ok(!JSON.stringify(success).includes('not-for-client'));
});
