import { DomainError } from './domain.ts';
import { geoPublicUrl } from './geo-content.ts';
import { boundedMaterialBytes } from './marketing-material.ts';
import { createMaterialStore, type MaterialEnvironment } from './marketing-material-store.ts';
import type { ModelMessage } from './model-client.ts';

const base = 'https://api.apimart.ai/v1';
const families = [
  { engine: 'DeepSeek', aliases: ['deepseek', '深度求索'], models: [/^deepseek-v4\.1-flash$/, /^deepseek-v4(?:\.\d+)?-flash$/, /^deepseek-(?:chat|flash)$/, /^deepseek-v3(?:[.\d]*)(?:-exp|-\d+)?$/, /^deepseek-v4(?:\.\d+)?-pro$/] },
  { engine: 'ChatGPT', aliases: ['chatgpt', 'openai', 'gpt'], models: [/^gpt-4\.1-mini$/, /^gpt-4o-mini$/, /^gpt-5(?:\.\d+)?-mini$/, /^gpt-4\.1$/, /^gpt-4o$/, /^gpt-5(?:\.\d+)?$/] },
  { engine: 'Gemini', aliases: ['gemini', 'google gemini'], models: [/^gemini-(?:2\.5|3\.\d+)-flash$/, /^gemini-(?:2\.5|3\.\d+)-flash-preview(?:-\d{2}-\d{2})?$/, /^gemini-2\.5-pro$/] },
  { engine: 'Claude', aliases: ['claude', 'anthropic'], models: [/^claude-haiku-4[-.]5(?:-\d{8})?$/, /^claude-sonnet-4[-.]\d(?:-\d{8})?$/] },
  { engine: '通义千问', aliases: ['通义千问', '千问', 'qwen'], models: [/^qwen-flash(?:-\d{4}-\d{2}-\d{2})?$/, /^qwen-plus(?:-\d{4}-\d{2}-\d{2})?$/, /^qwen3(?:\.\d+)?-\d+b(?:-a\d+b)?(?:-instruct(?:-\d{4})?)?$/] },
  { engine: '豆包', aliases: ['豆包', 'doubao'], models: [/^doubao-(?:seed-)?(?:\d[.\d]*-)?(?:lite|mini|flash)(?:-\d+)?$/, /^doubao-(?:seed-)?(?:\d[.\d]*-)?pro(?:-\d+)?$/] },
  { engine: 'Kimi', aliases: ['kimi', 'moonshot'], models: [/^kimi-k2(?:\.\d+)?(?:-instruct(?:-\d{4})?)?$/, /^moonshot-v1-(?:8k|32k|128k)$/] },
  { engine: 'ChatGPT 联网', aliases: ['chatgpt 联网'], models: [/^gpt-5\.2-pro$/], webSearch: true },
];

