import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { BridgeError, checkAbort, profileIdentity, videoIdentity } from './bridge-core.mjs';
import { inspectRetryTranscript } from './retry-transcript.mjs';
import { readConversationTranscript } from './conversation-transcript.mjs';

const HOME = 'https://www.douyin.com/';
const SELF = `${HOME}user/self`;
const READ_ONLY_ACCOUNT = /^dy-readonly-[a-f0-9]{24}$/;
const canonicalAccount = value => typeof value === 'string' && /^[a-zA-Z0-9_.-]{5,140}$/.test(value) && value !== 'self' && !value.startsWith('dy-readonly-');
const PASSIVE_ACCOUNT_TTL_MS = 15000;
const COMMENT_ROWS = '[data-e2e="comment-item"], [data-e2e="comment-level-1"], [data-e2e="comment-level-2"], .comment-item';
const STACK_CHAT = '[data-e2e="im-dialog"] [data-stack-layer="chat"]';
const CHAT_ROOTS = `${STACK_CHAT}, [role="dialog"], [data-e2e="im-chat"], [data-e2e="chat-container"], [data-e2e="message-panel"], [class*="chat-room"]`;
const COMPOSER = 'textarea, [contenteditable="true"], [role="textbox"]';
const MESSAGE_ROWS = '[data-e2e="message-item"], [data-e2e="chat-message"], [data-e2e="im-message"], [class*="message-item"], .messageMessageListlist .messageMessageBoxmessageBox';
const fail = (message, code) => { throw new BridgeError(message, code); };
const digest = text => createHash('sha256').update(text).digest('hex').slice(0, 28);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function deriveKeywords(input) {
  const raw = input.keywords?.filter(value => typeof value === 'string' && value.trim());
  const terms = raw?.length ? raw : String(input.requirements || '').split(/[，,。；;\n]/).map(value => value.trim()).filter(value => value.length >= 2);
  const keywords = [...new Set(terms.map(value => value.trim().slice(0, 60)))].slice(0, 5);
  if (!keywords.length) fail('请提供产品或目标客群搜索词。', 'NO_KEYWORDS');
  return keywords;
}

/** Reads only rendered DOM and uses native visible controls; no request interception,
 * private endpoints, cookie extraction, page internals, or anti-challenge techniques. */
