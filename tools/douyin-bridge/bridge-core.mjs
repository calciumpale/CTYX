import { open, constants, mkdir, rename, unlink, chmod, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class BridgeError extends Error {
  constructor(message, code = 'BRIDGE_ERROR') { super(message); this.code = code; }
}
const fail = (message, code) => { throw new BridgeError(message, code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const loopback = host => ['localhost', '127.0.0.1', '[::1]'].includes(host);
const hash = value => createHash('sha256').update(value).digest('hex');
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,256}$/.test(value);
export const checkAbort = signal => { if (signal?.aborted) throw new BridgeError('任务已停止，请检查设备连接或任务状态。', 'ABORTED'); };
export const safeError = error => error instanceof BridgeError ? error.message : '本地页面操作未完成，请检查浏览器、登录和页面结构。';

export function profileIdentity(value) {
  let url; try { url = new URL(value); } catch { fail('缺少有效的抖音用户主页。', 'INVALID_PROFILE'); }
  if (url.protocol !== 'https:' || !['www.douyin.com', 'douyin.com'].includes(url.hostname) || url.username || url.password || url.port) fail('只接受抖音公开用户主页。', 'INVALID_PROFILE');
  const match = /^\/user\/([a-zA-Z0-9_.-]{5,140})\/?$/.exec(url.pathname);
  if (!match || match[1] === 'self') fail('用户主页缺少稳定身份，不能发送。', 'INVALID_PROFILE');
  return { id: match[1], url: `https://www.douyin.com/user/${match[1]}` };
}
export function videoIdentity(value) {
  let url; try { url = new URL(value); } catch { fail('视频地址无效。', 'INVALID_VIDEO'); }
  const match = /^\/video\/(\d{1,30})\/?$/.exec(url.pathname);
  if (url.protocol !== 'https:' || !['www.douyin.com', 'douyin.com'].includes(url.hostname) || url.username || url.password || url.port || !match) fail('只接受抖音公开视频完整地址。', 'INVALID_VIDEO');
  return { id: match[1], url: `https://www.douyin.com/video/${match[1]}` };
}

export function validateConfig(value) {
  if (!object(value)) fail('配置必须为 JSON 对象。', 'INVALID_CONFIG');
  let origin; try { origin = new URL(value.origin); } catch { fail('origin 必须为工作台的完整 HTTPS 域名。', 'INVALID_CONFIG'); }
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback(origin.hostname)))) fail('origin 只允许 HTTPS 域名；本机回环地址可使用 HTTP。', 'INVALID_CONFIG');
  for (const key of ['deviceId', 'deviceToken']) if (typeof value[key] !== 'string' || !value[key] || value[key].length > 16384 || /[\x00-\x20\x7f]/.test(value[key])) fail('设备凭证不完整。', 'INVALID_CONFIG');
  if (value.sitesToken !== undefined && (typeof value.sitesToken !== 'string' || !value.sitesToken || value.sitesToken.length > 16384 || /[\x00-\x20\x7f]/.test(value.sitesToken))) fail('私站凭证格式无效。', 'INVALID_CONFIG');
  let cdpUrl;
  if (value.cdpUrl) {
    let url; try { url = new URL(value.cdpUrl); } catch { fail('cdpUrl 无效。', 'INVALID_CONFIG'); }
    if (!['http:', 'ws:'].includes(url.protocol) || !loopback(url.hostname) || url.username || url.password || url.search || url.hash) fail('CDP 仅允许显式配置的本机回环地址。', 'INVALID_CONFIG');
    cdpUrl = url.href;
  }
  return { origin: origin.origin, deviceId: value.deviceId, deviceToken: value.deviceToken, ...(value.sitesToken ? { sitesToken: value.sitesToken } : {}), ...(cdpUrl ? { cdpUrl } : {}) };
}

async function privateWrite(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); await handle.close(); handle = undefined;
    await rename(temp, path); await chmod(path, 0o600);
    const directory = await open(dirname(path), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await handle?.close().catch(() => {}); await unlink(temp).catch(() => {}); }
}
export async function saveConfig(path, value) { await privateWrite(resolve(path), validateConfig(value)); }
async function privateRead(path, maxBytes) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || (process.getuid && info.uid !== process.getuid()) || info.size > maxBytes) fail('本地配置或日志必须由当前用户持有，权限为 0600，且大小未超限。', 'PRIVATE_FILE');
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}
export async function loadConfig(path) { return validateConfig(await privateRead(path, 65536)); }

