import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { importKnowledgeFile } from '../app/lib/knowledge-library-import.ts';
import { parsePropertySources, type PropertySource } from '../app/lib/property-records.ts';

function source(text: string, overrides: Partial<PropertySource> = {}): PropertySource {
  return { documentId: 'doc-1', title: '空置房源', fileName: '空置房源.xlsx', libraryId: 'lib-1', libraryName: '公司知识库', text, ...overrides };
}

test('canonical Excel rows preserve actual columns, sheet, source and original row locations', () => {
  const text = '## 工作表：空置商铺表\n第1行：A1=区块；B1=地址；C1=面积；D1=建议业态\n第2行：A2=东门好邻居168；B2=枣园东路32-107及二层部分商铺；C2=1,549.17；D2=运动健身\n第6行：A6=绮园商业街；B6=5-2号商铺；D6=轻餐饮';
  const rows = parsePropertySources([source(text)]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].section, '工作表：空置商铺表');
  assert.equal(rows[0].rowLabel, '第2行');
  assert.equal(rows[0].status, 'vacant');
  assert.deepEqual(rows[0].area, { min: 1549.17, max: 1549.17, label: '面积', raw: '1,549.17', approximate: false, unit: 'unspecified' });
  assert.match(rows[0].location ?? '', /东门好邻居168.*枣园东路/);
  assert.equal(rows[0].usage, '运动健身');
  assert.equal(rows[1].area, undefined);
  assert.deepEqual(rows[1].fields, [{ label: '区块', value: '绮园商业街' }, { label: '地址', value: '5-2号商铺' }, { label: '面积', value: '' }, { label: '建议业态', value: '轻餐饮' }]);
  assert.equal(rows[1].raw, text.split('\n')[3]);
  assert.equal(rows[0].source.documentId, 'doc-1');
  assert.ok(!('text' in rows[0].source));
});

test('new XLSX serialization cannot turn literal cell addresses into fabricated area values', async () => {
  const literal = '东街；B2=120；含"引号"及\\路径和字面\\uFF1B';
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['地址', '面积', '业态'], [literal, null, '餐饮']]), '空置商铺表');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['地址', '面积', '业态'], ['西街', 80, '零售']]), '第二张空置商铺表');
  const imported = await importKnowledgeFile(new File([XLSX.write(book, { bookType: 'xlsx', type: 'array' })], '空置房源.xlsx'));
  const rows = parsePropertySources([source(imported.text)]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].fields[0].value, literal);
  assert.equal(rows[0].fields[1].value, '');
  assert.equal(rows[0].area, undefined);
  assert.equal(rows[1].area?.min, 80);
  assert.match(rows[0].raw, /\\uFF1BB2=120/);
});

test('global and per-worksheet JSON-v1 markers decode values only in their declared scope', () => {
  const escaped = '东街\\uFF1BB2=120\\\\门口\\"招牌\\"';
  const body = `第1行：A1=地址；B1=面积\n第2行：A2=${escaped}`;
  const global = parsePropertySources([source(`单元格转义：JSON-v1\n## 工作表：空置甲表\n${body}\n## 工作表：空置乙表\n${body}`)]);
  assert.equal(global.length, 2);
  assert.ok(global.every(row => row.fields[0].value === '东街；B2=120\\门口"招牌"' && row.area === undefined));
  const scoped = parsePropertySources([source(`## 工作表：空置甲表\n单元格转义：JSON-v1\n${body}\n## 工作表：空置乙表\n第1行：A1=地址；B1=面积\n第2行：A2=旧格式\\uFF1B；B2=80`)]);
  assert.equal(scoped[0].fields[0].value, '东街；B2=120\\门口"招牌"');
  assert.equal(scoped[1].fields[0].value, '旧格式\\uFF1B');
  assert.equal(scoped[1].area?.min, 80);
  for (const marker of ['单元格转义：JSON-v1', '单元格转义：JSON-v2']) {
    const malformed = `## 工作表：空置商铺\n${marker}\n第1行：A1=地址；B1=面积\n第2行：A2=错误\\q转义；B2=120`;
    assert.deepEqual(parsePropertySources([source(malformed)]), []);
  }
  for (const marker of ['', '单元格转义：JSON-v1\n']) {
    assert.deepEqual(parsePropertySources([source(`## 工作表：空置商铺\n${marker}第1行：A1=地址；B1=面积\n第2行：A2=东街；B2=120；B2=140`)]), []);
  }
});

test('only saved area values are read, never digits inside an uncalculated formula', () => {
  const rows = parsePropertySources([source('## 工作表：空置房源\n第1行：A1=房号；B1=面积（㎡）；C1=业态\n第2行：A2=1；B2=125（公式：=A2*125；保存结果）；C2=零售\n第3行：A3=2；B3==A3*120（无缓存结果，未计算）；C3=餐饮\n第4行：A4=3；B4==SUM(80,120)；C4=餐饮')]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].area?.min, 125);
  assert.equal(rows[0].area?.unit, 'sqm');
  assert.equal(rows[1].area, undefined);
  assert.equal(rows[2].area, undefined);
});

test('mixed inventory uses explicit sheet or row status and contradictions are not guessed away', () => {
  const text = '## 工作表：空置商铺表\n第1行：A1=房号；B1=面积；C1=状态\n第2行：A2=A；B2=120；C2=空置\n第3行：A3=B；B3=120；C3=已出租\n第4行：A4=C；B4=120；C4=待定\n## 工作表：履约商铺表\n第1行：A1=房号；B1=面积\n第2行：A2=D；B2=140';
  const rows = parsePropertySources([source(text, { title: '空置及在租房源', fileName: '房源汇总.xlsx' })]);
  assert.deepEqual(rows.map(row => row.status), ['vacant', 'unknown', 'unknown', 'rented']);
  assert.deepEqual(rows.map(row => row.statusConflict), [false, true, false, false]);
  assert.ok(rows.every(row => row.sourceStatus === 'unknown'));
  assert.equal(rows[3].sectionStatus, 'rented');
  const conflict = parsePropertySources([source('## 工作表：在租房源\n第1行：A1=地址；B1=面积\n第2行：A2=中山路1号；B2=90')])[0];
  assert.equal(conflict.status, 'unknown');
  assert.equal(conflict.statusConflict, true);
});

