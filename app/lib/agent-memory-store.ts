import { DomainError } from './domain.ts';
import type { MemoryDream, MemoryNote, MemoryScope, MemoryTopic, MemoryTranscript } from './agent-memory-types.ts';

const schema = [
  `CREATE TABLE IF NOT EXISTS workbench_agent_memory_settings (
    owner_id TEXT NOT NULL, member_id TEXT NOT NULL, enabled INTEGER NOT NULL,
    PRIMARY KEY (owner_id, member_id)
  )`,
  `CREATE TABLE IF NOT EXISTS workbench_agent_memory_transcripts (
    owner_id TEXT NOT NULL, member_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL,
    query TEXT NOT NULL, answer TEXT NOT NULL, trace TEXT, created_at TEXT NOT NULL, capture_token TEXT,
    PRIMARY KEY (owner_id, member_id, project_id, run_id)
  )`,
  `CREATE TABLE IF NOT EXISTS workbench_agent_memory_notes (
    owner_id TEXT NOT NULL, member_id TEXT NOT NULL, project_id TEXT NOT NULL, id TEXT NOT NULL, run_id TEXT NOT NULL,
    kind TEXT NOT NULL, topic TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, quote TEXT NOT NULL,
    created_at TEXT NOT NULL, reviewed_at TEXT,
    PRIMARY KEY (owner_id, member_id, project_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS workbench_agent_memory_topics (
    owner_id TEXT NOT NULL, member_id TEXT NOT NULL, project_id TEXT NOT NULL, topic TEXT NOT NULL,
    title TEXT NOT NULL, body TEXT NOT NULL, source_ids_json TEXT NOT NULL, updated_at TEXT NOT NULL,
    version INTEGER NOT NULL, visible INTEGER NOT NULL, forgotten_at TEXT,
    PRIMARY KEY (owner_id, member_id, project_id, topic)
  )`,
  `CREATE TABLE IF NOT EXISTS workbench_agent_memory_writes (
    owner_id TEXT NOT NULL, member_id TEXT NOT NULL, project_id TEXT NOT NULL, write_token TEXT NOT NULL,
    PRIMARY KEY (owner_id, member_id, project_id)
  )`,
  `CREATE TABLE IF NOT EXISTS workbench_agent_memory_forgotten_sources (
    owner_id TEXT NOT NULL, member_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL,
    PRIMARY KEY (owner_id, member_id, project_id, run_id)
  )`,
  `CREATE INDEX IF NOT EXISTS agent_memory_transcripts_pending
    ON workbench_agent_memory_transcripts (owner_id, member_id, project_id, created_at, run_id) WHERE capture_token IS NULL`,
  `CREATE INDEX IF NOT EXISTS agent_memory_notes_pending
    ON workbench_agent_memory_notes (owner_id, member_id, project_id, created_at, id) WHERE reviewed_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS agent_memory_notes_topic
    ON workbench_agent_memory_notes (owner_id, member_id, project_id, topic, created_at)`,
];
const initialized = new WeakMap<D1Database, Promise<void>>();

const valid = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !!value.trim();
const badInput = () => new DomainError('Agent 记忆记录格式无效', 400);
const denied = () => new DomainError('当前账号无权管理 Agent 记忆', 403);
const limitTo = (value: number, max = 50) => Number.isFinite(value) ? Math.max(1, Math.min(max, Math.trunc(value))) : 10;

function scopeValues(scope: MemoryScope): [string, string, string] {
  if (!valid(scope.ownerId, 512) || !valid(scope.memberId, 256) || typeof scope.projectId !== 'string' || scope.projectId.length > 256) throw badInput();
  return [scope.ownerId, scope.memberId, scope.projectId];
}

