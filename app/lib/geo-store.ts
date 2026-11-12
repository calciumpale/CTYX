import { DomainError } from './domain.ts';
import { checkGeoQuality, geoPublicUrl } from './geo-content.ts';
import type { GeoDocument, GeoObservation, GeoProject, GeoPublication, GeoStatus, GeoSummary } from './geo-types.ts';

export interface GeoActor {
  ownerId: string;
  memberId: string;
  role: 'sales' | 'manager';
}

interface GeoRow {
  owner_id: string;
  member_id: string;
  id: string;
  topic: string;
  title: string;
  status: GeoStatus;
  version: number;
  updated_at: string;
  document_json: string;
  review_note: string;
  reviewer_id: string | null;
  reviewed_at: string | null;
  publication_json: string | null;
  observations_json: string;
}

type GeoUpdate = Partial<Pick<GeoRow, 'topic' | 'title' | 'status' | 'document_json' | 'review_note' | 'reviewer_id' | 'reviewed_at' | 'publication_json' | 'observations_json'>>;
type SummaryRow = Pick<GeoRow, 'member_id' | 'id' | 'topic' | 'title' | 'status' | 'updated_at'>;

const notFound = () => new DomainError('GEO 稿件不存在或当前成员无权查看', 404);
const forbidden = () => new DomainError('当前成员无权执行此操作', 403);
const stale = () => new DomainError('稿件已更新，请重新打开后再试', 409);
const time = () => new Date().toISOString();
const editable = (status: GeoStatus) => status === 'draft' || status === 'changes_requested';

function projectFor(actor: GeoActor, row: GeoRow): GeoProject {
  const document = JSON.parse(row.document_json) as GeoDocument;
  const mine = actor.memberId === row.member_id;
  return {
    id: row.id,
    version: row.version,
    updatedAt: row.updated_at,
    status: row.status,
    document,
    quality: checkGeoQuality(document),
    reviewNote: row.review_note,
    ...(row.publication_json ? { publication: JSON.parse(row.publication_json) as GeoPublication } : {}),
    observations: JSON.parse(row.observations_json) as GeoObservation[],
    canEdit: mine && editable(row.status),
    canReview: actor.role === 'manager' && row.status === 'in_review',
    canRecord: mine && (row.status === 'approved' || row.status === 'published'),
  };
}

function recordText(value: unknown, label: string, maxLength: number, required = true): string {
  if (typeof value !== 'string' || value.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || required && !value.trim()) {
    throw new DomainError(`请填写有效的${label}，最多 ${maxLength} 字`, 400);
  }
  return value.trim();
}

function assertAuthor(actor: GeoActor, row: GeoRow): void {
  if (actor.memberId !== row.member_id) throw forbidden();
}

function assertVersion(row: GeoRow, version: number): void {
  if (row.version !== version) throw stale();
}

