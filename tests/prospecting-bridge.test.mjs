import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import { BridgeError, validateConfig, saveConfig, loadConfig, normalizeMediaCrawler, validateJob, runOnce, Journal } from '../tools/douyin-bridge/bridge-core.mjs';
import { DouyinBrowserAdapter, manageOwnedBrowserWindows } from '../tools/douyin-bridge/browser-adapter.mjs';
import * as bridgeCore from '../tools/douyin-bridge/bridge-core.mjs';

const config = { origin: 'https://workbench.example', deviceId: 'device-1', deviceToken: 'private-device-token' };
const sendJob = (id = 'job-1') => ({ id, campaignId: 'campaign-1', kind: 'send', leaseToken: 'lease-1', input: { senderAccountId: 'sender-1', recipientId: 'recipient-1', profileUrl: 'https://www.douyin.com/user/recipient-1', message: '你好，想了解你的需求。' } });
async function temporary(t) { const dir = await mkdtemp(join(tmpdir(), 'prospecting-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
async function journalFor(t) { const journal = await Journal.open(join(await temporary(t), 'journal.json')); t.after(() => journal.close()); return journal; }
const account = () => ({ authenticated: true, accountId: 'sender-1', accountName: '我' });
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('desktop window controls minimize owned windows once and restore the existing verification page', async () => {
  const context = new EventEmitter();
  const page = windowId => ({ windowId, isClosed: () => false });
  const pages = [page(1), page(1)];
  const states = new Map([[1, 'normal'], [2, 'normal']]);
  const transitions = [];
  let notifyPopupMinimized;
  const popupMinimized = new Promise(resolve => { notifyPopupMinimized = resolve; });
  context.pages = () => pages;
  context.newCDPSession = async target => ({
    async send(method, params) {
      if (method === 'Browser.getWindowForTarget') return { windowId: target.windowId, bounds: { windowState: states.get(target.windowId) } };
      if (method === 'Browser.getWindowBounds') return { bounds: { windowState: states.get(params.windowId) } };
      assert.equal(method, 'Browser.setWindowBounds');
      const { windowId, bounds } = params;
      states.set(windowId, bounds.windowState);
      transitions.push([windowId, bounds.windowState]);
      if (windowId === 2 && bounds.windowState === 'minimized') notifyPopupMinimized();
    },
    async detach() {},
  });

  const setWindowState = manageOwnedBrowserWindows(context);
  await setWindowState('minimized');
  assert.deepEqual(transitions, [[1, 'minimized']]);
  const verificationPage = page(2);
  pages.push(verificationPage);
  context.emit('page', verificationPage);
  await popupMinimized;
  await setWindowState('normal');
  assert.equal(context.pages()[2], verificationPage);
  assert.deepEqual(transitions, [[1, 'minimized'], [2, 'minimized'], [1, 'normal'], [2, 'normal']]);
});

test('doctor inspects local pairing without launching a browser or claiming a live login', async t => {
  const directory = await temporary(t), path = join(directory, 'config.json');
  await saveConfig(path, config);
  const { stdout } = await promisify(execFile)(process.execPath, ['tools/douyin-bridge/bridge.mjs', 'doctor', '--config', path], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(directory, 'no-installed-browser') },
  });
  const result = JSON.parse(stdout);
  assert.equal(result.configured, true); assert.equal(result.browser, 'not-opened');
  assert.equal(result.authenticated, false); assert.equal(result.loginChecked, false);
  assert.ok(!stdout.includes(config.deviceToken));
});

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

test('send preflight failure after renewal is failed without a durable dispatch or recipient reservation', async t => {
  const journal = await journalFor(t); let renewals = 0, completed;
  const adapter = { accountStatus: account, async send(_input, { renewBeforeDispatch }) {
    await renewBeforeDispatch();
    throw new BridgeError('待发送文案发生变化。', 'MESSAGE_CHANGED');
  } };
  await runOnce(config, { adapter, journal, fetchImpl: async (url, options) => {
    if (url.endsWith('/poll')) return response({ job: sendJob() });
    if (url.endsWith('/heartbeat')) renewals++;
    if (url.endsWith('/complete')) completed = JSON.parse(options.body).result;
    return response({ ok: true });
  } });
  assert.equal(renewals, 1);
  assert.deepEqual(completed, { outcome: 'failed', error: '待发送文案发生变化。' });
  const entry = JSON.parse(await readFile(journal.path, 'utf8')).entries[0];
  assert.equal(entry.dispatchedAt, undefined); assert.equal(entry.recipientKey, undefined);
  assert.equal(journal.data.lastSendAt, undefined); assert.equal(entry.reported, true);
});

for (const separateRenewal of [true, false]) test(`send commit ${separateRenewal ? 'reuses explicit renewal' : 'renews for legacy adapters'} before durable dispatch`, async t => {
  const journal = await journalFor(t); let renewals = 0;
  const adapter = { accountStatus: account, async send(_input, { renewBeforeDispatch, beforeDispatch }) {
    if (separateRenewal) await renewBeforeDispatch();
    assert.equal(journal.get('job-1').dispatchedAt, undefined);
    await beforeDispatch();
    assert.ok(journal.get('job-1').dispatchedAt);
    return { outcome: 'submitted' };
  } };
  await runOnce(config, { adapter, journal, fetchImpl: async url => {
    if (url.endsWith('/poll')) return response({ job: sendJob() });
    if (url.endsWith('/heartbeat')) renewals++;
    return response({ ok: true });
  } });
  assert.equal(renewals, 1); assert.equal(journal.get('job-1').result.outcome, 'submitted');
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

test('temporary owner verification remains unauthenticated while returning a bounded-retry hint', async t => {
  const journal = await journalFor(t); await journal.bindAccount('sender-1'); let polled;
  const result = await runOnce(config, { journal, adapter: { accountStatus: () => ({ authenticated: false, verificationPending: true }) }, fetchImpl: async (url, options) => {
    assert.ok(url.endsWith('/poll')); polled = JSON.parse(options.body); return response({ job: null });
  } });
  assert.equal(polled.authenticated, false); assert.equal(polled.verificationPending, undefined);
  assert.deepEqual(result, { worked: false, authenticated: false, verificationPending: true });
  assert.equal(journal.data.accountId, 'sender-1'); assert.equal(journal.data.entries.length, 0);
});

test('a bound canonical falling back to a readonly alias cannot overwrite the observed sender or acquire work', async t => {
  const journal = await journalFor(t); await journal.bindAccount('sender-1'); let polled;
  const result = await runOnce(config, { journal, adapter: { accountStatus: options => {
    assert.equal(options.expectedAccountId, 'sender-1'); assert.equal(options.passive, true);
    return { authenticated: true, accountId: `dy-readonly-${'a'.repeat(24)}` };
  } }, fetchImpl: async (url, options) => {
    assert.ok(url.endsWith('/poll')); polled = JSON.parse(options.body); return response({ job: null });
  } });
  assert.equal(polled.authenticated, false); assert.equal(polled.accountId, undefined);
  assert.deepEqual(result, { worked: false, authenticated: false, verificationPending: true });
  assert.equal(journal.data.accountId, 'sender-1'); assert.equal(journal.data.entries.length, 0);
});

test('explicit account change and challenges never become temporary identity-verification hints', async t => {
  const journal = await journalFor(t); await journal.bindAccount('sender-1'); let polls = 0;
  const changed = await runOnce(config, { journal, adapter: { accountStatus: () => ({ authenticated: true, accountId: 'sender-2', verificationPending: true }) }, fetchImpl: async (_url, options) => {
    polls++; assert.equal(JSON.parse(options.body).authenticated, false); return response({ job: null });
  } });
  assert.equal(changed.authenticated, false); assert.equal(changed.verificationPending, undefined);
  const challenge = await runOnce(config, { journal, adapter: { accountStatus: () => { throw new BridgeError('安全验证', 'HUMAN_ACTION_REQUIRED'); } }, fetchImpl: async () => { polls++; return response({ job: null }); } });
  assert.deepEqual(challenge, { worked: false, humanActionRequired: true }); assert.equal(polls, 1);
});

test('a bounded recovery request uses the dedicated adapter operation and subsequent polls remain passive', async t => {
  const journal = await journalFor(t); await journal.bindAccount('sender-1');
  const calls = [], bodies = [];
  const adapter = {
    async recoverAccountStatus(options) { calls.push(['recover', options]); return account(); },
    async accountStatus(options) { calls.push(['passive', options]); return account(); },
  };
  const fetchImpl = async (_url, options) => { bodies.push(JSON.parse(options.body)); return response({ job: null }); };
  assert.equal((await runOnce(config, { journal, adapter, fetchImpl, recoverAccount: true })).authenticated, true);
  await runOnce(config, { journal, adapter, fetchImpl });
  assert.deepEqual(calls.map(([kind]) => kind), ['recover', 'passive']);
  assert.equal(calls[0][1].expectedAccountId, 'sender-1'); assert.equal(calls[0][1].allowReadOnly, true);
  assert.equal(calls[1][1].passive, true); assert.equal(bodies.every(body => body.authenticated), true);
  assert.equal(journal.data.entries.length, 0);
});

test('a recovery request never substitutes active navigation on an adapter without a recovery operation', async t => {
  const journal = await journalFor(t); await journal.bindAccount('sender-1');
  const result = await runOnce(config, { journal, recoverAccount: true, adapter: { accountStatus: options => {
    assert.equal(options.passive, true); return { authenticated: false, verificationPending: true, needsAccountVerification: true, verificationReason: 'owner_proof_missing' };
  } }, fetchImpl: async () => response({ job: null }) });
  assert.deepEqual(result, { worked: false, authenticated: false, verificationPending: true, needsAccountVerification: true, verificationReason: 'owner_proof_missing' });
});

test('pending verification exposes only an allowlisted reason and never forwards the recovery hint to the server', async t => {
  const journal = await journalFor(t); await journal.bindAccount('sender-1'); let polled;
  const result = await runOnce(config, { journal, adapter: { accountStatus: () => ({ authenticated: false, verificationPending: true, needsAccountVerification: true, verificationReason: 'raw private failure text' }) }, fetchImpl: async (_url, options) => { polled = JSON.parse(options.body); return response({ job: null }); } });
  assert.equal(result.needsAccountVerification, true); assert.equal(result.verificationReason, undefined);
  assert.equal(polled.needsAccountVerification, undefined); assert.equal(polled.verificationReason, undefined);
  assert.ok(!JSON.stringify(result).includes('private failure'));
});

test('pending verification retains fixed owner proof stages locally without posting them to the service',async t=>{
 const reasons=['owner_route_changed','owner_controls_timeout','owner_controls_replaced','owner_handle_missing','owner_duplicate_same_handle','owner_handle_conflict','owner_read_interrupted'];
 for(const reason of reasons){
  const journal=await journalFor(t);await journal.bindAccount('sender-1');let polled;
  const result=await runOnce(config,{journal,adapter:{accountStatus:()=>({authenticated:false,verificationPending:true,needsAccountVerification:true,verificationReason:reason})},fetchImpl:async(_url,options)=>{polled=JSON.parse(options.body);return response({job:null});}});
  assert.equal(result.verificationReason,reason);
  assert.equal(polled.verificationReason,undefined);
 }
});

test('a definite account change from bounded recovery stops instead of becoming temporary pending', async t => {
  const journal = await journalFor(t); await journal.bindAccount('sender-1'); let polls = 0;
  await assert.rejects(runOnce(config, { journal, recoverAccount: true, adapter: {
    accountStatus: account,
    recoverAccountStatus: () => { throw new BridgeError('账号发生变化', 'ACCOUNT_CHANGED'); },
  }, fetchImpl: async () => { polls++; return response({ job: null }); } }), error => error.code === 'ACCOUNT_CHANGED');
  assert.equal(polls, 0);
});

test('device status heartbeat sends liveness without an identity claim or a job lease', async () => {
  const requests = [];
  assert.equal(typeof bridgeCore.deviceStatusHeartbeat, 'function');
  await bridgeCore.deviceStatusHeartbeat(config, { fetchImpl: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return response({ ok: true }); } });
  assert.deepEqual(requests, [{ url: `${config.origin}/api/prospecting-bridge/status`, body: { deviceId: config.deviceId } }]);
});

const browserTest = process.env.PROSPECT_BROWSER_TEST === '1' ? test : test.skip;
async function fixture(t, { echo = true, wrongTarget = false, challenge = false, searchResults, selfProfile, videoDetails, stackChat = false, slateDraft = false, history = '', chatReplyEcho = '', chatReplyStatus = '', ignoreFirstChatOpen = false } = {}) {
  const { chromium } = await import('../tools/douyin-bridge/node_modules/playwright/index.mjs');
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const context = await browser.newContext(); let clicks = 0;
  await context.exposeBinding('countSend', () => { clicks++; });
  const header = '<header><a aria-label="我的主页" href="' + (selfProfile ? '/user/self' : '/user/sender-1') + '">我</a></header>';
  const stackEcho = "const row=document.createElement('div');row.className='messageMessageBoxmessageBox';const text=document.createElement('span');text.textContent=document.querySelector('[contenteditable]').innerText.replace(/\\u200B$/, '');const list=document.querySelector('.messageMessageListlist');" +
    (chatReplyEcho ? "row.dataset.messageDirection='" + chatReplyEcho + "';row.dataset.messageStatus='" + chatReplyStatus + "';row.dataset.messageId='new-echo';text.dataset.e2e='message-text';row.append(text);for(const previous of list.querySelectorAll('[data-index]'))previous.dataset.index=Number(previous.dataset.index)+1;const slot=document.createElement('div');slot.dataset.index='0';slot.append(row);list.prepend(slot);" : "row.append('10:00 ',text);list.append(row);");
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'www.douyin.com') return route.abort();
    const body = challenge ? '<div role="dialog">请完成安全验证</div>' : url.pathname === '/user/self' && selfProfile ? selfProfile : url.pathname.startsWith('/search/')
      ? searchResults?.(decodeURIComponent(url.pathname.slice('/search/'.length))) ?? '<main><article><a href="/video/123">智能客服如何提效</a><a href="/user/competitor-1">真实竞品</a></article><article><a href="/video/124">客服自动化</a><a href="/user/competitor-1">真实竞品</a></article></main>'
      : url.pathname.startsWith('/video/')
        ? videoDetails?.(url.pathname.slice('/video/'.length)) ?? '<main><div data-e2e="comment-list">' + Array.from({ length: 55 }, (_, i) => `<div data-e2e="comment-item" data-comment-id="${i + 100}"><a href="/user/reader-${i}">用户${i}</a><span data-e2e="comment-content">多少钱 ${i}</span><time datetime="2026-11-05">今天</time></div>`).join('') + '</div></main>'
        : stackChat ? `<main>
          <button onclick="${ignoreFirstChatOpen ? 'if(!window.chatOpenTried){window.chatOpenTried=true;return;}' : ''}document.querySelector('[data-e2e=im-dialog]').hidden=false">私信</button>
          <div data-e2e="im-dialog" hidden>
            <div data-stack-layer="chat">
              <header><div class="StackLayoutStackChatHeaderuser">
                <div data-apm-action="个人页卡片" onclick="window.open('/user/${wrongTarget ? 'someone-else' : 'recipient-1'}')">头像</div>
                <span>同名用户</span>
              </div></header>
              <div class="messageMessageListwrapper"><div class="messageMessageListlist">${history}</div></div>
              <div data-e2e="msg-input">
                <div contenteditable="true" data-placeholder="发送消息" ${slateDraft ? 'data-slate-editor="true" oninput="this.append(String.fromCodePoint(8203))"' : ''}></div>
                <svg class="e2e-send-msg-btn" width="40" height="40" onclick="countSend(); ${echo ? stackEcho : ''}"><rect width="40" height="40"></rect></svg>
              </div>
            </div>
          </div>
        </main>` : '<main><h1>目标用户</h1><button onclick="document.querySelector(\'[role=dialog]\').hidden=false">私信</button><section role="dialog" hidden><header><a href="/user/' + (wrongTarget ? 'someone-else' : 'recipient-1') + '">目标用户</a></header><div data-e2e="message-list"></div><textarea placeholder="发送消息"></textarea><button onclick="window.countSend();' + (echo ? 'const m=document.createElement(\'p\');m.dataset.e2e=\'message-item\';m.textContent=document.querySelector(\'textarea\').value;document.querySelector(\'[data-e2e=message-list]\').append(m);' : '') + '">发送</button></section></main>';
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><meta charset="utf-8"></head><body>${header}${body}</body></html>` });
  });
  const adapter = new DouyinBrowserAdapter(context, { timeoutMs: 800, confirmationMs: 500, scrollDelayMs: 10 });
  return { adapter, clicks: () => clicks };
}

browserTest('signed-in self page without a canonical profile link can run discovery but cannot send', async t => {
  const { adapter, clicks } = await fixture(t, { selfProfile: '<main><h1>本人账号</h1><span>抖音号：tenant_123</span><button role="tab">私密作品</button><input placeholder="搜索你发布的作品"></main>' });
  const account = await adapter.accountStatus();
  assert.equal(account.authenticated, true);
  assert.match(account.accountId, /^dy-readonly-[a-f0-9]{24}$/);
  assert.equal((await adapter.discover({ keywords: ['海盐商铺出租'] })).candidates.length, 1);
  assert.equal((await adapter.accountStatus()).accountId, account.accountId);
  await assert.rejects(adapter.send({ ...sendJob().input, senderAccountId: account.accountId }), error => error.code === 'SENDER_UNVERIFIED');
  assert.equal(clicks(), 0);
});

browserTest('a profile label alone or hidden owner controls never prove a signed-in account', async t => {
  const { adapter } = await fixture(t, { selfProfile: '<main><h1>页面文字</h1><span>抖音号：tenant_123</span><button role="tab" hidden>私密作品</button><input placeholder="搜索你发布的作品" hidden></main>' });
  assert.equal((await adapter.accountStatus()).authenticated, false);
});

browserTest('browser discovers real account/video links and caps actual visible comments at 50', async t => {
  const { adapter } = await fixture(t);
  assert.equal((await adapter.accountStatus()).accountId, 'sender-1');
  const result = await adapter.discover({ keywords: ['客服'] });
  assert.equal(result.candidates[0].id, 'competitor-1'); assert.equal(result.candidates[0].videos.length, 2);
  const collected = await adapter.collect({ videos: result.candidates[0].videos.slice(0, 1), maxCommentsPerVideo: 50 });
  assert.equal(collected.comments.length, 50); assert.equal(collected.comments[0].profileUrl, 'https://www.douyin.com/user/reader-0');
});

browserTest('collection reads ordinary body text and emoji between verified author and time without UI labels', async t => {
  const { adapter } = await fixture(t, { videoDetails: () => '<main><h2>全部评论</h2><div data-e2e="comment-list">' +
    '<div data-e2e="comment-item" data-comment-id="ordinary-1"><a href="/user/reader-one"><img alt="问租者头像" width="20" height="20"></a><div><span>问租者</span><div><span>这个商铺多少钱一个月？</span><img alt="[玫瑰]" width="20" height="20"><span>想了解</span></div><div><span>6月前·浙江</span><button>点赞</button><button>分享</button><button>回复</button></div></div></div>' +
    '<div data-e2e="comment-item" data-comment-id="ordinary-2"><a href="/user/reader-two"><img alt="头像" width="20" height="20"></a><div><span>另一位租客</span><div>可以做餐饮吗？</div><div><span>昨天·上海</span><button>回复</button></div></div></div>' +
    '<div data-e2e="comment-item" data-comment-id="ordinary-3"><a href="/user/reader-three"><img alt="第三位头像" width="20" height="20"></a><div>第三位<div>想约看铺</div><span>昨天</span><button>回复</button></div></div>' +
    '<p>暂时没有更多评论</p></div></main>' });
  const result = await adapter.collect({ videos: [{ id: '10001', url: 'https://www.douyin.com/video/10001' }] });
  assert.deepEqual(result.comments.map(comment => [comment.id, comment.nickname, comment.text, comment.postedAt, comment.recipientId]), [
    ['ordinary-1', '问租者', '这个商铺多少钱一个月？[玫瑰]想了解', '6月前·浙江', 'reader-one'],
    ['ordinary-2', '另一位租客', '可以做餐饮吗？', '昨天·上海', 'reader-two'],
    ['ordinary-3', '第三位', '想约看铺', '昨天', 'reader-three'],
  ]);
});

browserTest('fallback comment identity stays stable when relative date text rolls over', async t => {
  let day = '3天前';
  const { adapter } = await fixture(t, { videoDetails: () => `<main><div data-e2e="comment-list"><div data-e2e="comment-item"><a href="/user/stable-reader">稳定读者</a><span data-e2e="comment-content">这条评论跨天保持相同</span><time>${day}</time></div></div></main>` });
  const first = await adapter.collect({ videos: [{ id: '10001', url: 'https://www.douyin.com/video/10001' }] });
  day = '4天前';
  const second = await adapter.collect({ videos: [{ id: '10001', url: 'https://www.douyin.com/video/10001' }] });
  assert.equal(first.comments[0].id, second.comments[0].id);
});

browserTest('collection reads the observed info-body-time structure without treating comment subparts as rows', async t => {
  const { adapter } = await fixture(t, { videoDetails: () => '<main><h2>全部评论</h2><div data-e2e="comment-list">' +
    '<div data-e2e="comment-item" data-comment-id="observed-parent"><div class="comment-item-avatar"><a href="/user/parent-reader"><img alt="问租甲头像" width="20" height="20"></a></div><div><div>' +
    '<div class="comment-item-info-wrap"><a href="/user/parent-reader">问租甲</a><div data-e2e="video-comment-more">更多</div></div>' +
    '<div><span><span>这铺面可以做餐饮吗？</span><img alt="[玫瑰]" width="20" height="20"></span></div>' +
    '<div><span>6月前·浙江</span></div><div class="comment-item-stats-container"><button>点赞</button><button>分享</button><button>回复</button></div>' +
    '</div><div data-e2e="comment-item" data-comment-id="observed-reply"><div class="comment-item-avatar"><a href="/user/reply-reader"><img alt="回复乙头像" width="20" height="20"></a></div><div><div>' +
    '<div class="comment-item-info-wrap"><a href="/user/reply-reader">回复乙</a><div data-e2e="video-comment-more">更多</div></div>' +
    '<div><span>可以安排看房</span></div><div><span>昨天·浙江</span></div><div class="comment-item-stats-container"><button>回复</button></div>' +
    '</div></div></div></div></div><p>暂时没有更多评论</p></div></main>' });
  const result = await adapter.collect({ videos: [{ id: '10001', url: 'https://www.douyin.com/video/10001' }] });
  assert.deepEqual(result.comments.map(comment => [comment.id, comment.nickname, comment.text, comment.recipientId]), [
    ['observed-parent', '问租甲', '这铺面可以做餐饮吗？[玫瑰]', 'parent-reader'],
    ['observed-reply', '回复乙', '可以安排看房', 'reply-reader'],
  ]);
});

browserTest('collection uses matching info and avatar identity rather than user links mentioned in the body', async t => {
  const { adapter } = await fixture(t, { videoDetails: () => '<div class="comment-item" data-comment-id="scoped-author"><div class="comment-item-avatar"><a href="/user/actual-reader"><img alt="问租者头像" width="20" height="20"></a></div><div><div class="comment-item-info-wrap"><a href="/user/actual-reader">问租者</a><div data-e2e="video-comment-more">更多</div></div><div><span>请问</span><a href="/user/mentioned-user">@朋友</a><span>租金多少？</span></div><div><span>6月前·浙江</span></div><div class="comment-item-stats-container"><button>回复</button></div></div></div>' });
  const result = await adapter.collect({ videos: [{ id: '10001', url: 'https://www.douyin.com/video/10001' }] });
  assert.equal(result.comments.length, 1);
  assert.equal(result.comments[0].text, '请问@朋友租金多少？');
  assert.equal(result.comments[0].recipientId, 'actual-reader');
});

browserTest('collection never assigns a nested reply body to its parent author', async t => {
  const { adapter } = await fixture(t, { videoDetails: () => '<div data-e2e="comment-list"><div data-e2e="comment-item" data-comment-id="parent-empty"><a href="/user/parent-author">父评论作者</a><time>昨天</time><button>回复</button><div data-e2e="comment-level-2" data-comment-id="reply-one"><a href="/user/reply-author">回复者</a><span data-e2e="comment-content">可以安排看铺吗？</span><time>今天</time><button>回复</button></div></div></div>' });
  const result = await adapter.collect({ videos: [{ id: '10001', url: 'https://www.douyin.com/video/10001' }] });
  assert.deepEqual(result.comments.map(comment => [comment.id, comment.text, comment.recipientId]), [['reply-one', '可以安排看铺吗？', 'reply-author']]);
});

browserTest('collection waits for the rendered body instead of declaring zero while rows are still loading', async t => {
  const { adapter } = await fixture(t, { videoDetails: () => '<div data-e2e="comment-item" data-comment-id="delayed-one"><a href="/user/reader-one">问租者</a><p id="late-body"></p><span>6月前·浙江</span><button>回复</button></div><script>setTimeout(()=>document.getElementById("late-body").textContent="还有空铺吗？",250)</script>' });
  const result = await adapter.collect({ videos: [{ id: '10001', url: 'https://www.douyin.com/video/10001' }] });
  assert.equal(result.comments[0]?.text, '还有空铺吗？');
});

browserTest('collection reports unreadable visible rows while preserving a genuine empty comment section', async t => {
  const unreadable = await fixture(t, { videoDetails: () => '<main><h2>全部评论</h2><div data-e2e="comment-item"><a href="/user/reader-one">问租者</a><button>回复</button></div></main>' });
  await assert.rejects(unreadable.adapter.collect({ videos: [{ id: '10001', url: 'https://www.douyin.com/video/10001' }] }), error => error.code === 'COMMENTS_UNREADABLE');
  const empty = await fixture(t, { videoDetails: () => '<main><h2>全部评论</h2><p>暂无评论</p></main>' });
  assert.deepEqual(await empty.adapter.collect({ videos: [{ id: '10001', url: 'https://www.douyin.com/video/10001' }] }), { comments: [] });
});

browserTest('collection preserves readable videos when another selected video has no readable comment region', async t => {
  const { adapter } = await fixture(t, { videoDetails: id => id === '10002' ? '<main>视频存在，但评论区域尚不可读</main>' : `<div data-e2e="comment-item" data-comment-id="read-${id}"><a href="/user/reader-one">问租者</a><span data-e2e="comment-content">想看看${id}的铺面</span><time>今天</time></div>` });
  const result = await adapter.collect({ videos: ['10001', '10002', '10003'].map(id => ({ id, url: `https://www.douyin.com/video/${id}` })) });
  assert.deepEqual(result.comments.map(comment => comment.videoId), ['10001', '10003']);
  assert.ok(result.warnings.some(warning => warning.includes('10002')));
});

