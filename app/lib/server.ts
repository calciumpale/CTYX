import { env } from 'cloudflare:workers';
import { assertRevision, demoGenerate, DomainError, executeAction, projectState } from './domain.ts';
import type { GenerationInput, GenerationOutput } from './domain.ts';
import { createSeed } from './seed.ts';
import { readEffectiveModel } from './connection-store.ts';
import { requestModelText } from './model-client.ts';
import { buildModelMessages } from './model-messages.ts';
import { buildTrainingMessages, demoTrainingGenerate } from './training-dialogue.ts';
import type { TrainingGenerationInput } from './training-dialogue.ts';
import type { ApiResult, Role, WorkbenchState } from './types.ts';

export const ROLE_COOKIE='ctai_experience_role';
const environment=()=>env as Cloudflare.Env;
function database():D1Database {
  const db=environment().DB;
  if(!db)throw new DomainError('体验空间数据库尚未连接，请配置D1绑定后再试',503);
  return db;
}
export function readRole(request:Request):Role {
  const entry=(request.headers.get('cookie')??'').split(';').map(item=>item.trim()).find(item=>item.startsWith(`${ROLE_COOKIE}=`));
  return entry?.slice(ROLE_COOKIE.length+1)==='sales'?'sales':'manager';
}
export function roleCookie(role:Role,request:Request):string {
  return `${ROLE_COOKIE}=${role}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${new URL(request.url).protocol==='https:'?'; Secure':''}`;
}
/** Trusted identity headers are injected/overwritten by the private Sites gateway. */
export function requireUserId(request:Request):string {
  const id=request.headers.get('oai-authenticated-user-id');
  if(!id||!request.headers.get('oai-authenticated-user-email'))throw new DomainError('请先使用平台账号登录',401);
  if(id.length>512)throw new DomainError('登录身份无效，请重新登录',401);
  return id;
}
async function applyModelStatus(state:WorkbenchState,userId:string,siteOrigin:string):Promise<void> {
  const model=await readEffectiveModel(userId,siteOrigin);
  state.model={connected:!!model,name:model?`${model.name} · 已配置，生成时验证`:'规则演示 · 未连接外部模型'};
}
export async function loadWorkspace(userId:string,siteOrigin='https://production.invalid'):Promise<WorkbenchState> {
  const db=database();
  let row=await db.prepare('SELECT state_json, revision FROM workbench_workspaces WHERE user_id = ?').bind(userId).first<{state_json:string;revision:number}>();
  if(!row) {
    const now=new Date().toISOString();const seed=createSeed(now);
    await db.prepare('INSERT INTO workbench_workspaces (user_id, state_json, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO NOTHING').bind(userId,JSON.stringify(seed),seed.revision,now,now).run();
    row=await db.prepare('SELECT state_json, revision FROM workbench_workspaces WHERE user_id = ?').bind(userId).first<{state_json:string;revision:number}>();
  }
  if(!row)throw new DomainError('体验空间初始化失败，请稍后重试',503);
  const state=JSON.parse(row.state_json) as WorkbenchState;
  state.revision=row.revision;await applyModelStatus(state,userId,siteOrigin);return state;
}
export async function saveWorkspace(userId:string,expectedRevision:number,state:WorkbenchState):Promise<void> {
  const result=await database().prepare('UPDATE workbench_workspaces SET state_json = ?, revision = ?, updated_at = ? WHERE user_id = ? AND revision = ?').bind(JSON.stringify(state),state.revision,new Date().toISOString(),userId,expectedRevision).run();
  if(result.meta.changes!==1)throw new DomainError('工作空间已被另一请求更新，请刷新后重试；本次操作未保存',409);
}
async function generate(input:GenerationInput,model:{key:string;url:string;name:string}|null):Promise<GenerationOutput> {
  if(!model)return demoGenerate(input);
  return {answer:await requestModelText(model,buildModelMessages(input)),mode:'live'};
}
async function generateTraining(input:TrainingGenerationInput,model:{key:string;url:string;name:string}|null):Promise<GenerationOutput> {
  if(!model)return demoTrainingGenerate(input);
  return {answer:await requestModelText(model,buildTrainingMessages(input)),mode:'live'};
}
export async function readWorkbench(userId:string,role:Role,siteOrigin='https://production.invalid'):Promise<WorkbenchState> {
  return projectState(await loadWorkspace(userId,siteOrigin),role);
}
export async function mutateWorkbench(userId:string,role:Role,action:string,payload:Record<string,unknown>,revision:unknown,siteOrigin='https://production.invalid'):Promise<ApiResult> {
  const state=await loadWorkspace(userId,siteOrigin);assertRevision(state,revision);
  const model=await readEffectiveModel(userId,siteOrigin);
  const result=await executeAction(state,role,action,payload,{generate:input=>generate(input,model),trainingGenerate:input=>generateTraining(input,model)});
  await saveWorkspace(userId,state.revision,result.state);
  return {...result,state:projectState(result.state,role)};
}
