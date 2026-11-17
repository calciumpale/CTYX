import { env } from 'cloudflare:workers';
import { assertSameOrigin } from '../../lib/connection-config.ts';
import { readEffectiveModel } from '../../lib/connection-store.ts';
import { DomainError } from '../../lib/domain.ts';
import { readGeoAIConnection } from '../../lib/geo-apimart.ts';
import { readGeoCaptureProvider } from '../../lib/geo-capture-provider.ts';
import { checkGeoQuality, generateGeoArticle, generateGeoEvidenceDraft, hasGeoSourceEvidence, parseGeoBrief, parseGeoDocument } from '../../lib/geo-content.ts';
import { createGeoStore, type GeoActor } from '../../lib/geo-store.ts';
import { diagnoseGeoGaps, selectGeoGapGuidance } from '../../lib/geo-workflow.ts';
import { boundedMaterialBytes } from '../../lib/marketing-material.ts';
import type { MaterialEnvironment } from '../../lib/marketing-material-store.ts';
import { requireMemberRole } from '../../lib/member-policy.ts';
import { requestModelText } from '../../lib/model-client.ts';
import { requireUserId } from '../../lib/server.ts';
import { materialHeaders } from '../marketing-materials/route.ts';

export const dynamic = 'force-dynamic';

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: materialHeaders });
const apimart = (ownerId: string) => readGeoAIConnection(ownerId, env as MaterialEnvironment);

async function textGeneration(actor: GeoActor, origin: string) {
  const connection = await apimart(actor.ownerId).catch(() => null);
  if (connection?.generationModel) return { generate: connection.generate, provider: 'apimart', model: connection.generationModel };
  const model = await readEffectiveModel(actor.ownerId, origin);
  if (!model) throw new DomainError('请先在服务连接中启用 APIMart 或配置工作台大模型。', 503);
  return { generate: (messages: Parameters<typeof requestModelText>[1]) => requestModelText(model, messages, {timeoutMs: 58000}), provider: 'workspace', model: model.name };
}

function failure(error: unknown) {
  const message = error instanceof DomainError ? error.message : 'GEO 服务暂时不可用，请稍后重试';
  return json({ error: message, message }, error instanceof DomainError ? error.status : 503);
}

function identity(request: Request): GeoActor {
  const role = requireMemberRole(request);
  if (role === 'admin') throw new DomainError('此功能仅向业务成员开放', 403);
  return { ownerId: requireUserId(request), memberId: request.headers.get('x-ctai-member-account-id')!, role };
}

function store() {
  const db = (env as Cloudflare.Env).DB;
  if (!db) throw new DomainError('GEO 稿件存储尚未连接', 503);
  return createGeoStore(db);
}

function projectId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(value)) throw new DomainError('GEO 稿件标识无效', 400);
  return value;
}

function projectVersion(value: unknown, minimum = 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value >= Number.MAX_SAFE_INTEGER) {
    throw new DomainError('GEO 稿件版本无效', 400);
  }
  return value;
}

const commands = {
  save: ['id', 'version', 'document', 'workflow'],
  submit: ['id', 'version'],
  review: ['id', 'version', 'decision', 'note'],
  publish: ['id', 'version', 'url', 'channel'],
  observe: ['id', 'version', 'engine', 'query', 'result', 'evidence'],
  workflow: ['id', 'version', 'workflow'],
  capture: ['id', 'version', 'answer'],
  capture_ai: ['id', 'version', 'slot', 'requestId'],
  gaps: ['id', 'version', 'gaps'],
  diagnose: ['id', 'version'],
  generate: ['brief', 'id', 'version', 'gapIds'],
  check: ['document'],
} as const;

async function readCommand(request: Request): Promise<{ action: keyof typeof commands; body: Record<string, unknown> }> {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') ?? '')) {
    throw new DomainError('请使用 JSON 格式提交 GEO 请求', 415);
  }
  if (!request.body) throw new DomainError('缺少 GEO 请求参数', 400);
  let bytes: Uint8Array;
  try {
    const length = request.headers.get('Content-Length');
    const source = new Response(request.body, { headers: length === null ? undefined : { 'Content-Length': length } });
    bytes = await boundedMaterialBytes(source, 512 * 1024);
  } catch (error) {
    if (error instanceof DomainError) throw new DomainError('GEO 请求内容过大', 413);
    throw new DomainError('GEO 请求未能完整读取', 400);
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new DomainError('GEO 请求格式无效', 400); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('GEO 请求格式无效', 400);
  const body = value as Record<string, unknown>;
  if (typeof body.action !== 'string' || !Object.hasOwn(commands, body.action)) throw new DomainError('GEO 操作无效', 400);
  const action = body.action as keyof typeof commands;
  const fields: readonly string[] = commands[action];
  if (Object.keys(body).some(key => key !== 'action' && !fields.includes(key))) throw new DomainError('GEO 请求含有未知参数', 400);
  return { action, body };
}