browserTest('collection still propagates a verification challenge after reading an earlier video', async t => {
  const { adapter } = await fixture(t, { videoDetails: id => id === '10002' ? '<div role="dialog">请完成安全验证</div>' : '<div data-e2e="comment-item"><a href="/user/reader-one">问租者</a><span data-e2e="comment-content">有空铺吗？</span><time>今天</time></div>' });
  await assert.rejects(adapter.collect({ videos: ['10001', '10002'].map(id => ({ id, url: `https://www.douyin.com/video/${id}` })) }), error => error.code === 'HUMAN_ACTION_REQUIRED');
  assert.equal((await adapter.page()).url(), 'https://www.douyin.com/video/10002');
});

browserTest('discovery reserves results for every keyword when the first search has twenty authors', async t => {
  const keywords = ['海盐商铺出租', '海盐租商铺', '海盐商铺租赁'];
  const { adapter } = await fixture(t, { searchResults: keyword => {
    const group = keywords.indexOf(keyword);
    return '<main>' + Array.from({ length: 20 }, (_, i) => `<article><a href="/video/${10000 + group * 100 + i}">${keyword}真实视频</a><a href="/user/author-${group}-${i}">${keyword}作者${i}</a></article>`).join('') + '</main>';
  } });
  const result = await adapter.discover({ keywords });
  assert.equal(result.candidates.length, 20);
  for (let group = 0; group < 3; group++) {
    assert.ok(result.candidates.filter(candidate => candidate.id.startsWith(`author-${group}-`)).length >= 6, `keyword ${group + 1} must receive a fair share of results`);
  }
  assert.equal(new Set(result.candidates.map(candidate => candidate.id)).size, 20);
});

