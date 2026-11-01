'use client';

import { useState } from 'react';
import { ArrowRight, BookOpen, Check, ChevronDown, CircleAlert, Clock3, FileText, Loader2, Play, ShieldCheck, X } from 'lucide-react';
import type { Run, Workflow } from '../lib/types';
import { AnswerContent } from './AnswerContent';
import { modelDisplayName } from './CoreViews';

function readable(value: unknown): string {
  if (value === undefined || value === null || value === '') return '无';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}
const statusName = (status: Run['status']) => status === 'paused' ? '等待人工确认' : status === 'failed' ? '运行失败' : status === 'rejected' ? '已拒绝' : '运行完成';

function ReviewForm({ busy, onReview }: { busy: boolean; onReview: (decision: 'approve' | 'reject', note: string) => Promise<void> }) {
  const [note, setNote] = useState('');
  return <div className="builder-review-form"><label className="builder-field">审核说明<textarea rows={3} value={note} maxLength={1000} disabled={busy} onChange={event => setNote(event.target.value)} placeholder="核对上游结果和业务边界，写明确认或拒绝的依据" /></label><div className="builder-review-actions"><button type="button" className="builder-button builder-danger" disabled={busy || !note.trim()} onClick={() => void onReview('reject', note.trim())}><X size={14} />拒绝</button><button type="button" className="builder-button builder-primary" disabled={busy || !note.trim()} onClick={() => void onReview('approve', note.trim())}><Check size={14} />确认并继续</button></div></div>;
}

export function BuilderDebugger({ workflow, run, stale, query, onQuery, onRun, onReview, onSelectNode, busy, canBuild, canReview, connected, modelName, reviewOnly = false }: {
  workflow: Workflow; run: Run | null; stale: boolean; query: string; onQuery: (value: string) => void; onRun: () => Promise<void>; onReview: (decision: 'approve' | 'reject', note: string) => Promise<void>; onSelectNode?: (id: string) => void; busy: boolean; canBuild: boolean; canReview: boolean; connected: boolean; modelName: string; reviewOnly?: boolean;
}) {
  const paused = run?.status === 'paused';
  return <div className="builder-debug-content">
    <div className="builder-debug-model"><span className={`builder-dot${(reviewOnly ? run?.mode === 'live' : connected) ? ' builder-dot-live' : ''}`} /><span>{reviewOnly ? '已保存运行' : connected ? `${modelDisplayName(modelName)} · 已配置` : '未配置模型'}</span></div>
    {!reviewOnly && <form className="builder-debug-form" onSubmit={event => { event.preventDefault(); void onRun(); }}>
      <label className="builder-field">任务输入<textarea rows={4} maxLength={5000} value={query} disabled={busy} onChange={event => onQuery(event.target.value)} placeholder="输入希望应用完成的客户分析、拜访准备或商务审查任务…" /></label>
      <div className="builder-debug-submit"><span>{canBuild ? '直接测试当前配置，无需先保存' : '运行团队已发布版本'}</span><button className="builder-button builder-primary" disabled={busy || !query.trim()}>{busy ? <Loader2 size={14} className="builder-spin" /> : <Play size={14} />}{busy ? '处理中…' : run ? '重新运行' : canBuild ? '试运行' : '开始运行'}</button></div>
    </form>}
    {reviewOnly && run && <div className="builder-review-query"><span>本次任务</span><p>{run.query}</p></div>}
    {busy && <div className="builder-running" role="status"><Loader2 size={17} className="builder-spin" /><div><strong>正在处理</strong><p>执行结束后显示实际结果和逐节点记录。</p></div></div>}
    {!run && !busy && <div className="builder-debug-empty"><Play size={24} /><strong>{canBuild ? '让配置跑一次' : '输入任务，开始使用应用'}</strong><p>{canBuild ? '输入任务后，查看执行路径、每一步输入输出和引用依据。' : '应用会使用团队发布的版本处理任务，结果保存在运行记录中。'}</p></div>}
    {run && <>
      {stale && <div className="builder-inline-note builder-stale" role="status"><CircleAlert size={16} /><p>对应上一次测试。当前配置已修改，请重新试运行后发布。</p></div>}
      <div className={`builder-run-summary${paused ? ' builder-run-paused' : ''}`}><div>{paused ? <ShieldCheck size={16} /> : run.status === 'failed' || run.status === 'rejected' ? <CircleAlert size={16} /> : <Check size={16} />}<strong>{statusName(run.status)}</strong><span>{run.mode === 'live' ? '模型生成' : '本地生成'}</span></div><small><Clock3 size={12} />{run.duration < 1000 ? `${Math.round(run.duration)} ms` : `${(run.duration / 1000).toFixed(1)} s`}{run.workflowVersion !== undefined && ` · v${run.workflowVersion}`}{run.workflowSource && ` · ${run.workflowSource === 'draft' ? '草稿配置' : '发布版本'}`}</small></div>
      {paused && <section className="builder-review-panel"><div className="builder-panel-title"><ShieldCheck size={17} /><h3>{workflow.nodes.find(node => node.id === run.awaitingNodeId)?.label ?? '人工确认'}</h3></div>{run.awaitingNodeId ? <><p>请核对下方结果与引用依据。通过后才会继续执行后续节点。</p>{canReview ? <ReviewForm key={`${run.id}-${run.awaitingNodeId}`} busy={busy} onReview={onReview} /> : <p className="builder-help">已提交销售管理者确认，请等待管理者处理此运行。</p>}</> : <p className="builder-help">旧版暂停记录无法继续，请重新运行。</p>}</section>}
      {run.review && <div className="builder-reviewed-note"><strong>{run.review.reviewer} · {run.review.decision === 'approve' ? '已确认' : '已拒绝'}</strong><p>{run.review.note}</p></div>}
      <section className="builder-debug-result"><h3>任务结果</h3><AnswerContent text={run.answer || '本次运行尚未产生最终输出。'} compact /></section>
      <section className="builder-debug-trace"><h3>执行过程 <span>{run.steps.length} 步</span></h3>{run.steps.map((step, index) => <details key={step.id} className={`builder-trace builder-trace-${step.status}`} open={step.status === 'warning' || step.status === 'error'}><summary><span className="builder-trace-index">{index + 1}</span><strong>{step.title}</strong><span className="builder-trace-status">{step.status === 'success' ? '完成' : step.status === 'warning' ? '暂停' : step.status === 'skipped' ? '未命中' : '失败'}</span><ChevronDown size={13} /></summary><div className="builder-trace-body"><p>{step.detail}</p>{step.nodeId && onSelectNode && <button type="button" className="builder-text-button" onClick={() => onSelectNode(step.nodeId!)}>定位节点<ArrowRight size={12} /></button>}{step.input !== undefined && <div className="builder-trace-data"><span>输入</span><pre>{readable(step.input)}</pre></div>}{step.output !== undefined && <div className="builder-trace-data"><span>输出</span><pre>{readable(step.output)}</pre></div>}</div></details>)}</section>
      <section className="builder-debug-citations"><h3><BookOpen size={15} />引用依据 <span>{run.citations.length}</span></h3>{run.citations.length ? run.citations.map(citation => <details key={citation.id}><summary><FileText size={13} />{citation.title}<ChevronDown size={12} /></summary><p>{citation.excerpt}</p></details>) : <p className="builder-help">本次运行没有引用生效资料。</p>}</section>
      <p className="builder-run-id">运行编号 · {run.id}</p>
    </>}
  </div>;
}
