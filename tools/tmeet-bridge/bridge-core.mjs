import { spawn } from 'node:child_process';
import { open, constants, mkdtemp, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { isIP } from 'node:net';

export const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const MAX_CLI_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_BYTES = 900000;
const MAX_PAGES = 200;

class BridgeError extends Error {
  constructor(message, code = 'BRIDGE_ERROR') { super(message); this.code = code; }
}
const fail = (message, code) => { throw new BridgeError(message, code); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const str = (value) => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
const abortCheck = (signal) => { if (signal?.aborted) throw signal.reason instanceof BridgeError ? signal.reason : new BridgeError('同步任务已中止。', 'ABORTED'); };
const loopback = (host) => ['localhost', '127.0.0.1', '[::1]'].includes(host);

export function validateConfig(value) {
  if (!object(value)) fail('同步助手配置格式无效。');
  let url;
  try { url = new URL(value.apiOrigin); } catch { fail('apiOrigin 必须是合法的 HTTPS origin。'); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('apiOrigin 只能包含协议、主机和端口。');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url.hostname))) fail('apiOrigin 必须使用 HTTPS；仅本机回环地址允许 HTTP。');
  for (const key of ['serviceAccessToken', 'deviceId', 'deviceToken']) {
    if (typeof value[key] !== 'string' || !value[key] || value[key].length > 16384 || /[\x00-\x20\x7f]/.test(value[key])) fail('同步助手凭证配置无效。');
  }
  return { apiOrigin: url.origin, serviceAccessToken: value.serviceAccessToken, deviceId: value.deviceId, deviceToken: value.deviceToken };
}

export async function loadConfig(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || (process.getuid && info.uid !== process.getuid())) fail('配置必须由当前用户持有，且权限为 0600。');
    if (info.size > 65536) fail('同步助手配置过大。');
    return validateConfig(JSON.parse(await handle.readFile('utf8')));
  } finally { await handle.close(); }
}

function validateArgv(args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.length > 8192 || /[\x00-\x1f\x7f]/.test(arg))) fail('不允许执行该 CLI 命令。');
  if (args.length === 1 && args[0] === '--version') return;
  if (args.length === 2 && args[0] === 'auth' && args[1] === 'status') return;
  if (args[0] !== 'record') fail('不允许执行该 CLI 命令。');
  const allowed = {
    search: new Set(['page-size', 'page-token', 'query', 'meeting-code']),
    content: new Set(['action', 'record-file-id', 'meeting-id', 'pid', 'limit']),
    access: new Set(['action', 'meeting-record-id', 'page-token', 'page-size']),
  }[args[1]];
  if (!allowed) fail('不允许执行该 CLI 命令。');
  const seen = new Map();
  for (const arg of args.slice(2)) {
    const match = /^--([a-z-]+)=(.+)$/s.exec(arg);
    if (!match || !allowed.has(match[1]) || seen.has(match[1])) fail('不允许执行该 CLI 参数。');
    seen.set(match[1], match[2]);
  }
  if (args[1] === 'content' && (!['minutes', 'transcript', 'paragraphs'].includes(seen.get('action')) || !seen.get('record-file-id'))) fail('不允许执行该 CLI 内容操作。');
  if (args[1] === 'access' && (seen.get('action') !== 'address' || !seen.get('meeting-record-id'))) fail('不允许执行该 CLI 地址操作。');
}

