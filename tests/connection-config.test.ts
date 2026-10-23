import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptConnectionSecret, encryptConnectionSecret, modelEndpoint, normalizeModelBaseUrl, parseConnectionCommand, readConnectionBody, assertSameOrigin, testModelConnection } from '../app/lib/connection-config.ts';
const key='12'.repeat(32);

test('model endpoints reject internal, ambiguous, credential-bearing and non-HTTPS destinations',()=>{
  for(const url of ['http://api.example.com/v1','https://127.0.0.1/v1','https://10.0.0.1','https://169.254.169.254','https://[::1]','https://[::ffff:127.0.0.1]','https://2130706433','https://0x7f000001','https://metadata.google.internal','https://localhost','https://foo.local','https://foo','https://user:secret@api.example.com/v1','https://api.example.com?key=secret','https://api.example.com/#key'])assert.throws(()=>normalizeModelBaseUrl(url));
  assert.equal(modelEndpoint('https://api.example.com/v1/'),'https://api.example.com/v1/chat/completions');
  assert.equal(normalizeModelBaseUrl('http://127.0.0.1:8080/v1','http://localhost:3000'),'http://127.0.0.1:8080/v1');
  assert.throws(()=>normalizeModelBaseUrl('http://192.168.1.1:8080','http://localhost:3000'));
  assert.throws(()=>normalizeModelBaseUrl('http://127.0.0.1:8080','https://work.example.com'));
});
test('AES-GCM ciphertext is randomized and cannot cross account or connection boundaries',async()=>{
  const a=await encryptConnectionSecret('sk-test-secret',key,'alice','model');
  const b=await encryptConnectionSecret('sk-test-secret',key,'alice','model');
  assert.notEqual(a,b);assert.ok(!a.includes('sk-test-secret'));
  assert.equal(await decryptConnectionSecret(a,key,'alice','model'),'sk-test-secret');
  await assert.rejects(decryptConnectionSecret(a,key,'bob','model'));
  await assert.rejects(decryptConnectionSecret(a,key,'alice','voice'));
  const parts=a.split('.');parts[2]=`${parts[2][0]==='A'?'B':'A'}${parts[2].slice(1)}`;
  await assert.rejects(decryptConnectionSecret(parts.join('.'),key,'alice','model'));
  await assert.rejects(encryptConnectionSecret('secret','bad-key','alice','model'));
});
test('commands reject invalid kinds, stale-version shapes and header injection',()=>{
  for(const input of [null,[],{action:'save',kind:'voice',version:0},{action:'save',kind:'model',version:-1},{action:'save',kind:'model',version:0,enabled:'yes'},{action:'save',kind:'model',version:0,secret:'key\r\nOther: secret'},{action:'save',kind:'model',version:0,modelName:'bad\nname'}])assert.throws(()=>parseConnectionCommand(input));
  assert.equal(parseConnectionCommand({action:'save',kind:'model',version:0,secret:'  '}).secret,undefined);
});
test('writes enforce same-origin and the streamed body ceiling',async()=>{
  assert.throws(()=>assertSameOrigin(new Request('https://work.example.com/api/connections',{headers:{origin:'https://attacker.example'}})));
  assert.throws(()=>assertSameOrigin(new Request('https://work.example.com/api/connections',{headers:{'sec-fetch-site':'cross-site'}})));
  assertSameOrigin(new Request('https://work.example.com/api/connections',{headers:{origin:'https://work.example.com'}}));
  await assert.rejects(readConnectionBody(new Request('https://work.example.com',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({secret:'x'.repeat(17000)})})),{status:413});
  await assert.rejects(readConnectionBody(new Request('https://work.example.com',{method:'POST',headers:{'content-type':'application/json'},body:'{'})),{status:400});
});
test('model tests send only a synthetic prompt, reject redirects, and redact provider bodies and exceptions',async()=>{
  const config={key:'sk-private-test',url:'https://api.example.com/v1/chat/completions',name:'example-model'};
  let sentBody:Record<string,unknown>={};
  const result=await testModelConnection(config,async(url,options)=>{
    assert.equal(url,config.url);assert.equal(options?.redirect,'manual');
    assert.equal(new Headers(options?.headers).get('Authorization'),'Bearer sk-private-test');
    sentBody=JSON.parse(String(options?.body));
    return Response.json({choices:[{message:{content:'ok'}}]});
  });
  assert.equal(sentBody.max_tokens,256);assert.equal(sentBody.model,'example-model');assert.equal((sentBody.messages as unknown[]).length,1);
  assert.equal(result.ok,true);assert.ok(!JSON.stringify(result).includes(config.key));
  for(const response of [new Response(config.key,{status:401}),new Response(config.key,{status:302,headers:{location:'https://attacker.example'}}),Response.json({error:config.key}),new Response(`{"choices":${config.key}`)]){
    await assert.rejects(testModelConnection(config,async()=>response),(error:unknown)=>error instanceof Error&&!error.message.includes(config.key));
  }
  await assert.rejects(testModelConnection(config,async()=>{throw new Error(`leaked ${config.key}`);}),(error:unknown)=>error instanceof Error&&!error.message.includes(config.key));
});
test('connection tests disable default DeepSeek thinking and budget enough tokens for a visible answer',async()=>{
  const config={key:'sk-private-test',url:'https://api.deepseek.com/chat/completions',name:'deepseek-v4-pro'};
  let sentBody:Record<string,unknown>={};
  const result=await testModelConnection(config,async(_url,options)=>{
    sentBody=JSON.parse(String(options.body));
    return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:'OK'}}]});
  });
  assert.deepEqual(sentBody.thinking,{type:'disabled'});assert.equal(sentBody.max_tokens,256);
  assert.equal(result.ok,true);
});
test('connection tests accept standard text content parts',async()=>{
  const result=await testModelConnection({key:'synthetic-key',url:'https://api.example.com/v1/chat/completions',name:'generic'},async()=>Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:[{type:'text',text:'OK'}]}}]}));
  assert.equal(result.ok,true);
});
test('connection tests explain exhausted reasoning output and reject partial truncated answers',async()=>{
  const config={key:'synthetic-key',url:'https://api.deepseek.com/chat/completions',name:'deepseek-reasoner'};
  for(const content of ['', 'partial answer']){
    await assert.rejects(testModelConnection(config,async()=>Response.json({choices:[{finish_reason:'length',message:{role:'assistant',reasoning_content:'private reasoning',content}}]})),(error:unknown)=>error instanceof Error&&/额度|截断/.test(error.message)&&!error.message.includes('private reasoning'));
  }
});
test('connection tests distinguish thinking without a final answer from generic empty content',async()=>{
  const config={key:'synthetic-key',url:'https://api.deepseek.com/chat/completions',name:'deepseek-reasoner'};
  await assert.rejects(testModelConnection(config,async()=>Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',reasoning_content:'private reasoning',content:null}}]})),(error:unknown)=>error instanceof Error&&/思考|推理/.test(error.message)&&!error.message.includes('private reasoning'));
});
