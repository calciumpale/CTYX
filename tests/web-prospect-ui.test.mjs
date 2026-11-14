import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('../', import.meta.url));
const shell = `import React,{useCallback,useState} from 'react';
import {createRoot} from 'react-dom/client';
import WebProspecting from '/app/components/WebProspecting.tsx';
import '/app/cds-theme.css';
import '/app/form-controls.css';`;
const fixture = `${shell}
createRoot(document.getElementById('root')).render(<div style={{height:'100vh'}}><WebProspecting/></div>);`;
const searchLabel = '搜索公开网页';
const statusFilter = '审核筛选';
const detail = '.web-prospect-detail';
const apiPath = '**/api/web-prospects';
const leadFixture = {
  id: 'l', taskId: 't', ownerId: 'o', memberId: 'm', version: 1, status: 'new',
  sourceUrl: 'https://example.com/a', title: '上海餐饮企业公开来源',
  excerpt: '<img src=x onerror=alert(1)>公开摘要', platform: 'other', query: '餐饮 上海',
  region: '上海', regionMatch: 'confirmed', regionEvidence: '上海餐饮', retrievedAt: '2026-11-08T00:00:00Z',
};

async function createFixture(source) {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'web-prospect-ui-vite-'));
  const server = await createServer({
    resolve: { dedupe: ['react', 'react-dom'] },
    cacheDir,
    optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react'] },
    root,
    configFile: false,
    logLevel: 'error',
    plugins: [react(), {
      name: 'web-prospect-test-fixture',
      resolveId(id) { if (id === '/__web-prospect-fixture.jsx') return path.join(root, '__web-prospect-fixture.jsx'); },
      load(id) { if (id === path.join(root, '__web-prospect-fixture.jsx')) return source; },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url !== '/') return next();
          response.setHeader('Content-Type', 'text/html');
          response.end(await server.transformIndexHtml('/', '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><div id="root"></div><script type="module" src="/__web-prospect-fixture.jsx"></script></body></html>'));
        });
      },
    }],
    server: { host: '127.0.0.1', port: 0, hmr: false },
  });
  await server.listen();
  return { server, origin: server.resolvedUrls.local[0].replace(/\/$/, ''), cacheDir };
}

