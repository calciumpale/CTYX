import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError } from '../app/lib/domain.ts';
import { requestModelText } from '../app/lib/model-client.ts';
import type { ConnectionFetch } from '../app/lib/connection-config.ts';

const generic={key:'sk-synthetic-private',url:'https://api.example.com/v1/chat/completions',name:'general-chat'};
const messages=[{role:'user' as const,content:'请给出跟进建议'}];
const completion=(message:Record<string,unknown>,finishReason='stop')=>Response.json({id:'synthetic',object:'chat.completion',choices:[{index:0,finish_reason:finishReason,message:{role:'assistant',...message}}]});

test('generation preserves request context and never adds DeepSeek fields to generic providers',async()=>{
  let sent:{url:string;options:RequestInit}|undefined;
  const result=await requestModelText(generic,messages,{request:async(url,options)=>{
    sent={url,options};return completion({content:'  建议先确认预算  '});
  }});
  assert.equal(result,'建议先确认预算');assert.equal(sent?.url,generic.url);
  assert.equal(sent?.options.method,'POST');assert.equal(sent?.options.redirect,'manual');
  assert.equal(new Headers(sent?.options.headers).get('Authorization'),'Bearer sk-synthetic-private');
  const body=JSON.parse(String(sent?.options.body));
  assert.equal(body.max_tokens,4096);assert.equal(body.model,'general-chat');assert.deepEqual(body.messages,messages);assert.equal('thinking' in body,false);
});

for(const model of [
  {url:'https://api.deepseek.com/chat/completions',name:'deepseek-chat'},
  {url:'https://api.deepseek.com/v1/chat/completions',name:'deepseek-v4-pro'},
  {url:'https://api.deepseek.com/chat/completions',name:'custom-chat-alias'},
  {url:'https://proxy.example.com/v1/chat/completions',name:'deepseek-v4-flash'},
])test(`DeepSeek chat disables default thinking for ${model.name} at ${new URL(model.url).hostname}`,async()=>{
  let body:Record<string,unknown>={};
  await requestModelText({...model,key:generic.key},messages,{request:async(_url,options)=>{
    body=JSON.parse(String(options.body));return completion({content:'完整答复'});
  }});
  assert.deepEqual(body.thinking,{type:'disabled'});assert.equal(body.max_tokens,4096);
});

for(const name of ['deepseek-reasoner','deepseek-r1','DeepSeek-R1-Distill'])test(`${name} retains explicit reasoning with a separate output budget`,async()=>{
  for(const [purpose,budget] of [['generation',16384],['test',2048]] as const){
    let body:Record<string,unknown>={};
    const answer=await requestModelText({...generic,name},messages,{purpose,request:async(_url,options)=>{
      body=JSON.parse(String(options.body));return completion({reasoning_content:'private thought',content:'最终答复'});
    }});
    assert.equal(answer,'最终答复');assert.equal(body.max_tokens,budget);assert.equal('thinking' in body,false);
  }
});

test('lookalike provider hostnames do not receive DeepSeek-only request fields',async()=>{
  for(const url of ['https://api.deepseek.com.attacker.example/chat/completions','https://notdeepseek.com/chat/completions']){
    let body:Record<string,unknown>={};
    await requestModelText({...generic,url},messages,{request:async(_url,options)=>{
      body=JSON.parse(String(options.body));return completion({content:'答复'});
    }});
    assert.equal('thinking' in body,false);
  }
});

test('visible answer supports standard text parts and excludes reasoning content',async()=>{
  assert.equal(await requestModelText(generic,messages,{request:async()=>completion({reasoning_content:'Do not show this thought',content:[{type:'text',text:'  确认预算'}, {type:'text',text:'，再安排演示。  '}]})}),'确认预算，再安排演示。');
});

for(const content of ['',null,'看似可用但已截断的回答'])test(`length finish reason rejects incomplete ${content===null?'null':content?'partial':'empty'} content`,async()=>{
  await assert.rejects(requestModelText(generic,messages,{request:async()=>completion({reasoning_content:'private chain',content},'length')}),(error:unknown)=>error instanceof DomainError&&/额度/.test(error.message)&&/截断/.test(error.message)&&!error.message.includes('private chain')&&!error.message.includes('看似可用'));
});

