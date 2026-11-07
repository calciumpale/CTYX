import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DouyinBrowserAdapter } from '../tools/douyin-bridge/browser-adapter.mjs';

const browserTest = process.env.PROSPECT_BROWSER_TEST === '1' ? test : test.skip;
const handle = 'tenant_123';
const ownProfile = (value = handle, controls = true) => `<main><h1>同名账号</h1><span>抖音号：${value}</span>${controls ? '<button role="tab">私密作品</button><input placeholder="搜索你发布的作品">' : ''}</main>`;
const result = (id, value = handle) => `<a href="/user/${id}?from=search">同名账号 抖音号: ${value}\n10粉丝 20获赞</a>`;
async function fixture(t, { search = result('other-user', `${handle}_other`) + result('sender-1'), canonical = ownProfile(), self = ownProfile() } = {}) {
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

browserTest('passive identity reuse avoids navigation for 15 seconds but fresh checks and expiry revalidate ownership', async t => {
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
  assert.equal(count(), initial + 3);
});

browserTest('a conflicting or ambiguous current header invalidates passive identity reuse', async t => {
  const { adapter, page, state } = await fixture(t);
  const options = { expectedAccountId: 'sender-1', passive: true };
  await adapter.accountStatus({ expectedAccountId: 'sender-1' });
  await page.locator('header').evaluate(node => { node.innerHTML = '<a aria-label="我的主页" href="/user/sender-2">其他账号</a>'; });
  assert.equal((await adapter.accountStatus(options)).accountId, 'sender-2');
  await page.locator('header').evaluate(node => { node.innerHTML = '<a aria-label="我的主页" href="/user/self">我</a>'; });
  const count = state.requests.length;
  await adapter.accountStatus(options); assert.equal(state.requests.length, count + 1);
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

browserTest('closing the verified identity page invalidates reuse and a failed fresh navigation remains pending', async t => {
  const { adapter, state } = await fixture(t);
  const options = { expectedAccountId: 'sender-1', passive: true };
  await adapter.accountStatus({ expectedAccountId: 'sender-1' });
  await adapter.identityPage.close();
  const count = state.requests.length;
  assert.equal((await adapter.accountStatus(options)).accountId, 'sender-1');
  assert.equal(state.requests.length, count + 1);
  state.failCanonical = true;
  const result = await adapter.accountStatus({ expectedAccountId: 'sender-1' });
  assert.equal(result.authenticated, false); assert.equal(result.verificationPending, true); assert.equal(result.accountId, undefined);
});