/** The only subprocess boundary: no shell, no credentials in argv, fixed read-only commands. */
export function createCliRunner(tmeetPath, { timeoutMs = 60000, signal } = {}) {
  if (!isAbsolute(tmeetPath)) fail('tmeet 路径必须为绝对路径。');
  return async (args) => {
    validateArgv(args);
    abortCheck(signal);
    const stdout = await new Promise((resolve, reject) => {
      let output = '';
      let size = 0;
      let failure;
      let done = false;
      let killTimer;
      const child = spawn(tmeetPath, args, {
        shell: false, detached: process.platform !== 'win32', cwd: homedir(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH || ''}` },
      });
      const kill = () => {
        try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch { /* already stopped */ }
        killTimer ??= setTimeout(() => {
          try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already stopped */ }
        }, 1000);
        killTimer.unref();
      };
      const onAbort = () => { failure = signal.reason instanceof BridgeError ? signal.reason : new BridgeError('同步任务已中止。', 'ABORTED'); kill(); };
      const timer = setTimeout(() => { failure = new BridgeError('腾讯会议 CLI 执行超时。', 'CLI_TIMEOUT'); kill(); }, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        size += Buffer.byteLength(chunk);
        if (size > MAX_CLI_BYTES) { failure = new BridgeError('腾讯会议返回内容过大，未读取完整。', 'CLI_OUTPUT_LIMIT'); kill(); }
        else output += chunk;
      });
      // Drain stderr without retaining account information, URLs, or server messages.
      child.stderr.resume();
      const finish = (error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error || failure) reject(failure || error); else resolve(output.trim());
      };
      child.once('error', () => finish(new BridgeError('无法运行本机腾讯会议 CLI，请检查安装路径。', 'CLI_UNAVAILABLE')));
      child.once('close', (code) => finish(code === 0 ? undefined : new BridgeError('腾讯会议读取失败，请检查授权、内容权限或生成状态。', 'CLI_FAILED')));
    });
    if (args[0] === '--version' || args[0] === 'auth') return stdout;
    let parsed;
    try { parsed = JSON.parse(stdout); } catch { fail('腾讯会议返回结构无法识别。', 'CLI_FORMAT'); }
    if (!object(parsed) || parsed.error || (parsed.code !== undefined && ![0, '0'].includes(parsed.code))) fail('腾讯会议读取失败，请检查内容权限或生成状态。', 'CLI_FAILED');
    return parsed;
  };
}

function dataOf(response) {
  let value = object(response) && Object.hasOwn(response, 'data') ? response.data : response;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { fail('腾讯会议返回结构无法识别。', 'CLI_FORMAT'); } }
  if (!object(value)) fail('腾讯会议返回结构无法识别。', 'CLI_FORMAT');
  return value;
}
function cursorOf(data) {
  const token = str(data.next_page_token);
  const explicit = data.has_more ?? data.has_remaining;
  if ((explicit === false && token) || (explicit === true && !token)) fail('腾讯会议分页结构不一致，未读取完整。', 'PAGINATION');
  if (token) return { hasMore: true, pageToken: token };
  if (explicit === true) fail('腾讯会议缺少下一页游标。', 'PAGINATION');
  if (Number(data.total_page) > Number(data.current_page || 1)) fail('腾讯会议仍有后续分页，但未返回可用游标。', 'PAGINATION');
  return { hasMore: false };
}
const safeValue = (value, max = 8192) => {
  if (typeof value !== 'string' || !value || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail('会议任务参数无效。', 'INVALID_JOB');
  return value;
};
const kindOf = (meeting, file) => {
  const type = str(file.file_type || file.record_type || meeting.record_type).toLowerCase();
  return ['5', 'audio', 'm4a', 'mp3', 'wav', 'aac', 'ogg', 'flac'].includes(type) ? 'audio' : ['0', '4', 'video', 'mp4'].includes(type) ? 'video' : 'unknown';
};
const stateOf = (value) => {
  const state = str(value);
  return /^(3|ready|completed|finished)$/i.test(state) ? 'ready'
    : /^(1|recording)$/i.test(state) ? 'recording'
      : /^(2|transcoding|processing)$/i.test(state) ? 'transcoding' : 'unavailable';
};
const startTimeOf = (value) => {
  const text = str(value);
  if (/^\d{10,13}$/.test(text)) {
    const milliseconds = text.length === 10 ? Number(text) * 1000 : Number(text);
    return new Date(milliseconds).toISOString();
  }
  return text;
};
function normalizeRecord(meeting, file) {
  const meetingRecordId = str(meeting.meeting_record_id);
  const recordFileId = str(file.record_file_id);
  if (!meetingRecordId || !recordFileId) fail('腾讯会议录制缺少可用文件标识。', 'CLI_FORMAT');
  const value = {
    key: `${meetingRecordId}:${recordFileId}`, meetingRecordId, recordFileId,
    ...(str(meeting.meeting_id) ? { meetingId: str(meeting.meeting_id) } : {}),
    ...(str(meeting.meeting_code) ? { meetingCode: str(meeting.meeting_code) } : {}),
    subject: str(meeting.subject || meeting.topic || meeting.file_name) || '未命名录制', state: stateOf(meeting.state ?? (recordFileId ? 'ready' : 'unavailable')),
  };
  const start = startTimeOf(file.record_start_time || meeting.media_start_time || meeting.meeting_start_time);
  if (start) value.startedAt = start;
  value.kind = kindOf(meeting, file);
  return value;
}
async function addressFiles(record, runCli, selectedFileId) {
  let token;
  const seen = new Set();
  const files = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = dataOf(await runCli(['record', 'access', '--action=address', `--meeting-record-id=${safeValue(record.meetingRecordId)}`, '--page-size=30', ...(token ? [`--page-token=${token}`] : [])]));
    if (!Array.isArray(data.record_files)) fail('腾讯会议录制地址结构无法识别。', 'CLI_FORMAT');
    files.push(...data.record_files);
    if (selectedFileId && files.some((file) => str(file.record_file_id) === selectedFileId)) return files;
    const cursor = cursorOf(data);
    if (!cursor.hasMore) return files;
    if (seen.has(cursor.pageToken)) fail('腾讯会议分页游标未前进。', 'PAGINATION');
    seen.add(cursor.pageToken);
    token = cursor.pageToken;
  }
  fail('录制文件分页超过本次读取上限。', 'PAGINATION');
}

export async function searchRecords(input, runCli) {
  if (!object(input)) fail('会议搜索参数无效。', 'INVALID_JOB');
  const args = ['record', 'search', '--page-size=30'];
  if (input.query) args.push(`--query=${safeValue(input.query, 50)}`);
  if (input.meetingCode) {
    if (!/^\d{6,20}$/.test(input.meetingCode)) fail('会议号必须为纯数字。', 'INVALID_JOB');
    args.push(`--meeting-code=${input.meetingCode}`);
  }
  if (input.pageToken) args.push(`--page-token=${safeValue(input.pageToken)}`);
  const data = dataOf(await runCli(args));
  const meetings = Array.isArray(data.records) ? data.records : data.record_meetings;
  if (!Array.isArray(meetings)) fail('腾讯会议录制列表结构无法识别。', 'CLI_FORMAT');
  const records = [];
  for (const meeting of meetings) {
    if (!object(meeting)) fail('腾讯会议录制条目结构无法识别。', 'CLI_FORMAT');
    if (str(meeting.record_file_id)) { records.push(normalizeRecord(meeting, meeting)); continue; }
    let files = meeting.record_files;
    if (!Array.isArray(files) && str(meeting.state) === '3' && meeting.meeting_record_id) files = await addressFiles({ meetingRecordId: str(meeting.meeting_record_id) }, runCli);
    if (!Array.isArray(files) || !files.length) {
      // Keep unfinished records visible; no invented file ID and no selectable content.
      records.push({ key: `${str(meeting.meeting_record_id)}:pending`, meetingRecordId: str(meeting.meeting_record_id), recordFileId: '', subject: str(meeting.subject) || '未命名录制', state: stateOf(meeting.state), kind: kindOf(meeting, {}) });
    } else for (const file of files) records.push(normalizeRecord(meeting, file));
  }
  return { records, ...cursorOf(data) };
}

function minutesText(data) {
  const minute = data.meeting_minute;
  if (typeof minute === 'string') return minute;
  if (!object(minute)) fail('纪要内容尚未生成或结构无法识别。');
  const values = [minute.minute, minute.todo].filter((value) => typeof value === 'string' && value.trim());
  if (Array.isArray(minute.todos)) values.push(...minute.todos.map((todo) => str(todo.content)).filter(Boolean));
  return values.join('\n\n');
}
function transcriptParagraphs(data) {
  if (!object(data.minutes) || !Array.isArray(data.minutes.paragraphs)) fail('转写内容尚未生成或结构无法识别。');
  if (data.minutes.paragraphs.some((paragraph) => !object(paragraph) || !Array.isArray(paragraph.sentences)
    || paragraph.sentences.some((sentence) => !object(sentence) || (Array.isArray(sentence.words)
      ? sentence.words.some((word) => !object(word) || typeof word.text !== 'string')
      : typeof sentence.text !== 'string')))) fail('转写文字字段结构无法识别，无法确认完整覆盖。');
  return data.minutes.paragraphs;
}
function paragraphText(value) {
  if (!Array.isArray(value.sentences)) return '';
  const text = value.sentences.map((sentence) => Array.isArray(sentence.words) ? sentence.words.map((word) => str(word.text)).join('') : str(sentence.text)).join('');
  const speaker = str(value.speaker_info?.username);
  return text ? `${speaker ? `${speaker}：` : ''}${text}` : '';
}
async function readTranscript(record, runCli) {
  const base = ['record', 'content', '--action=transcript', `--record-file-id=${safeValue(record.recordFileId)}`, ...(record.meetingId ? [`--meeting-id=${safeValue(record.meetingId)}`] : [])];
  const first = dataOf(await runCli(base));
  let paragraphs = transcriptParagraphs(first);
  const done = first.more === false || first.has_more === false;
  if (done && !first.next_page_token && first.more !== true && first.has_more !== true) return { text: paragraphs.map(paragraphText).filter(Boolean).join('\n'), complete: true };
  // File transcripts are located by real paragraph IDs, never page tokens or pid + 1.
  const byId = new Map(paragraphs.filter((item) => str(item.pid)).map((item) => [str(item.pid), item]));
  let complete = false;
  try {
    const directory = dataOf(await runCli(['record', 'content', '--action=paragraphs', `--record-file-id=${safeValue(record.recordFileId)}`, ...(record.meetingId ? [`--meeting-id=${safeValue(record.meetingId)}`] : [])]));
    const ids = Array.isArray(directory.pids) ? directory.pids.map((item) => str(item.pid)).filter(Boolean) : [];
    if (!ids.length || new Set(ids).size !== ids.length || ids.length !== Number(directory.total) || ids.length > MAX_PAGES) fail('转写段落目录不完整。');
    for (const id of ids) {
      if (byId.has(id)) continue;
      const page = dataOf(await runCli([...base, `--pid=${safeValue(id)}`, '--limit=1']));
      for (const item of transcriptParagraphs(page)) if (str(item.pid)) byId.set(str(item.pid), item);
    }
    paragraphs = ids.filter((id) => byId.has(id)).map((id) => byId.get(id));
    complete = ids.every((id) => byId.has(id));
  } catch (error) {
    if (['ABORTED', 'LEASE_LOST', 'JOB_TIMEOUT'].includes(error.code)) throw error;
    // Preserve successfully read source even when a later page fails.
    paragraphs = [...byId.values()];
  }
  return { text: paragraphs.map(paragraphText).filter(Boolean).join('\n'), complete };
}

const AUDIO_TYPES = { m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', webm: 'audio/webm' };
function audioFromFile(file, record) {
  // Only the official audio_address is accepted. download_address may contain video.
  if (!file.audio_address) return null;
  const extension = str(file.audio_address_file_type).toLowerCase().replace(/^\./, '');
  if (!Object.hasOwn(AUDIO_TYPES, extension)) fail('音频下载格式无法确认。');
  const name = str(record.subject).replace(/[\/\\\x00-\x1f\x7f]/g, '_').slice(0, 120) || '会议录音';
  return { url: file.audio_address, filename: `${name}.${extension}`, contentType: AUDIO_TYPES[extension] };
}

export async function importRecord(input, runCli, { uploadAudio: sendAudio, signal } = {}) {
  if (!object(input) || !object(input.record) || typeof input.includeAudio !== 'boolean') fail('会议导入参数无效。', 'INVALID_JOB');
  const record = input.record;
  safeValue(record.recordFileId);
  safeValue(record.meetingRecordId);
  if (!['ready', '3', 'completed', 'finished'].includes(str(record.state).toLowerCase())) fail('录制中、转码中或不可用，请就绪后再导入。', 'NOT_READY');
  let minutes = '';
  let transcript = '';
  let complete = true;
  let audioImported = false;
  const warnings = [];
  try {
    minutes = minutesText(dataOf(await runCli(['record', 'content', '--action=minutes', `--record-file-id=${record.recordFileId}`])));
    if (!minutes.trim()) { complete = false; warnings.push('会议纪要为空或尚未生成。'); }
  } catch (error) {
    abortCheck(signal);
    if (['ABORTED', 'LEASE_LOST', 'JOB_TIMEOUT'].includes(error.code)) throw error;
    complete = false;
    warnings.push('会议纪要读取失败，请检查内容权限或生成状态；未更改任何分享权限。');
  }
  try {
    const result = await readTranscript(record, runCli);
    transcript = result.text;
    complete &&= result.complete;
    if (!result.complete) warnings.push('转写仅获取部分内容，无法确认完整覆盖。');
    if (!transcript.trim()) { complete = false; warnings.push('转写正文为空或尚未生成。'); }
  } catch (error) {
    abortCheck(signal);
    if (['ABORTED', 'LEASE_LOST', 'JOB_TIMEOUT'].includes(error.code)) throw error;
    complete = false;
    warnings.push('转写读取失败，请检查内容权限或生成状态。');
  }
  if (Buffer.byteLength(`${minutes}\n${transcript}`) > MAX_TEXT_BYTES) fail('会议正文超过 900 KB 本次导入上限，未将其标记为完整。', 'TEXT_LIMIT');
  if (input.includeAudio) {
    try {
      abortCheck(signal);
      const files = await addressFiles(record, runCli, record.recordFileId);
      const file = files.find((item) => str(item.record_file_id) === record.recordFileId);
      const media = file && audioFromFile(file, record);
      if (!media || !sendAudio) warnings.push('当前录制未提供可下载的音频，音频未导入；纪要和转写可单独保存。');
      else { await sendAudio(media); audioImported = true; }
    } catch (error) {
      abortCheck(signal);
      if (['ABORTED', 'LEASE_LOST', 'JOB_TIMEOUT'].includes(error.code)) throw error;
      warnings.push(error instanceof BridgeError && ['AUDIO_LIMIT', 'AUDIO_TYPE'].includes(error.code) ? error.message : '音频下载或上传失败，音频未导入；已读取的文字保留。');
    }
  }
  if (!minutes.trim() && !transcript.trim() && !audioImported) fail('没有读取到可用的会议纪要、转写或音频，请检查权限或等待生成完成。', 'NO_CONTENT');
  return { minutes, transcript, complete, warnings };
}

function serviceHeaders(config) {
  return { 'OAI-Sites-Authorization': `Bearer ${config.serviceAccessToken}`, Authorization: `Bearer ${config.deviceToken}` };
}
async function apiRequest(config, path, body, { fetchImpl = fetch, signal, timeoutMs = 30000 } = {}) {
  abortCheck(signal);
  let response;
  try {
    response = await fetchImpl(`${config.apiOrigin}/api/meeting-bridge/${path}`, {
      method: 'POST', headers: { ...serviceHeaders(config), 'content-type': 'application/json' },
      body: JSON.stringify(body), redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
  } catch {
    abortCheck(signal);
    fail('无法连接营销工作台同步服务。', 'NETWORK');
  }
  if (!response.ok) fail(path === 'heartbeat' ? '同步任务租约已失效，已停止本机读取。' : `同步服务拒绝请求（HTTP ${response.status}）。`, path === 'heartbeat' ? 'LEASE_LOST' : 'API_REJECTED');
  try { return await response.json(); } catch { fail('同步服务返回结构无法识别。', 'API_FORMAT'); }
}

function validateAudioUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('音频下载地址无效。'); }
  if (url.protocol !== 'https:' || url.username || url.password || loopback(url.hostname) || isIP(url.hostname.replace(/^\[|\]$/g, ''))) fail('音频下载必须使用外部 HTTPS 地址。');
  if (url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local')) fail('音频下载地址无效。');
  return url.href;
}

export async function uploadAudio(config, job, media, { fetchImpl = fetch, signal } = {}) {
  const url = validateAudioUrl(media.url);
  abortCheck(signal);
  // Signed download links are short-lived; never forward either workbench credential.
  const response = await fetchImpl(url, { redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000) });
  if (!response.ok) fail('音频下载不可用，音频未导入。');
  const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('audio/')) { await response.body?.cancel(); fail('下载内容未确认为音频，音频未导入。', 'AUDIO_TYPE'); }
  const length = Number(response.headers.get('content-length'));
  if (length > MAX_AUDIO_BYTES) { await response.body?.cancel(); fail('音频超过 50 MB 上限，音频未导入。', 'AUDIO_LIMIT'); }
  if (!response.body) fail('音频下载为空，音频未导入。');
  // R2 requires a known length. Spool in a private temporary file, keeping both
  // download and upload streaming and bounding disk usage without buffering audio.
  const temporary = await mkdtemp(join(tmpdir(), 'tmeet-bridge-audio-'));
  const path = join(temporary, 'audio');
  let handle;
  let stream;
  let size = 0;
  const reader = response.body.getReader();
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    for (;;) {
      abortCheck(signal);
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_AUDIO_BYTES) fail('音频超过 50 MB 上限，音频未导入。', 'AUDIO_LIMIT');
      await handle.writeFile(value);
    }
    await handle.close();
    handle = undefined;
    if (!size) fail('音频下载为空，音频未导入。');
    stream = createReadStream(path);
    const uploaded = await fetchImpl(`${config.apiOrigin}/api/meeting-bridge/media`, {
      method: 'POST', redirect: 'error', duplex: 'half', body: stream,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000),
      headers: { ...serviceHeaders(config), 'content-type': type, 'content-length': String(size),
        'x-meeting-device-id': config.deviceId, 'x-meeting-job-id': job.id,
        'x-meeting-lease-token': job.leaseToken, 'x-meeting-filename': encodeURIComponent(media.filename) },
    });
    if (!uploaded.ok) fail('音频上传被同步服务拒绝，音频未导入。');
    const result = await uploaded.json();
    if (!object(result) || !object(result.media) || !str(result.media.id)) fail('同步服务未确认音频已保存，音频未导入。');
    return result;
  } catch (error) {
    abortCheck(signal);
    if (error instanceof BridgeError) throw error;
    fail('音频下载或上传失败，音频未导入。');
  } finally {
    stream?.destroy();
    await handle?.close().catch(() => {});
    await reader.cancel().catch(() => {});
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function runOnce(rawConfig, options = {}) {
  const config = validateConfig(rawConfig);
  const { tmeetPath, fetchImpl = fetch, heartbeatMs = 30000, cliTimeoutMs = 60000, jobTimeoutMs = 600000, logger = () => {} } = options;
  const probe = createCliRunner(tmeetPath, { timeoutMs: cliTimeoutMs, signal: options.signal });
  let cliVersion = 'unknown';
  let authenticated = false;
  try { cliVersion = (str(await probe(['--version'])).match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/) || [])[0] || 'unknown'; } catch { /* report unavailable without opening login */ }
  try {
    const status = str(await probe(['auth', 'status']));
    authenticated = /(^|\n)\s*Logged in\b/i.test(status) && !/not logged in|session has expired|RefreshToken:\s*expired/i.test(status);
  } catch { /* a failed status is explicitly unauthenticated */ }
  const response = await apiRequest(config, 'poll', { deviceId: config.deviceId, cliVersion, authenticated }, { fetchImpl, signal: options.signal });
  if (!object(response) || !Object.hasOwn(response, 'job')) fail('同步服务未返回有效任务。', 'API_FORMAT');
  const job = response.job;
  if (!job) return { authenticated, worked: false };
  if (!object(job) || !['search', 'import'].includes(job.kind)) fail('同步服务任务类型无效。', 'INVALID_JOB');
  safeValue(job.id, 256);
  safeValue(job.leaseToken, 8192);
  const controller = new AbortController();
  const onAbort = () => controller.abort(new BridgeError('同步任务已中止。', 'ABORTED'));
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timer = setTimeout(() => controller.abort(new BridgeError('同步任务超过 10 分钟上限，已停止读取。', 'JOB_TIMEOUT')), jobTimeoutMs);
  let heartbeatInFlight;
  const heartbeat = setInterval(() => {
    if (heartbeatInFlight || controller.signal.aborted) return;
    heartbeatInFlight = apiRequest(config, 'heartbeat', { deviceId: config.deviceId, jobId: job.id, leaseToken: job.leaseToken }, { fetchImpl, signal: controller.signal })
      .catch(() => controller.abort(new BridgeError('同步任务租约无法续期，已停止本机读取。', 'LEASE_LOST')))
      .finally(() => { heartbeatInFlight = undefined; });
  }, heartbeatMs);
  const runCli = createCliRunner(tmeetPath, { timeoutMs: cliTimeoutMs, signal: controller.signal });
  let result;
  let error;
  try {
    if (!authenticated) fail('本机腾讯会议尚未授权，请在本机完成官方登录。', 'UNAUTHENTICATED');
    result = job.kind === 'search' ? await searchRecords(job.input, runCli) : await importRecord(job.input, runCli, {
      signal: controller.signal,
      uploadAudio: (media) => uploadAudio(config, job, media, { fetchImpl, signal: controller.signal }),
    });
    abortCheck(controller.signal);
  } catch (caught) {
    error = caught instanceof BridgeError ? caught.message : '本机读取失败，请检查 CLI、授权或内容权限。';
  }
  try {
    if (controller.signal.reason?.code === 'LEASE_LOST' || controller.signal.reason?.code === 'ABORTED') throw controller.signal.reason;
    await apiRequest(config, 'complete', { deviceId: config.deviceId, jobId: job.id, leaseToken: job.leaseToken, ...(error ? { error } : { result }) }, {
      fetchImpl, signal: controller.signal.reason?.code === 'JOB_TIMEOUT' ? options.signal : controller.signal, timeoutMs: 180000,
    });
    logger(error ? '会议同步任务未完成，请查看工作台中的状态。' : '会议同步任务已回传。');
    return { authenticated, worked: true, ok: !error };
  } finally {
    clearInterval(heartbeat);
    if (heartbeatInFlight) await heartbeatInFlight;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

export async function resolveExecutable(name, envPath = process.env.PATH || '') {
  if (isAbsolute(name)) return name;
  if (name.includes('/') || name.includes('\\')) fail('可执行文件路径必须为绝对路径。');
  for (const directory of envPath.split(':').filter(Boolean)) {
    const path = join(directory, name);
    try { const handle = await open(path, constants.O_RDONLY); const info = await handle.stat(); await handle.close(); if (info.isFile() && (info.mode & 0o111)) return path; } catch { /* try next */ }
  }
  fail('未找到本机 tmeet，请先安装官方腾讯会议 CLI。', 'CLI_UNAVAILABLE');
}
