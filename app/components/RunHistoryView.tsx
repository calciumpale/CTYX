'use client';

import { useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { AlertCircle, ArrowLeft, BookOpen, Check, CheckCircle2, ChevronRight, Copy, FileText, GitBranch, History, Info, Loader2, MessageSquare, PauseCircle, Search, Sparkles, X, XCircle } from 'lucide-react';
import { AnswerContent } from './AnswerContent';
import { AGENTS, type Run, type TraceStep, type ViewProps } from '../lib/types';
import { filterRuns, groupRunsByDate, runAnswerForDisplay, runGenerationLabel, runStatus, type RunFilters, type RunStatus } from '../lib/run-history';
import './answer-content.css';
import './run-history.css';

const dateLabel = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const timeLabel = (value: string) => new Date(value).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });
const durationLabel = (duration: number) => duration < 1000 ? `${Math.round(duration)} ms` : `${(duration / 1000).toFixed(1)} s`;
const agentName = (id: string) => AGENTS.find(agent => agent.id === id)?.name ?? id;
const statusLabels: Record<RunStatus, string> = { completed: '已完成', paused: '待确认', failed: '执行失败', rejected: '已拒绝' };
const stepLabels: Record<TraceStep['status'], string> = { success: '完成', warning: '需关注', error: '失败', skipped: '已跳过' };
const tabs = [{ id: 'result', label: '任务结果' }, { id: 'process', label: '执行过程' }, { id: 'citations', label: '引用依据' }] as const;
type DetailTab = typeof tabs[number]['id'];

function StatusLabel({ status }: { status: RunStatus }) {
  const Icon = status === 'completed' ? CheckCircle2 : status === 'paused' ? PauseCircle : status === 'failed' ? AlertCircle : XCircle;
  return <span className={`run-history-status run-history-status-${status}`}><Icon size={14} aria-hidden="true" />{statusLabels[status]}</span>;
}

function Empty({ filtered, onClear }: { filtered: boolean; onClear: () => void }) {
  return <div className="run-history-empty">
    {filtered ? <Search size={28} aria-hidden="true" /> : <History size={28} aria-hidden="true" />}
    <h2>{filtered ? '没有找到匹配的运行记录' : '还没有运行记录'}</h2>
    <p>{filtered ? '清除筛选查看全部记录。' : '运行任务后，结果会保存在这里。'}</p>
    {filtered && <button type="button" className="studio-btn studio-btn-secondary" onClick={onClear}>清除筛选</button>}
  </div>;
}

function StepDetail({ step, index }: { step: TraceStep; index: number }) {
  return <li className={`run-history-step run-history-step-${step.status}`}>
    <span className="run-history-step-mark" aria-hidden="true">{step.status === 'success' ? <Check size={14} /> : step.status === 'error' ? <X size={14} /> : step.status === 'warning' ? <Info size={14} /> : <ChevronRight size={14} />}</span>
    <div className="run-history-step-body">
      <div className="run-history-step-heading"><h3>{index + 1}. {step.title}</h3><span>{stepLabels[step.status]}</span><small>{durationLabel(step.duration)}</small></div>
      {step.agent && <span className="run-history-step-agent">{agentName(step.agent)}</span>}
      <p>{step.detail}</p>
      {(step.input !== undefined || step.output !== undefined || step.nodeId) && <details className="run-history-step-data">
        <summary>查看输入与输出</summary>
        {step.nodeId && <p className="run-history-node-id">节点编号：{step.nodeId}</p>}
        {step.input !== undefined && <div><h4>输入</h4><pre>{step.input || '无输入内容'}</pre></div>}
        {step.output !== undefined && <div><h4>输出</h4><pre>{step.output || '无输出内容'}</pre></div>}
      </details>}
    </div>
  </li>;
}

