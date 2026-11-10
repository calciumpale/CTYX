import { DomainError } from './domain.ts';
import { momentDay, nextMomentAt } from './moments.ts';
import type { MomentDraft, MomentPlan, MomentPlanInput, MomentStoredDraft } from './moments-types.ts';

type PlanRow = {
  id: string; owner_id: string; member_id: string; version: number; input_json: string; next_run_at: string | null; updated_at: string;
};
type DraftRow = {
  id: string; plan_id: string; owner_id: string; member_id: string; trigger: MomentDraft['trigger'];
  version: number; status: MomentDraft['status']; input_json: string; output_json: string;
  next_check_at: string | null; lease_token: string | null; lease_until: string | null; created_at: string; updated_at: string;
};
type DraftOutput = Pick<MomentStoredDraft, 'text' | 'error' | 'imagePrompt' | 'imageTaskId'> & Partial<Pick<MomentStoredDraft, 'files'>>;
type DraftChange = Partial<DraftOutput & Pick<MomentStoredDraft, 'status' | 'nextCheckAt'>>;

const DAY_MS = 24 * 60 * 60 * 1000;
const LEASE_MS = 5 * 60 * 1000;
const ACTIVE = "('queued','writing','image_pending')";
const memberEligible = (owner: string, member: string) => `EXISTS (
  SELECT 1 FROM workbench_member_accounts AS member
  WHERE member.owner_id=${owner} AND member.account_id=${member} AND member.enabled=1
    AND (member.role='manager' OR (member.role='sales' AND member.sales_id IS NOT NULL AND
      (SELECT COUNT(*) FROM workbench_member_accounts AS peers WHERE peers.owner_id=member.owner_id
        AND peers.role='sales' AND peers.enabled=1 AND peers.sales_id=member.sales_id)=1))
)`;
const changed = () => new DomainError('记录已更新，请刷新后重试', 409);
const runnable = (table: string) => `${table}.status IN ${ACTIVE} AND (${table}.next_check_at IS NULL OR ${table}.next_check_at<=?) AND (${table}.lease_until IS NULL OR ${table}.lease_until<=?)`;
const batchLimit = (limit: number) => Math.max(1, Math.min(20, Math.trunc(limit) || 5));

function planFrom(row: PlanRow): MomentPlan {
  const input: MomentPlanInput = JSON.parse(row.input_json);
  return { ...input, id: row.id, version: row.version, nextRunAt: row.next_run_at, updatedAt: row.updated_at };
}

