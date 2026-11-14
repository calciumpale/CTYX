import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createSeed } from '../app/lib/seed.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const entry = '/__agent-memory.jsx';
const fixture = `import React from 'react';import {createRoot} from 'react-dom/client';import '/app/globals.css';import Workbench from '/app/components/Workbench.tsx';createRoot(document.getElementById('root')).render(<Workbench member={{accountId:'manager',username:'manager',displayName:'管理者',role:'manager'}} onLogout={async()=>{}}/>);`;

test('assistant memory separates personal and project actions, and leaves the chat draft in place', { timeout: 90_000 }, async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'agent-memory-ui-'));
  const server = await createServer({
    root, configFile: false, logLevel: 'error', cacheDir,
    resolve: { dedupe: ['react', 'react-dom'] },
    optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react'] },
    plugins: [react(), {
      name: 'agent-memory-fixture',
      resolveId(id) { if (id === entry) return path.join(root, entry); },
      load(id) { if (id === path.join(root, entry)) return fixture; },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url?.split('?')[0] !== '/') return next();
          response.setHeader('Content-Type', 'text/html');
          response.end(await server.transformIndexHtml('/', `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`));
        });
      },
    }],
    server: { host: '127.0.0.1', port: 0, hmr: false },
  });
  let browser;
  try {
    await server.listen();
    const { chromium } = await import(pathToFileURL(path.join(root, 'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const state = createSeed('2026-11-08T00:00:00Z');
    state.role = 'manager';
    const project = state.deals[0];
    const personTopic = { topic: 'preference', title: '文案偏好', body: '先给三条可用话术。', sourceIds: ['turn-1', 'turn-2'], updatedAt: '2026-11-08T03:00:00Z', version: 1 };
    const relatedTopic = { ...personTopic, topic: 'wording', title: '话术风格', body: '保留简明的措辞。', sourceIds: ['turn-1'] };
    const projectTopic = { ...personTopic, topic: 'practice', title: '项目沟通做法', body: '先确认现场使用限制。', version: 3 };
    const requests = [];
    let enabled = true;
    let pending = 2;
    let forgotten = false;
    await page.route('**/api/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === '/api/workbench') return route.fulfill({ json: state });
      if (url.pathname !== '/api/agent-memory') return route.fulfill({ json: { pendingCount: 0 } });
      const action = request.method() === 'POST' ? request.postDataJSON() : null;
      const projectId = action?.projectId ?? url.searchParams.get('projectId');
      const topic = url.searchParams.get('topic');
      if (topic) {
        requests.push({ projectId, topic });
        return route.fulfill({ json: { sources: [{ runId: 'turn-1', query: '客户请先确认现场使用限制。', createdAt: '2026-11-08T03:00:00Z' }] } });
      }
      requests.push(action ?? { projectId });
      if (action?.action === 'setEnabled') enabled = action.enabled;
      if (action?.action === 'dream') {
        if (pending === 2) {
          pending = 1;
          return route.fulfill({ status: 503, json: { error: '测试整理暂不可用' } });
        }
        pending = 0;
      }
      if (action?.action === 'forgetTopic') forgotten = true;
      return route.fulfill({ json: { enabled, pending, topics: projectId ? forgotten ? [] : [projectTopic] : [personTopic, relatedTopic] } });
    });
    await page.goto(`${server.resolvedUrls.local[0]}?view=deals&deal=${project.id}`);
    await page.getByRole('button', { name: 'AI 营销助手', exact: true }).click();
    const chat = page.getByRole('dialog', { name: 'AI 营销助手', exact: true });
    await chat.getByLabel('描述你的任务').fill('保留我的聊天草稿');
    await chat.getByRole('button', { name: '查看个人记忆' }).click();
    const memory = page.getByRole('dialog', { name: '助手记忆', exact: true });
    await memory.locator('summary').getByText('文案偏好', { exact: true }).click();
    assert.equal(await memory.getByText(personTopic.body, { exact: true }).isVisible(), true);
    assert.equal(await memory.getByText('2 条原始记录', { exact: true }).isVisible(), true);
    assert.equal(await memory.getByText('2 条记录待整理', { exact: true }).isVisible(), true);
    await memory.locator('.agent-memory-related').getByRole('button', { name: relatedTopic.title, exact: true }).click();
    assert.equal(await memory.getByText(relatedTopic.body, { exact: true }).isVisible(), true);
    await memory.getByRole('button', { name: '立即整理' }).click();
    await memory.getByRole('alert').getByText('测试整理暂不可用').waitFor();
    await memory.getByRole('button', { name: '立即整理' }).click();
    await memory.getByText('整理完成').waitFor();
    await memory.getByRole('switch', { name: '使用跨对话记忆' }).click();
    await memory.getByRole('switch', { checked: false }).waitFor();
    assert.equal(await memory.getByRole('button', { name: '立即整理' }).isDisabled(), true);
    await page.keyboard.press('Escape');
    assert.equal(await chat.getByLabel('描述你的任务').inputValue(), '保留我的聊天草稿');
    await chat.getByRole('button', { name: '关闭', exact: true }).click();

    await page.getByRole('button', { name: '企业画像与摘要', exact: true }).click();
    const profile = page.getByRole('region', { name: '企业画像与摘要', exact: true });
    await profile.locator('summary').getByText('助手记忆', { exact: true }).click();
    const projectMemory = profile.getByRole('region', { name: '项目记忆', exact: true });
    await projectMemory.getByText('项目沟通做法', { exact: true }).click();
    assert.equal(await projectMemory.getByText(personTopic.title, { exact: true }).count(), 0);
    await projectMemory.getByRole('button', { name: '查看依据' }).click();
    await projectMemory.getByText('客户请先确认现场使用限制。', { exact: true }).waitFor();
    await projectMemory.getByRole('button', { name: '忘记此主题' }).click();
    await projectMemory.getByRole('button', { name: '取消' }).click();
    assert.equal(requests.some(request => request.action === 'forgetTopic'), false);
    await projectMemory.getByRole('button', { name: '忘记此主题' }).click();
    await projectMemory.getByRole('button', { name: '确定忘记' }).click();
    await projectMemory.getByText('暂无已核对的记忆').waitFor();
    assert.deepEqual(requests, [
      { projectId: null }, { action: 'dream' }, { action: 'dream' }, { action: 'setEnabled', enabled: false },
      { projectId: project.id }, { projectId: project.id, topic: projectTopic.topic },
      { action: 'forgetTopic', projectId: project.id, topic: projectTopic.topic, version: 3 },
    ]);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await projectMemory.evaluate(element => element.scrollWidth > element.clientWidth), false);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});