function RecordDetail({ run, existingCandidate, busy, extractionPending, error, onBack, onCopy, onExtract, headingRef, canExtract }: {
  canExtract: boolean;
  run: Run;
  existingCandidate: boolean;
  busy: boolean;
  extractionPending: boolean;
  error: string;
  onBack: () => void;
  onCopy: () => void;
  onExtract: () => void;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const [tab, setTab] = useState<DetailTab>('result');
  const prefix = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const status = runStatus(run);
  const changeTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    setTab(tabs[next].id);
    tabRefs.current[next]?.focus();
  };
  const tabPanel = (id: DetailTab, children: ReactNode) => <section key={id} id={`${prefix}-panel-${id}`} className="run-history-tabpanel" role="tabpanel" aria-labelledby={`${prefix}-tab-${id}`} hidden={tab !== id} tabIndex={0}>{children}</section>;

  return <article className="run-history-detail" aria-labelledby={`${prefix}-title`}>
    <button type="button" className="run-history-back" onClick={onBack}><ArrowLeft size={17} aria-hidden="true" />返回记录</button>
    <header className="run-history-detail-heading">
      <h2 id={`${prefix}-title`} ref={headingRef} tabIndex={-1}>{run.query}</h2>
      <div className="run-history-meta"><StatusLabel status={status} /><time dateTime={run.createdAt}>{dateLabel(run.createdAt)}</time><span>耗时 {durationLabel(run.duration)}</span></div>
      <p className="run-history-experts">{run.workflowId ? <GitBranch size={14} aria-hidden="true" /> : <MessageSquare size={14} aria-hidden="true" />}<span>{run.workflowId ? '工作流' : '专家协作'}{run.agentIds.length > 0 && ` · ${run.agentIds.map(agentName).join('、')}`}</span></p>
      <div className="run-history-actions">
        <button type="button" className="studio-btn studio-btn-secondary" onClick={onCopy} disabled={!run.answer.trim()}><Copy size={15} aria-hidden="true" />复制结果</button>
        {canExtract && <button type="button" className="studio-btn studio-btn-ghost" onClick={onExtract} disabled={extractionPending || existingCandidate} title="保存为候选草稿，由管理者审核后发布">{busy ? <Loader2 size={15} className="studio-spin" aria-hidden="true" /> : existingCandidate ? <Check size={15} aria-hidden="true" /> : <Sparkles size={15} aria-hidden="true" />}{busy ? '正在提炼…' : existingCandidate ? '已提炼为候选 Skill' : '提炼为候选 Skill'}</button>}
      </div>
      {error && <p className="run-history-feedback" role="alert"><AlertCircle size={16} aria-hidden="true" /><span>{error} 请重试提炼。</span></p>}
    </header>
    <div className="run-history-tabs" role="tablist" aria-label="运行详情">
      {tabs.map((item, index) => <button type="button" key={item.id} ref={element => { tabRefs.current[index] = element; }} role="tab" id={`${prefix}-tab-${item.id}`} aria-controls={`${prefix}-panel-${item.id}`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)} onKeyDown={event => changeTab(event, index)}>{item.label}{item.id !== 'result' && <span>{item.id === 'process' ? run.steps.length : run.citations.length}</span>}</button>)}
    </div>
    {tabPanel('result', <>
      {status !== 'completed' && <div className="run-history-result-notice"><Info size={16} aria-hidden="true" /><div><p>{status === 'paused' ? '本次运行正在等待人工确认。' : status === 'rejected' ? '本次运行已被拒绝继续。' : '本次运行未完成，已有输出保留如下。'}</p><button type="button" onClick={() => { setTab('process'); tabRefs.current[1]?.focus(); }}>查看执行过程<ChevronRight size={13} aria-hidden="true" /></button></div></div>}
      {run.answer.trim() ? <AnswerContent text={runAnswerForDisplay(run.answer)} /> : <p className="run-history-no-content">本次运行尚未生成任务结果。</p>}
    </>)}
    {tabPanel('process', <>
      {run.steps.length ? <ol className="run-history-steps">{run.steps.map((step, index) => <StepDetail key={step.id} step={step} index={index} />)}</ol> : <p className="run-history-no-content">本次运行没有保存执行步骤。</p>}
      {run.review && <section className="run-history-review"><h3>人工确认记录</h3><p>{run.review.reviewer} · {run.review.decision === 'approve' ? '已批准继续' : '已拒绝继续'} · {dateLabel(run.review.date)}</p><p>{run.review.note}</p></section>}
    </>)}
    {tabPanel('citations', <>
      {run.citations.length ? <ol className="run-history-citations">{run.citations.map((citation, index) => <li key={citation.id}><h3><FileText size={16} aria-hidden="true" /><span>{index + 1}. {citation.title}</span></h3><p>{citation.excerpt}</p><small>引用编号：{citation.id}</small></li>)}</ol> : <div className="run-history-no-citations"><BookOpen size={24} aria-hidden="true" /><h3>本次运行未引用知识条目</h3><p>可以结合执行过程核对结论依据。</p></div>}
    </>)}
    <details className="run-history-technical"><summary>运行信息</summary><dl>
      <div><dt>运行编号</dt><dd>{run.id}</dd></div>
      <div><dt>生成方式</dt><dd>{runGenerationLabel(run)}</dd></div>
      <div><dt>任务来源</dt><dd>{run.workflowId ? '工作流' : '专家协作'}</dd></div>
      {run.workflowId && <div><dt>工作流编号</dt><dd>{run.workflowId}</dd></div>}
      {run.workflowVersion !== undefined && <div><dt>工作流版本</dt><dd>v{run.workflowVersion}{run.workflowSource && ` · ${run.workflowSource === 'published' ? '已发布' : '草稿'}`}</dd></div>}
      {run.awaitingNodeId && <div><dt>待确认节点</dt><dd>{run.awaitingNodeId}</dd></div>}
      {run.dealId && <div><dt>关联商机编号</dt><dd>{run.dealId}</dd></div>}
    </dl></details>
  </article>;
}