const scopeWhere = (alias = '') => {
  const prefix = alias ? `${alias}.` : '';
  return `${prefix}owner_id=? AND ${prefix}member_id=? AND ${prefix}project_id=?`;
};
const sameScope = (a: string, b: string) => `${a}.owner_id=${b}.owner_id AND ${a}.member_id=${b}.member_id AND ${a}.project_id=${b}.project_id`;
const allowed = (owner: string, member: string, respectsPause = false, project?: string) => `EXISTS (
  SELECT 1 FROM workbench_member_accounts a
  WHERE a.owner_id=${owner} AND a.account_id=${member} AND a.enabled=1
    AND (a.role='manager' OR (a.role='sales' AND a.sales_id IS NOT NULL AND
      (SELECT COUNT(*) FROM workbench_member_accounts peers WHERE peers.owner_id=a.owner_id
        AND peers.role='sales' AND peers.enabled=1 AND peers.sales_id=a.sales_id)=1))
    ${respectsPause ? `AND NOT EXISTS (SELECT 1 FROM workbench_agent_memory_settings s
      WHERE s.owner_id=a.owner_id AND s.member_id=a.account_id AND s.enabled=0)` : ''}
    ${project ? `AND (${project}='' OR EXISTS (
      SELECT 1 FROM workbench_workspaces w, json_each(CASE WHEN json_valid(w.state_json) THEN w.state_json ELSE '{}' END,'$.deals') deal
      WHERE w.user_id=a.owner_id AND json_extract(deal.value,'$.id')=${project}
        AND (a.role='manager' OR json_extract(deal.value,'$.ownerId')=a.sales_id)
    ))` : ''}
)`;
const forgottenEvidence = (alias: string) => `EXISTS (SELECT 1 FROM workbench_agent_memory_forgotten_sources f
  WHERE ${sameScope('f', alias)} AND f.run_id=${alias}.run_id)`;

type TranscriptRow = { run_id: string; query: string; answer: string; trace: string | null; created_at: string };
type NoteRow = { id: string; run_id: string; kind: MemoryNote['kind']; topic: string; title: string; text: string; quote: string; created_at: string };
type TopicRow = { topic: string; title: string; body: string; source_ids_json: string; updated_at: string; version: number };
type ScopeRow = { owner_id: string; member_id: string; project_id: string };
interface WorkspaceGuard { sql: string; bindings: [string, number, string]; }

const transcriptFrom = (row: TranscriptRow): MemoryTranscript => ({ runId: row.run_id, query: row.query, answer: row.answer, createdAt: row.created_at, ...(row.trace === null ? {} : { trace: row.trace }) });
const noteFrom = (row: NoteRow): MemoryNote => ({ id: row.id, runId: row.run_id, kind: row.kind, topic: row.topic, title: row.title, text: row.text, quote: row.quote, createdAt: row.created_at });
const topicFrom = (row: TopicRow): MemoryTopic => ({ topic: row.topic, title: row.title, body: row.body, sourceIds: JSON.parse(row.source_ids_json) as string[], updatedAt: row.updated_at, version: row.version });

