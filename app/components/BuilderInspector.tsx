'use client';

import { BookOpen, Bot, Check, FileText, GitBranch, Info, Play, ShieldCheck, Trash2 } from 'lucide-react';
import { AGENTS, type FlowNode, type ViewProps, type Workflow } from '../lib/types';

export const BUILDER_NODES = [
  { type: 'start', name: '开始', detail: '接收任务输入', icon: Play },
  { type: 'intent', name: '意图分流', detail: '按任务选择处理路径', icon: GitBranch },
  { type: 'knowledge', name: '知识检索', detail: '检索知识与已审核 Skill', icon: BookOpen },
  { type: 'agent', name: '领域专家', detail: '调用五位专家之一', icon: Bot },
  { type: 'review', name: '人工确认', detail: '暂停并交主管确认', icon: ShieldCheck },
  { type: 'output', name: '结束', detail: '汇总上游处理结果', icon: Check },
] as const;

export function KnowledgeSelection({ state, node, onChange, disabled = false }: {
  state: ViewProps['state']; node: FlowNode; onChange: (changes: Partial<FlowNode>) => void; disabled?: boolean;
}) {
  const sources = [...new Map([
    ...state.knowledge.filter(item => item.status === 'published').map(item => ({ id: item.id, title: item.title, kind: '知识' })),
    ...state.skills.filter(item => item.status === 'published').map(item => ({ id: `knowledge-${item.id}`, title: item.title, kind: 'Skill' })),
  ].map(source => [source.id, source])).values()];
  const all = node.knowledgeIds === undefined;
  return <fieldset className="builder-knowledge" disabled={disabled}>
    <legend>检索范围</legend>
    <label className="builder-check"><input type="checkbox" checked={all} onChange={event => onChange({ knowledgeIds: event.target.checked ? undefined : [] })} /><span>全部生效知识与 Skill</span></label>
    <p className="builder-help">仅检索已发布内容；候选与退回的 Skill 不参与生成。</p>
    {!all && <div className="builder-source-list">{sources.length ? sources.map(source => <label className="builder-check" key={source.id}><input type="checkbox" checked={node.knowledgeIds?.includes(source.id) ?? false} onChange={event => onChange({ knowledgeIds: event.target.checked ? [...(node.knowledgeIds ?? []), source.id] : (node.knowledgeIds ?? []).filter(id => id !== source.id) })} /><span>{source.title}<small>{source.kind}</small></span></label>) : <p className="builder-help">当前还没有生效知识，可先在知识与技能中导入。</p>}</div>}
    {!all && node.knowledgeIds?.length === 0 && <p className="builder-help">尚未选择资料，本节点不会检索知识。</p>}
  </fieldset>;
}

