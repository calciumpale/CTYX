import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, executeAction, projectState } from '../app/lib/domain.ts';
import { createSeed } from '../app/lib/seed.ts';
import type { FollowupRecording, WorkbenchState } from '../app/lib/types.ts';
import { MAX_RECORDING_BYTES, MAX_MULTIPART_BYTES, parseRecordingForm, validateRecording, saveRecordingNote, recordingObjectKey, authorizedRecording, parseAudioRange } from '../app/lib/followup-recordings.ts';

const now='2026-10-23T08:00:00.000Z';
const rejectsStatus=(status:number)=>(error:unknown)=>error instanceof DomainError&&error.status===status;
const recording:FollowupRecording={id:'recording-9a83c9a6-61ce-489c-bd7a-a6dba42ee69a',name:'客户沟通.wav',size:48,mimeType:'audio/wav'};
function wav():Uint8Array {
  const bytes=new Uint8Array(48);const view=new DataView(bytes.buffer);const write=(at:number,value:string)=>bytes.set(new TextEncoder().encode(value),at);
  write(0,'RIFF');view.setUint32(4,40,true);write(8,'WAVE');write(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,8000,true);view.setUint32(28,16000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);write(36,'data');view.setUint32(40,4,true);return bytes;
}
const file=(name='客户沟通.wav',type='audio/wav',bytes:Uint8Array=wav())=>new File([bytes as Uint8Array<ArrayBuffer>],name,{type});
function multipart(audio=file(),overrides:Record<string,string>={}) {
  const form=new FormData();form.set('dealId','deal-1');form.set('text','已确认下周看场地');form.set('revision','1');form.set('audio',audio);for(const [key,value] of Object.entries(overrides))form.set(key,value);
  return new Request('https://example.test/api/deal-recordings',{method:'POST',body:form});
}

test('recording notes accept trusted audio without text and preserve old text semantics',async()=>{
  const state=createSeed(now);const id=state.deals.find(item=>item.ownerId==='sales-1')!.id;
  const audio=await executeAction(state,'sales','deal_note',{dealId:id,text:''},{now,trustedRecording:recording});
  assert.deepEqual(audio.state.deals.find(item=>item.id===id)!.notes[0].recording,recording);
  assert.equal(audio.state.deals.find(item=>item.id===id)!.notes[0].text,'');
  assert.equal(state.deals.find(item=>item.id===id)!.notes[0].recording,undefined);
  const plain=await executeAction(state,'sales','deal_note',{dealId:id,text:'  已发送清单  '},{now});
  assert.equal(plain.state.deals.find(item=>item.id===id)!.notes[0].text,'已发送清单');
  await assert.rejects(executeAction(state,'sales','deal_note',{dealId:id,text:''},{now}),rejectsStatus(400));
});

test('client supplied recording references cannot attach arbitrary stored audio',async()=>{
  const state=createSeed(now);const id=state.deals[0].id;
  await assert.rejects(executeAction(state,'manager','deal_note',{dealId:id,text:'伪造',recording},{now}),rejectsStatus(400));
  const other=state.deals.find(item=>item.ownerId!=='sales-1')!;
  await assert.rejects(executeAction(state,'sales','deal_note',{dealId:other.id,text:''},{now,trustedRecording:recording}),rejectsStatus(403));
});

test('audio validation canonicalizes real WAV and rejects HTML, wrong MIME, empty and oversized files',async()=>{
  const valid=await validateRecording(file());assert.equal(valid.mimeType,'audio/wav');assert.equal(valid.name,'客户沟通.wav');assert.equal(valid.bytes.length,48);
  await assert.rejects(validateRecording(file('fake.wav','audio/wav',new TextEncoder().encode('<html><script>alert(1)</script>'))),rejectsStatus(415));
  await assert.rejects(validateRecording(file('actual.wav','text/html')),rejectsStatus(415));
  await assert.rejects(validateRecording(file('renamed.mp3','audio/mpeg')),rejectsStatus(415));
  await assert.rejects(validateRecording(file('empty.wav','audio/wav',new Uint8Array())),rejectsStatus(400));
  await assert.rejects(validateRecording(file('big.wav','audio/wav',new Uint8Array(MAX_RECORDING_BYTES+1))),rejectsStatus(413));
});

