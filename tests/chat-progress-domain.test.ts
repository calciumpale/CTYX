import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatProgressStep } from '../app/lib/chat-progress.ts';
import { executeMemberAction } from '../app/lib/member-policy.ts';
import { createSeed } from '../app/lib/seed.ts';

const now = '2026-11-13T17:00:00.000Z';
const privateQuery = '解释这句独立文本 PRIVATE_QUERY';
const privateReply = '模型原始输出 PRIVATE_REPLY';

function gate() {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  return { pending, release };
}

test('chat reports real retrieval and model progress before the answer resolves', async () => {
  const state = createSeed(now);
  const events: ChatProgressStep[] = [];
  const retrievalEntered = gate();
  const allowRetrieval = gate();
  const modelEntered = gate();
  const allowAnswer = gate();
  const result = executeMemberAction(state, 'manager', 'chat', { query: privateQuery }, {
    now,
    onChatProgress: step => events.push(step),
    prepareKnowledge: async () => {
      retrievalEntered.release();
      await allowRetrieval.pending;
      return { route: 'direct', evidenceIds: [], knowledge: [] };
    },
    generate: async () => {
      modelEntered.release();
      await allowAnswer.pending;
      return { answer: privateReply, mode: 'live', modelName: 'PRIVATE_MODEL' };
    },
  });

  try {
    await retrievalEntered.pending;
    const retrieval = events.find(step => step.title === '检索生效知识');
    assert.equal(retrieval?.status, 'running');
    assert.equal(events.some(step => /生成/.test(step.title)), false);
    allowRetrieval.release();
    await modelEntered.pending;
    assert.ok(events.some(step => step.id === retrieval?.id && step.status === 'success'));
    const generating = events.find(step => /生成/.test(step.title));
    assert.equal(generating?.status, 'running');
    assert.equal(events.filter(step => step.id === generating?.id).length, 1);
    allowAnswer.release();
    const { run } = await result;
    assert.equal(run?.answer, privateReply);
    assert.ok(events.some(step => step.id === generating?.id && step.status === 'success'));
    assert.ok(run?.steps.every(step => step.status !== ('running' as string)));
    assert.ok(run?.steps.some(step => step.id === generating?.id && step.detail.includes('PRIVATE_MODEL')));
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_QUERY|PRIVATE_REPLY|PRIVATE_MODEL/);
    for (const step of events) {
      assert.ok(Object.keys(step).every(key => ['id', 'title', 'detail', 'duration', 'status', 'agent'].includes(key)));
    }
  } finally {
    allowRetrieval.release();
    allowAnswer.release();
    await result.catch(() => {});
  }
});

test('progress reports a model failure without exposing provider errors or affecting access checks', async () => {
  const state = createSeed(now);
  const events: ChatProgressStep[] = [];
  const context = {
    now,
    onChatProgress: (step: ChatProgressStep) => { events.push(step); },
    generate: async () => { throw new Error('PRIVATE_PROVIDER_ERROR'); },
  };
  await assert.rejects(executeMemberAction(state, 'admin', 'chat', { query: privateQuery }, context), /没有此操作权限/);
  assert.equal(events.length, 0);
  await assert.rejects(executeMemberAction(state, 'manager', 'chat', { query: privateQuery }, context), /PRIVATE_PROVIDER_ERROR/);
  const generating = events.find(step => /生成/.test(step.title));
  assert.equal(generating?.status, 'running');
  assert.ok(events.some(step => step.id === generating?.id && step.status === 'error'));
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_PROVIDER_ERROR/);
});
