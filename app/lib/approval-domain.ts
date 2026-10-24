import { DomainError } from './domain.ts';
import type { ContractDocument } from './contract-types.ts';
import type { WorkbenchState } from './types.ts';
import type { ApprovalAction, ApprovalActor, ApprovalKind, ApprovalRequest, ApprovalRouteStep, ApprovalSummary, ApprovalTemplate, BusinessCondition } from './approval-types.ts';

function fail(message:string,status=400):never { throw new DomainError(message,status); }
function object(value:unknown,label:string):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))fail(`请检查${label}`);
  return value as Record<string,unknown>;
}
function only(payload:Record<string,unknown>,keys:readonly string[]) {
  if(Object.keys(payload).some(key=>!keys.includes(key)))fail('审批参数包含不允许修改的字段');
}
function text(value:unknown,label:string,max:number,required=true):string {
  if(typeof value!=='string'||value.length>max||/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)||required&&!value.trim())fail(`请检查${label}（最多${max.toLocaleString()}字）`);
  return value.trim();
}
function key(value:unknown,label:string):string {
  const result=text(value,label,128);
  if(!/^[A-Za-z0-9_-]+$/.test(result))fail(`请检查${label}`);
  return result;
}
function uuid(value:unknown,label:string):string {
  const result=text(value,label,36);
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result))fail(`请检查${label}`);
  return result.toLowerCase();
}
function email(value:unknown):string {
  const result=text(value,'审批人登录邮箱',254).toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result))fail('请填写有效的审批人登录邮箱');
  return result;
}
function actorIdentity(actor:ApprovalActor):ApprovalActor {
  return {id:text(actor.id,'用户身份',256),email:email(actor.email),name:text(actor.name,'用户姓名',200)};
}
function kind(value:unknown):ApprovalKind {
  if(value!=='business'&&value!=='contract')fail('请选择商务条件或合同审批');
  return value;
}
function route(value:unknown):ApprovalRouteStep[] {
  if(!Array.isArray(value)||value.length<1||value.length>8)fail('审批流程需包含1至8个节点');
  const ids=new Set<string>();
  return value.map(item=>{
    const data=object(item,'审批节点');only(data,['id','label','role','approverName','approverEmail']);
    const id=key(data.id,'审批节点标识');
    if(ids.has(id))fail('审批节点标识不能重复');ids.add(id);
    if(!['manager','finance','legal','executive','other'].includes(String(data.role)))fail('请选择有效的审批职责');
    return {id,label:text(data.label,'节点名称',100),role:data.role as ApprovalRouteStep['role'],approverName:text(data.approverName,'审批人姓名',100),approverEmail:email(data.approverEmail)};
  });
}
function conditions(value:unknown):BusinessCondition[] {
  if(!Array.isArray(value)||value.length<1||value.length>20)fail('请填写1至20条商务条件');
  const ids=new Set<string>();
  return value.map(item=>{
    const data=object(item,'商务条件');only(data,['id','category','subject','baseline','proposed','reason']);
    const id=key(data.id,'条件标识');if(ids.has(id))fail('商务条件标识不能重复');ids.add(id);
    return {id,category:text(data.category,'条件类别',80),subject:text(data.subject,'条件事项',200),baseline:text(data.baseline,'现有条件',2000),proposed:text(data.proposed,'申请条件',2000),reason:text(data.reason,'条件理由',2000)};
  });
}
function deadline(value:unknown):string|undefined {
  if(value===undefined||value==='')return undefined;
  const result=text(value,'截止时间',40);
  const date=result.slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(result)||Number.isNaN(Date.parse(result))||new Date(date).toISOString().slice(0,10)!==date)fail('请填写有效的截止时间');
  return result;
}
function version(current:number,value:unknown) {
  if(!Number.isSafeInteger(value)||value!==current)fail('审批已更新，请刷新后重试',409);
}
function sorted(value:unknown):unknown {
  if(Array.isArray(value))return value.map(sorted);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted((value as Record<string,unknown>)[key])]));
  return value;
}
async function hash(value:unknown):Promise<string> {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(sorted(value))));
  return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
}
/** Only contractual inputs invalidate approval; review metadata and handling status do not. */
export function contractApprovalHash(contract:ContractDocument):Promise<string> {
  return hash({dealId:contract.dealId,title:contract.title,text:contract.text,contractType:contract.contractType,ourParty:contract.ourParty,focus:contract.focus});
}
/** Compare retries before looking up a potentially changed source. IDs only identify the retry. */
export function approvalInputHash(payload:Record<string,unknown>):Promise<string> {
  return hash(Object.fromEntries(Object.entries(payload).filter(([field])=>field!=='id')));
}
export async function buildApproval(payload:Record<string,unknown>,workspace:WorkbenchState,actor:ApprovalActor,now:string):Promise<ApprovalRequest> {
  only(payload,['id','projectId','kind','title','reason','deadline','steps','conditions','contractId','contractVersion','previousRequestId']);
  const applicant=actorIdentity(actor);const id=uuid(payload.id,'申请标识');const projectId=key(payload.projectId,'项目标识');const requestKind=kind(payload.kind);
  const project=workspace.deals.find(deal=>deal.id===projectId);if(!project)fail('项目不存在或无权访问',404);
  const title=text(payload.title,'申请标题',200),reason=text(payload.reason,'申请说明',5000),due=deadline(payload.deadline),steps=route(payload.steps);
  if(steps.some(step=>step.approverEmail===applicant.email))fail('申请人不能审批自己的申请');
  const previousRequestId=payload.previousRequestId===undefined?undefined:uuid(payload.previousRequestId,'原申请标识');
  if(previousRequestId===id)fail('新申请不能关联自身');
  const snapshot:ApprovalRequest['snapshot']={project:{id:project.id,name:project.projectName||project.name,company:project.name,owner:project.owner,amount:project.amount,stage:project.stage}};
  let sourceHash:string|undefined;
  if(requestKind==='business') {
    if(payload.contractId!==undefined||payload.contractVersion!==undefined)fail('商务条件申请不能携带合同字段');
    snapshot.conditions=conditions(payload.conditions);
  } else {
    if(payload.conditions!==undefined)fail('合同申请不能携带商务条件');
    const contractId=key(payload.contractId,'已保存合同标识');const document=workspace.contracts?.find(contract=>contract.id===contractId&&contract.dealId===projectId);
    if(!document)fail('合同不存在或不属于当前项目',404);
    version(document.version,payload.contractVersion);snapshot.contract=structuredClone(document);sourceHash=await contractApprovalHash(document);
  }
  const contentHash=await hash({projectId,kind:requestKind,title,reason,deadline:due,steps:steps.map(step=>({label:step.label,role:step.role,approverName:step.approverName,approverEmail:step.approverEmail})),conditions:snapshot.conditions?.map(condition=>({category:condition.category,subject:condition.subject,baseline:condition.baseline,proposed:condition.proposed,reason:condition.reason})),sourceHash});
  const activeKey=requestKind==='contract'
    ?await hash({ownerId:applicant.id,contractId:snapshot.contract!.id,sourceHash})
    :await hash({ownerId:applicant.id,projectId,kind:requestKind,conditions:snapshot.conditions?.map(condition=>({category:condition.category,subject:condition.subject,baseline:condition.baseline,proposed:condition.proposed,reason:condition.reason}))});
  return {id,ownerId:applicant.id,projectId,kind:requestKind,title,reason,...(due?{deadline:due}:{}),status:'pending',steps:steps.map((step,index)=>({...step,status:index===0?'pending':'waiting'})),currentStep:0,snapshot,...(sourceHash?{sourceHash}:{}),contentHash,inputHash:await approvalInputHash(payload),activeKey,applicant,history:[{id:crypto.randomUUID(),action:'submit',actor:{...applicant},at:now}],version:1,createdAt:now,updatedAt:now,...(previousRequestId?{previousRequestId}:{})};
}
export function transitionApproval(request:ApprovalRequest,action:ApprovalAction,payload:Record<string,unknown>,actor:ApprovalActor,now:string):ApprovalRequest {
  only(payload,['version','note']);version(request.version,payload.version);
  if(!['approve','reject','return','withdraw'].includes(action))fail('不支持的审批操作');
  if(request.status!=='pending')fail('此申请已处理，请刷新后查看',409);
  const identity=actorIdentity(actor);const isApplicant=identity.id===request.applicant.id;
  if(action==='withdraw') {
    if(!isApplicant)fail('只有申请人可以撤回申请',403);
  } else {
    const step=request.steps[request.currentStep];
    if(!step||step.status!=='pending')fail('审批节点状态已变化，请刷新后重试',409);
    const boundIdentity=request.history.find(event=>event.action!=='submit'&&event.actor.email===identity.email)?.actor.id;
    if(isApplicant||identity.email===request.applicant.email||identity.email!==step.approverEmail||(boundIdentity&&boundIdentity!==identity.id))fail('只有当前节点指定的审批人可以操作，申请人不能审批自己',403);
  }
  const note=payload.note===undefined?'':text(payload.note,'审批意见',3000,false);
  if((action==='reject'||action==='return')&&!note)fail('驳回或退回修改时请填写审批意见');
  const result=structuredClone(request);
  if(action==='withdraw')result.status='withdrawn';
  else {
    const step=result.steps[result.currentStep];step.status=action==='approve'?'approved':action==='reject'?'rejected':'returned';step.decidedBy={...identity};step.decidedAt=now;if(note)step.note=note;
    if(action==='approve') {
      if(result.currentStep===result.steps.length-1)result.status='approved';
      else {result.currentStep++;result.steps[result.currentStep].status='pending';}
    } else result.status=action==='reject'?'rejected':'returned';
  }
  result.history.push({id:crypto.randomUUID(),action,actor:{...identity},at:now,...(action!=='withdraw'?{stepId:request.steps[request.currentStep].id,stepIndex:request.currentStep}:{}),...(note?{note}:{})});
  result.version++;result.updatedAt=now;return result;
}
export async function isApprovalStale(request:ApprovalRequest,workspace:WorkbenchState):Promise<boolean> {
  if(request.kind!=='contract')return false;
  const saved=request.snapshot.contract;const source=workspace.contracts?.find(contract=>contract.id===saved?.id&&contract.dealId===request.projectId);
  return !source||!request.sourceHash||request.sourceHash!==await contractApprovalHash(source);
}
export function approvalSummary(request:ApprovalRequest,actor:ApprovalActor):ApprovalSummary {
  const step=request.steps[request.currentStep];const isApplicant=actor.id===request.applicant.id;const currentEmail=actor.email.trim().toLowerCase();
  const boundIdentity=request.history.find(event=>event.action!=='submit'&&event.actor.email===currentEmail)?.actor.id;
  return {id:request.id,ownerId:request.ownerId,projectId:request.projectId,kind:request.kind,title:request.title,reason:request.reason,...(request.deadline?{deadline:request.deadline}:{}),status:request.status,currentStep:request.currentStep,stepCount:request.steps.length,applicant:{...request.applicant},version:request.version,createdAt:request.createdAt,updatedAt:request.updatedAt,...(request.previousRequestId?{previousRequestId:request.previousRequestId}:{}),projectName:request.snapshot.project.name,companyName:request.snapshot.project.company,currentApprover:request.status==='pending'?step?.approverName??'':'',...(request.status==='pending'&&step?{currentApproverEmail:step.approverEmail}:{}),riskCount:request.snapshot.contract?.analysis?.findings.length??0,isApplicant,canDecide:request.status==='pending'&&step?.status==='pending'&&!isApplicant&&currentEmail!==request.applicant.email&&currentEmail===step.approverEmail&&(!boundIdentity||boundIdentity===actor.id),canWithdraw:request.status==='pending'&&isApplicant};
}
export function validateApprovalTemplate(payload:Record<string,unknown>,actor:ApprovalActor,now:string,previous?:ApprovalTemplate):ApprovalTemplate {
  only(payload,['id','name','kind','steps','version']);const identity=actorIdentity(actor);
  const id=uuid(payload.id,'流程标识');
  if(previous) {
    if(previous.ownerId!==identity.id)fail('无权修改其他人的审批流程',403);
    if(id!==previous.id)fail('流程标识不能修改');version(previous.version,payload.version);
  } else if(payload.version!==undefined&&payload.version!==0)fail('流程已变化，请刷新后重试',409);
  return {id,ownerId:identity.id,name:text(payload.name,'流程名称',120),kind:kind(payload.kind),steps:route(payload.steps),version:(previous?.version??0)+1,updatedAt:now};
}