test('multipart parser enforces revision, field uniqueness and total bytes without trusting Content-Length',async()=>{
  const valid=await parseRecordingForm(multipart());assert.equal(valid.dealId,'deal-1');assert.equal(valid.revision,1);assert.equal(valid.audio.name,'客户沟通.wav');
  await assert.rejects(parseRecordingForm(multipart(file(),{revision:'1.5'})),rejectsStatus(400));
  const duplicate=new FormData();duplicate.append('dealId','deal-1');duplicate.append('dealId','deal-2');duplicate.set('text','');duplicate.set('revision','1');duplicate.set('audio',file());
  await assert.rejects(parseRecordingForm(new Request('https://example.test',{method:'POST',body:duplicate})),rejectsStatus(400));
  const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(MAX_MULTIPART_BYTES));controller.enqueue(new Uint8Array(1));controller.close();}});
  const huge=new Request('https://example.test',{method:'POST',headers:{'Content-Type':'multipart/form-data; boundary=test','Content-Length':'1'},body:stream,duplex:'half'} as RequestInit);
  await assert.rejects(parseRecordingForm(huge),rejectsStatus(413));
});

function persistence(state=createSeed(now),failSave=false) {
  const objects=new Map<string,Uint8Array>();let saved:WorkbenchState|undefined;
  const deps={load:async()=>structuredClone(state),save:async(expected:number,next:WorkbenchState)=>{assert.equal(expected,state.revision);if(failSave)throw new DomainError('版本冲突',409);saved=structuredClone(next);},bucket:{put:async(key:string,value:Uint8Array,options:{onlyIf:{etagDoesNotMatch:string}})=>{assert.equal(options.onlyIf.etagDoesNotMatch,'*');if(objects.has(key))return null;objects.set(key,value);return {key};},delete:async(key:string)=>{objects.delete(key);}}};
  return {deps,objects,saved:()=>saved};
}

test('saving audio persists one note, opaque account scoped object key and only projected metadata',async()=>{
  const store=persistence();const state=createSeed(now);const dealId=state.deals.find(item=>item.ownerId==='sales-1')!.id;
  const result=await saveRecordingNote('platform-user','sales',{dealId,text:'',revision:state.revision,audio:file()},store.deps);
  const note=result.state.deals.find(item=>item.id===dealId)!.notes[0];assert.equal(note.text,'');assert.equal(note.recording?.mimeType,'audio/wav');
  assert.equal(store.objects.size,1);assert.equal(store.saved()?.revision,state.revision+1);assert.equal(result.state.role,'sales');
  assert.ok(result.state.deals.every(item=>item.ownerId==='sales-1'));
  const key=[...store.objects.keys()][0];assert.ok(!key.includes('platform-user'));assert.ok(!JSON.stringify(result).includes(key));
  assert.equal(key,await recordingObjectKey('platform-user',note.recording!.id));assert.notEqual(key,await recordingObjectKey('another-user',note.recording!.id));
});

test('unauthorized or stale uploads leave no object; failed SQL save cleans uploaded bytes',async()=>{
  const state=createSeed(now);const own=state.deals.find(item=>item.ownerId==='sales-1')!;const other=state.deals.find(item=>item.ownerId!=='sales-1')!;
  const store=persistence(state);
  await assert.rejects(saveRecordingNote('user','sales',{dealId:other.id,text:'',revision:state.revision,audio:file()},store.deps),rejectsStatus(403));assert.equal(store.objects.size,0);
  await assert.rejects(saveRecordingNote('user','sales',{dealId:own.id,text:'',revision:0,audio:file()},store.deps),rejectsStatus(409));assert.equal(store.objects.size,0);
  const failing=persistence(state,true);
  await assert.rejects(saveRecordingNote('user','sales',{dealId:own.id,text:'',revision:state.revision,audio:file()},failing.deps),rejectsStatus(409));assert.equal(failing.objects.size,0);assert.equal(failing.saved(),undefined);
});

