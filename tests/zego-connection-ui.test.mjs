import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('../', import.meta.url));
const initial = { configured: true, enabled: false, storageReady: true, liveReady: false, customizationMode: 'zego_platform', appId: '123456', agentId: 'registered-agent', hasSecret: true, version: 3, avatarGrants: [] };
const members = [
  { accountId: 'member-sales', salesId: 'different-sales-id', username: 'sales', displayName: '销售甲', role: 'sales', enabled: true },
  { accountId: 'member-manager', username: 'manager', displayName: '经理乙', role: 'manager', enabled: true },
  { accountId: 'disabled-sales', username: 'disabled', displayName: '已停用丙', role: 'sales', enabled: false },
  { accountId: 'member-admin', username: 'admin', displayName: '管理员丁', role: 'admin', enabled: true },
];

async function fixture(run) {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'zego-settings-ui-'));
  const source = `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import ZegoConnectionSettings from '/app/components/ZegoConnectionSettings.tsx';function App(){const [updates,setUpdates]=useState(0);return <><ZegoConnectionSettings onConnectionChanged={async()=>setUpdates(n=>n+1)}/><output aria-label="更新次数">{updates}</output></>};createRoot(document.getElementById('root')).render(<App/>);`;
  const server = await createServer({ root, configFile: false, cacheDir, logLevel: 'silent', resolve: { dedupe: ['react', 'react-dom'] }, optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'] }, plugins: [react(), {
    name: 'zego-settings-fixture',
    resolveId(id) { if (id === '/__zego-settings.jsx') return path.join(root, '__zego-settings.jsx'); },
    load(id) { if (id === path.join(root, '__zego-settings.jsx')) return source; },
    configureServer(vite) { vite.middlewares.use(async (request, response, next) => {
      if (request.url !== '/') return next();
      response.setHeader('Content-Type', 'text/html');
      response.end(await vite.transformIndexHtml('/', '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:16px;font-family:Arial,sans-serif"><div id="root"></div><script type="module" src="/__zego-settings.jsx"></script></body></html>'));
    }); },
  }], server: { host: '127.0.0.1', port: 0, hmr: false } });
  let browser;
  try {
    await server.listen();
    const { chromium } = await import(pathToFileURL(path.join(root, 'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    page.setDefaultTimeout(7000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/workspace-members', route => route.fulfill({ json: { members } }));
    const origin = server.resolvedUrls.local[0];
    await run(page, origin, errors);
  } finally {
    await browser?.close();
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
}

test('ZEGO settings save member-account grants and preserve a blank saved secret without starting live work', { timeout: 45000 }, async () => {
  await fixture(async (page, origin, errors) => {
    const writes = [];
    const unexpected = [];
    let stored = { ...initial };
    await page.route('**/api/digital-humans**', route => { unexpected.push(route.request().url()); return route.abort(); });
    await page.route('**/api/zego-connection', route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { connection: stored } });
      const body = route.request().postDataJSON(); writes.push(body);
      stored = { ...stored, appId: body.appId, agentId: body.agentId, enabled: body.enabled, avatarGrants: body.avatarGrants, version: 4 };
      return route.fulfill({ json: { connection: stored, message: '连接已保存' } });
    });
    await page.goto(origin);
    await page.getByRole('button', { name: '保存数字人连接', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('input[autocomplete="off"]')?.value === '123456');
    assert.equal(writes.length, 0);
    await page.getByRole('button', { name: '添加形象授权', exact: true }).click();
    const options = await page.getByLabel('授权成员 1', { exact: true }).locator('option').evaluateAll(nodes => nodes.map(n => n.value));
    assert.deepEqual(options, ['', 'member-sales', 'member-manager']);
    await page.getByLabel('私有形象 ID 1', { exact: true }).fill('private-avatar');
    await page.getByLabel('授权成员 1', { exact: true }).selectOption('member-sales');
    await page.getByLabel('启用数字人服务', { exact: true }).check();
    await page.getByRole('button', { name: '保存数字人连接', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '连接已保存' }).waitFor();
    assert.deepEqual(writes, [{ action: 'save', version: 3, appId: '123456', agentId: 'registered-agent', secret: '', enabled: true, avatarGrants: [{ digitalHumanId: 'private-avatar', memberId: 'member-sales' }] }]);
    assert.equal(await page.getByLabel(/ServerSecret/).inputValue(), '');
    assert.match(await page.getByLabel(/ServerSecret/).getAttribute('type'), /^password$/);
    assert.equal(await page.getByLabel('更新次数').textContent(), '1');
    assert.deepEqual(unexpected, []);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    await page.reload();
    await page.getByLabel('私有形象 ID 1', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('授权成员 1', { exact: true }).inputValue(), 'member-sales');
    assert.equal(await page.getByLabel(/ServerSecret/).inputValue(), '');
    for (const [width, height] of [[1100, 36], [390, 44]]) {
      await page.setViewportSize({ width, height: 900 });
      for (const input of [page.getByLabel('AppID', { exact: true }), page.getByLabel('授权成员 1', { exact: true })]) {
        const bounds = await input.boundingBox();
        assert.equal(bounds.height, height);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    assert.deepEqual(errors, []);
  });
});

test('readonly connection test keeps unsaved nonsecret drafts, clears tested secret and distinguishes list access from live readiness', { timeout: 45000 }, async () => {
  await fixture(async (page, origin, errors) => {
    const writes = [];
    await page.route('**/api/zego-connection', route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { connection: initial } });
      writes.push(route.request().postDataJSON());
      return route.fulfill({ json: { connection: { ...initial, version: 9 }, message: '形象列表读取成功' } });
    });
    await page.goto(origin);
    await page.getByLabel('已注册 AgentId（直播前填写）', { exact: true }).fill('draft-agent');
    await page.getByLabel(/ServerSecret/).fill('fixture-secret-never-live');
    await page.getByRole('button', { name: '只读测试连接', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '形象列表读取成功' }).waitFor();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].action, 'test');
    assert.equal(writes[0].agentId, 'draft-agent');
    assert.equal(writes[0].secret, 'fixture-secret-never-live');
    assert.equal(await page.getByLabel('已注册 AgentId（直播前填写）', { exact: true }).inputValue(), 'draft-agent');
    assert.equal(await page.getByLabel(/ServerSecret/).inputValue(), '');
    assert.match(await page.getByRole('status').filter({ hasText: '形象列表读取成功' }).textContent(), /重新输入.*保存/);
    assert.match(await page.locator('section').innerText(), /不代表.*AgentId.*TTS.*直播/);
    assert.equal(await page.locator('body').innerText().then(text => text.includes('fixture-secret-never-live')), false);
    assert.equal(await page.getByLabel('更新次数').textContent(), '0', 'readonly test does not announce a persisted configuration change');
    await page.getByRole('button', { name: '保存数字人连接', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('output').textContent === '1');
    assert.equal(writes[1].version, 3, 'readonly testing must not silently adopt a newer server version and overwrite concurrent edits');
    assert.deepEqual(errors, []);
  });
});

