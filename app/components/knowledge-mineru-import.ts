import { KNOWLEDGE_FILE_LIMIT, KNOWLEDGE_TEXT_LIMIT } from '../lib/knowledge-library-types';

const endpoint = '/api/knowledge-mineru';
const pollInterval = 4_000;
const pollTimeout = 120_000;

class MineruRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function requestMineru(signal: AbortSignal, body?: FormData | { ticket: string }) {
  const deadline = AbortSignal.timeout(body ? 50_000 : 8_000);
  const requestSignal = AbortSignal.any([signal, deadline]);
  const json = body && !(body instanceof FormData);
  const response = await fetch(endpoint, {
    credentials: 'same-origin', cache: 'no-store', signal: requestSignal,
    ...(body ? { method: 'POST', body: json ? JSON.stringify(body) : body as FormData } : {}),
    ...(json ? { headers: { 'Content-Type': 'application/json' } } : {}),
  }).catch(() => {
    signal.throwIfAborted();
    throw new Error('MinerU 云解析连接暂时不可用，请稍后重试。');
  });
  const value: unknown = await response.json().catch(() => null);
  signal.throwIfAborted();
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (!response.ok) {
    const message = typeof data.error === 'string' && data.error.trim() ? data.error : 'MinerU 云解析暂时不可用，请稍后重试。';
    throw new MineruRequestError(message, response.status);
  }
  return data;
}

export async function readMineruAvailability(signal: AbortSignal): Promise<boolean> {
  const { configured } = await requestMineru(signal);
  if (typeof configured !== 'boolean') throw new Error('暂时无法读取 MinerU 配置。');
  return configured;
}

function waitForNextPoll(signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, pollInterval);
    function abort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function importMineruPdf(
  item: { file: File; mineruTicket?: string },
  signal: AbortSignal,
  progress: (message: string) => void,
  stopped: () => boolean,
): Promise<string | undefined> {
  if (!item.mineruTicket) {
    if (!item.file.size) throw new Error('文件为空，请选择包含正文的 PDF。');
    if (item.file.size > KNOWLEDGE_FILE_LIMIT) throw new Error('知识文件不能超过 10 MB，请压缩或拆分后重试。');
    const form = new FormData();
    form.set('file', item.file);
    progress('正在上传原始 PDF');
    const { ticket } = await requestMineru(signal, form);
    if (typeof ticket !== 'string' || !ticket) throw new Error('MinerU 云解析未返回任务凭证。');
    item.mineruTicket = ticket;
  }

  const limit = AbortSignal.timeout(pollTimeout);
  const pollSignal = AbortSignal.any([signal, limit]);
  try {
    progress('正在查询云解析进度');
    while (!stopped()) {
      const result = await requestMineru(pollSignal, { ticket: item.mineruTicket });
      if (result.status === 'done') {
        if (typeof result.text !== 'string' || !result.text.trim() || result.text.length > KNOWLEDGE_TEXT_LIMIT) {
          throw new Error('MinerU 返回的正文为空或超出知识库导入上限。');
        }
        return result.text;
      }
      if (result.status !== 'pending' && result.status !== 'running') throw new Error('MinerU 返回了无法识别的任务状态。');
      progress(result.status === 'pending' ? '云端排队中' : typeof result.pages === 'number' && typeof result.totalPages === 'number' && result.totalPages > 0
        ? `云端解析中 · ${result.pages} / ${result.totalPages} 页` : '云端解析中');
      if (!stopped()) await waitForNextPoll(pollSignal);
    }
  } catch (error) {
    signal.throwIfAborted();
    if (limit.aborted) throw new Error('MinerU 仍在云端解析，稍后重试此项可继续查询。');
    if (error instanceof MineruRequestError && [400, 410, 413, 422].includes(error.status)) delete item.mineruTicket;
    throw error;
  }
}
