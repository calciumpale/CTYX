import { DomainError } from './domain.ts';
import { isRecordingId, prepareRecording, persistRecordingObject, type RecordingObjectStore } from './followup-recordings.ts';
import type { RecordingInboxEntry, RecordingInboxPage } from './recording-inbox-types.ts';

type Row = { id: string; name: string; size: number; mime_type: string; created_at: string };
const columns = 'id, name, size, mime_type, created_at';
const ready = new WeakMap<D1Database, Promise<void>>();
const notFound = () => new DomainError('录音不存在或当前账号无法访问。', 404);

export function ensureRecordingInbox(db: D1Database) {
  const existing = ready.get(db);
  if (existing) return existing;
  const initialized = (async () => {
    await db.prepare(`CREATE TABLE IF NOT EXISTS workbench_recording_inbox (
      owner_id TEXT NOT NULL, member_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
      size INTEGER NOT NULL, mime_type TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (owner_id, id)
    )`).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS workbench_recording_inbox_member_recent
      ON workbench_recording_inbox (owner_id, member_id, created_at DESC, id DESC)`).run();
  })().catch(error => { ready.delete(db); throw error; });
  ready.set(db, initialized);
  return initialized;
}

function entry(row: Row): RecordingInboxEntry {
  return { recording: { id: row.id, name: row.name, size: row.size, mimeType: row.mime_type, sourceOnly: true }, createdAt: row.created_at };
}

function scope(ownerId: string, memberId: string | undefined) {
  if (!ownerId || ownerId.length > 512 || !memberId || memberId.length > 512) throw new DomainError('请先登录工作台。', 401);
  return [ownerId, memberId];
}

export async function readRecordingInboxSource(db: D1Database, ownerId: string, memberId: string | undefined, recordingId: string) {
  if (!isRecordingId(recordingId)) throw notFound();
  const identities = scope(ownerId, memberId);
  await ensureRecordingInbox(db);
  const row = await db.prepare(`SELECT ${columns} FROM workbench_recording_inbox WHERE owner_id = ? AND member_id = ? AND id = ?`)
    .bind(...identities, recordingId).first<Row>();
  if (!row) throw notFound();
  return entry(row);
}

export async function listRecordingInbox(db: D1Database, ownerId: string, memberId: string | undefined, cursor?: string | null): Promise<RecordingInboxPage> {
  const identities = scope(ownerId, memberId);
  let position: [string, string] | [] = [];
  if (cursor != null) {
    const [date, id, extra] = cursor.length < 140 ? cursor.split('|') : [];
    if (extra !== undefined || !isRecordingId(id) || !date || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(date) || !Number.isFinite(Date.parse(date))) {
      throw new DomainError('录音列表位置无效，请重新加载。');
    }
    position = [date, id];
  }
  await ensureRecordingInbox(db);
  const { results } = await db.prepare(`SELECT ${columns} FROM workbench_recording_inbox
    WHERE owner_id = ? AND member_id = ?${position.length ? ' AND (created_at, id) < (?, ?)' : ''}
    ORDER BY created_at DESC, id DESC LIMIT 51`).bind(...identities, ...position).all<Row>();
  const rows = results.slice(0, 50);
  const last = rows.at(-1);
  return { recordings: rows.map(entry), nextCursor: results.length > 50 && last ? `${last.created_at}|${last.id}` : null };
}

export async function saveRecordingInboxSource(db: D1Database, ownerId: string, memberId: string | undefined, file: File, bucket: RecordingObjectStore): Promise<RecordingInboxEntry> {
  const identities = scope(ownerId, memberId);
  const { recording, bytes } = await prepareRecording(file, true);
  const createdAt = new Date().toISOString();
  await ensureRecordingInbox(db);
  await persistRecordingObject(ownerId, recording, bytes, bucket, () => db.prepare(`INSERT INTO workbench_recording_inbox
    (owner_id, member_id, id, name, size, mime_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(...identities, recording.id, recording.name, recording.size, recording.mimeType, createdAt).run());
  return { recording, createdAt };
}
