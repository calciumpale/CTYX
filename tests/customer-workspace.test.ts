import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeed } from '../app/lib/seed.ts';
import type { Deal, Run } from '../app/lib/types.ts';
import { buildCustomerChatRequest, companyDirectory, customerChatHistory, selectCompanyProject, selectInitialCustomerProject } from '../app/lib/customer-workspace.ts';

const seed = createSeed('2026-11-07T08:00:00.000Z');
const deal = (id: string, name: string, projectName = id): Deal => ({ ...seed.deals[0], id, name, projectName });
const run = (id: string, dealId: string | undefined, createdAt: string, extra: Partial<Run> = {}): Run => ({ id, dealId, createdAt, query: id, answer: 'result', agentIds: ['insight'], steps: [], citations: [], mode: 'demo', duration: 1, ...extra });

test('directory groups only normalized exact company names and sorts independently of input order', () => {
  const input = [deal('z', '  远山科技  '), deal('a', '远山科技'), deal('b', '远山科技有限公司'), deal('c', 'ACME  Labs'), deal('d', 'ＡＣＭＥ Labs')];
  const companies = companyDirectory(input);
  assert.equal(companies.length, 3);
  assert.deepEqual(companies, companyDirectory([...input].reverse()));
  assert.deepEqual(companies.find(company => company.name === '远山科技')?.projects.map(project => project.id), ['a', 'z']);
  assert.equal(companies.find(company => company.projects.some(project => project.id === 'c'))?.projects.length, 2);
  assert.notEqual(companies.find(company => company.projects.some(project => project.id === 'a'))?.key, companies.find(company => company.projects.some(project => project.id === 'b'))?.key);
});

test('research names are a fallback and cannot collapse distinct manual company names', () => {
  const profile = { companyName: '远山集团' } as NonNullable<Deal['companyProfile']>;
  const companies = companyDirectory([{ ...deal('a', '远山一厂'), companyProfile: profile }, { ...deal('b', '远山二厂'), companyProfile: profile }, { ...deal('c', '  '), companyProfile: profile }]);
  assert.equal(companies.length, 3);
  assert.equal(companies.find(company => company.projects[0].id === 'c')?.name, '远山集团');
});

test('selection preserves explicit project IDs and refuses unavailable deep links', () => {
  const companies = companyDirectory([deal('a', '远山科技'), deal('b', '远山科技')]);
  assert.equal(selectInitialCustomerProject(companies, 'b'), 'b');
  assert.equal(selectInitialCustomerProject(companies, 'not-authorized'), null);
  assert.equal(selectInitialCustomerProject(companies), 'a');
  assert.equal(selectCompanyProject(companies[0], 'b'), 'b');
  assert.equal(selectCompanyProject(companies[0], 'unavailable'), 'a');
});

test('project chat history never includes other companies, sibling projects, global or workflow runs', () => {
  const runs = [run('b', 'selected', '2026-11-07T10:00:00Z'), run('a', 'selected', '2026-11-07T09:00:00Z'), run('private', 'other', '2026-11-07T08:00:00Z'), run('global', undefined, '2026-11-07T11:00:00Z'), run('workflow', 'selected', '2026-11-07T12:00:00Z', { workflowId: 'flow' })];
  assert.deepEqual(customerChatHistory(runs, 'selected').map(item => item.id), ['a', 'b']);
  assert.deepEqual(customerChatHistory(runs, null), []);
});

test('chat requests capture exact text, selected target and bounded completed context for safe retries', () => {
  const runs = Array.from({ length: 8 }, (_, index) => run(String(index), 'selected', `2026-11-07T0${index}:00:00Z`));
  runs.push(run('failed', 'selected', '2026-11-07T09:00:00Z', { status: 'failed' }), run('wrong', 'other', '2026-11-07T10:00:00Z'));
  const request = buildCustomerChatRequest({ query: '  继续\n保留原话  ', dealId: 'selected', runs, agentId: 'strategy' });
  assert.deepEqual(request, { query: '  继续\n保留原话  ', dealId: 'selected', agentId: 'strategy', conversationRunIds: ['2', '3', '4', '5', '6', '7'] });
  runs.splice(0);
  assert.equal(request.query, '  继续\n保留原话  ');
  assert.equal(request.conversationRunIds.length, 6);
});
