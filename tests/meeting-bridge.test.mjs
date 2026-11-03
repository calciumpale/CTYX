import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const core = () => import('../tools/tmeet-bridge/bridge-core.mjs');
const config = { apiOrigin: 'https://workbench.example', serviceAccessToken: 'sites-test-secret', deviceId: 'device-test', deviceToken: 'device-test-secret' };
const record = { key: 'record-1:file-1', meetingRecordId: 'record-1', recordFileId: 'file-1', meetingId: 'meeting-1', meetingCode: '123456789', subject: '客户访谈', state: '3', kind: 'audio' };
const envelope = (data) => ({ trace_id: 'test-trace', message: 'success', data });
const paragraph = (pid, text) => ({ pid, speaker_info: { username: '客户' }, sentences: [{ sid: `s${pid}`, words: [{ text }] }] });
const cliFixture = async (t, body) => {
  const dir = await mkdtemp(join(tmpdir(), 'meeting-bridge-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'tmeet');
  await writeFile(path, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  return { dir, path };
};

test('rejects insecure remote origins and config readable by other users', async (t) => {
  const { validateConfig, loadConfig } = await core();
  assert.throws(() => validateConfig({ ...config, apiOrigin: 'http://evil.example' }), /HTTPS/);
  assert.throws(() => validateConfig({ ...config, apiOrigin: 'https://u:password@workbench.example' }), /origin/i);
  assert.throws(() => validateConfig({ ...config, apiOrigin: 'https://workbench.example/path' }), /origin/i);
  assert.equal(validateConfig({ ...config, apiOrigin: 'http://127.0.0.1:8080' }).apiOrigin, 'http://127.0.0.1:8080');
  const { dir } = await cliFixture(t, '');
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify(config), { mode: 0o644 });
  await assert.rejects(loadConfig(path), /0600/);
  await chmod(path, 0o600);
  assert.deepEqual(await loadConfig(path), config);
});

test('normalizes documented recording files and preserves the search cursor', async () => {
  const { searchRecords } = await core();
  const calls = [];
  const result = await searchRecords({ query: '客户;$(touch nope)', pageToken: 'cursor-in' }, async (args) => {
    calls.push(args);
    return envelope(JSON.stringify({ record_meetings: [{ meeting_record_id: 'r', meeting_id: 'm', meeting_code: '123456789', subject: '访谈', state: 3, record_type: 5, record_files: [{ record_file_id: 'f', record_start_time: '2026-11-04T10:00+08:00' }] }], next_page_token: 'cursor-out', has_more: true }));
  });
  assert.deepEqual(result, { records: [{ key: 'r:f', meetingRecordId: 'r', recordFileId: 'f', meetingId: 'm', meetingCode: '123456789', subject: '访谈', state: 'ready', startedAt: '2026-11-04T10:00+08:00', kind: 'audio' }], hasMore: true, pageToken: 'cursor-out' });
  assert.deepEqual(calls, [['record', 'search', '--page-size=30', '--query=客户;$(touch nope)', '--page-token=cursor-in']]);
});

test('normalizes the live CLI flat records schema without inventing audio or losing the cursor', async () => {
  const { searchRecords } = await core();
  let calls = 0;
  const result = await searchRecords({}, async () => {
    calls += 1;
    return envelope({ has_more: true, next_page_token: 'live-next', records: [{ creator_name: '测试用户', duration_seconds: 0, file_name: '转写_快速会议', file_type: 'transcript', has_smart_minutes: true, has_transcript_content: true, meeting_code: '123456789', meeting_id: 'm123', meeting_record_id: 'r123', meeting_start_time: '2026-11-03T23:50:31+08:00', record_end_time: '', record_file_id: 'f123', record_start_time: '2026-11-03T23:50:36+08:00', subject: '快速会议' }], total_count: 1 });
  });
  assert.deepEqual(result, { records: [{ key: 'r123:f123', meetingRecordId: 'r123', recordFileId: 'f123', meetingId: 'm123', meetingCode: '123456789', subject: '快速会议', state: 'ready', startedAt: '2026-11-03T23:50:36+08:00', kind: 'unknown' }], hasMore: true, pageToken: 'live-next' });
  assert.equal(calls, 1);
});

test('malformed recording responses are errors, not empty successful results', async () => {
  const { searchRecords } = await core();
  await assert.rejects(searchRecords({}, async () => envelope({ unexpected: [] })), /结构/);
});

test('the CLI runner rejects writes and cannot interpret shell syntax', async (t) => {
  const { createCliRunner } = await core();
  const { path, dir } = await cliFixture(t, 'process.stdout.write(JSON.stringify({data:{argv:process.argv.slice(2)}}));');
  const run = createCliRunner(path);
  const result = await run(['record', 'search', '--query=$(touch /tmp/meeting-shell-must-not-execute)']);
  assert.deepEqual(result.data.argv, ['record', 'search', '--query=$(touch /tmp/meeting-shell-must-not-execute)']);
  await assert.rejects(run(['auth', 'login']), /不允许/);
  await assert.rejects(run(['record', 'share-set', '--download-enable']), /不允许/);
  assert.ok(dir);
});

test('CLI timeout kills a stalled process and does not expose its stderr', async (t) => {
  const { createCliRunner } = await core();
  const { path } = await cliFixture(t, 'process.stderr.write("secret-token\\n"); setInterval(()=>{},1000);');
  const run = createCliRunner(path, { timeoutMs: 350 });
  await assert.rejects(run(['record', 'search']), (error) => /超时/.test(error.message) && !error.message.includes('secret-token'));
});

test('imports distinct minutes and transcript with explicit complete coverage', async () => {
  const { importRecord } = await core();
  const result = await importRecord({ record, includeAudio: false }, async (args) => args.includes('--action=minutes')
    ? envelope({ meeting_minute: { minute: '讨论采购方案。', todo: '下周提交报价。' } })
    : envelope({ minutes: { paragraphs: [paragraph('p1', '我们计划采购。')] }, more: false }));
  assert.deepEqual(result, { minutes: '讨论采购方案。\n\n下周提交报价。', transcript: '客户：我们计划采购。', complete: true, warnings: [] });
});

test('uses returned paragraph IDs to fill truncated transcripts without arithmetic or duplicates', async () => {
  const { importRecord } = await core();
  const calls = [];
  const result = await importRecord({ record, includeAudio: false }, async (args) => {
    calls.push(args);
    if (args.includes('--action=minutes')) return envelope({ meeting_minute: { minute: '摘要' } });
    if (args.includes('--action=paragraphs')) return envelope({ total: 3, pids: [{ pid: 'alpha' }, { pid: 'z-9' }, { pid: 'last' }] });
    if (args.includes('--pid=z-9')) return envelope({ minutes: { paragraphs: [paragraph('z-9', '第二段')] }, more: true });
    if (args.includes('--pid=last')) return envelope({ minutes: { paragraphs: [paragraph('last', '最后一段')] }, more: false });
    return envelope({ minutes: { paragraphs: [paragraph('alpha', '第一段')] }, more: true });
  });
  assert.equal(result.transcript, '客户：第一段\n客户：第二段\n客户：最后一段');
  assert.equal(result.complete, true);
  assert.ok(calls.some((args) => args.includes('--pid=z-9') && args.includes('--limit=1')));
  assert.equal(calls.filter((args) => args.includes('--pid=alpha')).length, 0);
});

test('keeps partial source and reports missing transcript coverage', async () => {
  const { importRecord } = await core();
  const result = await importRecord({ record, includeAudio: false }, async (args) => {
    if (args.includes('--action=minutes')) return envelope({ meeting_minute: { minute: '摘要' } });
    if (args.includes('--action=paragraphs')) return envelope({ pids: [], total: 4 });
    return envelope({ minutes: { paragraphs: [paragraph('alpha', '第一段')] }, more: true });
  });
  assert.equal(result.transcript, '客户：第一段');
  assert.equal(result.complete, false);
  assert.ok(result.warnings.some((value) => /完整|部分/.test(value)));
});

test('ordinary denied content is not retried or turned into permission mutations', async () => {
  const { importRecord } = await core();
  const calls = [];
  const result = await importRecord({ record, includeAudio: false }, async (args) => {
    calls.push(args);
    if (args.includes('--action=minutes')) throw new Error('secret-token permission denied');
    return envelope({ minutes: { paragraphs: [paragraph('p', '原文')] }, more: false });
  });
  assert.equal(calls.length, 2);
  assert.equal(result.minutes, '');
  assert.equal(result.transcript, '客户：原文');
  assert.equal(result.complete, false);
  assert.equal(JSON.stringify(result).includes('secret-token'), false);
});

test('recording or transcoding states never read unfinished content', async () => {
  const { importRecord } = await core();
  let calls = 0;
  await assert.rejects(importRecord({ record: { ...record, state: '2' }, includeAudio: false }, async () => { calls += 1; }), /转码|录制/);
  assert.equal(calls, 0);
});

test('audio import matches the selected file across address pages and uploads audio only', async () => {
  const { importRecord } = await core();
  const uploads = [];
  const result = await importRecord({ record, includeAudio: true }, async (args) => {
    if (args.includes('--action=minutes')) return envelope({ meeting_minute: { minute: '摘要' } });
    if (args.includes('--action=transcript')) return envelope({ minutes: { paragraphs: [paragraph('p', '原文')] }, more: false });
    if (args.includes('--page-token=next')) return envelope({ record_files: [{ record_file_id: 'file-1', audio_address: 'https://media.example/audio.m4a', audio_address_file_type: 'm4a' }], has_more: false });
    return envelope({ record_files: [{ record_file_id: 'other', audio_address: 'https://media.example/wrong.m4a' }], next_page_token: 'next' });
  }, { uploadAudio: async (media) => { uploads.push(media); } });
  assert.deepEqual(uploads, [{ url: 'https://media.example/audio.m4a', filename: '客户访谈.m4a', contentType: 'audio/mp4' }]);
  assert.deepEqual(result.warnings, []);
});

test('unavailable audio remains a warning and never substitutes the video URL', async () => {
  const { importRecord } = await core();
  let uploaded = false;
  const result = await importRecord({ record, includeAudio: true }, async (args) => {
    if (args.includes('--action=minutes')) return envelope({ meeting_minute: { minute: '摘要' } });
    if (args.includes('--action=transcript')) return envelope({ minutes: { paragraphs: [paragraph('p', '原文')] }, more: false });
    return envelope({ record_files: [{ record_file_id: 'file-1', download_address: 'https://media.example/video.mp4', download_address_file_type: 'mp4' }], has_more: false });
  }, { uploadAudio: async () => { uploaded = true; } });
  assert.equal(uploaded, false);
  assert.ok(result.warnings.some((value) => /音频/.test(value)));
  assert.equal(result.complete, true);
});

test('finding the selected audio file does not read unrelated later address pages', async () => {
  const { importRecord } = await core();
  let addressCalls = 0;
  const uploads = [];
  const result = await importRecord({ record, includeAudio: true }, async (args) => {
    if (args.includes('--action=minutes')) return envelope({ meeting_minute: { minute: '摘要' } });
    if (args.includes('--action=transcript')) return envelope({ minutes: { paragraphs: [paragraph('p', '原文')] }, more: false });
    addressCalls += 1;
    if (addressCalls > 1) throw new Error('unrelated later page denied');
    return envelope({ record_files: [{ record_file_id: 'file-1', audio_address: 'https://media.example/audio.m4a', audio_address_file_type: 'm4a' }], next_page_token: 'unrelated' });
  }, { uploadAudio: async (media) => uploads.push(media) });
  assert.equal(addressCalls, 1);
  assert.equal(uploads.length, 1);
  assert.equal(result.warnings.length, 0);
});

test('malformed transcript words cannot be silently treated as complete coverage', async () => {
  const { importRecord } = await core();
  const result = await importRecord({ record, includeAudio: false }, async (args) => args.includes('--action=minutes')
    ? envelope({ meeting_minute: { minute: '摘要' } })
    : envelope({ minutes: { paragraphs: [paragraph('one', '完整段'), { pid: 'two', sentences: [{ words: [{ content: 'unrecognized text field' }] }] }] }, more: false }));
  assert.equal(result.complete, false);
  assert.ok(result.warnings.length);
});

test('poll and completion use both credentials while CLI and logs never receive them', async (t) => {
  const { runOnce } = await core();
  const { path } = await cliFixture(t, `const a=process.argv.slice(2); if(a[0]==='--version')console.log('tmeet version 1.1.0'); else if(a[0]==='auth')console.log('Logged in\\n  RefreshToken: valid'); else console.log(JSON.stringify({data:{record_meetings:[],has_more:false}}));`);
  const calls = [];
  const logs = [];
  await runOnce(config, { tmeetPath: path, logger: (value) => logs.push(value), fetchImpl: async (url, init) => {
    calls.push({ url, headers: new Headers(init.headers), body: JSON.parse(init.body) });
    return Response.json(url.endsWith('/poll') ? { job: { id: 'job', leaseToken: 'lease', kind: 'search', input: {} } } : { ok: true });
  } });
  assert.equal(calls[0].headers.get('OAI-Sites-Authorization'), 'Bearer sites-test-secret');
  assert.equal(calls[0].headers.get('Authorization'), 'Bearer device-test-secret');
  assert.deepEqual(calls[0].body, { deviceId: 'device-test', cliVersion: '1.1.0', authenticated: true });
  assert.deepEqual(calls.at(-1).body, { deviceId: 'device-test', jobId: 'job', leaseToken: 'lease', result: { records: [], hasMore: false } });
  assert.equal(JSON.stringify(logs).includes('secret'), false);
});

test('a zero-exit Not logged in status polls as unauthorized without attempting login', async (t) => {
  const { runOnce } = await core();
  const { path, dir } = await cliFixture(t, `const a=process.argv.slice(2); if(a[0]==='--version')console.log('tmeet version 1.1.0'); else if(a[0]==='auth'&&a[1]==='status')console.log("Not logged in. Please use 'tmeet auth login'."); else process.exit(99);`);
  const calls = [];
  await runOnce(config, { tmeetPath: path, fetchImpl: async (url, init) => { calls.push(JSON.parse(init.body)); return Response.json({ job: null }); } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authenticated, false);
  assert.ok(dir);
});

test('long imports renew their lease and stop when the lease is rejected', async (t) => {
  const { runOnce } = await core();
  const { path } = await cliFixture(t, `const a=process.argv.slice(2); if(a[0]==='--version')console.log('1.1.0'); else if(a[0]==='auth')console.log('Logged in'); else setTimeout(()=>console.log(JSON.stringify({data:{meeting_minute:{minute:'摘要'}}})),2000);`);
  const calls = [];
  await assert.rejects(runOnce(config, { tmeetPath: path, heartbeatMs: 25, fetchImpl: async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (url.endsWith('/poll')) return Response.json({ job: { id: 'job', leaseToken: 'lease', kind: 'import', input: { record, includeAudio: false } } });
    if (url.endsWith('/heartbeat')) return Response.json({ error: 'expired' }, { status: 409 });
    return Response.json({ ok: true });
  } }), /租约/);
  assert.ok(calls.some((call) => call.url.endsWith('/heartbeat') && call.body.leaseToken === 'lease'));
  assert.equal(calls.some((call) => call.url.endsWith('/complete')), false);
});

test('media upload streams bytes, enforces 50 MB, and does not forward device credentials to media hosts', async () => {
  const { uploadAudio } = await core();
  let payload;
  const job = { id: 'job', leaseToken: 'lease' };
  await uploadAudio(config, job, { url: 'https://media.example/audio.m4a', filename: '访谈.m4a', contentType: 'audio/mp4' }, { fetchImpl: async (url, init = {}) => {
    if (url.startsWith('https://media.example')) {
      assert.equal(new Headers(init.headers).has('Authorization'), false);
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mp4', 'content-length': '3' } });
    }
    payload = { headers: new Headers(init.headers), bytes: new Uint8Array(await new Response(init.body).arrayBuffer()), path: init.body.path };
    assert.equal((await stat(init.body.path)).mode & 0o777, 0o600);
    return Response.json({ media: { id: 'media' } });
  } });
  assert.deepEqual([...payload.bytes], [1, 2, 3]);
  assert.equal(payload.headers.get('content-length'), '3');
  await assert.rejects(stat(payload.path), { code: 'ENOENT' });
  assert.equal(payload.headers.get('x-meeting-filename'), encodeURIComponent('访谈.m4a'));
  assert.equal(payload.headers.get('x-meeting-lease-token'), 'lease');
  await assert.rejects(uploadAudio(config, job, { url: 'https://media.example/large', filename: 'a.m4a', contentType: 'audio/mp4' }, { fetchImpl: async () => new Response(null, { headers: { 'content-type': 'audio/mp4', 'content-length': String(50 * 1024 * 1024 + 1) } }) }), /50/);
});

test('completion keeps renewing the lease until the server has accepted the result', async (t) => {
  const { runOnce } = await core();
  const { path } = await cliFixture(t, `const a=process.argv.slice(2); if(a[0]==='--version')console.log('1.1.0'); else if(a[0]==='auth')console.log('Logged in'); else console.log(JSON.stringify({data:{record_meetings:[],has_more:false}}));`);
  let completing = false;
  let renewedWhileCompleting = 0;
  await runOnce(config, { tmeetPath: path, heartbeatMs: 15, fetchImpl: async (url) => {
    if (url.endsWith('/poll')) return Response.json({ job: { id: 'job', leaseToken: 'lease', kind: 'search', input: {} } });
    if (url.endsWith('/complete')) { completing = true; await new Promise((resolve) => setTimeout(resolve, 80)); return Response.json({ ok: true }); }
    if (completing) renewedWhileCompleting += 1;
    return Response.json({ ok: true });
  } });
  assert.ok(renewedWhileCompleting >= 2);
});

test('audio fetch rejects video responses, unsafe URLs, and streaming overflow', async () => {
  const { uploadAudio } = await core();
  const job = { id: 'job', leaseToken: 'lease' };
  const audio = { url: 'https://media.example/audio', filename: 'a.m4a', contentType: 'audio/mp4' };
  await assert.rejects(uploadAudio(config, job, audio, { fetchImpl: async () => new Response('video', { headers: { 'content-type': 'video/mp4' } }) }), /音频/);
  await assert.rejects(uploadAudio(config, job, { ...audio, url: 'http://127.0.0.1/private' }), /HTTPS|地址/);
  await assert.rejects(uploadAudio(config, job, audio, { fetchImpl: async (url, init) => {
    if (url.startsWith('https://media.example')) return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(30 * 1024 * 1024)); c.enqueue(new Uint8Array(30 * 1024 * 1024)); c.close(); } }), { headers: { 'content-type': 'audio/mp4' } });
    await new Response(init.body).arrayBuffer();
    return Response.json({ media: {} });
  } }), /50/);
});

