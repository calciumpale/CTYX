import assert from 'node:assert/strict';
import test from 'node:test';
import {
  customerDemandEvidence, customerInsightEvidence, formatCustomerDemand, formatCustomerInsightResult, formatCustomerRecordResult,
  isCustomerDemandFollowup, isCustomerDemandQuestion, isCustomerProfileRequest,
} from '../app/lib/customer-insight.ts';
import { createSeed } from '../app/lib/seed.ts';
import type { Deal } from '../app/lib/types.ts';

const now = '2026-11-12T09:00:00.000Z';
const company = '北京华天饮食控股集团有限公司';
const leaseQuestion = '调研下客户是否有租房需求';

function dealFixture(dataOrigin: Deal['dataOrigin'] = 'research'): Deal {
  return {
    ...createSeed(now).deals[0],
    name: company,
    dataOrigin,
    needs: [],
    notes: [],
    summary: '',
    nextAction: '核实适用场景与负责部门',
    customerProfile: undefined,
    companyProfile: {
      companyName: company, summary: '协会名录背景', status: 'ready', provider: 'web',
      warnings: [], modelUsed: false, updatedAt: now,
      facts: [{ label: '名录类别', value: '餐饮品牌方', sourceIds: ['listing', 'missing'] }],
      sources: [{ id: 'listing', title: '餐饮企业名录', url: 'https://example.com/list', provider: 'web', retrievedAt: now,
        snippet: `${company}是餐饮品牌方。` }],
    },
  };
}

const model = (status: string, factIds: string[], questions = ['近期是否有新增经营场地的安排？'], nextSteps = ['联系拓展负责人，核实选址和时间要求。']) =>
  JSON.stringify({ status, factIds, questions, nextSteps });

test('recognizes project lease, purchase, site selection, expansion and budget questions', () => {
  for (const query of [
    leaseQuestion, '客户有没有租赁意向', '看这家客户是否想租商铺', '该客户的租金预算是多少？',
    '客户有没有采购意向', '调研这家客户近期是否打算购买经营场所', '他们想买商铺吗？',
    '这家公司有没有扩店计划', '对方近期有没有选址需求', '调研近期是否有租赁计划',
    '这家公司的场地需求是什么', '租房需求呢？', '那他们有没有预算？',
    '北京华天饮食控股集团近期会租门面吗？', '客户近期是否需要办公室', '客户会不会租？',
  ]) assert.equal(isCustomerDemandQuestion(query, company), true, query);
  assert.equal(isCustomerDemandFollowup('那怎么核实？'), true);
  assert.equal(isCustomerDemandFollowup('再具体一点'), true);
  assert.equal(isCustomerDemandFollowup('改成三行，语气更自然'), false);
});

test('leaves inventory requests, offered terms, policy and official records on their own routes', () => {
  for (const query of [
    '给客户找能租的商铺', '看这家客户附近有没有空置商铺出租', '帮我查200平方米以上的空置商铺',
    '这个项目的商铺月租多少', '客户问我们商铺租金多少', '看下商铺能租吗',
    '客户想了解租赁合同违约责任', '租赁预算审批制度是什么', '这家客户有行政处罚记录吗',
    '调研下客户的基本情况', '给客户写一份租房意向话术', '把客户租房需求写成三条',
    '按客户租房预算查商铺', '给客户找办公场地，预算五万', '这家客户的商铺租金是多少',
    '请根据客户需求给推进建议', '请根据客户预算给推进建议', '他们预算多少',
    '分析北京华天饮食控股集团的需求',
  ]) assert.equal(isCustomerDemandQuestion(query, company), false, query);
});

