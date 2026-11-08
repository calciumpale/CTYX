import test from 'node:test';import assert from 'node:assert/strict';
import {parseMaterialInput,materialPayload,validateMaterialUrl,validateSlides,boundedMaterialBytes} from '../app/lib/marketing-material.ts';
test('retired presentation commands cannot create new tasks or edit old slides through the public surface',async()=>{
 const {assertCurrentMaterialCommand}=await import('../app/lib/marketing-material.ts');
 assert.throws(()=>assertCurrentMaterialCommand({action:'generate',input:{kind:'presentation',prompt:'产品'}}),{status:410});
 assert.throws(()=>assertCurrentMaterialCommand({action:'updateSlides',taskId:'legacy'}),{status:410});
 for(const kind of ['image','video'])assert.doesNotThrow(()=>assertCurrentMaterialCommand({action:'generate',input:{kind,prompt:'产品'}}));
 assert.doesNotThrow(()=>assertCurrentMaterialCommand({action:'refresh',taskId:'existing-image'}));
});
test('fixed APIMart payload defaults and unsupported options reject',()=>{const input=parseMaterialInput({kind:'video',prompt:'产品'});assert.deepEqual(materialPayload(input,'ignored'),{model:'kling-v3',prompt:'产品',mode:'std',duration:5,aspect_ratio:'16:9',audio:false});assert.throws(()=>parseMaterialInput({kind:'image',prompt:'产品',n:5}));assert.throws(()=>parseMaterialInput({kind:'video',prompt:'产品',duration:16}));});
test('result destination boundary rejects credential, redirects destination, literal IP and suffix tricks',()=>{for(const u of ['http://cdn.apimart.ai/a','https://127.0.0.1/a','https://cdn.apimart.ai.evil.com/a','https://secret@cdn.apimart.ai/a','https://cdn.apimart.ai:8443/a'])assert.throws(()=>validateMaterialUrl(u));assert.equal(validateMaterialUrl('https://upload.apimart.ai/a').hostname,'upload.apimart.ai');});
test('observed APIMart delivery host is exact and retains URL trust boundaries',()=>{
 assert.equal(validateMaterialUrl('https://getapib.org/result.png?signature=private').hostname,'getapib.org');
 for(const url of ['http://getapib.org/a','https://getapib.org.evil.com/a','https://cdn.getapib.org/a','https://evilgetapib.org/a','https://secret@getapib.org/a','https://getapib.org:8443/a','https://getapib.org/a#fragment'])assert.throws(()=>validateMaterialUrl(url));
});
test('bounded streams and slide limits',async()=>{await assert.rejects(boundedMaterialBytes(new Response('12345'),4));assert.throws(()=>validateSlides([{title:'a',bullets:[]}]));assert.equal(validateSlides(Array.from({length:5},()=>({title:'产品',bullets:['已提供的卖点']}))).length,5);});
test('full bounded Chinese slide edits fit body budget, oversized and non-JSON bodies reject',async()=>{const {readMaterialBody}=await import('../app/lib/marketing-material.ts');const body=JSON.stringify({action:'updateSlides',slides:Array.from({length:12},()=>({title:'中'.repeat(80),bullets:Array.from({length:5},()=> '中'.repeat(180))}))});assert.ok(body.length<64*1024);assert.equal((await readMaterialBody(new Request('https://site.example',{method:'POST',headers:{'Content-Type':'application/json'},body}))).action,'updateSlides');await assert.rejects(readMaterialBody(new Request('https://site.example',{method:'POST',headers:{'Content-Type':'application/json'},body:'x'.repeat(65537)})),{status:413});});
test('large known-length video persists as a backpressured stream and rejects oversize without completing',async()=>{
 const {persistMaterialResult}=await import('../app/lib/marketing-material.ts');
 let pulled=0,maxAhead=0,consumed=0;const chunkSize=256*1024,total=80*1024*1024;
 const response=new Response(new ReadableStream({pull(controller){if(pulled===total){controller.close();return;}pulled+=chunkSize;maxAhead=Math.max(maxAhead,pulled-consumed);controller.enqueue(new Uint8Array(chunkSize));}}),{headers:{'Content-Length':String(total)}});
 const bucket={async put(_key:string,body:ReadableStream){assert.ok(body instanceof ReadableStream);const reader=body.getReader();while(true){const {done,value}=await reader.read();if(done)break;consumed+=value.byteLength;await Promise.resolve();}return {};}} as unknown as R2Bucket;
 await persistMaterialResult(response,bucket,'video',100*1024*1024,'video/mp4');assert.equal(consumed,total);assert.ok(maxAhead<=chunkSize*4,`buffered ahead ${maxAhead}`);
 const oversized=new Response(new Uint8Array(32),{headers:{'Content-Length':'16'}});
 await assert.rejects(persistMaterialResult(oversized,bucket,'oversized',16,'video/mp4'));
});

test('unknown-length video uses sequential bounded multipart and aborts oversize',async()=>{
 const {persistMaterialResult}=await import('../app/lib/marketing-material.ts');let completed=false,aborted=false;const sizes:number[]=[];
 const bucket={createMultipartUpload:async()=>({uploadPart:async(partNumber:number,bytes:Uint8Array)=>{sizes.push(bytes.length);return {partNumber,etag:'safe'};},complete:async()=>{completed=true;},abort:async()=>{aborted=true;}})} as unknown as R2Bucket;
 const response=()=>new Response(new ReadableStream({start(controller){for(let i=0;i<18;i++)controller.enqueue(new Uint8Array(1024*1024));controller.close();}}));
 await persistMaterialResult(response(),bucket,'private',100*1024*1024,'video/mp4');assert.equal(completed,true);assert.deepEqual(sizes,[5242880,5242880,5242880,3145728]);
 completed=false;await assert.rejects(persistMaterialResult(response(),bucket,'private',17*1024*1024,'video/mp4'));assert.equal(aborted,true);assert.equal(completed,false);
});
