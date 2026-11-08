import {DomainError,validateCompanyProfile} from './domain.ts';
import type {Deal,WorkbenchState,CompanyProfileSource} from './types.ts';
export const DATASET_ID='industry-company-research-2026-11-08';
export const DEPARTMENTS=[{username:'zs',salesId:'sales-1',industry:'餐饮'},{username:'yl',salesId:'sales-yl',industry:'园林'},{username:'ch',salesId:'sales-ch',industry:'测绘'},{username:'yy',salesId:'sales-yy',industry:'医药'},{username:'wl',salesId:'sales-wl',industry:'文旅'}] as const;
export interface DepartmentResearchRow {externalKey:string;ownerUsername:string;legalName:string;industryKey:string;region:string;website?:string;sourceDate?:string;sources:(Omit<CompanyProfileSource,'provider'>&{sourceDate?:string})[];facts:{label:string;value:string;sourceIds:string[]}[];warnings?:string[];}
export interface DepartmentDataset {schemaVersion:number;datasetId:string;researchedAt:string;rows:DepartmentResearchRow[];}
export const digest=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),x=>x.toString(16).padStart(2,'0')).join('');
export async function departmentState(original:WorkbenchState,dataset:DepartmentDataset):Promise<WorkbenchState>{
 if(dataset.schemaVersion!==1||dataset.datasetId!==DATASET_ID||dataset.rows.length!==250)throw new DomainError('企业资料版本或数量无效',409);
 const counts=new Map<string,number>(),keys=new Set<string>(),names=new Set<string>();const next=structuredClone(original);next.revision++;
 for(const deal of next.deals){deal.archive??={at:dataset.researchedAt,reason:'五科室企业目录替换；历史保留',migrationKey:DATASET_ID};if(deal.ownerId==='sales-1')deal.owner='ZS';}
 for(const row of dataset.rows){const department=DEPARTMENTS.find(d=>d.username===row.ownerUsername);const identity=row.legalName.normalize('NFKC').replace(/\s/g,'').toLowerCase();
 if(!department||!row.externalKey||!identity||keys.has(row.externalKey)||names.has(identity)||!row.sources.length||!row.region)throw new DomainError('企业资料重复或缺少有效归属、来源',409);
 const accepted:Record<string,string[]>= {zs:['餐饮'],yl:['园林'],ch:['测绘'],yy:['医药','医院'],wl:['文旅','旅行社']};if(!accepted[row.ownerUsername].some(x=>row.industryKey.includes(x)))throw new DomainError('企业行业与科室不匹配',409);
 keys.add(row.externalKey);names.add(identity);counts.set(row.ownerUsername,(counts.get(row.ownerUsername)??0)+1);
 const deal:Deal={id:`research-${(await digest(dataset.datasetId+':'+row.externalKey)).slice(0,32)}`,name:row.legalName,projectName:row.legalName+' · 公开企业线索',ownerId:department.salesId,owner:department.username.toUpperCase(),industry:row.industryKey,region:row.region,source:DATASET_ID,createdAt:dataset.researchedAt,dataOrigin:'research',stage:'线索',amount:0,health:0,priority:'low',contact:'',position:'',lastContact:'',summary:'',needs:[],risks:[],notes:[],nextAction:'核实适用场景与负责部门',version:1,avatar:Array.from(row.legalName)[0],outcome:'open'};
 deal.companyProfile=validateCompanyProfile({companyName:row.legalName,provider:'web',status:'ready',modelUsed:false,updatedAt:dataset.researchedAt,summary:'公开机构资料不代表客户采购需求或关系；实际业务以人工记录为准。',sources:row.sources.map(s=>({...s,provider:'web',snippet:[s.snippet,(s.sourceDate??row.sourceDate)?`资料日期：${s.sourceDate??row.sourceDate}`:''].filter(Boolean).join('\n')})),facts:row.facts,warnings:[...(row.warnings??[]).slice(0,8),'当前登记、许可及营业状态尚未核验。']},deal);next.deals.push(deal);
 }
 if(DEPARTMENTS.some(d=>counts.get(d.username)!==50))throw new DomainError('每个科室必须有50条独立企业资料',409);
 if(new TextEncoder().encode(JSON.stringify(next)).byteLength>1800000)throw new DomainError('工作空间容量不足，导入未执行',413);return next;
}
