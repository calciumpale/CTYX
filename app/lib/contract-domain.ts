import {DomainError} from './domain.ts';
import {CONTRACT_TYPES} from './contract-types.ts';
import type {ContractAnalysis,ContractDocument,ContractFindingStatus} from './contract-types.ts';
import type {Deal,Role,WorkbenchState} from './types.ts';
import {validateContractAnalysis,ContractReviewError} from './contract-review.ts';
export interface ContractActionContext{now:string;actorName?:string;review?:(document:ContractDocument,deal:Deal)=>Promise<ContractAnalysis>;modelName?:string;}
function fail(message:string,status=400):never{throw new DomainError(message,status);}
function value(v:unknown,label:string,max:number,required=true):string{if(typeof v!=='string'||v.length>max||/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)||required&&!v.trim())fail(`请检查${label}（最多${max.toLocaleString()}字）`);return v;}
function allowed(payload:Record<string,unknown>,keys:string[]){if(Object.keys(payload).some(k=>!keys.includes(k)))fail('合同参数包含不允许修改的字段');}
export async function handleContractAction(state:WorkbenchState,role:Role,action:string,payload:Record<string,unknown>,context:ContractActionContext):Promise<{id:string;message:string;reviewed?:ContractDocument}|null>{
  if(!['contract_save','contract_review','contract_finding_status'].includes(action))return null;
  const now=context.now;const contracts=state.contracts??=[];
  const deal=(key:unknown)=>{const item=state.deals.find(d=>d.id===key);if(!item)fail('请选择合同关联项目',404);if(role==='sales'&&item.ownerId!=='sales-1')fail('无权访问其他销售的合同',403);return item;};
  const existing=()=>{const document=contracts.find(d=>d.id===payload.id);if(!document)fail('合同不存在或无权访问',404);deal(document.dealId);if(!Number.isInteger(payload.version)||payload.version!==document.version)fail('合同已更新，请刷新后重试',409);return document;};
  if(action==='contract_save'){
    allowed(payload,['id','version','dealId','title','text','contractType','ourParty','focus','fileName','sourceFormat','importWarnings']);
    const previous=payload.id?existing():undefined;const project=deal(payload.dealId);const title=value(payload.title,'合同名称',200).trim();const text=value(payload.text,'合同原文',80000);const focus=value(payload.focus??'','审查重点',2000,false).trim();
    if(!CONTRACT_TYPES.includes(payload.contractType as ContractDocument['contractType'])||!['甲方','乙方','待确认'].includes(String(payload.ourParty))||!['paste','txt','docx','pdf'].includes(String(payload.sourceFormat)))fail('请检查合同类型、我方立场和文本来源');
    if(contracts.reduce((n,c)=>n+(c.id===previous?.id?0:c.text.length),0)+text.length>300000)fail('合同正文总容量达到30万字，请联系管理员扩容',413);
    if(!previous&&contracts.length>=40)fail('当前工作空间最多保存40份合同，请联系管理员扩容',413);
    const fileName=payload.fileName===undefined?'':value(payload.fileName,'文件名',200,false).trim();if(/[\\/]/.test(fileName))fail('文件名格式不正确');
    const importWarnings=payload.importWarnings===undefined?[]:payload.importWarnings;if(!Array.isArray(importWarnings)||importWarnings.length>10)fail('导入提示格式不正确');const warnings=importWarnings.map(w=>value(w,'导入提示',500));
    const document:ContractDocument={id:previous?.id??`contract-${crypto.randomUUID()}`,dealId:project.id,title,text,contractType:payload.contractType as ContractDocument['contractType'],ourParty:payload.ourParty as ContractDocument['ourParty'],focus,sourceFormat:payload.sourceFormat as ContractDocument['sourceFormat'],...(fileName?{fileName}:{}),importWarnings:warnings,createdBy:previous?.createdBy??context.actorName??(role==='sales'?'林晓':'周予安'),createdAt:previous?.createdAt??now,updatedAt:now,version:(previous?.version??0)+1};
    const changed=!previous||['dealId','title','text','contractType','ourParty','focus'].some(k=>document[k as keyof ContractDocument]!==previous[k as keyof ContractDocument]);
    if(previous&&!changed){document.analysis=previous.analysis;document.reviewedAt=previous.reviewedAt;document.modelName=previous.modelName;}
    if(previous)contracts[contracts.findIndex(d=>d.id===previous.id)]=document;else contracts.unshift(document);
    return {id:document.id,message:changed?'合同已保存，可由商务风控 Agent 初审':'合同已保存'};
  }
  if(action==='contract_review'){
    allowed(payload,['id','version']);const document=existing();if(!context.review)fail('请先在设置中配置并启用大模型 API，合同原文已保存',503);
    let result:ContractAnalysis;try{result=validateContractAnalysis(await context.review(structuredClone(document),structuredClone(deal(document.dealId))),document.text);}catch(error){if(error instanceof DomainError)throw error;if(error instanceof ContractReviewError)fail(error.message,error.status);fail('合同初审未返回可定位的有效结果，原文及此前审核记录已保留，请重试',502);}
    result.findings=result.findings.map(f=>({...f,status:'open'}));document.analysis=result;document.reviewedAt=now;document.updatedAt=now;document.version++;document.modelName=context.modelName??'已配置的大模型';
    return {id:document.id,message:`合同初审完成，发现${result.findings.length}项条款风险、${result.missingItems.length}项待补充内容`,reviewed:document};
  }
  allowed(payload,['id','version','findingId','status']);const document=existing();const finding=document.analysis?.findings.find(f=>f.id===payload.findingId);if(!finding)fail('风险条目不存在，请先完成初审',404);if(!['open','revised','legal'].includes(String(payload.status)))fail('请选择待处理、已修改或需法务确认');finding.status=payload.status as ContractFindingStatus;document.version++;document.updatedAt=now;return {id:document.id,message:'风险处理状态已更新；合同原文未自动改写'};
}
