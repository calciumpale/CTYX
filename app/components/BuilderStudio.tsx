'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Bot, Check, CheckCheck, ChevronDown, ChevronRight, CircleAlert, FileText, GitBranch, Info, LayoutGrid, Loader2, PanelLeftClose, PanelLeftOpen, Play, Plus, Redo2, Save, Search, ShieldCheck, Undo2, X } from 'lucide-react';
import { AGENTS, type AgentId, type ApiResult, type FlowNode, type NodeType, type Run, type TraceStep, type ViewProps, type Workflow } from '../lib/types';
import { WorkflowCanvas } from './WorkflowCanvas';
import { BUILDER_NODES, BuilderInspector, KnowledgeSelection } from './BuilderInspector';
import { BuilderDebugger } from './BuilderDebugger';
import { modelDisplayName } from './CoreViews';
import './builder-studio.css';

type Kind = 'agent' | 'workflow';
type Template = 'blank' | 'visit' | 'risk' | 'router';
type Guard = (proceed: () => void) => boolean;
type BuilderProps = ViewProps & { readOnly?: boolean; onGuardReady?: (guard: Guard | null) => void };
const copy = (workflow: Workflow): Workflow => structuredClone(workflow);
const fingerprint = (workflow: Workflow) => JSON.stringify({ kind: workflow.kind ?? 'workflow', name: workflow.name, description: workflow.description, nodes: workflow.nodes, edges: workflow.edges });
const dateLabel = (value: string) => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const templates: { id: Template; title: string; description: string; icon: typeof GitBranch }[] = [
  { id: 'blank', title: '从空白开始', description: '自行配置处理目标与执行路径', icon: Plus },
  { id: 'visit', title: '拜访准备', description: '客户洞察与拜访方案协作', icon: BookOpen },
  { id: 'risk', title: '商务风控', description: '核对授权边界，交由主管确认', icon: ShieldCheck },
  { id: 'router', title: '智能分流', description: '按用户任务选择专家路径', icon: GitBranch },
];

function createDraft(name: string, kind: Kind, template: Template): Workflow {
  const base = { id: '', name, kind, description: templates.find(item => item.id === template)?.description ?? '', status: 'draft' as const, version: 0, updatedAt: new Date().toISOString() };
  if (kind === 'agent') return { ...base, nodes: [
    { id: 'start', type: 'start', label: '接收任务', x: 80, y: 200 },
    { id: 'knowledge', type: 'knowledge', label: '检索生效知识', x: 400, y: 200 },
    { id: 'expert', type: 'agent', label: template === 'risk' ? '商务风控' : template === 'visit' ? '客户洞察' : '策略方案', agentId: template === 'risk' ? 'risk' : template === 'visit' ? 'insight' : 'strategy', instruction: template === 'risk' ? '逐项核对商务诉求、授权依据与待确认事项。未经人工审批不承诺任何条件。' : template === 'visit' ? '梳理客户已确认事实、需求、决策链和待核实问题，提出可执行的拜访问题。' : '围绕用户任务，结合已确认事实与生效资料，给出明确建议和下一步。', x: 720, y: 200 },
    { id: 'output', type: 'output', label: '返回任务结果', x: 1040, y: 200 },
  ], edges: [{ from: 'start', to: 'knowledge' }, { from: 'knowledge', to: 'expert' }, { from: 'expert', to: 'output' }] };
  if (template === 'visit') return { ...base, nodes: [
    { id: 'start', type: 'start', label: '接收拜访目标', x: 80, y: 200 }, { id: 'knowledge', type: 'knowledge', label: '检索生效知识', x: 400, y: 200 },
    { id: 'insight', type: 'agent', label: '客户洞察', agentId: 'insight', instruction: '梳理客户事实、决策链和待核实问题，清楚区分事实与假设。', x: 720, y: 200 },
    { id: 'strategy', type: 'agent', label: '策略方案', agentId: 'strategy', instruction: '结合上游客户洞察，整理30分钟拜访议程、提问清单与下一步。', x: 1040, y: 200 },
    { id: 'output', type: 'output', label: '输出拜访提纲', x: 1360, y: 200 },
  ], edges: [{ from: 'start', to: 'knowledge' }, { from: 'knowledge', to: 'insight' }, { from: 'insight', to: 'strategy' }, { from: 'strategy', to: 'output' }] };
  if (template === 'risk') return { ...base, nodes: [
    { id: 'start', type: 'start', label: '接收商务诉求', x: 80, y: 200 }, { id: 'knowledge', type: 'knowledge', label: '检索授权资料', x: 400, y: 200 },
    { id: 'risk', type: 'agent', label: '商务风控', agentId: 'risk', instruction: '核对商务诉求、优惠授权与合同责任边界，列出需经理确认的事项。', x: 720, y: 200 },
    { id: 'review', type: 'review', label: '经理人工确认', x: 1040, y: 200 }, { id: 'output', type: 'output', label: '输出确认结果', x: 1360, y: 200 },
  ], edges: [{ from: 'start', to: 'knowledge' }, { from: 'knowledge', to: 'risk' }, { from: 'risk', to: 'review' }, { from: 'review', to: 'output' }] };
  if (template === 'router') return { ...base, nodes: [
    { id: 'start', type: 'start', label: '接收用户任务', x: 80, y: 260 }, { id: 'intent', type: 'intent', label: '识别任务意图', x: 400, y: 260 },
    { id: 'insight', type: 'agent', label: '客户洞察', agentId: 'insight', instruction: '整理客户需求、决策链和待核实问题。', x: 730, y: 70 },
    { id: 'risk', type: 'agent', label: '商务风控', agentId: 'risk', instruction: '核对商务条件、授权边界和待确认事项。', x: 730, y: 260 },
    { id: 'strategy', type: 'agent', label: '策略方案', agentId: 'strategy', instruction: '给出有依据的行动方案，并明确下一步。', x: 730, y: 450 },
    { id: 'output', type: 'output', label: '返回处理结果', x: 1080, y: 260 },
  ], edges: [{ from: 'start', to: 'intent' }, { from: 'intent', to: 'insight', condition: 'insight' }, { from: 'intent', to: 'risk', condition: 'risk' }, { from: 'intent', to: 'strategy', condition: 'default' }, { from: 'insight', to: 'output' }, { from: 'risk', to: 'output' }, { from: 'strategy', to: 'output' }] };
  return { ...base, nodes: [{ id: 'start', type: 'start', label: '开始', x: 100, y: 220 }, { id: 'output', type: 'output', label: '结束', x: 780, y: 220 }], edges: [] };
}