// The complete endpoint accepts 1,600,000 UTF-8 bytes, not characters. Reserve
// space for the lease/device envelope and bound the serialized result itself.
export const MAX_COLLECTION_RESULT_BYTES = 1450000;
const clipText = (value, max) => {
  if (typeof value !== 'string') return '';
  const clipped = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(0, max);
  // Never leave half a surrogate pair when a field ends at its UTF-16 limit.
  return /[\uD800-\uDBFF]$/.test(clipped) ? clipped.slice(0, -1) : clipped;
};
export function boundCollectionResult(value) {
  if (!object(value) || !Array.isArray(value.comments)) fail('采集结果缺少评论列表。', 'INVALID_RESULT');
  const warnings = Array.isArray(value.warnings) ? value.warnings.filter(item => typeof item === 'string').slice(0, 7).map(item => clipText(item, 500)) : [];
  const comments = [];
  let usedBytes = Buffer.byteLength(JSON.stringify({ comments: [], warnings }), 'utf8') + 1024;
  let clippedContent = false, byteLimited = false;
  for (const row of value.comments.slice(0, 300)) {
    if (!object(row) || typeof row.text !== 'string' || !row.text.trim()) continue;
    const content = clipText(row.text, 2000); if (content !== row.text) clippedContent = true;
    const item = { id: clipText(row.id, 140), videoId: clipText(row.videoId, 30), videoUrl: clipText(row.videoUrl, 200), text: content, nickname: clipText(row.nickname, 100), source: 'browser',
      ...(typeof row.recipientId === 'string' ? { recipientId: clipText(row.recipientId, 140) } : {}),
      ...(typeof row.profileUrl === 'string' ? { profileUrl: clipText(row.profileUrl, 300) } : {}),
      ...(typeof row.postedAt === 'string' ? { postedAt: clipText(row.postedAt, 60) } : {}) };
    const bytes = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
    if (usedBytes + bytes > MAX_COLLECTION_RESULT_BYTES) { byteLimited = true; break; }
    comments.push(item); usedBytes += bytes;
  }
  if (value.comments.length > 300) warnings.push('评论超过 300 条上限，本次仅保留前 300 条以内的数据。');
  if (clippedContent) warnings.push('部分评论正文超过 2000 字符或包含控制字符，已截断或清理；完整内容请查看来源视频。');
  if (byteLimited) warnings.push(`采集结果达到 UTF-8 上传字节上限，本次保留前 ${comments.length} 条；其余未上传，不代表完整采集。`);
  return { comments, ...(warnings.length ? { warnings } : {}) };
}

export function validateJob(value) {
  if (!object(value) || !id(value.id) || !id(value.campaignId) || typeof value.leaseToken !== 'string' || !value.leaseToken || value.leaseToken.length > 8192 || !object(value.input)) fail('工作台任务格式无效。', 'INVALID_JOB');
  const input = { ...value.input };
  if (value.kind === 'send') {
    const target = profileIdentity(input.profileUrl);
    if (input.recipientId && input.recipientId !== target.id) fail('目标身份与主页不一致。', 'INVALID_RECIPIENT');
    if (!id(input.senderAccountId)) fail('发送任务未绑定发送账号。', 'INVALID_SENDER');
    if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 1000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(input.message)) fail('招呼内容必须为 1–1000 字。', 'INVALID_MESSAGE');
    input.recipientId = target.id; input.profileUrl = target.url;
  } else if (value.kind === 'collect') {
    if (!Array.isArray(input.videos) || !input.videos.length || input.videos.length > 30) fail('每次请选择 1–30 个具体视频。', 'INVALID_VIDEOS');
    input.videos = [...new Map(input.videos.map(video => { const parsed = videoIdentity(video?.url); if (video.id !== parsed.id) fail('视频 ID 与来源地址不一致。', 'INVALID_VIDEO'); return [parsed.id, { ...parsed, title: String(video.title || '').slice(0, 200) }]; })).values()];
    input.maxCommentsPerVideo = Math.max(1, Math.min(50, Math.trunc(Number(input.maxCommentsPerVideo) || 50)));
  } else if (value.kind === 'discover') {
    if (input.keywords !== undefined && (!Array.isArray(input.keywords) || input.keywords.some(keyword => typeof keyword !== 'string' || keyword.length > 120))) fail('搜索词格式无效。', 'INVALID_KEYWORDS');
    if (input.requirements !== undefined && (typeof input.requirements !== 'string' || input.requirements.length > 10000)) fail('需求描述过长。', 'INVALID_KEYWORDS');
  } else fail('不支持的任务类型。', 'INVALID_JOB');
  return { ...value, input };
}

