import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPropertyAnswer, type PropertyQuery } from '../app/lib/property-query.ts';
import { parsePropertySources } from '../app/lib/property-records.ts';

const query: PropertyQuery = { status: 'vacant', groups: [], page: 1, pageSize: 10 };
const coverage = { complete: true, issues: [], sourceCount: 1 };
function records(noteLength = 360) {
  return parsePropertySources([{
    documentId: 'vacant', title: '空置房源', fileName: '空置房源.xlsx', libraryId: 'zs', libraryName: '招商',
    text: '## 工作表：空置商铺\n第1行：A1=铺号；B1=面积（㎡）；C1=位置；D1=业态；E1=备注\n' +
      Array.from({ length: 4 }, (_, i) => `第${i + 2}行：A${i + 2}=A10${i + 1}；B${i + 2}=120；C${i + 2}=南湖；D${i + 2}=轻餐饮；E${i + 2}=${'原始房源说明'.repeat(Math.ceil(noteLength / 6))}`).join('\n'),
  }]);
}

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
