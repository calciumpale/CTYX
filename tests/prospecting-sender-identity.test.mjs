import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DouyinBrowserAdapter } from '../tools/douyin-bridge/browser-adapter.mjs';

const browserTest = process.env.PROSPECT_BROWSER_TEST === '1' ? test : test.skip;
const handle = 'tenant_123';
const ownProfile = (value = handle, controls = true) => `<main><h1>同名账号</h1><span>抖音号：${value}</span>${controls ? '<button role="tab">私密作品</button><input placeholder="搜索你发布的作品">' : ''}</main>`;
const result = (id, value = handle) => `<a href="/user/${id}?from=search">同名账号 抖音号: ${value}\n10粉丝 20获赞</a>`;
function advanceIdentityNavigation(t, adapter) {
  const previousNow = Date.now.bind(Date);
  const offset = Math.max(0, (adapter.lastIdentityNavigationAt ?? previousNow()) + 60001 - previousNow());
  t.mock.method(Date, 'now', () => previousNow() + offset);
}
async function fixture(t, { search = result('other-user', `${handle}_other`) + result('sender-1'), canonical = ownProfile(), self = ownProfile(), conversation = false } = {}) {
  const { chromium } = await import('../tools/douyin-bridge/node_modules/playwright/index.mjs');
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const context = await browser.newContext();
  const state = { search, canonical, self, requests: [], failCanonical: false, profiles: {} };
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'https://www.douyin.com') return route.abort();
    state.requests.push(url.pathname);
    if (state.failCanonical && url.pathname === '/user/sender-1') return route.abort();
    const content = state.profiles[url.pathname] ?? (url.pathname === '/user/self' ? state.self
      : url.pathname === '/user/sender-1' ? state.canonical
      : url.pathname.startsWith('/search/') ? state.search
      : conversation ? '<main><button onclick="document.querySelector(\'[role=dialog]\').hidden=false">私信</button><section role="dialog" hidden><a href="/user/recipient-1">会话对象</a><div data-e2e="message-list"><div data-e2e="message-item" data-message-direction="incoming" data-message-id="inbound-1"><span data-e2e="message-text">想了解面积</span></div></div><textarea>保留的私信草稿</textarea></section></main>'
      : '<main><h1>同名账号</h1><span>抖音号：different_recipient</span><div role="dialog"><textarea>保留的私信草稿</textarea></div></main>');
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body><header><a aria-label="我的主页" href="/user/self">我</a></header>${content}</body></html>` });
  });
  const adapter = new DouyinBrowserAdapter(context, { timeoutMs: 1000, confirmationMs: 100 });
  const page = await adapter.navigate('https://www.douyin.com/user/recipient-1');
  return { adapter, page, state };
}
async function stackConversationFixture(t) {
  const data = await fixture(t, { conversation: true });
  await data.adapter.accountStatus({ expectedAccountId: 'sender-1' });
  await data.page.locator('[role=dialog]').evaluate(root => {
    root.setAttribute('data-stack-layer', 'chat');
    root.querySelector('a').remove();
    root.insertAdjacentHTML('afterbegin', '<div class="StackLayoutStackChatHeaderuser"><div data-apm-action="个人页卡片" onclick="window.open(\'/user/recipient-1\')">同名客户</div></div>');
  });
  return data;
}

browserTest('sender recovery requires an exact handle result and canonical owner controls without changing the chat', async t => {
  const { adapter, page } = await fixture(t);
  const account = await adapter.accountStatus();
  assert.equal(account.authenticated, true);
  assert.equal(account.accountId, 'sender-1');
  assert.equal(account.verifiedReadOnlyAccountId, `dy-readonly-${createHash('sha256').update(handle).digest('hex').slice(0, 24)}`);
  advanceIdentityNavigation(t, adapter);
  assert.equal((await adapter.verifiedSender(page, 'sender-1')).accountId, 'sender-1');
  assert.equal(page.url(), 'https://www.douyin.com/user/recipient-1');
  assert.equal(await page.locator('textarea').inputValue(), '保留的私信草稿');
});

browserTest('adjacent profile stats do not become part of the displayed Douyin handle', async t => {
  const search = `<a href="/user/sender-1"><span>同名账号</span><span>抖音号: ${handle}</span><span>0获赞</span><span>0粉丝</span></a>`;
  const { adapter } = await fixture(t, { search });
  assert.equal((await adapter.accountStatus()).accountId, 'sender-1');
});

browserTest('fuzzy-only and ambiguous exact search identities stay read-only', async t => {
  for (const search of [result('sender-1', `${handle}_other`), result('sender-1') + result('another-user')]) {
    const { adapter } = await fixture(t, { search });
    const account = await adapter.accountStatus();
    assert.equal(account.authenticated, true);
    assert.match(account.accountId, /^dy-readonly-/);
    assert.equal(account.verifiedReadOnlyAccountId, undefined);
  }
});

browserTest('a matching result cannot authorize sending without the same visible owner proof on its canonical page', async t => {
  for (const canonical of [ownProfile(handle, false), ownProfile('different_handle')]) {
    const { adapter } = await fixture(t, { canonical });
    const account = await adapter.accountStatus();
    assert.match(account.accountId, /^dy-readonly-/);
    assert.equal(account.verifiedReadOnlyAccountId, undefined);
  }
});

browserTest('a cached canonical identity is rejected after the signed-in account changes', async t => {
  const { adapter, page, state } = await fixture(t);
  assert.equal((await adapter.accountStatus()).accountId, 'sender-1');
  state.canonical = ownProfile(handle, false);
  state.self = ownProfile('switched_account');
  advanceIdentityNavigation(t, adapter);
  const account = await adapter.verifiedSender(page, 'sender-1');
  assert.equal(account.authenticated, false);
  assert.equal(page.url(), 'https://www.douyin.com/user/recipient-1');
  assert.equal(await page.locator('textarea').inputValue(), '保留的私信草稿');
});

browserTest('owner proof waits for the visible handle after owner controls have rendered', async t => {
  const canonical = ownProfile().replace(`<span>抖音号：${handle}</span>`, '<span id="pending-handle"></span>') + `<script>setTimeout(() => document.querySelector('#pending-handle').textContent = '抖音号：${handle}', 300)</script>`;
  const { adapter } = await fixture(t, { canonical });
  const page = await adapter.identityNavigate('https://www.douyin.com/user/sender-1');
  assert.equal((await adapter.ownProfileProof(page, undefined, 'sender-1'))?.handle, handle);
});

browserTest('strict sender proof waits for delayed owner search hydration without another reload', async t => {
  const { adapter, page, state } = await fixture(t);
  await adapter.accountStatus({ expectedAccountId: 'sender-1' });
  state.canonical = ownProfile().replace('<input placeholder="搜索你发布的作品">', '') + '<script>setTimeout(() => document.querySelector("main").insertAdjacentHTML("beforeend", \'<input placeholder="搜索你发布的作品">\'), 3000)</script>';
  adapter.timeoutMs = 5000;
  advanceIdentityNavigation(t, adapter);
  const before = state.requests.length;
  const verified = await adapter.verifiedSender(page, 'sender-1');
  assert.equal(verified.authenticated, true);
  assert.equal(verified.accountId, 'sender-1');
  assert.deepEqual(state.requests.slice(before), ['/user/sender-1']);
  assert.equal(await page.locator('textarea').inputValue(), '保留的私信草稿');
});

browserTest('strict sender proof waits for duplicate identical labels to become one without another reload', async t => {
  const { adapter, page, state } = await fixture(t);
  await adapter.accountStatus({ expectedAccountId: 'sender-1' });
  state.canonical = ownProfile() + `<span id="duplicate-owner">抖音号：${handle}</span><script>setTimeout(()=>document.querySelector('#duplicate-owner').remove(),1000)</script>`;
  adapter.timeoutMs = 2500;
  advanceIdentityNavigation(t, adapter);
  const before = state.requests.length;
  const account = await adapter.verifiedSender(page, 'sender-1');
  assert.equal(account.authenticated, true);
  assert.deepEqual(state.requests.slice(before), ['/user/sender-1']);
});

browserTest('strict sender proof waits for owner controls replaced after initial visibility', async t => {
  const { adapter, page, state } = await fixture(t);
  await adapter.accountStatus({ expectedAccountId: 'sender-1' });
  state.canonical = ownProfile() + '<span id="reloaded-owner"></span>';
  adapter.timeoutMs = 2500;
  const guard = adapter.guard.bind(adapter); let ownerChecks = 0;
  adapter.guard = async (current, signal) => {
    await guard(current, signal);
    if (current === adapter.identityPage && await current.locator('#reloaded-owner').count() && ++ownerChecks === 2) {
      await current.getByPlaceholder('搜索你发布的作品', { exact: true }).evaluate(node => { node.hidden = true; setTimeout(() => { node.hidden = false; }, 1000); });
    }
  };
  advanceIdentityNavigation(t, adapter);
  const before = state.requests.length;
  const account = await adapter.verifiedSender(page, 'sender-1');
  assert.equal(account.authenticated, true);
  assert.deepEqual(state.requests.slice(before), ['/user/sender-1']);
});

browserTest('persistent identical owner labels never authorize while conflicting handles reject immediately', async t => {
  for (const conflicting of [false, true]) {
    const { adapter } = await fixture(t);
    const value = conflicting ? 'different_owner' : handle;
    const page = await adapter.identityNavigate('https://www.douyin.com/user/sender-1');
    await page.locator('main').evaluate((node, label) => node.insertAdjacentHTML('beforeend', `<span>抖音号：${label}</span>`), value);
    adapter.timeoutMs = 350;
    const guard = adapter.guard.bind(adapter); let observations = 0;
    adapter.guard = async (...args) => { observations++; await guard(...args); };
    assert.equal(await adapter.ownProfileProof(page, undefined, 'sender-1'), null);
    assert.equal(adapter.ownerProofFailureReason, conflicting ? 'owner_handle_conflict' : 'owner_duplicate_same_handle');
    if (conflicting) assert.equal(observations, 1, 'A proved conflict must not retry hydration');
  }
});

browserTest('owner control hydration shares one overall timeout across both controls', async t => {
  const { adapter } = await fixture(t);
  const page = await adapter.identityNavigate('https://www.douyin.com/user/sender-1');
  await page.locator('main').evaluate(node => {
    node.querySelector('[role=tab]').remove(); node.querySelector('input').remove();
    setTimeout(() => node.insertAdjacentHTML('beforeend', '<button role="tab">私密作品</button>'), 200);
    setTimeout(() => node.insertAdjacentHTML('beforeend', '<input placeholder="搜索你发布的作品">'), 450);
  });
  adapter.timeoutMs = 350;
  assert.equal(await adapter.ownProfileProof(page, undefined, 'sender-1'), null);
  assert.equal(adapter.ownerProofFailureReason, 'owner_controls_timeout');
});

browserTest('waiting for owner hydration never accepts duplicate handles or a changed profile path', async t => {
  for (const canonical of [ownProfile() + `<span>抖音号：${handle}</span>`, ownProfile().replace(`<span>抖音号：${handle}</span>`, '<span id="pending-handle"></span>') + `<script>setTimeout(() => {history.replaceState({}, '', '/user/another-user'); document.querySelector('#pending-handle').textContent='抖音号：${handle}'}, 100)</script>`]) {
    const { adapter } = await fixture(t, { canonical });
    const page = await adapter.identityNavigate('https://www.douyin.com/user/sender-1');
    assert.equal(await adapter.ownProfileProof(page, undefined, 'sender-1'), null);
  }
});

browserTest('missing owner controls expose temporary verification without claiming authentication', async t => {
  const { adapter } = await fixture(t, { self: ownProfile(handle, false) });
  const result = await adapter.recoverOwnAccount();
  assert.equal(result.authenticated, false); assert.equal(result.verificationPending, true);
});

browserTest('a proved conflicting canonical handle is not a temporary missing-proof retry', async t => {
  const { adapter } = await fixture(t, { canonical: ownProfile('different_handle') });
  const result = await adapter.recoverOwnAccount(undefined, { allowReadOnly: false });
  assert.equal(result.authenticated, false); assert.equal(result.verificationPending, undefined);
});

browserTest('a bound canonical is only a fresh owner-proof hint and skips self/search rediscovery', async t => {
  const { adapter, state } = await fixture(t, { search: '', self: ownProfile('irrelevant_handle') });
  const result = await adapter.accountStatus({ expectedAccountId: 'sender-1' });
  assert.equal(result.authenticated, true); assert.equal(result.accountId, 'sender-1');
  assert.deepEqual(state.requests, ['/user/recipient-1', '/user/sender-1']);
});

browserTest('passive identity expiry rereads owner DOM without navigation while strict checks still reload ownership', async t => {
  const { adapter, page, state } = await fixture(t);
  const options = { expectedAccountId: 'sender-1' };
  assert.equal((await adapter.accountStatus(options)).accountId, 'sender-1');
  const count = () => state.requests.filter(path => path === '/user/sender-1').length;
  const initial = count();
  assert.equal((await adapter.accountStatus({ ...options, passive: true })).accountId, 'sender-1');
  assert.equal(count(), initial);
  await adapter.accountStatus(options); assert.equal(count(), initial + 1);
  advanceIdentityNavigation(t, adapter);
  await adapter.verifiedSender(page, 'sender-1'); assert.equal(count(), initial + 2);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(15001);
  assert.equal((await adapter.accountStatus({ ...options, passive: true })).accountId, 'sender-1');
  assert.equal(count(), initial + 2);
  await adapter.identityPage.locator('[role=tab]').evaluate(node => node.remove());
  t.mock.timers.tick(15001);
  assert.equal((await adapter.accountStatus({ ...options, passive: true })).authenticated, false);
  assert.equal(count(), initial + 2);
});

browserTest('a conflicting or ambiguous current header invalidates passive identity reuse', async t => {
  const { adapter, page, state } = await fixture(t);
  const options = { expectedAccountId: 'sender-1', passive: true };
  await adapter.accountStatus({ expectedAccountId: 'sender-1' });
  await page.locator('header').evaluate(node => { node.innerHTML = '<a aria-label="我的主页" href="/user/sender-2">其他账号</a>'; });
  assert.equal((await adapter.accountStatus(options)).accountId, 'sender-2');
  await page.locator('header').evaluate(node => { node.innerHTML = '<a aria-label="我的主页" href="/user/self">我</a>'; });
  const count = state.requests.length;
  await adapter.accountStatus(options); assert.equal(state.requests.length, count);
  await page.locator('header').evaluate(node => { node.innerHTML = '<a aria-label="我的主页" href="/user/sender-1">我</a><a aria-label="我的主页" href="/user/sender-2">其他账号</a>'; });
  const ambiguous = await adapter.accountStatus(options);
  assert.equal(ambiguous.authenticated, false); assert.equal(ambiguous.accountId, undefined);
});

browserTest('a strict sender check never accepts a passive proof after owner controls disappear', async t => {
  const { adapter, page, state } = await fixture(t);
  await adapter.accountStatus({ expectedAccountId: 'sender-1' });
  state.canonical = ownProfile(handle, false); state.self = ownProfile(handle, false);
  advanceIdentityNavigation(t, adapter);
  assert.equal((await adapter.verifiedSender(page, 'sender-1')).authenticated, false);
});

browserTest('a known canonical losing proof stays pending instead of claiming its readonly alias as a changed account', async t => {
  const { adapter, state } = await fixture(t);
  await adapter.accountStatus({ expectedAccountId: 'sender-1' });
  const count = state.requests.length;
  state.canonical = ownProfile(handle, false); state.search = '';
  const result = await adapter.accountStatus({ expectedAccountId: 'sender-1' });
  assert.equal(result.authenticated, false); assert.equal(result.verificationPending, true); assert.equal(result.accountId, undefined);
  assert.deepEqual(state.requests.slice(count), ['/user/sender-1', '/user/self']);
});

browserTest('a different freshly proved self handle still resolves the real replacement canonical', async t => {
  const { adapter, state } = await fixture(t);
  await adapter.accountStatus({ expectedAccountId: 'sender-1' });
  state.canonical = ownProfile(handle, false); state.self = ownProfile('new_handle');
  state.search = result('sender-2', 'new_handle'); state.profiles['/user/sender-2'] = ownProfile('new_handle');
  const observed = await adapter.accountStatus({ expectedAccountId: 'sender-1' });
  assert.equal(observed.authenticated, true); assert.equal(observed.accountId, 'sender-2');
  assert.equal(observed.verificationPending, undefined);
});

browserTest('closing the verified identity page pauses passive checks without opening tabs and explicit reconnect can recover', async t => {
  const { adapter, state } = await fixture(t);
  const options = { expectedAccountId: 'sender-1', passive: true };
  await adapter.accountStatus({ expectedAccountId: 'sender-1' });
  await adapter.identityPage.close();
  const count = state.requests.length;
  const pages = adapter.context.pages().length;
  assert.equal((await adapter.accountStatus(options)).authenticated, false);
  assert.equal(state.requests.length, count);
  assert.equal(adapter.context.pages().length, pages);
  assert.equal((await adapter.accountStatus({ expectedAccountId: 'sender-1' })).accountId, 'sender-1');
  assert.equal(state.requests.length, count + 1);
  state.failCanonical = true;
  const result = await adapter.accountStatus({ expectedAccountId: 'sender-1' });
  assert.equal(result.authenticated, false); assert.equal(result.verificationPending, true); assert.equal(result.accountId, undefined);
});


browserTest('passive health checks on an unopened or closed workspace never create or navigate a tab', async t => {
  const { adapter, page, state } = await fixture(t);
  await page.close();
  const before = state.requests.length;
  const pages = adapter.context.pages().length;
  assert.equal((await adapter.accountStatus({ passive: true, expectedAccountId: 'sender-1' })).authenticated, false);
  assert.equal(state.requests.length, before);
  assert.equal(adapter.context.pages().length, pages);
  const fresh = new DouyinBrowserAdapter(adapter.context, { timeoutMs: 100 });
  assert.equal((await fresh.accountStatus({ passive: true })).authenticated, false);
  assert.equal(adapter.context.pages().length, pages);
});

browserTest('temporary missing owner DOM recovers passively without navigating or authorizing a send', async t => {
  const { adapter, page, state } = await fixture(t);
  await adapter.accountStatus({ expectedAccountId: 'sender-1' });
  const initial = state.requests.length;
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() }); t.mock.timers.tick(15001);
  await adapter.identityPage.locator('[role=tab]').evaluate(node => node.remove());
  const pending = await adapter.accountStatus({ expectedAccountId: 'sender-1', passive: true });
  assert.equal(pending.authenticated, false); assert.equal(pending.verificationPending, true);
  assert.equal(state.requests.length, initial);
  await adapter.identityPage.locator('main').evaluate(node => node.insertAdjacentHTML('beforeend', '<button role="tab">私密作品</button>'));
  assert.equal((await adapter.accountStatus({ expectedAccountId: 'sender-1', passive: true })).accountId, 'sender-1');
  assert.equal(state.requests.length, initial);
  state.canonical = ownProfile(handle, false); state.self = ownProfile(handle, false);
  assert.equal((await adapter.verifiedSender(page, 'sender-1')).authenticated, false);
});

browserTest('read-only sessions retain a live owner-proof page for quiet passive collection checks', async t => {
  const { adapter, state } = await fixture(t, { search: result('other-user', `${handle}_other`) });
  const first = await adapter.accountStatus();
  assert.match(first.accountId, /^dy-readonly-/);
  const initial = state.requests.length;
  const realNow = Date.now.bind(Date); t.mock.method(Date, 'now', () => realNow() + 15001);
  const observed = await adapter.accountStatus({ passive: true, expectedAccountId: first.accountId });
  assert.equal(observed.authenticated, true); assert.equal(observed.accountId, first.accountId);
  assert.equal(state.requests.length, initial);
});

browserTest('dedicated session initialization reuses its owned existing page instead of opening another tab', async t => {
  const { adapter, page } = await fixture(t);
  const pages = adapter.context.pages().length;
  const resumed = new DouyinBrowserAdapter(adapter.context, { initialPage: page, timeoutMs: 100 });
  assert.equal(await resumed.page() === page, true);
  assert.equal(adapter.context.pages().length, pages);
});

browserTest('a transient DOM read interruption stays unauthenticated and recovers on the same pages', async t => {
  const { adapter, state } = await fixture(t);
  await adapter.accountStatus({ expectedAccountId: 'sender-1' });
  const before = state.requests.length, readAccount = adapter.currentAccount.bind(adapter);
  adapter.currentAccount = async () => { throw Error('Execution context was destroyed'); };
  const pending = await adapter.accountStatus({ passive: true, expectedAccountId: 'sender-1' });
  assert.equal(pending.authenticated, false); assert.equal(pending.verificationPending, true);
  assert.equal(state.requests.length, before);
  adapter.currentAccount = readAccount;
  assert.equal((await adapter.accountStatus({ passive: true, expectedAccountId: 'sender-1' })).accountId, 'sender-1');
  assert.equal(state.requests.length, before);
});

browserTest('bounded recovery can refresh a proved SELF alias without replacing the chat or draft', async t => {
  const { adapter, page, state } = await fixture(t);
  await adapter.accountStatus({ expectedAccountId: 'sender-1' });
  await adapter.identityNavigate('https://www.douyin.com/user/self');
  adapter.passiveAccount.checkedAt -= 15001;
  assert.equal((await adapter.accountStatus({ passive: true, expectedAccountId: 'sender-1' })).accountId, 'sender-1');
  const before = state.requests.length, pages = adapter.context.pages().length;
  advanceIdentityNavigation(t, adapter);
  const recovered = await adapter.recoverAccountStatus({ expectedAccountId: 'sender-1' });
  assert.equal(recovered.authenticated, true); assert.equal(recovered.accountId, 'sender-1');
  assert.deepEqual(state.requests.slice(before), ['/user/sender-1']);
  assert.equal(adapter.context.pages().length, pages);
  assert.equal(page.url(), 'https://www.douyin.com/user/recipient-1');
  assert.equal(await page.locator('textarea').inputValue(), '保留的私信草稿');
  assert.equal((await adapter.accountStatus({ passive: true, expectedAccountId: 'sender-1' })).authenticated, true);
});

browserTest('a missing task header retains independently proved owner health without scheduling repeated recovery', async t => {
  const { adapter, page, state } = await fixture(t);
  await adapter.accountStatus({ expectedAccountId: 'sender-1' });
  await page.locator('header').evaluate(node => node.remove());
  const before = state.requests.length;
  for (let i = 0; i < 3; i++) {
    adapter.passiveAccount.checkedAt -= 15001;
    assert.equal((await adapter.accountStatus({ passive: true, expectedAccountId: 'sender-1' })).accountId, 'sender-1');
  }
  assert.equal(state.requests.length, before);
  state.canonical = ownProfile(handle, false); state.self = ownProfile(handle, false);
  assert.equal((await adapter.verifiedSender(page, 'sender-1')).authenticated, false);
});

browserTest('bounded recovery repairs the SELF state left by a transient canonical proof failure', async t => {
  const { adapter, page, state } = await fixture(t);
  await adapter.accountStatus({ expectedAccountId: 'sender-1' });
  state.canonical = ownProfile(handle, false);
  assert.equal((await adapter.accountStatus({ expectedAccountId: 'sender-1' })).verificationPending, true);
  assert.equal(adapter.identityPage.url(), 'https://www.douyin.com/user/self');
  assert.equal(adapter.senderProof.accountId, 'sender-1');
  assert.equal(adapter.senderProof.handle, handle);
  state.canonical = ownProfile();
  const before = state.requests.length;
  advanceIdentityNavigation(t, adapter);
  const recovered = await adapter.recoverAccountStatus({ expectedAccountId: 'sender-1' });
  assert.equal(recovered.accountId, 'sender-1'); assert.equal(recovered.authenticated, true);
  assert.deepEqual(state.requests.slice(before), ['/user/sender-1']);
  assert.equal(await page.locator('textarea').inputValue(), '保留的私信草稿');
});

browserTest('a failed identity navigation recovers from the browser error page without requiring login', async t => {
  const { adapter, page, state } = await fixture(t);
  await adapter.accountStatus({ expectedAccountId: 'sender-1' });
  const identity = adapter.identityPage, pages = adapter.context.pages().length;
  state.failCanonical = true;
  advanceIdentityNavigation(t, adapter);
  const interrupted = await adapter.recoverAccountStatus({ expectedAccountId: 'sender-1' });
  assert.equal(interrupted.verificationPending, true);
  assert.equal(interrupted.verificationReason, 'navigation_failed');
  await identity.waitForURL('chrome-error://chromewebdata/', { waitUntil: 'commit', timeout: 2000 });
  assert.equal((await adapter.accountStatus({ passive: true, expectedAccountId: 'sender-1' })).verificationPending, true);
  state.failCanonical = false;
  const before = state.requests.length;
  assert.equal((await adapter.recoverAccountStatus({ expectedAccountId: 'sender-1' })).verificationPending, true);
  assert.equal(state.requests.length, before, 'A failed navigation also starts the quiet period');
  advanceIdentityNavigation(t, adapter);
  const recovered = await adapter.recoverAccountStatus({ expectedAccountId: 'sender-1' });
  assert.equal(recovered.authenticated, true);
  assert.equal(recovered.accountId, 'sender-1');
  assert.deepEqual(state.requests.slice(before), ['/user/sender-1']);
  assert.equal(adapter.identityPage, identity);
  assert.equal(adapter.context.pages().length, pages);
  assert.equal(await page.locator('textarea').inputValue(), '保留的私信草稿');
});

browserTest('browser error recovery still requires fresh matching owner proof', async t => {
  for (const proof of ['missing', 'changed']) {
    const { adapter, page, state } = await fixture(t);
    await adapter.accountStatus({ expectedAccountId: 'sender-1' });
    state.failCanonical = true;
    advanceIdentityNavigation(t, adapter);
    await adapter.recoverAccountStatus({ expectedAccountId: 'sender-1' });
    await adapter.identityPage.waitForURL('chrome-error://chromewebdata/', { waitUntil: 'commit', timeout: 2000 });
    state.failCanonical = false;
    state.canonical = proof === 'missing' ? ownProfile(handle, false) : ownProfile('changed_owner');
    advanceIdentityNavigation(t, adapter);
    if (proof === 'changed') {
      await assert.rejects(adapter.recoverAccountStatus({ expectedAccountId: 'sender-1' }), error => error.code === 'ACCOUNT_CHANGED');
    } else {
      const recovered = await adapter.recoverAccountStatus({ expectedAccountId: 'sender-1' });
      assert.equal(recovered.authenticated, false);
      assert.equal(recovered.verificationPending, true);
    }
  }
});

browserTest('bounded recovery does not resurrect a closed task or identity tab or navigate an off-origin task', async t => {
  for (const missing of ['task', 'identity', 'origin']) {
    const { adapter, page, state } = await fixture(t);
    await adapter.accountStatus({ expectedAccountId: 'sender-1' });
    if (missing === 'task') await page.close();
    else if (missing === 'identity') await adapter.identityPage.close();
    else await page.goto('about:blank');
    const before = state.requests.length, pages = adapter.context.pages().length;
    const recovered = await adapter.recoverAccountStatus({ expectedAccountId: 'sender-1' });
    assert.equal(recovered.authenticated, false); assert.equal(recovered.verificationPending, undefined);
    assert.equal(state.requests.length, before); assert.equal(adapter.context.pages().length, pages);
  }
});

browserTest('bounded recovery blocks a changed current account and a visible challenge before any navigation', async t => {
  for (const blocked of ['account', 'captcha']) {
    const { adapter, page, state } = await fixture(t);
    await adapter.accountStatus({ expectedAccountId: 'sender-1' });
    if (blocked === 'account') await page.locator('header').evaluate(node => { node.innerHTML = '<a aria-label="我的主页" href="/user/sender-2">其他账号</a>'; });
    else await adapter.identityPage.locator('main').evaluate(node => node.insertAdjacentHTML('beforeend', '<div data-e2e="captcha">安全验证</div>'));
    const before = state.requests.length;
    await assert.rejects(adapter.recoverAccountStatus({ expectedAccountId: 'sender-1' }), error => error.code === (blocked === 'account' ? 'ACCOUNT_CHANGED' : 'HUMAN_ACTION_REQUIRED'));
    assert.equal(state.requests.length, before);
  }
});

browserTest('bounded recovery cannot authorize a session whose canonical owner proof is still missing', async t => {
  const { adapter, page, state } = await fixture(t);
  await adapter.accountStatus({ expectedAccountId: 'sender-1' });
  state.canonical = ownProfile(handle, false); state.self = ownProfile(handle, false);
  const before = state.requests.length;
  advanceIdentityNavigation(t, adapter);
  const recovered = await adapter.recoverAccountStatus({ expectedAccountId: 'sender-1' });
  assert.equal(recovered.authenticated, false); assert.equal(recovered.verificationPending, true);
  assert.equal(recovered.needsAccountVerification, true); assert.equal(recovered.verificationReason, 'owner_controls_timeout');
  assert.deepEqual(state.requests.slice(before), ['/user/sender-1']);
  assert.equal((await adapter.verifiedSender(page, 'sender-1')).authenticated, false);
});

browserTest('an explicit visible login control overrides stale owner health without navigating', async t => {
  const { adapter, page, state } = await fixture(t);
  await adapter.accountStatus({ expectedAccountId: 'sender-1' });
  await page.locator('header').evaluate(node => { node.innerHTML = '<button>登录</button>'; });
  const before = state.requests.length;
  const passive = await adapter.accountStatus({ passive: true, expectedAccountId: 'sender-1' });
  assert.equal(passive.authenticated, false); assert.equal(passive.verificationPending, undefined);
  const recovered = await adapter.recoverAccountStatus({ expectedAccountId: 'sender-1' });
  assert.equal(recovered.authenticated, false); assert.equal(recovered.verificationPending, undefined);
  assert.equal(state.requests.length, before);
});

const conversationInput = { senderAccountId: 'sender-1', recipientId: 'recipient-1', profileUrl: 'https://www.douyin.com/user/recipient-1', conversationId: 'conversation-1', limit: 50 };

browserTest('strict dispatch verification rejects server account changes hidden by passive read DOM', async t => {
  for (const boundary of ['before', 'after']) for (const conflict of ['missing-owner', 'changed-owner']) {
    const { adapter, page, state } = await fixture(t, { conversation: true });
    await adapter.accountStatus({ expectedAccountId: 'sender-1' });
    const identity = adapter.identityPage, hint = { ...adapter.senderProof };
    const before = state.requests.length;
    const switchSession = async () => {
      // The server's current session is now B, while the unrefreshed identity
      // tab still renders A and the freshly loaded conversation header is SELF.
      state.canonical = conflict === 'missing-owner' ? ownProfile(handle, false) : ownProfile('session_b');
      state.self = ownProfile('session_b');
      assert.equal((await adapter.ownProfileProof(identity, undefined, 'sender-1')).handle, handle);
      assert.equal((await adapter.currentAccount(page)).hasSelfLink, true);
    };
    if (boundary === 'before') await switchSession();
    else {
      const verifyTarget = adapter.verifyTarget.bind(adapter);
      adapter.verifyTarget = async (...args) => { await verifyTarget(...args); await switchSession(); };
    }
    assert.equal((await adapter.readConversation(conversationInput)).reliable, true);
    advanceIdentityNavigation(t, adapter);
    if (conflict === 'missing-owner') {
      const account = await adapter.verifiedSender(page, 'sender-1');
      assert.equal(account.authenticated, false);
      assert.equal(account.verificationPending, true);
      assert.equal(account.verificationReason, 'owner_controls_timeout');
    } else {
      await assert.rejects(adapter.verifiedSender(page, 'sender-1'), error => error.code === 'ACCOUNT_CHANGED');
    }
    assert.equal(adapter.identityPage, identity);
    assert.deepEqual(state.requests.slice(before), ['/user/sender-1']);
    assert.deepEqual(adapter.senderProof, hint);
    assert.equal(await page.locator('textarea').inputValue(), '保留的私信草稿');
  }
});

browserTest('ordinary conversation reads reuse the visible chat and inspect ownership without page reloads', async t => {
  const { adapter, page, state } = await fixture(t, { conversation: true });
  await adapter.accountStatus({ expectedAccountId: 'sender-1' });
  const before = state.requests.length, identity = adapter.identityPage, pages = adapter.context.pages().length;
  const observed = await adapter.readConversation(conversationInput);
  assert.equal(observed.messages[0].text, '想了解面积');
  assert.equal(observed.reliable, true);
  assert.equal((await adapter.readConversation(conversationInput)).reliable, true);
  assert.deepEqual(state.requests.slice(before), []);
  assert.equal(adapter.identityPage, identity);
  assert.equal(adapter.context.pages().length, pages);
  assert.equal(page.url(), 'https://www.douyin.com/user/recipient-1');
  assert.equal(await page.locator('textarea').inputValue(), '保留的私信草稿');
});

browserTest('ordinary stack reads reuse the same visible participant proof for five minutes', async t => {
  const { adapter, state } = await stackConversationFixture(t);
  const before = state.requests.length;
  for (let poll = 0; poll < 3; poll++) assert.equal((await adapter.readConversation(conversationInput)).reliable, true);
  assert.deepEqual(state.requests.slice(before), ['/user/recipient-1']);
  const previousNow = Date.now.bind(Date); t.mock.method(Date, 'now', () => previousNow() + 300001);
  assert.equal((await adapter.readConversation(conversationInput)).reliable, true);
  assert.deepEqual(state.requests.slice(before), ['/user/recipient-1', '/user/recipient-1']);
});

browserTest('a changed stack participant pauses passive reads without retrying its popup', async t => {
  const { adapter, page, state } = await stackConversationFixture(t);
  await adapter.readConversation(conversationInput);
  await page.locator('[data-apm-action]').evaluate(card => { card.textContent = '客户乙'; });
  const before = state.requests.length;
  for (let attempt = 0; attempt < 3; attempt++) await assert.rejects(adapter.readConversation(conversationInput), error => error.code === 'RECIPIENT_UNVERIFIED');
  assert.equal(state.requests.length, before);
});

browserTest('strict stack dispatch independently rejects a same-label participant callback swap', async t => {
  const { adapter, page, state } = await fixture(t);
  await page.locator('body').evaluate(body => body.insertAdjacentHTML('beforeend', '<section data-stack-layer="chat"><div class="StackLayoutStackChatHeaderuser"><div data-apm-action="个人页卡片" onclick="window.open(\'/user/recipient-1\')">同名客户</div></div></section>'));
  const root = page.locator('[data-stack-layer=chat]'), target = { id: 'recipient-1', url: 'https://www.douyin.com/user/recipient-1' };
  await adapter.verifyTarget(page, root, target, true, { passive: true });
  await root.locator('[data-apm-action]').evaluate(card => { card.onclick = () => window.open('/user/someone-else'); });
  const before = state.requests.length;
  await adapter.verifyTarget(page, root, target, true, { passive: true });
  assert.equal(state.requests.length, before);
  await assert.rejects(adapter.verifyTarget(page, root, target, true), error => error.code === 'RECIPIENT_UNVERIFIED');
  assert.deepEqual(state.requests.slice(before), ['/user/someone-else']);
});

browserTest('a cached stack card never returns another customer transcript under the original recipient', async t => {
  const { adapter, page, state } = await stackConversationFixture(t);
  assert.equal((await adapter.readConversation(conversationInput)).reliable, true);
  await page.locator('[data-stack-layer=chat]').evaluate(root => {
    root.querySelector('[data-apm-action]').onclick = () => window.open('/user/someone-else');
    root.querySelector('[data-e2e=message-text]').textContent = '另一客户的手机号13800138000';
  });
  const before = state.requests.length;
  for (let poll = 0; poll < 2; poll++) await assert.rejects(adapter.readConversation(conversationInput), error => error.code === 'RECIPIENT_UNVERIFIED');
  assert.equal(state.requests.length, before);
  const previousNow = Date.now.bind(Date); t.mock.method(Date, 'now', () => previousNow() + 60001);
  await assert.rejects(adapter.readConversation(conversationInput), error => error.code === 'RECIPIENT_UNVERIFIED');
  assert.deepEqual(state.requests.slice(before), ['/user/someone-else']);
});

browserTest('a new stack snapshot needs one budgeted target proof before returning any message body', async t => {
  const { adapter, page, state } = await stackConversationFixture(t);
  const first = await adapter.readConversation(conversationInput), before = state.requests.length;
  assert.equal((await adapter.readConversation(conversationInput)).snapshotId, first.snapshotId);
  assert.equal(state.requests.length, before, 'An unchanged snapshot has no extra popup');
  await page.locator('[data-e2e=message-text]').evaluate(node => { node.textContent = '我需要80到100平'; });
  await assert.rejects(adapter.readConversation(conversationInput), error => error.code === 'RECIPIENT_UNVERIFIED');
  assert.equal(state.requests.length, before);
  const previousNow = Date.now.bind(Date); t.mock.method(Date, 'now', () => previousNow() + 60001);
  const verified = await adapter.readConversation(conversationInput);
  assert.equal(verified.messages[0].text, '我需要80到100平');
  assert.deepEqual(state.requests.slice(before), ['/user/recipient-1']);
  assert.equal((await adapter.readConversation(conversationInput)).snapshotId, verified.snapshotId);
  assert.deepEqual(state.requests.slice(before), ['/user/recipient-1']);
});

browserTest('a transcript changing during both target proofs is never returned or cached as verified', async t => {
  const { adapter, page, state } = await stackConversationFixture(t);
  await page.locator('[data-apm-action]').evaluate(card => {
    let changes = 0;
    card.onclick = () => {
      document.querySelector('[data-e2e=message-text]').textContent = `核实期间出现的不同正文 ${++changes}`;
      window.open('/user/recipient-1');
    };
  });
  const before = state.requests.length;
  await assert.rejects(adapter.readConversation(conversationInput), error => error.code === 'CONVERSATION_CHANGED');
  assert.deepEqual(state.requests.slice(before), ['/user/recipient-1', '/user/recipient-1']);
  assert.equal(adapter.readTargetBinding?.snapshotId, undefined);
});

browserTest('strict owner verification waits at least one minute between identity navigation attempts', async t => {
  const { adapter, page, state } = await fixture(t);
  await adapter.accountStatus({ expectedAccountId: 'sender-1' });
  const before = state.requests.length;
  const immediate = await adapter.verifiedSender(page, 'sender-1');
  assert.equal(immediate.authenticated, false);
  assert.equal(immediate.verificationPending, true);
  assert.deepEqual(state.requests.slice(before), []);
  const realNow = Date.now.bind(Date); t.mock.method(Date, 'now', () => realNow() + 60001);
  const verified = await adapter.verifiedSender(page, 'sender-1');
  assert.equal(verified.accountId, 'sender-1');
  assert.deepEqual(state.requests.slice(before), ['/user/sender-1']);
  const repeated = await adapter.verifiedSender(page, 'sender-1');
  assert.equal(repeated.verificationPending, true);
  assert.deepEqual(state.requests.slice(before), ['/user/sender-1']);
});

browserTest('an actual send refreshes its owner once only at the final dispatch boundary', async t => {
  const { adapter, page, state } = await fixture(t, { conversation: true });
  await adapter.accountStatus({ expectedAccountId: 'sender-1' });
  await page.locator('[role=dialog]').evaluate(root => root.insertAdjacentHTML('beforeend', '<button onclick="const row=document.createElement(\'div\');row.dataset.e2e=\'message-item\';row.textContent=this.parentElement.querySelector(\'textarea\').value;this.parentElement.append(row)">发送</button>'));
  advanceIdentityNavigation(t, adapter);
  const before = state.requests.length; let checkpoints = 0;
  const sent = await adapter.send({ ...conversationInput, message: '仅用于隔离测试' }, { beforeDispatch: async () => { checkpoints++; } });
  assert.equal(sent.outcome, 'submitted');
  assert.equal(checkpoints, 1);
  assert.deepEqual(state.requests.slice(before), ['/user/sender-1']);
});

browserTest('a server account switch after draft entry blocks the final send checkpoint', async t => {
  for (const owner of ['missing', 'changed']) {
    const { adapter, page, state } = await fixture(t, { conversation: true });
    await adapter.accountStatus({ expectedAccountId: 'sender-1' });
    await page.locator('[role=dialog]').evaluate(root => root.insertAdjacentHTML('beforeend', '<button>发送</button>'));
    adapter.lastIdentityNavigationAt = Date.now() - 61000;
    let checkpoints = 0;
    await assert.rejects(adapter.send({ ...conversationInput, message: '未授权发送的隔离测试草稿' }, {
      renewBeforeDispatch: async () => { state.canonical = owner === 'missing' ? ownProfile(handle, false) : ownProfile('another_owner'); },
      beforeDispatch: async () => { checkpoints++; },
    }), error => error.code === (owner === 'missing' ? 'ACCOUNT_VERIFICATION_PENDING' : 'ACCOUNT_CHANGED'));
    assert.equal(checkpoints, 0);
  }
});

browserTest('a same-handle SELF alias remains passive for reads while dispatch still refreshes its canonical', async t => {
  const { adapter, page, state } = await fixture(t, { conversation: true });
  await adapter.accountStatus({ expectedAccountId: 'sender-1' });
  await adapter.identityPage.evaluate(() => history.replaceState({}, '', '/user/self'));
  adapter.passiveAccount.checkedAt -= 15001;
  const before = state.requests.length;
  assert.equal((await adapter.accountStatus({ passive: true, expectedAccountId: 'sender-1' })).accountId, 'sender-1');
  assert.equal(state.requests.length, before);
  assert.equal((await adapter.readConversation(conversationInput)).messages[0].direction, 'inbound');
  assert.deepEqual(state.requests.slice(before), []);
  state.canonical = ownProfile(handle, false); state.self = ownProfile(handle, false);
  advanceIdentityNavigation(t, adapter);
  assert.equal((await adapter.verifiedSender(page, 'sender-1')).authenticated, false);
});

browserTest('missing post-read ownership is pending and retains the established identity hint', async t => {
  const { adapter, state } = await fixture(t, { conversation: true });
  await adapter.accountStatus({ expectedAccountId: 'sender-1' });
  const hint = { ...adapter.senderProof }, verifyTarget = adapter.verifyTarget.bind(adapter);
  adapter.verifyTarget = async (...args) => {
    await verifyTarget(...args);
    await adapter.identityPage.locator('[role=tab]').evaluate(node => node.remove());
    state.canonical = ownProfile(handle, false); state.self = ownProfile(handle, false);
  };
  await assert.rejects(adapter.readConversation(conversationInput), error => {
    assert.equal(error.code, 'ACCOUNT_VERIFICATION_PENDING');
    assert.equal(error.verificationPending, true);
    assert.equal(error.needsAccountVerification, true);
    assert.equal(error.verificationReason, 'owner_controls_timeout');
    return true;
  });
  assert.deepEqual(adapter.senderProof, hint);
});

browserTest('a strict temporary canonical failure preserves pending metadata and the established identity hint', async t => {
  const { adapter, page, state } = await fixture(t);
  await adapter.accountStatus({ expectedAccountId: 'sender-1' });
  const hint = { ...adapter.senderProof };
  state.canonical = ownProfile(handle, false); state.self = ownProfile(handle, false);
  advanceIdentityNavigation(t, adapter);
  const pending = await adapter.verifiedSender(page, 'sender-1');
  assert.equal(pending.authenticated, false);
  assert.equal(pending.verificationPending, true);
  assert.equal(pending.verificationReason, 'owner_controls_timeout');
  assert.deepEqual(adapter.senderProof, hint);
});

browserTest('fresh read ownership rejects a changed header or handle and explicit login before another identity navigation', async t => {
  for (const conflict of ['header', 'handle', 'login', 'captcha']) {
    const { adapter, state } = await fixture(t, { conversation: true });
    await adapter.accountStatus({ expectedAccountId: 'sender-1' });
    const before = state.requests.filter(path => path === '/user/sender-1').length;
    const verifyTarget = adapter.verifyTarget.bind(adapter);
    adapter.verifyTarget = async (...args) => {
      await verifyTarget(...args);
      if (conflict === 'header') await adapter.activePage.locator('header').first().evaluate(node => { node.innerHTML = '<a aria-label="我的主页" href="/user/sender-2">其他账号</a>'; });
      if (conflict === 'handle') await adapter.identityPage.locator('main span').evaluate(node => { node.textContent = '抖音号：changed_owner'; });
      if (conflict === 'login') await adapter.identityPage.locator('header').evaluate(node => { node.innerHTML = '<button>登录</button>'; });
      if (conflict === 'captcha') await adapter.identityPage.locator('main').evaluate(node => node.insertAdjacentHTML('beforeend', '<div data-e2e="captcha">安全验证</div>'));
    };
    await assert.rejects(adapter.readConversation(conversationInput), error => error.code === (conflict === 'login' ? 'UNAUTHENTICATED' : conflict === 'captcha' ? 'HUMAN_ACTION_REQUIRED' : 'ACCOUNT_CHANGED'));
    assert.equal(state.requests.filter(path => path === '/user/sender-1').length, before);
  }
});

browserTest('conversation identity DOM interruptions stay pending without erasing the established identity hint', async t => {
  const { adapter, state } = await fixture(t, { conversation: true });
  await adapter.accountStatus({ expectedAccountId: 'sender-1' });
  const hint = { ...adapter.senderProof }, identity = adapter.identityPage, before = state.requests.length;
  const currentAccount = adapter.currentAccount.bind(adapter);
  adapter.currentAccount = async page => {
    if (page === identity) throw Error('Execution context was destroyed');
    return currentAccount(page);
  };
  await assert.rejects(adapter.readConversation(conversationInput), error => {
    assert.equal(error.code, 'ACCOUNT_VERIFICATION_PENDING');
    assert.equal(error.verificationPending, true);
    assert.equal(error.needsAccountVerification, true);
    assert.equal(error.verificationReason, 'account_read_interrupted');
    return true;
  });
  assert.deepEqual(adapter.senderProof, hint);
  assert.deepEqual(state.requests.slice(before), []);
});

browserTest('strict sender DOM interruptions stay pending without erasing the established identity hint', async t => {
  const { adapter, page } = await fixture(t);
  await adapter.accountStatus({ expectedAccountId: 'sender-1' });
  const hint = { ...adapter.senderProof };
  adapter.currentAccount = async () => { throw Error('Execution context was destroyed'); };
  const pending = await adapter.verifiedSender(page, 'sender-1');
  assert.equal(pending.authenticated, false);
  assert.equal(pending.verificationPending, true);
  assert.equal(pending.verificationReason, 'account_read_interrupted');
  assert.deepEqual(adapter.senderProof, hint);
});

// All fixture requests stay inside the isolated, route-fulfilled browser context.
async function targetDispatchFixture(t, secondTarget = 'recipient-2') {
  const data = await fixture(t, { conversation: true });
  const { adapter, state } = data;
  await adapter.accountStatus({ expectedAccountId: conversationInput.senderAccountId });
  adapter.confirmationMs = 2000;
  for (const recipient of ['recipient-1', 'recipient-2']) {
    const proofTarget = recipient === 'recipient-2' ? secondTarget : recipient;
    state.profiles[`/user/${recipient}`] = `<main><section role="dialog" data-stack-layer="chat">
      <div class="StackLayoutStackChatHeaderuser"><div data-apm-action="个人页卡片" onclick="window.open('/user/${proofTarget}')">客户 ${recipient}</div></div>
      <div data-e2e="message-list"><div data-e2e="message-item" data-message-id="inbound-${recipient}" data-message-direction="incoming"><span data-e2e="message-text">想了解面积 ${recipient}</span></div></div>
      <div data-e2e="msg-input"><div contenteditable="true" oninput="window.__draftChanges++">保留的私信草稿</div><button class="e2e-send-msg-btn" onclick="sendFixtureMessage(this)">发送</button></div>
    </section></main><script>
      window.__sentMessages = []; window.__draftChanges = 0;
      function sendFixtureMessage(button) {
        const root = button.closest('section'), text = root.querySelector('[contenteditable]').innerText;
        window.__sentMessages.push(text);
        const row = document.createElement('div'); row.dataset.e2e = 'message-item';
        row.dataset.messageId = 'sent-' + window.__sentMessages.length; row.dataset.messageDirection = 'outgoing';
        const body = document.createElement('span'); body.dataset.e2e = 'message-text'; body.textContent = text;
        row.append(body); root.querySelector('[data-e2e="message-list"]').append(row);
      }
    </script>`;
  }
  const realNow = Date.now.bind(Date); let offset = 61000;
  t.mock.method(Date, 'now', () => realNow() + offset);
  const { readConversationTranscript } = await import('../tools/douyin-bridge/conversation-transcript.mjs');
  const prepare = async recipient => {
    const input = { ...conversationInput, recipientId: recipient, profileUrl: `https://www.douyin.com/user/${recipient}`, conversationId: `conversation-${recipient}`, actor: 'agent', message: `仅隔离测试 ${recipient}` };
    await adapter.navigate(input.profileUrl);
    // Set up the previously approved snapshot without spending a participant-proof budget.
    const observed = await readConversationTranscript(data.page.locator('[data-stack-layer="chat"]'), { ...input, timeoutMs: 1000 });
    assert.equal(observed.reliable, true);
    return { ...input, expectedSnapshotId: observed.snapshotId };
  };
  return { ...data, prepare, advance: ms => { offset += ms; } };
}