/** Imports existing exports only. This module never bundles or invokes MediaCrawler. */
export function normalizeMediaCrawler(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 5 * 1024 * 1024) fail('导入文件必须小于 5 MB。', 'IMPORT_LIMIT');
  let rows;
  try { const parsed = JSON.parse(text); rows = Array.isArray(parsed) ? parsed : [parsed]; }
  catch { try { rows = text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)); } catch { fail('导入文件不是有效 JSON 或 JSONL。', 'IMPORT_FORMAT'); } }
  const comments = new Map();
  for (const row of rows) {
    if (!object(row) || !/^\d{1,30}$/.test(String(row.aweme_id || '')) || !/^[a-zA-Z0-9_.:-]{1,140}$/.test(String(row.comment_id || '')) || typeof row.content !== 'string' || !row.content.trim()) continue;
    const comment = { id: String(row.comment_id), videoId: String(row.aweme_id), videoUrl: `https://www.douyin.com/video/${row.aweme_id}`, text: row.content.slice(0, 5000), nickname: String(row.nickname || '').slice(0, 100), source: 'mediacrawler' };
    // Imported crawler data is analysis-only, even when an older export has
    // contact identifiers. Only current visible-browser evidence is contactable.
    comments.set(comment.id, comment); if (comments.size >= 300) break;
  }
  return { comments: [...comments.values()], warnings: ['导入最多 300 条；所有 MediaCrawler 导入仅供分析，不能私信。MediaCrawler 商用需另行获得许可。'] };
}