test('detects explicit company profile requests alongside demand questions', () => {
  for (const query of [
    '这家公司的画像完善一下，搜一下对方有没有扩张的需求',
    '先整理一下企业画像，再调研客户有没有租房需求', '公司背景和当前租赁计划都看看',
    '主营业务是什么？另外核实下这家客户的选址需求', '调研一下客户的基本情况和租房需求',
    '查一下公司工商登记及近期的扩店计划', '做个企业画像，顺便问下场地需求',
    '根据公开企业资料梳理公司画像，再核实客户有没有扩店需求',
  ]) assert.equal(isCustomerProfileRequest(query), true, query);
  for (const query of [leaseQuestion, '根据已有企业画像判断客户是否有租房需求', '用已知的公司背景核实租赁意向', '不要展示企业画像，只核实租房需求']) {
    assert.equal(isCustomerProfileRequest(query), false, query);
  }
});

test('excludes synthetic and public-background information from project demand evidence', () => {
  const publicLead = dealFixture();
  assert.deepEqual(customerDemandEvidence(publicLead), []);
  const sample = dealFixture('sample');
  sample.needs = ['示例客户想租店铺'];
  assert.deepEqual(customerDemandEvidence(sample), []);
  const project = dealFixture('manual');
  project.needs = ['在北京租用经营场地'];
  project.notes = [{ id: 'note-1', author: '销售', date: now, text: '客户明确表示目前没有租房计划。' }];
  assert.deepEqual(customerDemandEvidence(project).map(entry => entry.value), ['在北京租用经营场地', '客户明确表示目前没有租房计划。']);
});

test('keeps public source IDs aligned with facts selected for the general project insight', () => {
  const evidence = customerInsightEvidence(dealFixture());
  assert.deepEqual(evidence.find(item => item.id === 'fact-1')?.sourceIds, ['listing']);
  const output = formatCustomerInsightResult(JSON.stringify({
    factIds: ['unknown', 'fact-1', 'fact-1'], insights: ['可核实实际经营主体。'],
    questions: ['联系哪一个团队？'], nextSteps: ['向负责人确认业务范围。'],
  }), evidence);
  assert.deepEqual(output?.factIds, ['fact-1']);
  assert.match(output?.answer ?? '', /餐饮品牌方/);
});

test('excludes an unsupported stored web fact and retains its source as an attributed excerpt', () => {
  const deal = dealFixture();
  deal.companyProfile!.facts[0].value = '已扩张至全国各地';
  const evidence = customerInsightEvidence(deal);
  assert.equal(evidence.find(item => item.id === 'fact-1'), undefined);
  assert.equal(evidence.find(item => item.id === 'source-1')?.value, `${company}是餐饮品牌方。`);
});

test('keeps matched public context ahead of identity-only profile facts', () => {
  const deal = dealFixture();
  deal.companyProfile!.facts = [{ label: '机构名称', value: company, sourceIds: ['listing'] }];
  const evidence = customerInsightEvidence(deal);
  assert.deepEqual(evidence.slice(0, 2).map(item => item.id), ['source-1', 'fact-1']);
  assert.match(evidence[0].value, /餐饮品牌方/);
});

test('keeps verified profile quotes and safe wording when the model includes unsupported clauses and markers', () => {
  const safe = '现有资料不能证明对方有扩店计划，建议先联系拓展团队核实。';
  const answer = `${safe}\n\n他们已经开了新店。\n\n[[fact-1]]\n\n> [[bad-id]]\n\n打开 [来源](https://bad.invalid)。`;
  const output = formatCustomerDemand(JSON.stringify({ answer, status: 'recorded' }), [], '客户是否有扩张需求？', customerInsightEvidence(dealFixture()), true);
  assert.ok(output);
  assert.ok(output.answer.startsWith(safe));
  assert.match(output.answer, /名录类别：餐饮品牌方/);
  assert.doesNotMatch(output.answer, /已经开|bad-id|bad\.invalid/);
  assert.deepEqual(output.factIds, []);
  assert.deepEqual(output.profileFactIds, ['fact-1']);
  assert.equal(output.groundingRejected, true);
});

