import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('../', import.meta.url));
const defaultPolicy = () => ({ libraryIds: [], replyDailyLimit: 30, conversationReplyLimit: 12, workStart: '08:30', workEnd: '21:30' });
const fixture = `
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ProspectingConversations } from '/app/components/ProspectingConversations.tsx';
import '/app/globals.css';
import '/app/components/prospecting-workspace.css';
function Fixture() {
  const [campaignId, setCampaign] = useState('campaign-a');
  const [blocked, setBlocked] = useState(false);
  useEffect(() => { window.__chatFixture = { setCampaign, setBlocked }; }, []);
  return <main className="prospect-workspace" style={{ display: 'block', maxWidth: 1200, margin: 'auto', padding: 16 }}><ProspectingConversations key={campaignId} campaignId={campaignId} active view="chat" blocked={blocked} paused={false} modelReady assistantOnline sendingAvailable resetKey={0} onViewChange={() => {}} onDirtyChange={dirty => { window.__chatDirty = dirty; }} onBusyChange={() => {}} /></main>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
`;

test('conversation settings preserve drafts, save the loaded enabled state, and block closed replies on desktop and mobile', { timeout: 60000 }, async () => {
  // Only an isolated local fixture is opened. All application API calls are mocked.
  const { chromium } = await import(pathToFileURL(path.join(root, 'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'conversation-ui-vite-'));
  const server = await createServer({
    resolve: { dedupe: ['react', 'react-dom'] }, cacheDir, optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react'] },
    root, configFile: false, logLevel: 'error', plugins: [react(), {
      name: 'conversation-test-fixture',
      resolveId(id) { if (id === '/__conversation-fixture.jsx') return path.join(root, '__conversation-fixture.jsx'); },
      load(id) { if (id === path.join(root, '__conversation-fixture.jsx')) return fixture; },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url !== '/') return next();
          response.setHeader('Content-Type', 'text/html');
          response.end(await server.transformIndexHtml('/', '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__conversation-fixture.jsx"></script></body></html>'));
        });
      },
    }], server: { host: '127.0.0.1', port: 0, hmr: false },
  });
  await server.listen();
  const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
  const posts = [];
  const errors = [];
  let reads = 0;
  let rejectSave = false;
  let enabled = false;
  const policies = { 'campaign-a': defaultPolicy(), 'campaign-b': defaultPolicy() };
  const snapshot = campaignId => {
    const base = { campaignId, leadId: 'lead-1', recipientId: 'recipient-1', profileUrl: '', mode: 'human', status: 'active', version: 1, lastMessageAt: '2026-11-07T08:00:00Z', lastMessagePreview: '想了解面积和预算', updatedAt: '2026-11-07T08:00:00Z' };
    return { enabled, online: true, policy: policies[campaignId], libraries: [{ id: 'public-info', name: '已审核招商资料' }, { id: 'public-faq', name: '客户常见问题' }], conversations: [
      { ...base, id: 'conversation-1', nickname: '王女士', memory: { needs: { area: '80–100 平方米', category: '咖啡', budget: '每月 1.5 万元', location: '一楼临街', timing: '明年三月', visit: '周五下午' }, stage: 'qualifying', contactCaptured: false, contactDeclines: 1, contactAsks: 2, summary: '希望临街，待确认租期。' } },
      { ...base, id: 'conversation-closed', nickname: '已退订客户', status: 'closed', closeReason: '客户明确要求停止联系', memory: { needs: {}, stage: 'closed', contactCaptured: false, contactDeclines: 2, contactAsks: 2, summary: '' } },
    ], messages: Array.from({ length: 22 }, (_, index) => ({ id: `message-${index}`, conversationId: 'conversation-1', direction: index % 2 ? 'outbound' : 'inbound', actor: index % 2 ? 'human' : 'customer', text: index % 2 ? '可以，下次为您确认具体条件。' : `需求沟通记录 ${index + 1}：希望了解具体铺位条件。`, status: index % 2 ? 'sent' : 'received', createdAt: '2026-11-07T08:00:00Z' })), pool: [] };
  };
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, serviceWorkers: 'block' });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort('blockedbyclient');
      if (url.pathname !== '/api/prospecting') return route.continue();
      if (route.request().method() === 'GET') {
        reads++;
        return route.fulfill({ json: snapshot(url.searchParams.get('campaignId') || 'campaign-a') });
      }
      const payload = route.request().postDataJSON();
      posts.push(payload);
      if (payload.policy && rejectSave) return route.fulfill({ status: 409, json: { error: '保存冲突，请重试。' } });
      if (payload.action === 'chatSettings') {
        enabled = payload.enabled;
        if (payload.policy) policies[payload.campaignId] = payload.policy;
      }
      return route.fulfill({ json: { message: '会话设置已保存。', chat: snapshot(payload.campaignId) } });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.getByRole('button', { name: '开启 AI 跟进', exact: true }).waitFor();
    await page.locator('.prospect-chat-agent-settings > summary').click();
    assert.equal(await page.getByRole('checkbox', { checked: true }).count(), 0, 'No library is shared by default');
    assert.equal(await page.getByLabel('每日回复上限', { exact: true }).inputValue(), '30');
    assert.equal(await page.getByLabel('单会话回复上限', { exact: true }).inputValue(), '12');
    assert.equal(await page.getByLabel('开始时间', { exact: true }).inputValue(), '08:30');
    await page.getByLabel('每日回复上限', { exact: true }).fill('17');
    await page.getByRole('checkbox', { name: '已审核招商资料' }).check();
    await page.waitForFunction(() => window.__chatDirty === true);
    const priorReads = reads;
    await page.waitForResponse(response => response.url().includes('/api/prospecting?') && response.request().method() === 'GET');
    assert.equal(await page.getByLabel('每日回复上限', { exact: true }).inputValue(), '17', 'Periodic refresh preserves unsaved settings');
    await page.getByRole('button', { name: '立即同步', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.prospect-chat-agent-settings input[type="number"]')?.value === '17');
    assert.equal(await page.getByLabel('每日回复上限', { exact: true }).inputValue(), '17');
    assert.equal(await page.getByRole('checkbox', { name: '已审核招商资料' }).isChecked(), true);
    await page.getByRole('button', { name: '开启 AI 跟进', exact: true }).click();
    await page.getByRole('button', { name: '关闭 AI 跟进', exact: true }).waitFor();
    assert.equal(await page.getByLabel('每日回复上限', { exact: true }).inputValue(), '17', 'Enabled-only responses preserve pending settings');
    assert.equal(posts.find(item => item.action === 'chatSettings').policy, undefined);
    rejectSave = true;
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.getByText('保存冲突，请重试。', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('每日回复上限', { exact: true }).inputValue(), '17');
    assert.equal(await page.evaluate(() => window.__chatDirty), true);
    rejectSave = false;
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.waitForFunction(() => window.__chatDirty === false);
    const saved = posts.findLast(item => item.policy);
    assert.equal(saved.enabled, true, 'Saving settings uses the loaded enabled state');
    assert.deepEqual(saved.policy, { ...defaultPolicy(), libraryIds: ['public-info'], replyDailyLimit: 17 });
    assert.ok(reads > priorReads, 'Mutation completion refreshed the server snapshot');
    await page.getByLabel('开始时间', { exact: true }).fill('22:00');
    assert.equal(await page.getByRole('button', { name: '保存设置', exact: true }).isDisabled(), true);
    await page.getByText('请选择有效的工作时间，开始时间须早于结束时间。').waitFor();
    await page.getByLabel('开始时间', { exact: true }).fill('08:30');
    await page.getByRole('textbox', { name: '人工回复客户', exact: true }).fill('仅用于测试的未发送草稿');
    await page.locator('.prospect-chat-needs > summary').click();
    await page.getByText('80–100 平方米', { exact: true }).waitFor();
    await page.getByText('留资询问 2 次 · 拒绝 1 次', { exact: true }).waitFor();
    const transcript = page.getByRole('log');
    await transcript.evaluate(el => { el.dispatchEvent(new WheelEvent('wheel')); el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
    await page.getByRole('button', { name: '查看最新消息', exact: true }).waitFor();
    await page.getByRole('button', { name: '查看最新消息', exact: true }).click();
    assert.ok(await transcript.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight < 50));
    const geometry = await page.getByLabel('每日回复上限', { exact: true }).boundingBox();
    assert.equal(geometry.height, 36);
    const captureDir = process.env.PROSPECT_UI_CAPTURE_DIR;
    if (captureDir) { await mkdir(captureDir, { recursive: true }); await page.screenshot({ path: path.join(captureDir, 'chat-desktop.png'), fullPage: true }); }
    await page.getByRole('button', { name: /已退订客户/ }).click();
    await page.getByText('会话已结束：客户明确要求停止联系', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '交还 AI 助手', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '发送回复', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('textbox', { name: '人工回复客户', exact: true }).isDisabled(), true);
    assert.equal(posts.filter(item => ['chatReply', 'chatResume'].includes(item.action)).length, 0);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.getByLabel('每日回复上限', { exact: true }).evaluate(el => getComputedStyle(el).height), '44px');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Mobile layout must not overflow');
    if (captureDir) await page.screenshot({ path: path.join(captureDir, 'chat-mobile.png'), fullPage: true });
    await page.getByRole('button', { name: '会话列表', exact: true }).click();
    await page.getByRole('button', { name: /王女士/ }).click();
    assert.equal(await page.getByRole('textbox', { name: '人工回复客户', exact: true }).inputValue(), '仅用于测试的未发送草稿');
    await page.evaluate(() => window.__chatFixture.setBlocked(true));
    assert.equal(await page.getByRole('button', { name: '关闭 AI 跟进', exact: true }).isDisabled(), true);
    assert.equal(await page.getByLabel('每日回复上限', { exact: true }).isDisabled(), true);
    await page.evaluate(() => { window.__chatFixture.setBlocked(false); window.__chatFixture.setCampaign('campaign-b'); });
    await page.getByLabel('每日回复上限', { exact: true }).waitFor({ state: 'attached' });
    assert.equal(await page.getByLabel('每日回复上限', { exact: true }).inputValue(), '30', 'Campaign remount resets settings');
    assert.equal(await page.getByRole('checkbox', { checked: true }).count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});
