import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { BridgeError, checkAbort, profileIdentity, videoIdentity } from './bridge-core.mjs';

const HOME = 'https://www.douyin.com/';
const COMMENT_ROWS = '[data-e2e="comment-item"], [data-e2e="comment-level-1"], [data-e2e="comment-level-2"], [class*="comment-item"]';
const CHAT_ROOTS = '[role="dialog"], [data-e2e="im-chat"], [data-e2e="chat-container"], [data-e2e="message-panel"], [class*="chat-room"]';
const MESSAGE_ROWS = '[data-e2e="message-item"], [data-e2e="chat-message"], [data-e2e="im-message"], [class*="message-item"]';
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
  constructor(context, { timeoutMs = 10000, confirmationMs = 12000, scrollDelayMs = 800 } = {}) {
    this.context = context; this.timeoutMs = timeoutMs; this.confirmationMs = confirmationMs; this.scrollDelayMs = scrollDelayMs;
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
      return accounts.size === 1 ? [...accounts.values()][0] : { authenticated: false, message: '未能从页面核实当前账号，请完成登录并打开顶部个人主页菜单。' };
    });
  }
  async accountStatus({ signal } = {}) {
    const page = await this.page(); if (!page.url().startsWith(HOME)) await this.navigate(HOME, signal);
    await this.guard(page, signal);
    let status = await this.currentAccount(page);
    if (!status.authenticated) {
      const avatars = page.locator('[data-e2e="header-avatar"], [data-e2e="douyin-header"] [aria-label="个人中心"], header [aria-label="个人中心"]');
      for (let i = 0; i < Math.min(await avatars.count(), 3); i++) if (await avatars.nth(i).isVisible()) { await avatars.nth(i).hover().catch(() => {}); break; }
      const deadline = Date.now() + Math.min(this.timeoutMs, 2000);
      while (!status.authenticated && Date.now() < deadline) { checkAbort(signal); await sleep(150); status = await this.currentAccount(page); }
    }
    return status;
  }
  async waitForContent(page, selector, signal) {
    try { await page.locator(selector).first().waitFor({ state: 'attached', timeout: this.timeoutMs }); }
    catch { await this.guard(page, signal); return false; }
    await this.guard(page, signal); return true;
  }
  async discover(input, { signal } = {}) {
    const candidates = new Map();
    for (const keyword of deriveKeywords(input)) {
      const page = await this.navigate(`${HOME}search/${encodeURIComponent(keyword)}?type=video`, signal);
      const found = await this.waitForContent(page, 'a[href*="/video/"]', signal);
      if (!found) {
        if (/暂无搜索结果|没有找到相关/.test(await page.locator('body').innerText())) continue;
        fail('搜索结果尚未加载或页面结构变化，请检查浏览器后重试。', 'SEARCH_UNAVAILABLE');
      }
      for (let scroll = 0; scroll < 4 && candidates.size < 20; scroll++) {
        await this.guard(page, signal);
        const rows = await page.evaluate(() => {
          const visible = node => node instanceof HTMLElement && !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length) && getComputedStyle(node).visibility !== 'hidden';
          const rows = [];
          for (const video of [...document.querySelectorAll('a[href*="/video/"]')].filter(visible)) {
            let card = video.closest('article, li, [role="listitem"], [data-e2e="search-card"], [data-e2e="search-video-item"]');
            if (!card) { let node = video.parentElement; for (let i = 0; i < 6 && node && node !== document.body; i++, node = node.parentElement) { if (node.querySelector('a[href*="/user/"]')) { card = node; break; } } }
            if (!card) continue;
            const profiles = [...card.querySelectorAll('a[href*="/user/"]')].filter(visible);
            const unique = new Map(profiles.map(link => [new URL(link.getAttribute('href'), location.origin).pathname, link]));
            if (unique.size !== 1) continue;
            const author = [...unique.values()][0];
            rows.push({ videoUrl: new URL(video.getAttribute('href'), location.origin).href, title: (video.getAttribute('title') || video.getAttribute('aria-label') || video.innerText || card.innerText).trim().slice(0, 200), profileUrl: new URL(author.getAttribute('href'), location.origin).href, nickname: (author.innerText || author.querySelector('img')?.alt || '').trim().slice(0, 100), description: card.innerText.trim().slice(0, 500) });
          }
          return rows;
        });
        for (const row of rows) {
          let target, video; try { target = profileIdentity(row.profileUrl); video = videoIdentity(row.videoUrl); } catch { continue; }
          if (!row.nickname) continue;
          const candidate = candidates.get(target.id) || { id: target.id, nickname: row.nickname, profileUrl: target.url, description: row.description, reason: `搜索“${keyword}”发现的真实视频作者，待核实是否为竞品。`, videos: [] };
          if (!candidate.videos.some(item => item.id === video.id) && candidate.videos.length < 10) candidate.videos.push({ ...video, title: row.title });
          if (candidates.has(target.id) || candidates.size < 20) candidates.set(target.id, candidate);
        }
        await page.mouse.wheel(0, 700); await sleep(this.scrollDelayMs);
      }
    }
    return { candidates: [...candidates.values()] };
  }
  async collect(input, { signal } = {}) {
    const comments = new Map(); const warnings = [];
    const limit = Math.max(1, Math.min(50, Number(input.maxCommentsPerVideo) || 50));
    for (const video of input.videos) {
      if (comments.size >= 300) { warnings.push('已达到本次 300 条评论上限。'); break; }
      const source = videoIdentity(video.url); const page = await this.navigate(source.url, signal);
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
      for (let scroll = 0; scroll < 12 && videoComments.size < limit && comments.size < 300; scroll++) {
        await this.guard(page, signal); const before = videoComments.size;
        const rows = await page.locator(COMMENT_ROWS).evaluateAll(elements => {
          const visible = node => node instanceof HTMLElement && !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length) && getComputedStyle(node).visibility !== 'hidden';
          return elements.filter(visible).map(row => {
            const author = [...row.querySelectorAll('a[href*="/user/"]')].find(visible);
            const text = row.querySelector('[data-e2e="comment-content"], [data-e2e="comment-text"], [class*="comment-content"]');
            const time = row.querySelector('time');
            return { nativeId: row.getAttribute('data-comment-id') || row.getAttribute('data-cid') || '', text: text?.innerText?.trim() || '', nickname: author?.innerText?.trim() || author?.querySelector('img')?.alt || '', profileUrl: author ? new URL(author.getAttribute('href'), location.origin).href : '', postedAt: time?.getAttribute('datetime') || time?.innerText?.trim() || '' };
          });
        });
        for (const row of rows) {
          if (!row.text || row.text.length > 5000) continue;
          let target; try { target = profileIdentity(row.profileUrl); } catch { /* preserve anonymous source, never guess identity */ }
          const commentId = /^[a-zA-Z0-9_.:-]{1,140}$/.test(row.nativeId) ? row.nativeId : `dom:${digest(`${source.id}\n${target?.id || row.nickname}\n${row.text}\n${row.postedAt}`)}`;
          if (videoComments.has(commentId)) continue;
          if (videoComments.size >= limit || comments.size >= 300) break;
          const item = { id: commentId, videoId: source.id, videoUrl: source.url, text: row.text, nickname: row.nickname.slice(0, 100), ...(target ? { recipientId: target.id, profileUrl: target.url } : {}), ...(row.postedAt ? { postedAt: row.postedAt } : {}), source: 'browser' };
          videoComments.set(commentId, item); comments.set(commentId, item);
        }
        stagnant = before === videoComments.size ? stagnant + 1 : 0;
        if (stagnant >= 2 || videoComments.size >= limit) break;
        await page.locator(COMMENT_ROWS).last().scrollIntoViewIfNeeded().catch(() => {});
        await page.evaluate(() => {
          const container = document.querySelector('[data-e2e="comment-list"], [class*="comment-list"]');
          if (container) container.scrollTop += Math.max(400, container.clientHeight); else window.scrollBy(0, 500);
        });
        await sleep(this.scrollDelayMs);
      }
      if (!videoComments.size) warnings.push(`视频 ${source.id} 的评论正文结构无法识别，未生成评论。`);
    }
    return { comments: [...comments.values()], ...(warnings.length ? { warnings } : {}) };
  }
  async uniqueVisible(locator, message) {
    const visible = [];
    for (let i = 0; i < Math.min(await locator.count(), 100); i++) if (await locator.nth(i).isVisible()) visible.push(locator.nth(i));
    if (visible.length !== 1) fail(message, 'CONTROL_UNVERIFIED');
    return visible[0];
  }
  async verifyTarget(root, target) {
    const profiles = await root.locator('a[href*="/user/"]').evaluateAll(elements => elements.filter(node => node instanceof HTMLElement && !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length)).map(node => new URL(node.getAttribute('href'), location.origin).href));
    const ids = new Set(); for (const url of profiles) { try { ids.add(profileIdentity(url).id); } catch { /* not a usable identity */ } }
    if (ids.size !== 1 || !ids.has(target.id)) fail('无法核对目标会话的用户主页，未发送。请打开该用户会话后检查页面结构。', 'RECIPIENT_UNVERIFIED');
  }
  async send(input, { signal, beforeDispatch } = {}) {
    const target = profileIdentity(input.profileUrl); if (target.id !== input.recipientId) fail('目标会话身份不一致。', 'INVALID_RECIPIENT');
    const page = await this.navigate(target.url, signal);
    const account = await this.accountStatus({ signal });
    if (!account.authenticated || account.accountId !== input.senderAccountId) fail('当前登录账号与任务账号不一致，未发送。', 'ACCOUNT_CHANGED');
    const button = await this.uniqueVisible(page.getByRole('button', { name: /^(私信|发消息|发送私信)$/ }), '未找到唯一的私信入口，目标可能未开放私信。');
    await button.click(); await this.guard(page, signal);
    try { await page.locator(`${CHAT_ROOTS}`).filter({ has: page.locator('textarea, [contenteditable="true"], [role="textbox"]') }).first().waitFor({ state: 'visible', timeout: this.timeoutMs }); }
    catch { fail('会话面板未打开或需要人工操作，未发送。', 'CHAT_UNAVAILABLE'); }
    // Remove outer dialog wrappers when an inner chat container is also matched.
    const roots = page.locator(CHAT_ROOTS); let root;
    for (let i = 0; i < await roots.count(); i++) {
      const candidate = roots.nth(i); if (!await candidate.isVisible()) continue;
      if (await candidate.locator('textarea, [contenteditable="true"], [role="textbox"]').count()) {
        if (await candidate.locator(CHAT_ROOTS).count()) continue;
        if (root) fail('存在多个会话面板，未发送。', 'CHAT_AMBIGUOUS'); root = candidate;
      }
    }
    if (!root) fail('无法核对目标会话面板，未发送。', 'CHAT_UNAVAILABLE');
    await this.verifyTarget(root, target);
    const composer = await this.uniqueVisible(root.locator('textarea, [contenteditable="true"], [role="textbox"]'), '未找到唯一消息输入框，未发送。');
    await composer.fill(input.message);
    const sendButton = await this.uniqueVisible(root.getByRole('button', { name: /^发送$/ }), '未找到唯一发送按钮，未发送。');
    if (!await sendButton.isEnabled()) fail('发送按钮不可用，请检查目标私信权限。', 'SEND_DISABLED');
    const matchedMessages = () => root.locator(MESSAGE_ROWS).evaluateAll((elements, text) => elements.filter(node => node instanceof HTMLElement && !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length) && node.innerText.trim() === text.trim()).length, input.message);
    const priorCount = await matchedMessages();
    await this.verifyTarget(root, target); const latest = await this.currentAccount(page);
    if (!latest.authenticated || latest.accountId !== input.senderAccountId) fail('发送前账号发生变化，未发送。', 'ACCOUNT_CHANGED');
    await this.guard(page, signal);
    if (typeof beforeDispatch !== 'function') fail('缺少持久化发送记录，未发送。', 'NO_JOURNAL');
    await beforeDispatch();
    // Once journaled, every exception/timeout is ambiguous. There is exactly one
    // click and deliberately no Enter fallback or automatic retry.
    try {
      checkAbort(signal);
      // Renewal may have taken seconds; re-check the visible account, target and
      // draft after it, immediately before the single irreversible click.
      const afterRenewal = await this.currentAccount(page);
      if (!afterRenewal.authenticated || afterRenewal.accountId !== input.senderAccountId) fail('发送前账号发生变化。', 'ACCOUNT_CHANGED');
      await this.verifyTarget(root, target);
      const draft = await composer.evaluate(node => node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement ? node.value : node.innerText);
      if (draft !== input.message) fail('待发送文案发生变化。', 'MESSAGE_CHANGED');
      await sendButton.click({ timeout: this.timeoutMs, noWaitAfter: true });
      const deadline = Date.now() + this.confirmationMs;
      while (Date.now() < deadline) {
        await this.guard(page, signal);
        const text = await root.innerText();
        if (/发送失败|消息未发送|消息发送失败|请勿频繁|无法发送|暂时无法发送/.test(text)) return { outcome: 'unknown', error: '点击后页面提示发送异常，请核对会话；不会重发。' };
        if (await matchedMessages() > priorCount && !/发送中/.test(text)) return { outcome: 'submitted', evidence: '已在核对过用户主页的会话中单次点击发送，并观察到新增同文消息；不代表送达或已读。' };
        await sleep(150);
      }
    } catch { /* any uncertainty after dispatch is retained, never retried */ }
    return { outcome: 'unknown', error: '已尝试一次发送，但未观察到可确认的新消息；请核对原会话，不会重发。' };
  }
}

export async function openBrowser(config, profileDir) {
  let chromium; try { ({ chromium } = await import('playwright')); } catch { fail('请先在 tools/douyin-bridge 安装本地 Playwright 依赖。', 'BROWSER_MISSING'); }
  if (config.cdpUrl) {
    const browser = await chromium.connectOverCDP(config.cdpUrl);
    const context = browser.contexts()[0]; if (!context) { await browser.close(); fail('CDP 没有可用浏览器上下文。', 'BROWSER_MISSING'); }
    const adapter = new DouyinBrowserAdapter(context);
    return { adapter, close: async () => { await adapter.activePage?.close().catch(() => {}); await browser.close(); } };
  }
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  let context; try { context = await chromium.launchPersistentContext(profileDir, { headless: false, viewport: { width: 1320, height: 900 } }); }
  catch { fail('无法启动专用浏览器，请安装 Chromium 并确认没有其他执行器占用。', 'BROWSER_MISSING'); }
  return { adapter: new DouyinBrowserAdapter(context), close: () => context.close() };
}
