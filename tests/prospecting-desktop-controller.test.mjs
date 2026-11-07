import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopController, createDesktopController } from '../tools/douyin-bridge/desktop-controller.mjs';
import { BridgeError, Journal, runOnce } from '../tools/douyin-bridge/bridge-core.mjs';

const config = { origin: 'https://workbench.example', deviceId: 'pd-desktop-test', deviceToken: 'device-private-token', sitesToken: 'sites-private-token' };
const account = { authenticated: true, accountId: 'sender-1', accountName: '测试账号' };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() >= deadline) assert.fail('condition did not become true'); await new Promise(resolve => setTimeout(resolve, 2)); }
}
function fakeController(overrides = {}) {
  const calls = { opens: 0, browserCloses: 0, journalCloses: 0, runs: 0, navigations: 0, bindings: [] };
  const data = { entries: [] };
  const adapter = { async navigate() { calls.navigations++; }, async accountStatus() { return account; } };
  const browser = { adapter, async close() { calls.browserCloses++; } };
  const dependencies = {
    loadConfig: async () => config,
    openJournal: async () => ({ data, async bindConfig() {}, async bindAccount(id) { data.accountId = id; calls.bindings.push(id); }, async close() { calls.journalCloses++; } }),
    openBrowser: async () => { calls.opens++; return browser; },
    runOnce: async () => { calls.runs++; return { worked: false, authenticated: true }; },
    sleep: async (_ms, { signal }) => { if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); },
    ...overrides,
  };
  const controller = createDesktopController({ configPath: '/tmp/desktop-controller-test/config.json', dependencies });
  return { controller, calls, data, adapter, browser, dependencies };
}

test('constructing, opening login and confirming login never pull a task', async t => {
  const { controller, calls } = fakeController(); t.after(() => controller.stop());
  assert.ok(controller instanceof DesktopController); assert.equal(controller.status().phase, 'idle'); assert.equal(calls.opens, 0);
  assert.equal((await controller.startLogin()).phase, 'logging_in'); assert.equal(calls.navigations, 1); assert.equal(calls.runs, 0);
  const ready = await controller.confirmLogin();
  assert.equal(ready.phase, 'ready'); assert.equal(ready.authenticated, true); assert.equal(ready.accountId, 'sender-1');
  assert.deepEqual(calls.bindings, ['sender-1']); assert.equal(calls.runs, 0);
  const statusText = JSON.stringify(controller.status());
  assert.ok(!statusText.includes(config.deviceToken)); assert.ok(!statusText.includes(config.sitesToken));
});

test('first start requires login confirmation, even when the browser already has an account', async t => {
  const { controller, calls } = fakeController(); t.after(() => controller.stop());
  const state = await controller.start();
  assert.equal(state.phase, 'logging_in'); assert.equal(state.running, false); assert.equal(calls.runs, 0);
  await controller.confirmLogin(); await controller.start(); await until(() => calls.runs === 1);
  assert.equal(controller.status().running, true);
});

test('one-click connection verifies the saved account once and starts syncing without rebinding', async t => {
  const { controller, calls, data, adapter } = fakeController(); data.accountId = account.accountId; t.after(() => controller.stop());
  const checks = []; adapter.accountStatus = async options => { checks.push(options); return account; };
  await controller.connect(); await until(() => calls.runs === 1);
  assert.equal(controller.status().running, true); assert.equal(controller.status().authenticated, true); assert.deepEqual(calls.bindings, []);
  assert.equal(checks.length, 1); assert.equal(checks[0].expectedAccountId, account.accountId);
  await controller.connect(); assert.equal(checks.length, 1); assert.equal(calls.runs, 1);
});