test('reasoning without a final answer reports the missing final answer without exposing thoughts',async()=>{
  await assert.rejects(requestModelText(generic,messages,{request:async()=>completion({reasoning_content:'private chain',content:''})}),(error:unknown)=>error instanceof DomainError&&/思考|推理/.test(error.message)&&/正文|答复/.test(error.message)&&!error.message.includes('private chain'));
});

test('empty, malformed and unsupported text content never becomes a successful answer',async()=>{
  for(const content of ['',null,123,[{type:'text',text:123}],[{type:'image_url',image_url:{url:'private'}}]]){
    await assert.rejects(requestModelText(generic,messages,{request:async()=>completion({content})}),/正文|有效文本/);
  }
  for(const payload of [null,[],{choices:[]},{choices:[{message:null}]},{error:{message:generic.key}}]){
    await assert.rejects(requestModelText(generic,messages,{request:async()=>Response.json(payload)}),(error:unknown)=>error instanceof DomainError&&!error.message.includes(generic.key));
  }
});

test('refusals are explained without displaying supplier refusal text',async()=>{
  for(const [message,reason] of [
    [{content:null,refusal:generic.key},'stop'],
    [{content:'partial'},'content_filter'],
    [{content:[{type:'refusal',refusal:generic.key}]},'stop'],
  ] as const){
    await assert.rejects(requestModelText(generic,messages,{request:async()=>completion(message,reason)}),(error:unknown)=>error instanceof DomainError&&/拒绝|限制/.test(error.message)&&!error.message.includes(generic.key));
  }
});

test('unsupported tool calls do not masquerade as completed textual answers',async()=>{
  for(const [message,reason] of [
    [{content:'partial'},'tool_calls'],
    [{content:null,tool_calls:[{id:'fake',type:'function',function:{name:'search',arguments:'{}'}}]},'stop'],
    [{content:'partial',function_call:{name:'search',arguments:'{}'}},'function_call'],
  ] as const){
    await assert.rejects(requestModelText(generic,messages,{request:async()=>completion(message,reason)}),/工具调用/);
  }
});

for(const [status,expected] of [[401,/认证|密钥/],[402,/余额/],[429,/频繁|配额|额度/],[503,/暂时不可用|服务异常/],[302,/重定向/]] as const)test(`HTTP ${status} returns a safe actionable message`,async()=>{
  await assert.rejects(requestModelText(generic,messages,{request:async()=>new Response(generic.key,{status})}),(error:unknown)=>error instanceof DomainError&&expected.test(error.message)&&!error.message.includes(generic.key));
});

test('invalid JSON and request exceptions never disclose provider content or credentials',async()=>{
  const requests:ConnectionFetch[]=[
    async()=>new Response(`invalid-json:${generic.key}`),
    async()=>{throw new Error(`request failed: ${generic.key}`);},
    async()=>{throw new DomainError(`upstream leaked: ${generic.key}`);},
  ];
  for(const request of requests)await assert.rejects(requestModelText(generic,messages,{request}),(error:unknown)=>error instanceof DomainError&&!error.message.includes(generic.key)&&!error.message.includes('upstream leaked'));
});

test('timeout aborts the request and gives a safe retryable error',async()=>{
  let signal:AbortSignal|undefined;
  await assert.rejects(requestModelText(generic,messages,{timeoutMs:5,request:async(_url,options)=>{
    signal=options.signal as AbortSignal;
    return new Promise<Response>((_resolve,reject)=>signal!.addEventListener('abort',()=>reject(new Error(`abort: ${generic.key}`)),{once:true}));
  }}),(error:unknown)=>error instanceof DomainError&&/超时/.test(error.message)&&!error.message.includes(generic.key));
  assert.equal(signal?.aborted,true);
});

test('a stalled response body is included in the same bounded request timeout',async()=>{
  await assert.rejects(requestModelText(generic,messages,{timeoutMs:5,request:async()=>new Response(new ReadableStream({start(){}}),{headers:{'content-type':'application/json'}})}),/超时/);
});

test('completed requests clear the abort timer',async()=>{
  let signal:AbortSignal|undefined;
  await requestModelText(generic,messages,{timeoutMs:5,request:async(_url,options)=>{
    signal=options.signal as AbortSignal;return completion({content:'已完成'});
  }});
  await new Promise(resolve=>setTimeout(resolve,15));
  assert.equal(signal?.aborted,false);
});
