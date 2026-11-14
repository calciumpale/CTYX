import { DomainError, projectState } from './domain.ts';
import { authorizedRecording } from './followup-recordings.ts';
import { organizeRecording, recordingProfileKeys, suggestRecordingProject, type RecordingModel } from './recording-processing-model.ts';
import type { RecordingProcessingApply, RecordingProcessingDraft, RecordingProcessingSource, RecordingProcessingStatus } from './recording-processing-types.ts';
import type { SalesScope } from './sales-scope.ts';
import type { GuardedWorkspacePrecondition, GuardedWorkspaceWrite } from './sales-report-store.ts';
import type { SpeechTranscriptionJob } from './speech-types.ts';
import type { CustomerProfile, Deal, Role, WorkbenchState } from './types.ts';

type Context = { ownerId: string; memberId: string; role: Role; salesScope?: SalesScope };
type DraftRow = { draft_json: string };

const initialized = new WeakMap<D1Database, Promise<void>>();
const notFound = () => new DomainError('录音、草稿或目标项目不存在，或当前账号无法访问。', 404);
const alreadyApplied = () => new DomainError('这份录音已经确认写入项目。', 409);
const staleSource = () => new DomainError('转写已更新或尚未完成，请重新打开录音后再整理。', 409);
const staleDraft = () => new DomainError('项目或整理草稿已更新，请重新整理后再确认。', 409);

function initialize(db: D1Database) {
  const cached = initialized.get(db);
  if (cached) return cached;
  const promise = (async () => {
    await db.prepare(`CREATE TABLE IF NOT EXISTS workbench_recording_processing_drafts (
      owner_id TEXT NOT NULL, member_id TEXT NOT NULL, recording_id TEXT NOT NULL, source_deal_id TEXT NOT NULL,
      job_id TEXT NOT NULL, requested_target_id TEXT NOT NULL, id TEXT NOT NULL, draft_json TEXT NOT NULL,
      PRIMARY KEY (owner_id, member_id, recording_id, requested_target_id), UNIQUE (owner_id, id)
    )`).run();
    await db.prepare(`CREATE TABLE IF NOT EXISTS workbench_recording_processing_receipts (
      owner_id TEXT NOT NULL, recording_id TEXT NOT NULL, source_deal_id TEXT NOT NULL, job_id TEXT NOT NULL,
      target_deal_id TEXT NOT NULL, draft_id TEXT NOT NULL, member_id TEXT NOT NULL, applied_at TEXT NOT NULL,
      PRIMARY KEY (owner_id, recording_id)
    )`).run();
  })().catch(error => { initialized.delete(db); throw error; });
  initialized.set(db, promise);
  return promise;
}

function fields(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new DomainError('录音处理参数不正确。');
  }
  return value as Record<string, unknown>;
}
function identifier(value: unknown) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(value)) throw new DomainError('录音处理标识不正确。');
  return value;
}
function parseSource(value: unknown): RecordingProcessingSource {
  const input = fields(value, ['dealId', 'recordingId', 'jobId', 'targetDealId']);
  return {
    dealId: identifier(input.dealId), recordingId: identifier(input.recordingId), jobId: identifier(input.jobId),
    ...(input.targetDealId == null || input.targetDealId === '' ? {} : { targetDealId: identifier(input.targetDealId) }),
  };
}

export function parseRecordingProcessingApply(value: unknown): RecordingProcessingApply {
  const input = fields(value, ['dealId', 'version', 'sourceDealId', 'recordingId', 'jobId', 'draftId', 'profile', 'followup', 'confirmed']);
  if (input.confirmed !== true) throw new DomainError('请先人工核对录音整理内容及目标项目。');
  if (typeof input.version !== 'number' || !Number.isSafeInteger(input.version) || input.version < 1) throw staleDraft();
  const profile: Partial<CustomerProfile> = {};
  for (const [key, raw] of Object.entries(fields(input.profile, [...recordingProfileKeys]))) {
    if (typeof raw !== 'string' || raw.length > 2000) throw new DomainError('每项客户画像最多 2,000 字。');
    if (raw.trim()) profile[key as keyof CustomerProfile] = raw.trim();
  }
  if (typeof input.followup !== 'string' || input.followup.length > 6000) throw new DomainError('跟进记录最多 6,000 字。');
  const followup = input.followup.trim();
  if (!followup && !Object.keys(profile).length) throw new DomainError('请填写至少一项要写入的内容。');
  return { dealId: identifier(input.dealId), version: input.version, sourceDealId: identifier(input.sourceDealId), recordingId: identifier(input.recordingId),
    jobId: identifier(input.jobId), draftId: identifier(input.draftId), profile, followup };
}

