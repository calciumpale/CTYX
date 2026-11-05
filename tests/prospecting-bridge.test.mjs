import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig, saveConfig, loadConfig, normalizeMediaCrawler, validateJob, runOnce, Journal } from '../tools/douyin-bridge/bridge-core.mjs';
import { DouyinBrowserAdapter } from '../tools/douyin-bridge/browser-adapter.mjs';

const config = { origin: 'https://workbench.example', deviceId: 'device-1', deviceToken: 'private-device-token' };
const sendJob = (id = 'job-1') => ({ id, campaignId: 'campaign-1', kind: 'send', leaseToken: 'lease-1', input: { senderAccountId: 'sender-1', recipientId: 'recipient-1', profileUrl: 'https://www.douyin.com/user/recipient-1', message: '你好，想了解你的需求。' } });
async function temporary(t) { const dir = await mkdtemp(join(tmpdir(), 'prospecting-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
async function journalFor(t) { const journal = await Journal.open(join(await temporary(t), 'journal.json')); t.after(() => journal.close()); return journal; }
const account = () => ({ authenticated: true, accountId: 'sender-1', accountName: '我' });
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('config stays private and never accepts remote CDP or insecure cloud origin', async t => {
  assert.throws(() => validateConfig({ ...config, origin: 'http://public.example' }));
  assert.throws(() => validateConfig({ ...config, cdpUrl: 'http://evil.example:9222' }));
  assert.throws(() => validateConfig({ ...config, origin: 'https://workbench.example/path' }));
  const path = join(await temporary(t), 'config.json'); await saveConfig(path, config);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await loadConfig(path)).deviceToken, config.deviceToken);
});

test('job validation binds recipient to profile and limits collection', () => {
  assert.throws(() => validateJob({ ...sendJob(), input: { ...sendJob().input, recipientId: 'someone-else' } }));
  assert.throws(() => validateJob({ ...sendJob(), input: { ...sendJob().input, profileUrl: 'https://evil.example/user/recipient-1' } }));
  const job = validateJob({ id: 'collect', campaignId: 'c', leaseToken: 'l', kind: 'collect', input: { maxCommentsPerVideo: 999, videos: [{ id: '123', url: 'https://www.douyin.com/video/123', title: '视频' }] } });
  assert.equal(job.input.maxCommentsPerVideo, 50);
});

test('MediaCrawler anonymous exports keep source text but never invent contact identity', () => {
  const imported = normalizeMediaCrawler('{"comment_id":"100","aweme_id":"123","content":"多少钱","creator_hash":"abcdef1234567890","nickname":"用***户"}\n');
  assert.equal(imported.comments[0].text, '多少钱');
  assert.equal(imported.comments[0].source, 'mediacrawler');
  assert.equal(imported.comments[0].recipientId, undefined);
  assert.equal(imported.comments[0].profileUrl, undefined);
  assert.ok(imported.warnings.length);
  const legacy = normalizeMediaCrawler(JSON.stringify([{ comment_id: '101', aweme_id: '123', content: '咨询', profile_url: 'https://www.douyin.com/user/legacy-1', user_id: '12345678' }]));
  assert.equal(legacy.comments[0].profileUrl, undefined);
  assert.equal(legacy.comments[0].recipientId, undefined);
});

test('journal never reports one device results using another device credentials', async t => {
  const journal = await journalFor(t); let requests = 0;
  await runOnce(config, { adapter: { accountStatus: account }, journal, fetchImpl: async () => response({ job: null }) });
  await assert.rejects(runOnce({ ...config, deviceId: 'other-device' }, { adapter: { accountStatus: account }, journal, fetchImpl: async () => { requests++; return response({ job: null }); } }), /配对/);
  assert.equal(requests, 0);
});

test('reporting failures retry completion only, never repeat a browser send', async t => {
  const journal = await journalFor(t); let sends = 0, completes = 0, polls = 0;
  const adapter = { accountStatus: account, async send(input, { beforeDispatch }) { await beforeDispatch(); sends++; return { outcome: 'submitted', evidence: '观察到新消息' }; } };
  const fetchImpl = async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer private-device-token');
    assert.equal(options.headers['OAI-Sites-Authorization'], undefined);
    if (url.endsWith('/poll')) { polls++; return response({ job: polls === 1 ? sendJob() : null }); }
    if (url.endsWith('/complete')) { completes++; if (completes === 1) throw Error('offline'); return response({ ok: true }); }
    return response({ ok: true });
  };
  await runOnce(config, { adapter, journal, fetchImpl });
  await runOnce(config, { adapter, journal, fetchImpl });
  assert.equal(sends, 1); assert.equal(completes, 2);
  assert.equal(journal.get('job-1').reported, true);
});