test('negated and unconfirmed inventory metadata cannot classify unknown records as vacant or rented', () => {
  const text = '房号,面积,地址\nA1,120,东街';
  for (const title of ['非空置房源', '不是空置商铺', '不在租房源', '非在租房源', '待确认空置房源', '空置房源（待核实）', '疑似空置房源', '是否在租房源', '待确认房源']) {
    const row = parsePropertySources([source(text, { title, fileName: '空置房源.csv' })])[0];
    assert.equal(row.status, 'unknown', title);
    assert.equal(row.sourceStatus, 'unknown', title);
  }
  for (const section of ['工作表：非空置商铺', '工作表：空置商铺（待确认）', '工作表：疑似在租房源']) {
    const row = parsePropertySources([source(`## ${section}\n第1行：A1=房号；B1=面积\n第2行：A2=A1；B2=120`)])[0];
    assert.equal(row.status, 'unknown', section);
    assert.equal(row.sectionStatus, 'unknown', section);
  }
  const unlet = parsePropertySources([source(text, { title: '未出租房源', fileName: '未出租房源.csv' })])[0];
  assert.equal(unlet.status, 'vacant');
});

test('prefaces and repeated headers do not become inventory rows or leak across sheets', () => {
  const rows = parsePropertySources([source('## 工作表：空置商铺表\n合并单元格：A1:D1（内容保留在原单元格，不填充空格）\n第1行：A1=2026年空置房源汇总\n第2行：A2=房号；B2=面积；C2=地址\n第3行：A3=A01；B3=80；C3=中山路\n第4行：A4=合计；B4=80\n第5行：A5=地址；B5=房号；C5=面积\n第6行：A6=建设路；B6=B01；C6=120\n## 工作表：备注\n第1行：A1=不能继承上一张表头；B1=300')]);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].area?.min, 120);
  assert.equal(rows[1].fields[0].label, '地址');
});

test('Markdown table parsing preserves escaped pipes and ignores separator rows', () => {
  const rows = parsePropertySources([source('# 空置商铺\n\n| 房号 | 面积（平方米） | 地址 | 适用业态 |\n| --- | ---: | --- | --- |\n| A-01 | 80～120 | 万达\\|东街 | 零售、咖啡 |\n| A-02 | 约１２０．５㎡ | 西街 | 商务办公 |', { fileName: '房源.md' })]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].format, 'markdown');
  assert.equal(rows[0].fields[2].value, '万达|东街');
  assert.equal(rows[0].rowLabel, '第5行');
  assert.equal(rows[0].area?.min, 80);
  assert.equal(rows[0].area?.max, 120);
  assert.equal(rows[1].area?.min, 120.5);
  assert.equal(rows[1].area?.approximate, true);
});

test('CSV and TSV retain quoted commas, escaped quotes, embedded newlines and empty columns', () => {
  const csv = '\uFEFF房号,面积(㎡),地址,业态\r\nA1,"1,250.00","东街1号\r\n二层","零售、\"\"轻餐饮\"\""\r\nA2,,西街,办公';
  const csvRows = parsePropertySources([source(csv, { fileName: '空置房源.csv' })]);
  assert.equal(csvRows.length, 2);
  assert.equal(csvRows[0].format, 'csv');
  assert.equal(csvRows[0].area?.min, 1250);
  assert.equal(csvRows[0].fields[2].value, '东街1号\r\n二层');
  assert.equal(csvRows[0].usage, '零售、"轻餐饮"');
  assert.equal(csvRows[0].rowLabel, '第2–3行');
  assert.equal(csvRows[1].rowLabel, '第4行');
  assert.equal(csvRows[1].area, undefined);
  assert.match(csvRows[0].raw, /"1,250\.00"/);
  const tsvRows = parsePropertySources([source('房号\t面积\t地址\t业态\nT1\t\t北街\t轻餐饮', { fileName: '空置房源.tsv' })]);
  assert.equal(tsvRows[0].format, 'tsv');
  assert.equal(tsvRows[0].fields[2].value, '北街');
  assert.equal(tsvRows[0].area, undefined);
});

test('ambiguous areas, unsupported units, incomplete rows and unrelated tables do not invent facts', () => {
  const ambiguous = parsePropertySources([source('| 房号 | 建筑面积(㎡) | 使用面积(㎡) |\n| --- | --- | --- |\n| A | 120 | 80 |')]);
  assert.equal(ambiguous[0].area, undefined);
  const units = parsePropertySources([source('房号,面积,地址\nA,2亩,东街\nB,1.2万平方米,西街\nC,约100平,南街')]);
  assert.equal(units[0].area, undefined);
  assert.equal(units[1].area?.min, 12000);
  assert.equal(units[2].area?.min, 100);
  assert.equal(units[2].area?.unit, 'sqm');
  assert.deepEqual(parsePropertySources([source('年份,空置率\n2026,12%', { title: '空置率统计', fileName: '空置率.csv' })]), []);
  assert.deepEqual(parsePropertySources([source('房号,面积,地址\nA,"120,东街')]), []);
  assert.deepEqual(parsePropertySources([source('## 工作表：空置房源\n第1行：A1=房号；B1=面积\n第2行：A2=A；B3=120')]), []);
});