test('first connection requires one explicit account confirmation before polling', async t => {
  const { controller, calls, data } = fakeController(); t.after(() => controller.stop());
  const pending = await controller.connect();
  assert.equal(pending.phase, 'confirmation_required'); assert.equal(pending.accountId, account.accountId); assert.equal(pending.authenticated, false);
  assert.equal(calls.runs, 0); assert.equal(data.accountId, undefined); assert.deepEqual(calls.bindings, []);
  await controller.confirmConnection(); await until(() => calls.runs === 1);
  assert.equal(controller.status().running, true); assert.equal(data.accountId, account.accountId); assert.deepEqual(calls.bindings, [account.accountId]);
});

test('confirmation cannot silently bind a different account from the one displayed', async t => {
  const { controller, calls, data, adapter } = fakeController(); t.after(() => controller.stop());
  await controller.connect(); assert.equal(controller.status().accountId, account.accountId); assert.equal(data.accountId, undefined);
  adapter.accountStatus = async () => ({ ...account, accountId: 'another-account', accountName: '另一个账号' });
  await controller.confirmConnection();
  assert.equal(controller.status().phase, 'confirmation_required'); assert.equal(controller.status().accountId, 'another-account');
  assert.equal(data.accountId, undefined); assert.deepEqual(calls.bindings, []); assert.equal(calls.runs, 0);
  await controller.confirmConnection(); await until(() => calls.runs === 1); assert.equal(data.accountId, 'another-account');
});

test('one-click connection cannot replace a previously paired canonical account', async t => {
  const { controller, calls, data } = fakeController(); data.accountId = 'previous-account'; t.after(() => controller.stop());
  await controller.connect(); assert.equal(controller.status().phase, 'account_mismatch');
  await controller.confirmConnection(); assert.equal(data.accountId, 'previous-account'); assert.deepEqual(calls.bindings, []); assert.equal(calls.runs, 0);
  assert.match(controller.status().message, /切回|重新配对/);
});

test('a temporary read-only fallback waits for the saved canonical identity and reconnects automatically', async t => {
  let checks = 0, pauses = 0;
  const state = fakeController({ sleep: async (_ms, { signal }) => {
    if (!state.calls.runs) { pauses++; return; }
    if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  } });
  const { controller, calls, data, adapter } = state; data.accountId = account.accountId; t.after(() => controller.stop());
  adapter.accountStatus = async () => ++checks === 1 ? { authenticated: true, accountId: 'dy-readonly-0123456789abcdef01234567' } : account;
  await controller.connect(); await until(() => calls.runs === 1);
  assert.equal(pauses, 1); assert.equal(checks, 2); assert.equal(controller.status().authenticated, true);
  assert.equal(data.accountId, account.accountId); assert.deepEqual(calls.bindings, []);
});

