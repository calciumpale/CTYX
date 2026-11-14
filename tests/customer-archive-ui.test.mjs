import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {CustomerWorkspace} from '/app/components/CustomerWorkspace.tsx';import {ProjectsView} from '/app/components/ProjectWorkspace.tsx';import {createSeed} from '/app/lib/seed.ts';import '/app/globals.css';
const now='2026-11-08T00:00:00Z';const seed=createSeed(now);const base={...seed.deals[0],owner:'ZS',ownerId:'sales-1',summary:'',contact:'',position:'',notes:[],needs:[],risks:[],amount:0,health:0};const active={...base,id:'new',name:'公开企业有限公司',projectName:'公开企业线索',dataOrigin:'research',companyProfile:{companyName:'公开企业有限公司',summary:'公开机构资料；尚未确认采购需求或建立客户关系。',provider:'web',status:'ready',modelUsed:false,updatedAt:now,facts:[{label:'地区',value:'嘉兴',sourceIds:['official']}],sources:[{id:'official',title:'官方机构名录',url:'https://example.com/registry',provider:'web',retrievedAt:now,snippet:'资料日期：2024-06-30'}],warnings:['当前登记、许可及营业状态尚未核验。']}};const old={...base,id:'old',name:'历史企业',projectName:'历史项目',archive:{at:now,reason:'五科室企业目录替换；历史保留',migrationKey:'setup'},notes:[{id:'note',text:'历史客户原话',author:'ZS',date:now}]};
function Fixture() {
  const [state,setState] = useState({ ...seed, deals:[active,old], salesOwners:[{salesId:'sales-empty',displayName:'WL'}], runs:[{id:'old-chat',dealId:'old',createdAt:now,query:'历史提问',answer:'历史回答',agentIds:['insight'],steps:[],citations:[],mode:'demo',duration:1}] });
  window.refreshFixture = () => setState(s => ({ ...s, revision:s.revision+1 }));
  window.setIntentFixture = ({ grade, score, stale = false }) => setState(current => ({
    ...current,
    deals: current.deals.map(deal => {
      if (deal.id !== 'new') return deal;
      const latest = {
        sourceHash: 'fixture', sourceVersion: deal.version - Number(stale), assessedAt: now, modelName: '测试模型',
        insight: { grade, score, summary: '意向依据', dimensions: [], nextActions: [], missingInfo: [] },
        forecast: { kind: 'estimated', probability: 21, range: null, confidence: null, summary: '成交估计依据', factors: [], nextActions: [] },
        warnings: [],
      };
      return { ...deal, intelligence: { status: grade ? 'ready' : 'needs_info', sourceHash: 'fixture', updatedAt: now, modelName: '测试模型', message: '', history: [], latest } };
    }),
  }));
  const params = new URLSearchParams(location.search);
  const View = params.has('legacy') ? ProjectsView : CustomerWorkspace;
  return <View state={state} member={{role:'manager',salesId:'manager',displayName:'管理者'}} mutate={async(action,payload)=>{window.lastMutation={action,payload};return {state,message:'已保存'};}} notify={()=>{}} initialDealId={params.get('deal')} onNavigate={(view,id)=>{window.navigation={view,id}}} onBusyChange={value=>{window.workspaceBusy=value}}/>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);`;

async function createFixture() {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'archive-ui-vite-'));
  const entry = path.join(root, '__archive-fixture.jsx');
  const server = await createServer({ root, configFile:false, logLevel:'error', cacheDir, resolve:{dedupe:['react','react-dom']}, optimizeDeps:{include:['react','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime','lucide-react']}, plugins:[react(),{
    name:'archive-fixture', resolveId(id){if(id==='/__archive-fixture.jsx')return entry;},load(id){if(id===entry)return fixture;},configureServer(server){server.middlewares.use(async(req,res,next)=>{if(!req.url?.startsWith('/?')&&req.url!=='/')return next();res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/','<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__archive-fixture.jsx"></script></body></html>'));});}
  }],server:{host:'127.0.0.1',port:0,hmr:false}});
  await server.listen();return {server,cacheDir,origin:server.resolvedUrls.local[0].replace(/\/$/,'')};
}

test('archive directory retains per-project drafts, history and contracts navigation; research and roster remain distinct', {timeout:60000}, async()=>{
  const {chromium}=await import(pathToFileURL(path.join(root,'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);const {server,origin,cacheDir}=await createFixture();let browser;
  try{browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(origin);
    await page.getByRole('button',{name:/公开企业有限公司/}).waitFor();assert.equal(await page.getByRole('button',{name:/历史企业/}).count(),0);await page.getByLabel('向 AI 询问当前项目').fill('当前线索草稿');await page.getByRole('button',{name:/归档历史/}).click();await page.getByRole('button',{name:/历史企业/}).waitFor();await page.getByText('历史回答',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.workspaceBusy),false);await page.getByLabel('向 AI 询问当前项目').fill('归档讨论草稿');await page.locator('summary[aria-label="项目操作"]').click();await page.getByRole('button',{name:'查看项目合同'}).click();assert.deepEqual(await page.evaluate(()=>window.navigation),{view:'contracts',id:'old'});await page.getByRole('button',{name:/当前企业/}).click();assert.equal(await page.getByLabel('向 AI 询问当前项目').inputValue(),'当前线索草稿');await page.evaluate(()=>window.refreshFixture());assert.equal(await page.getByLabel('向 AI 询问当前项目').inputValue(),'当前线索草稿');await page.locator('.cw-chat-title').getByText('公开线索 · 待开发',{exact:true}).waitFor();
    assert.equal(await page.locator('.cw-record-status').count(),0);
    await page.locator('.cw-sources > summary').click();await page.locator('.cw-sources small').filter({hasText:'资料日期：2024-06-30'}).waitFor();await page.getByRole('button',{name:/归档历史/}).click();assert.equal(await page.getByLabel('向 AI 询问当前项目').inputValue(),'归档讨论草稿');await page.getByRole('button',{name:'新建企业或项目'}).click();await page.getByLabel('项目负责人').selectOption('sales-empty');await page.getByLabel(/^客户企业/).fill('新建企业');await page.getByLabel(/^项目名称/).fill('新建项目');await page.getByRole('button',{name:'创建项目',exact:true}).click();assert.equal((await page.evaluate(()=>window.lastMutation)).payload.ownerId,'sales-empty');
    await page.goto(origin+'/?deal=old');await page.getByText('历史回答',{exact:true}).waitFor();await page.locator('.cw-materials > summary').click();await page.getByText('历史客户原话',{exact:true}).waitFor();await page.getByText('已归档',{exact:true}).waitFor();await page.locator('.cw-record-status').getByText(/历史保留/).waitFor();await mkdir(path.join(root,'.superpowers/sdd/2026-11-08-five-departments/artifacts'),{recursive:true});await page.screenshot({path:path.join(root,'.superpowers/sdd/2026-11-08-five-departments/artifacts/archive-desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'返回企业通讯录'}).click();await page.getByRole('button',{name:/当前企业/}).click();await page.getByRole('button',{name:/公开企业有限公司/}).click();await page.getByRole('button',{name:'查看客户资料'}).click();await page.screenshot({path:path.join(root,'.superpowers/sdd/2026-11-08-five-departments/artifacts/archive-mobile.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.equal(await page.getByRole('button',{name:'收起客户资料'}).evaluate(el=>el.getBoundingClientRect().height>=44),true);assert.deepEqual(errors,[]);
  }finally{await browser?.close();await server.close();await rm(cacheDir,{recursive:true,force:true});}
});

test('legacy project view excludes archives by default and exposes explicit history and roster', {timeout:60000}, async()=>{
  const {chromium}=await import(pathToFileURL(path.join(root,'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);const {server,origin,cacheDir}=await createFixture();let browser;
  try{browser=await chromium.launch({headless:true});const page=await browser.newPage();await page.route('**/api/approvals**',route=>route.fulfill({json:{requests:[]}}));await page.goto(origin+'/?legacy=1');await page.getByRole('button',{name:/公开企业线索/}).first().waitFor();assert.equal(await page.getByRole('button',{name:/历史项目/}).count(),0);await page.getByRole('button',{name:/归档历史/}).click();await page.getByRole('button',{name:/历史项目/}).first().click();await page.getByText('已归档',{exact:true}).waitFor();await page.getByRole('button',{name:'返回项目跟进'}).click();await page.getByRole('button',{name:'新建项目',exact:true}).click();await page.getByLabel('项目负责人').selectOption('sales-empty');await page.getByLabel(/^项目名称/).fill('经理代建项目');await page.getByLabel(/^客户企业/).fill('新客户');await page.getByRole('button',{name:'创建项目',exact:true}).click();assert.equal((await page.evaluate(()=>window.lastMutation)).payload.ownerId,'sales-empty');
  }finally{await browser?.close();await server.close();await rm(cacheDir,{recursive:true,force:true});}
});

test('customer details header shows the current intent score and links to the existing assessment', { timeout: 30000 }, async () => {
  const { chromium } = await import(pathToFileURL(path.join(root, 'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);
  const { server, origin, cacheDir } = await createFixture();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(origin);
    const header = page.locator('.cw-insights-heading');
    await header.getByRole('heading', { name: '客户资料' }).waitFor();
    assert.match(await header.innerText(), /尚未评估/);

    const editProject = page.getByRole('button', { name: '编辑', exact: true });
    const projectDialog = page.getByRole('dialog', { name: '编辑项目资料', exact: true });
    await editProject.click();
    const centered = () => projectDialog.evaluate(dialog => {
      const rect = dialog.getBoundingClientRect();
      return Math.abs(rect.left + rect.width / 2 - innerWidth / 2) <= 1
        && Math.abs(rect.top + rect.height / 2 - innerHeight / 2) <= 1;
    });
    assert.equal(await centered(), true);
    await page.setViewportSize({ width: 1384, height: 480 });
    assert.equal(await centered(), true);
    assert.equal(await projectDialog.evaluate(dialog => dialog.scrollHeight > dialog.clientHeight), true);
    await projectDialog.getByRole('button', { name: '保存资料', exact: true }).scrollIntoViewIfNeeded();
    assert.equal(await projectDialog.getByRole('button', { name: '保存资料', exact: true }).evaluate(button => {
      const dialog = button.closest('dialog');
      return button.getBoundingClientRect().bottom <= dialog.getBoundingClientRect().bottom;
    }), true);
    await page.keyboard.press('Escape');
    await projectDialog.waitFor({ state: 'hidden' });
    await page.setViewportSize({ width: 1440, height: 900 });

    const directory = page.getByRole('complementary', { name: '企业通讯录', exact: true });
    const collapseDirectory = directory.getByRole('button', { name: '收起企业目录', exact: true });
    const restoreDirectory = directory.getByRole('button', { name: '展开企业目录', exact: true });
    const filter = directory.getByRole('textbox', { name: '搜索企业、项目或联系人', exact: true });
    const composer = page.getByRole('textbox', { name: '向 AI 询问当前项目', exact: true });
    const conversation = page.getByRole('region', { name: '企业 AI 对话', exact: true });
    await filter.fill('公开企业');
    await composer.fill('折叠前的项目草稿');
    const widthBeforeCollapse = (await conversation.boundingBox()).width;
    assert.equal(await collapseDirectory.getAttribute('aria-expanded'), 'true');
    const controls = await collapseDirectory.getAttribute('aria-controls');
    assert.ok(controls);
    await collapseDirectory.press('Enter');
    await restoreDirectory.waitFor();
    assert.equal(await restoreDirectory.getAttribute('aria-expanded'), 'false');
    assert.equal(await restoreDirectory.getAttribute('aria-controls'), controls);
    assert.equal(await restoreDirectory.evaluate(button => document.activeElement === button), true);
    assert.equal(await filter.isVisible(), false);
    assert.ok((await conversation.boundingBox()).width > widthBeforeCollapse + 100, 'collapsing returns the directory space to the project');
    assert.equal(await composer.inputValue(), '折叠前的项目草稿');
    await restoreDirectory.press('Enter');
    assert.equal(await collapseDirectory.getAttribute('aria-expanded'), 'true');
    assert.equal(await collapseDirectory.evaluate(button => document.activeElement === button), true);
    assert.equal(await filter.inputValue(), '公开企业');
    assert.equal(await composer.inputValue(), '折叠前的项目草稿');
    await filter.fill('');
    await composer.fill('');

    for (const [grade, score, label] of [['A', 88, '高意向'], ['B', 58, '中意向'], ['C', 0, '低意向']]) {
      await page.evaluate(value => window.setIntentFixture(value), { grade, score });
      const scoreButton = header.getByRole('button', { name: new RegExp(`${grade}.*${label}.*${score}.*100`) });
      await scoreButton.waitFor();
      assert.doesNotMatch(await scoreButton.innerText(), /21%/);
      assert.equal(await header.evaluate(node => node.scrollWidth <= node.clientWidth), true);
    }

    await page.evaluate(() => window.setIntentFixture({ grade: 'A', score: 88, stale: true }));
    await header.getByText('待重新评估', { exact: true }).waitFor();
    assert.doesNotMatch(await header.innerText(), /88/);
    await page.evaluate(() => window.setIntentFixture({ grade: null, score: null }));
    await header.getByText('资料不足', { exact: true }).waitFor();
    assert.doesNotMatch(await header.innerText(), /\/\s*100/);

    await page.setViewportSize({ width: 320, height: 700 });
    assert.equal(await collapseDirectory.isVisible(), false, 'mobile keeps the existing directory screen');
    await page.getByRole('button', { name: /公开企业有限公司/ }).click();
    await page.getByRole('button', { name: '查看客户资料' }).click();
    await page.evaluate(() => window.setIntentFixture({ grade: 'A', score: 88 }));
    const mobileScore = header.getByRole('button', { name: /A.*高意向.*88.*100/ });
    await mobileScore.click();
    await page.getByRole('button', { name: '重新评估' }).waitFor();
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.matches('[tabindex="-1"]') && document.activeElement.querySelector('[aria-label="AI 销售分析"]'))), true);
    assert.equal(await page.evaluate(() => window.lastMutation), undefined);
    assert.equal(await header.evaluate(node => node.scrollWidth <= node.clientWidth), true);
    assert.equal(await mobileScore.evaluate(node => node.getBoundingClientRect().height >= 44), true);
  } finally {
    await browser?.close();
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});
