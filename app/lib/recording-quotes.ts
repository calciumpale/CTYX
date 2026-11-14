import { DomainError } from './domain.ts';
import { authorizedRecording } from './followup-recordings.ts';
import type { RecordingQuote } from './recording-quotes-types.ts';
import type { SpeechTranscriptionJob } from './speech-types.ts';
import type { WorkbenchState } from './types.ts';

type QuoteContext = {
  ownerId: string;
  memberId: string;
  manager: boolean;
  state: WorkbenchState;
};

type QuoteRow = {
  id: string;
  deal_id: string;
  recording_id: string;
  created_by: string;
  speaker: string;
  start_seconds: number;
  end_seconds: number;
  text: string;
  created_at: string;
};

type QuoteInput = {
  dealId: string;
  recordingId: string;
  jobId: string;
  segmentIndex: number;
};

const columns = 'id, deal_id, recording_id, created_by, speaker, start_seconds, end_seconds, text, created_at';
const initialized = new WeakMap<D1Database, Promise<void>>();
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value);
const notFound = () => new DomainError('金句或来源录音不存在，或当前账号无法访问。', 404);

function initialize(db: D1Database): Promise<void> {
  const existing = initialized.get(db);
  if (existing) return existing;
  const promise = (async () => {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS workbench_recording_quotes (
        owner_id TEXT NOT NULL,
        id TEXT NOT NULL,
        deal_id TEXT NOT NULL,
        recording_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        segment_index INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        speaker TEXT NOT NULL,
        start_seconds REAL NOT NULL,
        end_seconds REAL NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (owner_id, id),
        UNIQUE (owner_id, recording_id, job_id, segment_index)
      )
    `).run();
    await db.prepare(`
      CREATE INDEX IF NOT EXISTS workbench_recording_quotes_recent
      ON workbench_recording_quotes (owner_id, created_at DESC, id DESC)
    `).run();
  })().catch(error => {
    initialized.delete(db);
    throw error;
  });
  initialized.set(db, promise);
  return promise;
}

function parseInput(value: unknown): QuoteInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('请选择要摘录的转写段落。');
  const { dealId, recordingId, jobId, segmentIndex } = value as Record<string, unknown>;
  if (!identifier(dealId) || !identifier(recordingId) || !identifier(jobId) ||
    typeof segmentIndex !== 'number' || !Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex >= 6000) {
    throw new DomainError('请选择要摘录的转写段落。');
  }
  return { dealId, recordingId, jobId, segmentIndex };
}

function visibleRecordings(state: WorkbenchState) {
  return new Map(state.deals.flatMap(deal => deal.notes.flatMap(note =>
    note.recording ? [[note.recording.id, { dealId: deal.id, projectName: deal.projectName || deal.name, recordingName: note.recording.name }] as const] : [],
  )));
}

function toQuote(row: QuoteRow, context: QuoteContext, source: { projectName: string; recordingName: string }): RecordingQuote {
  return {
    id: row.id, dealId: row.deal_id, projectName: source.projectName, recordingId: row.recording_id,
    recordingName: source.recordingName, speaker: row.speaker, start: row.start_seconds, end: row.end_seconds,
    text: row.text, createdAt: row.created_at, canDelete: context.manager || context.memberId === row.created_by,
  };
}

/** State should already be projected to the current member's project scope. */
export function recordingQuoteStore(db: D1Database, context: QuoteContext) {
  async function list(cursor?: string | null): Promise<{ quotes: RecordingQuote[]; nextCursor: string | null }> {
    const [createdAt, id, extra] = cursor ? cursor.split('|') : [];
    if (cursor && (!createdAt || !identifier(id) || extra !== undefined || !Number.isFinite(Date.parse(createdAt)))) {
      throw new DomainError('金句分页位置无效，请重新加载。');
    }
    const sources = visibleRecordings(context.state);
    if (!sources.size) return { quotes: [], nextCursor: null };
    await initialize(db);
    const { results } = await db.prepare(`
      SELECT ${columns} FROM workbench_recording_quotes
      WHERE owner_id = ? AND recording_id IN (SELECT value FROM json_each(?))
        AND (? IS NULL OR (created_at, id) < (?, ?))
      ORDER BY created_at DESC, id DESC
      LIMIT 51
    `).bind(context.ownerId, JSON.stringify([...sources.keys()]), createdAt ?? null, createdAt ?? null, id ?? null).all<QuoteRow>();
    const rows = results.slice(0, 50);
    const quotes = rows.flatMap(row => {
      const source = sources.get(row.recording_id);
      return source?.dealId === row.deal_id ? [toQuote(row, context, source)] : [];
    });
    const last = rows.at(-1);
    return { quotes, nextCursor: results.length > 50 && last ? `${last.created_at}|${last.id}` : null };
  }

  async function save(value: unknown): Promise<RecordingQuote> {
    const { dealId, recordingId, jobId, segmentIndex } = parseInput(value);
    const recording = authorizedRecording(context.state, dealId, recordingId);
    const deal = context.state.deals.find(item => item.id === dealId)!;
    const source = { projectName: deal.projectName || deal.name, recordingName: recording.name };
    await initialize(db);

    const result = await db.prepare(`
      SELECT version, data_json FROM workbench_recording_transcriptions
      WHERE user_id = ? AND deal_id = ? AND recording_id = ?
    `).bind(context.ownerId, dealId, recordingId).first<{ version: number; data_json: string }>();
    const job = result ? JSON.parse(result.data_json) as SpeechTranscriptionJob : null;
    if (!result || !job || job.id !== jobId || job.dealId !== dealId || job.recordingId !== recordingId || job.status !== 'completed') {
      throw new DomainError('转写已更新或尚未完成。请重新打开录音后再摘录。', 409);
    }
    const segment = job.result?.segments[segmentIndex];
    if (!segment?.text.trim()) throw new DomainError('这段转写没有可摘录的文字。');
    const speaker = job.result?.speakers.find(item => item.id === segment.speaker)?.label || '未区分讲话人';
    await db.prepare(`
      INSERT INTO workbench_recording_quotes
      (owner_id, id, deal_id, recording_id, job_id, segment_index, created_by, speaker, start_seconds, end_seconds, text, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM workbench_recording_transcriptions
        WHERE user_id = ? AND deal_id = ? AND recording_id = ? AND version = ?)
      ON CONFLICT(owner_id, recording_id, job_id, segment_index) DO NOTHING
    `).bind(context.ownerId, `quote-${crypto.randomUUID()}`, dealId, recordingId, jobId, segmentIndex,
      context.memberId, speaker, segment.start, segment.end, segment.text, new Date().toISOString(),
      context.ownerId, dealId, recordingId, result.version).run();
    const saved = await db.prepare(`
      SELECT ${columns} FROM workbench_recording_quotes
      WHERE owner_id = ? AND deal_id = ? AND recording_id = ? AND job_id = ? AND segment_index = ?
    `).bind(context.ownerId, dealId, recordingId, jobId, segmentIndex).first<QuoteRow>();
    if (!saved) throw new DomainError('转写正在更新，请重新打开录音后再摘录。', 409);
    return toQuote(saved, context, source);
  }

  async function remove(id: unknown): Promise<void> {
    if (!identifier(id)) throw notFound();
    await initialize(db);
    const row = await db.prepare('SELECT deal_id, recording_id, created_by FROM workbench_recording_quotes WHERE owner_id = ? AND id = ?')
      .bind(context.ownerId, id).first<Pick<QuoteRow, 'deal_id' | 'recording_id' | 'created_by'>>();
    if (!row) throw notFound();
    authorizedRecording(context.state, row.deal_id, row.recording_id);
    if (!context.manager && context.memberId !== row.created_by) throw new DomainError('只有收藏者或销售管理者可以删除这条金句。', 403);
    await db.prepare('DELETE FROM workbench_recording_quotes WHERE owner_id = ? AND id = ?')
      .bind(context.ownerId, id).run();
  }

  return { list, save, remove };
}
