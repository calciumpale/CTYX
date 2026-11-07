import { DomainError } from './domain.ts';
import { normalizeScheduleDraft, scheduleId, scheduleRange, scheduleStatus, scheduleVersion } from './schedule-domain.ts';
import type { MemberRole } from './member-types.ts';
import type { ScheduleDraft, ScheduleItem, ScheduleList, ScheduleStatus, ScheduleUnscheduledPage } from './schedule-types.ts';

export interface ScheduleActor { ownerId: string; accountId: string; role: MemberRole; displayName: string; }
interface MemberRow { display_name: string; sales_id: string | null; }
interface ScheduleRow {
  id: string; owner_account_id: string; owner_name: string; create_json: string; kind: ScheduleDraft['kind']; title: string;
  start_at: string | null; end_at: string | null; all_day: number; deal_id: string | null; location: string; notes: string;
  status: ScheduleStatus; version: number; created_at: string; updated_at: string; deleted_at: string | null;
}
const conflict = () => new DomainError('日程已更新，请刷新后重试；本次操作未保存', 409);
const missing = () => new DomainError('日程不存在或不属于当前账号', 404);
const memberGuard = "EXISTS (SELECT 1 FROM workbench_member_accounts m WHERE m.owner_id = ? AND m.account_id = ? AND m.role = ? AND m.enabled = 1)";
const guardValues = (actor: ScheduleActor) => [actor.ownerId, actor.accountId, actor.role];
const projectGuard = "(? IS NULL OR EXISTS (SELECT 1 FROM workbench_workspaces w, json_each(w.state_json, '$.deals') p WHERE w.user_id = ? AND json_extract(p.value, '$.id') = ? AND (? = 'manager' OR json_extract(p.value, '$.ownerId') = ?)))";
const projectValues = (actor: ScheduleActor, member: MemberRow, dealId: string | null) => [dealId, actor.ownerId, dealId, actor.role, member.sales_id];
const visibleProject = "(s.deal_id IS NULL OR EXISTS (SELECT 1 FROM workbench_workspaces w,json_each(w.state_json,'$.deals') p WHERE w.user_id = s.workspace_owner_id AND json_extract(p.value,'$.id') = s.deal_id AND (? = 'manager' OR json_extract(p.value,'$.ownerId') = ?)))";
type UnscheduledKind = 'task' | 'visit';
type ScheduleScope = 'mine' | 'team';
interface ReadFilter { sql: string; values: (string | null)[]; }
interface UnscheduledCounts { task: number; visit: number; pendingTask: number; pendingVisit: number; }
interface CursorPointer { v: 1; context: string; at: string; id: string; }
const invalidCursor = () => new DomainError('未安排日程的分页游标无效或已跨账号、分类或范围，请重新加载', 400);
async function cursorContext(actor: ScheduleActor, member: MemberRow, scope: ScheduleScope, kind: UnscheduledKind): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify([actor.ownerId, actor.accountId, actor.role, member.sales_id, scope, kind]));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoded)), value => value.toString(16).padStart(2, '0')).join('');
}
function encodeCursor(pointer: CursorPointer): string {
  return btoa(JSON.stringify(pointer)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeCursor(cursor: string, context: string): CursorPointer {
  try {
    if (typeof cursor !== 'string' || !/^[a-zA-Z0-9_-]{1,1500}$/.test(cursor)) throw invalidCursor();
    const decoded = atob(cursor.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - cursor.length % 4) % 4));
    const pointer = JSON.parse(decoded) as CursorPointer;
    if (!pointer || typeof pointer !== 'object' || Array.isArray(pointer) || Object.keys(pointer).length !== 4 || Object.keys(pointer).some(key => !['v', 'context', 'at', 'id'].includes(key)) || pointer.v !== 1 || pointer.context !== context) throw invalidCursor();
    if (typeof pointer.at !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(pointer.at) || !Number.isFinite(Date.parse(pointer.at)) || new Date(pointer.at).toISOString() !== pointer.at) throw invalidCursor();
    scheduleId(pointer.id);
    if (encodeCursor(pointer) !== cursor) throw invalidCursor();
    return pointer;
  } catch { throw invalidCursor(); }
}