export class Journal {
  static async open(path) {
    path = resolve(path); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const lockPath = `${path}.lock`; let lock;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let prior; try { prior = JSON.parse(await readFile(lockPath, 'utf8')); } catch { fail('执行器日志锁无法确认，请检查是否已有执行器正在运行。', 'JOURNAL_LOCKED'); }
        if (!Number.isInteger(prior.pid) || prior.pid <= 0) fail('执行器日志锁无效，请人工检查。', 'JOURNAL_LOCKED');
        try { process.kill(prior.pid, 0); fail('已有执行器正在运行，不能同时启动。', 'JOURNAL_LOCKED'); }
        catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
        await unlink(lockPath);
      }
    }
    if (!lock) fail('执行器正在运行。', 'JOURNAL_LOCKED');
    await lock.writeFile(JSON.stringify({ pid: process.pid })); await lock.sync();
    const journal = new Journal(path, lockPath, lock);
    try {
      try { journal.data = await privateRead(path, 32 * 1024 * 1024); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (journal.data.version !== 1 || !Array.isArray(journal.data.entries)) fail('日志版本无效，已停止以免重复发送。', 'JOURNAL_FORMAT');
      for (const entry of journal.data.entries) {
        if (entry.dispatchedAt && !entry.result) { entry.result = { outcome: 'unknown', error: '上次发送在提交后中断，请核对原会话；不会重发。' }; entry.reported = false; }
        else if (!entry.result && !entry.error) { entry.error = '上次读取或发送准备中断；未再次执行该任务。'; entry.reported = false; }
      }
      await journal.save(); return journal;
    } catch (error) { await journal.close(); throw error; }
  }
  constructor(path, lockPath, lock) { this.path = path; this.lockPath = lockPath; this.lock = lock; this.data = { version: 1, entries: [] }; }
  get(jobId) { return this.data.entries.find(entry => entry.id === jobId); }
  async save() { await privateWrite(this.path, this.data); }
  async close() { if (this.lock) { await this.lock.close(); this.lock = null; await unlink(this.lockPath).catch(() => {}); } }
  async bindAccount(accountId) { this.data.accountId = accountId; await this.save(); }
  async bindConfig(config) {
    const scope = hash(`${config.origin}\n${config.deviceId}`);
    if (this.data.scope && this.data.scope !== scope) fail('本地日志属于其他设备配对，已停止以免向错误工作台上传。', 'PAIRING_CHANGED');
    if (!this.data.scope) { this.data.scope = scope; await this.save(); }
  }
  async start(job) {
    const fingerprint = hash(JSON.stringify({ kind: job.kind, campaignId: job.campaignId, input: job.input }));
    const existing = this.get(job.id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) fail('任务内容发生变化，不能复用原发送记录。', 'JOB_CHANGED');
      existing.leaseToken = job.leaseToken; await this.save(); return existing;
    }
    const entry = { id: job.id, kind: job.kind, campaignId: job.campaignId, leaseToken: job.leaseToken, fingerprint, startedAt: new Date().toISOString(), reported: false };
    this.data.entries.push(entry); await this.save(); return entry;
  }
  async dispatch(job) {
    const entry = this.get(job.id); if (!entry || entry.dispatchedAt) fail('发送任务已有提交记录，不会重发。', 'ALREADY_DISPATCHED');
    const recipientKey = hash(`${job.input.senderAccountId}\n${job.input.recipientId}`);
    if (this.data.entries.some(item => item.recipientKey === recipientKey && item.dispatchedAt)) fail('该账号已向目标提交过招呼或结果未知，不会重复发送。', 'DUPLICATE_RECIPIENT');
    if (this.data.lastSendAt && Date.now() - this.data.lastSendAt < 60000) fail('本机发送间隔不足 60 秒，请稍后重新审核排队。', 'SEND_COOLDOWN');
    entry.dispatchedAt = new Date().toISOString(); entry.recipientKey = recipientKey; this.data.lastSendAt = Date.now(); await this.save();
  }
  async finish(jobId, payload) { const entry = this.get(jobId); Object.assign(entry, payload, { finishedAt: new Date().toISOString(), reported: false }); await this.save(); }
  async reported(jobId) { this.get(jobId).reported = true; await this.save(); }
}

export async function apiRequest(config, action, body, { fetchImpl = fetch, signal } = {}) {
  checkAbort(signal);
  const headers = { Authorization: `Bearer ${config.deviceToken}`, 'content-type': 'application/json' };
  if (config.sitesToken) headers['OAI-Sites-Authorization'] = `Bearer ${config.sitesToken}`;
  let response;
  const timeoutMs = action === 'poll' ? 45000 : 20000;
  try { response = await fetchImpl(`${config.origin}/api/prospecting-bridge/${action}`, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) }); }
  catch { checkAbort(signal); fail('工作台暂时无法连接；已保存结果，不会重复发送。', 'NETWORK'); }
  if (!response.ok) { const error = new BridgeError(`工作台拒绝请求（HTTP ${response.status}）。`, action === 'heartbeat' ? 'LEASE_LOST' : 'API_REJECTED'); error.status = response.status; throw error; }
  try { return await response.json(); } catch { fail('工作台响应格式无法识别。', 'API_FORMAT'); }
}

