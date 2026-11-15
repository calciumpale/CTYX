import type { EffectiveModel } from './connection-config.ts';
import { DomainError } from './domain.ts';
import { geoProviderCitations, readGeoAIConnection } from './geo-apimart.ts';
import type { GeoCaptureProvider, GeoCaptureProviderOptions } from './geo-types.ts';
import { boundedMaterialBytes } from './marketing-material.ts';
import type { MaterialEnvironment } from './marketing-material-store.ts';
import { requestModelText } from './model-client.ts';

type Selection = { model: string; webSearch: boolean; provider: 'apimart' | 'workspace' };
type Availability = { status: 'ready' | 'disabled' | 'no_text_models' | 'error'; message?: string };

const textFamilies = [
  { engine: 'DeepSeek', aliases: ['deepseek', '深度求索'], pattern: /^deepseek[-_]/i },
  { engine: 'ChatGPT', aliases: ['chatgpt', 'openai', 'gpt'], pattern: /^gpt-(?:4|5)(?:[.o-]|$)/i },
  { engine: 'Gemini', aliases: ['gemini', 'google gemini'], pattern: /^gemini-/i },
  { engine: 'Claude', aliases: ['claude', 'anthropic'], pattern: /^claude-/i },
  { engine: '通义千问', aliases: ['通义千问', '千问', 'qwen'], pattern: /^qwen[\d-]/i },
  { engine: '豆包', aliases: ['豆包', 'doubao'], pattern: /^doubao-/i },
  { engine: 'Kimi', aliases: ['kimi', 'moonshot'], pattern: /^(?:kimi|moonshot)-/i },
];
const label = (value: string) => value.normalize('NFKC').trim().toLowerCase();
const deepSeekWeb = 'DeepSeek 联网';
const directDeepSeek = (model: EffectiveModel | null) => model?.name === 'deepseek-flash' &&
  /^https:\/\/api\.deepseek\.com\/(?:v1\/)?chat\/completions$/.test(model.url);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const objects = (value: unknown) => Array.isArray(value) ? value.map(record).filter(item => item !== undefined) : [];