function activeProject(deals: Deal[], target: string) {
  const project = deals.find(deal => deal.id === target && !deal.archive);
  if (!project) throw notFound();
  return project;
}

function exactSourceJob(context: Context, source: RecordingProcessingSource) {
  return { sql: `EXISTS (SELECT 1 FROM workbench_recording_transcriptions WHERE user_id = ? AND deal_id = ? AND recording_id = ?
    AND json_extract(data_json, '$.id') = ? AND json_extract(data_json, '$.status') = 'completed')`,
  bindings: [context.ownerId, source.dealId, source.recordingId, source.jobId] };
}

function unusedRecording(context: Context, recordingId: string) {
  return { sql: 'NOT EXISTS (SELECT 1 FROM workbench_recording_processing_receipts WHERE owner_id = ? AND recording_id = ?)',
    bindings: [context.ownerId, recordingId] };
}

export function createRecordingProcessing(db: D1Database) {
  function authorize(context: Context, state: WorkbenchState, source: RecordingProcessingSource) {
    if (context.role === 'sales' && !context.salesScope) throw new DomainError('销售账号归属无效。', 401);
    const visible = projectState(state, context.role, context.salesScope);
    authorizedRecording(visible, source.dealId, source.recordingId);
    return visible.deals;
  }

  async function completedResult(context: Context, source: RecordingProcessingSource) {
    const row = await db.prepare(`SELECT data_json FROM workbench_recording_transcriptions WHERE user_id = ? AND deal_id = ? AND recording_id = ?`)
      .bind(context.ownerId, source.dealId, source.recordingId).first<{ data_json: string }>();
    const job = row ? JSON.parse(row.data_json) as SpeechTranscriptionJob : null;
    if (!job || job.id !== source.jobId || job.dealId !== source.dealId || job.recordingId !== source.recordingId || job.status !== 'completed' || !job.result) throw staleSource();
    return job.result;
  }

  const appliedTarget = async (context: Context, source: RecordingProcessingSource) =>
    (await db.prepare(`SELECT target_deal_id FROM workbench_recording_processing_receipts WHERE owner_id = ? AND recording_id = ? AND source_deal_id = ?`)
      .bind(context.ownerId, source.recordingId, source.dealId).first<{ target_deal_id: string }>())?.target_deal_id;

  async function read(context: Context, state: WorkbenchState, input: unknown): Promise<RecordingProcessingStatus> {
    const source = parseSource(input);
    const deals = authorize(context, state, source);
    if (source.targetDealId) activeProject(deals, source.targetDealId);
    await initialize(db);
    const applied = await appliedTarget(context, source);
    if (applied) {
      const targetVisible = deals.some(deal => deal.id === applied);
      const row = targetVisible ? await db.prepare(`SELECT draft.draft_json FROM workbench_recording_processing_receipts receipt
        JOIN workbench_recording_processing_drafts draft ON draft.owner_id = receipt.owner_id AND draft.id = receipt.draft_id
        WHERE receipt.owner_id = ? AND receipt.recording_id = ? AND receipt.source_deal_id = ? AND receipt.member_id = ?`)
        .bind(context.ownerId, source.recordingId, source.dealId, context.memberId).first<DraftRow>() : null;
      return { draft: row ? JSON.parse(row.draft_json) as RecordingProcessingDraft : null, applied: true, appliedDealId: targetVisible ? applied : null };
    }
    const sourceJob = exactSourceJob(context, source);
    const row = await db.prepare(`SELECT draft_json FROM workbench_recording_processing_drafts
      WHERE owner_id = ? AND member_id = ? AND recording_id = ? AND source_deal_id = ? AND job_id = ? AND requested_target_id = ? AND ${sourceJob.sql}`)
      .bind(context.ownerId, context.memberId, source.recordingId, source.dealId, source.jobId, source.targetDealId ?? '', ...sourceJob.bindings).first<DraftRow>();
    const draft = row ? JSON.parse(row.draft_json) as RecordingProcessingDraft : null;
    const current = !draft?.matchedDealId || deals.some(deal => !deal.archive && deal.id === draft.matchedDealId && deal.version === draft.targetVersion);
    return { draft: current ? draft : null, applied: false, appliedDealId: null };
  }

  async function generate(context: Context, state: WorkbenchState, input: unknown, model: RecordingModel) {
    const source = parseSource(input);
    const deals = authorize(context, state, source).filter(deal => !deal.archive);
    const selection = source.targetDealId ? activeProject(deals, source.targetDealId) : undefined;
    await initialize(db);
    if (await appliedTarget(context, source)) throw alreadyApplied();
    const organized = await organizeRecording(await completedResult(context, source), model);
    const match = suggestRecordingProject(organized, deals, selection);
    const draft: RecordingProcessingDraft = { id: crypto.randomUUID(), summary: organized.summary, decisions: organized.decisions,
      followup: organized.followup, projectName: organized.projectName || organized.companyName, matchedDealId: match.target?.id ?? null,
      matchReason: match.matchReason, profile: organized.profile, evidence: organized.evidence, targetVersion: match.target?.version ?? null };
    const sourceJob = exactSourceJob(context, source);
    const pending = unusedRecording(context, source.recordingId);
    const saved = await db.prepare(`INSERT INTO workbench_recording_processing_drafts
      (owner_id, member_id, recording_id, source_deal_id, job_id, requested_target_id, id, draft_json)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${sourceJob.sql} AND ${pending.sql}
      ON CONFLICT (owner_id, member_id, recording_id, requested_target_id) DO UPDATE
      SET source_deal_id = excluded.source_deal_id, job_id = excluded.job_id, id = excluded.id, draft_json = excluded.draft_json`)
      .bind(context.ownerId, context.memberId, source.recordingId, source.dealId, source.jobId, source.targetDealId ?? '', draft.id, JSON.stringify(draft),
        ...sourceJob.bindings, ...pending.bindings).run();
    if (!saved.meta.changes) throw await appliedTarget(context, source) ? alreadyApplied() : staleSource();
    return draft;
  }

  async function prepareApply(context: Context, state: WorkbenchState, input: unknown, at = new Date().toISOString()) {
    const apply = parseRecordingProcessingApply(input);
    const source = { dealId: apply.sourceDealId, recordingId: apply.recordingId, jobId: apply.jobId };
    const deals = authorize(context, state, source);
    await initialize(db);
    if (await appliedTarget(context, source)) throw alreadyApplied();
    const target = activeProject(deals, apply.dealId);
    if (target.version !== apply.version) throw staleDraft();
    const draftBindings = [context.ownerId, context.memberId, source.dealId, source.recordingId, source.jobId, apply.draftId];
    const draftWhere = 'owner_id = ? AND member_id = ? AND source_deal_id = ? AND recording_id = ? AND job_id = ? AND id = ?';
    const row = await db.prepare(`SELECT draft_json FROM workbench_recording_processing_drafts WHERE ${draftWhere}`).bind(...draftBindings).first<DraftRow>();
    if (!row) throw notFound();
    const draft = JSON.parse(row.draft_json) as RecordingProcessingDraft;
    if (draft.matchedDealId !== target.id || draft.targetVersion !== target.version) throw staleDraft();
    await completedResult(context, source);

    const sourceJob = exactSourceJob(context, source);
    const precondition: GuardedWorkspacePrecondition = {
      sql: `${sourceJob.sql} AND EXISTS (SELECT 1 FROM workbench_recording_processing_drafts WHERE ${draftWhere})`,
      bindings: [...sourceJob.bindings, ...draftBindings],
    };
    const receipt: GuardedWorkspaceWrite = guard => db.prepare(`INSERT INTO workbench_recording_processing_receipts
      (owner_id, recording_id, source_deal_id, job_id, target_deal_id, draft_id, member_id, applied_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${guard.sql})`)
      .bind(context.ownerId, source.recordingId, source.dealId, source.jobId, target.id, draft.id, context.memberId, at, ...guard.bindings);
    return { draft, apply, receipt, precondition };
  }

  return { read, generate, prepareApply };
}