/** Fast editor feedback. The server validates the full graph again before execution or publication. */
function graphIssues(workflow: Workflow): string[] {
  const issues: string[] = [];
  if (!workflow.name.trim()) issues.push('请填写应用名称。');
  const starts = workflow.nodes.filter(node => node.type === 'start');
  const outputs = workflow.nodes.filter(node => node.type === 'output');
  if (starts.length !== 1) issues.push('需要且只允许一个开始节点。');
  if (!outputs.length) issues.push('至少需要一个结束节点。');
  if (workflow.nodes.length > 30 || workflow.edges.length > 80) issues.push('最多支持30个节点和80条连接。');
  if (workflow.nodes.some(node => !node.label.trim())) issues.push('请为每个节点填写名称。');
  if (workflow.nodes.some(node => node.type === 'agent' && !node.agentId)) issues.push('请为领域专家节点选择专家角色。');
  for (const node of workflow.nodes) {
    if (node.type === 'start' && workflow.edges.some(edge => edge.to === node.id)) issues.push('开始节点不能有输入连接。');
    if (node.type === 'output' && workflow.edges.some(edge => edge.from === node.id)) issues.push('结束节点不能有输出连接。');
    if (node.type === 'intent') {
      const edges = workflow.edges.filter(edge => edge.from === node.id);
      const conditional = edges.some(edge => edge.condition !== undefined);
      if (conditional && edges.filter(edge => edge.condition === 'default').length !== 1) issues.push(`“${node.label}”需要一条默认路径。`);
      if (conditional && edges.some(edge => !edge.condition)) issues.push(`请配置“${node.label}”的全部分支条件。`);
      if (conditional && new Set(edges.map(edge => edge.condition)).size !== edges.length) issues.push(`“${node.label}”的分支条件不能重复。`);
    }
  }
  if (starts.length === 1) {
    const reachable = new Set<string>();
    const visit = (id: string) => { if (reachable.has(id)) return; reachable.add(id); workflow.edges.filter(edge => edge.from === id).forEach(edge => visit(edge.to)); };
    visit(starts[0].id);
    if (workflow.nodes.some(node => !reachable.has(node.id))) issues.push('请将全部节点连接到开始节点的处理路径。');
  }
  const reachesOutput = new Set(outputs.map(node => node.id));
  for (let i = 0; i < workflow.nodes.length; i++) workflow.edges.forEach(edge => { if (reachesOutput.has(edge.to)) reachesOutput.add(edge.from); });
  if (workflow.nodes.some(node => !reachesOutput.has(node.id))) issues.push('每条处理分支都需要连接到结束节点。');
  const seen = new Set<string>(), active = new Set<string>();
  let cycle = false;
  const walk = (id: string) => { if (active.has(id)) { cycle = true; return; } if (seen.has(id)) return; seen.add(id); active.add(id); workflow.edges.filter(edge => edge.from === id).forEach(edge => walk(edge.to)); active.delete(id); };
  workflow.nodes.forEach(node => walk(node.id));
  if (cycle) issues.push('连接中存在循环，请移除回连。');
  return [...new Set(issues)];
}