export async function runOnce(rawConfig, { adapter, journal, fetchImpl = fetch, signal, heartbeatMs = 30000, jobTimeoutMs = 600000, logger = () => {} } = {}) {
  const config = validateConfig(rawConfig);
  await journal.bindConfig(config);
  const request = (action, body, requestSignal = signal) => apiRequest(config, action, body, { fetchImpl, signal: requestSignal });
  const report = async entry => {
    try { await request('complete', { deviceId: config.deviceId, jobId: entry.id, leaseToken: entry.leaseToken, ...(entry.result ? { result: entry.result } : { error: entry.error }) }); await journal.reported(entry.id); return true; }
    catch (error) {
      if (error.code === 'API_REJECTED' && [400, 404, 405, 409, 410, 413, 415, 422].includes(error.status)) {
        entry.reportRejected = true;
        entry.reportRejection = { status: error.status, code: error.code, at: new Date().toISOString(), evidence: safeError(error) };
        await journal.save(); logger(`工作台拒绝该结果（HTTP ${error.status}），证据已保留在本机；停止重复上报并继续后续任务。`); return true;
      }
      logger('结果尚未上报，稍后仅重试上报。'); return false;
    }
  };
  for (const entry of journal.data.entries.filter(item => !item.reported && !item.reportRejected && (item.result || item.error))) if (!await report(entry)) return { worked: false, pendingReport: true };
  checkAbort(signal);
  let account;
  try { account = await adapter.accountStatus({ signal }); } catch (error) { account = { authenticated: false, message: safeError(error) }; }
  const changed = account.authenticated && journal.data.accountId && journal.data.accountId !== account.accountId;
  if (changed) account = { ...account, authenticated: false, message: '浏览器账号已变化，请运行 login 明确确认新账号。' };
  if (account.authenticated && !journal.data.accountId) await journal.bindAccount(account.accountId);
  const polled = await request('poll', { deviceId: config.deviceId, authenticated: account.authenticated === true, accountId: account.accountId, accountName: account.accountName, message: account.message });
  if (!object(polled) || !Object.hasOwn(polled, 'job')) fail('工作台未返回有效任务。', 'API_FORMAT');
  if (!polled.job) return { worked: false, authenticated: account.authenticated };
  const job = validateJob(polled.job); const prior = journal.get(job.id); const entry = await journal.start(job);
  if (prior) {
    if (!entry.result && !entry.error) await journal.finish(job.id, job.kind === 'send' ? { result: { outcome: 'unknown', error: '已有执行记录，不能重复执行。' } } : { error: '任务已有执行记录。' });
    if (!entry.reportRejected) await report(entry); return { worked: true, replayed: true };
  }
  const controller = new AbortController();
  const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), jobTimeoutMs);
  let heartbeatInFlight;
  const beat = async () => {
    const result = await request('heartbeat', { deviceId: config.deviceId, jobId: job.id, leaseToken: job.leaseToken }, controller.signal);
    if (result?.ok !== true) fail('任务租约未确认，停止执行。', 'LEASE_LOST');
  };
  const heartbeat = setInterval(() => { if (!heartbeatInFlight && !controller.signal.aborted) heartbeatInFlight = beat().catch(() => controller.abort()).finally(() => { heartbeatInFlight = null; }); }, heartbeatMs);
  try {
    if (!account.authenticated) fail(account.message || '请先在专用浏览器中登录抖音。', 'UNAUTHENTICATED');
    let result;
    if (job.kind === 'send') {
      if (account.accountId !== job.input.senderAccountId) fail('发送账号与审核时账号不同，请重新确认。', 'ACCOUNT_CHANGED');
      result = await adapter.send(job.input, { signal: controller.signal, beforeDispatch: async () => {
        checkAbort(controller.signal); await beat(); checkAbort(controller.signal); await journal.dispatch(job);
      } });
      if (!object(result) || !['submitted', 'failed', 'unknown'].includes(result.outcome)) result = { outcome: 'unknown', error: '发送响应无法确认，请核对原会话。' };
      if (result.outcome === 'submitted' && !entry.dispatchedAt) result = { outcome: 'failed', error: '发送适配器缺少提交记录，结果未采纳。' };
    } else {
      result = job.kind === 'discover' ? await adapter.discover(job.input, { signal: controller.signal }) : await adapter.collect(job.input, { signal: controller.signal });
      checkAbort(controller.signal);
      if (job.kind === 'collect') result = boundCollectionResult(result);
    }
    await journal.finish(job.id, { result });
  } catch (error) {
    await journal.finish(job.id, job.kind === 'send' ? { result: { outcome: entry.dispatchedAt ? 'unknown' : 'failed', error: entry.dispatchedAt ? '发送动作已开始，但结果无法确认。请核对原会话；不会重发。' : safeError(error) } } : { error: safeError(error) });
  } finally {
    clearInterval(heartbeat); clearTimeout(timer); signal?.removeEventListener('abort', abort); if (heartbeatInFlight) await heartbeatInFlight;
  }
  const reported = await report(journal.get(job.id));
  return { worked: true, pendingReport: !reported, authenticated: account.authenticated };
}
