import { DomainError } from './domain.ts';
import { checkGeoQuality, geoPublicUrl } from './geo-content.ts';
import { geoSampleKey } from './geo-metrics.ts';
import { emptyGeoWorkflow, type GeoAnswer, type GeoCaptureAttempt, type GeoCaptureResponse, type GeoCaptureSlot, type GeoDocument, type GeoObservation, type GeoProject, type GeoProviderAnswer, type GeoPublication, type GeoStatus, type GeoSummary, type GeoWorkflow } from './geo-types.ts';
import { buildGeoProviderAnswer, parseGeoAnswer, parseGeoGaps, parseGeoPlan, parseGeoSlot } from './geo-workflow.ts';

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
const running = (attempt: GeoCaptureAttempt) => attempt.status === 'running' && Date.now() - Date.parse(attempt.startedAt) < 120000;
const unknownCapture = '无法确认 API Mart 的采样结果，本次调用可能已计费。';
type CaptureProvider = { engines: string[]; supports?: (engine: string) => boolean; capture: (engine: string, prompt: string, options?: {model?: string; webSearch?: boolean}) => Promise<GeoProviderAnswer> };

// Store the monitoring workflow beside the article in its existing CAS-protected JSON row.
function storedDocument(row: GeoRow) {
  const { workflow: saved, ...document } = JSON.parse(row.document_json) as GeoDocument & { workflow?: GeoWorkflow };
  return { document, workflow: saved ?? emptyGeoWorkflow(), hasWorkflow: Boolean(saved) };
}

function storeDocument(document: GeoDocument, workflow?: GeoWorkflow) {
  return JSON.stringify(workflow ? { ...document, workflow } : document);
}

function assertSize(document: string, observations: string) {
  if (new TextEncoder().encode(document + observations).byteLength > 1800000) throw new DomainError('此 GEO 项目的存储容量已满，请另建项目继续。', 413);
}

