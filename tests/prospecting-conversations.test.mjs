import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('../', import.meta.url));
const defaultPolicy = () => ({ libraryIds: [], replyDailyLimit: 30, conversationReplyLimit: 12, replyHoursEnabled: false, workStart: '08:30', workEnd: '21:30' });
const fixture = `
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ProspectingConversations } from '/app/components/ProspectingConversations.tsx';
import '/app/globals.css';
import '/app/components/prospecting-workspace.css';
function Fixture() {
  const [campaignId, setCampaign] = useState('campaign-a');
  const [blocked, setBlocked] = useState(false);
  const [view, setView] = useState('chat');
  useEffect(() => { window.__chatFixture = { setCampaign, setBlocked, setView }; }, []);
  return <main className="prospect-workspace" style={{ display: 'block', maxWidth: 1200, margin: 'auto', padding: 16 }}><ProspectingConversations key={campaignId} campaignId={campaignId} active view={view} blocked={blocked} paused={false} modelReady assistantOnline sendingAvailable resetKey={0} onViewChange={setView} onDirtyChange={dirty => { window.__chatDirty = dirty; }} onBusyChange={() => {}} /></main>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
`;

async function createConversationFixture() {
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
  return { server, origin, cacheDir };
}

test('conversation settings preserve drafts, save the loaded enabled state, and block closed replies on desktop and mobile', { timeout: 60000 }, async () => {
  // Only an isolated local fixture is opened. All application API calls are mocked.
  const { chromium } = await import(pathToFileURL(path.join(root, 'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);
  const { server, origin, cacheDir } = await createConversationFixture();
  const posts = [];
  const errors = [];
  let reads = 0;
  let rejectSave = false;
  let enabled = false;
  let handoffReason = '客户主动要求人工沟通，请直接跟进。';
  let syncStatus = 'failed';
  let syncError = '读取会话期间登录账号发生变化。';
  let lastSyncedAt = '2026-11-07T07:45:00Z';
  const policies = { 'campaign-a': defaultPolicy(), 'campaign-b': defaultPolicy() };
  const snapshot = campaignId => {
    const base = { campaignId, leadId: 'lead-1', recipientId: 'recipient-1', profileUrl: '', mode: 'human', status: 'active', version: 1, lastMessageAt: '2026-11-07T08:00:00Z', lastMessagePreview: '想了解面积和预算', handoffReason, lastSyncedAt, updatedAt: '2026-11-07T08:00:00Z' };
    return { enabled, online: true, policy: policies[campaignId], libraries: [{ id: 'public-info', name: '已审核招商资料' }, { id: 'public-faq', name: '客户常见问题' }], conversations: [
      { ...base, id: 'conversation-1', nickname: '王女士', taskMemory: {sessionId:'session-a',campaignId,activeCampaignId:campaignId,isActive:true,ready:true,sessionVersion:1,bindingVersion:1,state:{schemaVersion:2,facts:[{id:'area-fact',key:'area',value:'80–100 平方米',status:'confirmed',sourceMessageId:'message-0',sourceText:'希望80–100平方米',actor:'customer',sourceAt:'2026-11-07T08:00:00Z',updatedAt:'2026-11-07T08:00:00Z'}],events:[],ignoredSourceIds:[],sourceWatermark:1,summary:'希望临街，待确认租期。',updatedAt:'2026-11-07T08:00:00Z',contact:{captured:false,declined:true,submittedInvites:1,legacyInvites:1,pendingInvites:0,uncertainInvites:0}}}, memory: { needs: { area: '80–100 平方米', category: '咖啡', budget: '每月 1.5 万元', location: '一楼临街', timing: '明年三月', visit: '周五下午' }, stage: 'qualifying', contactCaptured: false, contactDeclines: 1, contactAsks: 2, summary: '希望临街，待确认租期。' } },
      { ...base, id: 'conversation-closed', nickname: '已退订客户', status: 'closed', closeReason: '客户明确要求停止联系', memory: { needs: {}, stage: 'closed', contactCaptured: false, contactDeclines: 2, contactAsks: 2, summary: '' } },
    ], sync: { conversationId: 'conversation-1', status: syncStatus, updatedAt: '2026-11-07T08:00:00Z', ...(syncError ? { error: syncError } : {}) }, messages: Array.from({ length: 22 }, (_, index) => ({ id: `message-${index}`, conversationId: 'conversation-1', direction: index % 2 ? 'outbound' : 'inbound', actor: index % 2 ? 'human' : 'customer', text: index % 2 ? '可以，下次为您确认具体条件。' : `需求沟通记录 ${index + 1}：希望了解具体铺位条件。`, status: index % 2 ? 'sent' : 'received', createdAt: '2026-11-07T08:00:00Z' })), pool: [] };
  };
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, timezoneId: 'Asia/Shanghai', serviceWorkers: 'block' });
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
      if (payload.action === 'chatSync') { syncStatus = 'done'; syncError = '会话面板读取失败。'; }
      if (payload.policy && rejectSave) return route.fulfill({ status: 409, json: { error: '保存冲突，请重试。' } });
      if (payload.action === 'chatSettings') {
        enabled = payload.enabled;
        if (payload.policy) policies[payload.campaignId] = payload.policy;
      }
      return route.fulfill({ json: { message: '会话设置已保存。', chat: snapshot(payload.campaignId) } });
    });
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date('2026-11-07T18:00:00Z')); // 02:00 in Shanghai.
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    const roster = page.getByRole('list', { name: '客户会话', exact: true });
    await roster.waitFor();
    const panel = page.getByRole('complementary', { name: '王女士', exact: true });
    assert.equal(await page.locator('.prospect-chat-panel').count(), 0, 'No conversation is selected automatically');
    const wang = roster.getByRole('button', { name: '查看王女士详情', exact: true });
    const closed = roster.getByRole('button', { name: '查看已退订客户详情', exact: true });
    const wangRow = roster.getByRole('listitem').filter({ has: page.getByRole('button', { name: '查看王女士详情', exact: true }) });
    const closedRow = roster.getByRole('listitem').filter({ has: page.getByRole('button', { name: '查看已退订客户详情', exact: true }) });
    await wangRow.getByText('未评估', { exact: true }).waitFor();
    await wangRow.getByText('需人工处理', { exact: true }).waitFor();
    await closedRow.getByText('已结束', { exact: true }).waitFor();
    assert.equal(await roster.getByText('想了解面积和预算', { exact: true }).count(), 0, 'The roster does not expose message previews');
    const username = await wang.getByText('王女士', { exact: true }).boundingBox();
    for (const label of ['未评估', '需人工处理']) {
      const metadata = await wangRow.getByText(label, { exact: true }).boundingBox();
      assert.ok(metadata.y >= username.y + username.height - 1, `${label} appears below the username`);
    }
    const description = await wang.evaluate(button => (button.getAttribute('aria-describedby') ?? '').split(/\s+/)
      .map(id => document.getElementById(id)?.textContent ?? '').join(' '));
    assert.match(description, /未评估/);
    assert.match(description, /需人工处理/);
    const settings = page.getByRole('button', { name: /^跟进设置/ });
    const closeSettings = page.getByRole('button', { name: '关闭跟进设置', exact: true });
    const tools = panel.getByRole('button', { name: '会话工具', exact: true });
    const openTools = async () => {
      if (await tools.getAttribute('aria-expanded') !== 'true') await tools.click();
    };
    await wang.click();
    await panel.getByRole('heading', { name: '王女士', exact: true }).waitFor();
    await panel.locator('header').getByRole('button', { name: '立即同步', exact: true }).waitFor();
    assert.equal(await tools.getAttribute('aria-expanded'), 'false');
    assert.equal(await panel.locator('.prospect-memory').isVisible(), false);
    await openTools();
    const toolsRegion = panel.getByRole('region', { name: '会话工具', exact: true });
    await toolsRegion.getByText(handoffReason, { exact: true }).waitFor();
    await toolsRegion.getByRole('button', { name: '提炼话术 Skill / 重试', exact: true }).press('Escape');
    await toolsRegion.waitFor({ state: 'hidden' });
    assert.equal(await tools.evaluate(button => button === document.activeElement), true);
    assert.equal(await panel.isVisible(), true, 'closing conversation tools leaves the transcript open');
    const expectWideDetail = async width => {
      await page.setViewportSize({ width, height: 1000 });
      const [rosterBounds, panelBounds] = await Promise.all([roster.boundingBox(), panel.boundingBox()]);
      assert.ok(panelBounds.x >= rosterBounds.x + rosterBounds.width - 1, `The detail occupies the right pane at ${width}px`);
      const splitWidth = panelBounds.x + panelBounds.width - rosterBounds.x;
      assert.ok(panelBounds.width / splitWidth >= 0.7, `The detail has at least 70% of the workspace at ${width}px`);
    };
    await expectWideDetail(960);
    await expectWideDetail(1280);
    const syncDetails = page.locator('.prospect-chat-sync-status');
    await syncDetails.locator(`time[datetime="${lastSyncedAt}"]`).waitFor();
    assert.match(await syncDetails.textContent(), /上次同步.*15:45/);
    assert.match(await syncDetails.textContent(), /同步失败/);
    assert.match(await syncDetails.textContent(), /核验.*账号.*重新同步/);
    assert.doesNotMatch(await syncDetails.textContent(), /16:00/, 'A job completion or GET refresh must not replace the platform observation time');
    await settings.click();
    assert.equal(await page.getByRole('checkbox', { checked: true }).count(), 2, 'All server-authorized department and shared libraries are mandatory');
    assert.equal(await page.getByLabel('每日回复上限', { exact: true }).inputValue(), '30');
    assert.equal(await page.getByLabel('单会话回复上限', { exact: true }).inputValue(), '12');
    assert.equal(await page.getByLabel('开始时间', { exact: true }).inputValue(), '08:30');
    const replyHours = page.getByRole('checkbox', { name: '限定回复时段', exact: true });
    assert.equal(await replyHours.isChecked(), false);
    await page.getByText('全天回复', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('开始时间', { exact: true }).isDisabled(), true);
    assert.equal(await page.getByLabel('结束时间', { exact: true }).isDisabled(), true);
    await replyHours.check();
    await page.getByLabel('开始时间', { exact: true }).fill('09:00');
    await page.getByLabel('结束时间', { exact: true }).fill('18:00');
    await page.getByLabel('每日回复上限', { exact: true }).fill('17');
    assert.equal(await page.getByRole('checkbox', { name: '已审核招商资料' }).isDisabled(), true);
    await page.waitForFunction(() => window.__chatDirty === true);
    const priorReads = reads;
    await page.waitForResponse(response => response.url().includes('/api/prospecting?') && response.request().method() === 'GET');
    assert.equal(await page.getByLabel('每日回复上限', { exact: true }).inputValue(), '17', 'Periodic refresh preserves unsaved settings');
    assert.equal(await replyHours.isChecked(), true, 'Periodic refresh preserves the unsaved hours switch');
    assert.equal(await page.getByLabel('开始时间', { exact: true }).inputValue(), '09:00');
    await replyHours.uncheck();
    assert.equal(await page.getByLabel('开始时间', { exact: true }).isDisabled(), true);
    assert.equal(await page.getByLabel('开始时间', { exact: true }).inputValue(), '09:00', 'Turning off limits preserves the edited window');
    await closeSettings.click();
    await page.getByRole('button', { name: '立即同步', exact: true }).click();
    await syncDetails.getByText('同步失败：会话面板尚未就绪，请在抖音打开此会话后重新同步。', { exact: true }).waitFor();
    assert.equal(syncStatus, 'done', 'A completed task with an error must still show a sync failure');
    assert.match(await syncDetails.textContent(), /15:45/);
    assert.doesNotMatch(await syncDetails.textContent(), /16:00/, 'Task completion must not advance the platform observation time');
    await openTools();
    assert.equal(await page.locator('.prospect-chat-takeover').getByText(handoffReason, { exact: true }).count(), 1, 'Synchronization status stays separate from the customer handoff reason');
    await settings.click();
    await page.waitForFunction(() => document.querySelector('.prospect-chat-policy input[type="number"]')?.value === '17');
    assert.equal(await page.getByLabel('每日回复上限', { exact: true }).inputValue(), '17');
    assert.equal(await page.getByRole('checkbox', { name: '已审核招商资料' }).isChecked(), true);
    syncError = undefined;
    await page.getByRole('button', { name: '开启 AI 跟进', exact: true }).click();
    await page.getByRole('button', { name: '关闭 AI 跟进', exact: true }).waitFor();
    await page.getByText('AI 助手在线', { exact: true }).waitFor();
    await closeSettings.click();
    assert.doesNotMatch(await syncDetails.textContent(), /同步已停滞/, 'A human-controlled conversation is outside routine automatic sync');
    await settings.click();
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
    assert.deepEqual(saved.policy, { ...defaultPolicy(), libraryIds: [], replyDailyLimit: 17, workStart: '09:00', workEnd: '18:00' });
    assert.ok(reads > priorReads, 'Mutation completion refreshed the server snapshot');
    await replyHours.check();
    await page.waitForFunction(() => window.__chatDirty === true);
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.waitForFunction(() => window.__chatDirty === false);
    assert.equal(posts.findLast(item => item.policy).policy.replyHoursEnabled, true, 'The switch alone is a saved policy change');
    await page.getByText('等待回复时段', { exact: true }).waitFor();
    await page.getByLabel('开始时间', { exact: true }).fill('22:00');
    assert.equal(await page.getByRole('button', { name: '保存设置', exact: true }).isDisabled(), true);
    await page.getByText('请选择有效的工作时间，开始时间须早于结束时间。').waitFor();
    await replyHours.uncheck();
    assert.equal(await page.getByRole('button', { name: '保存设置', exact: true }).isDisabled(), false, 'Turning off hours must clear an invalid disabled window');
    assert.equal(await page.getByLabel('开始时间', { exact: true }).inputValue(), '09:00');
    assert.equal(await page.getByLabel('结束时间', { exact: true }).inputValue(), '18:00');
    await replyHours.check();
    await page.getByLabel('开始时间', { exact: true }).fill('09:00');
    const replyInput = page.getByRole('textbox', { name: '人工回复客户', exact: true });
    await closeSettings.click();
    await replyInput.fill('仅用于测试的未发送草稿');
    await settings.click();
    await replyHours.uncheck();
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.getByRole('button', { name: '保存设置', exact: true }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('.prospect-chat-unsaved') === null);
    assert.equal(posts.findLast(item => item.policy).policy.replyHoursEnabled, false);
    assert.equal(await page.getByLabel('开始时间', { exact: true }).inputValue(), '09:00');
    assert.equal(await page.getByLabel('结束时间', { exact: true }).inputValue(), '18:00');
    await page.getByText('AI 助手在线', { exact: true }).waitFor();
    const geometry = await page.getByLabel('每日回复上限', { exact: true }).boundingBox();
    assert.equal(geometry.height, 36);
    await closeSettings.click();
    assert.equal(await replyInput.inputValue(), '仅用于测试的未发送草稿', 'Saving the hours switch preserves the manual reply draft');
    const composingKeys = await replyInput.evaluate(el => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中文' }));
      const results = [
        { ctrlKey: true, isComposing: true },
        { metaKey: true, isComposing: true },
        { ctrlKey: true, keyCode: 229 },
      ].map(init => el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', ...init })));
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }));
      return results;
    });
    assert.deepEqual(composingKeys, [true, true, true], 'IME shortcuts must keep their default composition behavior');
    assert.equal(await replyInput.inputValue(), '仅用于测试的未发送草稿');
    assert.equal(posts.filter(item => item.action === 'chatReply').length, 0, 'IME composition must not submit a reply');
    await openTools();
    await page.locator('.prospect-memory > summary').click();
    await page.getByText('80–100 平方米', { exact: true }).waitFor();
    await page.getByText('邀请已提交 1 次 · 待发送 0 次 · 待核对 0 次', { exact: true }).waitFor();
    await page.getByText('历史邀请待核实 1 次 · 未留资 · 已拒绝留资', { exact: true }).waitFor();
    const transcript = page.getByRole('log');
    await transcript.evaluate(el => { el.dispatchEvent(new WheelEvent('wheel')); el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
    await page.getByRole('button', { name: '查看最新消息', exact: true }).waitFor();
    await page.getByRole('button', { name: '查看最新消息', exact: true }).click();
    await page.waitForFunction(el => el.scrollHeight - el.scrollTop - el.clientHeight < 50, await transcript.elementHandle());
    const captureDir = process.env.PROSPECT_UI_CAPTURE_DIR;
    if (captureDir) { await mkdir(captureDir, { recursive: true }); await page.screenshot({ path: path.join(captureDir, 'chat-desktop.png'), fullPage: true }); }
    await closed.click();
    await page.getByText('会话已结束：客户明确要求停止联系', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '交还 AI 助手', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '发送回复', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('textbox', { name: '人工回复客户', exact: true }).isDisabled(), true);
    assert.equal(posts.filter(item => ['chatReply', 'chatResume'].includes(item.action)).length, 0);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Mobile layout must not overflow');
    assert.equal(await roster.isVisible(), false, 'Mobile shows just the selected detail');
    if (captureDir) await page.screenshot({ path: path.join(captureDir, 'chat-mobile.png'), fullPage: true });
    await page.getByRole('button', { name: '返回会话列表', exact: true }).click();
    await closed.waitFor();
    await wang.click();
    assert.equal(await page.getByRole('textbox', { name: '人工回复客户', exact: true }).inputValue(), '仅用于测试的未发送草稿');
    await settings.click();
    assert.equal(await page.getByLabel('每日回复上限', { exact: true }).evaluate(el => getComputedStyle(el).height), '44px');
    await page.evaluate(() => window.__chatFixture.setBlocked(true));
    await page.waitForFunction(() => document.querySelector('.prospect-chat-agent-toolbar button')?.disabled);
    assert.equal(await page.getByRole('button', { name: '关闭 AI 跟进', exact: true }).isDisabled(), true);
    assert.equal(await page.getByLabel('每日回复上限', { exact: true }).isDisabled(), true);
    await page.evaluate(() => { window.__chatFixture.setBlocked(false); window.__chatFixture.setCampaign('campaign-b'); });
    assert.equal(await page.getByRole('checkbox', { checked: true }).count(), 0, 'Settings are closed after campaign remount');
    await settings.click();
    assert.equal(await page.getByLabel('每日回复上限', { exact: true }).inputValue(), '30', 'Campaign remount resets settings');
    await closeSettings.click();
    handoffReason = undefined;
    lastSyncedAt = undefined;
    await page.waitForResponse(response => response.url().includes('/api/prospecting?') && response.request().method() === 'GET');
    await page.getByRole('button', { name: /王女士/ }).click();
    await openTools();
    await page.locator('.prospect-chat-takeover').getByText('未记录接管原因，请查看客户消息后继续跟进。', { exact: true }).waitFor();
    await syncDetails.getByText('尚未完成可靠同步', { exact: true }).waitFor();
    assert.equal(await syncDetails.locator('time').count(), 0, 'Legacy records without a platform sync time must not show the database refresh time');
    handoffReason = '涉及合同条款，请确认后回复。';
    await page.evaluate(() => window.__chatFixture.setCampaign(undefined));
    await page.getByRole('button', { name: /王女士/ }).click();
    await page.getByText('只读会话，接管与发送由原任务负责人操作。', { exact: true }).waitFor();
    await openTools();
    await page.locator('.prospect-chat-takeover').getByText(handoffReason, { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '发送回复', exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('verification waits stay one reply while legacy unsent attempts remain inspectable and genuine failures stay visible', { timeout: 60000 }, async () => {
  const { chromium } = await import(pathToFileURL(path.join(root, 'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);
  const { server, origin, cacheDir } = await createConversationFixture();
  const posts = [], errors = [];
  let phase = 'waiting';
  const replyText = '您希望在哪个区域找铺？';
  const legacy = [
    { id: 'legacy-1', text: '较早的一次未发送内容', error: '账号主页控件暂未就绪', createdAt: '2026-11-08T17:51:00Z' },
    { id: 'legacy-2', text: '另一次未发送内容', error: '账号核验尚未完成', createdAt: '2026-11-08T17:52:00Z' },
  ];
  const snapshot = () => ({
    enabled: true, online: true, policy: defaultPolicy(), libraries: [], pool: [],
    conversations: [{ id: 'conversation-1', campaignId: 'campaign-a', leadId: 'lead-1', recipientId: 'recipient-1', profileUrl: '', nickname: '王女士', mode: 'human', status: 'active', version: 1, lastMessageAt: '2026-11-08T18:00:00Z', lastMessagePreview: '想了解面积', lastSyncedAt: '2026-11-08T18:00:00Z', updatedAt: '2026-11-08T18:00:00Z' }],
    messages: [
      ...Array.from({ length: 16 }, (_, index) => ({ id: `history-${index}`, conversationId: 'conversation-1', direction: 'inbound', actor: 'customer', text: `之前的需求记录 ${index + 1}`, status: 'received', createdAt: '2026-11-08T17:50:00Z' })),
      ...legacy.map(message => ({ ...message, conversationId: 'conversation-1', direction: 'outbound', actor: 'agent', status: 'failed', retryable: true })),
      { id: 'genuine-failure', conversationId: 'conversation-1', direction: 'outbound', actor: 'human', text: '确实失败的回复', status: 'failed', error: '对方关闭了私信权限', createdAt: '2026-11-08T17:53:00Z' },
      { id: 'unknown-result', conversationId: 'conversation-1', direction: 'outbound', actor: 'human', text: '需要核对是否已发出的回复', status: 'unknown', retryable: true, error: '点击后连接中断，结果待确认', createdAt: '2026-11-08T17:54:00Z' },
      { id: 'stable-approved-reply', conversationId: 'conversation-1', direction: 'outbound', actor: 'agent', text: replyText, status: phase === 'sent' ? 'sent' : 'waiting', createdAt: '2026-11-08T18:00:00Z', ...(phase === 'sent' ? {} : { retryable: true, retryAt: '2026-11-08T18:05:00Z', retryExhausted: phase === 'exhausted', error: '账号核验尚未完成' }) },
      ...(phase === 'human-failed' ? [{ id: 'human-approved-reply', conversationId: 'conversation-1', direction: 'outbound', actor: 'human', text: '人工确认的未发送回复', status: 'failed', retryable: true, error: '账号核验尚未完成', createdAt: '2026-11-08T18:01:00Z' }] : []),
    ],
  });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, timezoneId: 'Asia/Shanghai', serviceWorkers: 'block' });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort('blockedbyclient');
      if (url.pathname !== '/api/prospecting') return route.continue();
      if (route.request().method() === 'GET') return route.fulfill({ json: snapshot() });
      posts.push(route.request().postDataJSON());
      return route.fulfill({ json: { message: '会话同步已请求。', chat: snapshot() } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.setFixedTime(new Date('2026-11-08T18:00:00Z'));
    await page.goto(origin);
    await page.getByRole('button', { name: /王女士/ }).click();
    const transcript = page.getByRole('log');
    const waiting = transcript.locator('article').filter({ has: page.getByText(replyText, { exact: true }) });
    await waiting.getByText('等待账号核验，尚未发送', { exact: true }).waitFor();
    assert.equal(await waiting.locator('time[datetime="2026-11-08T18:05:00Z"]').count(), 1);
    assert.equal(await waiting.getByRole('button').count(), 0, 'A verification wait must not expose send or retry actions');
    assert.equal(await waiting.locator('.needs-attention').count(), 0);
    const waitingNode = await waiting.elementHandle();
    const records = transcript.locator('details').filter({ has: page.getByText('账号核验记录（2次，均未发送）', { exact: true }) });
    await records.locator('summary').waitFor();
    assert.equal(await transcript.locator('article').count(), 19, 'Known unsent legacy attempts must not appear as ordinary chat bubbles');
    assert.equal(await page.getByText(legacy[0].text, { exact: true }).isVisible(), false);
    await records.locator('summary').click();
    for (const item of legacy) {
      assert.equal(await records.getByText(item.text, { exact: true }).isVisible(), true);
      assert.equal(await records.getByText(item.error, { exact: true }).isVisible(), true);
      assert.equal(await records.locator(`time[datetime="${item.createdAt}"]`).count(), 1);
    }
    await records.locator('summary').click();
    const failed = transcript.locator('article').filter({ has: page.getByText('确实失败的回复', { exact: true }) });
    assert.equal(await failed.getByText('发送失败', { exact: true }).isVisible(), true);
    assert.equal(await failed.getByText('对方关闭了私信权限', { exact: true }).isVisible(), true);
    const unknown = transcript.locator('article').filter({ has: page.getByText('需要核对是否已发出的回复', { exact: true }) });
    assert.equal(await unknown.getByText('结果待核对', { exact: true }).isVisible(), true);
    assert.equal(await unknown.getByRole('button').count(), 0, 'An unknown outcome cannot be retried');
    const draft = page.getByRole('textbox', { name: '人工回复客户', exact: true });
    await draft.fill('保留的人工草稿');
    await transcript.evaluate(el => { el.dispatchEvent(new WheelEvent('wheel')); el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
    phase = 'exhausted';
    await page.waitForResponse(response => response.url().includes('/api/prospecting?') && response.request().method() === 'GET');
    await waiting.getByText('检查助手后点击立即同步', { exact: true }).waitFor();
    assert.equal(posts.length, 0, 'Reaching the automatic attempt limit must not trigger a mutation');
    assert.equal(await waiting.getByRole('button').count(), 0);
    assert.equal(await transcript.evaluate(el => el.scrollTop), 0, 'Waiting-state refresh must preserve manual scrolling');
    await page.getByRole('button', { name: '查看最新消息', exact: true }).click();
    await page.waitForFunction(el => el.scrollHeight - el.scrollTop - el.clientHeight < 50, await transcript.elementHandle());
    const captureDir = process.env.PROSPECT_UI_CAPTURE_DIR;
    if (captureDir) { await mkdir(captureDir, { recursive: true }); await page.screenshot({ path: path.join(captureDir, 'chat-waiting-desktop.png'), fullPage: true }); }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await waiting.getByText('检查助手后点击立即同步', { exact: true }).isVisible(), true);
    assert.equal(await page.getByRole('button', { name: '立即同步', exact: true }).evaluate(el => getComputedStyle(el).height), '44px');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (captureDir) await page.screenshot({ path: path.join(captureDir, 'chat-waiting-mobile.png'), fullPage: true });
    phase = 'sent';
    await page.getByRole('button', { name: '立即同步', exact: true }).click();
    await waiting.getByText('已提交', { exact: true }).waitFor();
    assert.equal(await waiting.evaluate((node, previous) => node === previous, waitingNode), true, 'A successful retry updates the existing logical reply bubble');
    assert.equal(await transcript.getByText(replyText, { exact: true }).count(), 1);
    assert.equal(await waiting.getByText('等待账号核验，尚未发送', { exact: true }).count(), 0);
    assert.equal(await draft.inputValue(), '保留的人工草稿');
    assert.deepEqual(posts.map(item => item.action), ['chatSync'], 'Only the explicit sync click authorizes recovery');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    phase = 'human-failed';
    await page.waitForResponse(response => response.url().includes('/api/prospecting?') && response.request().method() === 'GET');
    const humanFailure = transcript.locator('article').filter({ has: page.getByText('人工确认的未发送回复', { exact: true }) });
    await humanFailure.getByRole('button', { name: '重试发送', exact: true }).waitFor();
    assert.equal(await records.locator('summary').textContent(), '账号核验记录（2次，均未发送）', 'Manual failures stay outside the agent verification history');
    assert.equal(posts.filter(item => item.action === 'chatReply').length, 0, 'A failed manual message never resends itself');
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/api/prospecting') && response.request().method() === 'POST'),
      humanFailure.getByRole('button', { name: '重试发送', exact: true }).click(),
    ]);
    assert.equal(posts.findLast(item => item.action === 'chatReply').message, '人工确认的未发送回复', 'An explicit manual retry keeps the original approved text');
    phase = 'exhausted';
    await page.evaluate(() => window.__chatFixture.setCampaign(undefined));
    await page.getByRole('button', { name: /王女士/ }).click();
    await page.getByText('只读会话，接管与发送由原任务负责人操作。', { exact: true }).waitFor();
    await waiting.getByText('请联系原任务负责人检查助手并同步', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '立即同步', exact: true }).count(), 0, 'Read-only viewers must not be directed to an unavailable mutation');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('conversation learning sends only source identifiers and shows retryable status and errors', { timeout: 60000 }, async () => {
  const { chromium } = await import(pathToFileURL(path.join(root, 'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);
  const { server, origin, cacheDir } = await createConversationFixture();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const snapshot = { enabled: false, online: true, policy: defaultPolicy(), libraries: [], conversations: [{ id: 'case-a', campaignId: 'campaign-a', nickname: '案例客户', mode: 'human', status: 'active', version: 1, updatedAt: '2026-11-08', lastMessageAt: '2026-11-08' }], messages: [], pool: [] };
    const posts = []; let fail = true;
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname !== '/api/prospecting') return route.continue();
      if (route.request().method() === 'GET') return route.fulfill({ json: snapshot });
      const payload = route.request().postDataJSON(); posts.push(payload);
      return fail ? route.fulfill({ status: 409, json: { error: '至少需要两轮实质客户文本' } }) : route.fulfill({ json: { chat: snapshot, message: '对话案例已保存；请配置大模型后重试' } });
    });
    await page.goto(origin);
    await page.getByRole('button', { name: /案例客户/ }).click();
    await page.getByRole('button', { name: '会话工具', exact: true }).click();
    const button = page.getByRole('button', { name: '提炼话术 Skill / 重试', exact: true });
    await button.click(); await page.getByText('至少需要两轮实质客户文本', { exact: true }).waitFor();
    assert.deepEqual(posts[0], { action: 'chatLearn', campaignId: 'campaign-a', conversationId: 'case-a' });
    fail = false; await button.click(); await page.getByText('对话案例已保存；请配置大模型后重试', { exact: true }).waitFor();
    assert.equal(posts.length, 2);
  } finally { await browser?.close(); await server.close(); await rm(cacheDir, { recursive: true, force: true }); }
});

test('the capture list filters four columns and opens authorized conversation details on demand', { timeout: 30000 }, async () => {
  const { chromium } = await import(pathToFileURL(path.join(root, 'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);
  const { server, origin, cacheDir } = await createConversationFixture();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
    const selectedReads = [];
    const snapshot = { enabled: false, online: false, policy: defaultPolicy(), conversations: [], messages: [], pool: [{ id: 'capture', conversationId: 'readonly', nickname: '留资客户', contactType: 'phone', contactValue: '13600000001', grade: 'high', score: 88, assignedName: '测试销售', status: 'assigned', updatedAt: '2026-11-08' }] };
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname !== '/api/prospecting') return route.continue();
      assert.equal(route.request().method(), 'GET');
      if (url.searchParams.get('conversationId') !== 'readonly') return route.fulfill({ json: snapshot });
      selectedReads.push(url.searchParams.get('campaignId'));
      return route.fulfill({ json: { ...snapshot, conversations: [{ id: 'readonly', campaignId: 'different-campaign', nickname: '留资客户', mode: 'human', status: 'active', version: 1, memoryEditable: false, lastMessagePreview: '想预约看铺' }], messages: [{ id: 'source', conversationId: 'readonly', direction: 'inbound', actor: 'customer', text: '想预约看铺', status: 'received', createdAt: '2026-11-08' }] } });
    });
    await page.goto(origin);
    await page.waitForFunction(() => Boolean(window.__chatFixture));
    await page.evaluate(() => window.__chatFixture.setView('pool'));
    const table = page.getByRole('table', { name: '留资线索池' });
    await table.waitFor();
    assert.deepEqual(await table.getByRole('columnheader').allTextContents(), ['用户名', '原文', '意向', '状态']);
    assert.equal(await page.getByRole('complementary', { name: '留资详情' }).count(), 0);
    assert.doesNotMatch(await table.textContent(), /13600000001|测试销售/);
    await page.getByLabel('意向等级').selectOption('low');
    await page.getByText('没有匹配的留资线索', { exact: true }).waitFor();
    await page.getByRole('button', { name: '查看全部留资' }).click();
    await table.getByRole('button', { name: /留资客户/ }).click();
    const detail = page.getByRole('complementary', { name: '留资详情' });
    await detail.getByText('13600000001').waitFor();
    assert.equal(await table.isVisible(), false);
    await detail.getByRole('button', { name: '查看会话' }).click();
    await page.getByRole('log').getByText('想预约看铺').waitFor();
    assert.ok(selectedReads.length && selectedReads.every(scope => scope === null));
    assert.equal(await page.getByRole('button', { name: '发送回复' }).count(), 0);
    const conversation = page.getByRole('complementary', { name: '留资客户', exact: true });
    await conversation.waitFor();
    await page.getByRole('button', { name: '返回会话列表' }).click();
    await conversation.waitFor({ state: 'hidden' });
  } finally { await browser?.close(); await server.close(); await rm(cacheDir, { recursive: true, force: true }); }
});

test('conversation talktrack detail names a conversation case, never a confirmed won case', async()=>{
 const {server,cacheDir}=await createConversationFixture();
 try{
  const React=await import('react');const {renderToStaticMarkup}=await import('react-dom/server');
  const {TalkLibraryView}=await server.ssrLoadModule('/app/components/TalkLibraryView.tsx');const {createSeed}=await server.ssrLoadModule('/app/lib/seed.ts');const state=createSeed('2026-11-08');
  state.talkTracks=[{id:'case',title:'需求话术',status:'published',weight:1,version:1,employeeName:'销售甲',employeeId:'sales-1',departmentId:'zs',topic:'需求',scenario:'需求核实',template:'确认需求',keywords:[],steps:[],objectionLogic:[],boundaries:[],leadTypes:[],evidence:[],createdAt:'2026-11-08',updatedAt:'2026-11-08',conversationSource:{campaignId:'task',capturedAt:'2026-11-08',messages:[]}}];
  const html=renderToStaticMarkup(React.createElement(TalkLibraryView,{state,mutate:async()=>{},notify:()=>{},onUsePlaybook:()=>{}}));
  assert.match(html,/的对话案例/);assert.doesNotMatch(html,/的成单沟通/);
 }finally{await server.close();await rm(cacheDir,{recursive:true,force:true});}
});