test('duplicate grants and in-flight submissions cannot overwrite configuration; conflicts retain draft for explicit reload', { timeout: 45000 }, async () => {
  await fixture(async (page, origin, errors) => {
    const writes = [];
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    await page.route('**/api/zego-connection', async route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { connection: initial } });
      writes.push(route.request().postDataJSON()); await pending;
      return route.fulfill({ status: 409, json: { message: '连接已被更新，请重新读取后保存' } });
    });
    await page.goto(origin);
    await page.getByRole('button', { name: '添加形象授权', exact: true }).click();
    await page.getByLabel('私有形象 ID 1', { exact: true }).fill('same-model');
    await page.getByLabel('授权成员 1', { exact: true }).selectOption('member-sales');
    await page.getByRole('button', { name: '添加形象授权', exact: true }).click();
    await page.getByLabel('私有形象 ID 2', { exact: true }).fill('same-model');
    await page.getByLabel('授权成员 2', { exact: true }).selectOption('member-manager');
    await page.getByRole('button', { name: '保存数字人连接', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '同一形象' }).waitFor();
    assert.equal(writes.length, 0);
    await page.getByRole('button', { name: '移除形象授权 2', exact: true }).click();
    await page.getByLabel(/ServerSecret/).fill('fixture-unsaved-key');
    await page.getByRole('button', { name: '保存数字人连接', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('button[type="submit"]').matches(':disabled'));
    await page.locator('form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(writes.length, 1);
    assert.equal(await page.getByLabel('AppID', { exact: true }).isDisabled(), true);
    release();
    await page.getByRole('alert').filter({ hasText: '连接已被更新' }).waitFor();
    assert.equal(await page.getByLabel(/ServerSecret/).inputValue(), 'fixture-unsaved-key');
    assert.equal(await page.getByLabel('私有形象 ID 1', { exact: true }).inputValue(), 'same-model');
    await page.getByRole('button', { name: '重新读取数字人连接', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('input[type="password"]').value === '');
    assert.equal(await page.getByLabel('私有形象 ID 1', { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
  });
});

test('failed member loading cannot erase existing private grants through a save', { timeout: 45000 }, async () => {
  await fixture(async (page, origin, errors) => {
    let available = false;
    let writes = 0;
    await page.route('**/api/workspace-members', route => available
      ? route.fulfill({ json: { members } })
      : route.fulfill({ status: 503, json: { message: '成员列表暂时不可用' } }));
    await page.route('**/api/zego-connection', route => {
      if (route.request().method() !== 'GET') writes++;
      return route.fulfill({ json: { connection: { ...initial, avatarGrants: [{ digitalHumanId: 'kept-model', memberId: 'member-sales' }] } } });
    });
    await page.goto(origin);
    await page.getByRole('alert').filter({ hasText: '成员列表暂时不可用' }).waitFor();
    assert.equal(await page.getByLabel('私有形象 ID 1', { exact: true }).inputValue(), 'kept-model');
    assert.equal(await page.getByRole('button', { name: '保存数字人连接', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '添加形象授权', exact: true }).isDisabled(), true);
    available = true;
    await page.getByRole('button', { name: '重新读取数字人连接', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('button[type="submit"]').matches(':disabled'));
    assert.equal(await page.getByLabel('授权成员 1', { exact: true }).inputValue(), 'member-sales');
    assert.equal(writes, 0);
    assert.deepEqual(errors, []);
  });
});

test('model-only configuration saves and tests without AgentId while rejecting AppIDs outside uint32', { timeout: 45000 }, async () => {
  await fixture(async (page, origin, errors) => {
    const writes = [];
    const liveRequests = [];
    let stored = { ...initial, agentId: '', enabled: true, liveReady: false };
    await page.route('**/api/digital-humans**', route => { liveRequests.push(route.request().url()); return route.abort(); });
    await page.route('**/api/zego-connection', route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { connection: stored } });
      const body = route.request().postDataJSON();
      writes.push(body);
      if (body.action === 'save') stored = { ...stored, appId: body.appId, agentId: body.agentId, version: stored.version + 1 };
      return route.fulfill({ json: { connection: stored, message: body.action === 'save' ? '配置已保存' : '形象列表读取成功' } });
    });
    await page.goto(origin);
    await page.getByLabel('AppID', { exact: true }).fill('0');
    await page.getByRole('button', { name: '只读测试连接', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'AppID' }).waitFor();
    assert.equal(writes.length, 0);
    await page.getByLabel('AppID', { exact: true }).fill('4294967296');
    await page.getByRole('button', { name: '只读测试连接', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'AppID' }).waitFor();
    assert.equal(writes.length, 0);
    await page.getByLabel('AppID', { exact: true }).fill('4294967295');
    await page.getByRole('button', { name: '保存数字人连接', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '配置已保存' }).waitFor();
    await page.getByRole('button', { name: '只读测试连接', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '形象列表读取成功' }).waitFor();
    assert.deepEqual(writes.map(({ action, appId, agentId }) => ({ action, appId, agentId })), [
      { action: 'save', appId: '4294967295', agentId: '' },
      { action: 'test', appId: '4294967295', agentId: '' },
    ]);
    assert.match(await page.locator('section').innerText(), /直播前.*AgentId/);
    assert.deepEqual(liveRequests, []);
    assert.deepEqual(errors, []);
  });
});
