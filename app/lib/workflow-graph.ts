import type { Workflow } from './types.ts';

export function canConnectNodes(workflow: Workflow, from: string, to: string): { ok: boolean; error?: string } {
  const source = workflow.nodes.find(node => node.id === from);
  const target = workflow.nodes.find(node => node.id === to);
  if (!source || !target) return { ok: false, error: '节点已不存在，请重新选择连接端口。' };
  if (from === to) return { ok: false, error: '节点不能连接自己，请选择另一个输入端口。' };
  if (target.type === 'start') return { ok: false, error: '开始节点没有输入端口。' };
  if (source.type === 'output') return { ok: false, error: '结果输出是终点，不能再向后连接。' };
  if (workflow.edges.some(edge => edge.from === from && edge.to === to)) return { ok: false, error: '这两个节点已经连接。' };
  const pending = [to];
  const visited = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (current === from) return { ok: false, error: '这条连接会形成循环，请连接到后续节点。' };
    if (visited.has(current)) continue;
    visited.add(current);
    for (const edge of workflow.edges) if (edge.from === current) pending.push(edge.to);
  }
  return { ok: true };
}

export function autoLayoutWorkflow(workflow: Workflow): Workflow {
  if (!workflow.nodes.length) return { ...workflow, nodes: [] };
  const indegree = new Map(workflow.nodes.map(node => [node.id, 0]));
  const outgoing = new Map(workflow.nodes.map(node => [node.id, [] as string[]]));
  const depth = new Map(workflow.nodes.map(node => [node.id, 0]));
  for (const edge of workflow.edges) {
    if (!indegree.has(edge.from) || !indegree.has(edge.to)) continue;
    indegree.set(edge.to, indegree.get(edge.to)! + 1);
    outgoing.get(edge.from)!.push(edge.to);
  }
  const queue = workflow.nodes.filter(node => indegree.get(node.id) === 0).map(node => node.id);
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index];
    for (const next of outgoing.get(id)!) {
      depth.set(next, Math.max(depth.get(next)!, depth.get(id)! + 1));
      indegree.set(next, indegree.get(next)! - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  // Incomplete drafts still receive separate positions, even before a bad cycle is repaired.
  const layers = new Map<number, string[]>();
  for (const node of workflow.nodes) {
    const column = depth.get(node.id)!;
    layers.set(column, [...(layers.get(column) ?? []), node.id]);
  }
  const largest = Math.max(...[...layers.values()].map(nodes => nodes.length));
  const positions = new Map<string, { x: number; y: number }>();
  for (const [column, ids] of layers) {
    ids.forEach((id, row) => positions.set(id, { x: 64 + column * 280, y: 80 + ((largest - ids.length) / 2 + row) * 168 }));
  }
  return { ...workflow, nodes: workflow.nodes.map(node => ({ ...node, ...positions.get(node.id)! })) };
}