export function createGeoStore(db: D1Database) {
  const visible = "(member_id=? OR (?='manager' AND status<>'draft'))";

  async function find(actor: GeoActor, id: string): Promise<GeoRow | null> {
    return db.prepare(`SELECT * FROM workbench_geo_projects WHERE owner_id=? AND id=? AND ${visible}`)
      .bind(actor.ownerId, id, actor.memberId, actor.role).first<GeoRow>();
  }

  async function load(actor: GeoActor, id: string): Promise<GeoRow> {
    const row = await find(actor, id);
    if (!row) throw notFound();
    return row;
  }

  async function update(actor: GeoActor, row: GeoRow, patch: GeoUpdate, at = time()): Promise<GeoProject> {
    const next = { ...row, ...patch, updated_at: at, version: row.version + 1 };
    const result = await db.prepare(
      `UPDATE workbench_geo_projects SET
        topic=?,title=?,status=?,version=?,updated_at=?,document_json=?,review_note=?,reviewer_id=?,reviewed_at=?,publication_json=?,observations_json=?
       WHERE owner_id=? AND member_id=? AND id=? AND version=?`,
    ).bind(
      next.topic, next.title, next.status, next.version, at, next.document_json, next.review_note, next.reviewer_id,
      next.reviewed_at, next.publication_json, next.observations_json, actor.ownerId, row.member_id, row.id, row.version,
    ).run();
    if (result.meta.changes !== 1) throw stale();
    return projectFor(actor, next);
  }

  async function get(actor: GeoActor, id: string): Promise<GeoProject> {
    return projectFor(actor, await load(actor, id));
  }

  async function list(actor: GeoActor): Promise<GeoSummary[]> {
    const { results } = await db.prepare(
      `SELECT member_id,id,topic,title,status,updated_at FROM workbench_geo_projects WHERE owner_id=? AND ${visible}
       ORDER BY updated_at DESC,id`,
    ).bind(actor.ownerId, actor.memberId, actor.role).all<SummaryRow>();
    return results.map(row => ({
      id: row.id, topic: row.topic, title: row.title, status: row.status, updatedAt: row.updated_at, mine: actor.memberId === row.member_id,
    }));
  }

  async function save(actor: GeoActor, id: string, expected: number, document: GeoDocument): Promise<GeoProject> {
    const documentJson = JSON.stringify(document);
    const topic = document.brief.topic;
    const title = document.article.title;
    const at = time();
    const sameSave = (row: GeoRow): boolean =>
      row.member_id === actor.memberId && row.version === expected + 1 && row.status === 'draft' && row.document_json === documentJson;

    if (expected === 0) {
      const inserted = await db.prepare(
        `INSERT INTO workbench_geo_projects
         (owner_id,member_id,id,topic,title,status,version,updated_at,document_json,review_note,observations_json)
         VALUES (?,?,?,?,?,'draft',1,?,?,'','[]') ON CONFLICT(owner_id,id) DO NOTHING RETURNING *`,
      ).bind(actor.ownerId, actor.memberId, id, topic, title, at, documentJson).first<GeoRow>();
      if (inserted) return projectFor(actor, inserted);
      const row = await find(actor, id);
      if (row && sameSave(row)) return projectFor(actor, row);
      throw stale();
    }

    const row = await load(actor, id);
    assertAuthor(actor, row);
    if (sameSave(row)) return projectFor(actor, row);
    assertVersion(row, expected);
    if (!editable(row.status)) throw new DomainError('当前审核状态下不能编辑稿件', 409);
    try {
      return await update(actor, row, { topic, title, status: 'draft', document_json: documentJson }, at);
    } catch (error) {
      if (!(error instanceof DomainError) || error.status !== 409) throw error;
      const latest = await find(actor, id);
      if (latest && sameSave(latest)) return projectFor(actor, latest);
      throw error;
    }
  }

  async function submit(actor: GeoActor, id: string, version: number): Promise<GeoProject> {
    const row = await load(actor, id);
    assertAuthor(actor, row);
    assertVersion(row, version);
    if (!editable(row.status)) throw new DomainError('只有草稿或待修改稿件可以提交审核', 409);
    const quality = checkGeoQuality(JSON.parse(row.document_json) as GeoDocument);
    if (!quality.ready) throw new DomainError('请先完成稿件检查中缺少的内容，再提交审核', 400);
    return update(actor, row, { status: 'in_review' });
  }

  async function review(actor: GeoActor, id: string, version: number, decision: unknown, note: unknown): Promise<GeoProject> {
    if (actor.role !== 'manager') throw forbidden();
    const row = await load(actor, id);
    assertVersion(row, version);
    if (row.status !== 'in_review') throw new DomainError('当前稿件没有待处理的审核', 409);
    if (decision !== 'approve' && decision !== 'changes') throw new DomainError('请选择审核结论', 400);
    const reviewNote = recordText(note ?? '', '审核意见', 1500, decision === 'changes');
    const at = time();
    return update(actor, row, {
      status: decision === 'approve' ? 'approved' : 'changes_requested',
      review_note: reviewNote,
      reviewer_id: actor.memberId,
      reviewed_at: at,
    }, at);
  }

  async function publish(actor: GeoActor, id: string, version: number, url: unknown, channel: unknown): Promise<GeoProject> {
    const row = await load(actor, id);
    assertAuthor(actor, row);
    assertVersion(row, version);
    if (row.status !== 'approved') throw new DomainError('审核通过后才可以登记已发布的稿件', 409);
    const at = time();
    const publication: GeoPublication = { url: geoPublicUrl(url, '发布链接'), channel: recordText(channel, '发布渠道', 120), recordedAt: at };
    return update(actor, row, { status: 'published', publication_json: JSON.stringify(publication) }, at);
  }

  async function observe(actor: GeoActor, id: string, version: number, engine: unknown, query: unknown, result: unknown, evidence: unknown): Promise<GeoProject> {
    const row = await load(actor, id);
    assertAuthor(actor, row);
    assertVersion(row, version);
    if (row.status !== 'published') throw new DomainError('登记发布链接后才可以记录可见性观察', 409);
    if (result !== 'mentioned' && result !== 'not_mentioned' && result !== 'unclear') throw new DomainError('请选择有效的观察结果', 400);
    const at = time();
    const observation: GeoObservation = {
      id: crypto.randomUUID(),
      engine: recordText(engine, '搜索引擎', 120),
      query: recordText(query, '查询问题', 600),
      result,
      evidence: recordText(evidence, '人工观察依据', 1500),
      recordedAt: at,
    };
    const observations = JSON.parse(row.observations_json) as GeoObservation[];
    const observationsJson = JSON.stringify([observation, ...observations]);
    if (new TextEncoder().encode(row.document_json + observationsJson).byteLength > 1800000) throw new DomainError('此稿件的可见性记录已达存储上限', 413);
    return update(actor, row, { observations_json: observationsJson }, at);
  }

  return { get, list, save, submit, review, publish, observe };
}
