import assert from 'node:assert/strict';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { DomainError } from '../app/lib/domain.ts';
import { pollMineruPdf, submitMineruPdf } from '../app/lib/mineru-client.ts';
import { KNOWLEDGE_TEXT_LIMIT } from '../app/lib/knowledge-library-types.ts';

const token = 'test-token-not-for-oss';
const batchId = '2bb2f0ec-a336-4a0a-b61a-241afaf9cc87';
const putUrl = 'https://mineru.oss-cn-shanghai.aliyuncs.com/api-upload/file?signature=sample';
const zipUrl = 'https://cdn-mineru.openxlab.org.cn/pdf/sample.zip';
const pdf = new File(['%PDF-1.7\nPDF sample'], '采购资料.pdf', { type: 'application/pdf' });
const acceptedBatch = (url = putUrl) => Response.json({ code: 0, data: { batch_id: batchId, file_urls: [url] } });
const result = (entry: object) => Response.json({ code: 0, data: { batch_id: batchId, extract_result: [entry] } });
const responseZip = (files: Record<string, Uint8Array>) => new Response(new Uint8Array(zipSync(files)));
const rejectsWith = (status: number, match: RegExp) => (error: unknown) => error instanceof DomainError && error.status === status && match.test(error.message);

test('signed upload submits a single OCR PDF and only sends the token to the MinerU API', async () => {
  const calls: string[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    const req = new Request(input, init);
    assert.equal(req.redirect, 'manual');
    if (url.endsWith('/file-urls/batch')) {
      assert.equal(req.headers.get('Authorization'), `Bearer ${token}`);
      assert.deepEqual(await req.json(), { model_version: 'vlm', enable_table: true, enable_formula: true, files: [{ name: 'document.pdf', is_ocr: true }] });
      return acceptedBatch();
    }
    assert.equal(url, putUrl);
    assert.equal(req.method, 'PUT');
    assert.equal(req.headers.has('Authorization'), false);
    assert.equal(req.headers.has('Content-Type'), false);
    assert.equal(await req.text(), await pdf.text());
    return new Response(null, { status: 200 });
  };
  assert.equal(await submitMineruPdf(token, pdf, request), batchId);
  assert.deepEqual(calls, ['https://mineru.net/api/v4/file-urls/batch', putUrl]);
});

test('polls conversion and progress before extracting Markdown from the completed ZIP', async () => {
  let polls = 0;
  const markdown = '# 识别正文\n\n| 资料 | 内容 |\n| --- | --- |\n| 扫描 | 识别结果 |';
  const request: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    assert.equal(req.redirect, 'manual');
    if (req.url === zipUrl) {
      assert.equal(req.headers.has('Authorization'), false);
      return responseZip({ 'full.md': strToU8(markdown), 'images/sample.jpg': new Uint8Array([0, 1, 2]) });
    }
    assert.equal(req.url, `https://mineru.net/api/v4/extract-results/batch/${batchId}`);
    assert.equal(req.headers.get('Authorization'), `Bearer ${token}`);
    if (++polls === 1) return result({ state: 'converting' });
    if (polls === 2) return result({ state: 'running', extract_progress: { extracted_pages: 2, total_pages: 3 } });
    return result({ state: 'done', full_zip_url: zipUrl });
  };
  assert.deepEqual(await pollMineruPdf(token, batchId, request), { status: 'pending' });
  assert.deepEqual(await pollMineruPdf(token, batchId, request), { status: 'running', pages: 2, totalPages: 3 });
  assert.deepEqual(await pollMineruPdf(token, batchId, request), { status: 'done', text: markdown });
});

test('rejects signed links outside documented origins and never follows redirects', async () => {
  let calls = 0;
  await assert.rejects(submitMineruPdf(token, pdf, async () => {
    calls++;
    return acceptedBatch('https://mineru.oss-cn-shanghai.aliyuncs.com.evil.example/');
  }), rejectsWith(502, /上传地址/));
  assert.equal(calls, 1);
  await assert.rejects(pollMineruPdf(token, batchId, async () => result({ state: 'done', full_zip_url: 'https://user@cdn-mineru.openxlab.org.cn/pdf/sample.zip' })), rejectsWith(502, /结果地址/));
  await assert.rejects(submitMineruPdf(token, pdf, async (_input, init) => {
    assert.equal(init?.redirect, 'manual');
    return new Response(null, { status: 302, headers: { Location: 'https://other.example/' } });
  }), rejectsWith(502, /MinerU/));
});

test('reports safe remediation without echoing provider error details', async () => {
  const secret = 'https://untrusted.example/private?token=PRIVATE';
  await assert.rejects(submitMineruPdf(token, pdf, async () => Response.json({ code: 'A0211', msg: secret })), rejectsWith(503, /Token/));
  await assert.rejects(pollMineruPdf(token, batchId, async () => Response.json({ msgCode: 'A0211', msg: secret })), rejectsWith(503, /Token/));
  await assert.rejects(pollMineruPdf(token, batchId, async () => Response.json({ code: -60012, msg: secret })), rejectsWith(410, /任务/));
  await assert.rejects(pollMineruPdf(token, batchId, async () => result({ state: 'failed', err_msg: secret })), (error: unknown) => rejectsWith(422, /解析失败/)(error) && !String(error).includes(secret));
  await assert.rejects(pollMineruPdf(token, batchId, async () => { throw new DomainError(secret, 422); }), (error: unknown) => rejectsWith(502, /暂时无法连接/)(error) && !String(error).includes(secret));
});

test('ignores other files and rejects ambiguous, corrupt or oversized Markdown', async () => {
  const parse = (createZip: () => Response) => pollMineruPdf(token, batchId, async input => String(input) === zipUrl ? createZip() : result({ state: 'done', full_zip_url: zipUrl }));
  await assert.rejects(parse(() => responseZip({ 'full.md': strToU8('甲'), 'other/full.md': strToU8('乙') })), rejectsWith(422, /结果/));
  await assert.rejects(parse(() => responseZip({ '../full.md': strToU8('甲') })), rejectsWith(422, /结果/));
  await assert.rejects(parse(() => responseZip({ 'full.md': strToU8('a'.repeat(KNOWLEDGE_TEXT_LIMIT + 1)) })), rejectsWith(413, /拆分/));
  await assert.rejects(parse(() => responseZip({ 'full.md': new Uint8Array([0xff]) })), rejectsWith(422, /结果/));
  await assert.rejects(parse(() => new Response('x', { headers: { 'Content-Length': String(64 * 1024 * 1024) } })), rejectsWith(413, /拆分/));
  await assert.rejects(parse(() => responseZip({ 'elsewhere.md': strToU8('可识别内容') })), rejectsWith(422, /结果/));
});

test('enforces the download size without Content-Length and verifies the selected ZIP entry CRC', async () => {
  const parse = (createZip: () => Response) => pollMineruPdf(token, batchId, async input => String(input) === zipUrl ? createZip() : result({ state: 'done', full_zip_url: zipUrl }));
  let stopped = false;
  await assert.rejects(parse(() => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024)); },
    cancel() { stopped = true; },
  }))), rejectsWith(413, /拆分/));
  assert.equal(stopped, true);
  const corrupt = new Uint8Array(zipSync({ 'full.md': strToU8('ABC') }, { level: 0 }));
  // Stored payload starts immediately after the local header and seven-byte name.
  corrupt[30 + 7] ^= 0x01;
  await assert.rejects(parse(() => new Response(corrupt)), rejectsWith(422, /结果/));
});
