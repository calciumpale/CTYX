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
const entry = path.join(root, '__chat-progress.jsx');
const fixture = `import React from 'react';
import {createRoot} from 'react-dom/client';
import '/app/globals.css';
import Workbench from '/app/components/Workbench.tsx';
createRoot(document.getElementById('root')).render(<Workbench member={{accountId:'member-1',username:'ZS',displayName:'ZS',role:'sales',salesId:'sales-1'}} onLogout={async()=>{}} />);`;

const now = '2026-11-14T00:00:00Z';
const lookup = { id: 'lookup', title: '检索项目资料', detail: '正在读取本轮资料', duration: 0, status: 'running' };
const found = { ...lookup, detail: '找到一条授权资料', duration: 41, status: 'success' };
const generation = { id: 'generation', title: '组织模型答复', detail: '正在等待本轮模型答复', duration: 0, status: 'running' };
const generated = { ...generation, detail: '模型已完成答复', duration: 87, status: 'success' };

function json(response, value) {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(value));
}

const line = event => `${JSON.stringify(event)}\n`;

test('project chat and the assistant show live progress and preserve the project reading position', { timeout: 60000 }, async t => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'workbench-chat-progress-'));
  let state = createSeed(now);
  state.role = 'sales';
  state.viewer = { name: 'ZS', team: '招商', salesId: 'sales-1' };
  state.deals = [state.deals[0]];
  state.runs = [];
  const dealId = state.deals[0].id;
  const posts = [];
  const gates = new Map();
  const handle = async (request, response, next, vite) => {
    const pathname = request.url?.split('?')[0];
    if (pathname === '/') {
      response.setHeader('Content-Type', 'text/html');
      return response.end(await vite.transformIndexHtml('/', '<html lang="zh-CN"><body><div id="root"></div><script type="module" src="/__chat-progress.jsx"></script></body></html>'));
    }
    if (pathname !== '/api/workbench') return pathname?.startsWith('/api/') ? json(response, { pendingCount: 0 }) : next();
    if (request.method === 'GET') return json(response, state);

    const body = JSON.parse((await Array.fromAsync(request.setEncoding('utf8'))).join(''));
    const gate = gates.get(body.payload?.query);
    posts.push({ method: request.method, action: body.action, query: body.payload?.query, dealId: body.payload?.dealId, conversationRunIds: body.payload?.conversationRunIds, accept: request.headers.accept });
    assert.ok(gate, 'only fixture questions may call chat');
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
    response.flushHeaders();
    response.write(line({ type: 'step', step: lookup }));
    await gate.lookup.promise;
    response.write(line({ type: 'step', step: found }) + line({ type: 'step', step: generation }));
    await gate.generation.promise;
    const run = { id: `run-${posts.length}`, query: body.payload.query, answer: gate.answer, agentIds: ['insight'], steps: [found, generated], citations: [], mode: 'live', createdAt: now, duration: 128, ...(body.payload.dealId ? { dealId: body.payload.dealId } : {}) };
    state = { ...state, revision: state.revision + 1, runs: [run, ...state.runs] };
    response.end(line({ type: 'step', step: generated }) + line({ type: 'complete', result: { state, run } }));
  };

  let server;
  let browser;
  try {
    server = await createServer({
      root, configFile: false, logLevel: 'error', cacheDir,
      resolve: { dedupe: ['react', 'react-dom'] },
      optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react'] },
      plugins: [react(), {
        name: 'chat-progress-fixture',
        resolveId(id) { if (id === '/__chat-progress.jsx') return entry; },
        load(id) { if (id === entry) return fixture; },
        configureServer(vite) { vite.middlewares.use((request, response, next) => { void handle(request, response, next, vite).catch(next); }); },
      }],
      server: { host: '127.0.0.1', port: 0, hmr: false },
    });
    await server.listen();
    browser = await chromium.launch({ headless: true });
    const projectUrl = `${server.resolvedUrls.local[0]}?view=deals&deal=${dealId}`;
    const openProject = page => page.goto(projectUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

    for (const surface of ['项目对话', 'AI 营销助手']) {
      await t.test(surface, async () => {
        const project = surface === '项目对话';
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        page.setDefaultTimeout(6000);
        const query = `${surface}测试：这家企业有什么公开资料？`;
        const gate = { lookup: Promise.withResolvers(), generation: Promise.withResolvers(), answer: `${surface}测试的最终模型回复。` };
        gates.set(query, gate);
        try {
          await openProject(page);
          if (!project) await page.getByRole('button', { name: 'AI 营销助手', exact: true }).click();
          const view = project ? page.locator('[aria-label="当前项目对话历史"]') : page.getByRole('dialog', { name: 'AI 营销助手' });
          const composer = project ? page.getByRole('textbox', { name: '向 AI 询问当前项目' }) : view.getByRole('textbox', { name: '描述你的任务' });
          const send = (project ? page : view).getByRole('button', { name: project ? '发送当前项目问题' : '发送任务' });
          const progress = view.getByRole('list', { name: '处理步骤' });
          const lookupRow = progress.getByRole('listitem').filter({ hasText: lookup.title });
          const answer = view.getByText(gate.answer, { exact: true });
          await composer.fill(query);
          if (project) {
            const form = page.locator('.conversation-composer').filter({ has: composer });
            const agent = form.getByRole('combobox', { name: '选择 AI 助手', exact: true });
            assert.equal(await form.count(), 1, 'project chat uses the shared composer shell');
            for (const width of [1440, 960, 851, 850, 700, 390, 320]) {
              await page.setViewportSize({ width, height: width === 1440 ? 900 : 720 });
              if (width < 960) {
                await openProject(page);
                await composer.fill(query);
              }
              assert.equal(await composer.inputValue(), query, 'changing widths preserves the edited draft');
              await send.scrollIntoViewIfNeeded();
              const style = await composer.evaluate(input => ({
                field: input.classList.contains('conversation-composer-input'),
                border: getComputedStyle(input).borderTopWidth,
                fontSize: parseFloat(getComputedStyle(input).fontSize),
                radius: parseFloat(getComputedStyle(input.closest('.conversation-composer')).borderTopLeftRadius),
              }));
              assert.equal(style.field, true);
              assert.equal(style.border, '0px');
              assert.ok(style.radius >= 16, 'one rounded shell frames the composer');
              if (width <= 850) assert.ok(style.fontSize >= 16, 'the mobile input uses a readable font size');
              const [agentBounds, sendBounds] = await Promise.all([agent.boundingBox(), send.boundingBox()]);
              assert.ok(sendBounds.x >= agentBounds.x + agentBounds.width - 1);
              const target = await send.evaluate(button => {
                const { x, y, width, height } = button.getBoundingClientRect();
                const hit = document.elementFromPoint(x + width / 2, y + height / 2);
                return {
                  shared: button.classList.contains('conversation-composer-send'), inside: button.contains(hit),
                  hit: hit?.closest('button')?.getAttribute('aria-label') ?? hit?.className ?? hit?.tagName,
                  rect: { x, y, width, height },
                };
              });
              assert.ok(target.shared && target.inside, `the send control is obscured at ${width}px: ${JSON.stringify(target)}`);
            }
            await page.setViewportSize({ width: 1440, height: 900 });
            await openProject(page);
            await composer.fill(query);
          }
          await send.click();

          await view.getByText('处理过程', { exact: true }).last().waitFor();
          await lookupRow.getByText(lookup.detail, { exact: true }).waitFor();
          await lookupRow.getByText('进行中', { exact: true }).waitFor();
          assert.equal(await send.isDisabled(), true);
          assert.equal(await answer.count(), 0);

          gate.lookup.resolve();
          await progress.getByText(generation.detail, { exact: true }).waitFor();
          assert.equal(await lookupRow.count(), 1);
          assert.equal(await lookupRow.getByText(lookup.detail, { exact: true }).count(), 0);
          await lookupRow.getByText(found.detail, { exact: true }).waitFor();
          await lookupRow.getByText('已完成', { exact: true }).waitFor();
          assert.equal(await answer.count(), 0);

          gate.generation.resolve();
          await answer.waitFor();
          assert.equal(await view.getByText(query, { exact: true }).count(), 1);
          assert.equal(await view.getByText(generation.detail, { exact: true }).count(), 0);
          const matchingPosts = posts.filter(post => post.query === query);
          assert.equal(matchingPosts.length, 1);
          const [{ accept, conversationRunIds, ...request }] = matchingPosts;
          assert.deepEqual(conversationRunIds, []);
          assert.deepEqual(request, { method: 'POST', action: 'chat', query, dealId });
          assert.match(accept, /\bapplication\/x-ndjson\b/);
        } finally {
          gate.lookup.resolve();
          gate.generation.resolve();
          await page.close();
        }
      });
    }

    await t.test('assistant scopes project shortcuts and history independently of the active project', async () => {
      const originalState = state;
      const otherDealId = 'second-project';
      const previous = { ...state.runs[0], id: 'other-project-run', query: '另一项目的历史问题', dealId: otherDealId };
      state = { ...state, deals: [...state.deals, { ...state.deals[0], id: otherDealId, name: '另一家企业' }], runs: [previous, ...state.runs] };
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      page.setDefaultTimeout(6000);
      const dialog = page.getByRole('dialog', { name: 'AI 营销助手', exact: true });
      const assistant = page.getByRole('button', { name: 'AI 营销助手', exact: true });
      const ask = async (query, expectedDeal, ids, shortcut = false) => {
        const answer = `${query}的测试回复`;
        gates.set(query, { lookup: { promise: Promise.resolve() }, generation: { promise: Promise.resolve() }, answer });
        if (shortcut) await dialog.getByRole('button', { name: /AI 项目复盘/ }).click();
        else {
          await dialog.getByRole('textbox', { name: '描述你的任务' }).fill(query);
          await dialog.getByRole('button', { name: '发送任务' }).click();
        }
        await dialog.getByText(answer, { exact: true }).waitFor();
        assert.equal(posts.at(-1).dealId, expectedDeal);
        assert.deepEqual(posts.at(-1).conversationRunIds, ids);
      };
      try {
        await openProject(page);
        await assistant.click();
        await ask('请结合当前客户事实与沟通记录，汇总项目现状、待核实风险及下一步推进清单。', dealId, [], true);
        await dialog.getByRole('button', { name: '关闭', exact: true }).click();
        await page.locator('.sidebar-recent').getByRole('button', { name: previous.query, exact: true }).click();
        await ask('继续讨论另一项目', otherDealId, [previous.id]);
        await dialog.getByRole('button', { name: '关闭', exact: true }).click();
        await page.locator('.sidebar nav').getByRole('link', { name: /^提醒/ }).click();
        await assistant.click();
        assert.equal(await dialog.getByRole('button', { name: /AI 项目复盘/ }).count(), 0);
        await ask('全局任务测试', undefined, []);
      } finally {
        await page.close();
        state = originalState;
      }
    });

    for (const reducedMotion of ['no-preference', 'reduce']) {
      await t.test(`项目对话：${reducedMotion} 时返回最新消息`, async () => {
        state = { ...state, runs: Array.from({ length: 12 }, (_, index) => ({
          id: `history-${index}`, query: `历史问题 ${index}`, answer: `这是第 ${index} 条历史回答。`, dealId,
          agentIds: ['insight'], steps: [], citations: [], mode: 'live',
          createdAt: new Date(Date.parse(now) - (12 - index) * 60000).toISOString(), duration: 128,
        })) };
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion });
        page.setDefaultTimeout(6000);
        const query = `项目滚动测试 ${reducedMotion}`;
        const gate = { lookup: Promise.withResolvers(), generation: Promise.withResolvers(), answer: `项目滚动测试的最终答复 ${reducedMotion}` };
        gates.set(query, gate);
        try {
          await openProject(page);
          const history = page.locator('[aria-label="当前项目对话历史"]');
          const scroller = await history.elementHandle();
          const waitForBottom = () => page.waitForFunction(element => element.scrollHeight - element.clientHeight - element.scrollTop < 2, scroller);
          const waitForLayout = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const latest = page.getByRole('button', { name: '最新消息', exact: true });
          const progress = history.getByRole('list', { name: '处理步骤' });
          await waitForBottom();
          assert.ok(await history.evaluate(element => element.scrollHeight - element.clientHeight > 240), 'the fixture history overflows');
          await history.evaluate(element => {
            const scrollTo = element.scrollTo.bind(element);
            element.dataset.scrollBehaviors = '';
            element.scrollTo = (...args) => {
              element.dataset.scrollBehaviors += `${args[0]?.behavior ?? 'default'},`;
              scrollTo(...args);
            };
          });

          await page.getByRole('textbox', { name: '向 AI 询问当前项目' }).fill(query);
          await page.getByRole('button', { name: '发送当前项目问题' }).click();
          await progress.getByText(lookup.detail, { exact: true }).waitFor();
          await waitForBottom();
          assert.doesNotMatch(await history.getAttribute('data-scroll-behaviors'), /smooth/, 'following a live update does not animate');

          await history.focus();
          await page.keyboard.press('Home');
          await page.waitForFunction(element => element.scrollTop < 2, scroller);
          await latest.waitFor();
          gate.lookup.resolve();
          await progress.getByText(generation.detail, { exact: true }).waitFor();
          await waitForLayout();
          assert.ok(await history.evaluate(element => element.scrollTop < 2), 'progress leaves the older messages in view');

          gate.generation.resolve();
          await history.getByText(gate.answer, { exact: true }).waitFor();
          await waitForLayout();
          assert.ok(await history.evaluate(element => element.scrollTop < 2), 'the final answer leaves the older messages in view');

          await history.evaluate(element => { element.dataset.scrollBehaviors = ''; });
          await latest.focus();
          await page.keyboard.press('Enter');
          await waitForBottom();
          await latest.waitFor({ state: 'hidden' });
          const behavior = reducedMotion === 'reduce' ? 'instant' : 'smooth';
          assert.equal(await history.getAttribute('data-scroll-behaviors'), `${behavior},`);
          assert.equal(await history.evaluate(element => document.activeElement === element), true, 'the keyboard returns to the transcript');
        } finally {
          gate.lookup.resolve();
          gate.generation.resolve();
          await page.close();
        }
      });
    }
    assert.equal(posts.length, 7);
  } finally {
    await browser?.close();
    await server?.close();
    await rm(cacheDir, { force: true, recursive: true });
  }
});