test('connect waits passively after the first strict check and verifies newly logged-in owner controls only once', async t => {
  const checks = [];
  const state = fakeController({ sleep: async (_ms, { signal }) => {
    if (state.calls.runs && !signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  } });
  const { controller, calls, data, adapter } = state; data.accountId = account.accountId; t.after(() => controller.stop());
  adapter.accountStatus = async options => {
    checks.push(options);
    if (checks.length <= 2) return { authenticated: false, verificationPending: true };
    if (checks.length === 3) return { authenticated: false, verificationPending: true, needsAccountVerification: true };
    return account;
  };
  await controller.connect(); await until(() => calls.runs === 1);
  assert.deepEqual(checks.map(options => options.passive), [false, true, true, false]);
  assert.ok(checks.every(options => options.expectedAccountId === account.accountId));
  assert.equal(controller.status().authenticated, true); assert.equal(calls.opens, 1); assert.deepEqual(calls.bindings, []);
});

test('an unresolved login-owner hint never repeats strict verification during one connection attempt', async t => {
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  const checks = [];
  const { controller, calls, data, adapter } = fakeController({ sleep: async () => { clock += 16000; } });
  data.accountId = account.accountId; t.after(() => controller.stop());
  adapter.accountStatus = async options => { checks.push(options); return { authenticated: false, verificationPending: true, needsAccountVerification: true }; };
  await controller.connect();
  assert.equal(checks.filter(options => options.passive === false).length, 2);
  assert.deepEqual(checks.map(options => options.passive), [false, true, false, true, true]);
  assert.equal(controller.status().running, false); assert.equal(controller.status().browserOpen, true); assert.equal(calls.runs, 0);
  assert.equal(calls.opens, 1); assert.equal(calls.browserCloses, 0); assert.equal(calls.journalCloses, 0);
});

test('waiting for a login can be cancelled without polling or leaving the browser open', async t => {
  const { controller, calls, data, adapter } = fakeController(); data.accountId = account.accountId; t.after(() => controller.stop());
  adapter.accountStatus = async () => ({ authenticated: false, verificationPending: true });
  const connecting = controller.connect(); await until(() => controller.status().phase === 'logging_in');
  assert.equal(controller.status().busy, true); assert.equal(controller.status().browserOpen, true); assert.equal(calls.runs, 0);
  await controller.stop(); await connecting;
  assert.equal(controller.status().phase, 'stopped'); assert.equal(controller.status().running, false); assert.equal(calls.runs, 0);
  assert.equal(calls.browserCloses, 1); assert.equal(calls.journalCloses, 1);
});

test('login detection has a bounded wait and leaves the page available for a later retry', async t => {
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  const { controller, calls, data, adapter } = fakeController({ sleep: async () => { clock += 61000; } });
  data.accountId = account.accountId; t.after(() => controller.stop()); adapter.accountStatus = async () => ({ authenticated: false });
  await controller.connect();
  const state = controller.status(); assert.equal(state.phase, 'logging_in'); assert.equal(state.busy, false); assert.equal(state.running, false);
  assert.equal(state.browserOpen, true); assert.equal(calls.runs, 0); assert.deepEqual(calls.bindings, []);
});

const readOnlyAlias = 'dy-readonly-0123456789abcdef01234567';
test('one-click verified self upgrade starts without replacing the journal before server acknowledgement', async t => {
  const { controller, calls, adapter, data } = fakeController(); t.after(() => controller.stop()); data.accountId = readOnlyAlias;
  adapter.accountStatus = async () => ({ ...account, verifiedReadOnlyAccountId: readOnlyAlias });
  await controller.connect(); await until(() => calls.runs === 1);
  assert.equal(controller.status().running, true); assert.equal(data.accountId, readOnlyAlias); assert.deepEqual(calls.bindings, []);
});

test('verified self upgrade reuses the confirmed session without prematurely replacing its journal alias', async t => {
  const { controller, calls, adapter, data } = fakeController(); t.after(() => controller.stop());
  data.accountId = readOnlyAlias;
  adapter.accountStatus = async () => ({ ...account, verifiedReadOnlyAccountId: readOnlyAlias });
  await controller.confirmLogin();
  assert.equal(data.accountId, readOnlyAlias); assert.equal(calls.runs, 0);
  await controller.start(); await until(() => calls.runs === 1);
  assert.equal(controller.status().running, true); assert.equal(calls.opens, 1);
});

test('runner upgrades an alias only after server acknowledgement and preserves history across retries', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'identity-upgrade-')); const journal = await Journal.open(join(directory, 'journal.json'));
  t.after(async () => { await journal.close(); await rm(directory, { recursive: true, force: true }); });
  await journal.bindAccount(readOnlyAlias);
  journal.data.entries.push({ id: 'past-discovery', kind: 'discover', reported: true, result: { candidates: [] } }); await journal.save();
  const originalEntries = structuredClone(journal.data.entries); let mode = 'network'; const bodies = [];
  const adapter = { accountStatus: async () => ({ ...account, verifiedReadOnlyAccountId: readOnlyAlias }) };
  const invoke = () => runOnce(config, { adapter, journal, fetchImpl: async (url, init) => {
    assert.ok(url.endsWith('/poll')); bodies.push(JSON.parse(init.body));
    if (mode === 'network') throw Error('synthetic network outage');
    return new Response(JSON.stringify({ job: null, ...(mode === 'accepted' ? { verifiedAccountId: account.accountId } : {}) }));
  } });
  await assert.rejects(invoke(), error => error.code === 'NETWORK'); assert.equal(journal.data.accountId, readOnlyAlias);
  mode = 'unconfirmed'; await assert.rejects(invoke(), error => error.code === 'ACCOUNT_CHANGED'); assert.equal(journal.data.accountId, readOnlyAlias);
  mode = 'accepted'; const result = await invoke(); assert.equal(result.authenticated, true); assert.equal(journal.data.accountId, account.accountId);
  await invoke(); assert.deepEqual(journal.data.entries, originalEntries);
  assert.ok(bodies.every(body => body.authenticated === true && body.verifiedReadOnlyAccountId === readOnlyAlias));
});

