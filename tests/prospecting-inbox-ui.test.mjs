import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { createServer } from 'vite';
import { chromium } from '../tools/douyin-bridge/node_modules/playwright/index.mjs';
import { createSeed } from '../app/lib/seed.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const entry = path.join(root, '__prospecting-inbox.jsx');
const fixture = `import React from 'react';
import {createRoot} from 'react-dom/client';
import '/app/globals.css';
import Workbench from '/app/components/Workbench.tsx';
createRoot(document.getElementById('root')).render(<Workbench member={{accountId:'member-1',username:'ZS',displayName:'ZS',role:'sales',salesId:'sales-1'}} onLogout={async()=>{}} />);`;

const now = '2026-11-14T00:00:00Z';
const campaign = (id, name) => ({ id, name, status: 'active', requirements: '园区招商客户', keywords: ['商铺'], reviewMode: 'manual', greetingTemplate: '', minIntentScore: 70, maxCommentsPerVideo: 30, dailyLimit: 10, memberId: 'member-1', createdAt: now, updatedAt: now, candidates: [], selectedCandidateIds: [] });
const campaigns = [campaign('a', '商铺获客任务'), campaign('b', '办公获客任务')];
const lead = (id, campaignId, nickname, text, status, intentScore) => ({ id, campaignId, nickname, text, status, intentScore, reason: `${nickname}的意向判断依据`, greeting: '本地夹具招呼', version: 1, analysisSource: 'model', source: 'browser', recipientId: `recipient-${id}`, profileUrl: `https://www.douyin.com/user/${id}`, videoId: `video-${id}`, videoUrl: 'https://www.douyin.com/video/1234', updatedAt: now });
const storeLead = lead('c1', 'a', '周末店主', '我想问嘉兴商铺的面积', 'pending', 86);
const submittedLead = lead('c2', 'a', '园区买家', '麻烦发一下办公楼位置', 'submitted', 77);
const officeLead = lead('c3', 'b', '办公访客', '还有独立办公室吗', 'pending', 80);
const webLead = { id: 'web-1', taskId: 'search-1', version: 1, status: 'new', sourceUrl: 'https://example.com/source', title: '本地夹具公开线索', excerpt: '园区公开检索摘要', platform: 'other', query: '园区', region: '嘉兴', regionMatch: 'unverified', retrievedAt: now };

