import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('../', import.meta.url));

const digitalHumanFixture="import React,{useEffect,useState} from 'react';export default function DigitalHumanWorkspace({onBusyChange,onDirtyChange}){const [value,setValue]=useState(''),[busy,setBusy]=useState(false);useEffect(()=>{onBusyChange?.(busy);return()=>onBusyChange?.(false);},[busy,onBusyChange]);useEffect(()=>{onDirtyChange?.(!!value.trim());return()=>onDirtyChange?.(false);},[value,onDirtyChange]);return <div className='digital-human-workspace'><label>数字人测试草稿<input value={value} onChange={e=>setValue(e.target.value)}/></label><button onClick={()=>setBusy(!busy)}>{busy?'结束数字人测试请求':'开始数字人测试请求'}</button></div>;}";

const fixture=`import React from 'react';import {createRoot} from 'react-dom/client';import MarketingMaterials from '/app/components/MarketingMaterials.tsx';import MaterialConnectionSettings from '/app/components/MaterialConnectionSettings.tsx';import '/app/form-controls.css';createRoot(document.getElementById('root')).render(<><div style={{height:'100vh'}}><MarketingMaterials notify={()=>{}}/></div><MaterialConnectionSettings/></>);`;
async function createFixture(source) {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'material-ui-vite-'));
  const server = await createServer({
    resolve: { dedupe: ['react', 'react-dom'] }, cacheDir, optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react'] },
    root, configFile: false, logLevel: 'error', plugins: [react(), {
      name: 'material-test-fixture',
      // This child boundary must resolve before Vite's existing-file resolver.
      enforce: 'pre',
      resolveId(id,importer) { if(id===path.join(root,'app/components/DigitalHumanWorkspace.tsx')||id==='/app/components/DigitalHumanWorkspace.tsx'||id==='./DigitalHumanWorkspace'&&importer?.endsWith('/app/components/MarketingMaterials.tsx'))return path.join(root,'__digital-human-fixture.jsx');if (id === '/__material-fixture.jsx') return path.join(root, '__material-fixture.jsx'); },
      load(id) { if(id===path.join(root,'__digital-human-fixture.jsx'))return digitalHumanFixture;if (id === path.join(root, '__material-fixture.jsx')) return source; },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url !== '/') return next();
          response.setHeader('Content-Type', 'text/html');
          response.end(await server.transformIndexHtml('/', '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__material-fixture.jsx"></script></body></html>'));
        });
      },
    }], server: { host: '127.0.0.1', port: 0, hmr: false },
  });
  await server.listen();
  const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
  return { server, origin, cacheDir };
}

