import { DomainError } from './domain.ts';
import type { ApprovalRequest, ApprovalTemplate } from './approval-types.ts';

/** SQL metadata is authoritative for selection; the envelope preserves immutable source and retry hashes. */
export interface ApprovalRecord {
  id:string;ownerId:string;projectId:string;kind:string;status:string;version:number;
  currentApproverEmail:string|null;activeKey:string|null;inputHash:string;
  createdAt:string;updatedAt:string;request:ApprovalRequest;
}
export interface ApprovalStoreIdentity {id:string;email:string;}
export interface ApprovalListOptions {scope?:'inbox'|'mine'|'all';status?:string;projectId?:string;q?:string;limit?:number;cursor?:string;}
export type ApprovalStoredTemplate=ApprovalTemplate;
interface Row {id:string;owner_id:string;project_id:string;kind:string;status:string;version:number;current_approver_email:string|null;active_key:string|null;created_at:string;updated_at:string;data_json:string;}
const fields='r.id,r.owner_id,r.project_id,r.kind,r.status,r.version,r.current_approver_email,r.active_key,r.created_at,r.updated_at,r.data_json';
const conflict=()=>new DomainError('申请已更新或相同内容正在审批，请刷新后重试',409);
function decode(row:Row):ApprovalRecord {
  const envelope=JSON.parse(row.data_json) as {request:ApprovalRequest;inputHash:string};
  return {id:row.id,ownerId:row.owner_id,projectId:row.project_id,kind:row.kind,status:row.status,version:row.version,currentApproverEmail:row.current_approver_email,activeKey:row.active_key,inputHash:envelope.inputHash,createdAt:row.created_at,updatedAt:row.updated_at,request:envelope.request};
}
function cursor(value:string|undefined):{createdAt:string;id:string}|undefined {
  if(!value)return;
  try{if(value.length>1800)throw new Error();const decoded=JSON.parse(atob(value)) as {createdAt:unknown;id:unknown};if(typeof decoded.createdAt!=='string'||!Number.isFinite(Date.parse(decoded.createdAt))||typeof decoded.id!=='string'||!decoded.id||decoded.id.length>160)throw new Error();return {createdAt:decoded.createdAt,id:decoded.id};}catch{throw new DomainError('分页位置无效，请重新加载',400);}
}
const encodeCursor=(record:ApprovalRecord)=>btoa(JSON.stringify({createdAt:record.createdAt,id:record.id}));
function scoped(actor:ApprovalStoreIdentity,scope:string):{sql:string;values:(string|number)[]} {
  const binding="NOT EXISTS (SELECT 1 FROM json_each(r.data_json,'$.request.steps') bound_step WHERE json_extract(bound_step.value,'$.decidedBy.email') = ? AND json_extract(bound_step.value,'$.decidedBy.id') <> ?)";
  if(scope==='mine')return {sql:'r.owner_id = ?',values:[actor.id]};
  if(scope==='inbox')return {sql:`r.current_approver_email = ? AND r.status = 'pending' AND r.owner_id <> ? AND json_extract(r.data_json,'$.request.applicant.email') <> ? AND ${binding}`,values:[actor.email,actor.id,actor.email,actor.email,actor.id]};
  return {sql:`(r.owner_id = ? OR (EXISTS (SELECT 1 FROM workbench_approval_participants p WHERE p.request_id = r.id AND p.email = ?) AND ${binding}))`,values:[actor.id,actor.email,actor.email,actor.id]};
}
export function createApprovalStore(db:D1Database){
  return {
    async insert(record:ApprovalRecord,emails:string[]):Promise<ApprovalRecord>{
      const statements=[db.prepare('INSERT INTO workbench_approval_requests (id,owner_id,project_id,kind,status,version,current_approver_email,active_key,created_at,updated_at,data_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(record.id,record.ownerId,record.projectId,record.kind,record.status,record.version,record.currentApproverEmail,record.activeKey,record.createdAt,record.updatedAt,JSON.stringify({request:record.request,inputHash:record.inputHash})),...Array.from(new Set(emails)).map(email=>db.prepare('INSERT INTO workbench_approval_participants (request_id,email) VALUES (?,?)').bind(record.id,email))];
      try{await db.batch(statements);}catch(error){if(/UNIQUE|constraint/i.test(error instanceof Error?error.message:''))throw conflict();throw error;}
      return record;
    },
    async get(id:string):Promise<ApprovalRecord|null>{const row=await db.prepare(`SELECT ${fields} FROM workbench_approval_requests r WHERE id = ?`).bind(id).first<Row>();return row?decode(row):null;},
    async visible(id:string,actor:ApprovalStoreIdentity):Promise<ApprovalRecord|null>{const access=scoped(actor,'all');const row=await db.prepare(`SELECT ${fields} FROM workbench_approval_requests r WHERE r.id = ? AND ${access.sql}`).bind(id,...access.values).first<Row>();return row?decode(row):null;},
    async list(actor:ApprovalStoreIdentity,options:ApprovalListOptions={}):Promise<{records:ApprovalRecord[];nextCursor?:string}>{
      const limit=options.limit??50;if(!Number.isInteger(limit)||limit<1||limit>50)throw new DomainError('每页数量应为1至50',400);
      const scope=options.scope??'all';if(!['all','mine','inbox'].includes(scope))throw new DomainError('审批列表范围无效',400);
      const access=scoped(actor,scope);const where=[access.sql];const values=access.values;const position=cursor(options.cursor);
      if(options.status){where.push(options.status==='superseded'?"(r.status = ? OR r.kind = 'contract')":'r.status = ?');values.push(options.status);}
      if(options.projectId){where.push('r.project_id = ?');values.push(options.projectId);}
      if(options.q){where.push("(json_extract(r.data_json,'$.request.title') LIKE ? ESCAPE '\\' OR json_extract(r.data_json,'$.request.snapshot.project.name') LIKE ? ESCAPE '\\' OR json_extract(r.data_json,'$.request.snapshot.project.company') LIKE ? ESCAPE '\\' OR json_extract(r.data_json,'$.request.applicant.name') LIKE ? ESCAPE '\\' OR json_extract(r.data_json,'$.request.applicant.email') LIKE ? ESCAPE '\\')");const query=`%${options.q.replace(/[\\%_]/g,'\\$&')}%`;values.push(query,query,query,query,query);}
      if(position){where.push('(r.created_at < ? OR (r.created_at = ? AND r.id < ?))');values.push(position.createdAt,position.createdAt,position.id);}
      values.push(limit+1);
      const result=await db.prepare(`SELECT ${fields} FROM workbench_approval_requests r WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC,r.id DESC LIMIT ?`).bind(...values).all<Row>();
      const records=(result.results??[]).map(decode);const hasNext=records.length>limit;records.splice(limit);
      return {records,...(hasNext&&records.length?{nextCursor:encodeCursor(records[records.length-1])}:{})};
    },
    async pendingCount(actor:ApprovalStoreIdentity):Promise<number>{const access=scoped(actor,'inbox');const row=await db.prepare(`SELECT COUNT(*) AS total FROM workbench_approval_requests r WHERE ${access.sql}`).bind(...access.values).first<{total:number}>();return Number(row?.total??0);},
    async update(record:ApprovalRecord,version:number,status:string,source?:{ownerId:string;stateJson:string}):Promise<void>{
      const sourceGuard=source?' AND EXISTS (SELECT 1 FROM workbench_workspaces w WHERE w.user_id = ? AND w.state_json = ?)':'';
      const values=[record.status,record.version,record.currentApproverEmail,record.activeKey,record.updatedAt,JSON.stringify({request:record.request,inputHash:record.inputHash}),record.id,version,status];if(source)values.push(source.ownerId,source.stateJson);
      const result=await db.prepare(`UPDATE workbench_approval_requests SET status = ?,version = ?,current_approver_email = ?,active_key = ?,updated_at = ?,data_json = ? WHERE id = ? AND version = ? AND status = ?${sourceGuard}`).bind(...values).run();
      if(result.meta.changes!==1)throw conflict();
    },
    async saveTemplate(template:ApprovalTemplate,version:number):Promise<void>{
      if(version===0){try{await db.prepare('INSERT INTO workbench_approval_templates (id,owner_id,version,updated_at,data_json) VALUES (?,?,?,?,?)').bind(template.id,template.ownerId,template.version,template.updatedAt,JSON.stringify(template)).run();}catch(error){if(/UNIQUE|constraint/i.test(error instanceof Error?error.message:''))throw conflict();throw error;}return;}
      const result=await db.prepare('UPDATE workbench_approval_templates SET version = ?,updated_at = ?,data_json = ? WHERE id = ? AND owner_id = ? AND version = ?').bind(template.version,template.updatedAt,JSON.stringify(template),template.id,template.ownerId,version).run();if(result.meta.changes!==1)throw conflict();
    },
    async templates(ownerId:string):Promise<ApprovalTemplate[]>{const result=await db.prepare('SELECT data_json FROM workbench_approval_templates WHERE owner_id = ? ORDER BY updated_at DESC,id DESC LIMIT 100').bind(ownerId).all<{data_json:string}>();return (result.results??[]).map(row=>JSON.parse(row.data_json) as ApprovalTemplate);},
    async deleteTemplate(id:string,ownerId:string,version:number):Promise<void>{const result=await db.prepare('DELETE FROM workbench_approval_templates WHERE id = ? AND owner_id = ? AND version = ?').bind(id,ownerId,version).run();if(result.meta.changes!==1)throw conflict();},
  };
}