function CreateApplication({ initialTemplate, onClose, onCreate }: { initialTemplate: Template; onClose: () => void; onCreate: (name: string, kind: Kind, template: Template) => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Kind>('workflow');
  const [template, setTemplate] = useState<Template>(initialTemplate);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  const submit = (event: FormEvent) => { event.preventDefault(); if (name.trim()) onCreate(name.trim(), kind, template); };
  return <dialog ref={dialog} className="builder-create-dialog" onCancel={event => { event.preventDefault(); onClose(); }} aria-labelledby="builder-create-title"><form onSubmit={submit}><div className="builder-dialog-heading"><div><h2 id="builder-create-title">创建应用</h2></div><button type="button" className="builder-icon-button" onClick={onClose} aria-label="关闭创建应用"><X size={18} /></button></div><label className="builder-field">应用名称<input autoFocus required maxLength={100} value={name} onChange={event => setName(event.target.value)} placeholder="例如：客户拜访准备助手" /></label><fieldset className="builder-create-kind"><legend>应用类型</legend><label className={kind === 'agent' ? 'builder-choice-active' : ''}><input type="radio" name="application-kind" checked={kind === 'agent'} onChange={() => { setKind('agent'); if (template === 'router') setTemplate('blank'); }} /><Bot size={21} /><strong>Agent</strong><span>一个专家角色，结合知识完成任务</span></label><label className={kind === 'workflow' ? 'builder-choice-active' : ''}><input type="radio" name="application-kind" checked={kind === 'workflow'} onChange={() => setKind('workflow')} /><GitBranch size={21} /><strong>工作流</strong><span>连接多个节点，编排业务处理路径</span></label></fieldset><fieldset className="builder-create-templates"><legend>起步方式</legend>{templates.filter(item => kind === 'workflow' || item.id !== 'router').map(item => <label key={item.id} className={template === item.id ? 'builder-choice-active' : ''}><input type="radio" name="application-template" checked={template === item.id} onChange={() => setTemplate(item.id)} /><item.icon size={17} /><span><strong>{item.title}</strong><small>{item.description}</small></span>{template === item.id && <Check size={16} />}</label>)}</fieldset><div className="builder-dialog-footer"><button type="button" className="builder-button" onClick={onClose}>取消</button><button className="builder-button builder-primary" disabled={!name.trim()}>创建并配置<ArrowRight size={14} /></button></div></form></dialog>;
}

function ReviewRunDialog({ workflow, run, busy, error, onClose, onReview }: {
  workflow: Workflow; run: Run; busy: boolean; error: string; onClose: () => void; onReview: (decision: 'approve' | 'reject', note: string) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={dialog} className="builder-studio builder-review-dialog" aria-labelledby="builder-review-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="builder-review-dialog-header"><div><h2 id="builder-review-title">人工确认</h2><p>{workflow.name} · 此次审核仅处理已保存的运行，不改变应用草稿或线上版本。</p></div><button type="button" className="builder-icon-button" disabled={busy} onClick={onClose} aria-label="关闭人工确认"><X size={18} /></button></div>
    {error && <div className="builder-error" role="alert"><CircleAlert size={16} />{error}</div>}
    <BuilderDebugger reviewOnly workflow={workflow} run={run} stale={false} query="" onQuery={() => {}} onRun={async () => {}} onReview={onReview} busy={busy} canBuild={false} canReview connected={run.mode === 'live'} modelName="" />
  </dialog>;
}

function AgentConfiguration({ state, workflow, onChange, busy }: { state: ViewProps['state']; workflow: Workflow; onChange: (next: Workflow) => void; busy: boolean }) {
  const expert = workflow.nodes.find(node => node.type === 'agent');
  const knowledge = workflow.nodes.find(node => node.type === 'knowledge');
  const updateNode = (node: FlowNode, changes: Partial<FlowNode>) => onChange({ ...workflow, nodes: workflow.nodes.map(item => item.id === node.id ? { ...item, ...changes } : item) });
  return <div className="builder-agent-form"><div className="builder-agent-intro"><span className="builder-application-icon"><Bot size={24} /></span><div><h2>Agent 配置</h2></div></div><label className="builder-field">应用说明<textarea rows={2} value={workflow.description} disabled={busy} maxLength={1000} onChange={event => onChange({ ...workflow, description: event.target.value })} placeholder="这个 Agent 适合处理什么任务？" /></label>{expert ? <><label className="builder-field">专家角色<select value={expert.agentId ?? ''} disabled={busy} onChange={event => updateNode(expert, { agentId: event.target.value as AgentId, label: AGENTS.find(item => item.id === event.target.value)?.name ?? expert.label })}>{AGENTS.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label><label className="builder-field">提示词<textarea className="builder-agent-prompt" rows={10} value={expert.instruction ?? ''} disabled={busy} maxLength={3000} onChange={event => updateNode(expert, { instruction: event.target.value })} placeholder="写下专家的任务目标、工作步骤、输出格式和业务边界。" /><small>运行时自动加入用户任务、授权客户信息与检索结果。</small></label></> : <p className="builder-help">当前 Agent 缺少专家节点，请重新创建或改用工作流配置。</p>}<section className="builder-agent-model"><span className="builder-application-icon builder-small-icon"><Bot size={17} /></span><div><strong>当前工作空间模型</strong><p>{state.model.connected ? modelDisplayName(state.model.name) : '未配置模型'}</p></div><span className="builder-badge">{state.model.connected ? '已配置' : '本地生成'}</span></section>{knowledge && <KnowledgeSelection state={state} node={knowledge} onChange={changes => updateNode(knowledge, changes)} disabled={busy} />}</div>;
}

export function BuilderStudio({ state, mutate, notify, onGuardReady, readOnly = false }: BuilderProps) {
  const canBuild = !readOnly && state.role === 'manager';
  const canReview = state.role === 'manager';
  const [draft, setDraft] = useState<Workflow | null>(null);
  const [baseline, setBaseline] = useState<Workflow | null>(null);
  const [past, setPast] = useState<Workflow[]>([]);
  const [future, setFuture] = useState<Workflow[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [panel, setPanel] = useState<'config' | 'debug'>('config');
  const [paletteOpen, setPaletteOpen] = useState(true);
  const [mobilePaletteOpen, setMobilePaletteOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<'all' | Kind>('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [createTemplate, setCreateTemplate] = useState<Template | null>(null);
  const [query, setQuery] = useState('');
  const [tested, setTested] = useState<{ fingerprint: string; run: Run } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showPublish, setShowPublish] = useState(false);
  const [leavePrompt, setLeavePrompt] = useState(false);
  const [reviewRun, setReviewRun] = useState<Run | null>(null);
  const continuation = useRef<(() => void) | null>(null);
  const running = useRef(false);
  const editTime = useRef(0);
  const dirty = Boolean(draft && (!baseline || fingerprint(draft) !== fingerprint(baseline)));
  const current = state.workflows.find(item => item.id === draft?.id);
  const isAgent = draft?.kind === 'agent';
  const stale = Boolean(draft && tested && fingerprint(draft) !== tested.fingerprint);
  const issues = useMemo(() => draft ? graphIssues(draft) : [], [draft]);
  const available = canBuild ? state.workflows : state.workflows.flatMap<Workflow>(item => {
    if (item.published) return [{ id: item.id, ...structuredClone(item.published), status: 'published' as const, updatedAt: item.published.publishedAt }];
    return item.status === 'published' ? [item] : [];
  });
  const pendingReviews = canReview ? state.runs.filter(item => item.status === 'paused' && Boolean(item.awaitingNodeId) && (canBuild || item.workflowSource === 'published')) : [];
  const applications = available.filter(item => (kindFilter === 'all' || (item.kind ?? 'workflow') === kindFilter) && (statusFilter === 'all' || item.status === statusFilter) && `${item.name} ${item.description}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));

  const guard = useCallback((proceed: () => void) => {
    if (running.current) { setError('当前操作正在处理，请完成后再离开。'); return false; }
    if (dirty) { continuation.current = proceed; setLeavePrompt(true); return false; }
    return true;
  }, [dirty]);
  useEffect(() => { onGuardReady?.(guard); return () => onGuardReady?.(null); }, [guard, onGuardReady]);
  useEffect(() => { if (!dirty && !busy) return; const beforeLeave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', beforeLeave); return () => window.removeEventListener('beforeunload', beforeLeave); }, [dirty, busy]);
  const leave = (action: () => void) => { if (guard(action)) action(); };
  const discard = () => { const action = continuation.current; continuation.current = null; setLeavePrompt(false); setDraft(baseline ? copy(baseline) : null); setPast([]); setFuture([]); action?.(); };
  const openApplication = (application: Workflow) => { setDraft(copy(application)); setBaseline(copy(application)); setPast([]); setFuture([]); setSelectedNodeId(null); setQuery(''); setTested(null); setShowPublish(false); setError(''); setPanel(canBuild ? 'config' : 'debug'); };
  const toList = () => { setDraft(null); setBaseline(null); setPast([]); setFuture([]); setTested(null); setShowPublish(false); setError(''); };
  const change = useCallback((next: Workflow) => {
    if (!canBuild || running.current || !draft || fingerprint(next) === fingerprint(draft)) return;
    const now = Date.now();
    if (now - editTime.current > 450) setPast(items => [...items.slice(-39), copy(draft)]);
    editTime.current = now;
    setFuture([]); setDraft(next); setShowPublish(false); setError('');
  }, [draft, canBuild]);
  const undo = () => { if (!canBuild || !draft || !past.length || running.current) return; const previous = past[past.length - 1]; setPast(past.slice(0, -1)); setFuture(items => [...items, copy(draft)]); setDraft(copy(previous)); editTime.current = 0; setShowPublish(false); };
  const redo = () => { if (!canBuild || !draft || !future.length || running.current) return; const next = future[future.length - 1]; setFuture(future.slice(0, -1)); setPast(items => [...items, copy(draft)]); setDraft(copy(next)); editTime.current = 0; setShowPublish(false); };
  const perform = async (action: string, payload: Record<string, unknown>): Promise<ApiResult | null> => {
    if (running.current) return null;
    running.current = true; setBusy(true); setError('');
    try { return await mutate(action, payload); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '操作未完成，请重试。'); return null; }
    finally { running.current = false; setBusy(false); }
  };
  const save = async () => {
    if (!canBuild) return;
    if (!draft || !draft.name.trim()) { setError('请填写应用名称。'); return; }
    const result = await perform('workflow_save', { workflow: { ...draft, name: draft.name.trim() } });
    if (!result) return;
    const saved = result.state.workflows.find(item => draft.id ? item.id === draft.id : !state.workflows.some(old => old.id === item.id));
    if (saved) { setDraft(copy(saved)); setBaseline(copy(saved)); setPast([]); setFuture([]); editTime.current = 0; }
    notify('草稿已保存，线上版本保持可用。');
  };
  const run = async () => {
    if (!draft || !query.trim()) return;
    if (canBuild && issues.length) { setError(issues[0]); setShowPublish(false); return; }
    const testedFingerprint = fingerprint(draft);
    const result = await perform('workflow_run', canBuild ? { mode: 'draft', workflow: draft, query: query.trim(), ...(current ? { workflowId: current.id } : {}) } : { mode: 'published', workflowId: draft.id, query: query.trim() });
    if (result?.run) { setTested({ fingerprint: testedFingerprint, run: result.run }); notify(result.run.status === 'paused' ? '运行已暂停，等待人工确认。' : result.run.status === 'failed' ? '运行失败，请查看执行过程。' : '运行结果已保存。'); }
  };
  const review = async (decision: 'approve' | 'reject', note: string) => {
    if (!canReview || !tested || (!canBuild && tested.run.workflowSource !== 'published')) return;
    const result = await perform('workflow_review', { runId: tested.run.id, decision, note });
    if (result?.run) { setTested({ ...tested, run: result.run }); notify(decision === 'reject' ? '已拒绝本次运行。' : result.run.status === 'paused' ? '已确认，运行暂停在下一处人工确认。' : '已确认并继续执行。'); }
  };
  const reviewSavedRun = async (decision: 'approve' | 'reject', note: string) => {
    if (!canReview || !reviewRun || (!canBuild && reviewRun.workflowSource !== 'published')) return;
    const result = await perform('workflow_review', { runId: reviewRun.id, decision, note });
    if (result?.run) { setReviewRun(result.run); notify(result.run.status === 'paused' ? '已确认，运行暂停在下一处人工确认。' : decision === 'reject' ? '已拒绝本次运行，后续节点不会执行。' : '已确认并完成后续处理。'); }
  };
  const publish = async () => {
    if (!canBuild || !draft || !current || dirty || issues.length || !tested || stale || tested.run.status !== 'completed') return;
    const result = await perform('workflow_publish', { workflowId: current.id, version: current.version, runId: tested.run.id });
    if (result) { const published = result.state.workflows.find(item => item.id === current.id); if (published) { setDraft(copy(published)); setBaseline(copy(published)); } setShowPublish(false); notify('已发布，销售人员现在可以运行这个版本。'); }
  };
  const addNode = (type: NodeType, position?: { x: number; y: number }) => {
    if (!draft || !canBuild || running.current) return;
    if (draft.nodes.length >= 30) { setError('工作流最多支持30个节点。'); return; }
    if (type === 'start' && draft.nodes.some(node => node.type === 'start')) { setError('工作流只能有一个开始节点。'); return; }
    const metadata = BUILDER_NODES.find(item => item.type === type);
    const node: FlowNode = { id: `node-${crypto.randomUUID().slice(0, 8)}`, type, label: metadata?.name ?? '节点', ...(position ?? { x: 400 + Math.floor(draft.nodes.length / 3) * 300, y: 80 + (draft.nodes.length % 3) * 170 }), ...(type === 'agent' ? { agentId: 'strategy' as const } : {}) };
    editTime.current = 0; change({ ...draft, nodes: [...draft.nodes, node] }); setSelectedNodeId(node.id); setPanel('config');
  };
  const create = (name: string, kind: Kind, template: Template) => { if (!canBuild) return; const workflow = createDraft(name, kind, template); setDraft(workflow); setBaseline(null); setPast([]); setFuture([]); setSelectedNodeId(null); setTested(null); setQuery(''); setPanel('config'); setCreateTemplate(null); setShowPublish(false); setError(''); editTime.current = 0; };
  const statuses = useMemo(() => {
    const mapped: Record<string, TraceStep['status']> = {};
    if (tested && !stale) for (const step of tested.run.steps) if (step.nodeId) mapped[step.nodeId] = step.status;
    return mapped;
  }, [tested, stale]);
  const debug = draft && <BuilderDebugger workflow={draft} run={tested?.run ?? null} stale={stale} query={query} onQuery={setQuery} onRun={run} onReview={review} onSelectNode={canBuild ? id => { setSelectedNodeId(id); } : undefined} busy={busy} canBuild={canBuild} canReview={canReview} connected={state.model.connected} modelName={modelDisplayName(state.model.name)} />;
  const leaveNotice = leavePrompt && <div className="builder-leave-confirm" role="alert"><CircleAlert size={18} /><div><strong>当前有未保存的更改</strong><p>离开会放弃本次修改，已保存的草稿和线上版本会保留。</p></div><button type="button" className="builder-button" onClick={() => { continuation.current = null; setLeavePrompt(false); }}>继续编辑</button><button type="button" className="builder-button builder-danger" onClick={discard}>放弃更改并离开</button></div>;
  const reviewWorkflow = reviewRun && state.workflows.find(item => item.id === reviewRun.workflowId);
  const reviewDialog = canReview && reviewRun && <ReviewRunDialog workflow={reviewWorkflow ?? { id: reviewRun.workflowId ?? '', name: '已保存工作流运行', description: '', status: 'draft', version: reviewRun.workflowVersion ?? 0, updatedAt: reviewRun.createdAt, nodes: [], edges: [] }} run={reviewRun} busy={busy} error={error} onClose={() => { if (running.current) { setError('审核正在处理，请完成后关闭。'); return; } setReviewRun(null); setError(''); }} onReview={reviewSavedRun} />;

  if (!draft) return <section className="builder-studio builder-library">
    <header className="builder-library-header"><div><h1>{canBuild ? '搭建中心' : '团队应用'}</h1></div>{canBuild && <button className="builder-button builder-primary" onClick={() => setCreateTemplate('blank')}><Plus size={16} />创建应用</button>}</header>
    {leaveNotice}{error && <div className="builder-error" role="alert"><CircleAlert size={16} />{error}</div>}
    <div className="builder-library-tools"><div className="builder-type-tabs" role="tablist" aria-label="应用类型">{([{ id: 'all', title: '全部应用', icon: LayoutGrid }, { id: 'agent', title: 'Agent', icon: Bot }, { id: 'workflow', title: '工作流', icon: GitBranch }] as const).map(item => <button key={item.id} role="tab" aria-selected={kindFilter === item.id} className={kindFilter === item.id ? 'builder-tab-active' : ''} onClick={() => setKindFilter(item.id)}><item.icon size={15} />{item.title}</button>)}</div><div className="builder-library-filters"><label className="builder-search"><Search size={15} /><input aria-label="搜索应用" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索应用名称或说明" />{search && <button className="builder-icon-button" onClick={() => setSearch('')} aria-label="清空搜索"><X size={13} /></button>}</label>{canBuild && <label><span className="builder-sr-only">筛选应用状态</span><select value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="all">全部状态</option><option value="draft">草稿</option><option value="published">已发布</option></select></label>}</div></div>
    {canReview && pendingReviews.length > 0 && <section className="builder-pending-reviews"><div className="builder-pending-heading"><ShieldCheck size={17} /><h2>待人工确认</h2><span>{pendingReviews.length}</span></div><div className="builder-pending-list">{pendingReviews.map(item => <button type="button" key={item.id} onClick={() => { setError(''); setReviewRun(item); }}><span className="builder-pending-icon"><ShieldCheck size={16} /></span><span><strong>{item.query}</strong><small>{state.workflows.find(application => application.id === item.workflowId)?.name ?? '工作流运行'} · {dateLabel(item.createdAt)}</small></span><span>查看并审核<ChevronRight size={14} /></span></button>)}</div></section>}
    <div className="builder-application-list">{applications.map(application => {
      const agent = application.kind === 'agent';
      const published = application.published;
      const draftChanged = published && fingerprint(application) !== fingerprint({ ...application, ...published });
      return <button type="button" className="builder-application-row" key={application.id} onClick={() => leave(() => openApplication(application))}>
        <span className="builder-application-icon builder-small-icon">{agent ? <Bot size={18} /> : <GitBranch size={18} />}</span>
        <span className="builder-application-copy"><strong>{application.name}</strong>{application.description && <span>{application.description}</span>}</span>
        <span className="builder-application-kind">{agent ? 'Agent' : `${application.nodes.length} 节点`}</span>
        <span className="builder-application-state"><span className="builder-badge">{application.status === 'published' ? '已发布' : '草稿'}</span>{canBuild && draftChanged && <span className="builder-draft-label">未发布更改</span>}</span>
        <span className="builder-application-version">{published ? `线上 v${published.version}${canBuild ? ` · 草稿 v${application.version}` : ''}` : `v${application.version}`}</span>
        <span className="builder-application-date">{dateLabel(application.updatedAt)}</span><ChevronRight size={15} />
      </button>;
    })}</div>
    {!applications.length && <div className="builder-list-empty"><Search size={29} /><h2>{search || kindFilter !== 'all' || statusFilter !== 'all' ? '没有匹配的应用' : canBuild ? '暂无应用' : '团队还没有发布应用'}</h2><p>{search ? '换一个关键词，或调整筛选条件。' : canBuild ? '创建 Agent 完成单项任务，或用工作流连接多个专家。' : '管理员发布后，可在这里选择应用并发起任务。'}</p>{canBuild && !search && <button className="builder-button builder-secondary" onClick={() => setCreateTemplate('blank')}><Plus size={15} />创建第一个应用</button>}</div>}
    {canBuild && !search && <details className="builder-template-section"><summary>业务模板<ChevronDown size={15} /></summary><div className="builder-template-grid">{templates.filter(item => item.id !== 'blank').map(item => <button key={item.id} onClick={() => setCreateTemplate(item.id)}><item.icon size={20} /><span><strong>{item.title}</strong><small>{item.description}</small></span><ArrowRight size={15} /></button>)}</div></details>}
    {canBuild && createTemplate && <CreateApplication initialTemplate={createTemplate} onClose={() => setCreateTemplate(null)} onCreate={create} />}
    {reviewDialog}
  </section>;

  const testedCurrent = tested && !stale && tested.run.status === 'completed';
  const publishedVersion = current?.published?.version ?? (current?.status === 'published' ? current.version : undefined);
  return <section className={`builder-studio builder-editor${isAgent ? ' builder-agent-editor' : ''}${!canBuild ? ' builder-sales-runner' : ''}`}>
    <header className="builder-editor-header"><div className="builder-editor-heading"><button type="button" className="builder-icon-button builder-back" onClick={() => leave(toList)} aria-label="返回应用列表"><ArrowLeft size={19} /></button><span className="builder-application-icon builder-small-icon">{isAgent ? <Bot size={18} /> : <GitBranch size={18} />}</span><div className="builder-editor-name">{canBuild ? <input aria-label="应用名称" value={draft.name} maxLength={100} disabled={busy} onChange={event => change({ ...draft, name: event.target.value })} /> : <h1>{draft.name}</h1>}<span>{canBuild ? `${dirty ? '有未保存更改' : '草稿已保存'}${publishedVersion ? ` · 线上 v${publishedVersion}` : ' · 未发布'}` : `已发布 · v${publishedVersion ?? draft.version}`}</span></div></div><div className="builder-editor-actions">{canBuild && <><div className="builder-history-actions"><button className="builder-icon-button" disabled={!past.length || busy} onClick={undo} aria-label="撤销" title="撤销"><Undo2 size={16} /></button><button className="builder-icon-button" disabled={!future.length || busy} onClick={redo} aria-label="重做" title="重做"><Redo2 size={16} /></button></div><button className="builder-button builder-secondary" disabled={!dirty || busy} onClick={() => void save()}>{busy ? <Loader2 size={14} className="builder-spin" /> : <Save size={14} />}保存</button><button className={`builder-button${panel === 'debug' ? ' builder-secondary' : ''}`} onClick={() => setPanel('debug')}><Play size={14} />试运行</button><button className="builder-button builder-primary" disabled={busy} onClick={() => setShowPublish(value => !value)}><CheckCheck size={14} />发布</button></>}</div></header>
    {leaveNotice}{error && <div className="builder-error" role="alert"><CircleAlert size={16} /><span>{error}</span><button className="builder-icon-button" onClick={() => setError('')} aria-label="关闭错误"><X size={14} /></button></div>}
    {showPublish && canBuild && <section className="builder-publish-panel"><div><h2>发布检查</h2><p>发布后团队使用此版本。</p></div><ul><li className={!dirty && current ? 'builder-check-pass' : ''}>{!dirty && current ? <Check size={14} /> : <CircleAlert size={14} />}已保存当前配置</li><li className={!issues.length ? 'builder-check-pass' : ''}>{!issues.length ? <Check size={14} /> : <CircleAlert size={14} />}{issues.length ? issues[0] : '节点和连接结构有效'}</li><li className={testedCurrent ? 'builder-check-pass' : ''}>{testedCurrent ? <Check size={14} /> : <CircleAlert size={14} />}{testedCurrent ? '当前配置试运行完成' : tested?.run.status === 'paused' && !stale ? '试运行等待人工确认，请先完成审核' : '当前配置尚未完成试运行'}</li></ul><div className="builder-publish-actions"><button className="builder-button" onClick={() => setShowPublish(false)}>收起</button><button className="builder-button builder-primary" disabled={dirty || !current || issues.length > 0 || !testedCurrent || busy} onClick={() => void publish()}>确认发布<ArrowRight size={14} /></button></div></section>}
    {!canBuild ? <div className="builder-sales-layout"><aside className="builder-sales-about"><span className="builder-application-icon">{isAgent ? <Bot size={25} /> : <GitBranch size={25} />}</span><h2>{draft.name}</h2><p>{draft.description || '根据任务输入，使用团队已发布的处理方式。'}</p><div className="builder-input-summary"><span>应用版本</span><strong>v{publishedVersion ?? draft.version}</strong></div><div className="builder-input-summary"><span>处理方式</span><strong>{isAgent ? '领域专家 Agent' : `${draft.nodes.length} 个业务节点`}</strong></div></aside><main className="builder-sales-debug">{debug}</main></div> : isAgent ? <div className="builder-agent-layout"><div className="builder-agent-config"><div className="builder-agent-tabs" role="tablist" aria-label="Agent 编辑区域"><button role="tab" aria-selected={panel === 'config'} className={panel === 'config' ? 'builder-tab-active' : ''} onClick={() => setPanel('config')}><FileText size={15} />配置</button><button role="tab" aria-selected={panel === 'debug'} className={panel === 'debug' ? 'builder-tab-active' : ''} onClick={() => setPanel('debug')}><Play size={15} />预览与调试</button></div><div className={`builder-agent-config-body${panel === 'debug' ? ' builder-agent-config-mobile-hidden' : ''}`}><AgentConfiguration state={state} workflow={draft} onChange={change} busy={busy} /></div></div><aside className={`builder-agent-debug${panel === 'config' ? ' builder-agent-debug-mobile-hidden' : ''}`}><div className="builder-panel-heading"><h2>预览与调试</h2><span>当前配置</span></div>{debug}</aside></div> : <div className={`builder-workspace${paletteOpen ? '' : ' builder-palette-collapsed'}${mobilePaletteOpen ? ' builder-palette-mobile-open' : ''}`}>
      <aside className={`builder-palette${paletteOpen ? ' builder-palette-open' : ''}`}><div className="builder-panel-heading"><h2>节点库</h2><button className="builder-icon-button" onClick={() => { setPaletteOpen(false); setMobilePaletteOpen(false); }} aria-label="收起节点库"><PanelLeftClose size={15} /></button></div><button className="builder-basic-settings" onClick={() => { setSelectedNodeId(null); setPanel('config'); }}><FileText size={16} /><span>应用信息</span></button><p className="builder-palette-description">点击添加，或拖入画布</p><div className="builder-palette-nodes">{BUILDER_NODES.map(item => <button key={item.type} type="button" title={item.detail} draggable={!busy} disabled={busy || item.type === 'start' && draft.nodes.some(node => node.type === 'start')} onDragStart={event => { event.dataTransfer.setData('application/x-ctai-node-type', item.type); event.dataTransfer.effectAllowed = 'copy'; }} onClick={() => addNode(item.type)}><span><item.icon size={17} /></span><div><strong>{item.name}</strong></div><Plus size={13} /></button>)}</div><details className="builder-palette-tip"><summary><Info size={14} />画布操作</summary><p>点击输出端口，再选输入端口以连接。选中连线后可删除；自动整理保留已有连接。</p></details></aside>
      <main className="builder-canvas-area"><div className="builder-canvas-topline"><button className="builder-icon-button" onClick={() => { if (window.matchMedia('(max-width: 1000px)').matches) setMobilePaletteOpen(value => !value); else setPaletteOpen(value => !value); }} aria-label={paletteOpen ? '收起节点库' : '展开节点库'}>{paletteOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}</button><span>工作流画布</span><span className="builder-canvas-count">{draft.nodes.length} 节点 · {draft.edges.length} 连线</span>{issues.length > 0 && <span className="builder-canvas-validation"><CircleAlert size={12} />待完善</span>}</div><WorkflowCanvas workflow={draft} readOnly={busy} selectedNodeId={selectedNodeId} onSelectNode={id => { setSelectedNodeId(id); if (id) setPanel('config'); }} onChange={change} statuses={statuses} onAddNode={addNode} /></main>
      <aside className="builder-sidebar"><div className="builder-side-tabs" role="tablist" aria-label="配置与调试"><button role="tab" aria-selected={panel === 'config'} className={panel === 'config' ? 'builder-tab-active' : ''} onClick={() => setPanel('config')}><FileText size={14} />节点配置</button><button role="tab" aria-selected={panel === 'debug'} className={panel === 'debug' ? 'builder-tab-active' : ''} onClick={() => setPanel('debug')}><Play size={14} />试运行{tested && <span className={`builder-test-dot${testedCurrent ? ' builder-test-complete' : ''}`} />}</button></div><div className="builder-sidebar-body">{panel === 'debug' ? debug : <BuilderInspector state={state} workflow={draft} selectedId={selectedNodeId} disabled={busy} onChange={change} onDelete={id => { editTime.current = 0; change({ ...draft, nodes: draft.nodes.filter(node => node.id !== id), edges: draft.edges.filter(edge => edge.from !== id && edge.to !== id) }); setSelectedNodeId(null); }} />}</div></aside>
    </div>}
    {reviewDialog}
  </section>;
}
