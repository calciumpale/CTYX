import test from 'node:test';
import assert from 'node:assert/strict';
import { executeMemberAction, assertMemberApi } from '../app/lib/member-policy.ts';
import { createSeed } from '../app/lib/seed.ts';
import type { Knowledge } from '../app/lib/types.ts';

const policy: Knowledge = {
  id: 'knowledge-document:chunk-17',
  title: '出差管理制度 · 第十二条',
  content: '出差审批须在订票前完成。超出标准时应填写书面说明。',
  category: '内部制度',
  source: '内部制度 / 出差管理制度.docx',
  status: 'published',
  updatedAt: '2026-11-07T00:00:00Z',
};

test('staff can reach the knowledge search endpoint', () => {
  for (const role of ['sales', 'manager', 'admin'] as const) {
    assert.doesNotThrow(() => assertMemberApi(role, '/api/knowledge-library', 'GET'));
    assert.doesNotThrow(() => assertMemberApi(role, '/api/knowledge-library', 'POST'));
    assert.throws(() => assertMemberApi(role, '/api/knowledge-library', 'PATCH'), { status: 403 });
  }
});

test('normal chat passes retrieved document context to the model and records its citation', async () => {
  let passedToModel = false;
  const query = '订票前需要走什么流程？';
  const result = await executeMemberAction(createSeed(), 'sales', 'chat', { query }, {
    retrieveManagedKnowledge: async (text) => {
      assert.equal(text, query);
      return [policy];
    },
    generate: async (input) => {
      passedToModel = input.knowledge.some(item => item.id === policy.id && item.content === policy.content);
      return { answer: '订票前先完成出差审批。', mode: 'live' };
    },
  });
  assert.ok(passedToModel);
  assert.ok(result.run?.citations.some(item => item.id === policy.id && item.title === policy.title));
});

test('unbound workflow knowledge retrieves documents and explicit bindings keep their scope', async () => {
  for (const bound of [false, true]) {
    const state = createSeed();
    const legacy = state.knowledge.find(item => item.status === 'published')!;
    const workflow = {
      id: 'policy-flow', name: '制度检查', description: '', status: 'published' as const,
      version: 1, updatedAt: policy.updatedAt,
      nodes: [
        { id: 'start', type: 'start' as const, label: '开始', x: 0, y: 0 },
        { id: 'library', type: 'knowledge' as const, label: '查制度', x: 200, y: 0, ...(bound ? { knowledgeIds: [legacy.id] } : {}) },
        { id: 'expert', type: 'agent' as const, agentId: 'risk' as const, label: '建议', x: 400, y: 0 },
        { id: 'output', type: 'output' as const, label: '输出', x: 600, y: 0 },
      ],
      edges: [{ from: 'start', to: 'library' }, { from: 'library', to: 'expert' }, { from: 'expert', to: 'output' }],
    };
    state.workflows = [workflow];
    let retrieved = false;
    const result = await executeMemberAction(state, 'sales', 'workflow_run', {
      mode: 'published', workflowId: workflow.id, query: '订票前需要走什么流程？',
    }, {
      retrieveManagedKnowledge: async () => { retrieved = true; return [policy]; },
      generate: async () => ({ answer: '已核对。', mode: 'live' }),
    });
    assert.equal(result.run?.status, 'completed');
    assert.equal(retrieved, !bound);
    assert.equal(result.run?.citations.some(item => item.id === policy.id), !bound);
    if (bound) assert.ok(result.run?.citations.some(item => item.id === legacy.id));
  }
});
