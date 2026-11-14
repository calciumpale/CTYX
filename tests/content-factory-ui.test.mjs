import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { createServer } from 'vite';
import { chromium } from '../tools/douyin-bridge/node_modules/playwright/index.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const entry = path.join(root, '__content-factory-ui.jsx');
const fixture = `import React from 'react';
import {createRoot} from 'react-dom/client';
import '/app/globals.css';
import MarketingMaterials from '/app/components/MarketingMaterials.tsx';
createRoot(document.getElementById('root')).render(<div style={{height:'100dvh'}}><MarketingMaterials notify={()=>{}} /></div>);`;
const html = '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__content-factory-ui.jsx"></script></body></html>';
const topic = '园区周末市集';
const audience = '在嘉兴经营小店的本地店主';
const now = '2026-11-14T02:00:00.000Z';
const generated = {
  copy: [
    { channel: 'wechat', title: '这个周末来逛园区市集', alternateTitle: '本周市集出摊指南', body: '欢迎本地店主在周末到园区了解摊位安排。' },
    { channel: 'xiaohongshu', title: '周末摊位逛展路线', alternateTitle: '周末市集这样逛', body: '逛市集可以先看入口导览，再走本地手作区。' },
  ],
  posters: [],
  audience: { summary: '重点触达附近经营独立店铺的人群。', tags: ['本地店主', '周末活动'], nextStep: '先邀请店主查看摊位说明。' },
  generatedAt: now,
};

