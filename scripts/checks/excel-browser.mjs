import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as XLSX from 'xlsx';

// Exercise the shipped parent loader, its worker factory and the worker together.
// This opens only an empty local test page; no application or account is loaded.
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const distRoot = await realpath(path.resolve(process.argv[2] || path.join(projectRoot, 'dist/client')));
const manifest = JSON.parse(await readFile(path.join(distRoot, '.vite/manifest.json'), 'utf8'));
const entry = manifest['app/lib/knowledge-excel.ts']?.file;
assert.ok(entry, 'Production manifest must expose app/lib/knowledge-excel.ts');
const { chromium } = await import(pathToFileURL(path.join(projectRoot, 'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);

const fixtures = new Map();
for (const format of ['xlsx', 'xls']) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['型号', '数量', '启用'],
    [`浏览器验收-${format}`, 42, false],
    [],
    ['中文末行', 0, true],
  ]), '产品资料');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['规则'], ['保留两个工作表'],
  ]), '说明');
  fixtures.set(`/__excel-fixtures__/fixture.${format}`, Buffer.from(XLSX.write(workbook, {
    bookType: format === 'xls' ? 'biff8' : 'xlsx', type: 'buffer',
  })));
}

const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (pathname === '/') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end('<!doctype html><html><body>Excel production bundle check</body></html>');
      return;
    }
    if (fixtures.has(pathname)) {
      response.setHeader('content-type', 'application/octet-stream');
      response.end(fixtures.get(pathname));
      return;
    }
    const filename = await realpath(path.resolve(distRoot, `.${pathname}`));
    if (!filename.startsWith(distRoot + path.sep)) {
      response.writeHead(403).end();
      return;
    }
    response.setHeader('content-type', filename.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : filename.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream');
    response.end(await readFile(filename));
  } catch {
    response.writeHead(404).end();
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const origin = `http://127.0.0.1:${server.address().port}`;
const blockedRequests = [];
const failedResponses = [];
let browser;
let page;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
      blockedRequests.push(url.href);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  await context.addInitScript(() => {
    // The shared preload helper lives in the app entry chunk. Keep its route
    // bootstrap idle so importing it cannot fetch or hydrate the real app.
    globalThis.__VINEXT_RSC_BOOTSTRAP_STATE__ = 'isolated-excel-check';
    globalThis.__excelWorkerURLs = [];
    const NativeWorker = globalThis.Worker;
    globalThis.Worker = class extends NativeWorker {
      constructor(url, options) {
        globalThis.__excelWorkerURLs.push({ url: new URL(String(url), location.href).href, type: options?.type });
        super(url, options);
      }
    };
  });
  page = await context.newPage();
  page.on('response', response => {
    if (response.status() >= 400) failedResponses.push({ url: response.url(), status: response.status() });
  });
  await page.goto(origin, { waitUntil: 'load' });
  const results = await page.evaluate(async entry => {
    const { importKnowledgeExcel } = await import(`/${entry}`);
    const results = [];
    for (const format of ['xlsx', 'xls']) {
      const response = await fetch(`/__excel-fixtures__/fixture.${format}`);
      if (!response.ok) throw new Error(`Fixture request failed: ${response.status}`);
      const file = new File([await response.arrayBuffer()], `fixture.${format}`);
      const result = await importKnowledgeExcel(file, format);
      results.push({ format, ...result });
    }
    return results;
  }, entry);

  for (const result of results) {
    assert.match(result.text, /## 工作表：产品资料/);
    assert.ok(result.text.includes(`第2行：A2=浏览器验收-${result.format}；B2=42；C2=FALSE`), `${result.format}: preserve row addresses and cell values`);
    assert.match(result.text, /第4行：A4=中文末行；B4=0；C4=TRUE/);
    assert.match(result.text, /## 工作表：说明/);
    assert.match(result.text, /第2行：A2=保留两个工作表/);
    assert.ok(Array.isArray(result.warnings));
  }
  const workerURLs = await page.evaluate(() => globalThis.__excelWorkerURLs);
  assert.equal(workerURLs.length, 2, 'Both formats must use a real browser Worker');
  for (const worker of workerURLs) {
    const url = new URL(worker.url);
    assert.equal(url.origin, origin, 'Worker URL must resolve to the page origin');
    assert.ok(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)), 'Worker URL must use HTTPS or loopback HTTP');
    assert.equal(worker.type, 'module');
  }
  assert.deepEqual(blockedRequests, [], 'No external requests are allowed');
  assert.deepEqual(failedResponses, [], 'All requested production assets must exist');
  console.log(JSON.stringify({ status: 'PASS', distRoot, entry, formats: results.map(result => result.format), workerURLs }));
} catch (error) {
  const workerURLs = page ? await page.evaluate(() => globalThis.__excelWorkerURLs).catch(() => []) : [];
  console.error(JSON.stringify({ status: 'FAIL', entry, workerURLs, blockedRequests, failedResponses, error: error.message }));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
