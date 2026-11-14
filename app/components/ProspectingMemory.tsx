'use client';

import { useEffect, useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { preferredScrollBehavior } from '../lib/scroll-behavior';
import type { TaskMemoryEvent, TaskMemoryFact, TaskMemoryView } from '../lib/prospecting-memory-types';
import './prospecting-memory.css';

type Edit = { factId: string; operation: 'correct' | 'retract' | 'ignore'; value?: string; sessionVersion: number; bindingVersion: number };
type Draft = Edit & { label: string; value: string };
type Props = {
  memory?: TaskMemoryView;
  tasks: { id: string; name: string }[];
  conversationId: string;
  editable: boolean;
  busy: boolean;
  resetKey: number;
  onInspectSource: () => void;
  onEdit: (edit: Edit) => Promise<boolean>;
  onSwitch: (target: string, bindingVersion: number) => Promise<boolean>;
  onDirtyChange: (dirty: boolean) => void;
};
const labels: Record<TaskMemoryFact['key'], string> = { area: '面积', category: '业态', budget: '预算', location: '意向位置', timing: '计划时间', visit: '到访安排', constraint: '附加条件', preference: '沟通偏好', next_step: '下一步' };
const statuses = { confirmed: '已确认', tentative: '待确认', stale: '可能过期', retracted: '已不再适用', superseded: '已被替代', ignored: '已忽略' };
const actors = { customer: '客户陈述', human: '人工记录', agent: 'AI 记录', system: '系统记录' };
const eventLabels = { customer_question: '客户问题', submitted_verified: '已核实提交', pending: '待处理', uncertain: '待核对', contact_declined: '拒绝留资', contact_captured: '已留资', human_edit: '人工纠错', sales_confirmed: '销售确认', system_verified: '系统核实' };
function eventLabel(event: TaskMemoryEvent) {
  if (event.type === 'customer_question') return event.status === 'resolved' ? '已解决问题' : event.status === 'open' ? '客户问题' : '待核实问题';
  if (event.status === 'resolved' && ['pending', 'uncertain'].includes(event.type)) return '已核实事项';
  return eventLabels[event.type];
}
const historical = (fact: TaskMemoryFact) => ['retracted', 'superseded', 'ignored'].includes(fact.status);
function date(value: string) { return Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '时间待确认'; }
export function prospectMessageId(id: string) { return `prospect-message-${id}`; }
function jumpToSource(id: string, onInspectSource: () => void) {
  const target = document.getElementById(prospectMessageId(id));
  if (!target) return false;
  onInspectSource();
  const details = target.closest('details'); if (details) details.open = true;
  target.scrollIntoView({ block: 'center', behavior: preferredScrollBehavior() });
  target.focus({ preventScroll: true });
  return true;
}

export function ProspectingMemory({ memory, tasks, conversationId, editable, busy, resetKey, onInspectSource, onEdit, onSwitch, onDirtyChange }: Props) {
  const prefix = useId();
  // Keep drafts for each task reception even when another conversation is selected.
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [switches, setSwitches] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState('');
  const [lastReset, setLastReset] = useState(resetKey);
  if (lastReset !== resetKey) { setLastReset(resetKey); setDrafts({}); setSwitches({}); setFeedback(''); }
  const key = memory?.sessionId || conversationId;
  const draft = drafts[key]; const target = switches[key] || '';
  const dirty = Object.keys(drafts).length > 0;
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  const disabled = busy || !editable || !memory?.ready || !memory.isActive;
  const conflict = draft && memory && (draft.sessionVersion !== memory.sessionVersion || draft.bindingVersion !== memory.bindingVersion);
  const clearDraft = () => { setDrafts(current => { const next = { ...current }; delete next[key]; return next; }); setFeedback(''); };
  function begin(fact: TaskMemoryFact, operation: Edit['operation']) {
    if (!memory || disabled) return;
    setDrafts(current => ({ ...current, [key]: { factId: fact.id, operation, value: fact.value, label: labels[fact.key], sessionVersion: memory.sessionVersion, bindingVersion: memory.bindingVersion } })); setFeedback('');
  }
  async function save() {
    if (!draft || disabled || conflict || draft.operation === 'correct' && !draft.value.trim()) return;
    const { factId, operation, value, sessionVersion, bindingVersion } = draft;
    if (await onEdit({ factId, operation, sessionVersion, bindingVersion, ...(operation === 'correct' ? { value: value.trim() } : {}) })) clearDraft();
    else setFeedback('保存未完成，草稿已保留。请核对最新记忆后重试。');
  }
  function source(id: string) { setFeedback(jumpToSource(id, onInspectSource) ? '' : '来源消息不在当前已加载记录中，原文与时间保留如下。'); }
  function renderFact(fact: TaskMemoryFact) {
    return <li key={fact.id} className="prospect-memory-fact">
      <div className="prospect-memory-fact-head"><strong>{labels[fact.key]}</strong><span>{statuses[fact.status]}</span></div>
      <p>{fact.value}</p>
      <details className="prospect-memory-source"><summary>来源与记录</summary><p>{fact.sourceText || '原文片段待核实'}</p><p>{actors[fact.actor]}{fact.actorId ? ` · ${fact.actorId}` : ''} · 来源 <time dateTime={fact.sourceAt}>{date(fact.sourceAt)}</time></p><p>更新 <time dateTime={fact.updatedAt}>{date(fact.updatedAt)}</time>{fact.supersedes && ' · 替代了较早记录'}</p><button type="button" className="button ghost" onClick={() => source(fact.sourceMessageId)}>查看{labels[fact.key]}来源</button></details>
      {!historical(fact) && <div className="prospect-memory-actions"><button type="button" className="button ghost" disabled={disabled || Boolean(draft)} onClick={() => begin(fact, 'correct')} aria-label={`纠正${labels[fact.key]}`}>纠正</button><button type="button" className="button ghost" disabled={disabled || Boolean(draft)} onClick={() => begin(fact, 'retract')} aria-label={`标记${labels[fact.key]}不再适用`}>标记不再适用</button><button type="button" className="button ghost" disabled={disabled || Boolean(draft)} onClick={() => begin(fact, 'ignore')} aria-label={`忽略${labels[fact.key]}`}>忽略这条记忆</button></div>}
    </li>;
  }
  const facts = memory?.state.facts || [];
  const current = facts.filter(fact => !historical(fact));
  const history = facts.filter(historical);
  const events = memory?.state.events || [];
  const questions = events.filter(event => event.status !== 'resolved' && (event.type === 'customer_question' || event.type === 'uncertain' || event.type === 'pending'));
  const progress = events.filter(event => !questions.includes(event));
  return <details className="prospect-memory">
    <summary><strong>本任务记忆</strong><span>{!memory?.ready ? '待核实' : current.some(fact => fact.status !== 'confirmed') ? '含待确认事项' : '需求与进展'}</span><ChevronDown size={13} /></summary>
    <div className="prospect-memory-body">
      {!memory ? <p>本任务记忆尚未就绪，原有消息仍保留。请同步后查看。</p> : <>
        <p className="prospect-memory-binding">当前自动接待任务：{memory.activeCampaignName || tasks.find(task => task.id === memory.activeCampaignId)?.name || (memory.activeCampaignId ? '任务名称待同步' : '待指定')}</p>
        {!memory.isActive && <p role="status">此客户由其他任务接待，当前任务记忆只读。</p>}
        {!editable && <p>只读记忆，请联系任务负责人纠正。</p>}
        {!memory.ready && <p role="status">记忆仍在核实，暂不可编辑或恢复自动接待。</p>}
        {memory.state.summary && <p className="prospect-memory-summary">{memory.state.summary}</p>}
        <h4>当前需求与附加条件</h4>
        {current.filter(fact => fact.key !== 'next_step').length ? <ul>{current.filter(fact => fact.key !== 'next_step').map(renderFact)}</ul> : <p>暂无已记录需求。</p>}
        <section aria-label="未解决问题与待核实事项"><h4>未解决问题与待核实事项</h4>
        {questions.length ? <ul>{questions.map(event => <li key={event.id}><strong>{eventLabel(event)}</strong><p>{event.sourceText}</p><span>{actors[event.actor]} · <time dateTime={event.sourceAt}>{date(event.sourceAt)}</time></span><button type="button" className="button ghost" onClick={() => source(event.sourceMessageId)}>查看问题来源</button></li>)}</ul> : <p>暂无记录。未记录不代表已解决。</p>}</section>
        <h4>下一步</h4><p>记录意向与待办；不会自动联系客户。</p>
        {current.some(fact => fact.key === 'next_step') ? <ul>{current.filter(fact => fact.key === 'next_step').map(renderFact)}</ul> : <p>暂无下一步安排。</p>}
        <h4>最近进展</h4>
        <p>邀请已提交 {memory.state.contact.submittedInvites} 次 · 待发送 {memory.state.contact.pendingInvites} 次 · 待核对 {memory.state.contact.uncertainInvites} 次</p>
        <p>历史邀请待核实 {memory.state.contact.legacyInvites} 次 · {memory.state.contact.captured ? '已留资' : '未留资'}{memory.state.contact.declined ? ' · 已拒绝留资' : ''}</p>
        {progress.length > 0 && <ul>{progress.slice(-8).map(event => <li key={event.id}><strong>{eventLabel(event)}</strong><p>{event.sourceText}</p><span>{actors[event.actor]} · <time dateTime={event.sourceAt}>{date(event.sourceAt)}</time></span><button type="button" className="button ghost" onClick={() => source(event.sourceMessageId)}>查看进展来源</button></li>)}</ul>}
        <details className="prospect-memory-history"><summary>变更历史（{history.length}）</summary>{history.length ? <ul>{history.map(renderFact)}</ul> : <p>暂无历史记录。</p>}</details>
        {draft && <div className="prospect-memory-editor" role="group" aria-label="编辑记忆">
          <strong>{draft.operation === 'correct' ? `纠正${draft.label}` : draft.operation === 'ignore' ? `忽略${draft.label}` : `标记${draft.label}不再适用`}</strong>
          {draft.operation === 'correct' ? <><label htmlFor={`${prefix}-value`}>纠正后的{draft.label}</label><textarea autoFocus id={`${prefix}-value`} value={draft.value} maxLength={1000} disabled={disabled} rows={3} onChange={event => setDrafts(current => ({ ...current, [key]: { ...draft, value: event.target.value } }))} /></> : <p>{draft.operation === 'ignore' ? '忽略后，同一来源不会再次进入记忆，原始消息保留。' : '保留变更记录，此项不再作为当前需求。'}</p>}
          {conflict && <p role="status">记忆已有更新，草稿已保留。请核对最新内容后刷新版本。</p>}
          <div className="prospect-memory-actions">{conflict && <button type="button" className="button secondary" disabled={disabled} onClick={() => setDrafts(current => ({ ...current, [key]: { ...draft, sessionVersion: memory.sessionVersion, bindingVersion: memory.bindingVersion } }))}>刷新版本，保留草稿</button>}<button type="button" className="button primary" disabled={disabled || Boolean(conflict) || draft.operation === 'correct' && !draft.value.trim()} onClick={() => void save()}>{draft.operation === 'correct' ? '保存纠正' : draft.operation === 'ignore' ? '确认忽略' : '确认不再适用'}</button><button type="button" className="button secondary" disabled={busy} onClick={clearDraft}>取消编辑</button></div>
        </div>}
        {editable && tasks.some(task => task.id !== memory.activeCampaignId) && <div className="prospect-memory-switch"><label htmlFor={`${prefix}-task`}>切换接待任务</label><select id={`${prefix}-task`} value={target} disabled={busy || !memory.ready || Boolean(draft)} onChange={event => setSwitches(current => ({ ...current, [key]: event.target.value }))}><option value="">选择任务</option>{tasks.filter(task => task.id !== memory.activeCampaignId).map(task => <option value={task.id} key={task.id}>{task.name}</option>)}</select>{target && <><p>切换将暂停原任务接待；新消息按切换边界归入目标任务，历史记忆不复制。正在发送或待核对的结果须先核实。人工接管会保留，恢复 AI 需单独操作。</p><button type="button" className="button secondary" disabled={busy || !memory.ready || Boolean(draft)} onClick={async () => { if (await onSwitch(target, memory.bindingVersion)) setSwitches(current => ({ ...current, [key]: '' })); }}>确认切换任务</button></>}</div>}
      </>}
      {feedback && <p role="status">{feedback}</p>}
    </div>
  </details>;
}