test('does not let uncertainty about a detail validate an assertion about the company', () => {
  const good = '先联系拓展团队核实。';
  for (const claim of [
    '我们已经确认客户确实有扩张计划但具体地址尚不清楚。',
    '虽然还不能确认具体位置但他们已选址并准备开店。',
    '现有资料不能证明对方有扩店计划但他们已经开了新店。',
  ]) {
    const output = formatCustomerDemand(`${claim}\n\n${good}`, [], '客户是否有扩张需求？', undefined, true);
    assert.equal(output?.answer, good, claim);
    assert.equal(output.groundingRejected, true, claim);
  }
});

test('official record guidance keeps approved verification entrances and omits unsupported findings', () => {
  const safe = '可用企业全称查询并核对实际经营主体。';
  const output = formatCustomerRecordResult(JSON.stringify({ answer: `${safe}\n\n> [[registry]]\n\n> [[invented]]\n\n我在数据库里看到了该公司的行政处罚。` }), true);
  assert.ok(output);
  assert.ok(output.answer.startsWith(safe));
  assert.match(output.answer, /https:\/\/www\.gsxt\.gov\.cn/);
  assert.doesNotMatch(output.answer, /看到了|invented/);
  assert.deepEqual(output.factIds, ['registry']);
});

test('renders public-only demand assessment as unconfirmed, even if the model reports a record', () => {
  const evidence = customerDemandEvidence(dealFixture());
  const output = formatCustomerDemand(model('recorded', ['listing', 'invented']), evidence, leaseQuestion);
  assert.match(output?.answer ?? '', /现有资料无法确认/);
  assert.match(output?.answer ?? '', /近期是否有新增经营场地的安排/);
  assert.deepEqual(output?.factIds, []);
});

test('keeps conditional analysis while removing unsupported conclusions and embedded facts', () => {
  const output = formatCustomerDemand(JSON.stringify({
    status: 'unconfirmed', factIds: [],
    insights: [
      '如果客户确有新店计划，可优先核实目标商圈和开业时间。',
      '若是现有门店续租，先确认租约到期时间。',
      '如果客户拓店，那么这家公司肯定会在杭州承租商铺。',
      '如果客户有拓店计划，可优先核实预算，客户已决定在杭州开店。',
      '如果客户有拓店计划，可先核实商圈，他们计划本周租店。',
      '如果客户有拓店计划，可先核实商圈。他们会在杭州租房。',
      '这家企业很可能正在找新的经营场地。',
      '如果需要新店，按该客户已有的十万元租金预算筛选。',
    ],
    questions: ['请问当前项目由哪个部门负责？'],
    nextSteps: ['先向现有对接人核实。'],
  }), [], leaseQuestion);
  assert.match(output?.answer ?? '', /条件分析/);
  assert.match(output?.answer ?? '', /优先核实目标商圈和开业时间/);
  assert.match(output?.answer ?? '', /确认租约到期时间/);
  assert.doesNotMatch(output?.answer ?? '', /肯定|已决定|计划本周租店|会在杭州租房|很可能正在找|十万元/);
  assert.match(output?.answer ?? '', /现有资料无法确认/);
});

test('separates explicitly requested public profile facts from customer demand evidence', () => {
  const deal = dealFixture();
  deal.summary = '仅内部项目备注';
  const temptingProfileFact = { id: 'fact-2', label: '需求', value: '客户正在租用商铺。', source: '企业宣传页', sourceIds: ['brochure'] };
  const output = formatCustomerDemand(JSON.stringify({
    status: 'recorded', factIds: ['fact-1', 'fact-2'], profileFactIds: ['fact-1', 'fact-1', 'record-1', 'invented'],
    insights: ['如果客户有选址计划，可先核实商圈和面积。'], questions: [], nextSteps: [],
  }), [temptingProfileFact], leaseQuestion, [...customerInsightEvidence(deal), temptingProfileFact]);
  assert.match(output?.answer ?? '', /公开企业资料[\s\S]*餐饮品牌方[\s\S]*餐饮企业名录/);
  assert.match(output?.answer ?? '', /现有资料无法确认/);
  assert.doesNotMatch(output?.answer ?? '', /现有项目资料有相关记录|仅内部项目备注/);
  assert.deepEqual(output?.factIds, []);
  assert.deepEqual(output?.profileFactIds, ['fact-1']);
});