test('creative studio connects copy, design, saved versions, and independent template drafts', { timeout: 60000 }, async () => {
  const { chromium } = await import(pathToFileURL(path.join(root, 'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);
  const { server, origin, cacheDir } = await createFixture(fixture.replace('<MaterialConnectionSettings/>', ''));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
    page.setDefaultTimeout(8000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    const projects = new Map();
    const actions = [];
    const coverRequests = [];
    const mediaTasks = [];
    const time = '2026-11-12T00:00:00.000Z';
    const copy = { title: '园区周末市集', caption: '来逛一圈周末市集。', script: '带你看看摊位。', coverPrompt: '街区市集全景', shots: [{ visual: '摊位全景', voiceover: '周末见', seconds: 5 }] };
    await page.route('**/api/marketing-materials', route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { tasks: mediaTasks, availability: { image: true, video: false } } });
      const body = route.request().postDataJSON();
      assert.equal(body.action, 'generate');
      coverRequests.push(body.requestId);
      if (coverRequests.length === 1) return route.abort();
      const task = { id: 'cover-1', requestId: body.requestId, version: 2, status: 'submission_unknown', input: body.input, files: [] };
      mediaTasks.push(task);
      return route.fulfill({ json: { task } });
    });
    await page.route('**/api/creative-studio*', route => {
      const request = route.request();
      const query = new URL(request.url()).searchParams;
      if (request.method() === 'GET') {
        if (query.has('market')) return route.fulfill({ json: { templates: [] } });
        if (query.has('id')) {
          const versions = projects.get(query.get('id')) ?? [];
          const project = query.has('version') ? versions.find(item => item.version === Number(query.get('version'))) : versions[0];
          return route.fulfill({ json: { project, versions: versions.map(({ version, updatedAt }) => ({ version, updatedAt })) } });
        }
        return route.fulfill({ json: { projects: [...projects.values()].map(([item]) => ({
          id: item.id, title: item.document.title, kind: item.document.kind, version: item.version, updatedAt: item.updatedAt,
        })), modelAvailable: true } });
      }
      const body = request.postDataJSON();
      actions.push(body.action);
      if (body.action === 'generate') {
        assert.equal(body.mode, 'copy');
        assert.equal(body.document.brief, '园区周末举办市集，拍摄摊位。');
        return route.fulfill({ json: { copy } });
      }
      assert.equal(body.action, 'save');
      const versions = projects.get(body.id) ?? [];
      assert.equal(body.version, versions[0]?.version ?? 0);
      const project = { id: body.id, version: body.version + 1, document: body.document, updatedAt: time };
      projects.set(body.id, [project, ...versions]);
      return route.fulfill({ json: { project } });
    });
    await page.goto(origin);
    assert.equal(await page.getByRole('tab', { name: '创作与设计' }).getAttribute('aria-selected'), 'true');
    if (process.env.STUDIO_QA_ARTIFACT_DIR) {
      await page.getByRole('button', { name: '网页设计', exact: true }).waitFor();
      await page.screenshot({ path: path.join(process.env.STUDIO_QA_ARTIFACT_DIR, 'studio-home.png') });
    }
    await page.getByLabel('记录灵感').fill('园区周末举办市集，拍摄摊位。');
    await page.getByRole('button', { name: '开始创作' }).click();
    assert.equal(await page.getByLabel('灵感与产品资料').inputValue(), '园区周末举办市集，拍摄摊位。');
    await page.getByRole('button', { name: '生成稿件', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('input, textarea')].some(input => input.value === '园区周末市集'));
    assert.equal(await page.getByRole('textbox', { name: /^画面/ }).inputValue(), '摊位全景');
    await page.getByRole('button', { name: '用稿件做画板' }).click();
    await page.getByRole('region', { name: '画板浏览区' }).waitFor();
    await page.getByLabel('项目名称', { exact: true }).fill('市集第一版');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByText('版本 1', { exact: true }).waitFor();
    await page.getByRole('button', { name: '成稿', exact: true }).click();
    await page.getByRole('button', { name: '生成封面图片', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: /fetch|请求/i }).waitFor();
    await page.reload();
    await page.getByRole('tab', { name: '创作与设计' }).click();
    await page.getByRole('region', { name: '最近项目' }).getByRole('button', { name: /市集第一版/ }).click();
    await page.getByRole('button', { name: '生成封面图片', exact: true }).click();
    await page.getByText('封面图片：提交结果待核对', { exact: false }).waitFor();
    assert.equal(coverRequests.length, 2);
    assert.equal(coverRequests[0], coverRequests[1]);
    assert.equal(await page.getByRole('button', { name: '生成封面图片', exact: true }).isDisabled(), true);
    await page.getByLabel('项目名称', { exact: true }).fill('市集第二版');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByText('版本 2', { exact: true }).waitFor();
    await page.getByRole('button', { name: '版本比较', exact: true }).click();
    await page.getByRole('region', { name: '左侧版本' }).getByText('市集第一版', { exact: true }).waitFor();
    await page.getByRole('region', { name: '右侧版本' }).getByText('市集第二版', { exact: true }).waitFor();
    await page.getByRole('button', { name: '恢复为草稿' }).click();
    assert.equal(await page.getByLabel('项目名称', { exact: true }).inputValue(), '市集第一版');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByText('版本 3', { exact: true }).waitFor();
    await page.getByRole('button', { name: '设计市场', exact: true }).click();
    await page.getByRole('button', { name: '小程序', exact: true }).click();
    await page.getByRole('button', { name: /^使用模板 / }).first().click();
    await page.getByRole('region', { name: '画板浏览区' }).waitFor();
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByText('版本 1', { exact: true }).waitFor();
    assert.deepEqual(actions, ['generate', 'save', 'save', 'save', 'save']);
    assert.equal(projects.size, 2);
    assert.deepEqual([...projects.values()].map(([item]) => item.document.kind), ['poster', 'mini']);
    if (process.env.STUDIO_QA_ARTIFACT_DIR) {
      await page.screenshot({ path: path.join(process.env.STUDIO_QA_ARTIFACT_DIR, 'studio-desktop.png'), fullPage: true });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (process.env.STUDIO_QA_ARTIFACT_DIR) {
      await page.getByRole('region', { name: '画板浏览区' }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(process.env.STUDIO_QA_ARTIFACT_DIR, 'studio-mobile.png') });
    }
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser?.close();
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});


test('retired generator gives way to the studio while historical pictures and video still open', { timeout: 60000 }, async () => {
  const { chromium } = await import(pathToFileURL(path.join(root, 'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);
  const { server, origin, cacheDir } = await createFixture(fixture);
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const date = '2026-11-12T00:00:00Z';
    const task = (id, kind, prompt, status, files = []) => ({
      id, requestId: id, version: 2, status, input: { kind, prompt }, progress: files.length ? 100 : 95,
      createdAt: date, updatedAt: date, pollAt: 0, files, slides: [],
    });
    const imageFile = { type: 'image/png', name: '封面.png', url: '/api/marketing-materials/result?taskId=old-image&fileIndex=0' };
    const videoFile = { type: 'video/mp4', name: '短片.mp4', url: '/api/marketing-materials/result?taskId=old-video&fileIndex=0' };
    const image = task('old-image', 'image', '已保存的园区封面', 'completed', [imageFile]);
    const video = task('old-video', 'video', '已保存的园区短片', 'saving');
    const deck = task('old-deck', 'presentation', '历史演示稿', 'completed');
    const mediaWrites = [];
    let connectionWrites = 0;
    await page.route('**/api/creative-studio', route => route.fulfill({ json: { projects: [], modelAvailable: false } }));
    await page.route('**/api/marketing-materials', route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { tasks: [image, video, deck], availability: { image: false, video: false } } });
      const body = route.request().postDataJSON();
      mediaWrites.push(body);
      return route.fulfill({ json: { task: { ...video, status: 'completed', version: 3, progress: 100, files: [videoFile] } } });
    });
    await page.route('**/api/marketing-materials/result?*', route => route.fulfill({
      contentType: route.request().url().includes('old-video') ? 'video/mp4' : 'image/png',
      body: route.request().url().includes('old-video') ? Buffer.from([]) : Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/D1cAAAAASUVORK5CYII=', 'base64'),
    }));
    await page.route('**/api/material-connection', route => {
      if (route.request().method() === 'POST') connectionWrites++;
      return route.fulfill({ json: { connection: {
        kind: 'apimart', configured: false, hasSecret: false, enabled: false, version: 0, imageModel: 'gpt-image-1-official', storageReady: true,
      }, message: '已保存' } });
    });
    await page.goto(origin);
    assert.deepEqual(await page.getByRole('tab').allTextContents(), ['创作与设计', 'AI 朋友圈', '数字人']);
    assert.equal(await page.getByRole('tab', { name: '创作与设计' }).getAttribute('aria-selected'), 'true');
    assert.equal(await page.getByLabel('输出类型').count(), 0);
    await page.getByRole('button', { name: '素材库', exact: true }).click();
    await page.getByRole('button', { name: /已保存的园区封面/ }).click();
    const detail = page.getByRole('article', { name: '素材详情' });
    await detail.getByRole('img').waitFor();
    assert.equal(await detail.getByRole('link', { name: '下载封面.png' }).getAttribute('href'), imageFile.url);
    assert.equal(await page.getByText('历史演示稿', { exact: true }).count(), 0);
    await page.getByRole('button', { name: '视频', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: /已保存的园区封面/ }).count(), 0);
    await page.getByRole('button', { name: /已保存的园区短片/ }).click();
    await detail.getByRole('button', { name: '重试保存' }).click();
    await detail.locator('video').waitFor();
    assert.equal(await detail.getByRole('link', { name: '下载短片.mp4' }).getAttribute('href'), videoFile.url);
    assert.deepEqual(mediaWrites, [{ action: 'refresh', taskId: 'old-video', version: 2 }]);
    const fieldHeights = () => page.locator('.material-connection input:not([type=checkbox]),.material-connection select').evaluateAll(
      fields => [...new Set(fields.map(field => Math.round(field.getBoundingClientRect().height)).filter(Boolean))],
    );
    assert.deepEqual(await fieldHeights(), [36]);
    await page.getByLabel(/API Key/).fill('test-key-not-live');
    await page.getByRole('button', { name: '保存连接', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('input[type=password]').value === '');
    assert.equal(connectionWrites, 1);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(await fieldHeights(), [44]);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('studio and digital human drafts survive tab changes and propagate the leave guard', { timeout: 60000 }, async () => {
  const source = `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import MarketingMaterials from '/app/components/MarketingMaterials.tsx';
  function Parent(){const [busy,setBusy]=useState(false),[dirty,setDirty]=useState(false);return <><output data-testid="material-state">{busy?'busy':dirty?'dirty':'clean'}</output><MarketingMaterials notify={()=>{}} onBusyChange={setBusy} onDirtyChange={setDirty}/></>};createRoot(document.getElementById('root')).render(<Parent/>);`;
  const { chromium } = await import(pathToFileURL(path.join(root, 'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);
  const { server, origin, cacheDir } = await createFixture(source);
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(8000);
    await page.route('**/api/creative-studio', route => route.fulfill({ json: { projects: [], modelAvailable: false } }));
    await page.route('**/api/marketing-materials', route => route.fulfill({ json: { tasks: [], availability: {} } }));
    await page.goto(origin);
    const state = value => page.getByTestId('material-state').filter({ hasText: value }).waitFor();
    await state('clean');
    await page.getByLabel('记录灵感').fill('未完成的品牌构思');
    await state('dirty');
    const creative = page.getByRole('tab', { name: '创作与设计', exact: true });
    const digital = page.getByRole('tab', { name: '数字人', exact: true });
    await creative.focus();
    await page.keyboard.press('End');
    await page.getByLabel('数字人测试草稿').fill('数字人草稿');
    await page.getByRole('button', { name: '开始数字人测试请求' }).click();
    await state('busy');
    assert.equal(await creative.isDisabled(), true);
    await page.getByRole('button', { name: '结束数字人测试请求' }).click();
    await state('dirty');
    await digital.focus();
    await page.keyboard.press('Home');
    assert.equal(await page.getByLabel('记录灵感').inputValue(), '未完成的品牌构思');
    await page.getByLabel('记录灵感').fill('');
    await state('dirty');
    await digital.click();
    assert.equal(await page.getByLabel('数字人测试草稿').inputValue(), '数字人草稿');
    await page.getByLabel('数字人测试草稿').fill('');
    await state('clean');
  } finally {
    await browser?.close();
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});
