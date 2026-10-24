import { DomainError } from './domain.ts';
import { decryptConnectionSecret, encryptConnectionSecret, encryptionReady } from './connection-config.ts';

export const QCC_ENDPOINT='https://api.qichacha.com/ECIV4/GetBasicDetailsByName';
export interface CompanyConnectionSummary {enabled:boolean;configured:boolean;hasCredentials:boolean;endpoint:string;version:number;updatedAt:string|null;}
export interface CompanyConnectionSnapshot {connection:CompanyConnectionSummary;storageReady:boolean;message?:string;}
interface Environment {DB?:D1Database;CONFIG_ENCRYPTION_KEY?:string;}
interface Row {enabled:number;base_url:string;secret_ciphertext:string;version:number;updated_at:string;}
interface Credentials {appKey:string;secretKey:string;}
const empty=():CompanyConnectionSummary=>({enabled:false,configured:false,hasCredentials:false,endpoint:QCC_ENDPOINT,version:0,updatedAt:null});
const summary=(row:Row|null):CompanyConnectionSummary=>row?{enabled:row.enabled===1,configured:!!row.secret_ciphertext,hasCredentials:!!row.secret_ciphertext,endpoint:QCC_ENDPOINT,version:row.version,updatedAt:row.updated_at}:empty();
const conflict=()=>new DomainError('企查查配置已更新，请重新加载后再保存',409);
function identity(userId:string) {if(!userId||typeof userId!=='string'||userId.length>512)throw new DomainError('请先登录工作台',401);}
function field(input:Record<string,unknown>,name:string):string|undefined {
  const value=input[name];if(value===undefined||value==='')return;
  if(typeof value!=='string'||value.length>1024||/[\u0000-\u0020\u007f]/u.test(value))throw new DomainError('企查查凭证格式不正确，请检查是否包含空格');
  return value;
}
export function createCompanyConnectionStore(environment:Environment) {
  const ready=()=>!!environment.DB&&encryptionReady(environment.CONFIG_ENCRYPTION_KEY);
  async function row(userId:string):Promise<Row|null> {
    identity(userId);if(!environment.DB)return null;
    try{return await environment.DB.prepare('SELECT enabled, base_url, secret_ciphertext, version, updated_at FROM workbench_api_connections WHERE user_id = ? AND kind = ?').bind(userId,'qcc').first<Row>();}
    catch{throw new DomainError('企查查配置暂时无法读取，请稍后重试',503);}
  }
  async function credentials(userId:string,stored:Row):Promise<Credentials> {
    const raw=await decryptConnectionSecret(stored.secret_ciphertext,environment.CONFIG_ENCRYPTION_KEY??'',userId,'qcc');
    try{const parsed=JSON.parse(raw) as Credentials;if(!parsed.appKey||!parsed.secretKey)throw new Error();return {appKey:parsed.appKey,secretKey:parsed.secretKey};}
    catch{throw new DomainError('企查查凭证无法读取，请重新填写并保存',503);}
  }
  async function snapshot(userId:string):Promise<CompanyConnectionSnapshot> {return {connection:summary(await row(userId)),storageReady:ready()};}
  async function effective(userId:string):Promise<(Credentials & {endpoint:string})|null> {
    const stored=await row(userId);if(!stored||stored.enabled!==1)return null;
    return {...await credentials(userId,stored),endpoint:QCC_ENDPOINT};
  }
  async function execute(userId:string,value:unknown):Promise<CompanyConnectionSnapshot> {
    identity(userId);
    if(!ready())throw new DomainError('API 配置加密存储尚未启用，请联系管理员',503);
    if(!value||typeof value!=='object'||Array.isArray(value))throw new DomainError('企查查配置格式不正确');
    const input=value as Record<string,unknown>;
    if(!['save','remove'].includes(String(input.action))||!Number.isSafeInteger(input.version)||(input.version as number)<0)throw new DomainError('企查查配置操作或版本无效');
    if(input.endpoint!==undefined&&input.endpoint!==QCC_ENDPOINT)throw new DomainError('仅支持企查查官方企业工商信息接口');
    if(input.enabled!==undefined&&typeof input.enabled!=='boolean')throw new DomainError('启用状态格式不正确');
    const stored=await row(userId);if(input.version!==(stored?.version??0))throw conflict();
    const db=environment.DB!;
    if(input.action==='remove') {
      if(stored){const result=await db.prepare('DELETE FROM workbench_api_connections WHERE user_id = ? AND kind = ? AND version = ?').bind(userId,'qcc',stored.version).run();if(result.meta.changes!==1)throw conflict();}
      return {...await snapshot(userId),message:'已移除企查查配置，后续使用公开网络检索'};
    }
    const appKey=field(input,'appKey');const secretKey=field(input,'secretKey');
    const previous=stored&&(!appKey||!secretKey)?await credentials(userId,stored):null;
    if(appKey&&previous&&appKey!==previous.appKey&&!secretKey)throw new DomainError('AppKey 已更改，请填写对应的 SecretKey');
    const next={appKey:appKey??previous?.appKey,secretKey:secretKey??previous?.secretKey};
    if(!next.appKey||!next.secretKey)throw new DomainError('请填写企查查 AppKey 和 SecretKey');
    const ciphertext=await encryptConnectionSecret(JSON.stringify(next),environment.CONFIG_ENCRYPTION_KEY!,userId,'qcc');
    const enabled=input.enabled??true;const version=Date.now()*1024+crypto.getRandomValues(new Uint32Array(1))[0];const updatedAt=new Date().toISOString();
    const result=stored
      ?await db.prepare('UPDATE workbench_api_connections SET enabled = ?, base_url = ?, model_name = ?, secret_ciphertext = ?, version = ?, updated_at = ? WHERE user_id = ? AND kind = ? AND version = ?').bind(enabled?1:0,QCC_ENDPOINT,'',ciphertext,version,updatedAt,userId,'qcc',stored.version).run()
      :await db.prepare('INSERT INTO workbench_api_connections (user_id, kind, enabled, base_url, model_name, secret_ciphertext, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, kind) DO NOTHING').bind(userId,'qcc',enabled?1:0,QCC_ENDPOINT,'',ciphertext,version,updatedAt).run();
    if(result.meta.changes!==1)throw conflict();
    return {connection:summary({enabled:enabled?1:0,base_url:QCC_ENDPOINT,secret_ciphertext:ciphertext,version,updated_at:updatedAt}),storageReady:true,message:enabled?'企查查配置已保存，将优先查询企业工商信息':'企查查配置已停用，后续使用公开网络检索'};
  }
  return {snapshot,effective,execute};
}
async function runtimeStore(){const {env}=await import('cloudflare:workers');return createCompanyConnectionStore(env as Environment);}
export async function readCompanyConnection(userId:string){return (await runtimeStore()).snapshot(userId);}
export async function writeCompanyConnection(userId:string,value:unknown){return (await runtimeStore()).execute(userId,value);}
export async function readEffectiveCompanyConnection(userId:string){return (await runtimeStore()).effective(userId);}