function item(row: ScheduleRow, actor: ScheduleActor): ScheduleItem {
  return { id: row.id, ownerAccountId: row.owner_account_id, ownerName: row.owner_name, kind: row.kind, title: row.title,
    startAt: row.start_at, endAt: row.end_at, allDay: !!row.all_day, dealId: row.deal_id, location: row.location, notes: row.notes,
    status: row.status, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at, canEdit: row.owner_account_id === actor.accountId };
}
/** All read/write predicates include the outer Sites owner and inner member; mutations never accept team scope. */
export function createScheduleStore(db: D1Database) {
  async function authenticate(actor: ScheduleActor): Promise<MemberRow> {
    if (!actor.ownerId || actor.ownerId.length > 512 || !actor.accountId || actor.accountId.length > 128 || !['sales', 'manager'].includes(actor.role)) throw new DomainError('当前账号没有日程权限', 403);
    const member = await db.prepare('SELECT display_name,sales_id FROM workbench_member_accounts WHERE owner_id = ? AND account_id = ? AND role = ? AND enabled = 1').bind(...guardValues(actor)).first<MemberRow>();
    if (!member) throw new DomainError('当前账号已失效或没有日程权限，请重新登录', 403);
    return member;
  }
  async function project(actor: ScheduleActor, member: MemberRow, dealId: string | null): Promise<void> {
    if (!dealId) return;
    const found = await db.prepare(`SELECT 1 AS valid WHERE ${projectGuard}`).bind(...projectValues(actor, member, dealId)).first<{valid: number}>();
    if (!found) throw new DomainError('关联项目不存在或当前账号不可见，请重新选择', 400);
  }
  const own = (actor: ScheduleActor, id: string) => db.prepare('SELECT * FROM workbench_schedules WHERE workspace_owner_id = ? AND owner_account_id = ? AND id = ?').bind(actor.ownerId, actor.accountId, scheduleId(id)).first<ScheduleRow>();
  async function mutable(actor: ScheduleActor, id: string, version: number, deleted = false): Promise<ScheduleRow> {
    scheduleVersion(version);
    const row = await own(actor, id);
    if (!row) throw missing();
    if (row.version !== version || !!row.deleted_at !== deleted) throw conflict();
    return row;
  }
  async function readChanged(actor: ScheduleActor, id: string, changes: number): Promise<ScheduleItem> {
    if (changes !== 1) throw conflict();
    const row = await own(actor, id);
    if (!row) throw missing();
    return item(row, actor);
  }
  async function create(actor: ScheduleActor, requestId: string, value: ScheduleDraft, now: string): Promise<ScheduleItem> {
    const member = await authenticate(actor), draft = normalizeScheduleDraft(value);
    scheduleId(requestId);
    const canonical = JSON.stringify(draft);
    const retry = () => db.prepare('SELECT * FROM workbench_schedules WHERE workspace_owner_id = ? AND owner_account_id = ? AND request_id = ?').bind(actor.ownerId, actor.accountId, requestId).first<ScheduleRow>();
    let row = await retry();
    if (row) { if (row.create_json !== canonical) throw new DomainError('该保存请求已用于其他日程，请刷新后重试', 409); return item(row, actor); }
    await project(actor, member, draft.dealId);
    const id = crypto.randomUUID();
    await db.prepare(`INSERT INTO workbench_schedules (id,workspace_owner_id,owner_account_id,owner_name,request_id,create_json,kind,title,start_at,end_at,all_day,deal_id,location,notes,status,version,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',1,?,? WHERE ${memberGuard} AND ${projectGuard} ON CONFLICT(workspace_owner_id,owner_account_id,request_id) DO NOTHING`).bind(id, actor.ownerId, actor.accountId, member.display_name, requestId, canonical, draft.kind, draft.title, draft.startAt, draft.endAt, draft.allDay ? 1 : 0, draft.dealId, draft.location, draft.notes, now, now, ...guardValues(actor), ...projectValues(actor, member, draft.dealId)).run();
    row = await retry();
    if (!row) throw conflict();
    if (row.create_json !== canonical) throw new DomainError('该保存请求已用于其他日程，请刷新后重试', 409);
    return item(row, actor);
  }
  async function update(actor: ScheduleActor, id: string, version: number, value: ScheduleDraft, now: string): Promise<ScheduleItem> {
    const member = await authenticate(actor), draft = normalizeScheduleDraft(value);
    await mutable(actor, id, version); await project(actor, member, draft.dealId);
    const result = await db.prepare(`UPDATE workbench_schedules SET kind=?,title=?,start_at=?,end_at=?,all_day=?,deal_id=?,location=?,notes=?,version=version+1,updated_at=? WHERE workspace_owner_id=? AND owner_account_id=? AND id=? AND version=? AND deleted_at IS NULL AND ${memberGuard} AND ${projectGuard}`).bind(draft.kind, draft.title, draft.startAt, draft.endAt, draft.allDay ? 1 : 0, draft.dealId, draft.location, draft.notes, now, actor.ownerId, actor.accountId, id, version, ...guardValues(actor), ...projectValues(actor, member, draft.dealId)).run();
    return readChanged(actor, id, result.meta.changes);
  }
  async function status(actor: ScheduleActor, id: string, version: number, value: ScheduleStatus, now: string): Promise<ScheduleItem> {
    await authenticate(actor); const next = scheduleStatus(value); await mutable(actor, id, version);
    const result = await db.prepare(`UPDATE workbench_schedules SET status=?,version=version+1,updated_at=? WHERE workspace_owner_id=? AND owner_account_id=? AND id=? AND version=? AND deleted_at IS NULL AND ${memberGuard}`).bind(next, now, actor.ownerId, actor.accountId, id, version, ...guardValues(actor)).run();
    return readChanged(actor, id, result.meta.changes);
  }
  async function deletion(actor: ScheduleActor, id: string, version: number, now: string, restore: boolean): Promise<ScheduleItem> {
    const member = await authenticate(actor), previous = await mutable(actor, id, version, restore);
    if (restore) await project(actor, member, previous.deal_id);
    const result = await db.prepare(`UPDATE workbench_schedules SET deleted_at=?,version=version+1,updated_at=? WHERE workspace_owner_id=? AND owner_account_id=? AND id=? AND version=? AND deleted_at IS ${restore ? 'NOT NULL' : 'NULL'} AND ${memberGuard}${restore ? ` AND ${projectGuard}` : ''}`).bind(restore ? null : now, now, actor.ownerId, actor.accountId, id, version, ...guardValues(actor), ...(restore ? projectValues(actor, member, previous.deal_id) : [])).run();
    return readChanged(actor, id, result.meta.changes);
  }
  function readFilter(actor: ScheduleActor, member: MemberRow, scope: ScheduleScope, exact = false): ReadFilter {
    if (!['mine', 'team'].includes(scope)) throw new DomainError('日程查看范围无效', 400);
    if (scope === 'team' && actor.role !== 'manager') {
      if (exact) throw missing();
      throw new DomainError('仅管理者可以查看团队日程', 403);
    }
    return {sql: `s.workspace_owner_id = ? AND s.deleted_at IS NULL${scope === 'mine' ? ' AND s.owner_account_id = ?' : ''} AND ${memberGuard} AND ${visibleProject}`,
      values: [actor.ownerId, ...(scope === 'mine' ? [actor.accountId] : []), ...guardValues(actor), actor.role, member.sales_id]};
  }
  async function unscheduledCounts(filter: ReadFilter): Promise<UnscheduledCounts> {
    const row = await db.prepare(`SELECT SUM(CASE WHEN s.kind = 'task' THEN 1 ELSE 0 END) AS task_count,SUM(CASE WHEN s.kind = 'visit' THEN 1 ELSE 0 END) AS visit_count,SUM(CASE WHEN s.kind = 'task' AND s.status = 'pending' THEN 1 ELSE 0 END) AS pending_task_count,SUM(CASE WHEN s.kind = 'visit' AND s.status = 'pending' THEN 1 ELSE 0 END) AS pending_visit_count FROM workbench_schedules s WHERE ${filter.sql} AND s.start_at IS NULL AND s.kind IN ('task','visit')`).bind(...filter.values).first<{task_count: number | null; visit_count: number | null; pending_task_count: number | null; pending_visit_count: number | null}>();
    return {task: Number(row?.task_count ?? 0), visit: Number(row?.visit_count ?? 0), pendingTask: Number(row?.pending_task_count ?? 0), pendingVisit: Number(row?.pending_visit_count ?? 0)};
  }
  /** Exact reads recover a moved record without widening access to its former date range. */
  async function get(actor: ScheduleActor, id: string, scope: ScheduleScope = 'mine'): Promise<ScheduleItem> {
    const member = await authenticate(actor), filter = readFilter(actor, member, scope, true);
    const row = await db.prepare(`SELECT s.* FROM workbench_schedules s WHERE ${filter.sql} AND s.id = ?`).bind(...filter.values, scheduleId(id)).first<ScheduleRow>();
    if (!row) throw missing();
    return item(row, actor);
  }
  async function list(actor: ScheduleActor, from: string, to: string, scope: ScheduleScope = 'mine'): Promise<ScheduleList> {
    const member = await authenticate(actor), range = scheduleRange(from, to), filter = readFilter(actor, member, scope);
    const [scheduled, unscheduled, counts] = await Promise.all([
      db.prepare(`SELECT s.* FROM workbench_schedules s WHERE ${filter.sql} AND s.start_at < ? AND s.end_at > ? ORDER BY s.start_at,s.id LIMIT 501`).bind(...filter.values, range.end, range.start).all<ScheduleRow>(),
      db.prepare(`SELECT s.* FROM workbench_schedules s WHERE ${filter.sql} AND s.start_at IS NULL AND s.kind IN ('task','visit') ORDER BY s.created_at DESC,s.id DESC LIMIT 201`).bind(...filter.values).all<ScheduleRow>(),
      unscheduledCounts(filter),
    ]);
    const scheduledTruncated = scheduled.results.length > 500;
    return {items: scheduled.results.slice(0, 500).map(row => item(row, actor)), unscheduled: unscheduled.results.slice(0, 200).map(row => item(row, actor)), scope,
      truncated: scheduledTruncated || counts.task + counts.visit > 200, scheduledTruncated, unscheduledCounts: {task: counts.task, visit: counts.visit}, pendingVisitCount: counts.pendingVisit};
  }
  /** Kind-specific keyset pagination keeps older visits reachable regardless of task history. */
  async function unscheduled(actor: ScheduleActor, kind: UnscheduledKind, scope: ScheduleScope = 'mine', cursor?: string): Promise<ScheduleUnscheduledPage> {
    if (kind !== 'task' && kind !== 'visit') throw new DomainError('未安排日程分类无效', 400);
    const member = await authenticate(actor), filter = readFilter(actor, member, scope), context = await cursorContext(actor, member, scope, kind);
    const pointer = cursor === undefined ? null : decodeCursor(cursor, context);
    const after = pointer ? ' AND (s.created_at < ? OR (s.created_at = ? AND s.id < ?))' : '';
    const [rows, counts] = await Promise.all([
      db.prepare(`SELECT s.* FROM workbench_schedules s WHERE ${filter.sql} AND s.start_at IS NULL AND s.kind = ?${after} ORDER BY s.created_at DESC,s.id DESC LIMIT 101`).bind(...filter.values, kind, ...(pointer ? [pointer.at, pointer.at, pointer.id] : [])).all<ScheduleRow>(),
      unscheduledCounts(filter),
    ]);
    const selected = rows.results.slice(0, 100), last = selected.at(-1);
    return {items: selected.map(row => item(row, actor)), totalCount: counts[kind], pendingCount: kind === 'task' ? counts.pendingTask : counts.pendingVisit,
      ...(rows.results.length > 100 && last ? {nextCursor: encodeCursor({v: 1, context, at: last.created_at, id: last.id})} : {})};
  }
  async function projects(actor: ScheduleActor): Promise<{id: string; name: string}[]> {
    const member = await authenticate(actor);
    const rows = await db.prepare("SELECT json_extract(p.value,'$.id') AS id, COALESCE(json_extract(p.value,'$.projectName'),json_extract(p.value,'$.name')) AS name FROM workbench_workspaces w,json_each(w.state_json,'$.deals') p WHERE w.user_id=? AND (?='manager' OR json_extract(p.value,'$.ownerId')=?) ORDER BY id LIMIT 501").bind(actor.ownerId, actor.role, member.sales_id).all<{id: string; name: string}>();
    return rows.results.slice(0, 500);
  }
  return {authenticate, create, update, status, get, list, unscheduled, projects, delete: (actor: ScheduleActor, id: string, version: number, now: string) => deletion(actor, id, version, now, false), restore: (actor: ScheduleActor, id: string, version: number, now: string) => deletion(actor, id, version, now, true)};
}