test('a proof for another alias cannot silently switch the locally bound account', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'identity-mismatch-')); const journal = await Journal.open(join(directory, 'journal.json'));
  t.after(async () => { await journal.close(); await rm(directory, { recursive: true, force: true }); });
  await journal.bindAccount(readOnlyAlias); let polled;
  const result = await runOnce(config, { journal, adapter: { accountStatus: async () => ({ ...account, verifiedReadOnlyAccountId: 'dy-readonly-ffffffffffffffffffffffff' }) }, fetchImpl: async (_url, init) => {
    polled = JSON.parse(init.body); return new Response(JSON.stringify({ job: null }));
  } });
  assert.equal(result.authenticated, false); assert.equal(polled.authenticated, false); assert.equal(polled.verifiedReadOnlyAccountId, undefined); assert.equal(journal.data.accountId, readOnlyAlias);
});

test('double start is serial and stop waits for the in-flight run before releasing journal', async t => {
  const running = deferred(), finished = deferred(); let active = 0, maxActive = 0;
  const state = fakeController({ runOnce: async (_config, { signal }) => {
    active++; maxActive = Math.max(maxActive, active); running.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    await finished.promise; active--; return { worked: true, pendingReport: true };
  } });
  const { controller, calls, data } = state; data.accountId = account.accountId; t.after(() => controller.stop());
  await Promise.all([controller.start(), controller.start()]); await running.promise;
  const stopping = controller.stop(); await until(() => calls.browserCloses === 1);
  assert.equal(controller.status().phase, 'stopping'); assert.equal(calls.journalCloses, 0);
  finished.resolve(); await stopping;
  assert.equal(active, 0); assert.equal(maxActive, 1); assert.equal(calls.journalCloses, 1); assert.equal(controller.status().phase, 'stopped');
  await controller.stop(); assert.equal(calls.journalCloses, 1);
});

test('missing login stays open for scanning but never invokes the runner', async t => {
  const { controller, calls, adapter } = fakeController(); t.after(() => controller.stop());
  adapter.accountStatus = async () => ({ authenticated: false, message: 'opaque response body' });
  await controller.startLogin(); const state = await controller.confirmLogin();
  assert.equal(state.phase, 'logging_in'); assert.equal(state.browserOpen, true); assert.equal(calls.runs, 0);
  assert.ok(!JSON.stringify(state).includes('opaque response body'));
});

test('browser-open errors release the journal, redact details, and permit a retry', async t => {
  let fail = true;
  const state = fakeController();
  state.dependencies.openBrowser = async () => { if (fail) throw new BridgeError(`body contains ${config.deviceToken}`, 'BROWSER_MISSING'); return state.browser; };
  const controller = createDesktopController({ configPath: '/tmp/desktop-controller-test/config.json', dependencies: state.dependencies }); t.after(() => controller.stop());
  const result = await controller.startLogin();
  assert.equal(result.phase, 'error'); assert.equal(state.calls.journalCloses, 1); assert.ok(!JSON.stringify(result).includes(config.deviceToken));
  fail = false; assert.equal((await controller.startLogin()).phase, 'logging_in');
});

