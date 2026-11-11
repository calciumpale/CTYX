import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPropertyAnswer, type PropertyQuery } from '../app/lib/property-query.ts';
import { formatCustomerPropertyReply } from '../app/lib/property-customer-reply.ts';
import { parsePropertySources } from '../app/lib/property-records.ts';

const query: PropertyQuery = { status: 'vacant', groups: [], page: 1, pageSize: 10 };
const coverage = { complete: true, issues: [], sourceCount: 1 };
function records(noteLength = 360, count = 4) {
  return parsePropertySources([{
    documentId: 'vacant', title: '空置房源', fileName: '空置房源.xlsx', libraryId: 'zs', libraryName: '招商',
    text: '## 工作表：空置商铺\n第1行：A1=铺号；B1=面积（㎡）；C1=位置；D1=建议业态；E1=备注\n' +
      Array.from({ length: count }, (_, i) => `第${i + 2}行：A${i + 2}=A10${i + 1}；B${i + 2}=120；C${i + 2}=南湖路${i + 1}号；D${i + 2}=轻餐饮；E${i + 2}=${'原始房源说明'.repeat(Math.ceil(noteLength / 6))}`).join('\n'),
  }]);
}

test('customer inventory lists every complete row in a single paragraph within 500 characters', () => {
  const rows = records(360, 10);
  const result = formatCustomerPropertyReply(rows, query, true, 500);
  assert.equal(rows.length, 10);
  assert.deepEqual(result.rows.map(row => row.id), rows.map(row => row.id));
  assert.equal((result.answer.match(/南湖路\d+号，面积120㎡，建议业态轻餐饮/g) ?? []).length, 10);
  assert.match(result.answer, /匹配10条/);
  assert.match(result.answer, /现况待核实/);
  assert.doesNotMatch(result.answer, /[\r\n\u2028\u2029]|原始房源说明|下一页/);
  assert.ok(result.answer.length <= 500);
});

test('customer inventory pages budget for separators and preserve all cited row identities', () => {
  const rows = records();
  const first = formatCustomerPropertyReply(rows, query, false, 80);
  const second = formatCustomerPropertyReply(rows, { ...query, page: 2 }, false, 80);
  assert.equal(first.rows.length, 2);
  assert.deepEqual([...first.rows, ...second.rows].map(row => row.id), rows.map(row => row.id));
  assert.match(first.answer, /已查到4条/);
  assert.match(first.answer, /下一页/);
  assert.doesNotMatch(second.answer, /下一页/);
  for (const result of [first, second]) {
    assert.doesNotMatch(result.answer, /[\r\n\u2028\u2029]/);
    assert.ok(result.answer.length <= 80);
  }
});

test('budget-sized pages enumerate every matching row once without skipping the truncated fixed-page tail', () => {
  const rows = records();
  const seen: string[] = [];
  let page = 1;
  while (true) {
    const result = formatPropertyAnswer(rows, { ...query, page }, coverage, 950);
    assert.ok(result.answer.length <= 950);
    assert.ok(result.rows.length > 0, `page ${page} must advance through the records`);
    seen.push(...result.rows.map(row => row.id));
    if (!result.answer.includes('下一页')) break;
    assert.ok(page++ < 4, 'pagination must finish');
  }
  assert.deepEqual(seen, rows.map(row => row.id));
  assert.ok(page > 1, 'the small answer budget should require multiple pages');
});

test('a single oversized row has an explicit source placeholder and advances past it', () => {
  const rows = records(5000);
  const pageQuery = { ...query, pageSize: 1 };
  const first = formatPropertyAnswer(rows, pageQuery, coverage, 400);
  assert.ok(first.answer.length <= 400);
  assert.equal(first.rows[0]?.id, rows[0].id);
  assert.match(first.answer, /过长|较长/);
  assert.match(first.answer, /来源|原表/);
  assert.match(first.answer, /下一页/);
  const last = formatPropertyAnswer(rows, { ...pageQuery, page: 4 }, coverage, 400);
  assert.ok(last.answer.length <= 400);
  assert.equal(last.rows[0]?.id, rows[3].id);
  assert.doesNotMatch(last.answer, /下一页/);
});

test('coverage issues and clarification respect the real answer budget without cutting rows mid-field', () => {
  const rows = records();
  for (const limit of [0, 1, 8, 20, 80, 160, 350, 900]) {
    const incomplete = formatPropertyAnswer(rows, query, { complete: false, sourceCount: 1, issues: ['文件读取失败'.repeat(100)] }, limit);
    assert.ok(incomplete.answer.length <= limit, `incomplete answer exceeds ${limit}`);
    const clarification = formatPropertyAnswer([], { ...query, clarification: '请确认面积范围。'.repeat(100) }, coverage, limit);
    assert.ok(clarification.answer.length <= limit, `clarification exceeds ${limit}`);
  }
});
