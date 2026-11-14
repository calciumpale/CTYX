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
const entry = path.join(root, '__training-ui.jsx');
const now = '2026-11-14T02:00:00Z';
const dimensions = [
  ['discovery', '需求探索', 15, 20],
  ['empathy', '倾听与共情', 12, 15],
  ['solution', '方案匹配', 16, 20],
  ['value', '价值表达', 11, 15],
  ['objections', '异议处理', 12, 15],
  ['next_step', '推进下一步', 12, 15],
];
const feedback = dimensions.map(([id, label, score, maxScore]) => ({
  id, label, score, maxScore, evidence: `已核对${label}的对话原文。`, suggestion: `下次补充${label}的具体问题。`,
}));
const total = feedback.reduce((sum, item) => sum + item.score, 0);
const replySuggestion = '先确认对方更在意固定物业费还是增项，再解释如何逐项核对。';
const legacySession = {
  id: 'legacy-training', scenario: '历史陪练用例', customer: '历史客户', createdAt: now, status: 'completed', score: 60,
  messages: [{ role: 'user', content: '练习历史记录正文' }],
  feedback: [{ label: '历史沟通表现', score: 60, evidence: '历史记录原有依据。', suggestion: '历史记录原有建议。' }],
};

const fixture = `import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import '/app/globals.css';
import {TrainingView} from '/app/components/StudioViews.tsx';
import {createSeed} from '/app/lib/seed.ts';
const now=${JSON.stringify(now)};
const feedback=${JSON.stringify(feedback)};
window.trainingCalls=[];
function Fixture(){
  const [state,setState]=useState(()=>({ ...createSeed(now), model:{connected:true,name:'测试模型'}, trainingSessions:[${JSON.stringify(legacySession)}, { id:'active-training', scenario:'进行中的旧练习', customer:'访客', createdAt:now, status:'active', messages:[] }] }));
  async function mutate(action,payload){
    window.trainingCalls.push({action,payload:structuredClone(payload)});
    let session=state.trainingSessions.find(item=>item.id===payload.sessionId);
    if(action==='training_start') session={id:'new-training',scenario:payload.scenario,customer:payload.profile.name,profile:payload.profile,mode:'live',status:'active',createdAt:now,messages:[{role:'assistant',content:'我需要比较两个园区的费用。'}]};
    else if(action==='training_reply') session={...session,messages:[...session.messages,{role:'user',content:payload.text},{role:'assistant',content:'请问你能提供物业费明细吗？',replySuggestion:${JSON.stringify(replySuggestion)}}]};
    else if(action==='training_finish') session={...session,status:'completed',score:${total},feedback,evaluationMode:'live'};
    else throw new Error('Unexpected fixture action: '+action);
    const next={...state,revision:state.revision+1,trainingSessions:[session,...state.trainingSessions.filter(item=>item.id!==session.id)]};
    setState(next);
    return {state:next,session};
  }
  return <TrainingView state={state} mutate={mutate} notify={()=>{}} />;
}
createRoot(document.getElementById('root')).render(<Fixture />);`;