browserTest('discovery merges verified videos for an author found by different keywords', async t => {
  const { adapter } = await fixture(t, { searchResults: keyword => `<main><article><a href="/video/${keyword === '商铺出租' ? '10001' : '10002'}">${keyword}</a><a href="/user/shared-author">同一真实作者</a></article></main>` });
  const result = await adapter.discover({ keywords: ['商铺出租', '商铺租赁'] });
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0].videos.map(video => video.id).sort(), ['10001', '10002']);
});

browserTest('discovery resolves a search video without a profile link through its visible detail author card', async t => {
  const { adapter } = await fixture(t, {
    searchResults: () => '<main><a href="/video/10001"><span>海盐商铺出租</span><span>仅展示昵称</span></a></main>',
    videoDetails: () => '<main><section data-e2e="comment-list"><h2>全部评论</h2><a href="/user/comment-reader">评论者</a><p>作者回复</p></section>' +
      '<section><a href="/user/verified-author">海盐真实作者</a><a href="/user/verified-author">认证徽章</a><p>粉丝 1.5万 获赞 13.4万</p><button>关注</button></section>' +
      '<section><h2>推荐视频</h2><a href="/user/recommended-user">推荐作者</a><button>关注</button></section></main>',
  });
  const result = await adapter.discover({ keywords: ['海盐商铺出租'] });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].id, 'verified-author');
  assert.equal(result.candidates[0].nickname, '海盐真实作者');
  assert.deepEqual(result.candidates[0].videos.map(video => video.id), ['10001']);
});