async function readCapabilities(actor: GeoActor, origin: string) {
  const workspaceModel = readEffectiveModel(actor.ownerId, origin).catch(() => null);
  const [model, connection] = await Promise.all([
    workspaceModel,
    readGeoCaptureProvider(actor.ownerId, env as MaterialEnvironment, () => workspaceModel),
  ]);
  return {
    modelAvailable: Boolean(connection.apimart.status === 'ready' || model),
    aiCapture: { engines: connection.engines, models: connection.models, providers: connection.providers, apimart: connection.apimart },
  };
}

export async function GET(request: Request) {
  try {
    const actor = identity(request);
    const url = new URL(request.url);
    const scope = url.searchParams.get('scope');
    if (url.searchParams.has('id')) return json({ project: await store().get(actor, projectId(url.searchParams.get('id'))) });
    if (scope === 'projects') return json({ projects: await store().list(actor) });
    if (scope === 'capabilities') return json(await readCapabilities(actor, url.origin));
    if (scope !== null) throw new DomainError('未知的 GEO 查询范围', 400);
    const [projects, capabilities] = await Promise.all([store().list(actor), readCapabilities(actor, url.origin)]);
    return json({ projects, ...capabilities });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    const actor = identity(request);
    assertSameOrigin(request);
    const { action, body } = await readCommand(request);
    if (action === 'generate') {
      const brief = parseGeoBrief(body.brief);
      const guided = body.gapIds !== undefined || body.id !== undefined || body.version !== undefined;
      const id = guided ? projectId(body.id) : undefined;
      const version = guided ? projectVersion(body.version) : undefined;
      let guidance: ReturnType<typeof selectGeoGapGuidance> = [];
      const db = id ? store() : undefined;
      if (db && id && version !== undefined) {
        const project = await db.ownedProject(actor, id, version);
        if (project.document.brief.brand !== brief.brand) throw new DomainError('品牌已变更，请先保存并重新核对待补齐缺口。', 409);
        guidance = selectGeoGapGuidance(project, body.gapIds);
      }
      const { generate, provider, model } = await textGeneration(actor, new URL(request.url).origin);
      const evidencePending = guided && !hasGeoSourceEvidence(brief);
      const article = evidencePending ? await generateGeoEvidenceDraft(brief, guidance, generate) : await generateGeoArticle(brief, generate, guidance);
      if (db && id && version !== undefined) await db.ownedProject(actor, id, version);
      return json({ article, provider, model, evidencePending });
    }
    if (action === 'check') return json({ quality: checkGeoQuality(parseGeoDocument(body.document)) });
    const id = projectId(body.id);
    const version = projectVersion(body.version, action === 'save' ? 0 : 1);
    const db = store();
    switch (action) {
      case 'save': return json({ project: await db.save(actor, id, version, parseGeoDocument(body.document), body.workflow) });
      case 'submit': return json({ project: await db.submit(actor, id, version) });
      case 'review': return json({ project: await db.review(actor, id, version, body.decision, body.note) });
      case 'publish': return json({ project: await db.publish(actor, id, version, body.url, body.channel) });
      case 'observe': return json({ project: await db.observe(actor, id, version, body.engine, body.query, body.result, body.evidence) });
      case 'workflow': return json({ project: await db.workflow(actor, id, version, body.workflow) });
      case 'capture': return json({ project: await db.capture(actor, id, version, body.answer) });
      case 'capture_ai': return json(await db.captureAI(actor, id, version, body.slot, body.requestId,
        () => readGeoCaptureProvider(actor.ownerId, env as MaterialEnvironment,
          () => readEffectiveModel(actor.ownerId, new URL(request.url).origin).catch(() => null))));
      case 'gaps': return json({ project: await db.gaps(actor, id, version, body.gaps) });
      case 'diagnose': {
        const project = await db.ownedProject(actor, id, version);
        const { generate, provider, model } = await textGeneration(actor, new URL(request.url).origin);
        const gaps = await diagnoseGeoGaps(project, generate);
        await db.ownedProject(actor, id, version);
        return json({ gaps, provider, model });
      }
    }
  } catch (error) { return failure(error); }
}
