import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import type { ActionContext, GenerationInput } from '../app/lib/domain.ts';
import {
  prepareKnowledgeContext, type KnowledgeAgentCandidate, type KnowledgeAgentRequest,
  type KnowledgePreparedContext,
} from '../app/lib/knowledge-agent.ts';
import { executeMemberAction } from '../app/lib/member-policy.ts';
import { requestModelText, type ModelMessage } from '../app/lib/model-client.ts';
import { buildModelMessages } from '../app/lib/model-messages.ts';
import { createSeed } from '../app/lib/seed.ts';
import type { Run } from '../app/lib/types.ts';

const now = '2026-11-12T12:49:28.000Z';
const company = '北岸合成测试客户';
const demandQuestion = '调研下客户是否有租房需求';
const policyQuestion = '我们内部的差旅报销制度是什么？';
const oldAnswer = '历史回合专用标记：差旅报销须送旧仓库。';
const oldCitation = { id: 'previous-turn-only', title: '历史回合资料', excerpt: oldAnswer };
const background = {
  id: 'directory-only', title: `${company} 企业名录`, content: `${company}从事餐饮经营。`,
};
const otherCustomer = {
  id: 'different-company', title: '南岸合成测试客户跟进', content: '南岸合成测试客户确认需要在园区租赁商铺。',
};
const demandSource = {
  id: 'current-demand', title: `${company}本轮跟进`, content: `${company}明确表示计划租用商铺开店。`,
};
const policySource = {
  id: 'current-policy', title: '本轮差旅报销制度', content: '员工须在出差结束后五个工作日内提交差旅报销申请。',
};

type Phase = 'route' | 'evidence' | 'answer' | 'insight';
type Call = { phase: Phase; messages: ModelMessage[] };
type Scenario = {
  question: string;
  useDeal?: boolean;
  candidates: KnowledgeAgentCandidate[];
  replies: Partial<Record<Phase, string | string[]>>;
  requireNarrative?: boolean;
  expectedMode?: Run['mode'];
  projectProfile?: NonNullable<ReturnType<typeof createSeed>['deals'][number]['companyProfile']>;
  searchCompanyExpansion?: ActionContext['searchCompanyExpansion'];
  enrichCompany?: ActionContext['enrichCompany'];
};

const selection = (...sources: KnowledgeAgentCandidate[]) => JSON.stringify({
  evidence: sources.map(source => ({ id: source.id, quote: source.content })), conflictEvidenceIds: [],
});
const demandAnswer = (status: 'recorded' | 'unconfirmed', factIds: string[]) => JSON.stringify({
  status, factIds, questions: ['是否有开店计划？'], nextSteps: ['向该客户的拓展负责人确认租赁计划。'],
});