test('stop during browser creation closes the late browser and leaves no running task', async () => {
  const opened = deferred(), releaseOpen = deferred();
  const state = fakeController();
  state.dependencies.openBrowser = async () => { opened.resolve(); await releaseOpen.promise; return state.browser; };
  const controller = createDesktopController({ configPath: '/tmp/desktop-controller-test/config.json', dependencies: state.dependencies });
  const login = controller.startLogin(); await opened.promise;
  const stopping = controller.stop(); releaseOpen.resolve(); await Promise.all([login, stopping]);
  assert.equal(controller.status().phase, 'stopped'); assert.equal(controller.status().busy, false);
  assert.equal(state.calls.browserCloses, 1); assert.equal(state.calls.journalCloses, 1); assert.equal(state.calls.runs, 0);
});

test('unexpected run failure stops and closes resources without leaking error bodies', async t => {
  const { controller, calls, data } = fakeController({ runOnce: async () => { throw Error(`opaque-body ${config.sitesToken}`); } });
  data.accountId = account.accountId; t.after(() => controller.stop());
  await controller.start(); await until(() => controller.status().phase === 'error');
  assert.equal(calls.browserCloses, 1); assert.equal(calls.journalCloses, 1);
  assert.ok(!JSON.stringify(controller.status()).includes('opaque-body')); assert.ok(!JSON.stringify(controller.status()).includes(config.sitesToken));
});

test('a captcha during login confirmation preserves the current browser until explicit stop', async t => {
  const { controller, calls, adapter } = fakeController(); t.after(() => controller.stop());
  await controller.startLogin();
  adapter.accountStatus = async () => { throw new BridgeError(`opaque ${config.deviceToken}`, 'HUMAN_ACTION_REQUIRED'); };
  const paused = await controller.confirmLogin();
  assert.equal(paused.errorCode, 'HUMAN_ACTION_REQUIRED'); assert.equal(paused.browserOpen, true); assert.equal(paused.running, false);
  assert.match(paused.message, /手动完成安全验证/); assert.ok(!JSON.stringify(paused).includes(config.deviceToken));
  assert.equal(calls.browserCloses, 0); assert.equal(calls.journalCloses, 0); assert.equal(calls.runs, 0);
  adapter.accountStatus = async () => account; await controller.confirmLogin();
  assert.equal(controller.status().phase, 'ready'); assert.equal(calls.opens, 1);
  await controller.stop(); assert.equal(calls.browserCloses, 1); assert.equal(calls.journalCloses, 1);
});

for (const code of ['UNAUTHENTICATED', 'ACCOUNT_CHANGED']) test(`${code} during explicit login verification keeps the existing browser available for recovery`, async t => {
  const { controller, calls, data, adapter } = fakeController(); data.accountId = account.accountId; t.after(() => controller.stop());
  await controller.startLogin();
  adapter.accountStatus = async () => { throw new BridgeError(`opaque ${config.deviceToken}`, code); };
  const paused = await controller.confirmLogin();
  assert.equal(paused.errorCode, code); assert.equal(paused.authenticated, false); assert.equal(paused.running, false); assert.equal(paused.browserOpen, true);
  assert.equal(calls.browserCloses, 0); assert.equal(calls.journalCloses, 0); assert.equal(calls.runs, 0);
  adapter.accountStatus = async () => account; await controller.connect(); await until(() => calls.runs === 1);
  assert.equal(calls.opens, 1); assert.equal(data.accountId, account.accountId); assert.deepEqual(calls.bindings, []);
  await controller.stop(); assert.equal(calls.browserCloses, 1); assert.equal(calls.journalCloses, 1);
});

