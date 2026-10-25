import {DomainError} from './domain.ts';
import {normalizeModelBaseUrl} from './connection-config.ts';
import {gatewayConfiguration} from './voice-session.ts';
import {SPEECH_DIALECTS} from './speech-types.ts';
import type {SpeechCapabilities,SpeechHotword,SpeechSettings} from './speech-types.ts';

export interface SpeechEnvironment {DB?:D1Database;VOICE_GATEWAY_URL?:string;VOICE_GATEWAY_SECRET?:string;}
export type StoredSpeechSettings=Omit<SpeechSettings,'capabilities'>;
export type SpeechFetch=(url:string,options?:RequestInit)=>Promise<Response>;
const unavailable=(configured=false,message='语音网关尚未配置'):SpeechCapabilities=>({configured,available:false,model:'',dialects:[],diarization:false,hotwords:false,message});
const defaults=():StoredSpeechSettings=>({version:0,hotwords:[],dialect:'auto',diarization:true,speakerCount:null});
export function speechGateway(environment:SpeechEnvironment,origin:string):{url:string;secret:string}|null {
  let configuration:ReturnType<typeof gatewayConfiguration>;
  try{configuration=gatewayConfiguration(environment,origin);}catch{throw new DomainError('语音网关配置不完整，请联系管理员检查服务地址和密钥',503);}
  if(!configuration)return null;
  const address=new URL(configuration.url);address.protocol=address.protocol==='wss:'?'https:':'http:';
  address.pathname=address.pathname.replace(/\/ws\/?$/,'').replace(/\/+$/,'');
  return {url:normalizeModelBaseUrl(address.href,origin),secret:configuration.secret};
}
export function parseSpeechSettings(value:unknown):StoredSpeechSettings {
  const fail=(message='语音识别设置格式不正确'):never=>{throw new DomainError(message);};
  if(!value||typeof value!=='object'||Array.isArray(value))return fail();const data=value as Record<string,unknown>;
  if(!Number.isSafeInteger(data.version)||(data.version as number)<0)throw new DomainError('设置版本无效，请刷新后重试',409);
  if(!SPEECH_DIALECTS.includes(data.dialect as SpeechSettings['dialect'])||typeof data.diarization!=='boolean'||(data.speakerCount!==null&&(!Number.isInteger(data.speakerCount)||(data.speakerCount as number)<1||(data.speakerCount as number)>10)))return fail('请检查方言和讲话人数设置');
  if(!Array.isArray(data.hotwords)||data.hotwords.length>50)return fail('热词表最多保存50条');
  const ids=new Set<string>(),terms=new Set<string>(),aliases=new Map<string,string>();
  const hotwords:SpeechHotword[]=data.hotwords.map(raw=>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return fail();const item=raw as Record<string,unknown>;
    if(typeof item.id!=='string'||!/^[\w-]{1,100}$/.test(item.id)||ids.has(item.id)||typeof item.term!=='string'||!item.term.trim()||item.term.trim().length>40||/[\u0000-\u001f\u007f,，]/.test(item.term)||typeof item.enabled!=='boolean'||!Array.isArray(item.aliases)||item.aliases.length>5)return fail('每条热词须有有效标准词、开关及至多5个误识别写法；标准词不能包含逗号');
    const term=item.term.trim(),normalized=term.toLocaleLowerCase();if(terms.has(normalized))return fail('标准词不能重复');terms.add(normalized);ids.add(item.id);
    const variants:string[]=[];for(const alias of item.aliases){if(typeof alias!=='string'||alias.trim().length<2||alias.trim().length>40||/[\u0000-\u001f\u007f]/.test(alias))return fail('误识别写法须为2至40字，避免单字误替换');const clean=alias.trim();if(clean===term||variants.includes(clean))continue;variants.push(clean);if(item.enabled){const previous=aliases.get(clean);if(previous&&previous!==term)return fail('同一误识别写法不能对应多个标准词');aliases.set(clean,term);}}
    return {id:item.id,term,aliases:variants,enabled:item.enabled};
  });
  for(const [alias,term] of aliases)if(terms.has(alias.toLocaleLowerCase())&&alias.toLocaleLowerCase()!==term.toLocaleLowerCase())return fail('误识别写法不能与其他标准词冲突');
  return {version:data.version as number,hotwords,dialect:data.dialect as SpeechSettings['dialect'],diarization:data.diarization,speakerCount:data.speakerCount as number|null};
}
export async function speechCapabilities(environment:SpeechEnvironment,origin:string,request:SpeechFetch=fetch):Promise<SpeechCapabilities>{
  let gateway:ReturnType<typeof speechGateway>;try{gateway=speechGateway(environment,origin);}catch{return unavailable(false,'语音网关配置不完整，请联系管理员');}if(!gateway)return unavailable();
  try{const response=await request(`${gateway.url}/speech-capabilities`,{redirect:'manual',signal:AbortSignal.timeout(4000)});if(!response.ok)return unavailable(true,'转写服务暂时不可用，请检查本机语音服务');const data=await readSpeechJson(response,16000) as Record<string,unknown>;
    const available=data.available===true;return {configured:true,available,model:typeof data.model==='string'?data.model.slice(0,160):'',dialects:Array.isArray(data.dialects)?data.dialects.filter((v):v is string=>typeof v==='string'&&v.length<80).slice(0,20):[],diarization:data.diarization===true,hotwords:data.hotwords===true,...(!available?{message:'识别模型尚未就绪，请启动或检查本机转写服务'}:{})};
  }catch{return unavailable(true,'无法连接转写服务，请检查本机语音服务');}
}
export async function readSpeechJson(response:Response,maxBytes:number):Promise<unknown>{
  if(!response.body)throw new DomainError('转写服务未返回结果',502);const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes){await reader.cancel();throw new DomainError('转写结果过大，请缩短录音后重试',413);}chunks.push(value);}}finally{reader.releaseLock();}const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new DomainError('转写服务返回格式无效',502);}
}
export function createSpeechSettingsStore(environment:SpeechEnvironment){
  const database=()=>{if(!environment.DB)throw new DomainError('语音设置存储尚未就绪',503);return environment.DB;};
  const user=(id:string)=>{if(!id||id.length>512)throw new DomainError('请先登录',401);};
  async function read(userId:string):Promise<StoredSpeechSettings>{user(userId);const row=await database().prepare('SELECT version,data_json FROM workbench_speech_settings WHERE user_id = ?').bind(userId).first<{version:number;data_json:string}>();return row?parseSpeechSettings({...JSON.parse(row.data_json),version:row.version}):defaults();}
  async function save(userId:string,value:unknown):Promise<StoredSpeechSettings>{user(userId);const input=parseSpeechSettings(value),now=new Date().toISOString(),next={...input,version:input.version+1};const result=input.version===0?await database().prepare('INSERT INTO workbench_speech_settings (user_id,version,updated_at,data_json) VALUES (?,?,?,?) ON CONFLICT(user_id) DO NOTHING').bind(userId,next.version,now,JSON.stringify(next)).run():await database().prepare('UPDATE workbench_speech_settings SET version = ?,updated_at = ?,data_json = ? WHERE user_id = ? AND version = ?').bind(next.version,now,JSON.stringify(next),userId,input.version).run();if(result.meta.changes!==1)throw new DomainError('语音设置已在其他页面更新，请刷新后重试',409);return next;}
  return {read,save,async snapshot(userId:string,origin:string,request?:SpeechFetch):Promise<SpeechSettings>{return {...await read(userId),capabilities:await speechCapabilities(environment,origin,request)};}};
}