async function runChat(scenario: Scenario) {
  const state = createSeed(now);
  const deal = state.deals[0];
  deal.name = company;
  deal.dataOrigin = 'research';
  deal.needs = [];
  deal.summary = '';
  deal.notes = [];
  delete deal.customerProfile;
  deal.companyProfile = scenario.projectProfile;
  const prior: Run = {
    id: 'synthetic-prior-turn', query: '合成旧任务：仓库搬迁流程', answer: oldAnswer, agentIds: ['insight'],
    steps: [], citations: [oldCitation], mode: 'live', createdAt: now, duration: 1,
    ...(scenario.useDeal ? { dealId: deal.id } : {}),
  };
  state.runs = [prior];
  const calls: Call[] = [];
  const requests: KnowledgeAgentRequest[] = [];
  const queries: string[] = [];
  const prepared: KnowledgePreparedContext[] = [];
  const fixtureErrors: unknown[] = [];
  const sentPhases: Phase[] = [];
  const model = { url: '', key: 'local-fixture-key', name: 'local-fixture-model' };
  const fixture = createServer(async (request, response) => {
    try {
      const body = await Array.fromAsync(request.setEncoding('utf8'));
      const payload = JSON.parse(body.join('')) as { model: string; messages: ModelMessage[] };
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, `Bearer ${model.key}`);
      assert.equal(payload.model, model.name);
      const phase = sentPhases[calls.length];
      const configured = scenario.replies[phase];
      const reply = Array.isArray(configured) ? configured[calls.filter(call => call.phase === phase).length] : configured;
      calls.push({ phase, messages: payload.messages });
      assert.equal(typeof reply, 'string', `unexpected model phase: ${phase}`);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: reply } }] }));
    } catch (error) {
      fixtureErrors.push(error);
      response.writeHead(500);
      response.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    fixture.once('error', reject);
    fixture.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = fixture.address();
    assert.ok(address && typeof address === 'object');
    model.url = `http://127.0.0.1:${address.port}/v1/chat/completions`;
    const requestModel = (phase: Phase, messages: ModelMessage[]) => {
      sentPhases.push(phase);
      return requestModelText(model, messages, { timeoutMs: 3000 });
    };
    const generate = (phase: 'answer' | 'insight') => async (input: GenerationInput) => ({
      answer: await requestModel(phase, buildModelMessages(input)), mode: 'live' as const,
    });
    const result = await executeMemberAction(state, 'manager', 'chat', {
      query: scenario.question,
      ...(scenario.useDeal ? { dealId: deal.id } : {}),
      conversationRunIds: [prior.id],
    }, {
      now, generate: generate('answer'), generateInsight: generate('insight'),
      requireNarrative: scenario.requireNarrative,
      searchCompanyExpansion: scenario.searchCompanyExpansion,
      enrichCompany: scenario.enrichCompany,
      prepareKnowledge: async request => {
        requests.push(request);
        const context = await prepareKnowledgeContext(request, {
          retrieve: async query => { queries.push(query); return scenario.candidates; },
          generate: (messages, options) => {
            const phase = options?.phase;
            assert.ok(phase === 'route' || phase === 'evidence');
            return requestModel(phase, messages);
          },
        });
        prepared.push(context);
        return context;
      },
    });
    assert.deepEqual(fixtureErrors, []);
    assert.deepEqual(calls.map(call => call.phase), sentPhases, 'every callback reached the loopback provider');
    assert.ok(result.run);
    assert.ok(result.state.runs.some(run => run.id === result.run?.id));
    assert.equal(result.run.mode, scenario.expectedMode ?? 'live');
    assert.doesNotMatch(JSON.stringify(result.run), /历史回合专用标记|previous-turn-only|合成旧任务/);
    assert.doesNotMatch(JSON.stringify(calls), /历史回合专用标记|previous-turn-only|合成旧任务/);
    return { run: result.run, calls, requests, queries, prepared };
  } finally {
    await new Promise<void>((resolve, reject) => fixture.close(error => error ? reject(error) : resolve()));
  }
}

const userPayload = (call: Call) => call.messages.filter(message => message.role === 'user').at(-1)?.content ?? '';

const compoundQuestion = '补全一下这家公司的画像，同时查一下他是不是有扩店的一些需求';
const registryProfile = {
  companyName: company, summary: '企业资料', status: 'ready' as const, provider: 'qcc' as const,
  modelUsed: false, warnings: [], updatedAt: now,
  facts: [{ label: '主营业务', value: '连锁餐饮运营', sourceIds: ['registry'] }],
  sources: [{ id: 'registry', title: '合成企业登记资料', url: 'https://example.com/company', provider: 'qcc' as const, retrievedAt: now }],
};