browserTest('discovery ignores navigation and footer video links outside search results', async t => {
  const { adapter } = await fixture(t, { searchResults: () => '<main><article><a href="/video/10001">实际搜索结果</a><a href="/user/search-author">搜索作者</a></article></main>' +
    '<footer><article><a href="/video/10002">全站热门</a><a href="/user/footer-author">页脚作者</a></article></footer>' +
    '<nav><article><a href="/video/10003">导航推荐</a><a href="/user/nav-author">导航作者</a></article></nav>' });
  assert.deepEqual((await adapter.discover({ keywords: ['海盐商铺'] })).candidates.map(candidate => candidate.id), ['search-author']);
});

browserTest('discovery never borrows one unrelated profile from a container holding multiple search videos', async t => {
  const { adapter } = await fixture(t, {
    searchResults: () => '<main><a href="/user/unrelated-user">无关账号</a><div><a href="/video/10001">海盐商铺一</a></div><div><a href="/video/10002">海盐商铺二</a></div></main>',
    videoDetails: id => `<section><a href="/user/author-${id}">真实作者${id}</a><span>粉丝 100 获赞 200</span><button>关注</button></section>`,
  });
  assert.deepEqual((await adapter.discover({ keywords: ['海盐商铺'] })).candidates.map(candidate => candidate.id).sort(), ['author-10001', 'author-10002']);
});