test('does not render unsolicited profile information in a demand-only answer', () => {
  const output = formatCustomerDemand(JSON.stringify({
    status: 'unconfirmed', factIds: [], profileFactIds: ['fact-1'], questions: [], nextSteps: [],
  }), [], leaseQuestion);
  assert.doesNotMatch(output?.answer ?? '', /公开企业资料/);
  assert.deepEqual(output?.profileFactIds, []);
});

test('quotes exact positive or negative customer evidence, with only the IDs displayed', () => {
  const deal = dealFixture('manual');
  deal.notes = [
    { id: 'note-1', author: '销售', date: now, text: '客户明确表示目前没有租房计划。' },
    { id: 'note-2', author: '销售', date: now, text: '已确认本周安排视频会议。' },
  ];
  const evidence = customerDemandEvidence(deal);
  const output = formatCustomerDemand(model('recorded', ['record-2', 'record-1', 'record-1']), evidence, leaseQuestion);
  assert.deepEqual(output?.factIds, ['record-1']);
  assert.match(output?.answer ?? '', /客户明确表示目前没有租房计划/);
  assert.doesNotMatch(output?.answer ?? '', /视频会议|有明确租房需求/);

  deal.notes[0].text = '客户表示计划在北京租用商铺开店。';
  const positive = formatCustomerDemand(model('recorded', ['record-1']), customerDemandEvidence(deal), leaseQuestion);
  assert.match(positive?.answer ?? '', /客户表示计划在北京租用商铺开店/);

  const external = { id: 'followup', label: '已授权知识库摘录', value: `${company}有租房需求。`, source: '项目会议纪要', sourceIds: ['followup'] };
  const documented = formatCustomerDemand(model('recorded', ['followup']), [external], leaseQuestion);
  assert.deepEqual(documented?.factIds, ['followup']);
  assert.match(documented?.answer ?? '', /有限公司有租房需求/);
});

test('screens unrelated demand, tentative notes and unsupported model assertions', () => {
  const deal = dealFixture('manual');
  deal.notes = [
    { id: 'note-1', author: '销售', date: now, text: '客户明确说要采购冷链设备。' },
    { id: 'note-2', author: '销售', date: now, text: '待确认客户是否有租房需求。' },
    { id: 'note-3', author: '销售', date: now, text: '没有直接证据表明客户有租房需求。' },
  ];
  const output = formatCustomerDemand(model('recorded', ['record-1', 'record-2', 'record-3'],
    ['近期是否有新增经营场地的安排？', '客户已经确认租房。'],
    ['联系拓展负责人，核实选址和时间要求。', '客户已经确认租房，安排签约。']),
  customerDemandEvidence(deal), leaseQuestion);
  assert.deepEqual(output?.factIds, []);
  assert.match(output?.answer ?? '', /现有资料无法确认/);
  assert.doesNotMatch(output?.answer ?? '', /采购冷链设备|已经确认租房/);
});

test('does not use a purchase budget as evidence for a lease budget', () => {
  const deal = dealFixture('manual');
  deal.notes = [
    { id: 'note-1', author: '销售', date: now, text: '客户明确说设备采购预算为十万元。' },
    { id: 'note-2', author: '销售', date: now, text: '客户明确回复暂时没有租金预算。' },
  ];
  const output = formatCustomerDemand(model('recorded', ['record-1', 'record-2']),
    customerDemandEvidence(deal), '该客户的租金预算是多少？');
  assert.deepEqual(output?.factIds, ['record-2']);
  assert.match(output?.answer ?? '', /暂时没有租金预算/);
});