test('a compound insight keeps verified profile and safe prose when part of the provider answer is rejected', async () => {
  const checked: string[] = [];
  const result = await runChat({
    question: compoundQuestion, useDeal: true, candidates: [], requireNarrative: true,
    enrichCompany: async () => { checked.push('profile'); return registryProfile; },
    searchCompanyExpansion: async () => { checked.push('search'); return { ...registryProfile, facts: [], sources: [], provider: 'web', status: 'partial' }; },
    replies: { insight: JSON.stringify({ status: 'recorded', answer: '这次先看已有的企业登记资料。\n\n[[fact-1]]\n> [[invented-source]]\n\n该公司已决定下月扩店。\n\n建议先向门店拓展部门确认目标商圈。' }) },
  });
  assert.deepEqual(checked, ['profile', 'search']);
  assert.deepEqual(result.calls.map(call => call.phase), ['insight']);
  assert.match(result.run.answer, /连锁餐饮运营/);
  assert.match(result.run.answer, /确认目标商圈/);
  assert.match(result.run.answer, /尚未确认|无法确认/);
  assert.doesNotMatch(result.run.answer, /已决定|invented-source/);
  assert.deepEqual(result.run.citations.map(item => item.title), ['合成企业登记资料']);
});

test('a compound insight still returns its verified profile after two unusable model outputs', async () => {
  const result = await runChat({
    question: compoundQuestion, useDeal: true, candidates: [], requireNarrative: true, projectProfile: registryProfile,
    expectedMode: 'demo',
    replies: { insight: ['{"answer":', '{"answer":'] },
  });
  assert.deepEqual(result.calls.map(call => call.phase), ['insight', 'insight']);
  assert.match(result.run.answer, /连锁餐饮运营/);
  assert.match(result.run.answer, /尚未确认|无法确认/);
  assert.deepEqual(result.run.citations.map(item => item.title), ['合成企业登记资料']);
  assert.equal(result.run.answerSource, 'evidence-boundary');
});

test('the screenshot question saves the final model prose without a fixed heading or opening', async () => {
  const answer = '目前还不能判断这家客户是否需要租赁场地。仅凭餐饮行业背景，我会先把它当成待跟进的线索。\n\n如果你想尽快确认，先问拓展团队近期是否在看新铺，或者已有门店准备续租、搬迁。';
  const result = await runChat({
    question: demandQuestion, useDeal: true, candidates: [], requireNarrative: true,
    replies: { insight: JSON.stringify({ answer, status: 'unconfirmed', factIds: [] }) },
  });
  assert.deepEqual(result.calls.map(call => call.phase), ['insight']);
  assert.equal(result.run.answer, answer);
  assert.deepEqual(result.run.citations, []);
});

test('model prose uses a verified customer quote without including unrelated reference IDs', async () => {
  const answer = '可以继续跟进租赁意向。项目里有这一条原话。\n\n> [[current-demand]]\n\n下一步建议确认目前在看的商圈。';
  const result = await runChat({
    question: demandQuestion, useDeal: true, candidates: [background, demandSource], requireNarrative: true,
    replies: { evidence: selection(demandSource), insight: JSON.stringify({ answer, status: 'recorded', factIds: [demandSource.id, background.id] }) },
  });
  assert.equal(result.run.answer, answer.replace('[[current-demand]]', demandSource.content));
  assert.deepEqual(result.run.citations.map(item => item.id), [demandSource.id]);
});

test('a template-only response from the provider gets one repair and saves the repaired model prose', async () => {
  const answer = '租赁需求还需要向客户确认。建议先问近期有没有新增或调整门店的安排。';
  const result = await runChat({
    question: demandQuestion, useDeal: true, candidates: [], requireNarrative: true,
    replies: { insight: [demandAnswer('unconfirmed', []), JSON.stringify({ answer, status: 'unconfirmed' })] },
  });
  assert.deepEqual(result.calls.map(call => call.phase), ['insight', 'insight']);
  assert.match(result.calls[1].messages[0].content, /重新写出简明的 answer 正文/);
  assert.equal(result.run.answer, answer);
});

test('official-record help retains model wording and resolves only an approved verification link', async () => {
  const opening = '这个问题需要按企业全称核对，手上的资料不能确认有没有行政处罚。';
  const result = await runChat({
    question: '这家公司的行政处罚记录怎么查？', useDeal: true, candidates: [], requireNarrative: true,
    replies: { route: '{"action":"retrieve"}', insight: JSON.stringify({ answer: `${opening}\n\n> [[registry]]` }) },
  });
  assert.ok(result.run.answer.startsWith(`${opening}\n\n`));
  assert.match(result.run.answer, /国家企业信用信息公示系统.*https:\/\/www\.gsxt\.gov\.cn/);
  assert.deepEqual(result.run.citations, []);
});

