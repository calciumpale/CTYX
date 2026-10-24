import test from 'node:test';
import assert from 'node:assert/strict';
import { extractProjectIntake, validateIntakeExtraction } from '../app/lib/project-intake.ts';

const raw = '今天拜访华星科技有限公司，联系人王敏，采购经理，需要客户管理系统，预算20万元，下周安排演示。';
const grounded = () => ({
  status: 'ready', companyCandidates: ['华星科技有限公司'],
  fields: { name: '华星科技有限公司', contact: '王敏', position: '采购经理', needs: ['客户管理系统'], amount: 200000, customerProfile: { budget: '预算20万元' }, nextAction: '下周安排演示' },
  evidence: [
    { field: 'name', quote: '华星科技有限公司' }, { field: 'contact', quote: '联系人王敏' },
    { field: 'position', quote: '采购经理' }, { field: 'needs', quote: '客户管理系统' },
    { field: 'amount', quote: '预算20万元' }, { field: 'customerProfile.budget', quote: '预算20万元' },
    { field: 'nextAction', quote: '下周安排演示' },
  ],
});

test('extracts only supported grounded fields and generates a project label', async () => {
  const result = await extractProjectIntake(raw, async messages => {
    assert.equal(messages.at(-1)?.role, 'user');
    assert.ok(messages.at(-1)?.content.includes(raw));
    return JSON.stringify(grounded());
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.fields.name, '华星科技有限公司');
  assert.equal(result.fields.projectName, '华星科技有限公司 · 新商机');
  assert.equal(result.fields.amount, 200000);
  assert.equal(result.fields.contact, '王敏');
  assert.equal(result.fields.website, undefined);
});

test('absent contact and budget remain empty rather than receiving model defaults', async () => {
  const text = '华星科技有限公司想了解客户管理系统。';
  const result = await extractProjectIntake(text, async () => JSON.stringify({ status: 'ready', companyCandidates: ['华星科技有限公司'], fields: { name: '华星科技有限公司', contact: '', amount: null, customerProfile: { budget: '' } }, evidence: [{ field: 'name', quote: '华星科技有限公司' }] }));
  assert.equal(result.fields.contact, undefined);
  assert.equal(result.fields.amount, undefined);
  assert.equal(result.fields.customerProfile, undefined);
});

test('missing enterprise asks one concrete question without inventing a company', () => {
  const result = validateIntakeExtraction({ status: 'ready', companyCandidates: [], fields: { needs: ['客户管理系统'] }, evidence: [{ field: 'needs', quote: '客户管理系统' }] }, '张总需要客户管理系统');
  assert.equal(result.status, 'needs_info');
  assert.equal(result.fields.name, undefined);
  assert.match(result.question || '', /企业|公司/);
});

test('multiple companies require the user to choose one enterprise', () => {
  const text = '华星科技有限公司和海川实业有限公司都想采购。';
  const result = validateIntakeExtraction({ status: 'ready', companyCandidates: ['华星科技有限公司', '海川实业有限公司'], fields: { name: '华星科技有限公司' }, evidence: [{ field: 'name', quote: '华星科技有限公司' }] }, text);
  assert.equal(result.status, 'needs_info');
  assert.match(result.question || '', /哪一家|一个|一家/);
});

test('rejects fabricated contact even when its evidence is a real quote', () => {
  const value = grounded(); value.fields.contact = '李总';
  assert.throws(() => validateIntakeExtraction(value, raw), /原话|证据|来源/);
});

test('rejects model-provided company names that never occur in the input', () => {
  const value = grounded(); value.fields.name = '幻想科技有限公司'; value.companyCandidates = ['幻想科技有限公司'];
  assert.throws(() => validateIntakeExtraction(value, raw), /原话|证据|来源/);
});

test('rejects paraphrased evidence and ungrounded budgets', () => {
  const value = grounded(); value.evidence[0].quote = '拜访了华星科技有限公司';
  assert.throws(() => validateIntakeExtraction(value, raw), /原话|证据|来源/);
  const budget = grounded(); budget.fields.amount = 999999;
  assert.throws(() => validateIntakeExtraction(budget, raw), /金额|预算|证据/);
});

test('rejects treating headcount as deal amount and percentage as budget', () => {
  for (const quote of ['有200名员工', '采购可能性80%']) {
    const amount = quote.includes('200') ? 200 : 80;
    assert.throws(() => validateIntakeExtraction({ status: 'ready', companyCandidates: ['华星科技有限公司'], fields: { name: '华星科技有限公司', amount }, evidence: [{ field: 'name', quote: '华星科技有限公司' }, { field: 'amount', quote }] }, `华星科技有限公司，${quote}`), /金额|预算|证据/);
  }
});

test('rejects unsupported properties instead of admitting owner or priority changes', () => {
  assert.throws(() => validateIntakeExtraction({ ...grounded(), fields: { ...grounded().fields, ownerId: 'other-sales' } }, raw), /字段|格式/);
});

test('respects an explicit project name with source evidence', () => {
  const text = '华星科技有限公司的新项目叫CRM采购。';
  const result = validateIntakeExtraction({ status: 'ready', companyCandidates: ['华星科技有限公司'], fields: { name: '华星科技有限公司', projectName: 'CRM采购' }, evidence: [{ field: 'name', quote: '华星科技有限公司' }, { field: 'projectName', quote: 'CRM采购' }] }, text);
  assert.equal(result.fields.projectName, 'CRM采购');
});

test('accepts a JSON code fence but rejects prose and malformed model output', async () => {
  assert.equal((await extractProjectIntake(raw, async () => `\x60\x60\x60json\n${JSON.stringify(grounded())}\n\x60\x60\x60`)).status, 'ready');
  for (const response of ['我建议直接新建项目', '{invalid}', 'null', JSON.stringify({ fields: {} })]) {
    await assert.rejects(extractProjectIntake(raw, async () => response), /格式|结构|JSON/);
  }
});

test('empty or oversized input is rejected before paying for a model call', async () => {
  let called = false;
  for (const text of ['', '   ', '客'.repeat(6001)]) await assert.rejects(extractProjectIntake(text, async () => { called = true; return JSON.stringify(grounded()); }), /输入|6000/);
  assert.equal(called, false);
});

test('provider failure propagates and never creates a fallback customer', async () => {
  await assert.rejects(extractProjectIntake(raw, async () => { throw new Error('模型连接超时'); }), /超时/);
});

// The boundary double replaces network persistence; it exposes action/payload so retries can be checked.
test('submission ignores simultaneous delivery and retains the same request id after a failure', async () => {
  const { createIntakeSubmissionController } = await import('../app/lib/project-intake.ts');
  const calls: { action: string; payload?: Record<string, unknown> }[] = [];
  let rejectDelivery: (error: Error) => void = () => {};
  let sequence = 0;
  const controller = createIntakeSubmissionController({ requestId: () => `request-${++sequence}`, mutate: async (action, payload) => {
    calls.push({ action, payload });
    return new Promise((_resolve, reject) => { rejectDelivery = reject; });
  } });
  const first = controller.submit({ text: raw, inputMode: 'speech' });
  assert.equal(await controller.submit({ text: raw, inputMode: 'speech' }), null);
  assert.equal(calls.length, 1);
  rejectDelivery(new Error('响应丢失'));
  await assert.rejects(first, /响应丢失/);
  const retry = controller.submit({ text: raw, inputMode: 'speech' });
  assert.equal(calls[1].payload?.requestId, 'request-1');
  assert.equal(calls[1].payload?.text, raw);
  rejectDelivery(new Error('仍不可用'));
  await assert.rejects(retry, /仍不可用/);
});

test('duplicate choice saves original speech as a followup and force new reuses the request', async () => {
  const { createIntakeSubmissionController } = await import('../app/lib/project-intake.ts');
  const calls: { action: string; payload?: Record<string, unknown> }[] = [];
  const controller = createIntakeSubmissionController({ requestId: () => 'request-original', mutate: async (action, payload) => {
    calls.push({ action, payload });
    return { state: {} as import('../app/lib/types.ts').WorkbenchState, intake: { status: 'duplicate', existing: [{ id: 'existing', name: '华星科技有限公司', projectName: 'CRM采购' }] } };
  } });
  await controller.submit({ text: raw, inputMode: 'speech' });
  await controller.followup('existing');
  await controller.submit({ text: raw, inputMode: 'speech', forceNew: true });
  assert.deepEqual(calls[1], { action: 'deal_intake_followup', payload: { dealId: 'existing', requestId: 'request-original', text: raw, inputMode: 'speech' } });
  assert.equal(calls[2].payload?.requestId, 'request-original');
  assert.equal(calls[2].payload?.forceNew, true);
});

test('new clarification gets a new request id and cannot overwrite the previous raw receipt', async () => {
  const { createIntakeSubmissionController } = await import('../app/lib/project-intake.ts');
  const sent: Record<string, unknown>[] = [];
  let sequence = 0;
  const controller = createIntakeSubmissionController({ requestId: () => `request-${++sequence}`, mutate: async (_action, payload) => { sent.push(payload || {}); return { state: {} as import('../app/lib/types.ts').WorkbenchState, intake: { status: 'needs_info', question: '哪家企业？' } }; } });
  await controller.submit({ text: '张总想采购', inputMode: 'text' });
  await controller.submit({ text: '张总想采购\n补充：企业名称为华星科技有限公司', inputMode: 'text' });
  assert.equal(sent[0].requestId, 'request-1');
  assert.equal(sent[1].requestId, 'request-2');
  assert.equal(sent[1].text, '张总想采购\n补充：企业名称为华星科技有限公司');
});

test('unknown field markers remain unknown and a contact title cannot become an enterprise', () => {
  const result = validateIntakeExtraction({ status: 'ready', companyCandidates: ['华星科技有限公司'], fields: { name: '华星科技有限公司', contact: '未知', customerProfile: { budget: '尚未确认' } }, evidence: [{ field: 'name', quote: '华星科技有限公司' }, { field: 'contact', quote: '联系人未知' }, { field: 'customerProfile.budget', quote: '预算尚未确认' }] }, '华星科技有限公司，联系人未知，预算尚未确认');
  assert.equal(result.fields.contact, undefined);
  assert.equal(result.fields.customerProfile, undefined);
  const person = validateIntakeExtraction({ status: 'ready', companyCandidates: ['刘经理'], fields: { name: '刘经理' }, evidence: [{ field: 'name', quote: '刘经理' }] }, '刘经理想采购客户管理系统');
  assert.equal(person.status, 'needs_info');
  assert.equal(person.fields.name, undefined);
});

test('budget ranges stay in the customer profile instead of becoming a made-up exact amount', () => {
  assert.throws(() => validateIntakeExtraction({ status: 'ready', companyCandidates: ['华星科技有限公司'], fields: { name: '华星科技有限公司', amount: 200000 }, evidence: [{ field: 'name', quote: '华星科技有限公司' }, { field: 'amount', quote: '预算10到20万元' }] }, '华星科技有限公司预算10到20万元'), /预算|金额/);
});

test('an unrelated number cannot become a budget just because the quote mentions budget', () => {
  for (const quote of ['预算未知，有200名员工', '预算未知有200名员工', '预算200美元', '预算200%']) {
    assert.throws(() => validateIntakeExtraction({ status: 'ready', companyCandidates: ['华星科技有限公司'], fields: { name: '华星科技有限公司', amount: 200 }, evidence: [{ field: 'name', quote: '华星科技有限公司' }, { field: 'amount', quote }] }, `华星科技有限公司，${quote}`), /预算|金额/);
  }
});

for (const [quote, amount] of [
  ['预计投入2周', 2], ['预计投入2个月', 2], ['预计投入2年', 2], ['预计投入2天', 2],
  ['预计投入2小时', 2], ['预计投入2人天', 2], ['预算2026年再讨论', 2026],
  ['预算2026/10/24确认', 2026], ['预算2026.10.24确认', 2026.1],
  ['预算20台设备', 20], ['预计投入20万用户', 200000], ['费用10次培训', 10],
] as const) test(`rejects nonmonetary evidence as an amount: ${quote}`, () => {
  assert.throws(() => validateIntakeExtraction({ status: 'ready', companyCandidates: ['华星科技有限公司'], fields: { name: '华星科技有限公司', amount }, evidence: [{ field: 'name', quote: '华星科技有限公司' }, { field: 'amount', quote }] }, `华星科技有限公司，${quote}`), /预算|金额/);
});

for (const [quote, amount] of [
  ['预算20万', 200000], ['预算20', 20], ['预计投入20万元用于系统升级', 200000],
  ['费用为1200.50元', 1200.5], ['￥20万', 200000], ['预算2026元', 2026],
] as const) test(`retains a grounded monetary value: ${quote}`, () => {
  const result = validateIntakeExtraction({ status: 'ready', companyCandidates: ['华星科技有限公司'], fields: { name: '华星科技有限公司', amount }, evidence: [{ field: 'name', quote: '华星科技有限公司' }, { field: 'amount', quote }] }, `华星科技有限公司，${quote}`);
  assert.equal(result.fields.amount, amount);
});

for (const [text, quote, amount] of [
  ['华星科技有限公司预计投入2周', '预计投入2', 2],
  ['华星科技有限公司预算2026年再讨论', '预算2026', 2026],
  ['华星科技有限公司预算20万用户', '预算20万', 200000],
  ['华星科技有限公司预算120万元', '20万元', 200000],
] as const) test(`cropped evidence cannot hide a nonmonetary unit or a larger amount: ${quote}`, () => {
  assert.throws(() => validateIntakeExtraction({ status: 'ready', companyCandidates: ['华星科技有限公司'], fields: { name: '华星科技有限公司', amount }, evidence: [{ field: 'name', quote: '华星科技有限公司' }, { field: 'amount', quote }] }, text), /预算|金额/);
});

test('a cropped upper budget bound cannot hide the original range', () => {
  for (const text of ['华星科技有限公司预算10到20万元', '华星科技有限公司预算10万至20万元']) {
    assert.throws(() => validateIntakeExtraction({ status: 'ready', companyCandidates: ['华星科技有限公司'], fields: { name: '华星科技有限公司', amount: 200000 }, evidence: [{ field: 'name', quote: '华星科技有限公司' }, { field: 'amount', quote: '20万元' }] }, text), /预算|金额/);
  }
});
