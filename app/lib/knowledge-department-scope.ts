export type KnowledgeDepartmentId='zs'|'yy'|'yl'|'ch'|'wl';
export type KnowledgeLibraryDepartment=KnowledgeDepartmentId|'shared'|'unassigned';

export const KNOWLEDGE_DEPARTMENTS:ReadonlyArray<{id:KnowledgeDepartmentId;label:string;salesId:string}>=[
  {id:'zs',label:'招商',salesId:'sales-1'},
  {id:'yy',label:'医药',salesId:'sales-yy'},
  {id:'yl',label:'园林',salesId:'sales-yl'},
  {id:'ch',label:'测绘',salesId:'sales-ch'},
  {id:'wl',label:'文旅',salesId:'sales-wl'},
];

/** Resolve the trusted account's stable sales identifier; never infer from a prompt. */
export function knowledgeDepartmentForSalesId(salesId:string|undefined|null):KnowledgeDepartmentId|null{
  return KNOWLEDGE_DEPARTMENTS.find(item=>item.salesId===salesId)?.id??null;
}

export function isKnowledgeLibraryDepartment(value:unknown):value is KnowledgeLibraryDepartment{
  return value==='shared'||value==='unassigned'||KNOWLEDGE_DEPARTMENTS.some(item=>item.id===value);
}

export function canReadKnowledgeDepartment(scope:unknown,department:KnowledgeDepartmentId|null):boolean{
  return scope==='shared'||department!==null&&scope===department;
}
