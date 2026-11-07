import assert from 'node:assert/strict';
import test from 'node:test';
import { strToU8, Zip, ZipDeflate, zipSync } from 'fflate';
import { validateExcelArchive } from '../app/lib/knowledge-excel-archive.ts';

const MB = 1024 * 1024;
const core = { 'xl/workbook.xml': strToU8('<workbook/>'), 'xl/worksheets/sheet1.xml': strToU8('<worksheet/>') };
const workbook = (extra: Record<string, Uint8Array> = {}, level: 0 | 6 = 6) => zipSync({ ...core, ...extra }, { level });
interface EntryLocation { central: number; local: number; data: number; name: string; }
function locations(bytes: Uint8Array): { view: DataView; end: number; entries: EntryLocation[] } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), end = bytes.length - 22;
  const entries: EntryLocation[] = [];
  let central = view.getUint32(end + 16, true);
  for (let index = 0; index < view.getUint16(end + 10, true); index++) {
    const local = view.getUint32(central + 42, true), nameSize = view.getUint16(central + 28, true);
    entries.push({ central, local, data: local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true), name: new TextDecoder().decode(bytes.subarray(central + 46, central + 46 + nameSize)) });
    central += 46 + nameSize + view.getUint16(central + 30, true) + view.getUint16(central + 32, true);
  }
  return { view, end, entries };
}
function changed(bytes: Uint8Array, edit: (copy: Uint8Array, structure: ReturnType<typeof locations>) => void): Uint8Array {
  const copy = bytes.slice(); edit(copy, locations(copy)); return copy;
}
function streamingWorkbook(): Uint8Array {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, chunk) => { if (error) throw error; chunks.push(chunk); });
  for (const [name, content] of Object.entries(core)) { const entry = new ZipDeflate(name); zip.add(entry); entry.push(content, true); }
  zip.end();
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
const excelError = (pattern: RegExp) => (error: unknown) => { assert.ok(error instanceof Error); assert.match(error.message, /Excel/); assert.match(error.message, pattern); return true; };

test('ordinary stored and deflated XLSX archives return every entry for attachment and macro inspection', async () => {
  const extra = { 'xl/media/image1.png': new Uint8Array([1, 2, 3]), 'xl/embeddings/object.bin': new Uint8Array([9]), 'xl/vbaProject.bin': new Uint8Array([7]), 'xl/worksheets/工作表.xml': strToU8('<worksheet/>') };
  for (const level of [0, 6] as const) {
    const bytes = workbook(extra, level), original = bytes.slice();
    assert.deepEqual((await validateExcelArchive(bytes)).entries, Object.keys({ ...core, ...extra }));
    assert.deepEqual(bytes, original);
  }
});

test('subarray buffers, archive comments and streamed data descriptors remain supported', async () => {
  const bytes = zipSync(core, { comment: '客户表格 PK\u0005\u0006 注释' });
  const wrapped = new Uint8Array(bytes.length + 14); wrapped.set(bytes, 7);
  assert.deepEqual((await validateExcelArchive(wrapped.subarray(7, 7 + bytes.length))).entries, Object.keys(core));
  assert.deepEqual((await validateExcelArchive(streamingWorkbook())).entries, Object.keys(core));
});

test('a valid 16 MB entry is allowed without retaining its expanded body', async () => {
  assert.ok((await validateExcelArchive(workbook({ 'xl/sharedStrings.xml': new Uint8Array(16 * MB) }))).entries.includes('xl/sharedStrings.xml'));
});

test('non-ZIP, truncated, trailing and missing workbook or worksheet inputs are rejected with Excel errors', async () => {
  const bytes = workbook();
  for (const bad of [new Uint8Array(), strToU8('not XLSX'), bytes.subarray(0, bytes.length - 1), new Uint8Array([...bytes, 0]), zipSync({ 'word/document.xml': strToU8('<document/>') }), zipSync({ 'xl/workbook.xml': core['xl/workbook.xml'] }), zipSync({ 'XL/WORKBOOK.XML': core['xl/workbook.xml'], 'xl/worksheets/sheet1.xml': core['xl/worksheets/sheet1.xml'] })]) {
    await assert.rejects(validateExcelArchive(bad), excelError(/损坏|目录|工作簿|工作表|格式/));
  }
});

test('encrypted flags in either header are rejected before reading contents', async () => {
  for (const flag of [1, 0x40, 0x2000]) for (const header of ['central', 'local'] as const) {
    const bad = changed(workbook(), (_, { view, entries }) => { const at = entries[0][header] + (header === 'central' ? 8 : 6); view.setUint16(at, view.getUint16(at, true) | flag, true); });
    await assert.rejects(validateExcelArchive(bad), excelError(/加密|密码/));
  }
});

test('duplicate and unsafe part names cannot hide alternate workbook content', async () => {
  const duplicate = changed(workbook({ 'xl/media/aa': new Uint8Array([1]), 'xl/media/bb': new Uint8Array([2]) }), (copy, { entries }) => {
    const target = entries.find(entry => entry.name === 'xl/media/bb')!;
    copy.set(strToU8('xl/media/aa'), target.central + 46); copy.set(strToU8('xl/media/aa'), target.local + 30);
  });
  await assert.rejects(validateExcelArchive(duplicate), excelError(/重复/));
  for (const name of ['../outside.xml', '/absolute.xml', 'xl/../escape.xml', 'xl\\worksheets\\sheet2.xml', 'xl//sheet2.xml', 'C:/sheet2.xml', 'xl/bad\0name.xml', 'XL/WORKBOOK.XML']) {
    await assert.rejects(validateExcelArchive(workbook({ [name]: strToU8('unsafe') })), excelError(/路径|文件名|重复/));
  }
});