browserTest('detail verification challenges remain open and propagate for manual completion', async t => {
  const { adapter } = await fixture(t, {
    searchResults: () => '<main><a href="/video/10001">海盐商铺</a></main>',
    videoDetails: () => '<div role="dialog">请完成安全验证</div>',
  });
  await assert.rejects(adapter.discover({ keywords: ['海盐商铺'] }), error => error.code === 'HUMAN_ACTION_REQUIRED');
  const page = await adapter.page();
  assert.equal(page.isClosed(), false);
  assert.equal(page.url(), 'https://www.douyin.com/video/10001');
});

browserTest('detail fallback gives each keyword a bounded lookup budget and deduplicates repeated video visits', async t => {
  const keywords = ['第一词', '第二词', '第三词', '第四词', '第五词'];
  const visits = new Map();
  const { adapter } = await fixture(t, {
    searchResults: keyword => '<main>' + Array.from({ length: 8 }, (_, i) => `<a href="/video/${i === 0 ? '10000' : 10000 + keywords.indexOf(keyword) * 100 + i}">${keyword}商铺${i}</a>`).join('') + '</main>',
    videoDetails: id => {
      visits.set(id, (visits.get(id) || 0) + 1);
      return `<section><a href="/user/author-${id}">真实作者${id}</a><span>粉丝 100 获赞 200</span><button>已关注</button></section>`;
    },
  });
  const result = await adapter.discover({ keywords });
  assert.ok(result.candidates.length <= 12);
  assert.ok(visits.size <= 12);
  assert.equal(visits.get('10000'), 1);
  assert.ok([...visits.values()].every(count => count === 1));
  for (let group = 0; group < 5; group++) assert.ok(result.candidates.some(candidate => candidate.videos.some(video => Number(video.id) > 10000 + group * 100 && Number(video.id) < 10100 + group * 100)), `keyword ${group + 1} must resolve a detail author`);
});