async function runBrowser(source, viewport, execute) {
  const { chromium } = await import(pathToFileURL(path.join(root, 'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);
  const { server, origin, cacheDir } = await createFixture(source);
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport });
    await execute(page, origin, cacheDir);
  } finally {
    await browser?.close();
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
}

const row = (page, text) => page.getByRole('row').filter({ hasText: text });
const toolbarSearch = page => page.getByRole('group', { name: '获客筛选' }).getByRole('button', { name: searchLabel, exact: true });
const submitSearch = page => page.locator('.web-prospect-form').getByRole('button', { name: searchLabel, exact: true });
const openSearch = async page => {
  await toolbarSearch(page).click();
  await page.getByLabel('搜索关键词').waitFor();
};

test('uses a four-column lead list, opens safe source review on demand and fits desktop and mobile', { timeout: 60000 }, async () => {
  await runBrowser(fixture, { width: 1280, height: 800 }, async (page, origin, cacheDir) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const lead = { ...leadFixture };
    let snapshot = { tasks: [], leads: [], owners: [] };
    const writes = [];
    await page.route(apiPath, async route => {
      if (route.request().method() === 'POST') {
        const input = route.request().postDataJSON();
        writes.push(input);
        if (input.action === 'search') snapshot = {
          tasks: [{ id: 't', keywords: ['餐饮'], status: 'completed', resultCount: 1, errors: [], createdAt: '2026-11-08T00:00:00Z' }],
          leads: [lead],
          owners: [],
        };
        if (input.action === 'review') { lead.status = input.status; lead.version++; }
        if (input.action === 'convert') { lead.projectId = 'p'; lead.version++; }
      }
      await route.fulfill({ json: snapshot });
    });
    await page.goto(origin);
    await page.getByText('尚未搜索。输入关键词后开始收集公开来源。').waitFor();
    assert.deepEqual(await page.getByRole('columnheader').allTextContents(), ['用户名', '原文', '意向', '状态']);
    assert.equal(await page.locator(detail).count(), 0);
    for (const mode of ['light', 'dark']) {
      await page.evaluate(value => { document.documentElement.dataset.mode = value; }, mode);
      const colorsAndSize = await toolbarSearch(page).evaluate(button => {
        const styles = getComputedStyle(button);
        const control = document.querySelector('.web-prospect-list-search');
        const luminance = color => {
          const [r, g, b] = color.match(/\d+/g).slice(0,3).map(value => {
            const component = Number(value) / 255;
            return component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const shades = [luminance(styles.color), luminance(styles.backgroundColor)].sort((a, b) => b - a);
        return {
          contrast: (shades[0] + 0.05) / (shades[1] + 0.05),
          button: button.getBoundingClientRect().height,
          search: control.getBoundingClientRect().height,
        };
      });
      assert.ok(colorsAndSize.contrast >= 4.5);
      assert.equal(colorsAndSize.button, colorsAndSize.search);
    }
    await page.evaluate(() => { document.documentElement.dataset.mode = 'light'; });
    await openSearch(page);
    await page.getByLabel('搜索平台').selectOption('tieba');
    await page.getByLabel('搜索关键词').fill('餐饮');
    assert.equal(await submitSearch(page).isDisabled(), true);
    await page.getByLabel('搜索地区').fill('上海');
    await submitSearch(page).click();
    await page.getByLabel('搜索关键词').waitFor({ state: 'hidden' });
    assert.equal(await page.locator(detail).count(), 0);
    const result = row(page, '公开摘要');
    assert.match(await result.innerText(), /example\.com.+<img.+待核实.+待审核/s);
    await page.getByLabel('查找公开线索').fill('没有匹配的文本');
    await page.getByText('当前筛选下没有来源').waitFor();
    await page.getByLabel('查找公开线索').fill('');
    await result.getByRole('button').focus();
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: lead.title }).waitFor();
    assert.equal(await page.locator(detail + ' img').count(), 0);
    assert.match(await page.locator('.web-prospect-excerpt').innerText(), /^<img/);
    assert.equal(await page.getByRole('link', { name: '打开公开来源' }).getAttribute('href'), lead.sourceUrl);
    await page.getByText('检索与地区证据').click();
    await page.getByText('上海餐饮', { exact: true }).waitFor();
    await page.getByRole('button', { name: '标为有效线索' }).click();
    await page.getByLabel('企业名称').fill('人工确认的企业');
    await page.getByLabel('项目名称').fill('公开线索项目');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(cacheDir, 'web-prospect-desktop.png') });
    await page.getByRole('button', { name: '确认建立项目' }).click();
    await page.getByRole('button', { name: '打开已建项目' }).waitFor();
    assert.equal(writes.find(input => input.action === 'convert').companyName, '人工确认的企业');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(cacheDir, 'web-prospect-mobile.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.getByRole('table').isVisible(), false);
    await page.getByRole('button', { name: '关闭线索详情' }).click();
    assert.equal(await page.getByRole('table').isVisible(), true);
    await page.getByLabel(statusFilter).selectOption('ignored');
    await page.getByText('当前筛选下没有来源').waitFor();
    assert.deepEqual(errors, []);
  });
});

test('keeps failed searches recoverable and distinguishes running, partial and empty results', { timeout: 30000 }, async () => {
  await runBrowser(fixture, { width: 920, height: 900 }, async (page, origin) => {
    await page.route(apiPath, route => route.fulfill({ status: 503, json: { error: '搜索源暂时不可用' } }));
    await page.goto(origin);
    assert.match(await page.getByRole('alert').innerText(), /搜索源暂时不可用/);
    await page.unroute(apiPath);
    for (const [status, resultCount, expected] of [
      ['completed', 0, '本次搜索成功，但未找到匹配的公开来源。可调整关键词或地区。'],
      ['partial', 0, '部分来源失败'],
      ['failed', 0, '搜索失败'],
      ['running', 0, '搜索中'],
    ]) {
      await page.route(apiPath, route => route.fulfill({ json: {
        tasks: [{ id: 'state', keywords: ['x'], status, resultCount, errors: [], createdAt: '2026-11-08T00:00:00Z' }],
        leads: [], owners: [],
      } }));
      await page.reload();
      await page.getByText(expected, { exact: true }).waitFor();
      await page.unroute(apiPath);
    }
  });
});