test('ZIP64, split archives and unsupported compression are refused', async () => {
  const edits: ((data: ReturnType<typeof locations>) => void)[] = [
    ({ view, end }) => view.setUint16(end + 4, 1, true),
    ({ view, end }) => view.setUint16(end + 10, 0xffff, true),
    ({ view, end }) => view.setUint32(end + 16, 0xffffffff, true),
    ({ view, entries }) => view.setUint32(entries[0].central + 24, 0xffffffff, true),
    ({ view, entries }) => view.setUint32(entries[0].central + 42, 0xffffffff, true),
    ({ view, entries }) => view.setUint16(entries[0].central + 34, 1, true),
    ({ view, entries }) => { view.setUint16(entries[0].central + 10, 99, true); view.setUint16(entries[0].local + 8, 99, true); },
  ];
  for (const edit of edits) await assert.rejects(validateExcelArchive(changed(workbook(), (_, data) => edit(data))), excelError(/ZIP64|分卷|压缩/));
  const zip64Extra = zipSync({ 'xl/workbook.xml': [core['xl/workbook.xml'], { extra: { 1: new Uint8Array(16) } }], 'xl/worksheets/sheet1.xml': core['xl/worksheets/sheet1.xml'] });
  await assert.rejects(validateExcelArchive(zip64Extra), excelError(/ZIP64/));
});

test('directory and local-header boundaries, names and metadata must agree', async () => {
  const edits: ((copy: Uint8Array, data: ReturnType<typeof locations>) => void)[] = [
    (_, { view, end }) => view.setUint32(end + 12, view.getUint32(end + 12, true) - 1, true),
    (_, { view, end }) => view.setUint32(end + 16, end, true),
    (_, { view, entries }) => view.setUint16(entries[0].central + 28, 0xffff, true),
    (_, { view, entries }) => view.setUint16(entries[0].local + 28, 0xffff, true),
    (_, { view, entries }) => view.setUint32(entries[0].central + 42, entries[0].central, true),
    (_, { view, entries }) => view.setUint32(entries[1].central + 42, entries[0].local, true),
    (copy, { entries }) => { copy[entries[0].local + 30] ^= 1; },
    (_, { view, entries }) => view.setUint16(entries[0].local + 8, 0, true),
    (_, { view, entries }) => view.setUint32(entries[0].local + 22, 0, true),
    (_, { view, entries }) => view.setUint32(entries[0].central + 20, entries[0].central, true),
  ];
  for (const edit of edits) await assert.rejects(validateExcelArchive(changed(workbook(), edit)), excelError(/损坏|目录|条目|一致|边界/));
});

test('CRC corruption is detected in XML and non-text attachments', async () => {
  for (const name of ['xl/workbook.xml', 'xl/media/image.png']) {
    const bad = changed(workbook({ 'xl/media/image.png': new Uint8Array([1, 2, 3, 4]) }, 0), (copy, { entries }) => { const entry = entries.find(item => item.name === name)!; copy[entry.data] ^= 1; });
    await assert.rejects(validateExcelArchive(bad), excelError(/校验|损坏/));
  }
});

test('forged size fields cannot bypass actual streaming output and CRC checks', async () => {
  const bytes = workbook({ 'xl/sharedStrings.xml': new Uint8Array(4 * MB) });
  for (const size of [0, 1, 4 * MB - 1, 4 * MB + 1]) {
    const bad = changed(bytes, (_, { view, entries }) => { const target = entries.find(entry => entry.name === 'xl/sharedStrings.xml')!; view.setUint32(target.central + 24, size, true); view.setUint32(target.local + 22, size, true); });
    await assert.rejects(validateExcelArchive(bad), excelError(/解压|校验|大小|损坏/));
  }
});

test('corrupted streamed descriptors and CRC declarations are rejected', async () => {
  const bad = changed(streamingWorkbook(), (_, { view, entries }) => { const entry = entries[0]; const descriptor = entry.data + view.getUint32(entry.central + 20, true); view.setUint32(descriptor + 4, 1, true); });
  await assert.rejects(validateExcelArchive(bad), excelError(/校验|描述|损坏|一致/));
  const wrongCrc = changed(workbook(), (_, { view, entries }) => { view.setUint32(entries[0].central + 16, 1, true); view.setUint32(entries[0].local + 14, 1, true); });
  await assert.rejects(validateExcelArchive(wrongCrc), excelError(/校验|损坏/));
});

test('expanded entry, archive total, file count and input limits stop oversized archives', async () => {
  const tooMany = Object.fromEntries(Array.from({ length: 2047 }, (_, index) => [`meta/${index}`, new Uint8Array()]));
  const total = new Uint8Array(11 * MB);
  for (const bad of [workbook({ 'large.bin': new Uint8Array(16 * MB + 1) }), workbook({ 'a.bin': total, 'b.bin': total, 'c.bin': total }), workbook(tooMany), new Uint8Array(10 * MB + 1)]) {
    await assert.rejects(validateExcelArchive(bad), excelError(/过大|上限|数量|2048|10\s?MB|16\s?MB|32\s?MB/));
  }
});