type ModelSelection = { model: string; webSearch: boolean };
type CaptureResult = { rawAnswer: string; citations: { title: string; url: string }[]; model: string; requestId?: string; webSearch: boolean };
export type GeoAIConnection = {
  engines: string[];
  catalogSize: number;
  models: Record<string, ModelSelection>;
  generationModel?: string;
  supports(engine: string, options?: Partial<ModelSelection>): boolean;
  capture(engine: string, prompt: string, options?: Partial<ModelSelection>): Promise<CaptureResult>;
  generate(messages: ModelMessage[]): Promise<string>;
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const objects = (value: unknown) => Array.isArray(value) ? value.map(record).filter(item => item !== undefined) : [];
const label = (value: string) => value.normalize('NFKC').trim().toLowerCase();
const modelId = (value: unknown): value is string => typeof value === 'string' && /^[\w.:-]{1,120}$/.test(value);

function providerError(status: number): DomainError {
  if (status >= 300 && status < 400) return new DomainError(`APIMart 返回重定向（HTTP ${status}），连接未返回模型结果。`, 502);
  if (status === 400) return new DomainError('APIMart 拒绝了模型或请求参数，请检查采样引擎。', 400);
  if (status === 401 || status === 403) return new DomainError('APIMart 密钥无效或没有该模型权限，请在 API 连接设置中检查。', status);
  if (status === 402) return new DomainError('APIMart 余额不足，请补充余额后重试。', 402);
  if (status === 404) return new DomainError('APIMart 暂未提供该模型或接口，请检查采样计划。', 404);
  if (status === 429) return new DomainError('APIMart 达到限流或配额上限，请稍后重试。', 429);
  return new DomainError(`APIMart 请求失败（HTTP ${status}），请稍后重试。`, 502);
}

async function requestJson(request: typeof fetch, key: string, path: string, timeout: number, input?: Record<string, unknown>) {
  const signal = AbortSignal.timeout(timeout);
  let response: Response;
  try {
    response = await request(base + path, {
      method: input ? 'POST' : 'GET', redirect: 'manual',
      headers: { Authorization: `Bearer ${key}`, ...(input ? { 'Content-Type': 'application/json' } : {}) },
      signal,
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
  } catch {
    if (signal.aborted) throw new DomainError('APIMart 请求超时，请检查该条记录后重试。', 504);
    throw new DomainError('工作台暂未连通 APIMart 的 API 服务。', 502);
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw providerError(response.status);
  }
  let data: Record<string, unknown> | undefined;
  try {
    data = record(JSON.parse(new TextDecoder().decode(await boundedMaterialBytes(response, 1024 * 1024))));
  } catch {
    if (signal.aborted) throw new DomainError('APIMart 请求超时，请检查该条记录后重试。', 504);
    throw new DomainError('APIMart 返回的内容无法解析为 API 数据。', 502);
  }
  if (!data) throw new DomainError('APIMart 返回的 API 数据格式异常。', 502);
  if (data.error || data.success === false) {
    const code = record(data.error)?.code ?? data.code;
    const status = typeof code === 'string' && /^\d{3}$/.test(code) ? Number(code) : code;
    if (typeof status === 'number' && status >= 400 && status <= 599) throw providerError(status);
    throw new DomainError('APIMart 拒绝了本次请求，请在 APIMart 控制台检查模型权限和余额。', 502);
  }
  return data;
}

export function geoProviderCitations(annotations: Record<string, unknown>[]) {
  const citations: CaptureResult['citations'] = [];
  const seen = new Set<string>();
  for (const item of annotations) {
    if (item.type !== 'url_citation') continue;
    const entry = record(item.url_citation) ?? item;
    if (typeof entry.url !== 'string' || entry.url.length > 2000) continue;
    try {
      const url = new URL(geoPublicUrl(entry.url));
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      const title = typeof entry.title === 'string' ? entry.title.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 180) : '';
      citations.push({ title: title || url.hostname, url: url.href });
    } catch { /* Invalid provider metadata is omitted. */ }
    if (citations.length === 12) break;
  }
  return citations;
}

async function chat(request: typeof fetch, key: string, model: string, messages: ModelMessage[], maxTokens: number) {
  const data = await requestJson(request, key, '/chat/completions', 58000, {
    model, messages, stream: false,
    ...(/^gpt-(?:5\b|5\.)/.test(model) ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
    ...(/^deepseek-/.test(model) ? { thinking: { type: 'disabled' } } : {}),
  });
  const choice = objects(data.choices)[0];
  const message = record(choice?.message);
  if (!message || (choice?.finish_reason && choice.finish_reason !== 'stop') || message.refusal || objects(message.tool_calls).length) {
    throw new DomainError('APIMart 未返回完整的可用答复，请稍后重试。', 502);
  }
  const answer = typeof message.content === 'string' ? message.content.trim()
    : objects(message.content).filter(part => part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text).join('').trim();
  if (!answer) throw providerError(502);
  return { answer, annotations: objects(message.annotations), id: data.id };
}

async function responses(request: typeof fetch, key: string, model: string, input: string | ModelMessage[], search: boolean) {
  const data = await requestJson(request, key, '/responses', 70000, {
    model, input, max_output_tokens: search ? 4096 : 6200, stream: false, store: false,
    ...(search ? { tools: [{ type: 'web_search' }], tool_choice: { type: 'web_search' }, max_tool_calls: 3 } : {}),
  });
  const output = objects(data.output);
  const parts = output.filter(item => item.type === 'message' && item.role === 'assistant')
    .flatMap(item => objects(item.content)).filter(part => part.type === 'output_text');
  const answer = parts.filter(part => typeof part.text === 'string').map(part => part.text).join('\n').trim();
  const annotations = parts.flatMap(part => objects(part.annotations));
  if ((data.status && data.status !== 'completed') || !answer) throw providerError(502);
  const searched = output.some(item => item.type === 'web_search_call' && item.status === 'completed');
  if (search && !searched && !geoProviderCitations(annotations).length) {
    throw new DomainError('APIMart 未返回联网执行记录，无法保存为联网样本。', 502);
  }
  return { answer, annotations, id: data.id };
}

const catalog = new Map<string, { until: number; ids: string[] }>();

async function readCatalog(ownerId: string, version: number, key: string, request: typeof fetch): Promise<string[]> {
  const cacheKey = JSON.stringify([ownerId, version]);
  const saved = request === fetch ? catalog.get(cacheKey) : undefined;
  if (saved && saved.until > Date.now()) return saved.ids;
  const data = await requestJson(request, key, '/models', 8000);
  if (!Array.isArray(data.data)) throw new DomainError('APIMart 的模型清单格式暂时无法识别。', 502);
  const ids = objects(data.data).filter(item => item.category === undefined || item.category === 'chat' || item.category === 'unknown')
    .map(item => item.id).filter(modelId).sort();
  if (request === fetch) {
    if (catalog.size >= 64) catalog.delete(catalog.keys().next().value!);
    catalog.set(cacheKey, { until: Date.now() + 120000, ids });
  }
  return ids;
}

export async function readGeoAIConnection(ownerId: string, env: MaterialEnvironment, request: typeof fetch = fetch): Promise<GeoAIConnection | null> {
  const store = createMaterialStore(env);
  const connection = await store.connection(ownerId);
  if (!connection.enabled || !connection.hasSecret || !connection.storageReady) return null;
  const key = await store.key(ownerId);
  const ids = await readCatalog(ownerId, connection.version, key, request);
  const available = families.flatMap(family => {
    const matches = family.models.flatMap(pattern => ids.filter(id => pattern.test(id)));
    return matches.length > 0 ? [{ ...family, matches }] : [];
  });
  const engines = available.map(entry => entry.engine);
  const models: Record<string, ModelSelection> = Object.fromEntries(available.flatMap(entry =>
    [...entry.aliases, entry.engine, ...entry.matches.filter(() => !entry.webSearch)].map(alias => [
      alias, { model: entry.matches.includes(alias) ? alias : entry.matches[0], webSearch: !!entry.webSearch },
    ])));
  const findFamily = (engine: string) => {
    const name = label(engine);
    return available.find(entry => entry.aliases.includes(name) || label(entry.engine) === name ||
      (!entry.webSearch && entry.matches.some(id => label(id) === name)));
  };
  const textModel = available.find(entry => !entry.webSearch)?.matches[0];
  const generationModel = textModel ?? available[0]?.matches[0];
  const supports = (engine: string, options: Partial<ModelSelection> = {}) => {
    const family = findFamily(engine);
    return Boolean(family && (options.model === undefined || family.matches.includes(options.model)) &&
      (options.webSearch === undefined || options.webSearch === Boolean(family.webSearch)));
  };
  return {
    engines, models, generationModel, catalogSize: ids.length,
    supports,
    async capture(engine, prompt, options = {}) {
      const name = label(engine);
      const family = findFamily(engine);
      const model = options.model ?? family?.matches.find(id => label(id) === name) ?? family?.matches[0];
      const webSearch = !!family?.webSearch;
      if (!model || !supports(engine, options)) {
        throw new DomainError('APIMart 当前没有此引擎对应的采样模型，请检查采样计划。', 404);
      }
      const result = webSearch ? await responses(request, key, model, prompt, true) : await chat(request, key, model, [{ role: 'user', content: prompt }], 2800);
      if (result.answer.length > 12000) throw new DomainError('APIMart 答复超过单条采样上限，请缩短提问后重试。', 502);
      return {
        rawAnswer: result.answer,
        citations: geoProviderCitations(result.annotations),
        model, webSearch,
        requestId: typeof result.id === 'string' && /^[\w.:-]{1,120}$/.test(result.id) ? result.id : undefined,
      };
    },
    async generate(messages) {
      if (!generationModel) throw new DomainError('APIMart 当前没有可用于 GEO 写作的文本模型。', 503);
      return textModel ? (await chat(request, key, textModel, messages, 6200)).answer
        : (await responses(request, key, generationModel, messages, false)).answer;
    },
  };
}