browserTest('detail fallback never promotes commenters, ambiguous author cards, or a different video', async t => {
  const cases = [
    '<section><h2>全部评论</h2><a href="/user/comment-reader">评论者</a><span>粉丝 100 获赞 200</span><button>关注</button></section>',
    '<section><a href="/user/author-one">甲</a><a href="/user/author-two">乙</a><span>粉丝 100 获赞 200</span><button>关注</button></section>',
    '<section><a href="/user/author-one">甲</a><span>粉丝 100 获赞 200</span><button>关注</button></section><section><a href="/user/author-two">乙</a><span>粉丝 100 获赞 200</span><button>互相关注</button></section>',
    '<section><a href="https://evil.example/user/author-one">外站</a><span>粉丝 100 获赞 200</span><button>关注</button></section>',
    '<section hidden><a href="/user/author-one">隐藏作者</a><span>粉丝 100 获赞 200</span><button>关注</button></section>',
    '<script>history.replaceState(null,"","/video/99999")</script><section><a href="/user/author-one">其他视频作者</a><span>粉丝 100 获赞 200</span><button>关注</button></section>',
  ];
  for (const detail of cases) {
    const { adapter } = await fixture(t, { searchResults: () => '<main><a href="/video/10001">海盐商铺</a></main>', videoDetails: () => detail });
    await assert.rejects(adapter.discover({ keywords: ['海盐商铺'] }), error => error.code === 'SEARCH_UNREADABLE');
  }
});

