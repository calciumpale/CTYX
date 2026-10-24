import { DomainError } from './domain.ts';
import { decryptConnectionSecret,encryptConnectionSecret,encryptionReady,normalizeModelBaseUrl } from './connection-config.ts';
import { requestEmbeddings, type EmbeddingConnection } from './embedding-client.ts';
export interface EmbeddingSummary{enabled:boolean;configured:boolean;baseUrl:string;modelName:string;version:number;storageReady:boolean;message?:string;}
interface Environment{DB?:D1Database;CONFIG_ENCRYPTION_KEY?:string;}
interface Row{enabled:number;base_url:string;model_name:string;secret_ciphertext:string;version:number;}
export function createEmbeddingStore(env:Environment){
  const ready=()=>!!env.DB&&encryptionReady(env.CONFIG_ENCRYPTION_KEY);
  async function row(userId:string){if(!userId)throw new DomainError('请先登录',401);return env.DB?await env.DB.prepare('SELECT enabled,base_url,model_name,secret_ciphertext,version FROM workbench_api_connections WHERE user_id=? AND kind=?').bind(userId,'embedding').first<Row>():null;}
  async function snapshot(userId:string):Promise<EmbeddingSummary>{const r=await row(userId);return {enabled:r?.enabled===1,configured:!!r?.secret_ciphertext,baseUrl:r?.base_url??'',modelName:r?.model_name??'',version:r?.version??0,storageReady:ready()};}
  async function effective(userId:string):Promise<EmbeddingConnection|null>{const r=await row(userId);if(!r||r.enabled!==1)return null;return {key:await decryptConnectionSecret(r.secret_ciphertext,env.CONFIG_ENCRYPTION_KEY??'',userId,'embedding'),url:r.base_url,name:r.model_name};}
  async function execute(userId:string,input:Record<string,unknown>,origin:string):Promise<EmbeddingSummary>{
    if(!ready())throw new DomainError('API 配置加密存储未启用',503);if(!['save','remove','test'].includes(String(input.action))||!Number.isSafeInteger(input.version))throw new DomainError('配置操作或版本无效');
    const r=await row(userId);if(input.version!==(r?.version??0))throw new DomainError('配置已更新，请重新加载',409);
    if(input.action==='test'){const model=await effective(userId);if(!model)throw new DomainError('请先保存并启用配置');const result=await requestEmbeddings(model,['销售客户需求沟通'],{origin});return {...await snapshot(userId),message:`向量连接通过，维度 ${result.vectors[0].length}`};}
    const db=env.DB!;
    if(input.action==='remove'){if(r){const out=await db.prepare('DELETE FROM workbench_api_connections WHERE user_id=? AND kind=? AND version=?').bind(userId,'embedding',r.version).run();if(out.meta.changes!==1)throw new DomainError('配置已更新',409);}return {...await snapshot(userId),message:'已移除向量服务配置，已发布话术仍可显式选用'};}
    if(typeof input.baseUrl!=='string'||typeof input.modelName!=='string'||!input.modelName.trim()||input.modelName.length>160||/[\u0000-\u001f\u007f]/.test(input.modelName)||typeof input.enabled!=='boolean')throw new DomainError('请检查接口地址、模型名称及启用状态');
    const url=normalizeModelBaseUrl(input.baseUrl,origin);const name=input.modelName.trim();let key:string;
    if(input.secret!==undefined&&input.secret!==''){if(typeof input.secret!=='string'||input.secret.length>8192||/[\u0000-\u0020\u007f]/.test(input.secret))throw new DomainError('API Key 格式无效');key=input.secret;}else{if(!r)throw new DomainError('请填写 API Key');if(url!==r.base_url)throw new DomainError('更换接口地址时请重新填写对应密钥');key=await decryptConnectionSecret(r.secret_ciphertext,env.CONFIG_ENCRYPTION_KEY??'',userId,'embedding');}
    const cipher=await encryptConnectionSecret(key,env.CONFIG_ENCRYPTION_KEY!,userId,'embedding');const version=Date.now()*1024+crypto.getRandomValues(new Uint16Array(1))[0];const now=new Date().toISOString();
    const out=r?await db.prepare('UPDATE workbench_api_connections SET enabled=?,base_url=?,model_name=?,secret_ciphertext=?,version=?,updated_at=? WHERE user_id=? AND kind=? AND version=?').bind(input.enabled?1:0,url,name,cipher,version,now,userId,'embedding',r.version).run():await db.prepare('INSERT INTO workbench_api_connections (user_id,kind,enabled,base_url,model_name,secret_ciphertext,version,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(user_id,kind) DO NOTHING').bind(userId,'embedding',input.enabled?1:0,url,name,cipher,version,now).run();
    if(out.meta.changes!==1)throw new DomainError('配置已更新，请重新加载',409);return {...await snapshot(userId),message:'配置已保存；更换模型后请重建话术索引'};
  }return {snapshot,effective,execute};
}
async function runtime(){const {env}=await import('cloudflare:workers');return createEmbeddingStore(env as Environment);}
export async function embeddingSnapshot(userId:string){return (await runtime()).snapshot(userId);}
export async function effectiveEmbedding(userId:string){return (await runtime()).effective(userId);}
export async function executeEmbedding(userId:string,input:Record<string,unknown>,origin:string){return (await runtime()).execute(userId,input,origin);}
