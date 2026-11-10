import { Inflate } from 'fflate';
import { DomainError } from './domain.ts';
import { KNOWLEDGE_TEXT_LIMIT } from './knowledge-library-types.ts';

const API = 'https://mineru.net/api/v4';
const UPLOAD_ORIGIN = 'https://mineru.oss-cn-shanghai.aliyuncs.com';
const RESULT_ORIGIN = 'https://cdn-mineru.openxlab.org.cn';
const ZIP_LIMIT = 20 * 1024 * 1024;
const JSON_LIMIT = 64 * 1024;
const MARKDOWN_LIMIT = 3 * KNOWLEDGE_TEXT_LIMIT + 3;
const API_TIMEOUT = 12_000;
const TRANSFER_TIMEOUT = 20_000;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

type MineruStatus = { status: 'pending' | 'running'; pages?: number; totalPages?: number } | { status: 'done'; text: string };

// Only locally constructed messages may cross the provider boundary.
class MineruClientError extends DomainError {}
const fail = (message: string, status = 502) => new MineruClientError(message, status);
const badArchive = () => fail('MinerU 返回的解析结果无法读取，请检查 PDF 后重试。', 422);
const largeArchive = () => fail('MinerU 解析结果超过导入限制，请拆分 PDF 后重试。', 413);
const badToken = () => fail('MinerU Token 无效或已过期，请在服务连接中更新。', 503);
const taskExpired = () => fail('MinerU 解析任务已失效，请重新提交 PDF。', 410);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

async function boundedBytes(response: Response, max: number, signal: AbortSignal, tooLarge: () => MineruClientError) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > max) throw tooLarge();
  const reader = response.body?.getReader();
  if (!reader) throw fail('MinerU 返回了空响应，请稍后重试。');
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const chunks: Uint8Array[] = [];
  let buffer = Number.isSafeInteger(declared) && declared > 0 ? new Uint8Array(declared) : undefined;
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const end = size + value.byteLength;
      if (end > max) { cancel(); throw tooLarge(); }
      if (buffer && end <= buffer.length) buffer.set(value, size);
      else {
        if (buffer) { chunks.push(buffer.subarray(0, size)); buffer = undefined; }
        chunks.push(value);
      }
      size = end;
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  if (buffer) return buffer.subarray(0, size);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function providerRequest<T>(request: typeof fetch, url: string, init: RequestInit, timeout: number, consume: (response: Response, signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let response: Response | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(fail('MinerU 服务响应超时，请稍后重试。', 504));
      controller.abort();
    }, timeout);
  });
  try {
    return await Promise.race([deadline, (async () => {
      response = await request(url, { ...init, redirect: 'manual', signal: controller.signal });
      if (controller.signal.aborted || response.redirected || response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => {});
        throw fail('MinerU 返回了不可用的响应，请稍后重试。');
      }
      return consume(response, controller.signal);
    })()]);
  } catch (error) {
    void response?.body?.cancel().catch(() => {});
    if (error instanceof MineruClientError) throw error;
    throw fail('暂时无法连接 MinerU 服务，请稍后重试。');
  } finally {
    clearTimeout(timer);
  }
}