export function BuilderInspector({ state, workflow, selectedId, onChange, onDelete, disabled = false }: {
  state: ViewProps['state']; workflow: Workflow; selectedId: string | null; onChange: (next: Workflow) => void; onDelete: (id: string) => void; disabled?: boolean;
}) {
  const node = workflow.nodes.find(item => item.id === selectedId);
  const metadata = BUILDER_NODES.find(item => item.type === node?.type);
  const update = (changes: Partial<FlowNode>) => node && onChange({ ...workflow, nodes: workflow.nodes.map(item => item.id === node.id ? { ...item, ...changes } : item) });
  if (!node) return <div className="builder-inspector-content"><div className="builder-panel-title"><FileText size={17} /><h2>应用信息</h2></div><label className="builder-field">应用名称<input value={workflow.name} maxLength={100} disabled={disabled} onChange={event => onChange({ ...workflow, name: event.target.value })} /></label><label className="builder-field">应用说明<textarea value={workflow.description} maxLength={1000} rows={4} disabled={disabled} onChange={event => onChange({ ...workflow, description: event.target.value })} placeholder="说明应用解决的问题和适用场景" /></label><div className="builder-inline-note"><Info size={16} /><p>选择画布节点以编辑配置。</p></div></div>;
  const Icon = metadata?.icon ?? Bot;
  const outgoing = workflow.edges.map((edge, index) => ({ edge, index })).filter(({ edge }) => edge.from === node.id);
  const incoming = workflow.edges.filter(edge => edge.to === node.id).map(edge => workflow.nodes.find(item => item.id === edge.from)?.label ?? '未知节点');
  return <div className="builder-inspector-content" key={node.id}>
    <div className="builder-panel-title"><Icon size={18} /><h2>{metadata?.name}配置</h2></div>
    <label className="builder-field">节点名称<input value={node.label} maxLength={80} disabled={disabled} onChange={event => update({ label: event.target.value })} /></label>
    {node.type !== 'start' && <div className="builder-input-summary"><span>输入来自</span><p>{incoming.length ? incoming.join('、') : '尚未连接上游节点'}</p></div>}
    {node.type === 'start' && <><div className="builder-input-summary"><span>任务输入</span><code>query · 文本</code><p>用户填写的任务文本。</p></div><p className="builder-help">仅使用当前账号有权访问的客户资料，不自动修改商机。</p></>}
    {node.type === 'agent' && <><label className="builder-field">领域专家<select value={node.agentId ?? ''} disabled={disabled} onChange={event => update({ agentId: event.target.value as FlowNode['agentId'] })}><option value="" disabled>选择领域专家</option>{AGENTS.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label><label className="builder-field">提示词<textarea rows={9} maxLength={3000} value={node.instruction ?? ''} disabled={disabled} onChange={event => update({ instruction: event.target.value })} placeholder="定义本节点的目标、输出要求和业务边界。上游结果会一同传给专家。" /><small>{(node.instruction ?? '').length} / 3,000</small></label><div className="builder-inline-note"><Bot size={16} /><p>{state.model.connected ? `模型：${state.model.name}。使用当前账号已启用的 API 配置。` : '尚未启用大模型 API，试运行将使用已标明的规则演示。'}</p></div></>}
    {node.type === 'knowledge' && <KnowledgeSelection state={state} node={node} onChange={update} disabled={disabled} />}
    {node.type === 'intent' && <><p className="builder-help">{outgoing.some(({ edge }) => edge.condition !== undefined) ? '按首个识别意图选择路径。未匹配时走默认分支；请为每条路径设置条件，并保留一条默认路径。' : '当前未启用条件分流，沿现有连线继续。为每条路径选择条件后启用分流，并保留一条默认路径。'}</p>{outgoing.length ? outgoing.map(({ edge, index }) => <label className="builder-field" key={`${edge.from}-${edge.to}`}>前往 {workflow.nodes.find(item => item.id === edge.to)?.label}<select value={edge.condition ?? ''} disabled={disabled} onChange={event => onChange({ ...workflow, edges: workflow.edges.map((item, itemIndex) => itemIndex === index ? { ...item, condition: event.target.value ? event.target.value as 'default' | typeof AGENTS[number]['id'] : undefined } : item) })}><option value="">未设置条件</option>{AGENTS.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}<option value="default">默认路径（其他任务）</option></select></label>) : <div className="builder-inline-note"><GitBranch size={16} /><p>先连接下游节点，再为每条路径设置意图条件。</p></div>}</>}
    {node.type === 'review' && <div className="builder-inline-note"><ShieldCheck size={17} /><div><strong>销售管理者人工确认</strong><p>运行到此暂停，由管理者填写意见并确认或拒绝。AI 不会自动批准。</p></div></div>}
    {node.type === 'output' && <div className="builder-inline-note"><Check size={17} /><p>仅汇总已到达的上游结果；未命中分支和待审核结果不加入输出。</p></div>}
    <div className="builder-node-foot"><span>节点 ID · {node.id}</span><button type="button" className="builder-button builder-danger" disabled={disabled} onClick={() => onDelete(node.id)}><Trash2 size={14} />删除节点</button></div>
  </div>;
}