test('prospecting inbox defaults to comment rows and only opens their details on selection', { timeout: 60000 }, async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'prospecting-inbox-'));
  let server;
  let browser;
  try {
    server = await createServer({
      root, configFile: false, logLevel: 'error', cacheDir,
      resolve: { dedupe: ['react', 'react-dom'] },
      optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react', 'react-markdown', 'remark-gfm', 'fflate', 'xlsx'] },
      plugins: [react(), {
        name: 'prospecting-inbox-fixture',
        resolveId(id) { if (id === '/__prospecting-inbox.jsx') return entry; },
        load(id) { if (id === entry) return fixture; },
        configureServer(vite) {
          vite.middlewares.use(async (request, response, next) => {
            if (request.url?.split('?')[0] !== '/') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end(await vite.transformIndexHtml('/', '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__prospecting-inbox.jsx"></script></body></html>'));
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0, hmr: false },
    });
    await server.listen();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(6000);
    const state = createSeed(now);
    state.role = 'sales';
    state.viewer = { name: 'ZS', team: '招商', salesId: 'sales-1' };
    const writes = [];
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/api/**', route => {
      const request = route.request();
      if (request.method() !== 'GET') {
        writes.push(request.method() + ' ' + request.url());
        return route.abort();
      }
      const url = new URL(request.url());
      if (url.pathname === '/api/workbench') return route.fulfill({ json: state });
      if (url.pathname === '/api/web-prospects') return route.fulfill({ json: { tasks: [], leads: [webLead], owners: [] } });
      if (url.pathname === '/api/prospecting') {
        if (url.searchParams.get('mode') === 'chat') return route.fulfill({ json: { online: false, enabled: false, modelReady: true, policy: { libraryIds: [], replyDailyLimit: 30, conversationReplyLimit: 12, replyHoursEnabled: false, workStart: '08:30', workEnd: '21:30' }, libraries: [], conversations: [], messages: [], pool: [] } });
        const selected = campaigns.find(item => item.id === url.searchParams.get('campaignId')) ?? campaigns[0];
        const leads = [storeLead, submittedLead, officeLead].filter(item => item.campaignId === selected.id);
        return route.fulfill({ json: { campaigns, campaign: selected, leads, jobs: [], discoveryRuns: [], device: { online: false, authenticated: false }, modelReady: true, leadPagination: { page: 1, pageSize: 30, total: leads.length } } });
      }
      return route.fulfill({ json: { pendingCount: 0 } });
    });
    const origin = server.resolvedUrls.local[0];
    const view = page.getByRole('combobox', { name: '获客视图', exact: true });
    const task = page.getByRole('combobox', { name: '当前任务', exact: true });
    const status = page.getByRole('combobox', { name: '状态筛选', exact: true });
    const keyword = page.getByRole('textbox', { name: '搜索线索', exact: true }).or(page.getByRole('searchbox', { name: '搜索线索', exact: true }));
    const actions = page.getByRole('button', { name: '任务与采集', exact: true });
    const table = page.getByRole('table', { name: '评论线索', exact: true });
    const firstRow = table.getByRole('row').filter({ hasText: storeLead.nickname });
    const otherRow = table.getByRole('row').filter({ hasText: submittedLead.nickname });
    const details = page.locator('aside[aria-label="线索详情"]');
    const editableGreeting = page.getByLabel('发送前可编辑招呼');
    const option = control => control.locator('option:checked').innerText();

    await page.goto(`${origin}?view=prospecting`);
    await firstRow.getByText(storeLead.text, { exact: true }).waitFor();
    assert.equal(await option(view), '评论线索');
    assert.deepEqual(await view.locator('option').allTextContents(), ['评论线索', '客户会话', '留资线索', '全网线索']);
    assert.deepEqual(await table.getByRole('columnheader').allTextContents(), ['用户名', '原文', '意向', '状态']);
    assert.equal(await firstRow.getByRole('rowheader').count(), 1);
    assert.equal(await firstRow.getByRole('cell').count(), 3);
    assert.match(await firstRow.innerText(), /86/);
    assert.match(await firstRow.innerText(), /待审核/);
    assert.equal(await editableGreeting.count(), 0, 'the first lead is not selected automatically');

    const controls = await Promise.all([view, task, status, keyword, actions].map(control => control.boundingBox()));
    assert.ok(controls.every(Boolean), 'five filter-row controls must be visible');
    const centers = controls.map(rect => rect.y + rect.height / 2);
    assert.ok(Math.max(...centers) - Math.min(...centers) <= 8, 'desktop filters and actions must be on one row');
    assert.ok(controls.every((rect, index) => !index || controls[index - 1].x + controls[index - 1].width <= rect.x + 1), 'filter row controls must not overlap');

    await firstRow.getByText(storeLead.text, { exact: true }).click();
    await details.getByText(storeLead.reason).waitFor();
    const desktopPanel = await details.boundingBox();
    const desktopList = await table.boundingBox();
    assert.ok(desktopPanel.x >= desktopList.x + desktopList.width - 1, 'desktop details appear next to the inbox');
    await details.getByRole('button', { name: '关闭详情', exact: true }).click();
    await editableGreeting.waitFor({ state: 'hidden' });
    await keyword.fill('办公楼');
    await firstRow.waitFor({ state: 'hidden' });
    await otherRow.waitFor();
    await keyword.fill('');
    await firstRow.waitFor();
    await status.selectOption({ label: '待审核' });
    await otherRow.waitFor({ state: 'hidden' });
    await task.selectOption({ label: campaigns[1].name });
    await table.getByText(officeLead.nickname, { exact: true }).waitFor();
    await firstRow.waitFor({ state: 'hidden' });
    assert.equal(await editableGreeting.count(), 0);

    await page.setViewportSize({ width: 390, height: 760 });
    const officeRowButton = table.getByRole('button', { name: `查看${officeLead.nickname}详情`, exact: true });
    await officeRowButton.focus();
    await officeRowButton.press('Enter');
    await details.getByText(officeLead.reason).waitFor();
    const close = details.getByRole('button', { name: '关闭详情', exact: true });
    assert.equal(await close.isVisible(), true);
    assert.equal(await table.isVisible(), false, 'mobile shows the selected detail without leaving a squashed table');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await close.click();
    await officeRowButton.waitFor();

    await page.goto(`${origin}?view=prospecting&section=handoff`);
    await view.waitFor();
    assert.equal(await option(view), '客户会话');
    await view.selectOption({ label: '全网线索' });
    const webTable = page.getByRole('table', { name: '公开网页线索', exact: true });
    await webTable.getByText(webLead.excerpt, { exact: true }).waitFor();
    await page.goto(`${origin}?view=prospecting&section=web`);
    await webTable.getByText(webLead.excerpt, { exact: true }).waitFor();
    assert.equal(await option(view), '全网线索');
    assert.deepEqual(writes, [], 'browsing and filtering must never enqueue a send');
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser?.close();
    await server?.close();
    await rm(cacheDir, { force: true, recursive: true });
  }
});