test('a media endpoint response without an accepted media object cannot claim success', async () => {
  const { uploadAudio } = await core();
  await assert.rejects(uploadAudio(config, { id: 'job', leaseToken: 'lease' }, { url: 'https://media.example/audio', filename: 'a.m4a', contentType: 'audio/mp4' }, {
    fetchImpl: async (url, init) => {
      if (url.startsWith('https://media.example')) return new Response('audio', { headers: { 'content-type': 'audio/mp4' } });
      await new Response(init.body).arrayBuffer();
      return Response.json({ ok: false });
    },
  }), /音频/);
});

test('audio-only success is retained with explicit missing-text warnings', async () => {
  const { importRecord } = await core();
  const result = await importRecord({ record, includeAudio: true }, async (args) => {
    if (args.includes('--action=address')) return envelope({ record_files: [{ record_file_id: 'file-1', audio_address: 'https://media.example/audio.m4a', audio_address_file_type: 'm4a' }] });
    throw new Error('not generated');
  }, { uploadAudio: async () => ({ media: { id: 'saved' } }) });
  assert.equal(result.minutes, '');
  assert.equal(result.transcript, '');
  assert.equal(result.complete, false);
  assert.equal(result.warnings.length, 2);
});

test('source larger than the server limit fails explicitly instead of submitting an oversized result', async () => {
  const { importRecord } = await core();
  await assert.rejects(importRecord({ record, includeAudio: false }, async (args) => args.includes('--action=minutes')
    ? envelope({ meeting_minute: { minute: 'a'.repeat(900000) } })
    : envelope({ minutes: { paragraphs: [paragraph('p', '原文')] }, more: false })), /900/);
});