export class DouyinBrowserAdapter {
  constructor(context, { timeoutMs = 10000, confirmationMs = 12000, scrollDelayMs = 800, initialPage } = {}) {
    this.context = context; this.timeoutMs = timeoutMs; this.confirmationMs = confirmationMs; this.scrollDelayMs = scrollDelayMs;
    if (initialPage && context.pages().includes(initialPage) && !initialPage.isClosed() &&
        (initialPage.url() === 'about:blank' || /^https:\/\/(?:www\.)?douyin\.com\//.test(initialPage.url()))) {
      this.activePage = initialPage; initialPage.setDefaultTimeout(timeoutMs);
    }
  }
  async page() {
    if (!this.activePage || this.activePage.isClosed()) { this.activePage = await this.context.newPage(); this.activePage.setDefaultTimeout(this.timeoutMs); }
    return this.activePage;
  }
  async navigate(url, signal) {
    checkAbort(signal); const page = await this.page();
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch { fail('页面打开失败，请检查网络和浏览器。', 'NAVIGATION'); }
    if (!['www.douyin.com', 'douyin.com'].includes(new URL(page.url()).hostname)) fail('页面跳转到非抖音域名，已停止。', 'UNEXPECTED_ORIGIN');
    await this.guard(page, signal); return page;
  }
  async guard(page, signal) {
    checkAbort(signal);
    const blocked = await page.evaluate(() => {
      const visible = node => node instanceof HTMLElement && !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length) && getComputedStyle(node).visibility !== 'hidden';
      if (/验证码中间页|安全验证|访问验证/.test(document.title)) return true;
      if ([...document.querySelectorAll('[id*="captcha"], [class*="captcha-verify"], [data-e2e="captcha"]')].some(visible)) return true;
      return [...document.querySelectorAll('[role="dialog"], body > div')].filter(visible).some(node => /请完成安全验证|拖动滑块完成验证|请通过以下验证|向右拖动滑块/.test(node.innerText));
    });
    if (blocked) fail('抖音要求安全验证，请在专用浏览器手动完成后重新发起任务。', 'HUMAN_ACTION_REQUIRED');
  }
  async currentAccount(page) {
    return page.evaluate(() => {
      const visible = node => node instanceof HTMLElement && !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length) && getComputedStyle(node).visibility !== 'hidden';
      const links = [...document.querySelectorAll('header a[href*="/user/"], [data-e2e="douyin-header"] a[href*="/user/"], [data-e2e="header-avatar"] a[href*="/user/"], a[aria-label="我的主页"], a[aria-label="个人主页"]')].filter(visible);
      const identities = links.filter(link => /我的主页|个人主页|我的抖音/.test(`${link.getAttribute('aria-label') || ''} ${link.getAttribute('title') || ''} ${link.innerText}`) || link.closest('[data-e2e="header-avatar"]'));
      const accounts = new Map();
      for (const link of identities) {
        const url = new URL(link.getAttribute('href'), location.origin);
        const match = /^\/user\/([a-zA-Z0-9_.-]{5,140})\/?$/.exec(url.pathname);
        if (['www.douyin.com', 'douyin.com'].includes(url.hostname) && match && match[1] !== 'self') accounts.set(match[1], { authenticated: true, accountId: match[1], accountName: (link.querySelector('img')?.alt || link.innerText || '已登录账号').trim().slice(0, 100) });
      }
      const hasSelfLink = [...document.querySelectorAll('a[href*="/user/self"]')].filter(visible).some(link => {
        const url = new URL(link.getAttribute('href'), location.origin);
        return url.protocol === 'https:' && ['www.douyin.com', 'douyin.com'].includes(url.hostname) && !url.port && /^\/user\/self\/?$/.test(url.pathname);
      });
      return accounts.size === 1 ? [...accounts.values()][0] : { authenticated: false, hasSelfLink, ...(accounts.size > 1 ? { ambiguous: true } : {}), message: '未能从页面核实当前账号，请完成登录并打开顶部个人主页菜单。' };
    });
  }
  async loginRequired(page) {
    return page.evaluate(() => {
      const visible = node => node instanceof HTMLElement && !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length) && getComputedStyle(node).visibility !== 'hidden';
      const controls = document.querySelectorAll('header button, header [role="button"], header a, [data-e2e="douyin-header"] button, [data-e2e="douyin-header"] [role="button"], [data-e2e="login-button"], [role="dialog"] button');
      return [...controls].some(node => visible(node) && /^(?:登录|登录[\/／]?注册|立即登录|扫码登录)$/.test(node.innerText.trim().replace(/\s+/g, '')));
    });
  }
  async ownProfileProof(page, signal, expectedId) {
    const url = new URL(page.url());
    const profile = /^\/user\/([a-zA-Z0-9_.-]{4,140})\/?$/.exec(url.pathname);
    if (url.protocol !== 'https:' || !['www.douyin.com', 'douyin.com'].includes(url.hostname) || url.port || url.username || url.password || !profile || expectedId && profile[1] !== expectedId) return null;
    const privateTab = page.getByRole('tab', { name: /^私密作品(?:\s*\d+)?$/ }).first();
    const ownWorks = page.getByPlaceholder('搜索你发布的作品', { exact: true })
      .or(page.getByRole('textbox', { name: '搜索你发布的作品', exact: true })).first();
    try {
      await privateTab.waitFor({ state: 'visible', timeout: this.timeoutMs });
      await ownWorks.waitFor({ state: 'visible', timeout: Math.min(this.timeoutMs, 2000) });
    } catch { await this.guard(page, signal); return null; }
    // Owner controls can render before the profile handle hydrates. Wait only
    // for missing evidence; a conflicting label or changed page fails at once.
    const deadline = Date.now() + this.timeoutMs;
    do {
      await this.guard(page, signal);
      if (!await privateTab.isVisible() || !await ownWorks.isVisible()) return null;
      const proof = await page.evaluate(expectedPath => {
        if (location.protocol !== 'https:' || !['www.douyin.com', 'douyin.com'].includes(location.hostname) ||
            location.pathname !== expectedPath || location.port) return null;
        const labels = [...document.body.innerText.matchAll(/抖音号[：:][\t \n]*([A-Za-z0-9_][A-Za-z0-9_.-]{0,63})(?![A-Za-z0-9_.-])/g)];
        if (!labels.length) return { pending: true };
        if (labels.length !== 1) return null;
        return { handle: labels[0][1], name: document.querySelector('h1')?.innerText.trim().slice(0, 100) };
      }, url.pathname);
      if (!proof?.pending) return proof;
      if (Date.now() < deadline) await sleep(100);
    } while (Date.now() < deadline);
    return null;
  }
  async identityNavigate(url, signal) {
    checkAbort(signal);
    // Keep account verification on a separate page so it cannot replace a chat or draft.
    if (!this.identityPage || this.identityPage.isClosed()) {
      this.identityPage = await this.context.newPage(); this.identityPage.setDefaultTimeout(this.timeoutMs);
    }
    try { await this.identityPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
    catch { checkAbort(signal); fail('本人身份核验页面打开失败。', 'NAVIGATION'); }
    const current = new URL(this.identityPage.url());
    if (current.protocol !== 'https:' || !['www.douyin.com', 'douyin.com'].includes(current.hostname) || current.port) fail('身份核验页面跳转到非抖音地址。', 'UNEXPECTED_ORIGIN');
    await this.guard(this.identityPage, signal); return this.identityPage;
  }
  async recoverOwnAccount(signal, { allowReadOnly = true, expectedAccountId } = {}) {
    const missing = { authenticated: false, message: '未能从本人主页核实可发送身份，请检查当前登录账号。' };
    const pending = { ...missing, verificationPending: true };
    const previous = this.senderProof;
    const candidateId = canonicalAccount(expectedAccountId) ? expectedAccountId : previous?.accountId;
    this.passiveAccount = undefined;
    let fallback = missing;
    const verified = proof => {
      const account = { authenticated: true, accountId: proof.accountId, accountName: proof.accountName,
        verifiedReadOnlyAccountId: `dy-readonly-${digest(proof.handle).slice(0, 24)}` };
      this.passiveAccount = { account, handle: proof.handle, checkedAt: Date.now(), context: this.context, page: this.activePage, identityPage: this.identityPage };
      return account;
    };
    const readOnlyFallback = async () => {
      if (!allowReadOnly || !fallback.authenticated) return allowReadOnly ? fallback : pending;
      // Discovery may have used the identity tab for search. Leave it on the
      // proved self profile so subsequent health checks only have to read DOM.
      const page = await this.identityNavigate(SELF, signal);
      const proof = await this.ownProfileProof(page, signal);
      if (!proof || `dy-readonly-${digest(proof.handle).slice(0, 24)}` !== fallback.accountId) return pending;
      this.passiveAccount = { account: fallback, handle: proof.handle, checkedAt: Date.now(), context: this.context, page: this.activePage, identityPage: this.identityPage };
      return fallback;
    };
    try {
      if (candidateId) {
        const page = await this.identityNavigate(`${HOME}user/${candidateId}`, signal);
        const current = await this.ownProfileProof(page, signal, candidateId);
        if (current && (previous?.accountId !== candidateId || current.handle === previous.handle)) {
          this.senderProof = { accountId: candidateId, handle: current.handle, accountName: current.name || previous?.accountName || '已登录抖音账号' };
          return verified(this.senderProof);
        }
        this.senderProof = undefined;
      }
      const ownPage = await this.identityNavigate(SELF, signal);
      const own = await this.ownProfileProof(ownPage, signal);
      if (!own) return pending;
      if (candidateId && previous?.accountId === candidateId && previous.handle === own.handle) return pending;
      // A visible /self handle can support rediscovery, but its readonly alias
      // must never replace a device's already bound canonical sender identity.
      fallback = candidateId ? pending : { authenticated: true, accountId: `dy-readonly-${digest(own.handle).slice(0, 24)}`, accountName: own.name || '已登录抖音账号' };
      let canonical;
      if (!/^\/user\/self\/?$/.test(new URL(ownPage.url()).pathname)) canonical = profileIdentity(ownPage.url());
      else {
        const search = await this.identityNavigate(`${HOME}search/${encodeURIComponent(own.handle)}?type=user`, signal);
        const deadline = Date.now() + this.timeoutMs;
        do {
          await this.guard(search, signal);
          const matches = await search.locator('a[href*="/user/"]').evaluateAll((links, handle) => {
            const visible = node => node instanceof HTMLElement && !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length) && getComputedStyle(node).visibility !== 'hidden';
            const exactHandle = node => {
              if (!visible(node)) return false;
              const labels = [...node.innerText.matchAll(/抖音号\s*[：:]\s*([A-Za-z0-9_][A-Za-z0-9_.-]{0,63})(?![A-Za-z0-9_.-])/g)];
              return labels.length === 1 && labels[0][1] === handle;
            };
            // Search cards can render the handle and counts as adjacent inline fields.
            return links.filter(visible).filter(link =>
              exactHandle(link) || [...link.querySelectorAll('span, div, p')].some(exactHandle)
            ).map(link => link.href);
          }, own.handle);
          const candidates = new Map();
          for (const href of matches) { try { const candidate = profileIdentity(href); if (candidate.id !== 'self') candidates.set(candidate.id, candidate); } catch { /* Only valid public profile URLs prove identity. */ } }
          if (candidates.size > 1) return await readOnlyFallback();
          if (candidates.size === 1) { canonical = [...candidates.values()][0]; break; }
          if (Date.now() < deadline) await sleep(150);
        } while (Date.now() < deadline);
        if (!canonical) return await readOnlyFallback();
        const profilePage = await this.identityNavigate(canonical.url, signal);
        const candidateProof = await this.ownProfileProof(profilePage, signal, canonical.id);
        if (!candidateProof) return await readOnlyFallback();
        if (candidateProof.handle !== own.handle) return allowReadOnly ? await readOnlyFallback() : missing;
      }
      this.senderProof = { accountId: canonical.id, handle: own.handle, accountName: own.name || '已登录抖音账号' };
      return verified(this.senderProof);
    } catch (error) {
      this.senderProof = undefined;
      if (error?.code === 'HUMAN_ACTION_REQUIRED' || signal?.aborted) throw error;
      if (error?.code === 'NAVIGATION') return pending;
      return allowReadOnly ? fallback : missing;
    }
  }
  async verifiedSender(page, expectedId, signal) {
    this.passiveAccount = undefined;
    await this.guard(page, signal);
    const header = await this.currentAccount(page);
    if (header.ambiguous) return { authenticated: false, message: '页面显示多个当前账号，发送身份未通过核验。' };
    if (header.authenticated && header.accountId !== expectedId) return { authenticated: false, message: '当前登录账号与任务账号不一致。' };
    // Cached recovery is never sufficient on its own: reload owner controls before every send check.
    const account = header.authenticated && !this.senderProof ? header : await this.recoverOwnAccount(signal, { allowReadOnly: false, expectedAccountId: expectedId });
    return account.authenticated && account.accountId === expectedId ? account : { authenticated: false, message: '当前登录账号的发送身份未通过核验。' };
  }
  async accountStatus({ signal, allowReadOnly = true, expectedAccountId, passive = false } = {}) {
    if (passive) {
      try { return await this.passiveAccountStatus({ signal, allowReadOnly, expectedAccountId }); }
      catch (error) {
        checkAbort(signal);
        if (error?.code === 'HUMAN_ACTION_REQUIRED') throw error;
        return { authenticated: false, ...(this.activePage && !this.activePage.isClosed() ? { verificationPending: true } : {}), message: '暂未读取到账号状态，请等待页面恢复；本轮不领取任务。' };
      }
    }
    const page = await this.page(); if (!/^https:\/\/(?:www\.)?douyin\.com\//.test(page.url())) await this.navigate(HOME, signal);
    await this.guard(page, signal);
    let status = await this.currentAccount(page);
    const expected = canonicalAccount(expectedAccountId) ? expectedAccountId : this.senderProof?.accountId;
    if (status.ambiguous || status.authenticated && expected && status.accountId !== expected) {
      this.passiveAccount = undefined;
      return status.ambiguous ? { ...status, verificationPending: true } : status;
    }
    const recover = () => this.recoverOwnAccount(signal, { allowReadOnly, expectedAccountId });
    if (status.authenticated) return this.senderProof?.accountId === status.accountId ? recover() : status;
    if (expected || status.hasSelfLink || /\/user\/self\/?(?:[?#]|$)/.test(page.url())) return recover();
    if (!status.authenticated) {
      const avatars = page.locator('[data-e2e="header-avatar"], [data-e2e="douyin-header"] [aria-label="个人中心"], header [aria-label="个人中心"]');
      for (let i = 0; i < Math.min(await avatars.count(), 3); i++) if (await avatars.nth(i).isVisible()) { await avatars.nth(i).hover().catch(() => {}); break; }
      const deadline = Date.now() + Math.min(this.timeoutMs, 2000);
      while (!status.authenticated && Date.now() < deadline) { checkAbort(signal); await sleep(150); status = await this.currentAccount(page); }
    }
    if (!status.authenticated && (this.senderProof || status.hasSelfLink)) return recover();
    this.passiveAccount = undefined;
    return status;
  }
  async recoverAccountStatus({ signal, allowReadOnly = true, expectedAccountId } = {}) {
    checkAbort(signal);
    const pending = reason => ({ authenticated: false, verificationPending: true, needsAccountVerification: true, verificationReason: reason, message: '暂未核实当前账号，请等待页面恢复；本轮不领取任务。' });
    const page = this.activePage, identity = this.identityPage;
    // A bounded recovery may refresh only the identity tab that this session
    // already owns. Never reopen a tab the user closed or replace a chat/draft.
    if (!page || page.isClosed() || !/^https:\/\/(?:www\.)?douyin\.com\//.test(page.url())) return { authenticated: false, message: '抖音任务页面已关闭或离开，请点击“连接抖音”恢复。' };
    if (!identity || identity.isClosed() || !/^https:\/\/(?:www\.)?douyin\.com\//.test(identity.url())) return { authenticated: false, message: '身份核验页面已关闭或离开，请点击“连接抖音”恢复。' };
    const expected = canonicalAccount(expectedAccountId) ? expectedAccountId : this.senderProof?.accountId;
    if (!expected) return this.accountStatus({ signal, allowReadOnly, expectedAccountId, passive: true });
    try {
      await this.guard(page, signal); await this.guard(identity, signal);
      if (await this.loginRequired(page) || await this.loginRequired(identity)) return { authenticated: false, message: '抖音页面要求重新登录，请完成登录后点击“连接抖音”。' };
      const header = await this.currentAccount(page);
      if (header.ambiguous) return pending('account_ambiguous');
      if (header.authenticated && header.accountId !== expected) fail('当前登录账号与已配对账号不一致。', 'ACCOUNT_CHANGED');
      try { await identity.goto(`${HOME}user/${expected}`, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
      catch {
        checkAbort(signal);
        return identity.isClosed() ? { authenticated: false, message: '身份核验页面已关闭，请点击“连接抖音”恢复。' } : pending('navigation_failed');
      }
      if (!/^https:\/\/(?:www\.)?douyin\.com\//.test(identity.url())) return { authenticated: false, message: '身份核验页面已离开抖音，请点击“连接抖音”恢复。' };
      await this.guard(identity, signal);
      if (await this.loginRequired(identity)) return { authenticated: false, message: '抖音页面要求重新登录，请完成登录后点击“连接抖音”。' };
      const proof = await this.ownProfileProof(identity, signal, expected);
      if (!proof) return pending('owner_proof_missing');
      if (this.senderProof?.accountId === expected && proof.handle !== this.senderProof.handle) fail('当前登录账号的本人身份已变化，请重新确认。', 'ACCOUNT_CHANGED');
      await this.guard(page, signal);
      const latestHeader = await this.currentAccount(page);
      if (latestHeader.ambiguous) return pending('account_ambiguous');
      if (latestHeader.authenticated && latestHeader.accountId !== expected) fail('当前登录账号与已配对账号不一致。', 'ACCOUNT_CHANGED');
      this.senderProof = { accountId: expected, handle: proof.handle, accountName: proof.name || this.senderProof?.accountName || '已登录抖音账号' };
      const account = { authenticated: true, accountId: expected, accountName: this.senderProof.accountName, verifiedReadOnlyAccountId: `dy-readonly-${digest(proof.handle).slice(0, 24)}` };
      this.passiveAccount = { account, handle: proof.handle, checkedAt: Date.now(), context: this.context, page, identityPage: identity };
      return account;
    } catch (error) {
      checkAbort(signal);
      if (error?.code === 'HUMAN_ACTION_REQUIRED' || error?.code === 'ACCOUNT_CHANGED') throw error;
      return pending('account_read_interrupted');
    }
  }
  async passiveAccountStatus({ signal, allowReadOnly, expectedAccountId }) {
    checkAbort(signal);
    const pending = { authenticated: false, verificationPending: true, message: '暂未核实当前账号，正在等待页面恢复；本轮不领取任务。' };
    const page = this.activePage;
    // Health checks must not resurrect a tab or navigate away from a draft.
    if (!page || page.isClosed() || !/^https:\/\/(?:www\.)?douyin\.com\//.test(page.url())) return { authenticated: false, message: '抖音任务页面已关闭或离开，请点击“连接抖音”恢复。' };
    await this.guard(page, signal);
    if (await this.loginRequired(page)) return { authenticated: false, message: '抖音页面要求重新登录，请完成登录后点击“连接抖音”。' };
    const status = await this.currentAccount(page);
    const expected = canonicalAccount(expectedAccountId) ? expectedAccountId : this.senderProof?.accountId;
    if (status.ambiguous || status.authenticated && expected && status.accountId !== expected) {
      this.passiveAccount = undefined;
      return status.ambiguous ? { ...status, verificationPending: true } : status;
    }
    // A task/chat header may be absent while the independent owner tab remains
    // healthy. Missing navigation chrome alone is not evidence of logout.
    if (!status.authenticated && !status.hasSelfLink && !this.passiveAccount && !this.senderProof) return { ...pending, needsAccountVerification: true, verificationReason: 'task_header_missing' };
    let cached = this.passiveAccount;
    if (!cached && status.authenticated && !this.senderProof) return status;
    const identity = this.identityPage;
    if (!identity || identity.isClosed()) return { authenticated: false, message: '身份核验页面已关闭，请点击“连接抖音”恢复。' };
    await this.guard(identity, signal);
    if (await this.loginRequired(identity)) return { authenticated: false, message: '抖音页面要求重新登录，请完成登录后点击“连接抖音”。' };
    if (cached && (cached.context !== this.context || cached.page !== page || cached.identityPage !== identity)) cached = undefined;
    const account = cached?.account;
    const matched = account && (account.accountId === expectedAccountId || account.accountId === expected || !expectedAccountId && !expected);
    const age = cached ? Date.now() - cached.checkedAt : Infinity;
    if (matched && !allowReadOnly && READ_ONLY_ACCOUNT.test(account.accountId)) return pending;
    if (matched && age >= 0 && age < PASSIVE_ACCOUNT_TTL_MS) return { ...account };
    // Re-read visible ownership evidence after expiry; only an explicit connect
    // or a strict pre-send check may reload it. This is never send authorization.
    const candidate = matched ? account : this.senderProof && (!expected || this.senderProof.accountId === expected)
      ? { authenticated: true, accountId: this.senderProof.accountId, accountName: this.senderProof.accountName, verifiedReadOnlyAccountId: `dy-readonly-${digest(this.senderProof.handle).slice(0, 24)}` } : undefined;
    if (!candidate) {
      // Newly rendered owner controls can request a bounded recovery. This DOM
      // read stays passive; the controller owns whether another check may load.
      const newlySignedIn = !cached && !this.senderProof && await this.ownProfileProof(identity, signal);
      return newlySignedIn ? { ...pending, needsAccountVerification: true, verificationReason: 'owner_proof_missing' } : pending;
    }
    if (!allowReadOnly && READ_ONLY_ACCOUNT.test(candidate.accountId)) return pending;
    const proof = await this.ownProfileProof(identity, signal, READ_ONLY_ACCOUNT.test(candidate.accountId) ? 'self' : candidate.accountId);
    if (!proof || proof.handle !== (matched ? cached.handle : this.senderProof?.handle)) return { ...pending, needsAccountVerification: true, verificationReason: /^\/user\/self\/?$/.test(new URL(identity.url()).pathname) ? 'identity_route_changed' : 'owner_proof_missing' };
    this.passiveAccount = { account: candidate, handle: proof.handle, checkedAt: Date.now(), context: this.context, page, identityPage: identity };
    return { ...candidate };
  }
  async waitForContent(page, selector, signal) {
    try { await page.locator(selector).first().waitFor({ state: 'attached', timeout: this.timeoutMs }); }
    catch { await this.guard(page, signal); return false; }
    await this.guard(page, signal); return true;
  }
  async videoAuthor(video, signal) {
    const page = await this.navigate(video.url, signal);
    const deadline = Date.now() + this.timeoutMs;
    do {
      await this.guard(page, signal);
      try { if (videoIdentity(page.url()).id !== video.id) return null; } catch { return null; }
      const author = await page.evaluate(() => {
        const visible = node => node instanceof HTMLElement && !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length) && getComputedStyle(node).visibility !== 'hidden';
        const excluded = 'header, footer, nav, [role="navigation"], [role="contentinfo"], [data-e2e="comment-list"], [class*="comment-list"], [data-e2e="comment-item"], [class*="comment-item"]';
        const authors = new Map();
        const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(node => visible(node) && /^(关注|已关注|互相关注)$/.test((node.innerText || node.getAttribute('aria-label') || '').trim()));
        for (const button of buttons) {
          if (button.closest(excluded)) continue;
          let card = button.parentElement;
          for (let depth = 0; depth < 5 && card && card !== document.body; depth++, card = card.parentElement) {
            const content = card.innerText.trim();
            if (card.matches(excluded) || card.querySelector(excluded) || content.length > 1000 || /全部评论|推荐视频|相关视频/.test(content)) break;
            if (!/粉丝\s*[\d,.]+(?:\s*[万亿千wWkK])?/.test(content) || !/获赞\s*[\d,.]+(?:\s*[万亿千wWkK])?/.test(content)) continue;
            const profiles = new Map();
            for (const link of [...card.querySelectorAll('a[href*="/user/"]')].filter(visible)) {
              let url; try { url = new URL(link.getAttribute('href'), location.origin); } catch { continue; }
              const match = /^\/user\/([a-zA-Z0-9_.-]{5,140})\/?$/.exec(url.pathname);
              if (url.protocol !== 'https:' || !['www.douyin.com', 'douyin.com'].includes(url.hostname) || url.port || url.username || url.password || !match || match[1] === 'self') continue;
              const nickname = link.innerText.split('\n').map(part => part.trim()).filter(part => part && !/^(?:认证徽章|企业认证|个人认证|官方认证|抖音认证|已认证|认证|蓝V(?:认证)?)$/.test(part)).join(' ').slice(0, 100);
              const previous = profiles.get(match[1]);
              if (!previous || !previous.nickname) profiles.set(match[1], { profileUrl: `https://www.douyin.com/user/${match[1]}`, nickname, description: content.slice(0, 500) });
            }
            if (profiles.size === 1) {
              const [id, value] = [...profiles.entries()][0];
              if (value.nickname) authors.set(id, value);
            }
            break;
          }
        }
        return authors.size === 1 ? [...authors.values()][0] : null;
      });
      if (author) return author;
      if (Date.now() < deadline) await sleep(150);
    } while (Date.now() < deadline);
    return null;
  }
  async discover(input, { signal } = {}) {
    const groups = [], keywords = deriveKeywords(input), detailAuthors = new Map(); let sawVideoLinks = false;
    const detailBudget = Math.min(4, Math.floor(12 / keywords.length));
    for (const keyword of keywords) {
      const page = await this.navigate(`${HOME}search/${encodeURIComponent(keyword)}?type=video`, signal);
      const found = await this.waitForContent(page, 'a[href*="/video/"]', signal);
      if (!found) {
        if (/暂无搜索结果|没有找到相关/.test(await page.locator('body').innerText())) continue;
        fail('搜索结果尚未加载或页面结构变化，请检查浏览器后重试。', 'SEARCH_UNAVAILABLE');
      }
      sawVideoLinks = true;
      // Each query has its own extraction budget; an early broad query cannot
      // prevent later, more specific queries from contributing real results.
      const candidates = new Map(), unresolved = new Map();
      const addCandidate = (target, video, row) => {
        const candidate = candidates.get(target.id) || { id: target.id, nickname: row.nickname, profileUrl: target.url, description: row.description, reason: `搜索“${keyword}”发现的真实视频作者，待核实是否为竞品。`, videos: [] };
        if (!candidate.videos.some(item => item.id === video.id) && candidate.videos.length < 10) candidate.videos.push({ ...video, title: row.title });
        if (candidates.has(target.id) || candidates.size < 20) candidates.set(target.id, candidate);
      };
      for (let scroll = 0; scroll < 4 && candidates.size < 20; scroll++) {
        await this.guard(page, signal);
        const rows = await page.evaluate(() => {
          const visible = node => node instanceof HTMLElement && !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length) && getComputedStyle(node).visibility !== 'hidden';
          const rows = [];
          for (const video of [...document.querySelectorAll('a[href*="/video/"]')].filter(visible)) {
            if (video.closest('header, footer, nav, [role="navigation"], [role="contentinfo"]')) continue;
            let card = video.closest('article, li, [role="listitem"], [data-e2e="search-card"], [data-e2e="search-video-item"]');
            if (!card) { let node = video.parentElement; for (let i = 0; i < 6 && node && node !== document.body; i++, node = node.parentElement) { if (node.querySelector('a[href*="/user/"]')) { card = node; break; } } }
            const cardVideos = new Set(card ? [...card.querySelectorAll('a[href*="/video/"]')].filter(visible).map(link => { const url = new URL(link.getAttribute('href'), location.origin); return `${url.origin}${url.pathname}`; }) : []);
            const profiles = card && cardVideos.size === 1 ? [...card.querySelectorAll('a[href*="/user/"]')].filter(visible) : [];
            const unique = new Map(profiles.map(link => [new URL(link.getAttribute('href'), location.origin).pathname, link]));
            const author = unique.size === 1 ? [...unique.values()][0] : null;
            rows.push({ videoUrl: new URL(video.getAttribute('href'), location.origin).href, title: (video.getAttribute('title') || video.getAttribute('aria-label') || video.innerText || card?.innerText || '').trim().slice(0, 200), profileUrl: author ? new URL(author.getAttribute('href'), location.origin).href : '', nickname: (author?.innerText || author?.querySelector('img')?.alt || '').trim().slice(0, 100), description: (card?.innerText || video.innerText).trim().slice(0, 500) });
          }
          return rows;
        });
        for (const row of rows) {
          let target, video; try { video = videoIdentity(row.videoUrl); } catch { continue; }
          try { target = profileIdentity(row.profileUrl); } catch { /* Search cards may only expose a video link. */ }
          if (!target || !row.nickname) {
            if (unresolved.size < 20 && !unresolved.has(video.id)) unresolved.set(video.id, { video, row });
            continue;
          }
          unresolved.delete(video.id); addCandidate(target, video, row);
        }
        await page.mouse.wheel(0, 700); await sleep(this.scrollDelayMs);
      }
      // Leave the search page only after collecting its visible result links.
      // The shared cache and per-query budget keep detail visits bounded and fair.
      let detailVisits = 0;
      for (const { video, row } of unresolved.values()) {
        if (candidates.size >= 20) break;
        if (!detailAuthors.has(video.id)) {
          if (detailVisits >= detailBudget) continue;
          detailVisits++;
          detailAuthors.set(video.id, await this.videoAuthor(video, signal));
        }
        const author = detailAuthors.get(video.id);
        if (author) addCandidate(profileIdentity(author.profileUrl), video, { ...row, ...author });
      }
      groups.push([...candidates.values()]);
    }
    const candidates = new Map();
    // Interleave query ranks before applying the shared 20-account limit.
    // Duplicate authors still contribute their verified source videos.
    for (let rank = 0; rank < 20; rank++) for (const group of groups) {
      const candidate = group[rank]; if (!candidate) continue;
      const existing = candidates.get(candidate.id);
      if (existing) {
        for (const video of candidate.videos) if (existing.videos.length < 10 && !existing.videos.some(item => item.id === video.id)) existing.videos.push(video);
      } else if (candidates.size < 20) candidates.set(candidate.id, { ...candidate, videos: [...candidate.videos] });
    }
    if (!candidates.size && sawVideoLinks) fail('搜索页存在视频链接，但未能核实任何作者与来源视频。请检查页面是否加载完整；这不代表没有相关内容。', 'SEARCH_UNREADABLE');
    return { candidates: [...candidates.values()] };
  }
  async collect(input, { signal } = {}) {
    const comments = new Map(); const warnings = [], failures = [];
    const limit = Math.max(1, Math.min(50, Number(input.maxCommentsPerVideo) || 50));
    for (const video of input.videos) {
      if (comments.size >= 300) { warnings.push('已达到本次 300 条评论上限。'); break; }
      const source = videoIdentity(video.url);
      try {
      const page = await this.navigate(source.url, signal);
      let visible = await this.waitForContent(page, COMMENT_ROWS, signal);
      if (!visible) {
        const buttons = page.getByRole('button', { name: /^评论(?:\s*\d.*)?$/ });
        if (await buttons.count() === 1 && await buttons.isVisible()) { await buttons.click(); visible = await this.waitForContent(page, COMMENT_ROWS, signal); }
      }
      if (!visible) {
        if (/暂无评论|还没有评论/.test(await page.locator('body').innerText())) continue;
        fail('未找到可识别的评论列表，请手动展开评论后重试。', 'COMMENTS_UNAVAILABLE');
      }
      const videoComments = new Map(); let stagnant = 0;
      const bodyDeadline = Date.now() + this.timeoutMs;
      for (let scroll = 0; scroll < 12 && videoComments.size < limit && comments.size < 300; scroll++) {
        await this.guard(page, signal); const before = videoComments.size;
        const rows = await page.locator(COMMENT_ROWS).evaluateAll((elements, rowSelector) => {
          const visible = node => node instanceof HTMLElement && !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length) && getComputedStyle(node).visibility !== 'hidden';
          return elements.filter(visible).map(row => {
            const own = selector => [...row.querySelectorAll(selector)].filter(node => node.closest(rowSelector) === row && visible(node));
            const before = (left, right) => !!(left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING);
            const controls = 'button, [role="button"], input, textarea, script, style';
            const tokens = root => {
              const found = [];
              const visit = node => {
                if (node.nodeType === Node.TEXT_NODE) { if (node.textContent.trim()) found.push({ node, text: node.textContent }); return; }
                if (!(node instanceof HTMLElement) || !visible(node) || node.closest(rowSelector) !== row || node.matches(controls)) return;
                if (node instanceof HTMLImageElement) { if (node.alt.trim()) found.push({ node, text: node.alt }); return; }
                for (const child of node.childNodes) visit(child);
              };
              visit(root); return found;
            };
            const join = parts => parts.map(part => part.text).join('').replace(/\s+/g, ' ').trim();
            const info = own('.comment-item-info-wrap')[0], avatar = own('.comment-item-avatar')[0];
            const links = own('a[href*="/user/"]').filter(link => !info || info.contains(link) || avatar?.contains(link));
            const author = links.find(link => info?.contains(link) && link.innerText.trim()) || links[0];
            const label = author?.innerText?.trim() || author?.getAttribute('title') || author?.getAttribute('aria-label') || author?.querySelector('img')?.alt || '';
            let nickname = label.replace(/的?头像$/, '').trim();
            if (/^(?:头像|用户|个人主页|查看主页|点击.*主页)$/.test(nickname)) nickname = '';
            const timePattern = /^(?:刚刚|今天|昨天|前天|\d+\s*(?:秒|分钟|小时|天|周|个月|月|年)前|(?:\d{4}[-/.年])?\d{1,2}[-/.月]\d{1,2}日?)(?:\s+\d{1,2}:\d{2})?(?:\s*[·•]\s*[^\s·•]{1,20})?$/;
            const time = own('time')[0] || own('span, div, p').find(node => !node.children.length && timePattern.test(node.innerText.trim()));
            const explicit = own('[data-e2e="comment-content"], [data-e2e="comment-text"], [class*="comment-content"]')[0];
            let content = explicit ? join(tokens(explicit)) : '';
            if (!content && info && time) {
              let timeBlock = time;
              while (timeBlock.parentElement && timeBlock.parentElement !== info.parentElement && timeBlock !== row) timeBlock = timeBlock.parentElement;
              if (timeBlock.parentElement === info.parentElement && before(info, timeBlock)) {
                const bodies = []; let strayText = false;
                for (let sibling = info.nextSibling; sibling && sibling !== timeBlock; sibling = sibling.nextSibling) {
                  if (sibling.nodeType === Node.TEXT_NODE && sibling.textContent.trim()) strayText = true;
                  if (sibling instanceof HTMLElement && visible(sibling) && sibling.closest(rowSelector) === row && tokens(sibling).length) bodies.push(sibling);
                }
                if (!strayText && bodies.length === 1) content = join(tokens(bodies[0]));
              }
            }
            if (!content && !info && author && time && before(author, time)) {
              const parts = tokens(row).filter(part => before(author, part.node) && before(part.node, time) &&
                !author.contains(part.node) && !links.some(link => link.contains(part.node)) && !time.contains(part.node));
              let nameBlock, nameNode;
              if (nickname && parts[0]?.text.trim() === nickname) nameNode = parts[0].node;
              // A label without an avatar name is accepted only as a separate
              // leading sibling of a body block and a later timestamp block.
              if (!nickname && parts[0]?.node.nodeType === Node.TEXT_NODE) {
                let block = parts[0].node.parentElement;
                while (block?.parentElement && block.parentElement !== row && !block.parentElement.contains(time)) block = block.parentElement;
                const next = block?.nextElementSibling;
                const name = block?.innerText.trim() || '';
                if (block && next && block !== row && block.parentElement?.contains(time) && !block.contains(time) &&
                    ['DIV', 'P'].includes(next.tagName) && !next.contains(time) && before(next, time) &&
                    name === parts[0].text.trim() && name.length <= 100 && !/[。？！!?\n]/.test(name) &&
                    !block.querySelector('a, button, [role="button"], img')) { nickname = name; nameBlock = block; }
              }
              if (nickname) content = join(parts.filter(part => part.node !== nameNode && !nameBlock?.contains(part.node)));
            }
            const identities = new Set(links.map(link => new URL(link.getAttribute('href'), location.origin).href.split(/[?#]/)[0]));
            const authorEvidence = !info || avatar && links.some(link => info.contains(link)) && links.some(link => avatar.contains(link));
            return { nativeId: row.getAttribute('data-comment-id') || row.getAttribute('data-cid') || '', text: content, nickname,
              profileUrl: authorEvidence && identities.size === 1 && author ? new URL(author.getAttribute('href'), location.origin).href : '',
              postedAt: time?.getAttribute('datetime') || time?.innerText?.trim() || '' };
          });
        }, COMMENT_ROWS);
        for (const row of rows) {
          if (!row.text || row.text.length > 5000) continue;
          let target; try { target = profileIdentity(row.profileUrl); } catch { /* preserve anonymous source, never guess identity */ }
          const commentId = /^[a-zA-Z0-9_.:-]{1,140}$/.test(row.nativeId) ? row.nativeId : `dom:${digest(`${source.id}\n${target?.id || row.nickname}\n${row.text}\n${row.postedAt}`)}`;
          if (videoComments.has(commentId)) continue;
          if (videoComments.size >= limit || comments.size >= 300) break;
          const item = { id: commentId, videoId: source.id, videoUrl: source.url, text: row.text, nickname: row.nickname.slice(0, 100), ...(target ? { recipientId: target.id, profileUrl: target.url } : {}), ...(row.postedAt ? { postedAt: row.postedAt } : {}), source: 'browser' };
          videoComments.set(commentId, item); comments.set(commentId, item);
        }
        if (!videoComments.size && Date.now() < bodyDeadline) { await sleep(150); scroll--; continue; }
        stagnant = before === videoComments.size ? stagnant + 1 : 0;
        if (stagnant >= 2 || videoComments.size >= limit) break;
        await page.locator(COMMENT_ROWS).last().scrollIntoViewIfNeeded().catch(() => {});
        await page.evaluate(() => {
          const container = document.querySelector('[data-e2e="comment-list"], [class*="comment-list"]');
          if (container) container.scrollTop += Math.max(400, container.clientHeight); else window.scrollBy(0, 500);
        });
        await sleep(this.scrollDelayMs);
      }
      if (!videoComments.size) fail('评论行已显示，但正文结构无法安全识别；未将页面文字猜作评论。', 'COMMENTS_UNREADABLE');
      } catch (error) {
        if (!['COMMENTS_UNAVAILABLE', 'COMMENTS_UNREADABLE', 'NAVIGATION'].includes(error?.code)) throw error;
        failures.push(error); warnings.push(`视频 ${source.id}：${error.message}`);
      }
    }
    if (!comments.size && failures.length) fail(warnings.join('；').slice(0, 500), failures[0].code);
    return { comments: [...comments.values()], ...(warnings.length ? { warnings } : {}) };
  }
  async uniqueVisible(locator, message) {
    const visible = [];
    for (let i = 0; i < Math.min(await locator.count(), 100); i++) if (await locator.nth(i).isVisible()) visible.push(locator.nth(i));
    if (visible.length !== 1) fail(message, 'CONTROL_UNVERIFIED');
    return visible[0];
  }
  async verifyTarget(page, root, target, stackChat) {
    const message = '无法核对目标会话的用户主页，未发送。请打开该用户会话后检查页面结构。';
    if (stackChat) {
      // The current chat header opens the participant's actual profile in a new tab.
      const profileCard = await this.uniqueVisible(root.locator('.StackLayoutStackChatHeaderuser [data-apm-action="个人页卡片"]'), message);
      let profilePage;
      try {
        await Promise.all([
          page.waitForEvent('popup', { timeout: this.timeoutMs }).then(opened => { profilePage = opened; }),
          profileCard.click(),
        ]);
        await profilePage.waitForURL(url => url.href !== 'about:blank', { waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
        if (profileIdentity(profilePage.url()).id === target.id) return;
      } catch { /* An unavailable, invalid, or different profile cannot authorize a send. */ }
      finally { await profilePage?.close().catch(() => {}); }
      fail(message, 'RECIPIENT_UNVERIFIED');
    }
    const profiles = await root.locator('a[href*="/user/"]').evaluateAll(elements => elements.filter(node => node instanceof HTMLElement && !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length)).map(node => new URL(node.getAttribute('href'), location.origin).href));
    const ids = new Set(); for (const url of profiles) { try { ids.add(profileIdentity(url).id); } catch { /* not a usable identity */ } }
    if (ids.size !== 1 || !ids.has(target.id)) fail(message, 'RECIPIENT_UNVERIFIED');
  }
  async openConversation(input, { signal, writable = true } = {}) {
    if (READ_ONLY_ACCOUNT.test(input.senderAccountId)) fail('当前账号只完成了搜索身份核验，未验证可发送的主页身份。', 'SENDER_UNVERIFIED');
    const target = profileIdentity(input.profileUrl); if (target.id !== input.recipientId) fail('目标会话身份不一致。', 'INVALID_RECIPIENT');
    if (target.id === input.senderAccountId) fail('不能向当前登录账号发送获客私信。', 'INVALID_RECIPIENT');
    const page = await this.navigate(target.url, signal);
    if (profileIdentity(page.url()).id !== target.id) fail('打开的主页与审核时的收件人不同。', 'INVALID_RECIPIENT');
    const account = await this.verifiedSender(page, input.senderAccountId, signal);
    if (!account.authenticated || account.accountId !== input.senderAccountId) fail('当前登录账号与任务账号不一致，未发送。', 'ACCOUNT_CHANGED');
    const entry = page.getByRole('button', { name: /^(私信|发消息|发送私信)$/ });
    const entryError = '未找到唯一的私信入口，目标可能未开放私信。';
    try { await entry.filter({ visible: true }).first().waitFor({ state: 'visible', timeout: this.timeoutMs }); }
    catch { await this.guard(page, signal); fail(entryError, 'CONTROL_UNVERIFIED'); }
    const button = await this.uniqueVisible(entry, entryError);
    await button.click(); await this.guard(page, signal);
    const required = writable ? COMPOSER : '.messageMessageListwrapper, [data-e2e="message-list"]';
    const roots = page.locator(CHAT_ROOTS);
    const panel = roots.filter({ has: page.locator(required), visible: true }).first();
    try { await panel.waitFor({ state: 'visible', timeout: Math.min(3000, this.timeoutMs) }); }
    catch {
      await this.guard(page, signal);
      // The profile can expose its private-message button before it responds to
      // a click. Only retry the entry while no chat panel is visible.
      if (!await roots.filter({ visible: true }).count() && profileIdentity(page.url()).id === target.id) {
        const retry = await this.uniqueVisible(entry, entryError);
        await retry.click(); await this.guard(page, signal);
      }
      try { await panel.waitFor({ state: 'visible', timeout: this.timeoutMs }); }
      catch { await this.guard(page, signal); fail('会话面板未打开或需要人工操作，未发送。', 'CHAT_UNAVAILABLE'); }
    }
    // Remove outer dialog wrappers when an inner chat container is also matched.
    let root;
    for (let i = 0; i < await roots.count(); i++) {
      const candidate = roots.nth(i); if (!await candidate.isVisible()) continue;
      if (await candidate.locator(required).count()) {
        if (await candidate.locator(CHAT_ROOTS).count()) continue;
        if (root) fail('存在多个会话面板，未发送。', 'CHAT_AMBIGUOUS'); root = candidate;
      }
    }
    if (!root) fail('无法核对目标会话面板，未发送。', 'CHAT_UNAVAILABLE');
    const stackChat = await root.getAttribute('data-stack-layer') === 'chat';
    await this.verifyTarget(page, root, target, stackChat);
    return { page, root, target, stackChat };
  }
  async readConversation(input, { signal } = {}) {
    const { page, root, target, stackChat } = await this.openConversation(input, { signal, writable: false });
    const result = await readConversationTranscript(root, { ...input, signal, timeoutMs: this.timeoutMs, includeProof: true });
    const account = await this.verifiedSender(page, input.senderAccountId, signal);
    if (!account.authenticated) fail('读取会话期间登录账号发生变化。', 'ACCOUNT_CHANGED');
    await this.verifyTarget(page, root, target, stackChat);
    return result;
  }
  async reply(input, options = {}) {
    return this.send(input, { ...options, conversationReply: true });
  }
  async send(input, { signal, renewBeforeDispatch, beforeDispatch, conversationReply = false } = {}) {
    const { page, root, target, stackChat } = await this.openConversation(input, { signal });
    const verifyConversation = async () => {
      if (!conversationReply) return;
      const observed = await readConversationTranscript(root, { ...input, limit: 100, signal, timeoutMs: this.timeoutMs, includeProof: true });
      if (observed.snapshotId !== input.expectedSnapshotId) fail('会话内容已有变化，请同步最新消息并重新确认回复。', 'CONVERSATION_CHANGED');
      if (input.actor === 'agent' && !observed.reliable) fail('当前会话的消息方向或正文未能完整核实，请由人工接管。', 'CONVERSATION_UNREADABLE');
      if (input.actor === 'agent' && observed.messages.at(-1)?.direction !== 'inbound') fail('当前没有可核实的新来信，智能体未继续发送。', 'NO_INBOUND_MESSAGE');
      return observed;
    };
    await verifyConversation();
    const priorSubmission = async () => {
      if (!input.retry) return null;
      const history = await inspectRetryTranscript(root, { message: input.message, checkSince: input.retry.checkSince, timeoutMs: this.timeoutMs, signal });
      if (history.status === 'submitted') return { outcome: 'submitted', alreadySubmitted: true, evidence: history.evidence || '已在核对的会话中发现本人同文消息，本次没有再次发送。' };
      if (history.status !== 'clear') return { outcome: 'unknown', error: history.error || '未能确认原会话中没有相同消息，本次没有再次发送。' };
      return null;
    };
    const existing = await priorSubmission(); if (existing) return existing;
    const composer = await this.uniqueVisible(root.locator(stackChat ? '[data-e2e="msg-input"] [contenteditable="true"]' : COMPOSER), '未找到唯一消息输入框，未发送。');
    await composer.fill(input.message);
    const sendControl = stackChat ? root.locator('[data-e2e="msg-input"] .e2e-send-msg-btn') : root.getByRole('button', { name: /^发送$/ });
    const sendButton = await this.uniqueVisible(sendControl, '未找到唯一发送按钮，未发送。');
    if (!await sendButton.isEnabled()) fail('发送按钮不可用，请检查目标私信权限。', 'SEND_DISABLED');
    try { await sendButton.click({ trial: true, timeout: this.timeoutMs }); }
    catch { await this.guard(page, signal); fail('发送按钮不可操作，请检查对方的私信设置。', 'SEND_DISABLED'); }
    const matchedMessages = () => root.locator(MESSAGE_ROWS).evaluateAll((rows, { text, stackChat }) => {
      const visible = node => node instanceof HTMLElement && node.getClientRects().length > 0 && getComputedStyle(node).visibility === 'visible';
      const matches = node => visible(node) && node.innerText.trim() === text.trim();
      return rows.filter(row => visible(row) && (matches(row) || stackChat && [...row.querySelectorAll('div, span, p')].some(matches))).length;
    }, { text: input.message, stackChat });
    if (typeof beforeDispatch !== 'function') fail('缺少持久化发送记录，未发送。', 'NO_JOURNAL');
    await renewBeforeDispatch?.();
    const afterRenewal = await this.verifiedSender(page, input.senderAccountId, signal);
    if (!afterRenewal.authenticated || afterRenewal.accountId !== input.senderAccountId) fail('发送前账号发生变化，未发送。', 'ACCOUNT_CHANGED');
    await this.verifyTarget(page, root, target, stackChat);
    const dispatchSnapshot = await verifyConversation();
    const latest = await priorSubmission(); if (latest) return latest;
    const priorCount = conversationReply ? 0 : await matchedMessages();
    const priorProof = dispatchSnapshot?.proof;
    const priorMessageKeys = priorProof?.rowKeys ?? [];
    const latestMessageKey = priorMessageKeys.at(-1);
    if (conversationReply && !priorProof?.covered) fail('当前会话的最新记录未能核实，请重新同步后再回复。', 'CONVERSATION_UNREADABLE');
    const draftMatches = await composer.evaluate((node, message) => {
      if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) return node.value === message;
      const draft = node.innerText;
      if (draft === message) return true;
      if (node.getAttribute('data-slate-editor') !== 'true') return draft.replace(/\uFEFF/g, '') === message;
      // Slate appends invisible caret markers to the approved draft.
      return draft.startsWith(message) && /^[\u200B\uFEFF]+$/.test(draft.slice(message.length));
    }, input.message);
    if (!draftMatches) fail('私信输入框的文案与批准的内容不一致，未发送。', 'MESSAGE_CHANGED');
    await this.guard(page, signal);
    await beforeDispatch(conversationReply ? { conversation: { snapshotId: dispatchSnapshot.snapshotId, covered: priorProof.covered, priorMessageKeys, latestMessageKey } } : undefined);
    // A failed or interrupted click stays ambiguous after the durable checkpoint.
    let clicked = false;
    try {
      checkAbort(signal);
      await sendButton.click({ timeout: this.timeoutMs, noWaitAfter: true });
      clicked = true;
      const deadline = Date.now() + this.confirmationMs;
      while (Date.now() < deadline) {
        await this.guard(page, signal);
        if (conversationReply) {
          const observed = await readConversationTranscript(root, { ...input, limit: 100, signal, timeoutMs: Math.min(550, deadline - Date.now()), includeProof: true });
          const proof = observed.proof;
          const anchor = latestMessageKey ? proof?.rowKeys.indexOf(latestMessageKey) ?? -1 : -1;
          if (proof?.covered && (!latestMessageKey || anchor >= 0)) {
            const priorKeys = new Set(priorMessageKeys);
            const newRows = new Set(proof.rowKeys.slice(anchor + 1).filter(key => !priorKeys.has(key)));
            const confirmed = observed.messages.some(message => message.direction === 'outbound' &&
              message.text === input.message.trim() && newRows.has(proof.messageKeys[message.id]));
            if (confirmed) return { outcome: 'submitted', evidence: '已核对到本次点击后新增的本人同文消息，未验证送达或已读。' };
          }
          await sleep(150);
          continue;
        }
        const text = await root.innerText();
        if (/发送失败|消息未发送|消息发送失败|请勿频繁|无法发送|暂时无法发送/.test(text)) return { outcome: 'unknown', error: '点击后页面提示发送异常，请核对会话；不会重发。' };
        if (await matchedMessages() > priorCount && !/发送中/.test(text)) return { outcome: 'submitted', evidence: '已在核对过用户主页的会话中单次点击发送，并观察到新增同文消息；不代表送达或已读。' };
        await sleep(150);
      }
    } catch {
      return { outcome: 'unknown', error: clicked ? '已点击发送，核对新消息时页面中断；请查看原会话。' : '发送按钮操作中断，无法确认提交结果；请查看原会话。' };
    }
    return { outcome: 'unknown', error: '已尝试一次发送，但未观察到可确认的新消息；请核对原会话，不会重发。' };
  }
}

export async function openBrowser(config, profileDir) {
  let chromium; try { ({ chromium } = await import('playwright')); } catch { fail('请先在 tools/douyin-bridge 安装本地 Playwright 依赖。', 'BROWSER_MISSING'); }
  if (config.cdpUrl) {
    const browser = await chromium.connectOverCDP(config.cdpUrl);
    const context = browser.contexts()[0]; if (!context) { await browser.close(); fail('CDP 没有可用浏览器上下文。', 'BROWSER_MISSING'); }
    const adapter = new DouyinBrowserAdapter(context);
    return { adapter, close: async () => {
      await adapter.identityPage?.close().catch(() => {});
      await adapter.activePage?.close().catch(() => {});
      await browser.close();
    } };
  }
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  let context; try { context = await chromium.launchPersistentContext(profileDir, { headless: false, viewport: { width: 1320, height: 900 } }); }
  catch { fail('无法启动专用浏览器，请安装 Chromium 并确认没有其他执行器占用。', 'BROWSER_MISSING'); }
  // This context belongs only to the pairing's dedicated profile. Never adopt
  // an arbitrary page from a user's CDP browser (the explicit-CDP path above).
  const initialPage = context.pages().find(page => !page.isClosed() && (page.url() === 'about:blank' || /^https:\/\/(?:www\.)?douyin\.com\//.test(page.url())));
  return { adapter: new DouyinBrowserAdapter(context, { initialPage }), close: () => context.close() };
}