test('content factory edits generated channel copy and saves a local publication queue', { timeout: 60000 }, async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'content-factory-ui-'));
  const initialRead = Promise.withResolvers();
  const initialReadFinished = Promise.withResolvers();
  let server;
  let browser;
  try {
    server = await createServer({
      root, configFile: false, logLevel: 'error', cacheDir,
      resolve: { dedupe: ['react', 'react-dom'] },
      optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react', 'fflate', 'react-markdown', 'remark-gfm'] },
      plugins: [react(), {
        name: 'content-factory-fixture',
        resolveId(id) { if (id === '/__content-factory-ui.jsx') return entry; },
        load(id) { if (id === entry) return fixture; },
        configureServer(vite) {
          vite.middlewares.use(async (request, response, next) => {
            if (request.url?.split('?')[0] !== '/') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end(await vite.transformIndexHtml('/', html));
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0, hmr: false },
    });
    await server.listen();
    browser = await chromium.launch({ headless: true });
    const origin = server.resolvedUrls.local[0];
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(7000);
    const pageErrors = [];
    const requests = [];
    const unexpected = [];
    const records = new Map();
    let hasReadCampaigns = false;
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== new URL(origin).origin || url.pathname.startsWith('/api/') && url.pathname !== '/api/content-factory') {
        unexpected.push(`${request.method()} ${url.pathname}`);
        return route.abort();
      }
      if (url.pathname !== '/api/content-factory') return route.continue();
      if (request.method() === 'GET') {
        const campaigns = [...records.values()];
        if (hasReadCampaigns) return route.fulfill({ json: { modelAvailable: true, campaigns } });
        hasReadCampaigns = true;
        await initialRead.promise;
        try { await route.fulfill({ json: { modelAvailable: true, campaigns } }); }
        catch { /* The stale request can be canceled after the newer save. */ }
        finally { initialReadFinished.resolve(); }
        return;
      }
      assert.equal(request.method(), 'POST');
      const body = request.postDataJSON();
      requests.push(body);
      if (body.action === 'generate') {
        if (body.channel === 'xiaohongshu') return route.fulfill({ json: { generated: { ...generated, copy: [generated.copy[1]], audience: null } } });
        return route.fulfill({ json: { generated: { ...generated, copy: [generated.copy[0]] }, copyError: '小红书笔记未生成，可切换到对应渠道重试。' } });
      }
      assert.equal(body.action, 'save');
      const previous = records.get(body.id);
      assert.equal(body.version, previous?.version ?? 0);
      const record = { id: body.id, version: body.version + 1, document: body.document, updatedAt: now };
      records.set(record.id, record);
      return route.fulfill({ json: { record } });
    });

    await page.goto(origin);
    const tabs = page.getByRole('tablist', { name: '素材功能' }).getByRole('tab');
    const factory = page.getByRole('tab', { name: 'AI 内容工厂', exact: true });
    await factory.waitFor();
    assert.deepEqual(await tabs.allTextContents(), ['AI 内容工厂', '数字人']);
    assert.equal(await factory.getAttribute('aria-selected'), 'true');
    await page.getByLabel('活动 / 主题', { exact: true }).fill(topic);
    await page.getByLabel('目标人群', { exact: true }).fill(audience);

    const save = page.getByRole('button', { name: '保存活动', exact: true });
    const saveResponse = () => page.waitForResponse(result => result.request().method() === 'POST' && result.request().postDataJSON().action === 'save');
    const firstSave = saveResponse();
    await save.click();
    assert.equal((await firstSave).status(), 200);
    const history = page.getByRole('combobox', { name: '历史活动', exact: true });
    await history.waitFor();
    initialRead.resolve();
    await initialReadFinished.promise;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await history.locator('option:checked').textContent(), topic, 'a stale list response cannot remove a saved activity');

    await page.getByRole('button', { name: '生成全套内容', exact: true }).click();
    const title = page.getByRole('textbox', { name: /^标题$/ }).first();
    const body = page.getByRole('textbox', { name: /^正文$/ }).first();
    await title.waitFor();
    assert.equal(await title.inputValue(), generated.copy[0].title);
    assert.equal(await body.inputValue(), generated.copy[0].body);
    assert.deepEqual(requests[1], { action: 'generate', brief: { goal: 'leads', topic, audience, tone: 'professional', channels: ['wechat', 'xiaohongshu'], requirements: '', brand: '' } });

    const editedTitle = '周末市集店主邀约';
    const editedCopy = '本周日来现场看摊位，请先确认意向时段。';
    await title.fill(editedTitle);
    await body.fill(editedCopy);
    await page.getByRole('alert').filter({ hasText: '小红书笔记未生成' }).waitFor();
    const channelTabs = page.getByRole('tablist', { name: '生成结果渠道' });
    await channelTabs.getByRole('tab', { name: '小红书笔记' }).click();
    await page.getByRole('button', { name: '生成当前渠道' }).click();
    await title.waitFor();
    assert.equal(await title.inputValue(), generated.copy[1].title);
    assert.equal(requests[2].channel, 'xiaohongshu');
    await channelTabs.getByRole('tab', { name: '公众号长文' }).click();
    assert.equal(await title.inputValue(), editedTitle);
    assert.equal(await body.inputValue(), editedCopy);
    await page.getByRole('region', { name: 'AI 人群洞察' }).getByText(generated.audience.summary, { exact: true }).waitFor();
    await page.getByRole('button', { name: '加入发布队列', exact: true }).click();

    const response = saveResponse();
    await save.click();
    assert.equal((await response).status(), 200);
    assert.equal(requests[3].document.queue[0].status, 'draft');

    await page.getByRole('button', { name: '送审并排期', exact: true }).click();
    const review = page.getByRole('dialog', { name: '送审并排期', exact: true });
    await review.getByLabel('计划发布时间').fill('2099-02-15T09:30');
    const schedule = saveResponse();
    await review.getByRole('button', { name: '确认送审', exact: true }).click();
    assert.equal((await schedule).status(), 200);
    const queue = page.getByRole('dialog', { name: '发布队列', exact: true });
    await queue.getByText(editedTitle, { exact: true }).waitFor();
    await queue.getByText(/待审核 · 已登记排期/).waitFor();
    const reschedule = queue.getByRole('button', { name: '调整排期', exact: true });
    for (const dismissal of ['button', 'Escape']) {
      await reschedule.click();
      await review.getByLabel('计划发布时间').waitFor();
      if (dismissal === 'button') await review.getByRole('button', { name: '取消', exact: true }).click();
      else await page.keyboard.press('Escape');
      await review.waitFor({ state: 'hidden' });
      assert.equal(await reschedule.evaluate(button => document.activeElement === button), true, 'return focus to the selected queue row');
    }
    await queue.getByRole('button', { name: '关闭', exact: true }).click();

    const document = requests[4].document;
    assert.deepEqual(requests.map(request => request.action), ['save', 'generate', 'generate', 'save', 'save']);
    const saves = requests.filter(request => request.action === 'save');
    assert.deepEqual(saves.map(request => request.version), [0, 1, 2]);
    assert.ok(saves.every(request => request.id === saves[0].id));
    assert.equal(document.generated.copy.find(item => item.channel === 'wechat').body, editedCopy);
    assert.deepEqual(document.generated.copy.find(item => item.channel === 'xiaohongshu'), generated.copy[1]);
    assert.equal(document.queue.length, 1);
    assert.deepEqual({ channel: document.queue[0].channel, title: document.queue[0].title, body: document.queue[0].body }, { channel: 'wechat', title: editedTitle, body: editedCopy });
    assert.equal(document.queue[0].status, 'scheduled');
    assert.equal(document.queue[0].scheduledAt, new Date('2099-02-15T09:30').toISOString());

    await page.reload();
    await history.selectOption({ label: topic });
    await title.waitFor();
    assert.equal(await title.inputValue(), editedTitle);
    assert.equal(await body.inputValue(), editedCopy);

    const resultTabs = page.getByRole('tablist', { name: '生成结果渠道', exact: true });
    const wechatTab = resultTabs.getByRole('tab', { name: '公众号长文', exact: true });
    const xhsTab = resultTabs.getByRole('tab', { name: '小红书笔记', exact: true });
    assert.equal(await wechatTab.evaluate(tab => getComputedStyle(tab, '::after').content), 'none');
    await wechatTab.focus();
    for (const [key, tab, expected] of [
      ['ArrowRight', xhsTab, generated.copy[1].title],
      ['ArrowLeft', wechatTab, editedTitle],
      ['End', xhsTab, generated.copy[1].title],
      ['Home', wechatTab, editedTitle],
    ]) {
      await page.keyboard.press(key);
      assert.equal(await tab.getAttribute('aria-selected'), 'true');
      assert.equal(await tab.evaluate(element => document.activeElement === element), true);
      assert.equal(await tab.evaluate(element => {
        const panels = [...document.querySelectorAll('[role="tabpanel"]')];
        return panels.some(panel => panel.getAttribute('aria-labelledby') === element.id && !panel.hidden);
      }), true, 'the selected channel controls the visible result panel');
      assert.equal(await title.inputValue(), expected);
    }

    const artifacts = process.env.CONTENT_FACTORY_QA_ARTIFACT_DIR;
    if (artifacts) await page.screenshot({ path: path.join(artifacts, 'content-factory-desktop.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (artifacts) await page.screenshot({ path: path.join(artifacts, 'content-factory-mobile.png'), animations: 'disabled' });
    await page.getByRole('button', { name: /^发布队列/ }).click();
    await queue.getByText(editedTitle, { exact: true }).waitFor();
    if (artifacts) await page.screenshot({ path: path.join(artifacts, 'content-factory-mobile-queue.png'), animations: 'disabled' });
    assert.deepEqual(unexpected, []);
    assert.deepEqual(pageErrors, []);
  } finally {
    initialRead.resolve();
    await browser?.close();
    await server?.close();
    await rm(cacheDir, { force: true, recursive: true });
  }
});