test('a job deadline stops CLI reads and reports an error instead of content success', async (t) => {
  const { runOnce } = await core();
  const { path } = await cliFixture(t, `const a=process.argv.slice(2); if(a[0]==='--version')console.log('1.1.0'); else if(a[0]==='auth')console.log('Logged in'); else setTimeout(()=>console.log(JSON.stringify({data:{record_meetings:[]}})),2000);`);
  let completed;
  await runOnce(config, { tmeetPath: path, jobTimeoutMs: 50, heartbeatMs: 1000, fetchImpl: async (url, init) => {
    if (url.endsWith('/poll')) return Response.json({ job: { id: 'job', leaseToken: 'lease', kind: 'search', input: {} } });
    completed = JSON.parse(init.body);
    return Response.json({ ok: true });
  } });
  assert.match(completed.error, /上限/);
  assert.equal(completed.result, undefined);
});

test('macOS installation writes private config and an absolute-path LaunchAgent without starting it', async (t) => {
  const { installMacAgent } = await import('../tools/tmeet-bridge/install-macos.mjs');
  const { dir, path } = await cliFixture(t, 'console.log("test");');
  const result = await installMacAgent(config, { home: dir, nodePath: process.execPath, tmeetPath: path, bridgePath: fileURLToPath(new URL('../tools/tmeet-bridge/bridge.mjs', import.meta.url)) });
  assert.equal((await stat(result.configPath)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(result.configPath, 'utf8')), config);
  const plist = await readFile(result.plistPath, 'utf8');
  assert.ok(plist.includes(process.execPath));
  assert.ok(plist.includes(path));
  assert.equal(plist.includes('sites-test-secret'), false);
  assert.equal(result.started, false);
});

test('bridge entrypoint exposes safe command usage without needing credentials', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../tools/tmeet-bridge/bridge.mjs', import.meta.url)), '--help'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 0);
  assert.match(output, /--config/);
  assert.match(output, /--once/);
});