export function createAgentMemoryStore(db: D1Database, now: () => number = Date.now) {
  const stamp = () => new Date(now()).toISOString();

  function ready(): Promise<void> {
    let pending = initialized.get(db);
    if (!pending) {
      pending = db.batch(schema.map(sql => db.prepare(sql))).then(() => undefined).catch(error => {
        initialized.delete(db);
        throw error;
      });
      initialized.set(db, pending);
    }
    return pending;
  }

  /** The caller places this before its workspace UPDATE in the same atomic batch. */
  function transcriptStatement(scope: MemoryScope, transcript: MemoryTranscript, guard?: WorkspaceGuard): D1PreparedStatement {
    const values = scopeValues(scope);
    if (!valid(transcript.runId, 256) || typeof transcript.query !== 'string' || typeof transcript.answer !== 'string' ||
      !Number.isFinite(Date.parse(transcript.createdAt)) || (transcript.trace !== undefined && typeof transcript.trace !== 'string')) throw badInput();
    if (new TextEncoder().encode(transcript.query + transcript.answer + (transcript.trace ?? '')).length > 1_500_000) throw new DomainError('原始对话超过单条记忆存储容量', 413);
    return db.prepare(`INSERT INTO workbench_agent_memory_transcripts
      (owner_id,member_id,project_id,run_id,query,answer,trace,created_at)
      SELECT ?,?,?,?,?,?,?,? WHERE ${allowed('?', '?', true)} ${guard ? `AND EXISTS (${guard.sql})` : ''}
      ON CONFLICT(owner_id,member_id,project_id,run_id) DO NOTHING`)
      .bind(...values, transcript.runId, transcript.query, transcript.answer, transcript.trace ?? null, transcript.createdAt,
        scope.ownerId, scope.memberId, ...(guard?.bindings ?? []));
  }

  async function notes(scope: MemoryScope, limit: number, pendingOnly: boolean): Promise<MemoryNote[]> {
    await ready();
    const rows = await db.prepare(`SELECT n.* FROM workbench_agent_memory_notes n
      WHERE ${scopeWhere('n')} AND ${allowed('n.owner_id', 'n.member_id', pendingOnly)} AND NOT ${forgottenEvidence('n')}
      ${pendingOnly ? 'AND n.reviewed_at IS NULL' : `AND NOT EXISTS (SELECT 1 FROM workbench_agent_memory_topics p
        WHERE ${sameScope('p', 'n')} AND p.topic=n.topic AND n.created_at<=p.forgotten_at)`}
      ORDER BY n.created_at ${pendingOnly ? 'ASC' : 'DESC'}, n.id LIMIT ?`).bind(...scopeValues(scope), limitTo(limit)).all<NoteRow>();
    return rows.results.map(noteFrom);
  }

  async function transcripts(scope: MemoryScope, runIds: string[], evidenceOnly = false): Promise<MemoryTranscript[]> {
    if (!runIds.length) return [];
    if (runIds.length > 100 || runIds.some(id => !valid(id, 256))) throw badInput();
    await ready();
    const rows = await db.prepare(`SELECT t.* FROM workbench_agent_memory_transcripts t WHERE ${scopeWhere('t')}
      AND ${allowed('t.owner_id', 't.member_id', evidenceOnly)} AND t.run_id IN (SELECT value FROM json_each(?))
      ${evidenceOnly ? `AND NOT ${forgottenEvidence('t')}` : ''} ORDER BY t.created_at,t.run_id`)
      .bind(...scopeValues(scope), JSON.stringify(runIds)).all<TranscriptRow>();
    return rows.results.map(transcriptFrom);
  }

  async function topicsByKey(scope: MemoryScope, topics: string[]): Promise<MemoryTopic[]> {
    if (!topics.length) return [];
    if (topics.length > 24 || topics.some(topic => !valid(topic, 160))) throw badInput();
    await ready();
    const rows = await db.prepare(`SELECT p.* FROM workbench_agent_memory_topics p WHERE ${scopeWhere('p')}
      AND p.visible=1 AND ${allowed('p.owner_id', 'p.member_id')} AND p.topic IN (SELECT value FROM json_each(?))
      ORDER BY p.updated_at DESC,p.topic`).bind(...scopeValues(scope), JSON.stringify(topics)).all<TopicRow>();
    return rows.results.map(topicFrom);
  }

  async function forgetTopic(scope: MemoryScope, topic: string, version: number): Promise<boolean> {
    if (!valid(topic, 160) || !Number.isSafeInteger(version) || version < 0) throw badInput();
    await ready();
    if (version === 0) return false;
    const values = scopeValues(scope), at = stamp();
    const results = await db.batch([
      db.prepare(`INSERT INTO workbench_agent_memory_forgotten_sources (owner_id,member_id,project_id,run_id)
        SELECT p.owner_id,p.member_id,p.project_id,source.value FROM workbench_agent_memory_topics p, json_each(p.source_ids_json) source
        WHERE ${scopeWhere('p')} AND p.topic=? AND p.version=? AND p.visible=1 AND ${allowed('p.owner_id', 'p.member_id')}
        ON CONFLICT(owner_id,member_id,project_id,run_id) DO NOTHING`).bind(...values, topic, version),
      db.prepare(`UPDATE workbench_agent_memory_topics SET title='',body='',source_ids_json='[]',
        visible=0,forgotten_at=?,updated_at=?,version=version+1
        WHERE ${scopeWhere()} AND topic=? AND version=? AND visible=1 AND ${allowed('?', '?')}`)
        .bind(at, at, ...values, topic, version, scope.ownerId, scope.memberId),
      db.prepare(`UPDATE workbench_agent_memory_notes AS n SET reviewed_at=? WHERE ${scopeWhere('n')}
        AND ((n.topic=? AND n.created_at<=?) OR ${forgottenEvidence('n')}) AND n.reviewed_at IS NULL AND EXISTS (
          SELECT 1 FROM workbench_agent_memory_topics WHERE ${scopeWhere()}
          AND topic=? AND version=? AND visible=0 AND forgotten_at=?
        )`).bind(at, ...values, topic, at, ...values, topic, version + 1, at),
    ]);
    return results[1].meta.changes === 1;
  }

  async function applyDream(scope: MemoryScope, dream: MemoryDream): Promise<boolean> {
    const { examinedNoteIds, upsert, remove } = dream;
    const updates = [...upsert, ...remove];
    if (!examinedNoteIds.length || examinedNoteIds.length > 50 || updates.length > 30 || new Set(examinedNoteIds).size !== examinedNoteIds.length ||
      examinedNoteIds.some(id => !valid(id, 256)) || new Set(updates.map(item => item.topic)).size !== updates.length ||
      updates.some(item => !valid(item.topic, 160) || !Number.isSafeInteger(item.version) || item.version < 0) ||
      remove.some(item => item.version < 1) || upsert.some(item => !valid(item.title, 160) || !valid(item.body, 5000) ||
        !item.sourceIds.length || item.sourceIds.length > 30 || item.sourceIds.some(id => !valid(id, 256)))) throw badInput();
    await ready();
    const values = scopeValues(scope), at = stamp(), token = crypto.randomUUID();
    const noteIds = JSON.stringify(examinedNoteIds);
    const versions = JSON.stringify(updates.map(({ topic, version }) => ({ topic, version })));
    const sources = JSON.stringify(upsert.flatMap(item => item.sourceIds.map(runId => ({ topic: item.topic, runId }))));
    const ownsWrite = `EXISTS (SELECT 1 FROM workbench_agent_memory_writes WHERE ${scopeWhere()} AND write_token=?)`;
    const writeValues = [...values, token];
    // One scope write token gates all mutations. Its CAS checks the evidence and versions before any row is changed.
    const statements = [
      db.prepare(`INSERT INTO workbench_agent_memory_writes (owner_id,member_id,project_id,write_token)
        SELECT ?,?,?,'' WHERE ${allowed('?', '?', true)} ON CONFLICT(owner_id,member_id,project_id) DO NOTHING`)
        .bind(...values, scope.ownerId, scope.memberId),
      db.prepare(`UPDATE workbench_agent_memory_writes SET write_token=? WHERE ${scopeWhere()}
        AND ${allowed('?', '?', true)}
        AND (SELECT COUNT(*) FROM workbench_agent_memory_notes WHERE ${scopeWhere()} AND reviewed_at IS NULL
          AND id IN (SELECT value FROM json_each(?)))=?
        AND NOT EXISTS (SELECT 1 FROM json_each(?) requested
          LEFT JOIN workbench_agent_memory_topics p ON ${scopeWhere('p')}
            AND p.topic=json_extract(requested.value,'$.topic') AND p.visible=1
          WHERE COALESCE(p.version,0)<>json_extract(requested.value,'$.version'))
        AND NOT EXISTS (SELECT 1 FROM json_each(?) source
          LEFT JOIN workbench_agent_memory_transcripts t ON ${scopeWhere('t')}
            AND t.run_id=json_extract(source.value,'$.runId')
          LEFT JOIN workbench_agent_memory_topics p ON ${sameScope('p', 't')}
            AND p.topic=json_extract(source.value,'$.topic')
          WHERE t.run_id IS NULL OR t.created_at<=p.forgotten_at OR ${forgottenEvidence('t')})`)
        .bind(token, ...values, scope.ownerId, scope.memberId, ...values, noteIds, examinedNoteIds.length, versions, ...values, sources, ...values),
    ];
    for (const item of upsert) statements.push(db.prepare(`INSERT INTO workbench_agent_memory_topics
      (owner_id,member_id,project_id,topic,title,body,source_ids_json,updated_at,version,visible)
      SELECT ?,?,?,?,?,?,?,?,1,1 WHERE ${ownsWrite}
      ON CONFLICT(owner_id,member_id,project_id,topic) DO UPDATE SET title=excluded.title, body=excluded.body,
        source_ids_json=excluded.source_ids_json, updated_at=excluded.updated_at, visible=1, version=version+1`)
      .bind(...values, item.topic, item.title, item.body, JSON.stringify([...new Set(item.sourceIds)]), at, ...writeValues));
    for (const item of remove) {
      statements.push(db.prepare(`UPDATE workbench_agent_memory_topics SET title='',body='',source_ids_json='[]',
        visible=0,forgotten_at=?,updated_at=?,version=version+1 WHERE ${scopeWhere()} AND topic=? AND ${ownsWrite}`)
        .bind(at, at, ...values, item.topic, ...writeValues));
      statements.push(db.prepare(`UPDATE workbench_agent_memory_notes SET reviewed_at=? WHERE ${scopeWhere()}
        AND topic=? AND created_at<=? AND reviewed_at IS NULL AND ${ownsWrite}`)
        .bind(at, ...values, item.topic, at, ...writeValues));
    }
    statements.push(db.prepare(`UPDATE workbench_agent_memory_notes SET reviewed_at=? WHERE ${scopeWhere()}
      AND reviewed_at IS NULL AND id IN (SELECT value FROM json_each(?)) AND ${ownsWrite}`)
      .bind(at, ...values, noteIds, ...writeValues));
    const result = await db.batch(statements);
    return result[1].meta.changes === 1;
  }

  return {
    ready,
    transcriptStatement,
    forgetTopic,
    applyDream,
    async isEnabled(scope: MemoryScope): Promise<boolean> {
      scopeValues(scope);
      await ready();
      return Boolean(await db.prepare(`SELECT 1 WHERE ${allowed('?', '?', true)}`).bind(scope.ownerId, scope.memberId).first());
    },
    async setEnabled(scope: MemoryScope, enabled: boolean): Promise<void> {
      scopeValues(scope);
      if (typeof enabled !== 'boolean') throw badInput();
      await ready();
      const result = await db.prepare(`INSERT INTO workbench_agent_memory_settings (owner_id,member_id,enabled)
        SELECT ?,?,? WHERE ${allowed('?', '?')} ON CONFLICT(owner_id,member_id) DO UPDATE SET enabled=excluded.enabled`)
        .bind(scope.ownerId, scope.memberId, Number(enabled), scope.ownerId, scope.memberId).run();
      if (result.meta.changes !== 1) throw denied();
    },
    async appendTranscript(scope: MemoryScope, transcript: MemoryTranscript): Promise<boolean> {
      await ready();
      return (await transcriptStatement(scope, transcript).run()).meta.changes === 1;
    },
    async pendingTranscripts(scope: MemoryScope, limit: number): Promise<MemoryTranscript[]> {
      await ready();
      const rows = await db.prepare(`SELECT t.* FROM workbench_agent_memory_transcripts t WHERE ${scopeWhere('t')}
        AND t.capture_token IS NULL AND ${allowed('t.owner_id', 't.member_id', true)} ORDER BY t.created_at,t.run_id LIMIT ?`)
        .bind(...scopeValues(scope), limitTo(limit, 20)).all<TranscriptRow>();
      return rows.results.map(transcriptFrom);
    },
    transcripts: (scope: MemoryScope, runIds: string[]) => transcripts(scope, runIds),
    evidenceTranscripts: (scope: MemoryScope, runIds: string[]) => transcripts(scope, runIds, true),
    async completeCapture(scope: MemoryScope, runId: string, captured: MemoryNote[]): Promise<boolean> {
      if (!valid(runId, 256) || captured.length > 5 || new Set(captured.map(note => note.id)).size !== captured.length || captured.some(note =>
        note.runId !== runId || !['preference', 'practice', 'correction'].includes(note.kind) || !valid(note.id, 256) || !valid(note.topic, 160) ||
        !valid(note.title, 160) || !valid(note.text, 2000) || !valid(note.quote, 4000))) throw badInput();
      await ready();
      const values = scopeValues(scope), token = crypto.randomUUID();
      const statements = [db.prepare(`UPDATE workbench_agent_memory_transcripts SET capture_token=?
        WHERE ${scopeWhere()} AND run_id=? AND capture_token IS NULL AND ${allowed('?', '?', true)}
          AND NOT EXISTS (SELECT 1 FROM json_each(?) candidate WHERE instr(query,candidate.value)=0)`)
        .bind(token, ...values, runId, scope.ownerId, scope.memberId, JSON.stringify(captured.map(note => note.quote)))];
      for (const note of captured) statements.push(db.prepare(`INSERT INTO workbench_agent_memory_notes
        (owner_id,member_id,project_id,id,run_id,kind,topic,title,text,quote,created_at,reviewed_at)
        SELECT t.owner_id,t.member_id,t.project_id,?,t.run_id,?,?,?,?,?,t.created_at,
          CASE WHEN t.created_at<=p.forgotten_at THEN p.forgotten_at END
        FROM workbench_agent_memory_transcripts t
        LEFT JOIN workbench_agent_memory_topics p ON ${sameScope('p', 't')} AND p.topic=?
        WHERE ${scopeWhere('t')} AND t.run_id=? AND t.capture_token=?`)
        .bind(note.id, note.kind, note.topic, note.title, note.text, note.quote, note.topic, ...values, runId, token));
      const result = await db.batch(statements);
      return result[0].meta.changes === 1;
    },
    pendingNotes: (scope: MemoryScope, limit: number) => notes(scope, limit, true),
    recentNotes: (scope: MemoryScope, limit: number) => notes(scope, limit, false),
    topicsByKey,
    async topic(scope: MemoryScope, topic: string): Promise<MemoryTopic | null> {
      return (await topicsByKey(scope, [topic]))[0] ?? null;
    },
    async findTopics(scope: MemoryScope, terms: string[], limit: number): Promise<MemoryTopic[]> {
      const keys = [...new Set(terms.filter(term => valid(term, 48)).map(term => term.trim().toLowerCase()))].slice(0, 24);
      if (!keys.length) return [];
      await ready();
      const rows = await db.prepare(`WITH ranked AS (
        SELECT p.*, (SELECT SUM(CASE WHEN instr(lower(p.title),term.value)>0 THEN 4
          WHEN instr(lower(p.body),term.value)>0 THEN 1 ELSE 0 END) FROM json_each(?) term) AS score
        FROM workbench_agent_memory_topics p WHERE ${scopeWhere('p')} AND p.visible=1
          AND ${allowed('p.owner_id', 'p.member_id', true)}
      ) SELECT * FROM ranked WHERE score>0 ORDER BY score DESC,updated_at DESC,topic LIMIT ?`)
        .bind(JSON.stringify(keys), ...scopeValues(scope), limitTo(limit, 24)).all<TopicRow>();
      return rows.results.map(topicFrom);
    },
    async topics(scope: MemoryScope, limit: number): Promise<MemoryTopic[]> {
      await ready();
      const rows = await db.prepare(`SELECT p.* FROM workbench_agent_memory_topics p WHERE ${scopeWhere('p')}
        AND p.visible=1 AND ${allowed('p.owner_id', 'p.member_id')} ORDER BY p.updated_at DESC,p.topic LIMIT ?`)
        .bind(...scopeValues(scope), limitTo(limit)).all<TopicRow>();
      return rows.results.map(topicFrom);
    },
    async pendingScopes(limit: number, ownerId?: string): Promise<MemoryScope[]> {
      if (ownerId !== undefined && !valid(ownerId, 512)) throw badInput();
      await ready();
      const ownerFilter = ownerId === undefined ? '' : 'AND owner_id=?';
      const rows = await db.prepare(`WITH pending AS (
        SELECT owner_id,member_id,project_id,MIN(created_at) AS since FROM workbench_agent_memory_transcripts
          WHERE capture_token IS NULL ${ownerFilter} GROUP BY owner_id,member_id,project_id
        UNION ALL SELECT owner_id,member_id,project_id,MIN(created_at) FROM workbench_agent_memory_notes
          WHERE reviewed_at IS NULL ${ownerFilter} GROUP BY owner_id,member_id,project_id
      ) SELECT p.owner_id,p.member_id,p.project_id FROM pending p
        WHERE ${allowed('p.owner_id', 'p.member_id', true, 'p.project_id')}
        GROUP BY p.owner_id,p.member_id,p.project_id ORDER BY MIN(p.since),p.owner_id,p.member_id,p.project_id LIMIT ?`)
        .bind(...(ownerId === undefined ? [] : [ownerId, ownerId]), limitTo(limit, 30)).all<ScopeRow>();
      return rows.results.map(row => ({ ownerId: row.owner_id, memberId: row.member_id, projectId: row.project_id }));
    },
    async pendingCount(scope: MemoryScope): Promise<{ transcripts: number; notes: number }> {
      await ready();
      const values = scopeValues(scope);
      const result = await db.prepare(`SELECT
        (SELECT COUNT(*) FROM workbench_agent_memory_transcripts WHERE ${scopeWhere()} AND capture_token IS NULL) AS transcripts,
        (SELECT COUNT(*) FROM workbench_agent_memory_notes WHERE ${scopeWhere()} AND reviewed_at IS NULL) AS notes
        WHERE ${allowed('?', '?')}`).bind(...values, ...values, scope.ownerId, scope.memberId).first<{ transcripts: number; notes: number }>();
      return result ? { transcripts: result.transcripts, notes: result.notes } : { transcripts: 0, notes: 0 };
    },
  };
}
