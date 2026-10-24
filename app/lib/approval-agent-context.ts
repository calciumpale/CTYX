import {isApprovalStale} from './approval-domain.ts';
import type {ApprovalKind,ApprovalRequest,ApprovalStatus} from './approval-types.ts';
import type {WorkbenchState} from './types.ts';

export interface ProjectApprovalContext {id:string;kind:ApprovalKind;title:string;status:ApprovalStatus;updatedAt:string;contractTitle?:string;conditions?:{subject:string;baseline:string;proposed:string;reason:string}[];}
/** Only scoped, bounded submission facts enter model context; reviewer emails and contract bodies stay out. */
export async function projectApprovalContext(requests:ApprovalRequest[],workspace:WorkbenchState,projectId:string,ownerId:string):Promise<ProjectApprovalContext[]>{
  const result:ProjectApprovalContext[]=[];
  for(const request of requests.filter(item=>item.ownerId===ownerId&&item.projectId===projectId).slice(0,5)){
    const status=(request.status==='pending'||request.status==='approved')&&await isApprovalStale(request,workspace)?'superseded':request.status;
    result.push({id:request.id,kind:request.kind,title:request.title.slice(0,200),status,updatedAt:request.updatedAt,...(request.snapshot.contract?{contractTitle:request.snapshot.contract.title.slice(0,200)}:{}),...(request.snapshot.conditions?{conditions:request.snapshot.conditions.slice(0,5).map(item=>({subject:item.subject.slice(0,200),baseline:item.baseline.slice(0,300),proposed:item.proposed.slice(0,500),reason:item.reason.slice(0,300)}))}:{})});
  }
  return result;
}