test('large Chinese collections fit the complete API UTF-8 budget with truthful truncation', async t => {
  const journal = await journalFor(t); let completed;
  const job = { id: 'large-collection', campaignId: 'campaign-1', leaseToken: 'lease-1', kind: 'collect', input: { videos: [{ id: '12345', url: 'https://www.douyin.com/video/12345', title: '视频' }], maxCommentsPerVideo: 50 } };
  const comments = Array.from({ length: 300 }, (_, i) => ({ id: `comment-${i}`, videoId: '12345', videoUrl: 'https://www.douyin.com/video/12345', text: '需求'.repeat(i === 0 ? 1500 : 1000), nickname: '目标客户', recipientId: `reader-${i}`, profileUrl: `https://www.douyin.com/user/reader-${i}`, source: 'browser' }));
  const adapter = { accountStatus: account, collect: async () => ({ comments }) };
  await runOnce(config, { adapter, journal, fetchImpl: async (url, options) => {
    if (url.endsWith('/poll')) return response({ job });
    if (url.endsWith('/complete')) {
      assert.ok(Buffer.byteLength(options.body, 'utf8') < 1500000, 'completion payload must fit below server 1.6 MB limit');
      completed = JSON.parse(options.body).result;
    }
    return response({ ok: true });
  } });
  assert.ok(completed, 'oversized results must be normalized before posting');
  assert.ok(completed.comments.length > 0 && completed.comments.length < 300);
  assert.ok(completed.comments.every(comment => comment.text.length <= 2000));
  assert.ok(completed.warnings.some(warning => /截|上限/.test(warning)));
  assert.equal(journal.get(job.id).reported, true);
});

test('permanent result rejection is retained without blocking the next poll', async t => {
  const journal = await journalFor(t); let polls = 0, completes = 0, sends = 0;
  const adapter = { accountStatus: account, send: async (input, { beforeDispatch }) => { await beforeDispatch(); sends++; return { outcome: 'submitted', evidence: '本地观察到消息' }; } };
  const fetchImpl = async url => {
    if (url.endsWith('/poll')) { polls++; return response({ job: polls === 1 ? sendJob() : null }); }
    if (url.endsWith('/complete')) { completes++; return response({ error: 'too large' }, 413); }
    return response({ ok: true });
  };
  await runOnce(config, { adapter, journal, fetchImpl }); await runOnce(config, { adapter, journal, fetchImpl });
  assert.equal(sends, 1); assert.equal(completes, 1); assert.equal(polls, 2);
  const entry = journal.get('job-1');
  assert.equal(entry.reportRejected, true); assert.equal(entry.reportRejection.status, 413);
  assert.equal(entry.result.outcome, 'submitted'); assert.equal(entry.result.evidence, '本地观察到消息');
});

test('rate-limited completion remains retryable and never re-executes the action', async t => {
  const journal = await journalFor(t); let polls = 0, completes = 0, sends = 0;
  const adapter = { accountStatus: account, send: async (input, { beforeDispatch }) => { await beforeDispatch(); sends++; return { outcome: 'unknown', error: '待核对' }; } };
  const fetchImpl = async url => {
    if (url.endsWith('/poll')) { polls++; return response({ job: sendJob() }); }
    if (url.endsWith('/complete')) { completes++; return response({ error: 'rate limited' }, 429); }
    return response({ ok: true });
  };
  await runOnce(config, { adapter, journal, fetchImpl }); await runOnce(config, { adapter, journal, fetchImpl });
  assert.equal(sends, 1); assert.equal(completes, 2); assert.equal(polls, 1);
  assert.equal(journal.get('job-1').reportRejected, undefined);
});