test('deduped repeat search preserves per-lead conversion drafts and host leave guard', { timeout: 30000 }, async () => {
  const guarded = `${shell}
function Host() {
  const [dirty,setDirty]=useState(false),[mounted,setMounted]=useState(true),[attempt,setAttempt]=useState('none');
  const onDirtyChange=useCallback(value=>setDirty(value),[]);
  return <><output aria-label="dirty状态">{dirty?'dirty':'clean'}</output><output aria-label="离开状态">{attempt}</output>
    <button onClick={()=>dirty?setAttempt('blocked'):setMounted(false)}>离开模式</button>
    {mounted?<div style={{height:'760px'}}><WebProspecting onDirtyChange={onDirtyChange}/></div>:<p>已离开模式</p>}</>;
}
createRoot(document.getElementById('root')).render(<Host/>);`;
  await runBrowser(guarded, { width: 920, height: 900 }, async (page, origin) => {
    const a = { ...leadFixture, id: 'a', status: 'qualified', title: '来源A', excerpt: '公开摘要A' };
    const b = { ...a, id: 'b', sourceUrl: 'https://example.com/b', title: '来源B', excerpt: '公开摘要B' };
    const owners = [{ salesId: 'sales-a', displayName: '销售甲' }, { salesId: 'sales-b', displayName: '销售乙' }];
    let searches = 0;
    await page.route(apiPath, route => {
      if (route.request().method() === 'POST') searches++;
      return route.fulfill({ json: { tasks: [], leads: searches < 2 ? [a, b] : [b, a], owners } });
    });
    await page.goto(origin);
    assert.equal(await page.locator(detail).count(), 0);
    await row(page, '公开摘要A').click();
    await page.getByLabel('企业名称').fill('尚未提交的企业草稿A');
    await page.getByLabel('项目名称').fill('尚未提交的项目草稿A');
    await page.getByLabel('销售归属').selectOption('sales-a');
    await page.getByRole('button', { name: '关闭线索详情' }).click();
    await openSearch(page);
    await page.getByLabel('搜索关键词').fill('餐饮');
    await submitSearch(page).click();
    await page.getByLabel('搜索关键词').waitFor({ state: 'hidden' });
    await row(page, '公开摘要A').click();
    assert.equal(await page.getByLabel('企业名称').inputValue(), '尚未提交的企业草稿A');
    assert.equal(await page.getByLabel('销售归属').inputValue(), 'sales-a');
    assert.equal(await page.getByLabel('dirty状态').innerText(), 'dirty');
    await page.getByRole('button', { name: '离开模式' }).click();
    assert.equal(await page.getByLabel('离开状态').innerText(), 'blocked');
    assert.equal(await page.getByText('已离开模式', { exact: true }).count(), 0);
    await row(page, '公开摘要B').click();
    await page.getByLabel('企业名称').fill('尚未提交的企业草稿B');
    await page.getByLabel('项目名称').fill('尚未提交的项目草稿B');
    await page.getByLabel('销售归属').selectOption('sales-b');
    await openSearch(page);
    await submitSearch(page).click();
    await page.getByLabel('搜索关键词').waitFor({ state: 'hidden' });
    await row(page, '公开摘要B').click();
    assert.equal(await page.getByLabel('企业名称').inputValue(), '尚未提交的企业草稿B');
    assert.equal(await page.getByLabel('销售归属').inputValue(), 'sales-b');
    await row(page, '公开摘要A').click();
    assert.equal(await page.getByLabel('企业名称').inputValue(), '尚未提交的企业草稿A');
    assert.equal(await page.getByLabel('dirty状态').innerText(), 'dirty');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  });
});
