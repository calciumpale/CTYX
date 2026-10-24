import assert from 'node:assert/strict';
import test from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import { importContractFile, collectContractPdfText } from '../app/lib/contract-import.ts';

const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
const docx = (body: string, extra: Record<string, Uint8Array> = {}) => new File([zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': strToU8(xml(body)), ...extra })], '销售合同.docx');

test('TXT imports UTF-8 and explicit UTF-16 without silently truncating the original clauses', async () => {
  const text = '第一条 乙方应于验收后支付全部款项。\n第二条 违约金应以合同总额为限。';
  assert.equal((await importContractFile(new File([text], '合同.TXT'))).text, text);
  const utf16 = new Uint8Array(2 + text.length * 2); utf16.set([255,254]);
  const view = new DataView(utf16.buffer); for(let i=0;i<text.length;i++) view.setUint16(2+i*2,text.charCodeAt(i),true);
  assert.equal((await importContractFile(new File([utf16], '合同.txt'))).text, text);
});

test('file validation rejects empty, oversized, binary, unsupported and overlong inputs', async () => {
  await assert.rejects(importContractFile(new File([], '空合同.txt')), /空/);
  await assert.rejects(importContractFile(new File([new Uint8Array(10*1024*1024+1)], '大合同.txt')), /10\s?MB/);
  await assert.rejects(importContractFile(new File(['abc\0def'], '二进制.txt')), /编码|二进制|乱码/);
  await assert.rejects(importContractFile(new File(['合同正文'], '合同.doc')), /TXT|DOCX|PDF/);
  await assert.rejects(importContractFile(new File(['合同'.repeat(40001)], '合同.txt')), /80,000|80000|8 万/);
  await assert.rejects(importContractFile(new File(['not a pdf'], '合同.pdf')), /PDF/);
});

test('DOCX imports paragraphs, tables, entities, revision text and footnotes without extracting media', async () => {
  const file = docx('<w:p><w:r><w:t>金额 &amp; 币种：人民币</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>支付期限</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>30日</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:del><w:r><w:delText>无条件退款</w:delText></w:r></w:del><w:ins><w:r><w:t>按责任承担</w:t></w:r></w:ins></w:p>', {
    'word/footnotes.xml': strToU8('<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="1"><w:p><w:r><w:t>附注：含税。</w:t></w:r></w:p></w:footnote></w:footnotes>'),
    'word/media/image1.png': new Uint8Array([1,2,3]),
  });
  const result = await importContractFile(file);
  assert.equal(result.format, 'docx'); assert.equal(result.fileName, '销售合同.docx');
  assert.match(result.text, /金额 & 币种：人民币/); assert.match(result.text, /支付期限/); assert.match(result.text, /30日/);
  assert.match(result.text, /删除修订：无条件退款/); assert.match(result.text, /附注：含税/);
  assert.ok(result.warnings.some(w=>/修订/.test(w))); assert.ok(result.warnings.some(w=>/图片/.test(w)));
});

test('DOCX rejects malformed XML, missing body, external chunks and encrypted/renamed documents', async () => {
  await assert.rejects(importContractFile(new File([zipSync({'word/document.xml':strToU8(xml('<w:p><w:t>合同</w:p>'))})], '坏.docx')), /损坏|XML/);
  await assert.rejects(importContractFile(new File([zipSync({'not-word.txt':strToU8('合同')})], '伪.docx')), /正文|DOCX/);
  await assert.rejects(importContractFile(docx('<w:altChunk r:id="external"/>')), /外部正文|altChunk/);
  await assert.rejects(importContractFile(new File([new Uint8Array([208,207,17,224,161,177,26,225])], '加密.docx')), /加密|DOCX/);
  await assert.rejects(importContractFile(docx('<!DOCTYPE x [<!ENTITY e SYSTEM "https://example.com">]><w:p><w:t>&e;</w:t></w:p>')), /XML|实体|损坏/);
  await assert.rejects(importContractFile(docx('<w:p><w:t>甲方 & 乙方</w:t></w:p>')), /XML|实体/);
  await assert.rejects(importContractFile(docx('<w:p/>', {'word/footnotes.xml':strToU8('<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote><w:p><w:t>只有脚注</w:t></w:p></w:footnote></w:footnotes>')})), /正文|扫描/);
});

test('DOCX rejects decompression bombs before extracting text', async () => {
  const bomb = docx(`<w:p><w:r><w:t>${'合同'.repeat(2_000_000)}</w:t></w:r></w:p>`);
  assert.ok(bomb.size < 10*1024*1024);
  await assert.rejects(importContractFile(bomb), /解压|过大|压缩/);
});

test('DOCX rejects forged entry sizes and corrupted body CRC values', async () => {
  const zip=zipSync({'word/document.xml':strToU8(xml('<w:p><w:t>合同付款条件。</w:t></w:p>'))},{level:0});
  const corrupted=zip.slice();const local=new DataView(corrupted.buffer);corrupted[30+local.getUint16(26,true)+local.getUint16(28,true)+5]^=1;
  await assert.rejects(importContractFile(new File([corrupted],'损坏.docx')), /校验|损坏/);
  const forged=zip.slice();const view=new DataView(forged.buffer);let central=-1;
  for(let i=0;i<forged.length-4;i++)if(view.getUint32(i,true)===0x02014b50){central=i;break;}
  assert.ok(central>0);view.setUint32(central+24,1,true);
  await assert.rejects(importContractFile(new File([forged],'伪造.docx')), /校验|解压|损坏/);
});

test('PDF text collector visits every page and gives explicit page separators', async () => {
  const visited:number[]=[];
  const result=await collectContractPdfText({numPages:2,async getPage(page:number){visited.push(page);return {async getTextContent(){return {items:[{str:`第${page}页合同约定`,hasEOL:true},{str:'全部付款条件。'}]};},cleanup(){}};}});
  assert.deepEqual(visited,[1,2]); assert.match(result.text,/第 1 页/); assert.match(result.text,/第 2 页/);
  assert.equal(result.pages,2);
});

test('PDF collector refuses an unreadable scanned page instead of reviewing a partial contract', async () => {
  await assert.rejects(collectContractPdfText({numPages:2,async getPage(page:number){return {async getTextContent(){return {items:page===1?[{str:'第一条 甲乙双方约定合同金额。'}]:[]};},cleanup(){}};}}), /第 2 页.*文字|扫描|OCR/);
  await assert.rejects(collectContractPdfText({numPages:201,async getPage(){throw new Error('must not read');}}), /200/);
});

test('PDF cleanup runs on extraction errors and no oversized or garbled text is silently accepted', async () => {
  let cleaned=0;
  await assert.rejects(collectContractPdfText({numPages:1,async getPage(){return {async getTextContent(){return {items:[{str:'合同'.repeat(40_001)}]};},cleanup(){cleaned++;}};}}),/80,000|80000/);
  assert.equal(cleaned,1);
  await assert.rejects(collectContractPdfText({numPages:1,async getPage(){return {async getTextContent(){return {items:[{str:'甲方\uFFFD向乙方付款。'}]};},cleanup(){cleaned++;}};}}),/乱码|编码/);
  assert.equal(cleaned,2);
});
