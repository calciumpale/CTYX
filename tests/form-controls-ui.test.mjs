import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import '/app/globals.css';
import {KnowledgeLibraries} from '/app/components/KnowledgeLibraries.tsx';
import {ApiConnectionSettings} from '/app/components/ApiConnectionSettings.tsx';
import MaterialConnectionSettings from '/app/components/MaterialConnectionSettings.tsx';
import WebProspecting from '/app/components/WebProspecting.tsx';
import {ProjectsView} from '/app/components/ProjectWorkspace.tsx';
import {createSeed} from '/app/lib/seed.ts';
const which = new URLSearchParams(location.search).get('module');
const seed = createSeed('2026-11-08T00:00:00Z');
const views = {
 knowledge: <KnowledgeLibraries notify={()=>{}}/>,
 settings: <><ApiConnectionSettings/><MaterialConnectionSettings/></>,
 web: <div style={{height:900}}><WebProspecting/></div>,
 projects: <ProjectsView state={seed} member={{role:'manager',salesId:'manager',displayName:'管理者'}} mutate={async()=>({state:seed})} notify={()=>{}}/>,
 types: <div style={{display:"grid",gap:8,maxWidth:300}}><input aria-label="text"/><input type="number"/><input type="date"/><input type="search"/><select><option>选项</option></select><textarea rows="4"/><input type="checkbox"/><input type="radio"/><input type="file"/><input type="range"/><input type="color"/></div>,
};
createRoot(document.getElementById('root')).render(<main style={{padding:16,minWidth:0}}>{views[which]}</main>);
`;

async function createFixture() {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'form-controls-ui-'));
  const entry = path.join(root, '__form-controls-fixture.jsx');
  const server = await createServer({root, configFile:false, logLevel:'error', cacheDir,
    resolve:{dedupe:['react','react-dom']}, optimizeDeps:{include:['react','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime','lucide-react']},
    plugins:[react(), {name:'form-controls-fixture',
      resolveId(id){if(id==='/__form-controls-fixture.jsx') return entry;},
      load(id){if(id===entry)return fixture;},
      configureServer(server){server.middlewares.use(async(req,res,next)=>{
        if(!req.url?.startsWith('/?'))return next();
        res.setHeader('Content-Type','text/html');
        res.end(await server.transformIndexHtml('/', '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__form-controls-fixture.jsx"></script></body></html>'));
      });},
    }], server:{host:'127.0.0.1',port:0,hmr:false},
  });
  await server.listen();
  return {server,cacheDir,origin:server.resolvedUrls.local[0].replace(/\/$/,'')};
}

const singleLine = 'input:not([type=checkbox],[type=radio],[type=file],[type=range],[type=color],[type=hidden]), select:not([multiple])';

test('existing module controls share outer border geometry on desktop and mobile', {timeout:120000}, async()=>{
  const {chromium}=await import(pathToFileURL(path.join(root,'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);
  const {server,cacheDir,origin}=await createFixture();
  let browser;
  try {
    browser=await chromium.launch({headless:true});
    const page=await browser.newPage();
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    let writes=0;
    await page.route('**/api/**',route=>{
      if(route.request().method()!=='GET')writes++;
      const url=new URL(route.request().url());
      const data=url.pathname==='/api/knowledge-library'?{libraries:[{id:'library',name:'测试知识库',description:'',documentCount:0,chunkCount:0}],documents:[],canManage:true,embeddingConfigured:false}:
        url.pathname==='/api/connections'?{model:{kind:'model',source:'none',configured:false,enabled:false,hasSecret:false,version:0,baseUrl:'',modelName:''},storageReady:true}:
        url.pathname==='/api/material-connection'?{connection:{kind:'apimart',configured:false,enabled:false,hasSecret:false,version:0,imageModel:'gpt-image-1-official',storageReady:true}}:
        {tasks:[],leads:[],owners:[],requests:[]};
      return route.fulfill({json:data});
    });
    for(const width of [1280,760,390]) {
      await page.setViewportSize({width,height:900});
      const expected=width>850?36:44;
      for(const viewName of ['knowledge','settings','web','projects','types']) {
        await page.goto(origin+'/?module='+viewName);
        if(viewName==='knowledge')await page.getByRole('button',{name:'检索测试',exact:true}).click();
        await page.locator(singleLine).first().waitFor();
        if(viewName==='settings')await page.waitForFunction(()=>!document.querySelector('.api-settings fieldset').disabled);
        const geometry=await page.locator(singleLine).evaluateAll(elements=>elements.filter(el=>el.getClientRects().length).map(el=>{
          const parent=el.closest('.api-settings-key-input,.project-search,.search-field,.approval-search,.studio-search,.builder-search,.talk-library-search,.run-history-search,.meeting-search-input,.sales-report-controls > label');
          const outer=parent||el, rect=outer.getBoundingClientRect(), inner=el.getBoundingClientRect();
          return {tag:el.tagName,type:el.type,classes:outer.className,height:rect.height,innerHeight:inner.height,contained:inner.top>=rect.top&&inner.bottom<=rect.bottom};
        }));
        assert.ok(geometry.length>0,viewName);
        console.log(JSON.stringify({width,viewName,expected,controls:geometry}));
        for(const control of geometry) {
          assert.equal(control.height,expected,JSON.stringify({width,viewName,control}));
          assert.ok(control.contained,JSON.stringify({width,viewName,control}));
        }
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${viewName} overflow at ${width}`);
        if((viewName==='settings'||viewName==='knowledge')&&width!==760)await page.screenshot({path:`/tmp/ctyx-control-height-${viewName}-${width}.png`,fullPage:true});
        if(viewName==='types') {
          assert.ok(await page.locator('textarea').evaluate(el=>el.getBoundingClientRect().height)>expected);
          assert.ok(await page.locator('input[type=checkbox]').evaluate(el=>el.getBoundingClientRect().height)<expected);
          await page.locator('input[type=checkbox]').check();
          await page.locator('input[type=radio]').check();
          assert.equal(await page.locator('input[type=checkbox]').isChecked(),true);
          assert.equal(await page.locator('input[type=radio]').isChecked(),true);
          await page.locator('input[type=file]').setInputFiles({name:'fixture.txt',mimeType:'text/plain',buffer:Buffer.from('fixture')});
          assert.equal(await page.locator('input[type=file]').evaluate(el=>el.files[0].name),'fixture.txt');
        }
      }
    }
    assert.equal(writes,0);
    assert.deepEqual(errors,[]);
  } finally {
    await browser?.close();
    await server.close();
    await rm(cacheDir,{recursive:true,force:true});
  }
});
