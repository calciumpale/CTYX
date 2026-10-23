import { DomainError } from './domain.ts';
import { requestModelText } from './model-client.ts';

export interface ConnectionCommand {
  action:'save'|'test'|'remove';kind:'model';version:number;
  enabled?:boolean;baseUrl?:string;modelName?:string;secret?:string;
}
export interface EffectiveModel {key:string;url:string;name:string;}
export type ConnectionFetch=(url:string,options:RequestInit)=>Promise<Response>;
const encoder=new TextEncoder();
const controls=/[\u0000-\u001f\u007f]/;
const loopback=(host:string)=>['localhost','127.0.0.1','[::1]'].includes(host.toLowerCase());
function localSite(origin:string):boolean {
  try {const url=new URL(origin);return url.protocol==='http:'&&loopback(url.hostname);}catch{return false;}
}
/** Only public DNS hostnames are supported in production. Literal IPs are rejected,
 * including WHATWG-normalized numeric/hex IPv4 and mapped IPv6 addresses. */
export function normalizeModelBaseUrl(value:string,siteOrigin='https://production.invalid'):string {
  if(typeof value!=='string'||!value.trim()||value.length>2048||controls.test(value))throw new DomainError('请填写有效的 API Base URL');
  let url:URL;try {url=new URL(value.trim());}catch{throw new DomainError('API Base URL 格式不正确');}
  if(url.username||url.password||url.search||url.hash)throw new DomainError('API 地址不能包含账号、密码、查询参数或片段');
  const host=url.hostname.toLowerCase().replace(/\.$/,'');
  const local=loopback(host)&&localSite(siteOrigin);
  const publicHost=/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(host)
    &&!/(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|onion)$/.test(host);
  if(!local&&(url.protocol!=='https:'||!publicHost))throw new DomainError('API 地址须使用公网域名的 HTTPS；本地开发仅允许回环地址');
  if(local&&!['http:','https:'].includes(url.protocol))throw new DomainError('本地 API 地址须使用 HTTP 或 HTTPS');
  url.hostname=host;return url.href.replace(/\/+$/,'');
}
export function modelEndpoint(baseUrl:string,siteOrigin?:string):string {
  return `${normalizeModelBaseUrl(baseUrl,siteOrigin)}/chat/completions`;
}
export function parseConnectionCommand(value:unknown):ConnectionCommand {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new DomainError('API 配置参数格式不正确');
  const input=value as Record<string,unknown>;
  if(!['save','test','remove'].includes(String(input.action))||input.kind!=='model')throw new DomainError('请选择有效的 API 配置操作');
  if(!Number.isSafeInteger(input.version)||(input.version as number)<0)throw new DomainError('配置版本无效，请刷新后重试',409);
  if(input.enabled!==undefined&&typeof input.enabled!=='boolean')throw new DomainError('启用状态格式不正确');
  const text=(field:string,max:number):string|undefined=>{
    const raw=input[field];if(raw===undefined)return undefined;
    if(typeof raw!=='string'||raw.length>max||controls.test(raw))throw new DomainError('API 配置文本格式或长度不正确');
    return raw.trim()||undefined;
  };
  return {action:input.action as ConnectionCommand['action'],kind:'model',version:input.version as number,enabled:input.enabled as boolean|undefined,baseUrl:text('baseUrl',2048),modelName:text('modelName',160),secret:text('secret',8192)};
}
export function encryptionReady(key:unknown):key is string {return typeof key==='string'&&/^[0-9a-fA-F]{64}$/.test(key);}
async function cryptoKey(key:string):Promise<CryptoKey> {
  if(!encryptionReady(key))throw new DomainError('API 配置加密尚未启用，请联系管理员',503);
  const bytes=Uint8Array.from(key.match(/../g)!,pair=>parseInt(pair,16));
  return crypto.subtle.importKey('raw',bytes,'AES-GCM',false,['encrypt','decrypt']);
}
function encode(bytes:Uint8Array):string {return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function decode(value:string):Uint8Array<ArrayBuffer> {return Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),character=>character.charCodeAt(0));}
function aad(userId:string,kind:string):Uint8Array<ArrayBuffer> {return encoder.encode(JSON.stringify(['workbench-api-connection',userId,kind]));}
export async function encryptConnectionSecret(secret:string,key:string,userId:string,kind:string):Promise<string> {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(userId,kind)},await cryptoKey(key),encoder.encode(secret));
  return `v1.${encode(iv)}.${encode(new Uint8Array(encrypted))}`;
}
export async function decryptConnectionSecret(value:string,key:string,userId:string,kind:string):Promise<string> {
  try {
    const [version,iv,ciphertext,...extra]=value.split('.');
    if(version!=='v1'||!iv||!ciphertext||extra.length)throw new Error('Invalid ciphertext');
    const bytes=decode(iv);if(bytes.length!==12)throw new Error('Invalid IV');
    const decrypted=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes,additionalData:aad(userId,kind)},await cryptoKey(key),decode(ciphertext));
    return new TextDecoder().decode(decrypted);
  }catch{throw new DomainError('已保存的 API 密钥无法读取，请重新填写密钥并保存',503);}
}
export function assertSameOrigin(request:Request):void {
  const origin=request.headers.get('origin');
  if((origin&&origin!==new URL(request.url).origin)||request.headers.get('sec-fetch-site')==='cross-site')throw new DomainError('只允许从当前站点修改 API 配置',403);
}
export async function readConnectionBody(request:Request):Promise<unknown> {
  if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))throw new DomainError('请使用 JSON 格式提交请求',415);
  const reader=request.body?.getReader();if(!reader)throw new DomainError('缺少 API 配置参数');
  const chunks:Uint8Array[]=[];let length=0;
  try {while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>16384){await reader.cancel();throw new DomainError('API 配置参数过大',413);}chunks.push(value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.byteLength;}
  try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new DomainError('API 配置参数格式不正确');}
}
export async function testModelConnection(model:EffectiveModel,request:ConnectionFetch=fetch):Promise<{ok:true;detail:string;latencyMs:number}> {
  const start=Date.now();
  await requestModelText(model,[{role:'user',content:'Reply with OK.'}],{request,purpose:'test'});
  // Provider content is never echoed by the synthetic connection test.
  return {ok:true,detail:'已收到模型有效回复，连接测试通过',latencyMs:Math.max(0,Date.now()-start)};
}