test('explicit rental research sends just the company name to search and lets the model state the result', async () => {
  const answer = '暂时没有足够的信息确认租赁需求。建议先核实拓展团队是否在寻找新店场地。';
  let searched = false;
  const result = await runChat({
    question: demandQuestion, useDeal: true, candidates: [], requireNarrative: true,
    searchCompanyExpansion: async input => {
      searched = true;
      assert.deepEqual(input, { name: company });
      return { companyName: company, summary: '', status: 'partial', provider: 'web', modelUsed: false, warnings: [], updatedAt: now,
        facts: [], sources: [] };
    },
    replies: { insight: JSON.stringify({ status: 'unconfirmed', answer }) },
  });
  assert.equal(searched, true);
  assert.match(result.calls[0].messages[0].content, /公开检索未找到/);
  assert.equal(result.run.answer, answer);
});

test('customer demand research reaches the insight model without borrowing a company directory or another customer', async () => {
  const result = await runChat({
    question: demandQuestion, useDeal: true, candidates: [background, otherCustomer],
    replies: { evidence: selection(), insight: demandAnswer('unconfirmed', []) },
  });
  assert.deepEqual(result.calls.map(call => call.phase), ['evidence', 'insight']);
  assert.equal(result.requests[0].audience, 'workspace');
  assert.equal(result.requests[0].intent, 'business');
  assert.equal(result.requests[0].subject, company);
  assert.deepEqual(result.queries, [`${demandQuestion}\n${company}`]);
  assert.equal(result.prepared[0].route, 'no_evidence');
  assert.match(userPayload(result.calls[0]), /directory-only/);
  assert.doesNotMatch(userPayload(result.calls[0]), /different-company/);
  assert.doesNotMatch(userPayload(result.calls[1]), /directory-only|different-company|从事餐饮经营/);
  assert.deepEqual(result.run.agentIds, ['insight']);
  assert.deepEqual(result.run.citations, []);
  assert.match(result.run.answer, /现有资料无法确认/);
  assert.match(result.run.answer, /向该客户的拓展负责人确认租赁计划/);
  assert.match(result.run.steps.map(step => step.detail).join('\n'), /服务端外部模型返回/);
});

test('a combined profile and expansion request keeps supported profile facts and model analysis when demand is unknown', async () => {
  const result = await runChat({
    question: '这家公司的画像完善一下，搜一下对方有没有扩张的需求', useDeal: true, candidates: [],
    projectProfile: {
      companyName: company, summary: '', status: 'ready', provider: 'qcc', modelUsed: false, warnings: [], updatedAt: now,
      facts: [{ label: '主营业务', value: '连锁餐饮运营', sourceIds: ['registry'] }],
      sources: [{ id: 'registry', title: '合成企业登记资料', url: 'https://example.com/company', provider: 'qcc', retrievedAt: now }],
    },
    replies: { insight: JSON.stringify({
      status: 'unconfirmed', factIds: [], profileFactIds: ['fact-1'],
      insights: ['如果出现新店签约公告，可以先核实目标城市与预计开业时间。'],
      questions: ['今年是否有新增门店安排？'], nextSteps: ['查询该企业的公开公告。'],
    }) },
  });
  assert.deepEqual(result.calls.map(call => call.phase), ['insight']);
  assert.equal(result.prepared[0].route, 'no_evidence');
  assert.match(userPayload(result.calls[0]), /连锁餐饮运营/);
  assert.match(result.run.answer, /连锁餐饮运营/);
  assert.match(result.run.answer, /如果出现新店签约公告/);
  assert.match(result.run.answer, /现有资料无法确认/);
  assert.deepEqual(result.run.citations.map(citation => citation.title), ['合成企业登记资料']);
});

