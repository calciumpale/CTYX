import assert from 'node:assert/strict';
import test from 'node:test';
import type { Run } from '../app/lib/types.ts';
import { filterRuns, groupRunsByDate, runAnswerForDisplay, runStatus } from '../app/lib/run-history.ts';

const run = (overrides: Partial<Run> = {}): Run => ({
  id: 'run-1', query: '准备客户拜访方案', answer: '先确认预算与决策链。', agentIds: ['strategy'],
  steps: [], citations: [], mode: 'live', createdAt: '2026-10-24T02:00:00Z', duration: 1200,
  ...overrides,
});

test('normalizes legacy chat status while preserving paused, rejected, and failed runs', () => {
  assert.equal(runStatus(run()), 'completed');
  for (const status of ['completed', 'paused', 'rejected', 'failed'] as const) {
    assert.equal(runStatus(run({ status })), status);
  }
});

test('does not present a run containing a failed step as completed', () => {
  const steps: Run['steps'] = [{ id: 'step-error', title: '生成方案', detail: '模型请求失败', duration: 100, status: 'error' }];
  assert.equal(runStatus(run({ steps })), 'failed');
  assert.equal(runStatus(run({ steps, status: 'completed' })), 'failed');
  assert.equal(filterRuns([run({ steps })], { status: 'failed' }).length, 1);
  assert.equal(filterRuns([run({ steps })], { status: 'completed' }).length, 0);
});

test('searches tasks, results, translated expert names, and run IDs case insensitively', () => {
  const records = [run({ id: 'RUN-ABC' })];
  for (const search of [' 拜访 ', '预算', '策略方案', 'run-abc']) {
    assert.equal(filterRuns(records, { search }).length, 1, search);
  }
  assert.equal(filterRuns(records, { search: '不存在的客户' }).length, 0);
});

test('combines status and task source filters and sorts newest first without mutating records', () => {
  const records = [
    run({ id: 'old-chat', createdAt: '2026-10-22T01:00:00Z' }),
    run({ id: 'paused-flow', workflowId: 'workflow-1', status: 'paused', createdAt: '2026-10-24T02:00:00Z' }),
    run({ id: 'new-chat', createdAt: '2026-10-24T04:00:00Z' }),
    run({ id: 'completed-flow', workflowId: 'workflow-1' }),
  ];
  assert.deepEqual(filterRuns(records).map(item => item.id), ['new-chat', 'paused-flow', 'completed-flow', 'old-chat']);
  assert.deepEqual(filterRuns(records, { source: 'workflow', status: 'paused' }).map(item => item.id), ['paused-flow']);
  assert.deepEqual(filterRuns(records, { source: 'chat', status: 'completed' }).map(item => item.id), ['new-chat', 'old-chat']);
  assert.deepEqual(records.map(item => item.id), ['old-chat', 'paused-flow', 'new-chat', 'completed-flow']);
});

test('groups records by Shanghai date across UTC midnight boundaries', () => {
  const records = [
    run({ id: 'after-midnight', createdAt: '2026-10-23T16:01:00Z' }),
    run({ id: 'before-midnight', createdAt: '2026-10-23T15:59:00Z' }),
    run({ id: 'same-day', createdAt: '2026-10-24T02:00:00Z' }),
  ];
  const groups = groupRunsByDate(filterRuns(records));
  assert.deepEqual(groups.map(group => group.date), ['2026-10-24', '2026-10-23']);
  assert.deepEqual(groups[0].runs.map(item => item.id), ['same-day', 'after-midnight']);
  assert.deepEqual(groups[1].runs.map(item => item.id), ['before-midnight']);
});


test('hides only the standalone legacy generation prefix without altering original answer content', () => {
  const original = '客户洞察\n  演示生成 · 未调用外部模型  \n示例政策仍需核对。\n\n策略方案\n演示生成 · 未调用外部模型\n合成案例说明。\n正文中的演示生成 · 未调用外部模型应保留。';
  const displayed = runAnswerForDisplay(original);
  assert.equal(displayed, '客户洞察\n示例政策仍需核对。\n\n策略方案\n合成案例说明。\n正文中的演示生成 · 未调用外部模型应保留。');
  assert.ok(original.includes('  演示生成 · 未调用外部模型  '));
  assert.equal(runAnswerForDisplay('演示生成 · 未调用外部模型：其他说明'), '演示生成 · 未调用外部模型：其他说明');
});