for (const method of ['send', 'reply']) for (const recentRead of [false, true]) {
  browserTest(`dispatch preflight: consecutive ${method} to two customers survives ${recentRead ? 'a just-completed A health proof' : 'the 61-second send interval'}`, async t => {
    const { adapter, page, state, prepare, advance } = await targetDispatchFixture(t);
    const first = await prepare('recipient-1'), checkpoints = [];
    const firstStartedAt = Date.now();
    const sentA = await adapter[method](first, { beforeDispatch: async () => { checkpoints.push(first.recipientId); } });
    assert.equal(sentA.outcome, 'submitted');
    assert.deepEqual(await page.evaluate(() => window.__sentMessages), [first.message]);
    advance(61000);
    assert.ok(Date.now() - firstStartedAt >= 61000, 'The next task has passed the server send interval');
    if (recentRead) {
      assert.equal((await adapter.readConversation(first)).reliable, true);
      assert.ok(Date.now() - adapter.lastTargetProofAttemptAt < 60000, 'A recent health proof must not block an eligible B dispatch');
    }
    const second = await prepare('recipient-2'), before = state.requests.length;
    const sentB = await adapter[method](second, { beforeDispatch: async () => { checkpoints.push(second.recipientId); } });
    assert.equal(sentB.outcome, 'submitted');
    assert.deepEqual(checkpoints, ['recipient-1', 'recipient-2']);
    assert.deepEqual(await page.evaluate(() => window.__sentMessages), [second.message]);
    assert.deepEqual(state.requests.slice(before), ['/user/recipient-2', '/user/sender-1', '/user/recipient-2'], 'B is proved before draft entry and again at strict dispatch, with one fresh owner check');
  });
}

