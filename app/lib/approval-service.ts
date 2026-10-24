import { DomainError } from './domain.ts';
import { approvalInputHash, approvalSummary, buildApproval, isApprovalStale, transitionApproval, validateApprovalTemplate } from './approval-domain.ts';
import { createApprovalStore } from './approval-store.ts';
import type { ApprovalActor, ApprovalRequest, ApprovalTemplate, ApprovalSummary, ApprovalAction } from './approval-types.ts';
import type { ApprovalListOptions, ApprovalRecord } from './approval-store.ts';
import type { Role, WorkbenchState } from './types.ts';

function identity(actor:ApprovalActor):ApprovalActor {
  const id=actor.id?.trim(),email=actor.email?.trim().toLowerCase(),name=actor.name?.trim();
  if(!id||id.length>256||!email||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!name||name.length>200||/[\u0000-\u001f\u007f]/.test(id+email+name))throw new DomainError('请先使用平台账号登录',401);
  return {id,email,name};
}
/** The private Sites gateway overwrites these headers; experience-role cookies grant no authority. */
export function readApprovalIdentity(request:Request):ApprovalActor {
  let name=request.headers.get('oai-authenticated-user-full-name')??'';
  try{name=decodeURIComponent(name);}catch{throw new DomainError('登录姓名无效，请重新登录',401);}
  const email=request.headers.get('oai-authenticated-user-email')??'';
  return identity({id:request.headers.get('oai-authenticated-user-id')??'',email,name:name||email});
}
export function assertApprovalOrigin(request:Request):void {
  const origin=request.headers.get('origin'),site=request.headers.get('sec-fetch-site');
  if((origin&&origin!==new URL(request.url).origin)||(site&&site!=='same-origin'&&site!=='none'))throw new DomainError('只允许从当前站点发起操作',403);
}
export interface ApprovalMutationResult {request?:ApprovalRequest;template?:ApprovalTemplate;message:string;}
interface Source {workspace:WorkbenchState;stateJson:string;}
function record(request:ApprovalRequest):ApprovalRecord {
  return {id:request.id,ownerId:request.ownerId,projectId:request.projectId,kind:request.kind,status:request.status,version:request.version,currentApproverEmail:request.status==='pending'?request.steps[request.currentStep]?.approverEmail??null:null,activeKey:request.status==='pending'?request.activeKey:null,inputHash:request.inputHash,createdAt:request.createdAt,updatedAt:request.updatedAt,request};
}
function remember(cache:Map<string,Source|null>|undefined,ownerId:string,saved:Source|null):void{if(!cache)return;if(cache.has(ownerId))cache.delete(ownerId);while(cache.size>=4)cache.delete(cache.keys().next().value!);cache.set(ownerId,saved);}
const notFound=()=>new DomainError('申请不存在或无权访问',404);
function requestId(payload:Record<string,unknown>):string {if(typeof payload.id!=='string'||payload.id.length>128||!payload.id)throw new DomainError('请检查申请标识');return payload.id;}
function expectedVersion(payload:Record<string,unknown>):number{if(!Number.isSafeInteger(payload.version)||Number(payload.version)<0)throw new DomainError('审批已更新，请刷新后重试',409);return Number(payload.version);}
function fields(payload:Record<string,unknown>,allowed:string[]):void{if(Object.keys(payload).some(key=>!allowed.includes(key)))throw new DomainError('审批参数包含不允许修改的字段');}
export function createApprovalService(db:D1Database,clock:()=>string=()=>new Date().toISOString()){
  const store=createApprovalStore(db);
  async function source(ownerId:string):Promise<Source|null>{
    const row=await db.prepare('SELECT state_json FROM workbench_workspaces WHERE user_id = ?').bind(ownerId).first<{state_json:string}>();
    if(!row)return null;
    const workspace=JSON.parse(row.state_json) as WorkbenchState;
    if(!Array.isArray(workspace.deals))throw new DomainError('项目数据暂时无法读取，请稍后重试',503);
    return {workspace,stateJson:row.state_json};
  }
  async function fresh(stored:ApprovalRecord,cache?:Map<string,Source|null>):Promise<ApprovalRecord>{
    if(stored.kind!=='contract'||!['pending','approved'].includes(stored.status))return stored;
    let saved:Source|null;if(cache?.has(stored.ownerId))saved=cache.get(stored.ownerId)!;else{saved=await source(stored.ownerId);remember(cache,stored.ownerId,saved);}
    if(saved&&!await isApprovalStale(stored.request,saved.workspace))return stored;
    const at=clock();const request:ApprovalRequest={...stored.request,status:'superseded',version:stored.version+1,updatedAt:at,history:[...stored.request.history,{id:crypto.randomUUID(),action:'supersede',actor:{id:'system:source-validation',email:'',name:'系统校验'},at,note:'关联合同内容已变更或来源已移除，本次审批已失效；提交快照和此前人工意见保留，请核对最新合同后重新提交。'}]};const next=record(request);
    try{await store.update(next,stored.version,stored.status);return next;}catch(error){if(!(error instanceof DomainError)||error.status!==409)throw error;const latest=await store.get(stored.id);if(!latest)throw notFound();if(latest.status==='superseded')return latest;throw error;}
  }
  return {
    async list(rawActor:ApprovalActor,options:ApprovalListOptions={}):Promise<{identity:ApprovalActor;requests:ApprovalSummary[];templates:ApprovalTemplate[];pendingCount:number;nextCursor?:string}>{
      const actor=identity(rawActor);if(options.status&&!['pending','approved','rejected','returned','withdrawn','superseded'].includes(options.status))throw new DomainError('审批状态筛选无效');if(options.q&&options.q.length>200||options.projectId&&options.projectId.length>128)throw new DomainError('筛选内容过长');
      const page=await store.list(actor,options),cache=new Map<string,Source|null>();const requests:ApprovalSummary[]=[];
      for(const stored of page.records){const current=await fresh(stored,cache);if(options.status&&current.status!==options.status||options.scope==='inbox'&&current.status!=='pending')continue;requests.push(approvalSummary(current.request,actor));}
      return {identity:actor,requests,templates:await store.templates(actor.id),pendingCount:await store.pendingCount(actor),...(page.nextCursor?{nextCursor:page.nextCursor}:{})};
    },
    async detail(rawActor:ApprovalActor,id:string):Promise<{identity:ApprovalActor;request:ApprovalRequest}>{const actor=identity(rawActor);if(!id||id.length>128)throw notFound();const stored=await store.visible(id,actor);if(!stored)throw notFound();return {identity:actor,request:(await fresh(stored)).request};},
    async mutate(rawActor:ApprovalActor,role:Role,action:string,payload:Record<string,unknown>):Promise<ApprovalMutationResult>{
      const actor=identity(rawActor);const now=clock();
      if(action==='submit'){
        const id=requestId(payload),inputHash=await approvalInputHash(payload),existing=await store.get(id);
        if(existing){if(existing.ownerId!==actor.id||existing.inputHash!==inputHash)throw new DomainError('申请标识已使用，请重新发起；原申请未修改',409);return {request:(await fresh(existing)).request,message:'申请已提交'};}
        const saved=await source(actor.id);if(!saved)throw new DomainError('请先保存项目后再发起审批',404);
        const workspace=role==='sales'?{...saved.workspace,deals:saved.workspace.deals.filter(deal=>deal.ownerId==='sales-1')}:saved.workspace;
        if(payload.previousRequestId!==undefined){const previous=typeof payload.previousRequestId==='string'?await store.visible(payload.previousRequestId,actor):null;if(!previous||previous.ownerId!==actor.id||previous.projectId!==payload.projectId||previous.kind!==payload.kind)throw notFound();if(!['returned','rejected','withdrawn','superseded'].includes((await fresh(previous)).status))throw new DomainError('原申请仍在审批或已经通过，不能重新提交',409);}
        const request=await buildApproval(payload,workspace,actor,now);
        try{await store.insert(record(request),request.steps.map(step=>step.approverEmail));}catch(error){if(error instanceof DomainError&&error.status===409){const raced=await store.get(id);if(raced?.ownerId===actor.id&&raced.inputHash===inputHash)return {request:(await fresh(raced)).request,message:'申请已提交'};}throw error;}
        return {request,message:'申请已提交，等待首个节点审批'};
      }
      if(action==='template_save'){
        const id=requestId(payload),version=payload.version===undefined?0:expectedVersion(payload);const templates=await store.templates(actor.id);const previous=templates.find(item=>item.id===id);
        if(!previous&&version!==0)throw new DomainError('流程已变化或无权访问，请刷新后重试',409);if(!previous&&templates.length>=100)throw new DomainError('最多保存100个流程，请先删除不再使用的流程',409);
        const template=validateApprovalTemplate(payload,actor,now,previous);await store.saveTemplate(template,version);return {template,message:'审批流程已保存'};
      }
      if(action==='template_delete'){fields(payload,['id','version']);await store.deleteTemplate(requestId(payload),actor.id,expectedVersion(payload));return {message:'审批流程已删除'};}
      if(action!=='decide'&&action!=='withdraw')throw new DomainError('不支持的审批操作');
      fields(payload,action==='decide'?['id','version','decision','note','comment']:['id','version','note']);const id=requestId(payload);const stored=await store.visible(id,actor);if(!stored)throw notFound();const current=await fresh(stored);let decision:ApprovalAction='withdraw';
      if(action==='decide'){if(!['approve','reject','return'].includes(String(payload.decision)))throw new DomainError('请选择有效的审批决定');decision=payload.decision as ApprovalAction;}
      const next=transitionApproval(current.request,decision,{version:payload.version,...(payload.note!==undefined||payload.comment!==undefined?{note:payload.note??payload.comment}:{})},actor,now);
      // CAS also checks the exact canonical source row, preventing a simultaneous source edit from being approved.
      const saved=current.kind==='contract'?await source(current.ownerId):null;
      if(current.kind==='contract'&&(!saved||await isApprovalStale(current.request,saved.workspace))){await fresh(current);throw new DomainError('合同内容已变化，请重新提交审批',409);}
      await store.update(record(next),current.version,current.status,saved?{ownerId:current.ownerId,stateJson:saved.stateJson}:undefined);
      return {request:next,message:decision==='withdraw'?'申请已撤回':decision==='approve'?(next.status==='approved'?'所有节点审批已通过':'已通过，等待下一节点审批'):decision==='reject'?'申请已驳回':'申请已退回修改'};
    }
  };
}
