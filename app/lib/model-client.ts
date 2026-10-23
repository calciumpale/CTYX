import { DomainError } from './domain.ts';
import type { ConnectionFetch, EffectiveModel } from './connection-config.ts';

export interface ModelMessage {role:'system'|'user'|'assistant';content:string;}
export interface ModelRequestOptions {
  request?:ConnectionFetch;
  purpose?:'generation'|'test';
  timeoutMs?:number;
}

// Only errors created here may cross the provider boundary. A fetch adapter can
// throw any Error subclass, including DomainError with a credential-bearing body.
class ModelClientError extends DomainError {}
const failure=(message:string)=>new ModelClientError(message,502);
const record=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;

function requestPolicy(model:EffectiveModel,purpose:'generation'|'test') {
  let officialDeepSeek=false;
  try {officialDeepSeek=new URL(model.url).hostname.toLowerCase().replace(/\.$/,'')==='api.deepseek.com';}catch{/* Configuration validation owns URL errors. */}
  const deepSeek=officialDeepSeek||/^deepseek-/i.test(model.name);
  const reasoning=/(?:reasoner|(?:^|[-_/])r1(?:$|[-_/]))/i.test(model.name);
  const testing=purpose==='test';
  return {
    maxTokens:reasoning?(testing?2048:16384):(testing?256:4096),
    timeoutMs:reasoning?(testing?30000:60000):(testing?12000:25000),
    disableThinking:deepSeek&&!reasoning,
  };
}

function httpError(status:number):ModelClientError {
  if(status>=300&&status<400)return failure('模型 API 返回了重定向，为保护密钥未跟随跳转，请检查 API Base URL');
  if(status===401)return failure('模型 API 认证失败（HTTP 401），请检查密钥是否有效');
  if(status===402)return failure('模型 API 余额不足（HTTP 402），请补充余额或更换密钥后重试');
  if(status===403)return failure('模型 API 拒绝访问（HTTP 403），请检查密钥权限和模型访问权限');
  if(status===404)return failure('模型 API 地址或模型不存在（HTTP 404），请检查 API 地址和模型名称');
  if(status===429)return failure('模型 API 请求过于频繁或配额不足（HTTP 429），请稍后重试并检查配额');
  if(status>=500)return failure(`模型服务暂时不可用（HTTP ${status}），请稍后重试`);
  return failure(`模型 API 请求失败（HTTP ${status}），请检查 API 地址、模型名称和配置`);
}

function visibleText(content:unknown):string {
  if(typeof content==='string')return content.trim();
  if(!Array.isArray(content)||!content.every(part=>{
    const item=record(part);return item?.type==='text'&&typeof item.text==='string';
  }))return '';
  return content.map(part=>(part as {text:string}).text).join('').trim();
}

function completionText(data:unknown):string {
  const choices=record(data)?.choices;
  const choice=Array.isArray(choices)?record(choices[0]):null;
  const message=record(choice?.message);
  if(choice?.finish_reason==='length')throw failure('模型输出额度已耗尽，回复被截断且未完成；请缩短问题或改用非推理模型后重试');
  if(!message)throw failure('模型 API 返回格式异常，请检查接口是否兼容 Chat Completions');
  const parts=Array.isArray(message.content)?message.content:[];
  if(choice?.finish_reason==='content_filter'||(typeof message.refusal==='string'&&message.refusal.trim())||parts.some(part=>record(part)?.type==='refusal'))throw failure('模型拒绝了本次请求或触发内容限制，请调整问题后重试');
  if(choice?.finish_reason==='tool_calls'||choice?.finish_reason==='function_call'||(Array.isArray(message.tool_calls)&&message.tool_calls.length>0)||message.function_call)throw failure('模型返回了当前工作台不支持的工具调用，请使用可直接回复文本的模型');
  if(choice?.finish_reason&&choice.finish_reason!=='stop')throw failure('模型未完成答复，请稍后重试');
  const answer=visibleText(message.content);
  if(answer)return answer;
  if(typeof message.reasoning_content==='string'&&message.reasoning_content.trim())throw failure('模型只返回了思考过程，尚未生成答复正文；请缩短问题或改用非推理模型后重试');
  throw failure('模型未返回有效文本正文，请检查接口是否兼容 Chat Completions 后重试');
}

/** Uses the same response contract for generation and synthetic connection tests.
 * Reasoning is never substituted for the visible assistant answer. */
export async function requestModelText(model:EffectiveModel,messages:ModelMessage[],options:ModelRequestOptions={}):Promise<string> {
  const purpose=options.purpose??'generation';
  const policy=requestPolicy(model,purpose);
  const requestedTimeout=options.timeoutMs;
  const timeoutMs=typeof requestedTimeout==='number'&&Number.isFinite(requestedTimeout)
    ?Math.max(1,Math.min(requestedTimeout,purpose==='test'?30000:60000)):policy.timeoutMs;
  const controller=new AbortController();
  let timer:ReturnType<typeof setTimeout>|undefined;
  const timeoutMessage=purpose==='test'?'模型连接测试超时，请稍后重试或使用非推理模型':'模型回复超时，请稍后重试或使用非推理模型';
  const timedOut=new Promise<never>((_resolve,reject)=>{
    timer=setTimeout(()=>{controller.abort();reject(failure(timeoutMessage));},timeoutMs);
  });
  const complete=async()=>{
    const response=await (options.request??fetch)(model.url,{
      method:'POST',redirect:'manual',
      headers:{Authorization:`Bearer ${model.key}`,'Content-Type':'application/json'},
      signal:controller.signal,
      body:JSON.stringify({model:model.name,messages,max_tokens:policy.maxTokens,...(policy.disableThinking?{thinking:{type:'disabled'}}:{})}),
    });
    if(!response.ok)throw httpError(response.status);
    let data:unknown;
    try {data=await response.json();}catch{
      if(controller.signal.aborted)throw failure(timeoutMessage);
      throw failure('模型 API 返回格式异常，请检查接口是否兼容 Chat Completions');
    }
    return completionText(data);
  };
  try {return await Promise.race([complete(),timedOut]);}
  catch(error){
    if(error instanceof ModelClientError)throw error;
    if(controller.signal.aborted)throw failure(timeoutMessage);
    throw failure(purpose==='test'?'模型连接测试失败，请检查地址、模型名称和密钥':'模型请求失败，请检查 API 地址、模型名称和密钥后重试');
  }finally{clearTimeout(timer);}
}
