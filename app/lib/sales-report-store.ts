import { DomainError } from './domain.ts';
import { salesDayBounds } from './sales-report-domain.ts';
import type { WorkbenchState } from './types.ts';
import type { SalesEvent, SalesEventCounts, SalesEventKind, SalesReport, SalesReportSummary } from './sales-report-types.ts';

const conflict=()=>new DomainError('工作空间或日报已更新，请刷新后重试；本次操作未保存',409);
const user=(value:string)=>{if(typeof value!=='string'||!value||value.length>512)throw new DomainError('请先使用平台账号登录',401);};

/** D1.batch is atomic. Every insert and the final workspace CAS share the exact old JSON/revision guard. */
export async function persistSalesWorkspace(db:D1Database,userId:string,expectedRevision:number,nextState:WorkbenchState,events:SalesEvent[]=[]):Promise<void>{
  user(userId);if(!Number.isInteger(expectedRevision)||nextState.revision!==expectedRevision+1)throw conflict();
  const json=JSON.stringify(nextState);if(new TextEncoder().encode(json).length>1800000)throw new DomainError('工作空间存储容量不足；本次新增内容未保存',413);
  const source=await db.prepare('SELECT state_json FROM workbench_workspaces WHERE user_id = ? AND revision = ?').bind(userId,expectedRevision).first<{state_json:string}>();if(!source)throw conflict();
  if(events.length>100)throw new DomainError('单次业务变更事件过多，请分批保存',413);
  const now=new Date().toISOString();const guard='SELECT 1 FROM workbench_workspaces WHERE user_id = ? AND revision = ? AND state_json = ?';const guarded=[userId,expectedRevision,source.state_json];
  const statements:D1PreparedStatement[]=[];
  const manual=new Map(nextState.deals.filter(deal=>deal.dataOrigin==='manual').map(deal=>[deal.id,deal]));
  for(const event of events){if(!manual.has(event.projectId)||manual.get(event.projectId)!.version!==event.sourceVersion||!Number.isFinite(Date.parse(event.occurredAt)))throw new DomainError('销售事件与本次项目记录不一致',400);
    statements.push(db.prepare(`INSERT INTO workbench_sales_events (user_id,id,project_id,kind,owner_id,occurred_at,data_json) SELECT ?,?,?,?,?,?,? WHERE EXISTS (${guard}) ON CONFLICT(user_id,id) DO NOTHING`).bind(userId,event.id,event.projectId,event.kind,event.ownerId,event.occurredAt,JSON.stringify(event),...guarded));
  }
  const coverageAt=events.reduce((value,event)=>event.occurredAt<value?event.occurredAt:value,now);
  statements.push(db.prepare(`INSERT INTO workbench_sales_coverage (user_id,started_at) SELECT ?,? WHERE EXISTS (${guard}) ON CONFLICT(user_id) DO NOTHING`).bind(userId,coverageAt,...guarded));
  statements.push(db.prepare('UPDATE workbench_workspaces SET state_json = ?,revision = ?,updated_at = ? WHERE user_id = ? AND revision = ? AND state_json = ?').bind(json,nextState.revision,now,...guarded));
  const results=await db.batch(statements);if(results[results.length-1].meta.changes!==1)throw conflict();
}
interface ReportRow {status:SalesReport['status'];version:number;lease_token:string|null;lease_until:string|null;data_json:string;}
export function createSalesReportStore(db:D1Database){
  const get=async(ownerId:string,date:string)=>{user(ownerId);salesDayBounds(date);const row=await db.prepare('SELECT status,version,lease_token,lease_until,data_json FROM workbench_sales_reports WHERE user_id = ? AND report_date = ?').bind(ownerId,date).first<ReportRow>();if(!row)return null;const report=JSON.parse(row.data_json) as SalesReport;report.status=row.status;report.version=row.version;return {report,leaseUntil:row.lease_until};};
  return {
    get,
    async workspace(ownerId:string):Promise<WorkbenchState>{user(ownerId);const row=await db.prepare('SELECT state_json,revision FROM workbench_workspaces WHERE user_id = ?').bind(ownerId).first<{state_json:string;revision:number}>();if(!row)throw new DomainError('请先打开项目中心初始化本账号工作空间',404);const state=JSON.parse(row.state_json) as WorkbenchState;state.revision=row.revision;return state;},
    async coverage(ownerId:string,now?:string):Promise<string|null>{user(ownerId);if(now)await db.prepare('INSERT INTO workbench_sales_coverage (user_id,started_at) SELECT ?,? WHERE EXISTS (SELECT 1 FROM workbench_workspaces WHERE user_id = ?) ON CONFLICT(user_id) DO NOTHING').bind(ownerId,now,ownerId).run();const row=await db.prepare('SELECT started_at FROM workbench_sales_coverage WHERE user_id = ?').bind(ownerId).first<{started_at:string}>();return row?.started_at??null;},
    async events(ownerId:string,date:string,cutoff:string):Promise<{events:SalesEvent[];counts:SalesEventCounts;ownerCounts:Map<string,number>}>{
      user(ownerId);const {start,end}=salesDayBounds(date);const values=[ownerId,start,end,cutoff];const filter='user_id = ? AND occurred_at >= ? AND occurred_at < ? AND occurred_at <= ?';
      const [records,grouped,outcomes,owners]=await Promise.all([
        db.prepare(`SELECT data_json FROM workbench_sales_events WHERE ${filter} ORDER BY occurred_at DESC,id DESC LIMIT 100`).bind(...values).all<{data_json:string}>(),
        db.prepare(`SELECT kind,COUNT(*) AS total FROM workbench_sales_events WHERE ${filter} GROUP BY kind LIMIT 10`).bind(...values).all<{kind:SalesEventKind;total:number}>(),
        db.prepare(`SELECT SUM(CASE WHEN json_extract(data_json,'$.changes.outcome.after') = 'won' THEN 1 ELSE 0 END) AS won,SUM(CASE WHEN json_extract(data_json,'$.changes.outcome.after') = 'lost' THEN 1 ELSE 0 END) AS lost FROM workbench_sales_events WHERE ${filter} AND kind = 'outcome'`).bind(...values).first<{won:number|null;lost:number|null}>(),
        db.prepare(`SELECT owner_id,COUNT(*) AS total FROM workbench_sales_events WHERE ${filter} GROUP BY owner_id ORDER BY owner_id LIMIT 100`).bind(...values).all<{owner_id:string;total:number}>(),
      ]);
      const counts:SalesEventCounts={won:Number(outcomes?.won??0),lost:Number(outcomes?.lost??0)};for(const row of grouped.results)counts[row.kind]=Number(row.total);
      return {events:records.results.map(row=>JSON.parse(row.data_json) as SalesEvent),counts,ownerCounts:new Map(owners.results.map(row=>[row.owner_id,Number(row.total)]))};
    },
    async pendingApprovals(ownerId:string):Promise<number>{user(ownerId);const row=await db.prepare("SELECT COUNT(*) AS total FROM workbench_approval_requests r WHERE r.owner_id = ? AND r.status = 'pending' AND EXISTS (SELECT 1 FROM workbench_workspaces w,json_each(w.state_json,'$.deals') p WHERE w.user_id = r.owner_id AND json_extract(p.value,'$.id') = r.project_id AND json_extract(p.value,'$.dataOrigin') = 'manual')").bind(ownerId).first<{total:number}>();return Number(row?.total??0);},
    async list(ownerId:string):Promise<SalesReportSummary[]>{user(ownerId);const rows=await db.prepare('SELECT status,version,lease_token,lease_until,data_json FROM workbench_sales_reports WHERE user_id = ? ORDER BY report_date DESC LIMIT 30').bind(ownerId).all<ReportRow>();return rows.results.map(row=>{const report=JSON.parse(row.data_json) as SalesReport;return {date:report.date,status:row.status,mode:report.mode,updatedAt:report.updatedAt,newProjects:report.snapshot.metrics.newProjects,followups:report.snapshot.metrics.followups};});},
    async claim(ownerId:string,date:string,report:SalesReport,expectedVersion:number,now:string):Promise<string|null>{
      user(ownerId);salesDayBounds(date);const token=crypto.randomUUID(),until=new Date(Date.parse(now)+10*60000).toISOString();
      const result=expectedVersion===0?await db.prepare('INSERT INTO workbench_sales_reports (user_id,report_date,status,version,lease_token,lease_until,updated_at,data_json) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(user_id,report_date) DO NOTHING').bind(ownerId,date,'running',report.version,token,until,now,JSON.stringify(report)).run():await db.prepare("UPDATE workbench_sales_reports SET status = 'running',version = ?,lease_token = ?,lease_until = ?,updated_at = ?,data_json = ? WHERE user_id = ? AND report_date = ? AND version = ? AND (status != 'running' OR lease_until <= ?)").bind(report.version,token,until,now,JSON.stringify(report),ownerId,date,expectedVersion,now).run();
      return result.meta.changes===1?token:null;
    },
    async finish(ownerId:string,date:string,token:string,report:SalesReport):Promise<void>{user(ownerId);const result=await db.prepare('UPDATE workbench_sales_reports SET status = ?,updated_at = ?,data_json = ?,lease_token = NULL,lease_until = NULL WHERE user_id = ? AND report_date = ? AND lease_token = ? AND version = ? AND status = ?').bind(report.status,report.updatedAt,JSON.stringify(report),ownerId,date,token,report.version,'running').run();if(result.meta.changes!==1)throw conflict();},
    async accounts(after=''):Promise<{ids:string[];hasMore:boolean}>{if(after.length>512)throw new DomainError('日报任务游标无效',400);const rows=await db.prepare('SELECT user_id FROM workbench_workspaces WHERE user_id > ? ORDER BY user_id LIMIT 6').bind(after).all<{user_id:string}>();return {ids:rows.results.slice(0,5).map(row=>row.user_id),hasMore:rows.results.length>5};},
  };
}
