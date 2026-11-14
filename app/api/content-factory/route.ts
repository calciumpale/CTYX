import { env } from 'cloudflare:workers';
import { assertSameOrigin } from '../../lib/connection-config.ts';
import { readEffectiveModel } from '../../lib/connection-store.ts';
import { generateFactory, parseFactoryBrief, parseFactoryDocument, parseFactoryGenerateOptions } from '../../lib/content-factory.ts';
import { studioId, studioObject, studioVersion } from '../../lib/creative-studio-validation.ts';
import { DomainError } from '../../lib/domain.ts';
import { listFactoryCampaigns, saveFactoryCampaign } from '../../lib/factory-campaign-store.ts';
import { boundedMaterialBytes } from '../../lib/marketing-material.ts';
import { requestModelText } from '../../lib/model-client.ts';
import { materialHeaders, materialIdentity } from '../marketing-materials/route.ts';

export const dynamic = 'force-dynamic';

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: materialHeaders });

function failure(error: unknown) {
  const message = error instanceof DomainError ? error.message : '内容工厂暂时不可用，请稍后重试';
  return json({ error: message, message }, error instanceof DomainError ? error.status : 503);
}

function database() {
  const db = (env as Cloudflare.Env).DB;
  if (!db) throw new DomainError('内容工厂存储尚未连接', 503);
  return db;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') ?? '')) {
    throw new DomainError('请使用 JSON 格式提交内容工厂请求', 415);
  }
  if (!request.body) throw new DomainError('缺少内容工厂请求参数', 400);
  let bytes: Uint8Array;
  try {
    const length = request.headers.get('Content-Length');
    const source = new Response(request.body, { headers: length === null ? undefined : { 'Content-Length': length } });
    bytes = await boundedMaterialBytes(source, 1200000);
  } catch (error) {
    if (error instanceof DomainError) throw new DomainError('活动内容过大，请移除部分待发布素材后重试', 413);
    throw new DomainError('内容工厂请求未能完整读取', 400);
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new DomainError('内容工厂请求格式无效', 400); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('内容工厂请求格式无效', 400);
  return value as Record<string, unknown>;
}

export async function GET(request: Request) {
  try {
    const { owner, member } = materialIdentity(request);
    const [campaigns, model] = await Promise.all([
      listFactoryCampaigns(database(), owner, member),
      readEffectiveModel(owner, new URL(request.url).origin).catch(() => null),
    ]);
    return json({ campaigns, modelAvailable: Boolean(model) });
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
        const id = studioId(body.id, '活动标识');
        const version = studioVersion(body.version, 0);
        const document = parseFactoryDocument(body.document);
        return json({ record: await saveFactoryCampaign(database(), owner, member, id, version, document) });
      }
      case 'generate': {
        studioObject(body, '生成请求', ['action', 'brief', 'channel', 'previous']);
        const brief = parseFactoryBrief(body.brief);
        const options = parseFactoryGenerateOptions(brief, body);
        const model = await readEffectiveModel(owner, new URL(request.url).origin);
        if (!model) throw new DomainError('请先在服务连接中配置并启用大模型', 503);
        return json(await generateFactory(brief, options, messages => requestModelText(model, messages)));
      }
      default: throw new DomainError('内容工厂操作无效', 400);
    }
  } catch (error) { return failure(error); }
}
