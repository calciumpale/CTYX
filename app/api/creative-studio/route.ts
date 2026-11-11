import { env } from 'cloudflare:workers';
import { assertSameOrigin } from '../../lib/connection-config.ts';
import { readEffectiveModel } from '../../lib/connection-store.ts';
import { generateStudio } from '../../lib/creative-studio-model.ts';
import { createCreativeStudioStore } from '../../lib/creative-studio-store.ts';
import { parseStudioDocument, parseStudioSelection, studioChoice, studioId, studioObject, studioText, studioVersion } from '../../lib/creative-studio-validation.ts';
import { DomainError } from '../../lib/domain.ts';
import { boundedMaterialBytes } from '../../lib/marketing-material.ts';
import { requestModelText } from '../../lib/model-client.ts';
import { materialHeaders, materialIdentity } from '../marketing-materials/route.ts';

export const dynamic = 'force-dynamic';

function store() {
  const db = (env as Cloudflare.Env).DB;
  if (!db) throw new DomainError('创作项目存储尚未连接', 503);
  return createCreativeStudioStore(db);
}

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: materialHeaders });

function failure(error: unknown) {
  const message = error instanceof DomainError ? error.message : '创作服务暂时不可用，请稍后重试';
  return json({ error: message, message }, error instanceof DomainError ? error.status : 503);
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') ?? '')) {
    throw new DomainError('请使用 JSON 格式提交创作请求', 415);
  }
  if (!request.body) throw new DomainError('缺少创作请求参数', 400);
  let bytes: Uint8Array;
  try {
    const length = request.headers.get('Content-Length');
    const source = new Response(request.body, { headers: length === null ? undefined : { 'Content-Length': length } });
    bytes = await boundedMaterialBytes(source, 1800000);
  } catch (error) {
    if (error instanceof DomainError) throw new DomainError('创作项目内容过大', 413);
    throw new DomainError('创作请求未能完整读取', 400);
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new DomainError('创作请求格式无效', 400); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('创作请求格式无效', 400);
  return value as Record<string, unknown>;
}

export async function GET(request: Request) {
  try {
    const { owner, member } = materialIdentity(request);
    const url = new URL(request.url);
    const db = store();
    const params = url.searchParams;
    if (params.get('market') === '1') return json({ templates: await db.listTemplates(owner, member) });
    if (params.has('id')) {
      const id = studioId(params.get('id'), '创作项目标识');
      if (params.has('version')) {
        const raw = params.get('version') ?? '';
        const version = studioVersion(/^\d+$/.test(raw) ? Number(raw) : NaN);
        return json({ project: await db.get(owner, member, id, version) });
      }
      const project = await db.get(owner, member, id);
      const versions = await db.versions(owner, member, id, project.version);
      return json({ project, versions });
    }
    if (params.has('version')) throw new DomainError('缺少创作项目标识', 400);
    const [projects, model] = await Promise.all([
      db.list(owner, member),
      readEffectiveModel(owner, url.origin).catch(() => null),
    ]);
    return json({ projects, modelAvailable: Boolean(model) });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    const { owner, member } = materialIdentity(request);
    assertSameOrigin(request);
    const body = await readBody(request);
    switch (body.action) {
      case 'save': {
        studioObject(body, '保存请求', ['action', 'id', 'version', 'document']);
        const id = studioId(body.id, '创作项目标识');
        const version = studioVersion(body.version, 0);
        const document = parseStudioDocument(body.document);
        return json({ project: await store().save(owner, member, id, version, document) });
      }
      case 'archive': {
        studioObject(body, '归档请求', ['action', 'id', 'version']);
        await store().archive(owner, member, studioId(body.id, '创作项目标识'), studioVersion(body.version));
        return json({ ok: true });
      }
      case 'generate': {
        studioObject(body, '生成请求', ['action', 'mode', 'document', 'instruction', 'selection']);
        const mode = studioChoice(body.mode, ['copy', 'design', 'revise'], '生成方式');
        const document = parseStudioDocument(body.document);
        const instruction = body.instruction === undefined ? undefined : studioText(body.instruction, '修改指令', 1500);
        const selection = parseStudioSelection(body.selection);
        const model = await readEffectiveModel(owner, new URL(request.url).origin);
        if (!model) throw new DomainError('请在服务连接配置并启用大模型后再生成', 503);
        return json(await generateStudio(mode, document, { instruction, selection }, messages => requestModelText(model, messages)));
      }
      case 'publishTemplate': {
        studioObject(body, '发布请求', ['action', 'id', 'version', 'title', 'description']);
        const id = studioId(body.id, '创作项目标识');
        const version = studioVersion(body.version);
        const title = studioText(body.title, '模板标题', 120, true);
        const description = studioText(body.description, '模板说明', 600);
        const template = await store().publishTemplate(owner, member, id, version, title, description);
        return json({ template });
      }
      case 'removeTemplate': {
        studioObject(body, '移除请求', ['action', 'id']);
        await store().removeTemplate(owner, member, studioId(body.id, '模板标识'));
        return json({ ok: true });
      }
      default: throw new DomainError('创作操作无效', 400);
    }
  } catch (error) { return failure(error); }
}