test('a crash after dispatch becomes unknown and duplicate job cannot send again', async t => {
  const journal = await journalFor(t); let sends = 0; const completed = [];
  const adapter = { accountStatus: account, async send(input, { beforeDispatch }) { await beforeDispatch(); sends++; throw Error('page disappeared'); } };
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/poll')) return response({ job: sendJob() });
    if (url.endsWith('/complete')) completed.push(JSON.parse(options.body).result);
    return response({ ok: true });
  };
  await runOnce(config, { adapter, journal, fetchImpl }); await runOnce(config, { adapter, journal, fetchImpl });
  assert.equal(sends, 1); assert.equal(completed[0].outcome, 'unknown');
  const disk = JSON.parse(await readFile(journal.path, 'utf8'));
  assert.equal(disk.entries[0].result.outcome, 'unknown');
});

test('a persisted dispatch recovered after restart is unknown without execution', async t => {
  const dir = await temporary(t); const path = join(dir, 'journal.json');
  let journal = await Journal.open(path); await journal.start(sendJob()); await journal.dispatch(sendJob()); await journal.close();
  journal = await Journal.open(path); t.after(() => journal.close());
  assert.equal(journal.get('job-1').result.outcome, 'unknown');
  assert.equal(journal.get('job-1').reported, false);
});

test('account change and lease loss stop before any dispatch', async t => {
  const journal = await journalFor(t); let sends = 0;
  const adapter = { accountStatus: account, async send(input, { beforeDispatch }) { await beforeDispatch(); sends++; return { outcome: 'submitted' }; } };
  const fetchImpl = async url => url.endsWith('/poll') ? response({ job: sendJob() }) : url.endsWith('/heartbeat') ? response({ error: 'expired' }, 409) : response({ ok: true });
  await runOnce(config, { adapter, journal, fetchImpl });
  assert.equal(sends, 0); assert.equal(journal.get('job-1').dispatchedAt, undefined);
  assert.equal(journal.get('job-1').result.outcome, 'failed');
});

test('a second process cannot acquire the same journal', async t => {
  const journal = await journalFor(t); await assert.rejects(Journal.open(journal.path), /正在运行/);
});

test('a newly observed sender cannot silently replace the bound account', async t => {
  const journal = await journalFor(t); await journal.bindAccount('sender-1'); let sends = 0, polled;
  const adapter = { accountStatus: () => ({ authenticated: true, accountId: 'sender-2', accountName: '另一个账号' }), send: async () => { sends++; return { outcome: 'submitted' }; } };
  await runOnce(config, { adapter, journal, fetchImpl: async (url, options) => {
    if (url.endsWith('/poll')) { polled = JSON.parse(options.body); return response({ job: sendJob() }); }
    return response({ ok: true });
  } });
  assert.equal(polled.authenticated, false); assert.equal(sends, 0);
  assert.equal(journal.get('job-1').result.outcome, 'failed');
});

