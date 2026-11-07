import assert from 'node:assert/strict';
import test from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import { importKnowledgeFile } from '../app/lib/knowledge-library-import.ts';
import { collectContractPdfText, importContractFile, type ContractTextPdf } from '../app/lib/contract-import.ts';

const docx = (text: string, padding = '') => new File([zipSync({
  'word/document.xml': strToU8(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><!--${padding}--><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`),
}, { level: 0 })], '产品.docx');

const textPdf = (pages: string[]): ContractTextPdf => ({
  numPages: pages.length,
  async getPage(page) {
    return { async getTextContent() { return { items: [{ str: pages[page - 1] }] }; }, cleanup() {} };
  },
});

test('TXT, Markdown and CSV retain source evidence and the original filename', async () => {
  for (const [name, text] of [['产品.TXT', '型号 AB-12\n保修期：一年。'], ['产品.md', '# 产品资料\n\n价格以合同为准。'], ['说明.markdown', '## 限制\n不可用于室外。'], ['价格.csv', '型号,说明,价格\nAB-12,"含税,含运费",2000\n']]) {
    const result = await importKnowledgeFile(new File([text], name));
    assert.equal(result.text, text.trim()); assert.equal(result.fileName, name); assert.ok(Array.isArray(result.warnings));
  }
});

test('knowledge text formats accept one million characters without truncating source evidence', async () => {
  const text = '字'.repeat(1_000_000);
  for (const extension of ['txt', 'md', 'markdown', 'csv']) {
    const result = await importKnowledgeFile(new File([text], `产品.${extension}`));
    assert.equal(result.text, text);
    assert.equal(result.fileName, `产品.${extension}`);
  }
});

test('contract text imports retain their eighty thousand character default', async () => {
  const result = await importContractFile(new File(['字'.repeat(80_000)], '合同.txt'));
  assert.equal(result.text.length, 80_000);
  await assert.rejects(importContractFile(new File(['字'.repeat(80_001)], '合同.txt')), /80,000/);
});

test('legacy text encoding support is reused for Markdown without changing its filename', async () => {
  const text = '# 使用说明\n安全使用产品。';
  const bytes = new Uint8Array(2 + text.length * 2); bytes.set([255, 254]);
  const view = new DataView(bytes.buffer); for (let i = 0; i < text.length; i++) view.setUint16(2 + i * 2, text.charCodeAt(i), true);
  const result = await importKnowledgeFile(new File([bytes], '说明.md'));
  assert.equal(result.text, text); assert.equal(result.fileName, '说明.md');
});

test('DOCX reuses bounded text extraction and reports unsupported media', async () => {
  const xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>第一章 产品说明</w:t></w:r></w:p><w:p><w:r><w:t>支持本地部署 &amp; 权限控制。</w:t></w:r></w:p></w:body></w:document>';
  const file = new File([zipSync({ 'word/document.xml': strToU8(xml), 'word/media/image.png': new Uint8Array([1]) })], '产品.docx');
  const result = await importKnowledgeFile(file);
  assert.equal(result.text, '第一章 产品说明\n支持本地部署 & 权限控制。');
  assert.ok(result.warnings.some(warning => warning.includes('图片')));
});

test('knowledge DOCX supports a million Chinese characters with document XML larger than two MiB', async () => {
  const text = '字'.repeat(1_000_000);
  const file = docx(text, 'x'.repeat(5 * 1024 * 1024));
  assert.ok(file.size < 10 * 1024 * 1024);
  const result = await importKnowledgeFile(file);
  assert.equal(result.text, text);
  await assert.rejects(importContractFile(file), /解压|过大/);
});

test('knowledge DOCX rejects text beyond one million characters without truncation', async () => {
  await assert.rejects(importKnowledgeFile(docx('字'.repeat(1_000_001))), /1,000,000/);
});

test('knowledge PDF collection accepts one million characters including page labels', async () => {
  const result = await collectContractPdfText(textPdf(['字'.repeat(999_992)]), { textLimit: 1_000_000 });
  assert.equal(result.text.length, 1_000_000);
  assert.ok(result.text.endsWith('字'.repeat(100)));
  assert.equal(result.pages, 1);
});

test('knowledge PDF collection rejects excess aggregate text and preserves contract defaults', async () => {
  const document = textPdf(['字'.repeat(600_000), '字'.repeat(600_000)]);
  await assert.rejects(collectContractPdfText(document, { textLimit: 1_000_000 }), /1,000,000/);
  await assert.rejects(collectContractPdfText(textPdf(['字'.repeat(80_001)])), /80,000/);
});

test('knowledge import rejects oversized, empty, binary, unsupported and overlong files without truncation', async () => {
  await assert.rejects(importKnowledgeFile(new File([], '空.md')), /空/);
  await assert.rejects(importKnowledgeFile(new File([new Uint8Array(10 * 1024 * 1024 + 1)], '大.md')), /10\s?MB/);
  await assert.rejects(importKnowledgeFile(new File(['字'.repeat(1_000_001)], '长.csv')), /1,000,000/);
  await assert.rejects(importKnowledgeFile(new File(['hello\0world'], 'binary.txt')), /二进制|编码/);
  await assert.rejects(importKnowledgeFile(new File(['产品说明'], '产品.ods')), /PDF|DOCX|TXT|CSV/);
  await assert.rejects(importKnowledgeFile(new File(['not a PDF'], '产品.pdf')), /PDF/);
});

test('unreadable document errors ask for OCR and use document terminology', async () => {
  const xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>';
  await assert.rejects(importKnowledgeFile(new File([zipSync({ 'word/document.xml': strToU8(xml) })], '扫描件.docx')), error => {
    assert.ok(error instanceof Error); assert.match(error.message, /OCR/); assert.ok(!error.message.includes('合同')); return true;
  });
});