for (const challenge of ['account', 'discover', 'send']) test(`captcha during ${challenge} pauses real execution, preserves the page and never replays work`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-captcha-'));
  let controller; t.after(async () => { await controller?.stop(); await rm(directory, { recursive: true, force: true }); });
  let blocked = true, accountChecks = 0, polls = 0, actions = 0, reports = 0, closes = 0, opens = 0, journalPath;
  const kind = challenge === 'send' ? 'send' : 'discover';
  const job = { id: 'captcha-job', campaignId: 'campaign-1', leaseToken: 'lease-1', kind, input: kind === 'send'
    ? { senderAccountId: 'sender-1', recipientId: 'reader-1', profileUrl: 'https://www.douyin.com/user/reader-1', message: '你好' }
    : { keywords: ['租商铺'] } };
  const captcha = () => { throw new BridgeError('请手动完成安全验证', 'HUMAN_ACTION_REQUIRED'); };
  const adapter = {
    navigate: async () => {}, accountStatus: async () => { accountChecks++; if (challenge === 'account' && accountChecks >= 3 && blocked) captcha(); return account; },
    discover: async () => { actions++; if (blocked) captcha(); return { candidates: [] }; },
    send: async (_input, { beforeDispatch }) => { await beforeDispatch(); actions++; captcha(); },
  };
  const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  controller = createDesktopController({ configPath: join(directory, 'config.json'), dependencies: {
    loadConfig: async () => config, openJournal: async path => { journalPath = path; return Journal.open(path); },
    openBrowser: async () => { opens++; return { adapter, close: async () => { closes++; } }; },
    sleep: async (_ms, { signal }) => { if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); },
    runOnce: (value, options) => runOnce(value, { ...options, fetchImpl: async (url, init) => {
      if (url.endsWith('/poll')) { polls++; return response({ job }); }
      if (url.endsWith('/complete')) { reports++; if (kind === 'send') assert.equal(JSON.parse(init.body).result.outcome, 'unknown'); }
      return response({ ok: true });
    } }),
  } });
  await controller.confirmLogin(); await controller.start();
  await until(() => controller.status().errorCode === 'HUMAN_ACTION_REQUIRED');
  assert.equal(controller.status().running, false); assert.equal(controller.status().browserOpen, true); assert.equal(closes, 0);
  const entries = JSON.parse(await readFile(journalPath, 'utf8')).entries;
  assert.equal(polls, challenge === 'account' ? 0 : 1); assert.equal(reports, challenge === 'account' ? 0 : 1);
  if (challenge === 'account') assert.equal(entries.length, 0);
  else { assert.equal(entries[0].reported, true); if (kind === 'send') assert.equal(entries[0].result.outcome, 'unknown'); else assert.match(entries[0].error, /安全验证/); }
  blocked = false; await controller.confirmLogin(); await controller.start();
  await until(() => challenge === 'account' ? reports === 1 : polls === 2);
  await controller.stop(); assert.equal(actions, 1); assert.equal(opens, 1); assert.equal(closes, 1);
});

test('legacy confirmation cannot replace the account of an existing pairing', async t => {
  const { controller, calls, data } = fakeController(); data.accountId = 'old-account'; t.after(() => controller.stop());
  assert.equal((await controller.start()).phase, 'logging_in'); assert.equal(calls.runs, 0);
  await controller.confirmLogin(); assert.equal(controller.status().phase, 'account_mismatch');
  await controller.start(); assert.equal(calls.runs, 0); assert.equal(data.accountId, 'old-account'); assert.deepEqual(calls.bindings, []);
});

test('missing pairing is a friendly state and does not open the browser', async t => {
  const { controller, calls } = fakeController({ loadConfig: async () => { const error = Error(`read failed: ${config.deviceToken}`); error.code = 'ENOENT'; throw error; } });
  t.after(() => controller.stop());
  const state = await controller.startLogin();
  assert.equal(state.phase, 'error'); assert.equal(state.errorCode, 'ENOENT');
  assert.match(state.message, /导入配对配置/); assert.equal(calls.opens, 0); assert.equal(calls.runs, 0);
  assert.ok(!JSON.stringify(state).includes(config.deviceToken));
});

