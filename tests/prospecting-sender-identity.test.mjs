import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DouyinBrowserAdapter } from '../tools/douyin-bridge/browser-adapter.mjs';

const browserTest = process.env.PROSPECT_BROWSER_TEST === '1' ? test : test.skip;
const handle = 'tenant_123';
const ownProfile = (value = handle, controls = true) => `<main><h1>同名账号</h1><span>抖音号：${value}</span>${controls ? '<button role="tab">私密作品</button><input placeholder="搜索你发布的作品">' : ''}</main>`;
const result = (id, value = handle) => `<a href="/user/${id}?from=search">同名账号 抖音号: ${value}\n10粉丝 20获赞</a>`;
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

browserTest('sender recovery requires an exact handle result and canonical owner controls without changing the chat', async t => {
  const { adapter, page } = await fixture(t);
  const account = await adapter.accountStatus();
  assert.equal(account.authenticated, true);
  assert.equal(account.accountId, 'sender-1');
  assert.equal(account.verifiedReadOnlyAccountId, `dy-readonly-${createHash('sha256').update(handle).digest('hex').slice(0, 24)}`);
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
  const recovered = await adapter.recoverAccountStatus({ expectedAccountId: 'sender-1' });
  assert.equal(recovered.accountId, 'sender-1'); assert.equal(recovered.authenticated, true);
  assert.deepEqual(state.requests.slice(before), ['/user/sender-1']);
  assert.equal(await page.locator('textarea').inputValue(), '保留的私信草稿');
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
  const recovered = await adapter.recoverAccountStatus({ expectedAccountId: 'sender-1' });
  assert.equal(recovered.authenticated, false); assert.equal(recovered.verificationPending, true);
  assert.equal(recovered.needsAccountVerification, true); assert.equal(recovered.verificationReason, 'owner_proof_missing');
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

browserTest('conversation reads reject a server-side account switch hidden by stale owner DOM at either read boundary', async t => {
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
    await assert.rejects(adapter.readConversation(conversationInput), error => {
      assert.equal(error.code, conflict === 'missing-owner' ? 'ACCOUNT_VERIFICATION_PENDING' : 'ACCOUNT_CHANGED');
      if (conflict === 'missing-owner') {
        assert.equal(error.verificationPending, true);
        assert.equal(error.verificationReason, 'owner_proof_missing');
      }
      return true;
    });
    assert.equal(adapter.identityPage, identity);
    assert.deepEqual(state.requests.slice(before), boundary === 'before'
      ? ['/user/recipient-1', '/user/sender-1']
      : ['/user/recipient-1', '/user/sender-1', '/user/sender-1']);
    assert.deepEqual(adapter.senderProof, hint);
    assert.equal(await page.locator('textarea').inputValue(), '保留的私信草稿');
  }
});

browserTest('healthy conversation reads verify both boundaries on the same canonical identity tab without rediscovery', async t => {
  const { adapter, page, state } = await fixture(t, { conversation: true });
  await adapter.accountStatus({ expectedAccountId: 'sender-1' });
  const before = state.requests.length, identity = adapter.identityPage, pages = adapter.context.pages().length;
  const observed = await adapter.readConversation(conversationInput);
  assert.equal(observed.messages[0].text, '想了解面积');
  assert.equal(observed.reliable, true);
  assert.deepEqual(state.requests.slice(before), ['/user/recipient-1', '/user/sender-1', '/user/sender-1']);
  assert.equal(adapter.identityPage, identity);
  assert.equal(adapter.context.pages().length, pages);
  assert.equal(page.url(), 'https://www.douyin.com/user/recipient-1');
  assert.equal(await page.locator('textarea').inputValue(), '保留的私信草稿');
});

browserTest('a same-handle SELF alias stays passive while conversation reads refresh the established canonical', async t => {
  const { adapter, page, state } = await fixture(t, { conversation: true });
  await adapter.accountStatus({ expectedAccountId: 'sender-1' });
  await adapter.identityPage.evaluate(() => history.replaceState({}, '', '/user/self'));
  adapter.passiveAccount.checkedAt -= 15001;
  const before = state.requests.length;
  assert.equal((await adapter.accountStatus({ passive: true, expectedAccountId: 'sender-1' })).accountId, 'sender-1');
  assert.equal(state.requests.length, before);
  assert.equal((await adapter.readConversation(conversationInput)).messages[0].direction, 'inbound');
  assert.deepEqual(state.requests.slice(before), ['/user/recipient-1', '/user/sender-1', '/user/sender-1']);
  state.canonical = ownProfile(handle, false); state.self = ownProfile(handle, false);
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
    assert.equal(error.verificationReason, 'owner_proof_missing');
    return true;
  });
  assert.deepEqual(adapter.senderProof, hint);
});

browserTest('a strict temporary canonical failure preserves pending metadata and the established identity hint', async t => {
  const { adapter, page, state } = await fixture(t);
  await adapter.accountStatus({ expectedAccountId: 'sender-1' });
  const hint = { ...adapter.senderProof };
  state.canonical = ownProfile(handle, false); state.self = ownProfile(handle, false);
  const pending = await adapter.verifiedSender(page, 'sender-1');
  assert.equal(pending.authenticated, false);
  assert.equal(pending.verificationPending, true);
  assert.equal(pending.verificationReason, 'owner_proof_missing');
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
    assert.equal(state.requests.filter(path => path === '/user/sender-1').length, before + 1);
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
  assert.deepEqual(state.requests.slice(before), ['/user/recipient-1', '/user/sender-1']);
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
