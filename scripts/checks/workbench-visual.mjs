#!/usr/bin/env node
/**
 * Bounded visual QA of the real Workbench component with synthetic data only.
 * Usage: node scripts/checks/workbench-visual.mjs --capture-dir /tmp/workbench-qa
 * Add --baseline for the representative initial desktop/mobile project views.
 * Add --correction for customer captures plus audits of four wrapped-field views.
 * No application API, real account, external website, or persistent browser is used.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const captureArg = args.indexOf('--capture-dir');
const captureDir = path.resolve(captureArg >= 0 ? args[captureArg + 1] : '/private/tmp/ctyx-charcoal-visual');
const baseline = args.includes('--baseline');
const correction = args.includes('--correction');
const now = '2026-11-08T02:00:00.000Z';
const members = [
  { accountId: 'visual-manager', username: 'visual.manager', displayName: '周予安', role: 'manager', salesId: 'sales-1', enabled: true },
  { accountId: 'visual-admin', username: 'visual.admin', displayName: '系统管理员', role: 'admin', enabled: true },
  { accountId: 'visual-sales', username: 'visual.sales', displayName: '林晓', role: 'sales', salesId: 'sales-1', enabled: true },
];
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import Workbench from '/app/components/Workbench.tsx';
import { BusinessSettingsProvider } from '/app/components/BusinessSettingsContext.tsx';
import '/app/globals.css';
import '/app/components/role-workspaces.css';
const role = new URLSearchParams(location.search).get('fixtureRole') || 'manager';
const member = ${JSON.stringify(members)}.find(item => item.role === role);
createRoot(document.getElementById('root')).render(<BusinessSettingsProvider><Workbench member={member} onLogout={async () => {}} /></BusinessSettingsProvider>);
`;
const campaign = { id: 'visual-campaign', name: '园区招商需求', requirements: '寻找计划入驻园区、需要研发办公与商业空间的企业', keywords: ['办公选址', '园区招商'], reviewMode: 'manual', greetingTemplate: '你好，方便了解具体空间需求吗？', minIntentScore: 70, maxCommentsPerVideo: 30, dailyLimit: 10, status: 'active', memberId: 'visual-manager', createdAt: now, updatedAt: now, candidates: [], selectedCandidateIds: [] };
const prospect = { campaigns: [campaign], campaign, leads: [], jobs: [], device: { id: 'visual-device', label: '合成测试助手', online: false, authenticated: false }, modelReady: false };
const chat = { enabled: false, online: false, policy: { libraryIds: [], replyDailyLimit: 30, conversationReplyLimit: 12, workStart: '08:30', workEnd: '21:30' }, libraries: [{ id: 'visual-library', name: '园区公开招商资料' }], conversations: [{ id: 'visual-conversation', campaignId: campaign.id, leadId: 'visual-lead', recipientId: 'visual-recipient', nickname: '测试客户', profileUrl: '', mode: 'human', status: 'active', version: 1, lastMessageAt: now, lastMessagePreview: '希望了解办公面积和预算', updatedAt: now, memory: { needs: { area: '120–160 平方米', budget: '待确认' }, stage: 'qualifying', contactCaptured: false, contactDeclines: 0, contactAsks: 0, summary: '合成会话，用于界面检查。' } }], messages: [{ id: 'visual-message-1', conversationId: 'visual-conversation', direction: 'inbound', actor: 'customer', text: '希望了解办公面积和预算。', status: 'received', createdAt: now }], pool: [] };

const cases = [
  ['deals', 'manager', 'view=deals&deal=deal-1'],
  ['project-profile', 'manager', 'view=deals&deal=deal-1', 'profile'],
  ['social-create', 'manager', 'view=prospecting&section=create'],
  ['social-handoff', 'manager', 'view=prospecting&section=handoff'],
  ['schedule', 'manager', 'view=schedule'],
  ['contracts', 'manager', 'view=contracts'],
  ['approvals', 'manager', 'view=approvals'],
  ['training', 'manager', 'view=training'],
  ['knowledge', 'manager', 'view=knowledge'],
  ['admin-home', 'admin', 'view=home'],
  ['admin-settings', 'admin', 'view=settings'],
  ['admin-members', 'admin', 'view=members'],
  ['admin-rules', 'admin', 'view=rules'],
  ['admin-studio', 'admin', 'view=studio'],
  ['admin-runs', 'admin', 'view=runs'],
];
const correctionNames = new Set(['deals', 'project-profile', 'approvals', 'admin-settings', 'admin-studio', 'admin-runs']);

/** Runs in the browser: alpha-composited, computed text/background contrast. */
function inspectRenderedPage() {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  function rgba(color) { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; }
  const over = (f, b) => { const a = f[3] + b[3] * (1 - f[3]); return [...f.slice(0, 3).map((v, i) => a ? (v * f[3] + b[i] * b[3] * (1 - f[3])) / a : 0), a]; };
  const lum = c => c.slice(0, 3).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((v, n, i) => v + n * [.2126, .7152, .0722][i], 0);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
  function background(el) { const parents = []; for (let p = el; p; p = p.parentElement) parents.unshift(p); return parents.reduce((b, p) => over(rgba(getComputedStyle(p).backgroundColor), b), [255, 255, 255, 1]); }
  const visible = el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 1 && r.height > 1 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0; };
  const disabled = el => !!el.closest(':disabled, [aria-disabled="true"]');
  const sample = (el, pseudo) => { const s = getComputedStyle(el, pseudo), bg = background(el), color = rgba(s.color); return { tag: el.tagName.toLowerCase(), class: String(el.className || '').slice(0, 100), text: (pseudo ? el.getAttribute('placeholder') : el.textContent)?.trim().slice(0, 80), contrast: +ratio(over(color, bg), bg).toFixed(2), color: s.color, background: bg.slice(0, 3).map(Math.round), ...(pseudo ? { placeholder: true } : {}) }; };
  const texts = [...document.querySelectorAll('body *')].filter(el => !(el instanceof SVGElement) && visible(el) && !disabled(el) && !el.classList.contains('sr-only') && [...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim())).map(el => sample(el));
  const placeholders = [...document.querySelectorAll('input[placeholder],textarea[placeholder]')].filter(el => visible(el) && !disabled(el)).map(el => sample(el, '::placeholder'));
  const inputs = [...document.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="hidden"]):not([type="range"]),select')].filter(visible).map(el => {
    const group = el.closest('.search-field,.project-search,.approval-search,.studio-search,.builder-search,.talk-library-search,.run-history-search,.meeting-search-input,.api-settings-key-input,.sales-report-controls > label');
    return { label: el.getAttribute('aria-label') || el.labels?.[0]?.textContent.trim() || el.getAttribute('placeholder') || el.id, height: +(group || el).getBoundingClientRect().height.toFixed(2), innerHeight: +el.getBoundingClientRect().height.toFixed(2), ...(group ? { wrapper: group.className } : {}), tag: el.tagName, class: String(el.className) };
  });
  const nav = [...document.querySelectorAll('.sidebar .nav-item,.mobile-role-navigation > button')].filter(visible).map(el => ({ text: el.textContent.trim(), icon: !!el.querySelector('svg'), color: getComputedStyle(el).color, iconColor: el.querySelector('svg') ? getComputedStyle(el.querySelector('svg')).color : null }));
  const surfaces = Object.fromEntries(['.sidebar', '.cw-directory', '.cw-conversation', '.cw-insights', '.kl-sidebar', '.prospect-sidebar'].map(selector => { const el = document.querySelector(selector); return [selector, el ? getComputedStyle(el).backgroundColor : null]; }));
  const sidebarIcons = [...document.querySelectorAll('.sidebar svg')].filter(visible).map(el => { const s = getComputedStyle(el), bg = background(el); return { label: el.parentElement.getAttribute('aria-label') || el.parentElement.textContent.trim(), color: s.color, contrast: +ratio(over(rgba(s.color), bg), bg).toFixed(2) }; });
  const box = selector => { const el = document.querySelector(selector); if (!el || !visible(el)) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  const projectGeometry = { profile: box('.cw-insights'), composer: box('.cw-composer'), send: box('.cw-composer button[type="submit"]'), mobileNav: box('.mobile-role-navigation') };
  return { viewport: { width: innerWidth, height: innerHeight }, pageWidth: document.documentElement.scrollWidth, overflow: document.documentElement.scrollWidth > innerWidth + 1, title: document.querySelector('.breadcrumb')?.textContent, headings: [...document.querySelectorAll('h1,h2')].filter(visible).map(el => el.textContent.trim()), textSamples: texts.length, placeholderSamples: placeholders.length, contrastFailures: [...texts, ...placeholders].filter(item => item.contrast < 4.5), minimumContrast: Math.min(...texts.map(i => i.contrast)), inputs, nav, sidebarIcons, surfaces, projectGeometry, alerts: [...document.querySelectorAll('[role="alert"]')].filter(visible).map(el => el.textContent.trim()) };
}