const browserTest = process.env.PROSPECT_BROWSER_TEST === '1' ? test : test.skip;
async function fixture(t, { echo = true, wrongTarget = false, challenge = false } = {}) {
  const { chromium } = await import('../tools/douyin-bridge/node_modules/playwright/index.mjs');
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const context = await browser.newContext(); let clicks = 0;
  await context.exposeBinding('countSend', () => { clicks++; });
  const header = '<header><a aria-label="我的主页" href="/user/sender-1">我</a></header>';
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'www.douyin.com') return route.abort();
    const body = challenge ? '<div role="dialog">请完成安全验证</div>' : url.pathname.startsWith('/search/')
      ? '<main><article><a href="/video/123">智能客服如何提效</a><a href="/user/competitor-1">真实竞品</a></article><article><a href="/video/124">客服自动化</a><a href="/user/competitor-1">真实竞品</a></article></main>'
      : url.pathname.startsWith('/video/')
        ? '<main><div data-e2e="comment-list">' + Array.from({ length: 55 }, (_, i) => `<div data-e2e="comment-item" data-comment-id="${i + 100}"><a href="/user/reader-${i}">用户${i}</a><span data-e2e="comment-content">多少钱 ${i}</span><time datetime="2026-11-05">今天</time></div>`).join('') + '</div></main>'
        : '<main><h1>目标用户</h1><button onclick="document.querySelector(\'[role=dialog]\').hidden=false">私信</button><section role="dialog" hidden><header><a href="/user/' + (wrongTarget ? 'someone-else' : 'recipient-1') + '">目标用户</a></header><div data-e2e="message-list"></div><textarea placeholder="发送消息"></textarea><button onclick="window.countSend();' + (echo ? 'const m=document.createElement(\'p\');m.dataset.e2e=\'message-item\';m.textContent=document.querySelector(\'textarea\').value;document.querySelector(\'[data-e2e=message-list]\').append(m);' : '') + '">发送</button></section></main>';
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><meta charset="utf-8"></head><body>${header}${body}</body></html>` });
  });
  const adapter = new DouyinBrowserAdapter(context, { timeoutMs: 800, confirmationMs: 500, scrollDelayMs: 10 });
  return { adapter, clicks: () => clicks };
}

browserTest('browser discovers real account/video links and caps actual visible comments at 50', async t => {
  const { adapter } = await fixture(t);
  assert.equal((await adapter.accountStatus()).accountId, 'sender-1');
  const result = await adapter.discover({ keywords: ['客服'] });
  assert.equal(result.candidates[0].id, 'competitor-1'); assert.equal(result.candidates[0].videos.length, 2);
  const collected = await adapter.collect({ videos: result.candidates[0].videos.slice(0, 1), maxCommentsPerVideo: 50 });
  assert.equal(collected.comments.length, 50); assert.equal(collected.comments[0].profileUrl, 'https://www.douyin.com/user/reader-0');
});

browserTest('browser submits once only after target verification and persistent dispatch callback', async t => {
  const { adapter, clicks } = await fixture(t); let dispatched = false;
  const result = await adapter.send(sendJob().input, { beforeDispatch: async () => { assert.equal(clicks(), 0); dispatched = true; } });
  assert.ok(dispatched); assert.equal(clicks(), 1); assert.equal(result.outcome, 'submitted');
});

browserTest('browser no-echo after one send is unknown, and wrong conversation is not sent', async t => {
  const missing = await fixture(t, { echo: false });
  assert.equal((await missing.adapter.send(sendJob().input, { beforeDispatch: async () => {} })).outcome, 'unknown');
  assert.equal(missing.clicks(), 1);
  const wrong = await fixture(t, { wrongTarget: true }); let dispatches = 0;
  await assert.rejects(wrong.adapter.send(sendJob().input, { beforeDispatch: async () => { dispatches++; } }), /目标会话/);
  assert.equal(wrong.clicks(), 0); assert.equal(dispatches, 0);
});

browserTest('account change during final lease renewal cannot trigger a send', async t => {
  const { adapter, clicks } = await fixture(t);
  const result = await adapter.send(sendJob().input, { beforeDispatch: async () => {
    const page = await adapter.page();
    await page.locator('a[aria-label="我的主页"]').evaluate(link => link.href = '/user/sender-2');
  } });
  assert.equal(clicks(), 0); assert.equal(result.outcome, 'unknown');
});

browserTest('browser stops at verification instead of attempting to bypass it', async t => {
  const { adapter } = await fixture(t, { challenge: true });
  await assert.rejects(adapter.discover({ keywords: ['客服'] }), /验证/);
});