function projectFor(actor: GeoActor, row: GeoRow): GeoProject {
  const { document, workflow } = storedDocument(row);
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
    workflow,
    canEditWorkflow: mine,
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

  async function save(actor: GeoActor, id: string, expected: number, document: GeoDocument, rawPlan?: unknown): Promise<GeoProject> {
    const plan = rawPlan === undefined ? undefined : parseGeoPlan(rawPlan);
    const topic = document.brief.topic;
    const title = document.article.title;
    const at = time();
    const nextDocument = (row?: GeoRow) => {
      const saved = row ? storedDocument(row) : undefined;
      return storeDocument(document, plan ? { ...(saved?.workflow ?? emptyGeoWorkflow()), ...plan } : saved?.hasWorkflow ? saved.workflow : undefined);
    };
    const sameSave = (row: GeoRow): boolean =>
      row.member_id === actor.memberId && row.version === expected + 1 && row.status === 'draft' && row.document_json === nextDocument(row);

    if (expected === 0) {
      const documentJson = nextDocument();
      assertSize(documentJson, '[]');
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
    const documentJson = nextDocument(row);
    assertSize(documentJson, row.observations_json);
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
    const quality = checkGeoQuality(storedDocument(row).document);
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
    assertSize(row.document_json, observationsJson);
    return update(actor, row, { observations_json: observationsJson }, at);
  }

  async function updateWorkflow(actor: GeoActor, row: GeoRow, document: GeoDocument, workflow: GeoWorkflow, at = time()) {
    const documentJson = storeDocument(document, workflow);
    assertSize(documentJson, row.observations_json);
    return update(actor, row, { document_json: documentJson }, at);
  }

  async function ownedProject(actor: GeoActor, id: string, version: number) {
    const row = await load(actor, id);
    assertAuthor(actor, row);
    assertVersion(row, version);
    return row;
  }

  async function workflow(actor: GeoActor, id: string, version: number, rawPlan: unknown) {
    const row = await ownedProject(actor, id, version);
    const current = storedDocument(row);
    return updateWorkflow(actor, row, current.document, { ...current.workflow, ...parseGeoPlan(rawPlan) });
  }

  function sampleSnapshot(document: GeoDocument, workflow: GeoWorkflow, input: GeoCaptureSlot) {
    const question = workflow.questions.find(question => question.id === input.questionId);
    if (!question || !workflow.engines.includes(input.engine) || input.sample > workflow.repeats) throw new DomainError('先将该提问、引擎与采样序号加入计划。');
    const brand = document.brief.brand;
    if (!brand.trim()) throw new DomainError('先填写要追踪的品牌。');
    return { ...input, prompt: question.prompt, dimension: question.dimension, intent: question.intent, brand };
  }

  function sampleReady(row: GeoRow, workflow: GeoWorkflow, slot: GeoCaptureSlot, key: string, method: GeoAnswer['method']) {
    if (workflow.answers.some(other => other.phase === slot.phase && geoSampleKey(other) === key)) {
      throw new DomainError('该问题、引擎与采样序号已记录，请改用其他序号。', 409);
    }
    if (workflow.captureAttempts?.some(attempt => attempt.sampleKey === key && attempt.slot.phase === slot.phase && running(attempt))) {
      throw new DomainError('该答案正在通过 API Mart 采样，请稍后查询。', 409);
    }
    const baseline = slot.phase === 'retest' ? workflow.answers.find(other => other.phase === 'baseline' && geoSampleKey(other) === key && other.method === method) : undefined;
    if (slot.phase === 'retest' && (row.status !== 'published' || !row.publication_json || !baseline)) {
      throw new DomainError('登记发布链接并具备同一问题、引擎、序号和采集方式的基线后才可复测。', 409);
    }
    if (workflow.answers.length >= 600) throw new DomainError('本项目已达到 600 条答案记录，请另建项目继续。', 413);
    return baseline;
  }

  async function capture(actor: GeoActor, id: string, version: number, rawAnswer: unknown) {
    const row = await ownedProject(actor, id, version);
    const { document, workflow } = storedDocument(row);
    const input = parseGeoAnswer(rawAnswer, workflow);
    const answer: GeoAnswer = { ...input, ...sampleSnapshot(document, workflow, input), method: 'manual', recordedAt: time() };
    if (workflow.answers.some(other => other.id === answer.id) || workflow.captureAttempts?.some(attempt => attempt.id === answer.id)) throw new DomainError('采样标识已使用。', 409);
    sampleReady(row, workflow, answer, geoSampleKey(answer), 'manual');
    return updateWorkflow(actor, row, document, { ...workflow, answers: [answer, ...workflow.answers] }, answer.recordedAt);
  }

  function captureResponse(actor: GeoActor, row: GeoRow, attempt: GeoCaptureAttempt): GeoCaptureResponse {
    const expired = attempt.status === 'running' && !running(attempt);
    return { project: projectFor(actor, row), capture: expired ? { status: 'unknown', message: unknownCapture }
      : { status: attempt.status, ...(attempt.message ? { message: attempt.message } : {}) } };
  }

  async function completeCapture(actor: GeoActor, id: string, started: GeoCaptureAttempt, outcome: GeoCaptureResponse['capture'], answer?: GeoAnswer): Promise<GeoCaptureResponse> {
    for (let retry = 0; retry < 4; retry++) {
      const row = await load(actor, id);
      assertAuthor(actor, row);
      const {document, workflow} = storedDocument(row);
      const attempts = workflow.captureAttempts ?? [];
      const position = attempts.findIndex(attempt => attempt.id === started.id);
      const current = attempts[position];
      if (!current) throw stale();
      if (current.status !== 'running') return captureResponse(actor, row, current);
      const occupied = workflow.answers.some(other => other.phase === started.slot.phase && geoSampleKey(other) === started.sampleKey);
      const superseded = attempts.slice(0, position).some(next => next.sampleKey === started.sampleKey && next.slot.phase === started.slot.phase);
      if (answer && (workflow.answers.length >= 600 || occupied || superseded)) {
        outcome = { status: 'unknown', message: 'API Mart 已返回答案，但该采样位置已更改或超过存储容量。' };
        answer = undefined;
      }
      const updated = { ...current, ...outcome };
      const next = { ...workflow, captureAttempts: attempts.map(attempt => attempt.id === started.id ? updated : attempt),
        answers: answer ? [answer, ...workflow.answers] : workflow.answers };
      try {
        return { project: await updateWorkflow(actor, row, document, next), capture: outcome };
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        if (error.status === 413 && answer) {
          outcome = { status: 'unknown', message: 'API Mart 已返回答案，但当前项目的存储容量不足。' };
          answer = undefined;
          continue;
        }
        if (error.status !== 409 || retry === 3) throw error;
      }
    }
    throw stale();
  }

  async function captureAI(actor: GeoActor, id: string, version: number, rawSlot: unknown, requestId: unknown, resolveProvider: () => Promise<CaptureProvider | null>): Promise<GeoCaptureResponse> {
    const slot = parseGeoSlot(rawSlot);
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(requestId)) throw new DomainError('采样请求标识无效。');
    const row = await load(actor, id);
    assertAuthor(actor, row);
    const {document, workflow} = storedDocument(row);
    const attempts = workflow.captureAttempts ?? [];
    const replay = (row: GeoRow, previous: GeoCaptureAttempt) => {
      if (JSON.stringify(previous.slot) !== JSON.stringify(slot)) throw new DomainError('同一采样请求标识只能对应同一个问题与采样位置。', 409);
      return captureResponse(actor, row, previous);
    };
    const previous = attempts.find(attempt => attempt.id === requestId);
    if (previous) return replay(row, previous);
    assertVersion(row, version);
    if (attempts.length >= 800) throw new DomainError('本项目已达到 API 采样请求上限，请另建项目继续。', 413);
    if (workflow.answers.some(answer => answer.id === requestId)) throw new DomainError('采样请求标识已使用。', 409);
    const snapshot = sampleSnapshot(document, workflow, slot);
    const key = geoSampleKey(snapshot);
    const baseline = sampleReady(row, workflow, slot, key, 'apimart');
    if (baseline && !baseline.provenance) throw new DomainError('基线未记录 API Mart 模型与联网方式，请重新建立基线。', 409);
    const provider = await resolveProvider();
    if (!provider || !(provider.supports?.(slot.engine) ?? provider.engines.includes(slot.engine))) {
      throw new DomainError('当前所选引擎没有可用的 API Mart 采样能力。', 503);
    }
    const attempt: GeoCaptureAttempt = { id: requestId, slot, sampleKey: key, status: 'running', startedAt: time() };
    try {
      await updateWorkflow(actor, row, document, { ...workflow, captureAttempts: [attempt, ...attempts] });
    } catch (error) {
      if (!(error instanceof DomainError) || error.status !== 409) throw error;
      const latest = await load(actor, id);
      const previouslyClaimed = storedDocument(latest).workflow.captureAttempts?.find(saved => saved.id === requestId);
      if (previouslyClaimed) return replay(latest, previouslyClaimed);
      throw error;
    }
    let answer: GeoAnswer;
    try {
      const options = baseline?.provenance ? { model: baseline.provenance.model, webSearch: baseline.provenance.webSearch } : undefined;
      const result = await provider.capture(slot.engine, snapshot.prompt, options);
      if (options && (result.model !== options.model || result.webSearch !== options.webSearch)) throw new DomainError('API Mart 返回的模型或联网方式与基线不一致。', 502);
      answer = buildGeoProviderAnswer({ ...snapshot, id: requestId }, result, { document,
        ...(row.publication_json ? { publicationUrl: (JSON.parse(row.publication_json) as GeoPublication).url } : {}),
        competitors: workflow.competitors, recordedAt: time() });
    } catch (error) {
      const known = error instanceof DomainError && [400, 401, 402, 403, 404, 429].includes(error.status);
      return completeCapture(actor, id, attempt, { status: known ? 'failed' : 'unknown', message: known ? error.message : unknownCapture });
    }
    return completeCapture(actor, id, attempt, { status: 'saved' }, answer);
  }

  async function gaps(actor: GeoActor, id: string, version: number, rawGaps: unknown) {
    const row = await ownedProject(actor, id, version);
    const current = storedDocument(row);
    return updateWorkflow(actor, row, current.document, { ...current.workflow, gaps: parseGeoGaps(rawGaps, current.workflow.answers) });
  }

  return { get, list, save, submit, review, publish, observe, workflow, capture, captureAI, gaps, ownedProject: async (actor: GeoActor, id: string, version: number) => projectFor(actor, await ownedProject(actor, id, version)) };
}