export function RunsView({ state, mutate, notify, canExtract = true }: ViewProps & {canExtract?:boolean}) {
  const [filters, setFilters] = useState<RunFilters>({ search: '', status: 'all', source: 'all' });
  const [selectedId, setSelectedId] = useState('');
  const [mobileDetail, setMobileDetail] = useState(false);
  const [extractingId, setExtractingId] = useState('');
  const [extractedIds, setExtractedIds] = useState<string[]>([]);
  const [error, setError] = useState({ runId: '', message: '' });
  const mutationRunning = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listButtons = useRef(new Map<string, HTMLButtonElement>());
  const runs = filterRuns(state.runs, filters);
  const groups = groupRunsByDate(runs);
  const selected = runs.find(run => run.id === selectedId) ?? runs[0];
  const hasFilters = !!filters.search.trim() || filters.status !== 'all' || filters.source !== 'all';
  const existingCandidate = !!selected && (extractedIds.includes(selected.id) || state.skills.some(skill => skill.source.includes(selected.id)));
  const clearFilters = () => { setFilters({ search: '', status: 'all', source: 'all' }); setMobileDetail(false); };
  const selectRun = (id: string) => {
    setSelectedId(id);
    setMobileDetail(true);
    if (window.matchMedia('(max-width: 1060px)').matches) requestAnimationFrame(() => headingRef.current?.focus());
  };
  const backToRecords = () => {
    setMobileDetail(false);
    requestAnimationFrame(() => { if (selected) listButtons.current.get(selected.id)?.focus(); });
  };
  const copyResult = async () => {
    if (!selected?.answer.trim()) return;
    try { await navigator.clipboard.writeText(selected.answer); notify('已复制任务结果。'); }
    catch { notify('复制未完成，请选择结果文字后复制。'); }
  };
  const extractCandidate = async () => {
    if (!canExtract || !selected || mutationRunning.current || existingCandidate) return;
    const run = selected;
    mutationRunning.current = true;
    setExtractingId(run.id);
    setError({ runId: '', message: '' });
    try {
      await mutate('skill_candidate', {
        title: `${run.query.slice(0, 36)} · 方法草稿`,
        description: '依据本次运行的任务、执行轨迹与引用整理的方法草稿。需要管理者核对原始事实、适用条件和授权边界。',
        scenario: `适用于类似任务：“${run.query.slice(0, 1800)}”。复用前核实客户、业务阶段、关键事实和现行政策。`,
        steps: run.steps.length ? run.steps.slice(0, 12).map(step => `复用“${step.title}”：${step.detail}`.slice(0, 1900)) : ['澄清任务目标与待核实事实', '核对生效知识及业务授权边界', '形成建议并与实际反馈逐项验证'],
        boundaries: ['当前工作空间使用示例数据；示例结果不构成真实客户反馈、成交或转化证据。', '本次运行输出属于方法草稿，需管理者核对原始依据后人工审核。', '不得承诺未经审批的优惠、交付或商务条件；复用时重新核对生效知识。'],
        evidence: `证据性质：本工作空间为示例数据；以下运行结果不是成交或转化证据。仅保留任务和执行输出供人工审核。\n运行编号：${run.id}\n生成方式：${runGenerationLabel(run)}\n\n原始任务：${run.query.slice(0, 1100)}\n\n原始结果片段：${run.answer.slice(0, 3200)}\n\n引用来源：${run.citations.map(item => item.title).join('；').slice(0, 250)}`.slice(0, 5000),
        source: `运行记录 ${run.id} · ${dateLabel(run.createdAt)} · ${runGenerationLabel(run)}`,
      });
      setExtractedIds(ids => [...ids, run.id]);
      notify('已提炼为候选 Skill，待管理者本人核对证据与边界后审核。');
    } catch (problem) {
      setError({ runId: run.id, message: problem instanceof Error ? problem.message : '提炼未完成。' });
    } finally { mutationRunning.current = false; setExtractingId(''); }
  };

  return <section className="studio-view run-history-view" data-detail-open={mobileDetail && !!selected ? 'true' : 'false'}>
    <header className="run-history-heading"><h1>AI 任务记录</h1></header>
    <div className="run-history-toolbar" role="search" aria-label="筛选运行记录">
      <label className="run-history-search"><Search size={17} aria-hidden="true" /><span className="studio-sr-only">搜索任务、结果、专家或运行编号</span><input value={filters.search} onChange={event => { setFilters({ ...filters, search: event.target.value }); setMobileDetail(false); }} placeholder="搜索任务、结果、专家或编号" />{filters.search && <button type="button" onClick={() => setFilters({ ...filters, search: '' })} aria-label="清空搜索"><X size={16} /></button>}</label>
      <label className="run-history-filter"><span className="studio-sr-only">运行状态</span><select value={filters.status} onChange={event => { setFilters({ ...filters, status: event.target.value as RunFilters['status'] }); setMobileDetail(false); }}><option value="all">全部状态</option><option value="completed">已完成</option><option value="paused">待确认</option><option value="failed">执行失败</option><option value="rejected">已拒绝</option></select></label>
      <label className="run-history-filter"><span className="studio-sr-only">任务来源</span><select value={filters.source} onChange={event => { setFilters({ ...filters, source: event.target.value as RunFilters['source'] }); setMobileDetail(false); }}><option value="all">全部来源</option><option value="chat">专家协作</option><option value="workflow">工作流</option></select></label>
      {hasFilters && runs.length > 0 && <button type="button" className="run-history-clear" onClick={clearFilters}>清除筛选</button>}
      <span className="run-history-count" role="status">{runs.length} 条记录</span>
    </div>
    {selected ? <div className="run-history-layout">
      <nav className="run-history-list" aria-label="已保存的运行记录">
        {groups.map(group => <div className="run-history-date-group" key={group.date}><h2>{group.date.replace(/^(\d+)-(\d+)-(\d+)$/, '$1年$2月$3日')}</h2><ul>{group.runs.map(run => <li key={run.id}><button type="button" ref={element => { if (element) listButtons.current.set(run.id, element); else listButtons.current.delete(run.id); }} className={`run-history-item${selected.id === run.id ? ' run-history-item-selected' : ''}`} onClick={() => selectRun(run.id)} aria-current={selected.id === run.id ? 'true' : undefined}>
          <div className="run-history-item-top"><StatusLabel status={runStatus(run)} /><time dateTime={run.createdAt}>{timeLabel(run.createdAt)}</time></div>
          <span className="run-history-item-title">{run.query}</span>
          <p>{run.workflowId ? <GitBranch size={13} aria-hidden="true" /> : <MessageSquare size={13} aria-hidden="true" />}<span>{run.workflowId ? '工作流' : '专家协作'}{run.agentIds.length > 0 && ` · ${run.agentIds.map(agentName).join('、')}`}</span><ChevronRight size={14} aria-hidden="true" /></p>
        </button></li>)}</ul></div>)}
      </nav>
      <RecordDetail key={selected.id} run={selected} existingCandidate={existingCandidate} busy={extractingId === selected.id} extractionPending={!!extractingId} error={error.runId === selected.id ? error.message : ''} onBack={backToRecords} onCopy={copyResult} onExtract={extractCandidate} headingRef={headingRef} canExtract={canExtract} />
    </div> : <Empty filtered={hasFilters} onClear={clearFilters} />}
  </section>;
}