await mkdir(captureDir, { recursive: true });
const cacheDir = await mkdtemp(path.join(tmpdir(), 'workbench-visual-vite-'));
const server = await createServer({ root, configFile: false, cacheDir, logLevel: 'error', resolve: { dedupe: ['react', 'react-dom'] }, optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react', 'react-markdown', 'remark-gfm'] }, plugins: [react(), {
  name: 'isolated-workbench-visual',
  resolveId(id) { if (id === '/__workbench-visual.jsx') return path.join(root, '__workbench-visual.jsx'); },
  load(id) { if (id === path.join(root, '__workbench-visual.jsx')) return fixture; },
  configureServer(vite) { vite.middlewares.use(async (req, res, next) => { if (new URL(req.url, 'http://localhost').pathname !== '/') return next(); res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml('/', '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__workbench-visual.jsx"></script></body></html>')); }); },
}], server: { host: '127.0.0.1', port: 0, hmr: false } });
let browser;
const results = [], errors = [], apiReads = new Set(), unexpectedApis = new Set(), mutations = [], blockedExternal = new Set();
try {
  const { createSeed } = await server.ssrLoadModule('/app/lib/seed.ts');
  const seed = createSeed(now);
  seed.runs = [{ id: 'visual-run-1', query: '准备澄光咖啡下一次沟通', answer: '根据已确认的需求，先核对装修安排、预算和决策时间。\n\n下一步：与客户确认现场踏勘时间，整理可核验的交付清单。', agentIds: ['insight', 'strategy'], dealId: 'deal-1', status: 'completed', mode: 'demo', createdAt: now, duration: 1200, steps: [{ id: 'visual-step', title: '核对当前项目资料', detail: '使用合成企业资料准备沟通要点。', status: 'success', duration: 250 }], citations: [{ id: 'knowledge-1', title: '园区公开资料', excerpt: '以现场踏勘和正式文件核验为准。' }] }];
  await server.listen();
  const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
  const { chromium } = await import(pathToFileURL(path.join(root, 'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);
  browser = await chromium.launch({ headless: true });
  async function routeApi(route, role) {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== origin) { blockedExternal.add(url.origin); return route.abort('blockedbyclient'); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    apiReads.add(url.pathname);
    if (req.method() !== 'GET') { mutations.push({ path: url.pathname, method: req.method() }); return route.fulfill({ status: 405, json: { error: 'Synthetic visual fixture is read only.' } }); }
    const identity = { id: `visual-${role}`, email: `${role}@example.invalid`, name: role === 'admin' ? '系统管理员' : '周予安' };
    let json;
    switch (url.pathname) {
      case '/api/workbench': json = { ...seed, role }; break;
      case '/api/business-settings': json = { version: 1, urgentDays: 2, warningDays: 5 }; break;
      case '/api/workspace-members': json = { members }; break;
      case '/api/approvals': json = { requests: [], pendingCount: 0, templates: [], identity, canManageTemplates: role === 'admin' }; break;
      case '/api/prospecting': json = url.searchParams.get('mode') === 'chat' ? chat : prospect; break;
      case '/api/schedules': json = url.searchParams.has('unscheduled') ? { items: [], pendingCount: 0, totalCount: 0 } : { items: [{ id: 'visual-schedule', kind: 'visit', title: '澄光咖啡现场踏勘', startAt: '2026-11-08T06:00:00.000Z', endAt: '2026-11-08T07:00:00.000Z', allDay: false, dealId: 'deal-1', location: '园区一层接待处', notes: '核对面积与装修条件', ownerAccountId: 'visual-manager', ownerName: '周予安', status: 'pending', version: 1, createdAt: now, updatedAt: now, canEdit: true }], unscheduled: [], scope: 'mine', truncated: false, scheduledTruncated: false, unscheduledCounts: { task: 0, visit: 0 }, pendingVisitCount: 1 }; break;
      case '/api/knowledge-library': json = { libraries: [{ id: 'visual-library', name: '园区招商资料', documentCount: 1 }], documents: [{ id: 'visual-document', libraryId: 'visual-library', title: '园区公开资料与交付清单', fileName: '园区公开资料.md', strategy: 'flat', status: 'ready', chunkCount: 6, indexedCount: 6, error: null, updatedAt: now }], canManage: role !== 'sales', embeddingConfigured: false }; break;
      case '/api/training-voice': json = { configured: false }; break;
      case '/api/connections': json = { model: { kind: 'model', enabled: false, configured: false, source: 'none', baseUrl: '', modelName: '', hasSecret: false, version: 1, updatedAt: null }, storageReady: true }; break;
      case '/api/embedding-connection': json = { enabled: false, configured: false, baseUrl: '', modelName: '', hasSecret: false, version: 1, source: 'none', storageReady: true }; break;
      case '/api/company-connection': json = { connection: { provider: url.searchParams.get('provider') || 'qcc', enabled: false, configured: false, endpoint: 'https://api.example.invalid/company/detail', hasCredentials: false, version: 1, updatedAt: null }, storageReady: true }; break;
      case '/api/speech-settings': json = { version: 1, hotwords: [], dialect: 'auto', diarization: false, speakerCount: null, capabilities: { configured: false, available: false, model: '', dialects: [], diarization: false, hotwords: false } }; break;
      case '/api/meeting-imports': json = { imports: [], jobs: [], devices: [], records: [], device: { online: false }, configured: false }; break;
      default: unexpectedApis.add(url.pathname); return route.fulfill({ status: 501, json: { error: 'Unmocked visual API: ' + url.pathname } });
    }
    return route.fulfill({ json });
  }
  const variants = baseline ? [['desktop', 1440, 1000, 'light'], ['mobile', 390, 844, 'light']] : [['desktop', 1440, 1000, 'light'], ['mobile', 390, 844, 'light'], ['dark', 1440, 1000, 'dark'], ['compact-980', 980, 900, 'light'], ['compact-1100', 1100, 900, 'light'], ['compact-1200', 1200, 900, 'light']];
  for (const [variant, width, height, theme] of variants) {
    for (const [name, role, query, action] of (baseline ? cases.slice(0, 1) : variant.startsWith('compact') ? cases.slice(0, 2) : correction ? cases.filter(c => correctionNames.has(c[0])) : cases)) {
      const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block', colorScheme: theme });
      context.setDefaultTimeout(8000);
      await context.addInitScript(mode => localStorage.setItem('ctai-theme', mode), theme);
      await context.route('**/*', route => routeApi(route, role));
      const page = await context.newPage();
      page.on('pageerror', error => errors.push({ name, variant, error: error.message }));
      try {
        await page.goto(`${origin}/?${query}&fixtureRole=${role}`, { waitUntil: 'networkidle' });
        await page.locator('.app-shell').waitFor({ timeout: 20000 });
        if (action === 'profile') {
          const profileVisible = await page.locator('.cw-insights').isVisible();
          if (!profileVisible) await page.getByRole('button', { name: '查看客户资料', exact: true }).click();
        }
        // Keyboard focus is exercised without invoking any business mutation.
        await page.mouse.click(width - 4, 2);
        await page.keyboard.press('Tab');
        const focus = await page.evaluate(() => { const e = document.activeElement, s = getComputedStyle(e); return { text: e.getAttribute('aria-label') || e.textContent?.trim().slice(0, 60), focusVisible: e.matches(':focus-visible'), outline: s.outline, boxShadow: s.boxShadow, renderedRing: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 || s.boxShadow !== 'none' }; });
        const audit = await page.evaluate(inspectRenderedPage);
        const captured = !correction || name === 'deals' || name === 'project-profile';
        if (captured) await page.screenshot({ path: path.join(captureDir, `${baseline ? 'baseline-' : ''}${name}-${variant}.png`), fullPage: true });
        const field = page.locator('input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="hidden"]):not([type="range"]):enabled,select:enabled,textarea:enabled').filter({ visible: true }).first();
        let fieldFocus = null;
        if (await field.count()) {
          const before = await field.evaluate(e => { const out = []; for (let p = e, i = 0; p && i < 3; p = p.parentElement, i++) { const s = getComputedStyle(p); out.push({ border: s.borderColor, outline: s.outline, boxShadow: s.boxShadow }); } return out; });
          await field.focus();
          fieldFocus = await field.evaluate((e, initial) => {
            const s = getComputedStyle(e), parents = []; let renderedRing = false;
            for (let p = e, i = 0; p && i < 3; p = p.parentElement, i++) { const ps = getComputedStyle(p), outline = ps.outlineStyle !== 'none' && parseFloat(ps.outlineWidth) > 0, shadow = ps.boxShadow !== 'none', borderChanged = initial[i]?.border !== ps.borderColor && parseFloat(ps.borderWidth) > 0; parents.push({ tag: p.tagName, class: String(p.className), border: ps.borderColor, outline: ps.outline, boxShadow: ps.boxShadow, borderChanged }); renderedRing ||= outline || shadow || borderChanged; }
            return { label: e.getAttribute('aria-label') || e.labels?.[0]?.textContent.trim() || e.getAttribute('placeholder'), focusVisible: e.matches(':focus-visible'), outline: s.outline, boxShadow: s.boxShadow, renderedRing, parents };
          }, before);
        }
        results.push({ name, variant, role, captured, focus, fieldFocus, ...audit });
        // Exercise real desktop/mobile navigation and project panel transitions once.
        if (name === 'deals' && theme === 'light' && !baseline) {
          if (width < 701) {
            await page.getByRole('button', { name: '查看客户资料', exact: true }).click();
            await page.getByRole('button', { name: '返回项目对话', exact: true }).click();
          } else {
            if (await page.getByRole('button', { name: '收起客户资料', exact: true }).isVisible()) {
              await page.getByRole('button', { name: '收起客户资料', exact: true }).click();
              await page.getByRole('button', { name: '查看客户资料', exact: true }).click();
            } else {
              await page.getByRole('button', { name: '查看客户资料', exact: true }).click();
              await page.getByRole('button', { name: '收起客户资料', exact: true }).click();
            }
          }
          const labels = ['社交平台获客', '提醒及日程', '合同及审批', '培训提升', '知识库', '项目跟进'];
          for (const label of labels) {
            const nav = page.getByRole('navigation', { name: width < 701 ? '快捷导航' : '业务导航', exact: true });
            await nav.getByRole(width < 701 ? 'button' : 'link', { name: label, exact: width < 701 }).click();
            await page.waitForTimeout(80);
            if (await page.locator('.breadcrumb strong').textContent() !== label) throw new Error('Navigation failed: ' + label);
          }
        }
      } catch (error) { errors.push({ name, variant, error: error.message }); await page.screenshot({ path: path.join(captureDir, `ERROR-${name}-${variant}.png`), fullPage: true }).catch(() => {}); }
      finally { await context.close(); }
    }
  }
  const summary = { baseline, captureDir, screens: results.length, errors, unexpectedApis: [...unexpectedApis], apiReads: [...apiReads], mutations, blockedExternal: [...blockedExternal], overflow: results.filter(r => r.overflow).map(r => `${r.name}-${r.variant}: ${r.pageWidth}`), contrast: results.filter(r => r.contrastFailures.length).map(r => ({ screen: `${r.name}-${r.variant}`, count: r.contrastFailures.length, examples: r.contrastFailures.slice(0, 12) })), inputHeights: results.filter(r => r.inputs.some(input => Math.abs(input.height - (r.variant === 'mobile' ? 44 : 36)) > .5)).map(r => ({ screen: `${r.name}-${r.variant}`, mismatches: r.inputs.filter(input => Math.abs(input.height - (r.variant === 'mobile' ? 44 : 36)) > .5) })), focusFailures: results.filter(r => !r.focus.focusVisible || !r.focus.renderedRing || r.fieldFocus && (!r.fieldFocus.focusVisible || !r.fieldFocus.renderedRing)).map(r => ({ screen: `${r.name}-${r.variant}`, navigation: r.focus, field: r.fieldFocus })), results };
  await writeFile(path.join(captureDir, baseline ? 'baseline-summary.json' : 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, results: undefined }, null, 2));
  if (errors.length || unexpectedApis.size || mutations.length || summary.overflow.length || !baseline && (summary.contrast.length || summary.inputHeights.length || summary.focusFailures.length)) process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