test('an explicit search supplies public expansion signals to the model separately from verified demand', async () => {
  const source = { id: 'expansion-web-1', title: '合成新闻报道', url: 'https://example.com/news', provider: 'web' as const,
    snippet: `${company}发布新店选址公告。`, retrievedAt: now };
  const result = await runChat({
    question: '搜一下对方有没有扩张的需求', useDeal: true, candidates: [],
    searchCompanyExpansion: async input => {
      assert.deepEqual(input, { name: company });
      return { companyName: company, summary: '', status: 'partial', provider: 'web', modelUsed: false, warnings: [], updatedAt: now,
        facts: [], sources: [source] };
    },
    replies: { insight: JSON.stringify({ status: 'recorded', factIds: [source.id], profileFactIds: [source.id],
      questions: ['选址范围是什么？'], nextSteps: ['向拓展部门核实公告的进度。'] }) },
  });
  const payload = userPayload(result.calls[0]);
  assert.match(payload, /客户洞察可用证据"\s*:\s*\[\],"公开企业资料"/);
  assert.match(result.run.answer, /现有资料无法确认/);
  assert.match(result.run.answer, /公开搜索摘要，待核实/);
  assert.deepEqual(result.run.citations.map(citation => citation.title), [source.title]);
});

test('when a public search fails, the final model still offers useful conditional advice', async () => {
  const result = await runChat({
    question: '搜一下对方有没有扩张的需求', useDeal: true, candidates: [],
    searchCompanyExpansion: async () => { throw new Error('search provider timeout'); },
    replies: { insight: demandAnswer('unconfirmed', []) },
  });
  assert.match(result.run.steps.map(step => step.detail).join('\n'), /公开检索暂时未完成/);
  assert.match(result.run.answer, /向该客户的拓展负责人确认租赁计划/);
  assert.deepEqual(result.run.citations, []);
});

test('customer demand research cites only the confirmed source selected for the current customer', async () => {
  const result = await runChat({
    question: demandQuestion, useDeal: true, candidates: [background, otherCustomer, demandSource],
    replies: { evidence: selection(demandSource), insight: demandAnswer('recorded', [demandSource.id]) },
  });
  assert.deepEqual(result.calls.map(call => call.phase), ['evidence', 'insight']);
  assert.equal(result.prepared[0].route, 'retrieved');
  assert.deepEqual(result.prepared[0].evidenceIds, [demandSource.id]);
  assert.match(userPayload(result.calls[1]), /current-demand/);
  assert.doesNotMatch(userPayload(result.calls[1]), /directory-only|different-company/);
  assert.ok(result.run.answer.includes(demandSource.content));
  assert.deepEqual(result.run.citations.map(citation => citation.id), [demandSource.id]);
});

test('customer demand research without a selected customer asks for the project before retrieving', async () => {
  const clarification = '请提供客户名称或选择需要调研的项目。';
  const result = await runChat({
    question: demandQuestion, candidates: [background, otherCustomer, demandSource],
    replies: { answer: clarification },
  });
  assert.deepEqual(result.calls.map(call => call.phase), ['answer']);
  assert.deepEqual(result.queries, []);
  assert.deepEqual(result.requests, []);
  assert.equal(result.run.dealId, undefined);
  assert.ok(result.run.answer.includes(clarification));
  assert.doesNotMatch(userPayload(result.calls[0]), /北岸合成测试客户|南岸合成测试客户/);
  assert.deepEqual(result.run.citations, []);
});

test('a workplace policy answer cites only its current selected evidence', async () => {
  const obsoleteText = '旧制度的差旅报销表统一交蓝盒仓库。';
  const mixedPolicySource = { ...policySource, content: `${obsoleteText}\n${policySource.content}` };
  const result = await runChat({
    question: policyQuestion, candidates: [background, mixedPolicySource],
    replies: { evidence: selection(policySource), answer: policySource.content },
  });
  assert.deepEqual(result.calls.map(call => call.phase), ['evidence', 'answer']);
  assert.deepEqual(result.queries, [policyQuestion]);
  assert.equal(result.prepared[0].route, 'retrieved');
  assert.deepEqual(result.prepared[0].evidenceIds, [policySource.id]);
  assert.match(userPayload(result.calls[0]), /蓝盒仓库/);
  assert.match(userPayload(result.calls[1]), /current-policy/);
  assert.doesNotMatch(userPayload(result.calls[1]), /directory-only|蓝盒仓库/);
  assert.ok(result.run.answer.includes(policySource.content));
  assert.deepEqual(result.run.citations, [{ id: policySource.id, title: policySource.title, excerpt: policySource.content }]);
});

test('a workplace policy question without current evidence gets a bounded model answer and no citations', async () => {
  const answer = '我手上没有适用于你的差旅制度，无法确认公司的提交期限。\n\n差旅报销通常包括整理凭证、提交申请和财务审核。\n\n建议先确认适用的报销流程。';
  const result = await runChat({
    question: policyQuestion, candidates: [background],
    replies: { evidence: selection(), answer },
  });
  assert.deepEqual(result.calls.map(call => call.phase), ['evidence', 'answer']);
  assert.deepEqual(result.queries, [policyQuestion]);
  assert.equal(result.prepared[0].route, 'no_evidence');
  assert.doesNotMatch(userPayload(result.calls[1]), /directory-only|从事餐饮经营/);
  assert.equal(result.run.answer, answer);
  assert.deepEqual(result.run.citations, []);
});

test('without internal policy evidence, the answer keeps actionable guidance and drops unsupported requirements', async () => {
  const result = await runChat({
    question: policyQuestion, candidates: [],
    replies: { answer: '公司规定必须在三天内提交报销。\n\n可以先把交通凭证和行程单整理好，再向财务确认提交入口。' },
  });
  assert.deepEqual(result.calls.map(call => call.phase), ['answer']);
  assert.match(result.run.answer, /把交通凭证和行程单整理好/);
  assert.doesNotMatch(result.run.answer, /三天内/);
  assert.deepEqual(result.run.citations, []);
});

test('conflicting current policy records reach the final model without either disputed claim', async () => {
  const records = [5, 3].map(days => ({
    id: `policy-${days}-days`, title: policySource.title,
    content: `员工出差结束后的差旅报销申请期限为${days}个工作日。`,
  }));
  const result = await runChat({
    question: policyQuestion, candidates: records,
    replies: {
      evidence: JSON.stringify({
        evidence: records.map(record => ({ id: record.id, quote: record.content })),
        conflictEvidenceIds: records.map(record => record.id),
      }),
      answer: '请核对财务部门发布的现行报销要求。',
    },
  });
  assert.deepEqual(result.calls.map(call => call.phase), ['evidence', 'answer']);
  assert.equal(result.prepared[0].route, 'conflict');
  assert.deepEqual(result.prepared[0].evidenceIds, records.map(record => record.id));
  assert.doesNotMatch(userPayload(result.calls[1]), /policy-[35]-days|[35]个工作日/);
  assert.match(result.run.steps.map(step => step.detail).join('\n'), /内容冲突的资料/);
  assert.match(result.run.answer, /请核对财务部门发布的现行报销要求/);
  assert.deepEqual(result.run.citations, []);
});

test('an independent writing request reaches route and answer without reading knowledge', async () => {
  const result = await runChat({
    question: '请写一句得体的邮件问候语', candidates: [background],
    replies: { route: JSON.stringify({ action: 'direct' }), answer: '您好，希望您一切顺利。' },
  });
  assert.deepEqual(result.calls.map(call => call.phase), ['route', 'answer']);
  assert.deepEqual(result.queries, []);
  assert.equal(result.prepared[0].route, 'direct');
  assert.match(result.run.answer, /您好，希望您一切顺利/);
  assert.deepEqual(result.run.citations, []);
});
