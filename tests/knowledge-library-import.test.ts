import assert from 'node:assert/strict';
import test from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import { importKnowledgeFile } from '../app/lib/knowledge-library-import.ts';

test('TXT, Markdown and CSV retain source evidence and the original filename', async () => {
  for (const [name, text] of [['产品.TXT', '型号 AB-12\n保修期：一年。'], ['产品.md', '# 产品资料\n\n价格以合同为准。'], ['说明.markdown', '## 限制\n不可用于室外。'], ['价格.csv', '型号,说明,价格\nAB-12,"含税,含运费",2000\n']]) {
    const result = await importKnowledgeFile(new File([text], name));
    assert.equal(result.text, text.trim()); assert.equal(result.fileName, name); assert.ok(Array.isArray(result.warnings));
  }
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

test('knowledge import rejects oversized, empty, binary, unsupported and overlong files without truncation', async () => {
  await assert.rejects(importKnowledgeFile(new File([], '空.md')), /空/);
  await assert.rejects(importKnowledgeFile(new File([new Uint8Array(10 * 1024 * 1024 + 1)], '大.md')), /10\s?MB/);
  await assert.rejects(importKnowledgeFile(new File(['字'.repeat(80_001)], '长.csv')), /80,000|80000/);
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