async function apiRequest(request: typeof fetch, token: string, path: string, body?: object) {
  return providerRequest(request, `${API}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, API_TIMEOUT, async (response, signal) => {
    if (response.status === 401 || response.status === 403) throw badToken();
    if (response.status === 429) throw fail('MinerU 请求频率过高，请稍后重试。', 429);
    const malformed = () => fail('MinerU 返回的任务信息格式异常，请稍后重试。');
    const bytes = await boundedBytes(response, JSON_LIMIT, signal, malformed);
    let payload: Record<string, unknown> | undefined;
    try { payload = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
    catch { throw malformed(); }
    const code = String(payload?.code ?? payload?.msgCode);
    if (['A0202', 'A0211', '-60013'].includes(code)) throw badToken();
    if (code === '-60012') throw taskExpired();
    if (code === '-60005' || code === '-60006') throw fail('PDF 超过 MinerU 的文件大小或页数限制，请拆分后重试。', 413);
    if (code === '-60018' || code === '-60009') throw fail('MinerU 当前解析额度不足或队列已满，请稍后重试。', 429);
    if (!response.ok || code !== '0') throw fail('MinerU 未能处理此次请求，请检查 PDF 或稍后重试。');
    const data = record(payload?.data);
    if (!data) throw malformed();
    return data;
  });
}

function trustedUrl(value: unknown, origin: string, label: string) {
  if (typeof value === 'string' && value.length <= 8192) {
    try {
      const url = new URL(value);
      if (url.origin === origin && !url.username && !url.password && !url.hash) return url.href;
    } catch { /* Invalid links get the same safe diagnostic. */ }
  }
  throw fail(`MinerU 返回的${label}地址不可用，请稍后重试。`);
}

export async function submitMineruPdf(token: string, file: File, request: typeof fetch = fetch): Promise<string> {
  const data = await apiRequest(request, token, '/file-urls/batch', {
    model_version: 'vlm', enable_table: true, enable_formula: true,
    // The local import retains the original file name. Only the type matters upstream.
    files: [{ name: 'document.pdf', is_ocr: true }],
  });
  const batchId = data.batch_id;
  if (typeof batchId !== 'string' || !ID.test(batchId) || !Array.isArray(data.file_urls) || data.file_urls.length !== 1) {
    throw fail('MinerU 返回的上传任务信息不完整，请稍后重试。');
  }
  const url = trustedUrl(data.file_urls[0], UPLOAD_ORIGIN, '上传');
  // Slicing also removes the MIME type, as required by the signed PUT.
  await providerRequest(request, url, { method: 'PUT', body: file.slice() }, TRANSFER_TIMEOUT, async response => {
    void response.body?.cancel().catch(() => {});
    if (!response.ok) throw fail('PDF 未能上传到 MinerU，请稍后重试。');
  });
  return batchId;
}

interface ZipEntry { offset: number; name: Uint8Array; size: number; compressed: number; method: number; flags: number; crc: number; }
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

/** Read one entry by the central directory. Images and other attachments stay compressed. */
function markdownFromZip(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true), u32 = (at: number) => view.getUint32(at, true);
  let end = bytes.length - 22;
  const lower = Math.max(0, bytes.length - 65_557);
  while (end >= lower && (u32(end) !== 0x06054b50 || end + 22 + u16(end + 20) !== bytes.length)) end--;
  if (end < lower) throw badArchive();
  const count = u16(end + 10), directory = u32(end + 16);
  if (!count || count > 4096 || u16(end + 4) || u16(end + 6) || u16(end + 8) !== count || directory + u32(end + 12) !== end) throw badArchive();
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  let at = directory;
  let entry: ZipEntry | undefined;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || u32(at) !== 0x02014b50) throw badArchive();
    const nameEnd = at + 46 + u16(at + 28);
    const next = nameEnd + u16(at + 30) + u16(at + 32);
    if (next > end) throw badArchive();
    const name = bytes.subarray(at + 46, nameEnd);
    const path = utf8.decode(name).split('/');
    if (path.at(-1) === 'full.md') {
      if (entry || u16(at + 34) || (u32(at + 38) >>> 16 & 0xf000) === 0xa000 ||
        path.some(part => !part || part === '.' || part === '..' || /[:\\\u0000-\u001f]/.test(part))) throw badArchive();
      entry = { offset: u32(at + 42), name, size: u32(at + 24), compressed: u32(at + 20), method: u16(at + 10), flags: u16(at + 8), crc: u32(at + 16) };
    }
    at = next;
  }
  if (at !== end || !entry) throw badArchive();
  const { offset, name, size, compressed, method, flags, crc } = entry;
  if (size > MARKDOWN_LIMIT || compressed > MARKDOWN_LIMIT + 65_536) throw largeArchive();
  if (flags & ~0x080e || (method !== 0 && method !== 8) || (method === 0 && compressed !== size) ||
    offset + 30 > directory || u32(offset) !== 0x04034b50 || u16(offset + 6) !== flags || u16(offset + 8) !== method || u16(offset + 26) !== name.length) throw badArchive();
  const dataOffset = offset + 30 + name.length + u16(offset + 28);
  if (dataOffset + compressed > directory || !name.every((byte, index) => byte === bytes[offset + 30 + index])) throw badArchive();
  if (!(flags & 8) && (u32(offset + 14) !== crc || u32(offset + 18) !== compressed || u32(offset + 22) !== size)) throw badArchive();
  const input = bytes.subarray(dataOffset, dataOffset + compressed);
  let output: Uint8Array = input;
  if (method === 8) {
    if (!input.length) throw badArchive();
    output = new Uint8Array(size);
    let written = 0;
    const inflater = new Inflate(chunk => {
      if (written + chunk.byteLength > size) throw badArchive();
      output.set(chunk, written);
      written += chunk.byteLength;
    });
    for (let start = 0; start < input.length; start += 1024) inflater.push(input.subarray(start, start + 1024), start + 1024 >= input.length);
    if (written !== size) throw badArchive();
  }
  let check = 0xffffffff;
  for (const byte of output) check = crcTable[(check ^ byte) & 255] ^ (check >>> 8);
  if (((check ^ 0xffffffff) >>> 0) !== crc) throw badArchive();
  const markdown = utf8.decode(output).replace(/\r\n?/g, '\n').trim();
  if (markdown.length > KNOWLEDGE_TEXT_LIMIT) throw largeArchive();
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/.test(markdown) || !/[\p{L}\p{N}]/u.test(markdown.replace(/!\[[^\]\n]*\]\([^\n)]*\)/g, ''))) throw badArchive();
  return markdown;
}

export async function pollMineruPdf(token: string, batchId: string, request: typeof fetch = fetch): Promise<MineruStatus> {
  if (typeof batchId !== 'string' || !ID.test(batchId)) throw taskExpired();
  const data = await apiRequest(request, token, `/extract-results/batch/${batchId}`);
  if (data.batch_id !== batchId || !Array.isArray(data.extract_result) || data.extract_result.length > 1) throw fail('MinerU 返回的任务信息不完整，请稍后重试。');
  if (!data.extract_result.length) return { status: 'pending' };
  const result = record(data.extract_result[0]);
  switch (result?.state) {
    case 'waiting-file': case 'uploading': case 'pending': case 'converting': return { status: 'pending' };
    case 'running': {
      const progress = record(result.extract_progress);
      const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
      const pages = count(progress?.extracted_pages), totalPages = count(progress?.total_pages);
      return pages !== undefined && totalPages && pages <= totalPages ? { status: 'running', pages, totalPages } : { status: 'running' };
    }
    case 'failed': throw fail('MinerU 解析失败，请检查 PDF 是否加密、损坏或超限后重试。', 422);
    case 'done': {
      const url = trustedUrl(result.full_zip_url, RESULT_ORIGIN, '结果');
      return providerRequest(request, url, { method: 'GET' }, TRANSFER_TIMEOUT, async (response, signal) => {
        if (!response.ok) throw fail('MinerU 解析结果暂时无法下载，请稍后重试。');
        const bytes = await boundedBytes(response, ZIP_LIMIT, signal, largeArchive);
        try { return { status: 'done', text: markdownFromZip(bytes) }; }
        catch (error) { throw error instanceof MineruClientError ? error : badArchive(); }
      });
    }
    default: throw fail('MinerU 返回的解析状态异常，请稍后重试。');
  }
}