test('playback requires an actual visible deal note reference and validates single byte ranges',()=>{
  const state=createSeed(now);const own=state.deals.find(item=>item.ownerId==='sales-1')!;const other=state.deals.find(item=>item.ownerId!=='sales-1')!;
  own.notes[0].recording=recording;other.notes[0].recording={...recording,id:'recording-ec4ab83f-dae3-4a67-af13-4f5abf61e82c'};
  assert.equal(authorizedRecording(projectState(state,'sales'),own.id,recording.id).name,'客户沟通.wav');
  assert.throws(()=>authorizedRecording(projectState(state,'sales'),other.id,other.notes[0].recording!.id),rejectsStatus(404));
  assert.throws(()=>authorizedRecording(state,own.id,other.notes[0].recording!.id),rejectsStatus(404));
  assert.deepEqual(parseAudioRange('bytes=0-9',100),{offset:0,length:10});assert.deepEqual(parseAudioRange('bytes=-10',100),{offset:90,length:10});assert.deepEqual(parseAudioRange('bytes=90-',100),{offset:90,length:10});
  assert.throws(()=>parseAudioRange('bytes=100-',100),rejectsStatus(416));assert.throws(()=>parseAudioRange('bytes=0-2,5-8',100),rejectsStatus(416));
});

test('all offered recording formats require matching codec headers as well as filename and MIME',async()=>{
  const mp3=Uint8Array.from([255,251,144,0,0,0,0,0]);
  const tagged=new Uint8Array(18);tagged.set(new TextEncoder().encode('ID3'));tagged[3]=4;tagged.set(mp3,10);
  const m4a=new Uint8Array(24);new DataView(m4a.buffer).setUint32(0,24);m4a.set(new TextEncoder().encode('ftypM4A '),4);m4a.set(new TextEncoder().encode('isommp42'),16);
  const aac=Uint8Array.from([255,241,80,128,0,255,252]);
  const flac=new Uint8Array(42);flac.set(new TextEncoder().encode('fLaC'));flac[4]=128;flac[7]=34;
  const ogg=new Uint8Array(36);ogg.set(new TextEncoder().encode('OggS'));ogg[26]=1;ogg[27]=8;ogg.set(new TextEncoder().encode('OpusHead'),28);
  const webm=new Uint8Array(32);webm.set([26,69,223,163]);webm.set(new TextEncoder().encode('webm A_OPUS'),10);
  for(const [extension,mimeType,bytes] of [['mp3','audio/mpeg',mp3],['mp3','audio/mpeg',tagged],['m4a','audio/mp4',m4a],['aac','audio/aac',aac],['flac','audio/flac',flac],['ogg','audio/ogg',ogg],['webm','audio/webm',webm]] as const) {
    assert.equal((await validateRecording(file(`sample.${extension}`,mimeType,bytes))).mimeType,mimeType);
    await assert.rejects(validateRecording(file(`fake.${extension}`,mimeType,new TextEncoder().encode('<html>not an audio container</html>'))),rejectsStatus(415));
  }
});

test('a conditional storage collision cannot overwrite an object or persist a dangling note',async()=>{
  const state=createSeed(now);const deal=state.deals.find(item=>item.ownerId==='sales-1')!;
  const existing=new Map<string,Uint8Array>();let saved=false;
  const deps={load:async()=>state,save:async()=>{saved=true;},bucket:{put:async(key:string)=>{existing.set(key,Uint8Array.from([1,2,3]));return null;},delete:async(key:string)=>{existing.delete(key);}}};
  await assert.rejects(saveRecordingNote('user','sales',{dealId:deal.id,text:'',revision:state.revision,audio:file()},deps),rejectsStatus(503));
  assert.equal(saved,false);assert.equal(existing.size,1);assert.deepEqual([...existing.values()][0],Uint8Array.from([1,2,3]));
});