test('training uses four setup cards, optional coaching tips and a six-dimension review dialog', { timeout: 60000 }, async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'training-ui-'));
  let server;
  let browser;
  try {
    server = await createServer({
      root, configFile: false, logLevel: 'error', cacheDir,
      resolve: { dedupe: ['react', 'react-dom'] },
      optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react'] },
      plugins: [react(), {
        name: 'training-ui-fixture',
        resolveId(id) { if (id === '/__training-ui.jsx') return entry; },
        load(id) { if (id === entry) return fixture; },
        configureServer(vite) {
          vite.middlewares.use(async (request, response, next) => {
            if (request.url !== '/') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end(await vite.transformIndexHtml('/', '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__training-ui.jsx"></script></body></html>'));
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0, hmr: false },
    });
    await server.listen();
    const origin = new URL(server.resolvedUrls.local[0]).origin;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(6000);
    const unexpected = [];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === origin && url.pathname === '/api/training-voice' && request.method() === 'GET') return route.fulfill({ json: { configured: false } });
      if (url.origin === origin && !url.pathname.startsWith('/api/')) return route.continue();
      unexpected.push(`${request.method()} ${url.pathname}`);
      return route.abort();
    });

    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const setupNames = ['选择剧本', '人物及音色', '选陪练方式', '开始陪练'];
    const setupCards = setupNames.map(name => page.getByRole('region', { name, exact: true }));
    await page.getByRole('heading', { name: 'AI带练', exact: true }).waitFor();
    for (const card of setupCards) await card.waitFor();
    await page.getByRole('heading', { name: '练习记录及复盘', exact: true }).waitFor();
    const cardBounds = () => Promise.all(setupCards.map(card => card.boundingBox()));
    const expectEqualCards = async (state) => {
      const bounds = await cardBounds();
      const [first] = bounds;
      assert.ok(bounds.every(card => Math.abs(card.width - first.width) <= 1 && Math.abs(card.height - first.height) <= 1),
        `${state} desktop cards share width and height: ${JSON.stringify(bounds)}`);
      return first.height;
    };
    const desktopHeight = await expectEqualCards('initial');
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileCards = await cardBounds();
    assert.ok(mobileCards.every((card, index) => index === 0 || card.y >= mobileCards[index - 1].y + mobileCards[index - 1].height - 1), 'mobile setup cards stack in task order');
    assert.ok(Math.max(...mobileCards.map(card => card.height)) - Math.min(...mobileCards.map(card => card.height)) > 10, 'mobile cards size to their content');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.setViewportSize({ width: 1440, height: 900 });

    const price = page.getByRole('button', { name: /^价格与价值异议/ });
    const comparison = page.getByRole('button', { name: /^竞品比较/ });
    await page.getByRole('button', { name: /^免租期异议/ }).waitFor();
    await page.getByRole('button', { name: /^首访剧本/ }).waitFor();
    assert.equal(await price.getAttribute('aria-pressed'), 'true');
    await comparison.click();
    assert.equal(await comparison.getAttribute('aria-pressed'), 'true');
    assert.equal(await price.getAttribute('aria-pressed'), 'false');
    const textMode = page.getByRole('button', { name: '文字陪练', exact: true });
    const voiceMode = page.getByRole('button', { name: '语音陪练', exact: true });
    assert.equal(await textMode.getAttribute('aria-pressed'), 'true');
    await voiceMode.click();
    const voiceTransport = page.getByRole('group', { name: '语音连接方式', exact: true });
    await voiceTransport.getByRole('button', { name: '实时语音', exact: true }).waitFor();
    await voiceTransport.getByRole('button', { name: '兼容模式', exact: true }).click();
    await page.getByLabel('客户中文音色', { exact: true }).waitFor();
    await textMode.click();
    await voiceTransport.waitFor({ state: 'hidden' });
    await page.getByText('编辑客户画像', { exact: true }).click();
    await setupCards[1].getByText('客户背景与决策条件', { exact: true }).click();
    await setupCards[1].getByRole('textbox', { name: '客户称呼', exact: true }).waitFor();
    assert.ok(await expectEqualCards('expanded profile') > desktopHeight, 'cards grow to fit the expanded profile');
    await page.getByRole('textbox', { name: '业务需求', exact: true }).fill('比较两处园区的办公成本。');
    await page.getByRole('button', { name: '预览并确认', exact: true }).click();
    await page.getByRole('heading', { name: '确认客户画像', exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.trainingCalls), []);
    const start = page.getByRole('button', { name: '开始陪练', exact: true });
    await start.click();
    await page.getByText('我需要比较两个园区的费用。', { exact: true }).waitFor();
    const [startCall] = await page.evaluate(() => window.trainingCalls);
    assert.equal(startCall.action, 'training_start');
    assert.equal(startCall.payload.confirmed, true);
    assert.equal(startCall.payload.scenario, '竞品比较');
    assert.equal(startCall.payload.profile.need, '比较两处园区的办公成本。');

    const coachingSwitch = page.getByRole('switch', { name: '建议怎么回答', exact: true });
    const tips = page.locator('.training-reply-tip');
    assert.equal(await coachingSwitch.getAttribute('aria-checked'), 'true');
    await tips.first().waitFor();
    await coachingSwitch.click();
    assert.equal(await coachingSwitch.getAttribute('aria-checked'), 'false');
    assert.equal(await tips.count(), 0);
    assert.equal((await page.evaluate(() => window.trainingCalls)).length, 1);
    const reply = '我先核对租金和物业费构成，再按相同面积逐项比较。';
    await page.getByRole('textbox', { name: '输入你的回应', exact: true }).fill(reply);
    await page.getByRole('button', { name: '发送回应', exact: true }).click();
    await page.getByText('请问你能提供物业费明细吗？', { exact: true }).waitFor();
    assert.equal(await tips.count(), 0, 'turns stay readable while coaching is disabled');
    await coachingSwitch.click();
    await tips.nth(1).waitFor();
    assert.equal(await tips.count(), 2, 'one coaching hint appears per simulated customer turn');
    await tips.getByText(replySuggestion, { exact: true }).waitFor();
    const calls = await page.evaluate(() => window.trainingCalls.slice(1));
    assert.deepEqual(calls, [{ action: 'training_reply', payload: { sessionId: 'new-training', text: reply } }]);

    await page.getByRole('button', { name: '结束并复盘', exact: true }).click();
    const review = page.getByRole('dialog', { name: '练习复盘', exact: true });
    await review.waitFor();
    assert.match(await review.innerText(), new RegExp(`${total}\\s*[/／]\\s*100`));
    const scoreRows = review.getByRole('listitem');
    assert.equal(await scoreRows.count(), feedback.length);
    for (const { label, score, maxScore, evidence, suggestion } of feedback) {
      const scoreRow = scoreRows.filter({ has: page.getByText(label, { exact: true }) });
      await scoreRow.getByText(evidence, { exact: true }).waitFor();
      await scoreRow.getByText(suggestion, { exact: true }).waitFor();
      assert.match(await scoreRow.innerText(), new RegExp(`${score}\\s*[/／]\\s*${maxScore}`));
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await review.evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1), true);
    await page.keyboard.press('Escape');
    await review.waitFor({ state: 'hidden' });
    const viewScore = page.getByRole('button', { name: '查看评分', exact: true });
    await viewScore.click();
    await review.getByText('推进下一步', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await review.waitFor({ state: 'hidden' });
    assert.equal(await viewScore.evaluate(button => document.activeElement === button), true);
    await page.getByRole('button', { name: /历史陪练用例/ }).click();
    await viewScore.click();
    await review.getByText('历史沟通表现', { exact: true }).waitFor();
    assert.equal(await review.getByText('推进下一步', { exact: true }).count(), 0, 'legacy feedback retains its original rubric');
    assert.deepEqual(await page.evaluate(() => window.trainingCalls.slice(2)), [{ action: 'training_finish', payload: { sessionId: 'new-training' } }]);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server?.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});