for (const method of ['send', 'reply']) {
  browserTest(`dispatch preflight: ${method} reuses the current participant cache and retains strict verification`, async t => {
    const { adapter, page, state, prepare } = await targetDispatchFixture(t);
    const input = await prepare('recipient-1');
    assert.equal((await adapter.readConversation(input)).reliable, true);
    const before = state.requests.length; let checkpoints = 0;
    const result = await adapter[method](input, { beforeDispatch: async () => { checkpoints++; } });
    assert.equal(result.outcome, 'submitted');
    assert.equal(checkpoints, 1);
    assert.deepEqual(await page.evaluate(() => window.__sentMessages), [input.message]);
    assert.deepEqual(state.requests.slice(before), ['/user/sender-1', '/user/recipient-1'], 'A cache hit skips only the early participant popup');
  });

  browserTest(`dispatch preflight: a mismatched new ${method} target is checked before editing the draft`, async t => {
    const { adapter, page, state, prepare } = await targetDispatchFixture(t, 'someone-else');
    const first = await prepare('recipient-1');
    assert.equal((await adapter.readConversation(first)).reliable, true);
    const second = await prepare('recipient-2'), before = state.requests.length; let checkpoints = 0;
    await assert.rejects(adapter[method](second, { beforeDispatch: async () => { checkpoints++; } }), error => error.code === 'RECIPIENT_UNVERIFIED');
    assert.deepEqual(state.requests.slice(before), ['/user/someone-else'], 'Reject the actual wrong profile, rather than short-circuiting on a read cooldown');
    assert.equal(await page.locator('[contenteditable="true"]').innerText(), '保留的私信草稿');
    assert.equal(await page.evaluate(() => window.__draftChanges), 0);
    assert.deepEqual(await page.evaluate(() => window.__sentMessages), []);
    assert.equal(checkpoints, 0);
  });
}