browserTest('discovery reports unreadable authors instead of a successful empty result when video links exist', async t => {
  const { adapter } = await fixture(t, { searchResults: () => '<main>' +
    '<article><a href="/video/10001">缺少作者</a></article>' +
    '<article><a href="/video/10002">作者不唯一</a><a href="/user/author-one">甲</a><a href="/user/author-two">乙</a></article>' +
    '<article><a href="https://evil.example/video/10003">非抖音视频</a><a href="/user/author-three">丙</a></article>' +
    '<article><a href="/video/10004">非抖音作者</a><a href="https://evil.example/user/author-four">丁</a></article>' +
    '</main>' });
  await assert.rejects(adapter.discover({ keywords: ['海盐商铺出租'] }), error => error.code === 'SEARCH_UNREADABLE');
});

browserTest('discovery preserves a genuine no-results response as an empty candidate list', async t => {
  const { adapter } = await fixture(t, { searchResults: () => '<main>暂无搜索结果</main>' });
  assert.deepEqual(await adapter.discover({ keywords: ['没有匹配的视频'] }), { candidates: [] });
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

browserTest('current Douyin chat verifies the avatar profile and uses its scoped send icon', async t => {
  const { adapter, clicks } = await fixture(t, { stackChat: true });
  let dispatches = 0;
  const result = await adapter.send(sendJob().input, { beforeDispatch: async () => { assert.equal(clicks(), 0); dispatches++; } });
  assert.equal(result.outcome, 'submitted');
  assert.equal(dispatches, 1);
  assert.equal(clicks(), 1);
});

const retryInput = () => ({ ...sendJob().input, retry: { previousJobId: 'prior-send', checkSince: '2026-11-06T03:19:37.675Z' } });
const coveredHistory = '<div data-index="0"><time datetime="2020-04-23T00:00:00Z">2020/04/23</time><div class="messageMessageBoxmessageBox messageMessageBoxisFullRowCenterMessage">对方撤回了一条消息</div></div>';
const existingMessage = direction => `<div data-index="0"><div class="messageMessageBoxmessageBox" data-message-direction="${direction}"><span>${sendJob().input.message}</span></div></div>`;
const conversationInput = () => ({ senderAccountId: 'sender-1', recipientId: 'recipient-1', profileUrl: 'https://www.douyin.com/user/recipient-1', conversationId: 'conversation-1', limit: 50 });
const incomingHistory = '<div data-index="0"><div class="messageMessageBoxmessageBox" data-message-direction="incoming" data-message-id="inbound-current"><span data-e2e="message-text">这个店面多大面积？</span></div></div>';

browserTest('conversation reading verifies the participant and returns inbound history without touching the composer', async t => {
  const { adapter, clicks } = await fixture(t, { stackChat: true, history: incomingHistory });
  const result = await adapter.readConversation(conversationInput());
  assert.equal(result.reliable, true); assert.equal(result.messages[0].direction, 'inbound');
  assert.equal(result.messages[0].text, '这个店面多大面积？');
  assert.equal(clicks(), 0); assert.equal(await (await adapter.page()).locator('[contenteditable]').innerText(), '');
});

browserTest('conversation reading retries once when the first private-message click leaves the panel closed', async t => {
  const { adapter, clicks } = await fixture(t, { stackChat: true, history: incomingHistory, ignoreFirstChatOpen: true });
  const result = await adapter.readConversation(conversationInput());
  assert.equal(result.reliable, true);
  assert.equal(result.messages[0].direction, 'inbound');
  assert.equal(clicks(), 0);
});

browserTest('an approved agent reply requires a fresh reliable incoming snapshot and dispatches once', async t => {
  const { adapter, clicks } = await fixture(t, { stackChat: true, history: incomingHistory.replace('这个店面多大面积？', '上条消息发送失败了吗？'), slateDraft: true, chatReplyEcho: 'outgoing' });
  const observed = await adapter.readConversation(conversationInput()); let dispatches = 0;
  const result = await adapter.reply({ ...conversationInput(), message: '这个店面约80平方米，方便进一步了解吗？', replyId: 'reply-one', expectedSnapshotId: observed.snapshotId, actor: 'agent' }, { beforeDispatch: async () => { dispatches++; } });
  assert.equal(result.outcome, 'submitted'); assert.equal(dispatches, 1); assert.equal(clicks(), 1);
});

browserTest('a changed conversation after lease renewal rejects an approved reply before dispatch', async t => {
  const { adapter, clicks } = await fixture(t, { stackChat: true, history: incomingHistory });
  const observed = await adapter.readConversation(conversationInput()); let dispatches = 0;
  await assert.rejects(adapter.reply({ ...conversationInput(), message: '可以进一步了解', replyId: 'reply-stale', expectedSnapshotId: observed.snapshotId, actor: 'agent' }, {
    renewBeforeDispatch: async () => { await (await adapter.page()).locator('[data-e2e="message-text"]').evaluate(node => { node.textContent = '不用了，请不要再联系'; }); },
    beforeDispatch: async () => { dispatches++; },
  }), { code: 'CONVERSATION_CHANGED' });
  assert.equal(dispatches, 0); assert.equal(clicks(), 0);
});

browserTest('ambiguous direction blocks the agent while an explicit human reply still requires the same snapshot', async t => {
  const history = incomingHistory.replace('data-message-direction="incoming"', '');
  for (const actor of ['agent', 'human']) {
    const { adapter, clicks } = await fixture(t, { stackChat: true, history, chatReplyEcho: 'outgoing' });
    const observed = await adapter.readConversation(conversationInput()); assert.equal(observed.reliable, false);
    let dispatches = 0;
    const action = () => adapter.reply({ ...conversationInput(), message: '您好，请问希望了解哪方面？', replyId: `reply-${actor}`, expectedSnapshotId: observed.snapshotId, actor }, { beforeDispatch: async () => { dispatches++; } });
    if (actor === 'agent') { await assert.rejects(action(), { code: 'CONVERSATION_UNREADABLE' }); assert.equal(dispatches, 0); assert.equal(clicks(), 0); }
    else { assert.equal((await action()).outcome, 'submitted'); assert.equal(dispatches, 1); assert.equal(clicks(), 1); }
  }
});

browserTest('a matching incoming echo or pending outgoing bubble cannot confirm a submitted chat reply', async t => {
  for (const [chatReplyEcho, chatReplyStatus] of [['incoming',''],['outgoing','pending']]) {
    const { adapter, clicks } = await fixture(t, { stackChat: true, history: incomingHistory, chatReplyEcho, chatReplyStatus });
    const observed = await adapter.readConversation(conversationInput());
    const result = await adapter.reply({ ...conversationInput(), message: '你好，我来帮你核对', replyId: 'direction-proof', expectedSnapshotId: observed.snapshotId, actor: 'agent' }, { beforeDispatch: async () => {} });
    assert.equal(result.outcome, 'unknown');
    assert.equal(clicks(), 1);
  }
});

browserTest('reviewed retry reconciles an existing outgoing message without filling or dispatching again', async t => {
  const { adapter, clicks } = await fixture(t, { stackChat: true, history: existingMessage('outgoing') });
  let dispatches = 0;
  const result = await adapter.send(retryInput(), { beforeDispatch: async () => { dispatches++; } });
  assert.equal(result.outcome, 'submitted'); assert.equal(result.alreadySubmitted, true);
  assert.equal(dispatches, 0); assert.equal(clicks(), 0);
  assert.equal(await (await adapter.page()).locator('[contenteditable]').innerText(), '');
});

browserTest('reviewed retry blocks duplicate or unreadable history without another dispatch', async t => {
  for (const history of [existingMessage('incoming'), '']) {
    const { adapter, clicks } = await fixture(t, { stackChat: true, history });
    let dispatches = 0;
    const result = await adapter.send(retryInput(), { beforeDispatch: async () => { dispatches++; } });
    assert.equal(result.outcome, 'unknown'); assert.ok(result.error);
    assert.equal(dispatches, 0); assert.equal(clicks(), 0);
  }
});

browserTest('reviewed retry sends once only when loaded same-chat history covers the prior uncertain attempt', async t => {
  const { adapter, clicks } = await fixture(t, { stackChat: true, slateDraft: true, history: coveredHistory });
  let dispatches = 0;
  const result = await adapter.send(retryInput(), { beforeDispatch: async () => { dispatches++; } });
  assert.equal(result.outcome, 'submitted'); assert.notEqual(result.alreadySubmitted, true);
  assert.equal(dispatches, 1); assert.equal(clicks(), 1);
});

browserTest('reviewed retry checks for an outgoing echo again after lease renewal', async t => {
  const { adapter, clicks } = await fixture(t, { stackChat: true, history: coveredHistory });
  let dispatches = 0;
  const result = await adapter.send(retryInput(), {
    renewBeforeDispatch: async () => { await (await adapter.page()).locator('.messageMessageListlist').evaluate((node, html) => { node.innerHTML = html; }, existingMessage('outgoing')); },
    beforeDispatch: async () => { dispatches++; },
  });
  assert.equal(result.outcome, 'submitted'); assert.equal(result.alreadySubmitted, true);
  assert.equal(dispatches, 0); assert.equal(clicks(), 0);
});

browserTest('Douyin Slate caret marker after the exact draft permits one private message', async t => {
  const { adapter, clicks } = await fixture(t, { stackChat: true, slateDraft: true });
  const result = await adapter.send(sendJob().input, { beforeDispatch: async () => assert.equal(clicks(), 0) });
  assert.equal(result.outcome, 'submitted');
  assert.equal(clicks(), 1);
});

browserTest('a same-name chat whose avatar opens another profile cannot dispatch', async t => {
  const { adapter, clicks } = await fixture(t, { stackChat: true, wrongTarget: true });
  let dispatches = 0;
  await assert.rejects(adapter.send(sendJob().input, { beforeDispatch: async () => { dispatches++; } }), { code: 'RECIPIENT_UNVERIFIED' });
  assert.equal(dispatches, 0);
  assert.equal(clicks(), 0);
});

browserTest('account change during final lease renewal cannot trigger a send', async t => {
  const { adapter, clicks } = await fixture(t); let dispatches = 0;
  await assert.rejects(adapter.send(sendJob().input, {
    renewBeforeDispatch: async () => {
      const page = await adapter.page();
      await page.locator('a[aria-label="我的主页"]').evaluate(link => link.href = '/user/sender-2');
    },
    beforeDispatch: async () => { dispatches++; },
  }), { code: 'ACCOUNT_CHANGED' });
  assert.equal(clicks(), 0);
  assert.equal(dispatches, 0);
});

browserTest('visible text added to a Slate draft stops before the dispatch checkpoint', async t => {
  const { adapter, clicks } = await fixture(t, { stackChat: true, slateDraft: true }); let dispatches = 0;
  await assert.rejects(adapter.send(sendJob().input, {
    renewBeforeDispatch: async () => {
      const page = await adapter.page();
      await page.locator('[data-slate-editor]').evaluate(editor => editor.append('另外一段文案'));
    },
    beforeDispatch: async () => { dispatches++; },
  }), { code: 'MESSAGE_CHANGED' });
  assert.equal(clicks(), 0);
  assert.equal(dispatches, 0);
});

browserTest('browser stops at verification instead of attempting to bypass it', async t => {
  const { adapter } = await fixture(t, { challenge: true });
  await assert.rejects(adapter.discover({ keywords: ['客服'] }), /验证/);
});
