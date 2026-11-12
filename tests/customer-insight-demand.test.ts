import assert from 'node:assert/strict';
import test from 'node:test';
import {
  customerDemandEvidence, customerInsightEvidence, formatCustomerDemand, formatCustomerInsightResult,
  isCustomerDemandFollowup, isCustomerDemandQuestion,
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
      sources: [{ id: 'listing', title: '餐饮企业名录', url: 'https://example.com/list', provider: 'web', retrievedAt: now }],
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

test('renders public-only demand assessment as unconfirmed, even if the model reports a record', () => {
  const evidence = customerDemandEvidence(dealFixture());
  const output = formatCustomerDemand(model('recorded', ['listing', 'invented']), evidence, leaseQuestion);
  assert.match(output?.answer ?? '', /现有资料无法确认/);
  assert.match(output?.answer ?? '', /近期是否有新增经营场地的安排/);
  assert.deepEqual(output?.factIds, []);
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
