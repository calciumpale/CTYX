import test from 'node:test';
import assert from 'node:assert/strict';
import { autoLayoutWorkflow, canConnectNodes } from '../app/lib/workflow-graph.ts';
import type { Workflow } from '../app/lib/types.ts';

function graph(): Workflow {
  return { id: 'branch', name: '分支流程', description: '', version: 1, status: 'draft', updatedAt: '2026-10-23', nodes: [
    { id: 'start', type: 'start', label: '开始', x: 0, y: 0 },
    { id: 'intent', type: 'intent', label: '意图识别', x: 10, y: 0 },
    { id: 'a', type: 'agent', label: '洞察', x: 20, y: 0, agentId: 'insight', instruction: '保持此指令' },
    { id: 'b', type: 'agent', label: '风控', x: 20, y: 0, agentId: 'risk' },
    { id: 'out', type: 'output', label: '输出', x: 30, y: 0 },
  ], edges: [{ from: 'start', to: 'intent' }, { from: 'intent', to: 'a', condition: 'default' }, { from: 'intent', to: 'b', condition: 'risk' }, { from: 'a', to: 'out' }, { from: 'b', to: 'out' }] };
}

test('connections reject self loops, duplicates, cycles, missing nodes and invalid start/output ports', () => {
  const workflow = graph();
  for (const [from, to] of [['a', 'a'], ['start', 'intent'], ['a', 'intent'], ['missing', 'a'], ['a', 'start'], ['out', 'a']]) {
    const result = canConnectNodes(workflow, from, to);
    assert.equal(result.ok, false, `${from} → ${to}`);
    assert.ok(result.error);
  }
  assert.deepEqual(canConnectNodes(workflow, 'a', 'b'), { ok: true });
});

test('layout keeps every branch, condition, node setting and published snapshot unchanged', () => {
  const original = graph();
  const before = structuredClone(original);
  const arranged = autoLayoutWorkflow(original);
  assert.deepEqual(original, before);
  assert.deepEqual(arranged.edges, before.edges);
  const withoutPosition = (node: Workflow['nodes'][number]) => { const copy: Partial<typeof node> = { ...node }; delete copy.x; delete copy.y; return copy; };
  assert.deepEqual(arranged.nodes.map(withoutPosition), before.nodes.map(withoutPosition));
  for (const edge of arranged.edges) {
    assert.ok(arranged.nodes.find(node => node.id === edge.to)!.x > arranged.nodes.find(node => node.id === edge.from)!.x);
  }
  const a = arranged.nodes.find(node => node.id === 'a')!;
  const b = arranged.nodes.find(node => node.id === 'b')!;
  assert.equal(a.x, b.x);
  assert.ok(Math.abs(a.y - b.y) >= 140);
  assert.deepEqual(autoLayoutWorkflow(arranged), arranged);
});

test('layout gives disconnected draft nodes usable separate positions and handles empty graphs', () => {
  const workflow = graph();
  workflow.nodes.push({ id: 'draft', type: 'knowledge', label: '未连线资料', x: 0, y: 0 });
  const arranged = autoLayoutWorkflow(workflow);
  const positions = new Set(arranged.nodes.map(node => `${node.x},${node.y}`));
  assert.equal(positions.size, workflow.nodes.length);
  assert.ok(arranged.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y) && node.x >= 48 && node.y >= 48));
  assert.deepEqual(autoLayoutWorkflow({ ...workflow, nodes: [], edges: [] }), { ...workflow, nodes: [], edges: [] });
});