test('transient network failure stays serial and retry waits for the configured pause', async t => {
  const paused = deferred(), resume = deferred(); let count = 0;
  const { controller, calls, data } = fakeController({
    runOnce: async () => { count++; if (count === 1) throw new BridgeError(`body ${config.sitesToken}`, 'NETWORK'); return { worked: false, authenticated: true }; },
    sleep: async (_ms, { signal }) => { paused.resolve(); if (count === 1) await resume.promise; else if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); },
  }); data.accountId = account.accountId; t.after(() => controller.stop());
  await controller.start(); await paused.promise;
  assert.equal(count, 1); assert.equal(controller.status().running, true); assert.equal(calls.journalCloses, 0);
  assert.ok(!JSON.stringify(controller.status()).includes(config.sitesToken));
  resume.resolve(); await until(() => count === 2); await controller.stop();
  assert.equal(count, 2); assert.equal(calls.journalCloses, 1);
});

test('temporary account verification keeps the same browser open beyond four unresolved polls without claiming authentication', async t => {
  let polls = 0; const retryStates = [];
  const { controller, calls, data } = fakeController({
    runOnce: async () => { polls++; return { worked: false, authenticated: false, verificationPending: true }; },
    sleep: async (_ms, { signal }) => {
      retryStates.push(controller.status());
      if (polls >= 8 && !signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    },
  }); data.accountId = account.accountId; t.after(() => controller.stop());
  await controller.start(); await until(() => polls >= 8 || controller.status().phase === 'login_required');
  assert.equal(polls, 8); assert.equal(retryStates.length, 8);
  for (const state of retryStates) {
    assert.equal(state.running, true); assert.equal(state.browserOpen, true); assert.equal(state.authenticated, false);
    assert.match(state.message, /核实|核验/); assert.match(state.message, /重试/);
  }
  assert.equal(calls.opens, 1); assert.equal(calls.browserCloses, 0); assert.equal(calls.journalCloses, 0);
  assert.equal(data.accountId, account.accountId); assert.deepEqual(calls.bindings, []);
  await controller.stop(); assert.equal(calls.browserCloses, 1); assert.equal(calls.journalCloses, 1);
});

test('successful account verification restores authentication after repeated unresolved checks and can recover again', async t => {
  const pending = { worked: false, authenticated: false, verificationPending: true };
  const sequence = [pending, pending, pending, pending, { worked: false, authenticated: true }, pending, { worked: false, authenticated: true }];
  let polls = 0; const states = [];
  const { controller, calls, data } = fakeController({
    runOnce: async () => sequence[polls++],
    sleep: async (_ms, { signal }) => {
      states.push(controller.status());
      if (polls >= sequence.length && !signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    },
  }); data.accountId = account.accountId; t.after(() => controller.stop());
  await controller.start(); await until(() => polls >= sequence.length || controller.status().phase === 'login_required');
  assert.equal(polls, sequence.length); assert.equal(states.length, sequence.length);
  assert.equal(states[4].authenticated, true); assert.equal(states[5].authenticated, false); assert.equal(states[6].authenticated, true);
  assert.equal(controller.status().running, true); assert.equal(calls.browserCloses, 0); assert.equal(calls.journalCloses, 0);
});

test('an explicit missing or changed account pauses polling but explicit reconnection reuses the retained browser and binding', async t => {
  for (const unauthenticated of [{ worked: false, authenticated: false }, { worked: false, authenticated: false, verificationPending: false }]) {
    let polls = 0, restored = false;
    const { controller, calls, data } = fakeController({
      runOnce: async () => { polls++; return restored ? { worked: false, authenticated: true } : polls === 1 ? { worked: false, authenticated: false, verificationPending: true } : unauthenticated; },
      sleep: async (_ms, { signal }) => { if (restored && !signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); },
    }); data.accountId = account.accountId; t.after(() => controller.stop());
    await controller.start(); await until(() => controller.status().phase === 'login_required');
    assert.equal(polls, 2); assert.equal(controller.status().running, false); assert.equal(controller.status().authenticated, false);
    assert.equal(controller.status().browserOpen, true); assert.equal(calls.browserCloses, 0); assert.equal(calls.journalCloses, 0);
    restored = true; await controller.connect(); await until(() => polls === 3);
    assert.equal(controller.status().running, true); assert.equal(calls.opens, 1); assert.equal(data.accountId, account.accountId); assert.deepEqual(calls.bindings, []);
    await controller.stop(); assert.equal(calls.browserCloses, 1); assert.equal(calls.journalCloses, 1);
  }
});

for (const code of ['UNAUTHENTICATED', 'ACCOUNT_CHANGED']) test(`${code} pauses without closing the session, and reconnecting still enforces the original account`, async t => {
  let polls = 0, restored = false;
  const { controller, calls, data, adapter } = fakeController({
    runOnce: async () => { polls++; if (!restored) throw new BridgeError(`opaque ${config.deviceToken}`, code); return { worked: false, authenticated: true }; },
  }); data.accountId = account.accountId; t.after(() => controller.stop());
  await controller.start(); await until(() => controller.status().errorCode === code);
  assert.equal(controller.status().running, false); assert.equal(controller.status().authenticated, false); assert.equal(controller.status().browserOpen, true);
  assert.equal(calls.browserCloses, 0); assert.equal(calls.journalCloses, 0); assert.equal(polls, 1);
  assert.ok(!JSON.stringify(controller.status()).includes(config.deviceToken));
  adapter.accountStatus = async () => ({ ...account, accountId: 'different-account' });
  await controller.connect(); assert.equal(controller.status().phase, 'account_mismatch'); assert.equal(polls, 1); assert.equal(data.accountId, account.accountId);
  adapter.accountStatus = async () => account; restored = true;
  await controller.connect(); await until(() => polls === 2);
  assert.equal(controller.status().running, true); assert.equal(calls.opens, 1); assert.deepEqual(calls.bindings, []);
  await controller.stop(); assert.equal(calls.browserCloses, 1); assert.equal(calls.journalCloses, 1);
});

test('stop after dispatch keeps real journal unknown and restart only reports the result', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-real-journal-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const dispatched = deferred(); let sends = 0, claimed = false, journalPath, reports = 0;
  const job = { id: 'send-desktop', campaignId: 'campaign-1', leaseToken: 'lease-1', kind: 'send', input: { senderAccountId: 'sender-1', recipientId: 'reader-1', profileUrl: 'https://www.douyin.com/user/reader-1', message: '你好' } };
  const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  const adapter = { navigate: async () => {}, accountStatus: async () => account, send: async (_input, { beforeDispatch, signal }) => {
    await beforeDispatch(); sends++; dispatched.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    throw Error('browser closed after dispatch');
  } };
  const controller = createDesktopController({ configPath: join(directory, 'config.json'), dependencies: {
    loadConfig: async () => config, openJournal: async path => { journalPath = path; return Journal.open(path); },
    openBrowser: async () => ({ adapter, close: async () => {} }),
    runOnce: (value, options) => runOnce(value, { ...options, fetchImpl: async (url, init) => {
      if (url.endsWith('/poll')) { if (claimed) return response({ job: null }); claimed = true; return response({ job }); }
      if (url.endsWith('/complete')) { reports++; assert.equal(JSON.parse(init.body).result.outcome, 'unknown'); }
      return response({ ok: true });
    } }),
  } }); t.after(() => controller.stop());
  await controller.startLogin(); await controller.confirmLogin(); await controller.start(); await dispatched.promise; await controller.stop();
  assert.equal(JSON.parse(await readFile(journalPath, 'utf8')).entries[0].result.outcome, 'unknown');
  await controller.start(); await until(() => reports === 1); await controller.stop();
  assert.equal(sends, 1);
});
