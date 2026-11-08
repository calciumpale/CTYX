import {canReadKnowledgeDepartment,knowledgeDepartmentForSalesId} from './knowledge-department-scope.ts';
import type {KnowledgeDepartmentId} from './knowledge-department-scope.ts';
/** Legacy initial material is shared; recorded author ownership always takes precedence. */
export function canReadLegacyKnowledge(item:{id:string;departmentId?:unknown;employeeId?:string},access:Record<string,string>,department:KnowledgeDepartmentId|null):boolean{
 if(item.departmentId!==undefined)return canReadKnowledgeDepartment(item.departmentId,department);
 const owner=item.employeeId??access[item.id]??access[item.id.replace(/^knowledge-/,'')];
 if(owner&&owner!=='manager')return department!==null&&knowledgeDepartmentForSalesId(owner)===department;
 return true;
}