async function searchDeepSeek(model: EffectiveModel, prompt: string, request: typeof fetch) {
  const response = await request(model.url, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(60000),
    headers: { Authorization: `Bearer ${model.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model.name, messages: [{ role: 'user', content: prompt }], stream: false,
      tools: [{ type: 'deepseek_web_search' }], thinking: { type: 'disabled' }, max_tokens: 3600,
    }),
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    const status = response.status;
    throw new DomainError(`DeepSeek 联网接口请求失败（HTTP ${status}）。`, [400, 401, 402, 403, 404, 429].includes(status) ? status : 502);
  }
  const data = record(JSON.parse(new TextDecoder().decode(await boundedMaterialBytes(response, 1024 * 1024))));
  const choice = objects(data?.choices)[0];
  const message = record(choice?.message);
  const rawAnswer = typeof message?.content === 'string' ? message.content.trim() : '';
  const citations = geoProviderCitations(objects(message?.annotations));
  const searched = objects(message?.server_tool_calls).flatMap(step => objects(step.calls))
    .some(call => call.type === 'deepseek_web_search' && call.status === 'completed');
  if (choice?.finish_reason !== 'stop' || !rawAnswer || rawAnswer.length > 12000) {
    throw new DomainError('DeepSeek 未返回完整的联网答复。', 502);
  }
  if (!searched) throw new DomainError('DeepSeek 本次未联网查询，该条未记录为联网样本。', 400);
  return { rawAnswer, citations, model: model.name, webSearch: true, provider: 'workspace' as const,
    requestId: typeof data?.id === 'string' && /^[\w.:-]{1,120}$/.test(data.id) ? data.id : undefined };
}

export async function readGeoCaptureProvider(
  ownerId: string,
  environment: MaterialEnvironment,
  loadWorkspaceModel: () => Promise<EffectiveModel | null>,
  request: typeof fetch = fetch,
): Promise<GeoCaptureProvider & {
  models: Record<string, Selection>;
  providers: Record<Selection['provider'], Record<string, Selection>>;
  apimart: Availability;
}> {
  const [catalog, workspace] = await Promise.allSettled([
    readGeoAIConnection(ownerId, environment, request),
    loadWorkspaceModel(),
  ]);
  const mart = catalog.status === 'fulfilled' ? catalog.value : null;
  const martError = catalog.status === 'rejected'
    ? (catalog.reason instanceof DomainError ? catalog.reason : new DomainError('APIMart 的连接暂时不可用。', 503))
    : null;
  const workspaceModel = workspace.status === 'fulfilled' ? workspace.value : null;
  const family = workspaceModel && /^[\w.:-]{1,120}$/.test(workspaceModel.name) &&
    !/(?:image|audio|vision-only|embed|realtime|moderation|tts|transcri)/i.test(workspaceModel.name)
    ? textFamilies.find(item => item.pattern.test(workspaceModel.name)) : undefined;
  const martModels: Record<string, Selection> = Object.fromEntries(Object.entries(mart?.models ?? {})
    .map(([engine, entry]) => [engine, { ...entry, provider: 'apimart' }]));
  const workspaceModels: Record<string, Selection> = family && workspaceModel ? Object.fromEntries(
    [...family.aliases, family.engine, workspaceModel.name].map(engine => [engine, {
      model: workspaceModel.name, webSearch: false, provider: 'workspace',
    }]),
  ) : {};
  if (directDeepSeek(workspaceModel) && workspaceModel) {
    workspaceModels[deepSeekWeb] = { model: workspaceModel.name, webSearch: true, provider: 'workspace' };
  }
  const apimart: Availability = martError ? { status: 'error', message: martError.message }
    : mart?.engines.length ? { status: 'ready' }
      : mart ? { status: 'no_text_models', message: mart.catalogSize
        ? '当前 APIMart 连接的清单未包含 GEO 支持的文本模型。'
        : '当前 APIMart 连接没有返回可用模型。' }
        : { status: 'disabled', message: 'APIMart 文本采样需使用已配置并启用的连接。' };

  const workspaceSelection = (engine: string) => Object.entries(workspaceModels)
    .find(([name]) => label(name) === label(engine))?.[1];
  const supportsWorkspace = (engine: string, options: GeoCaptureProviderOptions = {}) => {
    const selected = workspaceSelection(engine);
    return Boolean(selected && (options.model === undefined || options.model === selected.model) &&
      (options.webSearch === undefined || options.webSearch === selected.webSearch));
  };
  const supports = (engine: string, options: GeoCaptureProviderOptions = {}) =>
    Boolean((options.provider !== 'workspace' && mart?.supports(engine, options)) ||
      (options.provider !== 'apimart' && supportsWorkspace(engine, options)));
  return {
    engines: [...new Set([...(mart?.engines ?? []), ...(family ? [family.engine] : []), ...(workspaceModels[deepSeekWeb] ? [deepSeekWeb] : [])])],
    models: { ...workspaceModels, ...martModels },
    providers: { apimart: martModels, workspace: workspaceModels },
    apimart, supports,
    async capture(engine, prompt, options = {}) {
      if (options.provider !== 'workspace' && mart?.supports(engine, options)) {
        return { ...await mart.capture(engine, prompt, options), provider: 'apimart' };
      }
      if (workspaceModel && options.provider !== 'apimart' && supportsWorkspace(engine, options)) {
        if (workspaceSelection(engine)?.webSearch) return searchDeepSeek(workspaceModel, prompt, request);
        const rawAnswer = await requestModelText(workspaceModel, [{ role: 'user', content: prompt }], { request, timeoutMs: 58000 });
        if (rawAnswer.length > 12000) throw new DomainError('模型答复超过单条采样上限，请缩短提问后重试。', 502);
        return { rawAnswer, citations: [], model: workspaceModel.name, webSearch: false, provider: 'workspace' };
      }
      if (martError && options.provider !== 'workspace') throw martError;
      throw new DomainError('当前没有可用于此引擎的采样模型，请检查采样计划。', 404);
    },
  };
}
