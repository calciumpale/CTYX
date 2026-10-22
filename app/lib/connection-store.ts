import { DomainError } from './domain.ts';
import { decryptConnectionSecret, encryptConnectionSecret, encryptionReady, modelEndpoint, normalizeModelBaseUrl, parseConnectionCommand, testModelConnection } from './connection-config.ts';
import type { ConnectionFetch, EffectiveModel } from './connection-config.ts';
import type { ConnectionActionResult, ConnectionSummary, ConnectionsSnapshot } from './connection-types.ts';

export interface ConnectionEnvironment {
  DB?:D1Database;CONFIG_ENCRYPTION_KEY?:string;MODEL_API_KEY?:string;MODEL_BASE_URL?:string;MODEL_NAME?:string;
}
interface ConnectionRow {user_id:string;kind:'model';enabled:number;base_url:string;model_name:string;secret_ciphertext:string;version:number;updated_at:string;}
interface ModelSettings {baseUrl:string;modelName:string;secret:string;}
const emptySummary=():ConnectionSummary=>({kind:'model',enabled:false,configured:false,source:'none',baseUrl:'',modelName:'',hasSecret:false,version:0,updatedAt:null});
const conflict=()=>new DomainError('API 配置已在其他页面更新，请刷新后重试',409);
function assertUser(userId:string):void {if(typeof userId!=='string'||!userId||userId.length>512)throw new DomainError('请先使用平台账号登录',401);}
function environmentSettings(environment:ConnectionEnvironment,siteOrigin:string):ModelSettings|null {
  if(!environment.MODEL_API_KEY?.trim()||!environment.MODEL_BASE_URL?.trim()||!environment.MODEL_NAME?.trim())return null;
  try {
    const parsed=parseConnectionCommand({action:'save',kind:'model',version:0,baseUrl:environment.MODEL_BASE_URL,modelName:environment.MODEL_NAME,secret:environment.MODEL_API_KEY});
    return {baseUrl:normalizeModelBaseUrl(parsed.baseUrl!,siteOrigin),modelName:parsed.modelName!,secret:parsed.secret!};
  }catch{return null;}
}
function fallbackSummary(environment:ConnectionEnvironment,siteOrigin:string):ConnectionSummary {
  const settings=environmentSettings(environment,siteOrigin);
  if(settings)return {...emptySummary(),enabled:true,configured:true,source:'environment',baseUrl:settings.baseUrl,modelName:settings.modelName,hasSecret:true};
  // Never return an invalid raw environment URL: it may contain embedded credentials.
  if(environment.MODEL_BASE_URL||environment.MODEL_NAME||environment.MODEL_API_KEY)return {...emptySummary(),source:'environment',hasSecret:!!environment.MODEL_API_KEY?.trim()};
  return emptySummary();
}
function accountSummary(row:ConnectionRow):ConnectionSummary {
  return {kind:'model',enabled:row.enabled===1,configured:!!(row.base_url&&row.model_name&&row.secret_ciphertext),source:'account',baseUrl:row.base_url,modelName:row.model_name,hasSecret:!!row.secret_ciphertext,version:row.version,updatedAt:row.updated_at};
}
/** The injected binding is also used by integration tests against real SQLite. */
export function createConnectionStore(environment:ConnectionEnvironment) {
  const ready=()=>!!environment.DB&&encryptionReady(environment.CONFIG_ENCRYPTION_KEY);
  const db=():D1Database=>{if(!ready())throw new DomainError('API 配置加密存储尚未启用，请联系管理员',503);return environment.DB!;};
  async function readRow(userId:string):Promise<ConnectionRow|null> {
    assertUser(userId);
    if(!environment.DB)return null;
    try {return await environment.DB.prepare('SELECT user_id, kind, enabled, base_url, model_name, secret_ciphertext, version, updated_at FROM workbench_api_connections WHERE user_id = ? AND kind = ?').bind(userId,'model').first<ConnectionRow>();}
    catch {throw new DomainError('API 配置存储暂时不可用，请稍后重试',503);}
  }
  async function snapshot(userId:string,siteOrigin='https://production.invalid'):Promise<ConnectionsSnapshot> {
    const row=await readRow(userId);
    return {model:row?accountSummary(row):fallbackSummary(environment,siteOrigin),storageReady:ready()};
  }
  async function effectiveModel(userId:string,siteOrigin='https://production.invalid'):Promise<EffectiveModel|null> {
    const row=await readRow(userId);
    if(row) {
      if(row.enabled!==1)return null;
      const url=modelEndpoint(row.base_url,siteOrigin);
      const key=await decryptConnectionSecret(row.secret_ciphertext,environment.CONFIG_ENCRYPTION_KEY??'',userId,'model');
      return {key,url,name:row.model_name};
    }
    const fallback=environmentSettings(environment,siteOrigin);
    return fallback?{key:fallback.secret,url:modelEndpoint(fallback.baseUrl,siteOrigin),name:fallback.modelName}:null;
  }
  async function execute(userId:string,value:unknown,siteOrigin='https://production.invalid',request?:ConnectionFetch):Promise<ConnectionActionResult> {
    assertUser(userId);const command=parseConnectionCommand(value);const database=db();
    const row=await readRow(userId);
    if(command.version!==(row?.version??0))throw conflict();
    if(command.action==='remove') {
      if(row) {
        const result=await database.prepare('DELETE FROM workbench_api_connections WHERE user_id = ? AND kind = ? AND version = ?').bind(userId,'model',command.version).run();
        if(result.meta.changes!==1)throw conflict();
      }
      return {connection:(await snapshot(userId,siteOrigin)).model,message:'已移除当前账号的 API 配置'};
    }
    const fallback=environmentSettings(environment,siteOrigin);
    const previousBase=row?.base_url??fallback?.baseUrl;
    const baseUrl=normalizeModelBaseUrl(command.baseUrl??previousBase??'',siteOrigin);
    const modelName=command.modelName??row?.model_name??fallback?.modelName;
    if(!modelName)throw new DomainError('请填写模型名称');
    if(!command.secret&&previousBase&&new URL(baseUrl).origin!==new URL(previousBase).origin)throw new DomainError('API 域名已更改，请重新填写此服务的密钥');
    const secret=command.secret??(row?await decryptConnectionSecret(row.secret_ciphertext,environment.CONFIG_ENCRYPTION_KEY!,userId,'model'):fallback?.secret);
    if(!secret)throw new DomainError('请填写 API 密钥');
    if(command.action==='test')return {test:await testModelConnection({key:secret,url:modelEndpoint(baseUrl,siteOrigin),name:modelName},request),message:'模型 API 连接测试通过'};
    const ciphertext=await encryptConnectionSecret(secret,environment.CONFIG_ENCRYPTION_KEY!,userId,'model');
    const enabled=command.enabled??(row?row.enabled===1:true);
    // Random opaque revisions prevent an old request matching a removed-and-recreated row.
    const version=crypto.getRandomValues(new Uint32Array(1))[0]+Date.now()*1024;
    const updatedAt=new Date().toISOString();
    const result=row
      ?await database.prepare('UPDATE workbench_api_connections SET enabled = ?, base_url = ?, model_name = ?, secret_ciphertext = ?, version = ?, updated_at = ? WHERE user_id = ? AND kind = ? AND version = ?').bind(enabled?1:0,baseUrl,modelName,ciphertext,version,updatedAt,userId,'model',command.version).run()
      :await database.prepare('INSERT INTO workbench_api_connections (user_id, kind, enabled, base_url, model_name, secret_ciphertext, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, kind) DO NOTHING').bind(userId,'model',enabled?1:0,baseUrl,modelName,ciphertext,version,updatedAt).run();
    if(result.meta.changes!==1)throw conflict();
    return {connection:accountSummary({user_id:userId,kind:'model',enabled:enabled?1:0,base_url:baseUrl,model_name:modelName,secret_ciphertext:ciphertext,version,updated_at:updatedAt}),message:enabled?'API 配置已保存，后续生成将使用当前账号配置':'API 配置已保存并停用'};
  }
  return {snapshot,effectiveModel,execute};
}
async function runtimeStore() {const {env}=await import('cloudflare:workers');return createConnectionStore(env as ConnectionEnvironment);}
export async function readConnections(userId:string,siteOrigin?:string):Promise<ConnectionsSnapshot> {return (await runtimeStore()).snapshot(userId,siteOrigin);}
export async function writeConnection(userId:string,value:unknown,siteOrigin?:string):Promise<ConnectionActionResult> {return (await runtimeStore()).execute(userId,value,siteOrigin);}
export async function readEffectiveModel(userId:string,siteOrigin='https://production.invalid'):Promise<EffectiveModel|null> {return (await runtimeStore()).effectiveModel(userId,siteOrigin);}