function draftFrom(row: DraftRow): MomentStoredDraft {
  const input: MomentPlanInput = JSON.parse(row.input_json);
  const output: DraftOutput = JSON.parse(row.output_json);
  return {
    ...output,
    id: row.id, planId: row.plan_id, ownerId: row.owner_id, memberId: row.member_id, input,
    productName: input.productName, style: input.style, trigger: row.trigger, status: row.status, files: output.files ?? [],
    version: row.version, nextCheckAt: row.next_check_at, leaseToken: row.lease_token, leaseUntil: row.lease_until,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function createMomentStore(db: D1Database) {
  const ownPlan = (owner: string, member: string, id: string) => db.prepare(
    'SELECT * FROM workbench_moment_plans WHERE owner_id=? AND member_id=? AND id=? AND archived_at IS NULL',
  ).bind(owner, member, id).first<PlanRow>();

  async function listPlans(owner: string, member: string): Promise<MomentPlan[]> {
    const result = await db.prepare('SELECT * FROM workbench_moment_plans WHERE owner_id=? AND member_id=? AND archived_at IS NULL ORDER BY updated_at DESC,id LIMIT 20')
      .bind(owner, member).all<PlanRow>();
    return result.results.map(planFrom);
  }

  async function listDrafts(owner: string, member: string): Promise<MomentStoredDraft[]> {
    const result = await db.prepare('SELECT * FROM workbench_moment_drafts WHERE owner_id=? AND member_id=? ORDER BY created_at DESC,id DESC LIMIT 60')
      .bind(owner, member).all<DraftRow>();
    return result.results.map(draftFrom);
  }

  async function getDraft(owner: string, member: string, id: string): Promise<MomentStoredDraft> {
    const row = await db.prepare('SELECT * FROM workbench_moment_drafts WHERE owner_id=? AND member_id=? AND id=?').bind(owner, member, id).first<DraftRow>();
    if (!row) throw new DomainError('朋友圈草稿不存在', 404);
    return draftFrom(row);
  }

  async function savePlan(owner: string, member: string, input: MomentPlanInput, identity?: { id: string; version: number }, now = new Date().toISOString()): Promise<MomentPlan> {
    const id = identity?.id ?? `moment-plan-${crypto.randomUUID()}`;
    const eligible = await db.prepare(`SELECT ${memberEligible('?', '?')} AS eligible`).bind(owner, member).first<{ eligible: number }>();
    if (!eligible?.eligible) throw new DomainError('当前账号不能管理朋友圈计划', 403);
    const enabled = Number(input.enabled);
    const nextRunAt = input.enabled ? nextMomentAt(input.time, now) : null;
    const serialized = JSON.stringify(input);
    if (identity) {
      const previous = await ownPlan(owner, member, id);
      if (!previous) throw new DomainError('朋友圈计划不存在', 404);
      if (previous.version !== identity.version) throw changed();
      const keepNext = input.enabled && planFrom(previous).time === input.time;
      const result = await db.prepare(`UPDATE workbench_moment_plans AS p SET version=version+1,enabled=?,next_run_at=CASE WHEN ?=1 AND enabled=1 AND next_run_at IS NOT NULL THEN next_run_at ELSE ? END,updated_at=?,input_json=?
        WHERE p.owner_id=? AND p.member_id=? AND p.id=? AND p.version=? AND p.archived_at IS NULL AND ${memberEligible('p.owner_id', 'p.member_id')}`)
        .bind(enabled, Number(keepNext), nextRunAt, now, serialized, owner, member, id, identity.version).run();
      if (!result.meta.changes) throw changed();
    } else {
      const result = await db.prepare(`INSERT INTO workbench_moment_plans (id,owner_id,member_id,version,enabled,next_run_at,updated_at,input_json)
        SELECT ?,?,?,1,?,?,?,? WHERE ${memberEligible('?', '?')} AND
        (SELECT COUNT(*) FROM workbench_moment_plans WHERE owner_id=? AND member_id=? AND archived_at IS NULL)<20`)
        .bind(id, owner, member, enabled, nextRunAt, now, serialized, owner, member, owner, member).run();
      if (!result.meta.changes) throw new DomainError('最多保留 20 个朋友圈计划', 409);
    }
    const saved = await ownPlan(owner, member, id);
    if (!saved) throw changed();
    return planFrom(saved);
  }

  async function archivePlan(owner: string, member: string, id: string, version: number, now: string): Promise<void> {
    const result = await db.prepare(`UPDATE workbench_moment_plans AS p SET version=version+1,enabled=0,next_run_at=NULL,archived_at=?,updated_at=?
      WHERE p.owner_id=? AND p.member_id=? AND p.id=? AND p.version=? AND p.archived_at IS NULL AND ${memberEligible('p.owner_id', 'p.member_id')}`)
      .bind(now, now, owner, member, id, version).run();
    if (!result.meta.changes) throw changed();
  }

  async function queueManual(owner: string, member: string, planId: string, requestId: string, now: string): Promise<MomentStoredDraft> {
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) throw new DomainError('提交标识无效');
    const requestKey = `manual:${requestId}`;
    const existing = () => db.prepare(`SELECT d.* FROM workbench_moment_drafts AS d
      WHERE d.owner_id=? AND d.member_id=? AND d.request_key=? AND ${memberEligible('d.owner_id', 'd.member_id')}`)
      .bind(owner, member, requestKey).first<DraftRow>();
    const resolveRequest = (row: DraftRow) => {
      if (row.plan_id !== planId) throw new DomainError('相同提交标识对应的计划已变化', 409);
      return draftFrom(row);
    };
    const previous = await existing();
    if (previous) return resolveRequest(previous);
    const id = `moment-draft-${crypto.randomUUID()}`;
    const dayStart = new Date(`${momentDay(now)}T00:00:00+08:00`).toISOString();
    await db.prepare(`INSERT INTO workbench_moment_drafts (id,plan_id,owner_id,member_id,request_key,trigger,version,status,input_json,output_json,next_check_at,created_at,updated_at)
      SELECT ?,p.id,p.owner_id,p.member_id,?,'manual',1,'queued',p.input_json,'{}',?,?,? FROM workbench_moment_plans AS p
      WHERE p.owner_id=? AND p.member_id=? AND p.id=? AND p.archived_at IS NULL AND ${memberEligible('p.owner_id', 'p.member_id')}
      AND NOT EXISTS (SELECT 1 FROM workbench_moment_drafts d WHERE d.owner_id=p.owner_id AND d.member_id=p.member_id AND d.plan_id=p.id AND d.trigger='manual' AND d.status IN ${ACTIVE})
      AND (SELECT COUNT(*) FROM workbench_moment_drafts d WHERE d.owner_id=p.owner_id AND d.member_id=p.member_id AND d.trigger='manual' AND d.created_at>=?)<10
      ON CONFLICT(owner_id,member_id,request_key) DO NOTHING`)
      .bind(id, requestKey, now, now, now, owner, member, planId, dayStart).run();
    const saved = await existing();
    if (saved) return resolveRequest(saved);
    if (!await ownPlan(owner, member, planId)) throw new DomainError('朋友圈计划不存在', 404);
    throw new DomainError('该计划已有手动草稿在生成，或今天已达到手动生成上限', 409);
  }

  async function queueDue(now: string, limit = 5): Promise<MomentStoredDraft[]> {
    const due = await db.prepare(`SELECT p.* FROM workbench_moment_plans AS p
      WHERE p.enabled=1 AND p.archived_at IS NULL AND p.next_run_at<=? AND ${memberEligible('p.owner_id', 'p.member_id')}
      ORDER BY p.next_run_at,p.id LIMIT ?`).bind(now, batchLimit(limit)).all<PlanRow>();
    const queued: MomentStoredDraft[] = [];
    for (const plan of due.results) {
      const id = `moment-draft-${crypto.randomUUID()}`;
      const nextRunAt = nextMomentAt(planFrom(plan).time, now);
      // Catch up only the latest due occurrence. Editing the time after a run
      // cannot create a second automatic draft for that Shanghai day.
      const day = momentDay(new Date(Date.parse(nextRunAt) - DAY_MS).toISOString());
      const requestKey = `daily:${plan.id}:${day}`;
      const guard = `p.owner_id=? AND p.member_id=? AND p.id=? AND p.version=? AND p.next_run_at=? AND p.enabled=1 AND p.archived_at IS NULL
        AND ${memberEligible('p.owner_id', 'p.member_id')}`;
      const match = [plan.owner_id, plan.member_id, plan.id, plan.version, plan.next_run_at];
      const [created] = await db.batch([
        db.prepare(`INSERT INTO workbench_moment_drafts (id,plan_id,owner_id,member_id,request_key,trigger,version,status,input_json,output_json,next_check_at,created_at,updated_at)
          SELECT ?,p.id,p.owner_id,p.member_id,?,'daily',1,'queued',p.input_json,'{}',?,?,? FROM workbench_moment_plans AS p WHERE ${guard}
          ON CONFLICT(owner_id,member_id,request_key) DO NOTHING`).bind(id, requestKey, now, now, now, ...match),
        db.prepare(`UPDATE workbench_moment_plans AS p SET next_run_at=? WHERE ${guard}`).bind(nextRunAt, ...match),
      ]);
      if (created.meta.changes) queued.push(await getDraft(plan.owner_id, plan.member_id, id));
    }
    return queued;
  }

  async function listRunnable(now: string, limit = 5, scope?: { ownerId: string; memberId: string }): Promise<MomentStoredDraft[]> {
    const results = await db.prepare(`SELECT d.* FROM workbench_moment_drafts AS d WHERE ${runnable('d')}
      AND ${memberEligible('d.owner_id', 'd.member_id')} ${scope ? 'AND d.owner_id=? AND d.member_id=?' : ''}
      ORDER BY COALESCE(d.next_check_at,d.created_at),d.id LIMIT ?`)
      .bind(now, now, ...(scope ? [scope.ownerId, scope.memberId] : []), batchLimit(limit)).all<DraftRow>();
    return results.results.map(draftFrom);
  }

  async function reserveDraft(draft: MomentStoredDraft, now: string): Promise<MomentStoredDraft | null> {
    const token = crypto.randomUUID(), until = new Date(Date.parse(now) + LEASE_MS).toISOString();
    const result = await db.prepare(`UPDATE workbench_moment_drafts AS d SET version=version+1,lease_token=?,lease_until=?,
      status=CASE WHEN status='queued' THEN 'writing' ELSE status END,updated_at=?
      WHERE d.owner_id=? AND d.member_id=? AND d.id=? AND d.version=? AND ${runnable('d')} AND ${memberEligible('d.owner_id', 'd.member_id')}`)
      .bind(token, until, now, draft.ownerId, draft.memberId, draft.id, draft.version, now, now).run();
    return result.meta.changes ? getDraft(draft.ownerId, draft.memberId, draft.id) : null;
  }

  async function saveDraft(draft: MomentStoredDraft, fields: DraftChange, now = new Date().toISOString()): Promise<MomentStoredDraft> {
    if (!draft.leaseToken) throw changed();
    const value = { ...draft, ...fields };
    const { status, text, error, files, imagePrompt, imageTaskId, nextCheckAt } = value;
    const output = JSON.stringify({ text, error, files, imagePrompt, imageTaskId });
    const result = await db.prepare(`UPDATE workbench_moment_drafts AS d SET version=version+1,status=?,output_json=?,next_check_at=?,lease_token=NULL,lease_until=NULL,updated_at=?
      WHERE d.owner_id=? AND d.member_id=? AND d.id=? AND d.version=? AND d.lease_token=? AND d.lease_until>? AND ${memberEligible('d.owner_id', 'd.member_id')}`)
      .bind(status, output, nextCheckAt, now, draft.ownerId, draft.memberId, draft.id, draft.version, draft.leaseToken, now).run();
    if (!result.meta.changes) throw changed();
    return getDraft(draft.ownerId, draft.memberId, draft.id);
  }

  return { listPlans, listDrafts, savePlan, archivePlan, queueManual, queueDue, listRunnable, getDraft, reserveDraft, saveDraft };
}
