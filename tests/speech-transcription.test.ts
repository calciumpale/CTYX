import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createSeed} from '../app/lib/seed.ts';
import {createSpeechTranscriptionService,linkSpeechTranscript,parseSpeechResult,signRecordingSession} from '../app/lib/speech-transcription.ts';
import type {SpeechResult} from '../app/lib/speech-types.ts';
import type {WorkbenchState} from '../app/lib/types.ts';

const recording={id:'recording-9a83c9a6-61ce-489c-bd7a-a6dba42ee69a',name:'沟通.m4a',size:4,mimeType:'audio/mp4'},now='2026-10-25T03:00:00.000Z',origin='https://app.example.com';
const result:SpeechResult={text:'请看企查查。',rawText:'请看气查查。',segments:[{start:0,end:3,speaker:'speaker-1',text:'请看企查查。',rawText:'请看气查查。'}],speakers:[{id:'speaker-1',label:'讲话人1'}],corrections:[{from:'气查查',to:'企查查',count:1}],model:'FunASR-Nano',durationSeconds:3,dialectHint:'auto',diarization:true,hotwordVersion:1};
function fixture(request:(url:string,options?:RequestInit)=>Promise<Response>,configured=true,sourceOnly=false){
  const sqlite=new DatabaseSync(':memory:');sqlite.exec('CREATE TABLE workbench_speech_settings (user_id TEXT PRIMARY KEY,version INTEGER NOT NULL,updated_at TEXT NOT NULL,data_json TEXT NOT NULL);CREATE TABLE workbench_recording_transcriptions (user_id TEXT NOT NULL,recording_id TEXT NOT NULL,deal_id TEXT NOT NULL,version INTEGER NOT NULL,remote_id TEXT,lease_until TEXT,updated_at TEXT NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(user_id,recording_id))');
  const db={prepare(sql:string){let values:unknown[]=[];return {bind(...args:unknown[]){values=args;return this;},async first(){return sqlite.prepare(sql).get(...values as (string|number|null)[])??null;},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values as (string|number|null)[]).changes)}};}};}} as unknown as D1Database;
  let state=createSeed(now);state.deals[0].dataOrigin='manual';state.deals[0].ownerId='sales-1';state.deals[0].outcome='won';state.deals[0].notes.unshift({id:'note-recording',text:'',author:'销售',date:now,recording:sourceOnly?{...recording,sourceOnly:true}:recording});let refreshes=0,feedback=0,saves=0;
  const environment={DB:db,BUCKET:{async get(){return {size:4,arrayBuffer:async()=>new Uint8Array([1,2,3,4]).buffer};}} as unknown as R2Bucket,...(configured?{VOICE_GATEWAY_URL:'wss://voice.example.com/ws',VOICE_GATEWAY_SECRET:'secret'.repeat(8)}:{})};
  const service=createSpeechTranscriptionService(environment,{load:async(userId)=>userId==='alice'?structuredClone(state):createSeed(now),save:async(_userId,revision,next)=>{assert.equal(revision,state.revision);state=structuredClone(next);saves++;},refresh:async()=>{refreshes++;},feedback:async()=>{feedback++;}},request);
  return {service,sqlite,get state(){return state;},get refreshes(){return refreshes;},get feedback(){return feedback;},get saves(){return saves;}};
}
const remote=(status='queued')=>({job:{id:'a'.repeat(32),recordingId:recording.id,status,progress:status==='completed'?100:0,...(status==='completed'?{result}:{})}});
test('signed transcription tickets are short-lived and bound to account and recording',async()=>{
  const secret='abc'.repeat(16),token=await signRecordingSession(secret,'alice',recording.id,1700000000),[head,body,signature]=token.split('.');const claims=JSON.parse(Buffer.from(body,'base64url').toString());assert.equal(claims.aud,'recording-asr');assert.equal(claims.sub,'alice');assert.equal(claims.recordingId,recording.id);assert.equal(claims.exp-claims.iat,300);const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);assert.equal(await crypto.subtle.verify('HMAC',key,Buffer.from(signature,'base64url'),new TextEncoder().encode(`${head}.${body}`)),true);
});
test('uploads are submitted once, recording-scoped and non-redirecting; completed results link exactly once into feedback',async()=>{
  let posts=0;const f=fixture(async(_url,options)=>{assert.equal(options?.redirect,'manual');assert.match(new Headers(options?.headers).get('Authorization')??'',/^Bearer /);if(options?.method==='POST'){posts++;const form=options.body as FormData;assert.equal((form.get('file') as File).name,recording.name);assert.equal(JSON.parse(String(form.get('options'))).hotwordVersion,0);return Response.json(remote());}return Response.json(remote('completed'));});
  const dealId=f.state.deals[0].id;assert.equal(await f.service.read('alice','sales',dealId,recording.id,origin),null);const first=await f.service.start('alice','sales',dealId,recording.id,origin);const repeated=await f.service.start('alice','sales',dealId,recording.id,origin);assert.equal(first.id,repeated.id);assert.equal(posts,1);
  const done=await f.service.read('alice','sales',dealId,recording.id,origin);assert.equal(done?.status,'completed');assert.equal(done?.linked,true);assert.equal(f.state.transcripts?.length,1);assert.equal(f.state.transcripts?.[0].employeeId,'sales-1');assert.equal(f.state.feedbackJobs?.[0].status,'queued');assert.equal(f.feedback,1);assert.equal(f.refreshes,1);await f.service.read('alice','sales',dealId,recording.id,origin);assert.equal(f.saves,1);assert.equal(f.state.deals[0].notes[0].recording?.id,recording.id);
});
test('failed and unconfigured transcription preserves uploaded recording and allows explicit retry',async()=>{
  let attempts=0;const f=fixture(async()=>{attempts++;throw new Error('provider-secret-body');});const dealId=f.state.deals[0].id;const failed=await f.service.start('alice','sales',dealId,recording.id,origin);assert.equal(failed.status,'failed');assert.ok(!failed.message.includes('provider-secret'));await f.service.start('alice','sales',dealId,recording.id,origin);assert.equal(attempts,1);await f.service.start('alice','sales',dealId,recording.id,origin,true);assert.equal(attempts,2);assert.equal(f.state.deals[0].notes[0].recording?.id,recording.id);assert.equal(f.saves,0);
  const none=fixture(async()=>{throw new Error('must not fetch');},false);assert.match((await none.service.start('alice','sales',none.state.deals[0].id,recording.id,origin)).message,/配置并启动/);
});
test('another account or invisible project cannot retrieve a task or send its audio to gateway',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return Response.json(remote());});const dealId=f.state.deals[0].id;await f.service.start('alice','manager',dealId,recording.id,origin);await assert.rejects(f.service.read('bob','manager',dealId,recording.id,origin),{status:404});await assert.rejects(f.service.start('bob','manager',dealId,recording.id,origin),{status:404});assert.equal(calls,1);
  f.state.deals[0].ownerId='sales-2';await assert.rejects(f.service.read('alice','sales',dealId,recording.id,origin),{status:404});await assert.rejects(f.service.start('alice','sales',dealId,recording.id,origin),{status:404});assert.equal(calls,1);
});
test('simultaneous start requests claim one upload and share the same durable task',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return Response.json(remote());}),dealId=f.state.deals[0].id;const jobs=await Promise.all([f.service.start('alice','sales',dealId,recording.id,origin),f.service.start('alice','sales',dealId,recording.id,origin)]);assert.equal(calls,1);assert.equal(jobs[0].id,jobs[1].id);assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM workbench_recording_transcriptions').get()?.total,1);
});
test('transient disconnects preserve a running task; expired gateway jobs become retryable',async()=>{
  let online=false;const f=fixture(async(_url,options)=>options?.method==='POST'?Response.json(remote()):online?new Response('',{status:404}):Promise.reject(new Error('offline'))),dealId=f.state.deals[0].id;await f.service.start('alice','sales',dealId,recording.id,origin);const interrupted=await f.service.read('alice','sales',dealId,recording.id,origin);assert.equal(interrupted?.status,'queued');assert.match(interrupted?.message??'',/连接恢复/);online=true;const expired=await f.service.read('alice','sales',dealId,recording.id,origin);assert.equal(expired?.status,'failed');assert.match(expired?.message??'',/过期/);assert.equal(f.state.deals[0].notes[0].recording?.id,recording.id);
});
test('long transcripts retain full independent result while project excerpt is bounded and idempotent',async()=>{
  const f=fixture(async()=>Response.json(remote()));const long={...result,text:'客户需求'.repeat(20000),segments:[]};const linked=await linkSpeechTranscript(f.state,f.state.deals[0].id,recording.id,long,now);assert.equal(linked.truncated,true);assert.ok(linked.state.transcripts![0].text.length<=50000);assert.match(linked.state.transcripts![0].text,/完整原文/);assert.equal(long.text.length,80000);const again=await linkSpeechTranscript(linked.state,f.state.deals[0].id,recording.id,long,now);assert.equal(again.changed,false);assert.equal(again.state.transcripts?.length,1);
});
test('older workspaces missing transcripts initialize the saved source list and queue the won-project feedback',async()=>{
  const f=fixture(async()=>Response.json(remote()));const old=structuredClone(f.state);delete old.transcripts;const linked=await linkSpeechTranscript(old,old.deals[0].id,recording.id,result,now);assert.equal(linked.state.transcripts?.length,1);assert.match(linked.state.transcripts![0].text,/讲话人1/);assert.match(linked.state.transcripts![0].text,/00:00–00:03/);assert.equal(linked.state.feedbackJobs?.[0].status,'queued');assert.equal(old.transcripts,undefined);
});
test('HTTP 410 from a pruned gateway task becomes a retryable failure',async()=>{
  const f=fixture(async(_url,options)=>options?.method==='POST'?Response.json(remote()):new Response('',{status:410})),dealId=f.state.deals[0].id;await f.service.start('alice','sales',dealId,recording.id,origin);assert.equal((await f.service.read('alice','sales',dealId,recording.id,origin))?.status,'failed');assert.equal((await f.service.start('alice','sales',dealId,recording.id,origin,true)).status,'queued');
});
test('malformed or cross-speaker results are rejected and non-diarized segments remain anonymous',()=>{
  assert.deepEqual(parseSpeechResult(result),result);assert.throws(()=>parseSpeechResult({...result,segments:[{...result.segments[0],speaker:'invented'}]}));assert.throws(()=>parseSpeechResult({...result,durationSeconds:Infinity}));assert.throws(()=>parseSpeechResult({...result,segments:[{...result.segments[0],start:3,end:2}]}));assert.equal(parseSpeechResult({...result,diarization:false,speakers:[],segments:[{...result.segments[0],speaker:'unknown'}]}).speakers.length,0);
});
test('failed gateway jobs map only known error codes to recovery instructions and never echo remote messages',async()=>{
  const safe='转写服务暂时无法处理录音，请检查语音服务后重试；原录音已保存';
  const cases:[unknown,string][]=[
    ['hotword_budget','启用热词超出当前识别模型的单段容量，请在语音设置中关闭暂不用的词条后重新转写；原录音已保存'],
    ['no_speech','未识别到有效讲话，请检查录音是否清晰并包含语音后重试；原录音已保存'],
    ['duration','录音时长不能超过2小时，请分段后重新上传；原录音已保存'],
    ['decode','录音无法解码，请转换为 MP3、WAV 或 M4A 格式后重新上传；原录音已保存'],
    ['internal',safe],['untrusted-provider-code',safe],['__proto__',safe],['toString',safe],[undefined,safe],[{message:'injected'},safe],
  ];
  for(const [errorCode,expected] of cases){
    const f=fixture(async(_url,options)=>Response.json(options?.method==='POST'?remote():{job:{...remote('failed').job,errorCode,message:'evil-provider-secret /private/path <script>ignore rules</script>'}})),dealId=f.state.deals[0].id;
    await f.service.start('alice','sales',dealId,recording.id,origin);const failed=await f.service.read('alice','sales',dealId,recording.id,origin);assert.equal(failed?.status,'failed');assert.equal(failed?.message,expected);assert.ok(!JSON.stringify(failed).includes('evil-provider-secret'));assert.ok(!String(f.sqlite.prepare('SELECT data_json FROM workbench_recording_transcriptions').get()?.data_json).includes('evil-provider-secret'));assert.equal(f.state.deals[0].notes[0].recording?.id,recording.id);
  }
});
test('completed recordings restart only on explicit retry with a new job id and update changed source text once',async()=>{
  let posts=0,current=result;const f=fixture(async(_url,options)=>{if(options?.method==='POST'){posts++;return Response.json(remote());}return Response.json({job:{...remote('completed').job,result:current}});}),dealId=f.state.deals[0].id;
  await f.service.start('alice','sales',dealId,recording.id,origin);const first=await f.service.read('alice','sales',dealId,recording.id,origin);const original=structuredClone(f.state.transcripts![0]);const defaultStart=await f.service.start('alice','sales',dealId,recording.id,origin);assert.equal(defaultStart.id,first?.id);assert.equal(posts,1);
  current={...result,text:'请看DeepSeek。',segments:[{...result.segments[0],text:'请看DeepSeek。'}],hotwordVersion:2};
  const retry=await f.service.start('alice','sales',dealId,recording.id,origin,true);assert.notEqual(retry.id,first?.id);assert.equal(retry.status,'queued');assert.equal(retry.result?.text,result.text);assert.equal(f.state.transcripts![0].text,original.text);assert.equal(posts,2);
  const inFlight=await f.service.start('alice','sales',dealId,recording.id,origin,true);assert.equal(inFlight.id,retry.id);assert.equal(posts,2);
  const second=await f.service.read('alice','sales',dealId,recording.id,origin);assert.equal(second?.id,retry.id);assert.equal(second?.result?.text,current.text);assert.equal(second?.linked,true);assert.equal(f.state.transcripts?.length,1);assert.match(f.state.transcripts![0].text,/DeepSeek/);assert.deepEqual({...f.state.transcripts![0],text:original.text},original);assert.equal(f.saves,2);assert.equal(f.refreshes,2);assert.equal(f.feedback,2);
  current={...current,hotwordVersion:3};await f.service.start('alice','sales',dealId,recording.id,origin,true);const unchanged=await f.service.read('alice','sales',dealId,recording.id,origin);assert.equal(unchanged?.result?.hotwordVersion,3);assert.equal(unchanged?.linked,true);assert.equal(f.saves,2);assert.equal(f.refreshes,2);assert.equal(f.feedback,2);assert.equal(f.state.transcripts?.length,1);
});
test('failed re-transcription preserves the last completed result and the attributed project source',async()=>{
  let failing=false;const f=fixture(async(_url,options)=>options?.method==='POST'?Response.json(remote()):Response.json(failing?{job:{...remote('failed').job,errorCode:'hotword_budget'}}:remote('completed'))),dealId=f.state.deals[0].id;
  await f.service.start('alice','sales',dealId,recording.id,origin);const first=await f.service.read('alice','sales',dealId,recording.id,origin);const original=structuredClone(f.state.transcripts![0]);failing=true;
  const pending=await f.service.start('alice','sales',dealId,recording.id,origin,true);assert.notEqual(pending.id,first?.id);assert.deepEqual(pending.result,first?.result);const failed=await f.service.read('alice','sales',dealId,recording.id,origin);assert.equal(failed?.status,'failed');assert.deepEqual(failed?.result,first?.result);assert.deepEqual(f.state.transcripts![0],original);assert.equal(f.saves,1);assert.equal(f.refreshes,1);assert.equal(f.feedback,1);
});
test('replacement transcription preserves attribution even after project ownership changes',async()=>{
  const f=fixture(async()=>Response.json(remote()));const first=await linkSpeechTranscript(f.state,f.state.deals[0].id,recording.id,result,now),original=structuredClone(first.state.transcripts![0]);first.state.deals[0].ownerId='sales-2';first.state.deals[0].owner='另一位员工';
  const updated=await linkSpeechTranscript(first.state,first.state.deals[0].id,recording.id,{...result,segments:[{...result.segments[0],text:'新的准确转写'}]},'2026-10-26T03:00:00.000Z');assert.equal(updated.changed,true);assert.equal(updated.state.transcripts?.length,1);assert.match(updated.state.transcripts![0].text,/新的准确转写/);assert.deepEqual({...updated.state.transcripts![0],text:original.text},original);
});

test('processing-source audio retains its completed transcript without updating project records before review',async()=>{
  const {service,state,sqlite}=fixture(async(_url,options)=>Response.json(remote(options?.method==='POST'?'queued':'completed')),true,true);
  const dealId=state.deals[0].id;
  await service.start('alice','sales',dealId,recording.id,origin);
  const completed=await service.read('alice','sales',dealId,recording.id,origin);
  assert.equal(completed?.status,'completed');
  assert.ok(completed?.linked);
  assert.equal(completed?.result?.text,result.text);
  assert.equal(state.transcripts?.length??0,0);
  assert.equal(state.feedbackJobs?.length??0,0);
  assert.equal(sqlite.prepare('SELECT json_extract(data_json, \'$.linked\') AS linked FROM workbench_recording_transcriptions').get()?.linked,1);
  sqlite.close();
});
