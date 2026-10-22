'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDownToLine, ArrowRight, ArrowUp, BarChart3, BriefcaseBusiness, Check, ChevronDown, ChevronRight, CircleHelp, ClipboardCheck, LayoutGrid, List, Loader2, MessageSquare, Search, ShieldCheck, Sparkles, Target, Users, X } from 'lucide-react';
import { AGENTS, STAGES, type AgentId, type ApiResult, type Deal, type View, type ViewProps } from '../lib/types';
import { FollowupRecordingField, FollowupRecordingPlayer } from './FollowupRecordingField';

export const money = (n: number) => `¥${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(n / 10000)}万`;
export const shortDate = (value: string) => new Date(value).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
export const expertIcons = [Users, Target, BarChart3, ShieldCheck, MessageSquare];
export function BrandMark({ small = false }: { small?: boolean }) {
  return <svg className={small ? 'brand-mark small' : 'brand-mark'} viewBox="0 0 40 40" fill="none" aria-hidden="true">{Array.from({ length: 12 }, (_, i) => <path key={i} d="M20 3 L21.3 14.7 L20 18 L18.7 14.7 Z" fill="currentColor" transform={`rotate(${i * 30} 20 20)`} />)}<circle cx="20" cy="20" r="3.8" fill="currentColor" /></svg>;
}

export function Overlay({ children, title, onClose, className = '', wide = false }: { children: ReactNode; title: string; onClose: () => void; className?: string; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    if (!dialog?.open) dialog?.showModal();
    const cancel = (e: Event) => { e.preventDefault(); closeRef.current(); };
    dialog?.addEventListener('cancel', cancel);
    return () => { dialog?.removeEventListener('cancel', cancel); dialog?.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} className={`overlay ${wide ? 'wide' : ''} ${className}`} aria-label={title} onClick={e => { if (e.target === e.currentTarget) onClose(); }}><div className="overlay-body"><div className="overlay-heading"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={19} /></button></div>{children}</div></dialog>;
}

export function Composer({ onSend, placeholder = '今天有什么销售任务，交给我一起完成…', busy = false, compact = false, modelConnected = false }: { onSend: (query: string, agentId?: AgentId) => void; placeholder?: string; busy?: boolean; compact?: boolean; modelConnected?: boolean }) {
  const [text, setText] = useState('');
  const [agentId, setAgentId] = useState<AgentId | ''>('');
  const composing = useRef(false);
  const send = () => { if (text.trim() && !busy) { onSend(text.trim(), agentId || undefined); setText(''); } };
  return <div className={`composer ${compact ? 'compact' : ''}`}><textarea aria-label="描述你的任务" value={text} onChange={e => setText(e.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={e => { if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return; if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} placeholder={placeholder} rows={compact ? 2 : 3} maxLength={6000} /><div className="composer-bottom"><label className="agent-select"><Sparkles size={15} /><select aria-label="任务专家" value={agentId} onChange={e => setAgentId(e.target.value as AgentId | '')}><option value="">智能调度</option>{AGENTS.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select><ChevronDown size={12} /></label><div className="composer-right"><span className="composer-mode"><span className={`status-dot ${modelConnected ? 'connected' : ''}`} />{modelConnected ? '接口已配置' : '演示生成'}</span><button aria-label="发送任务" className="send-button" onClick={send} disabled={!text.trim() || busy}>{busy ? <Loader2 size={19} className="spin" /> : <ArrowUp size={19} />}</button></div></div></div>;
}

type CoreProps = ViewProps & { onNavigate?: (view: View, id?: string) => void; initialDealId?: string | null; onDealClosed?: () => void; uploadFollowup?: (dealId: string, text: string, audio: File) => Promise<ApiResult> };
export function HomeView({ state, onAsk, onNavigate }: CoreProps) {
  const manager = state.role === 'manager';
  const allRisks = state.deals.filter(d => d.priority === 'high' || d.risks.length > 0);
  const risks = allRisks.slice(0, 3);
  const candidates = state.skills.filter(s => s.status === 'candidate');
  const total = state.deals.reduce((a, d) => a + d.amount, 0);
  const name = state.viewer.name;
  return <div className={`home-view ${manager ? 'manager-home' : ''}`}>
    {manager ? <><div className="page-header"><div><div className="eyebrow">TEAM OVERVIEW <span>· 团队工作台</span></div><h1 className="page-title">把目光，放在关键处。</h1><p className="page-description">{name}，团队的推进节奏与待办已整理在这里。</p></div><span className="badge">示例业务数据</span></div><div className="manager-summary"><div><span>在跟商机金额</span><strong>{money(total)}</strong><small>{state.deals.length} 个商机 · 各阶段金额合计</small></div><div><span>需要你的介入</span><strong>{allRisks.length}<small>项</small></strong><small>优先商机与商务条件待核对</small></div><button onClick={() => onNavigate?.('knowledge')}><span>候选 Skill 待审核</span><strong>{candidates.length}<small>项</small></strong><small>由你亲自确认发布 <ArrowRight size={14} /></small></button></div><div className="manager-columns"><section className="card funnel-card"><div className="section-heading"><h2>团队推进漏斗</h2><span>按当前阶段</span></div><div className="funnel-list">{STAGES.map((stage, index) => { const count = state.deals.filter(d => d.stage === stage).length; return <button key={stage} onClick={() => onNavigate?.('deals')}><span className="funnel-stage">{stage}</span><span className="funnel-track"><i style={{ width: `${Math.max(8, count / Math.max(1, state.deals.length) * 100)}%`, opacity: 1 - index * 0.12 }} /></span><b>{count}</b></button>; })}</div><p className="fine-print">规则健康度用于安排跟进顺序，不代表成交概率。</p></section><section className="card intervention-card"><div className="section-heading"><h2>值得介入的商机</h2><button className="text-button" onClick={() => onNavigate?.('deals')}>查看全部 <ArrowRight size={14} /></button></div>{risks.map(d => <button className="intervention-row" key={d.id} onClick={() => onNavigate?.('deals', d.id)}><span className="company-avatar">{d.avatar || d.name.slice(0, 1)}</span><span><strong>{d.name}</strong><small>{d.risks[0] || d.nextAction}</small></span><ChevronRight size={16} /></button>)}</section></div><section className="review-strip"><ClipboardCheck size={22} /><div><strong>让实战经验，成为团队的下一次底气。</strong><p>{candidates.length ? `有 ${candidates.length} 项候选 Skill 等待核对来源、步骤与适用边界。` : '目前没有待审核 Skill，可以从一次任务运行中沉淀候选。'}</p></div><button className="button secondary" onClick={() => onNavigate?.('knowledge')}>查看候选 <ArrowRight size={15} /></button></section><div className="manager-ask"><h2>也可以，直接交给你的管理 Agent。</h2><Composer onSend={onAsk} modelConnected={state.model.connected} placeholder="例如：梳理本周商机风险，并给出团队跟进建议" compact /></div></> : <><section className="welcome"><div className="welcome-intro"><BrandMark /><div className="welcome-kicker">你的销售 Agent，已就位</div><h1>{name}，今天想推进什么？</h1><p>把客户问题交给我，把更多时间留给客户。</p></div><Composer onSend={onAsk} modelConnected={state.model.connected} /><div className="suggestions"><button onClick={() => onAsk('为澄光咖啡准备一份拜访方案，梳理客户需求、开场话术和关键问题', 'strategy')}><span><BriefcaseBusiness size={18} />准备一次拜访</span><p>带着客户洞察，聊到关键处</p><ArrowRight size={15} /></button><button onClick={() => onAsk('本周哪些商机值得优先跟进？请列出依据和下一步行动', 'opportunity')}><span><Target size={18} />梳理重点商机</span><p>理清优先级，找到下一步</p><ArrowRight size={15} /></button><button onClick={() => onNavigate?.('training')}><span><MessageSquare size={18} />练习一场谈判</span><p>重要对话之前，先练习一次</p><ArrowRight size={15} /></button></div></section><section className="expert-section"><div className="section-heading"><h2>五位专家，协作完成</h2><span>按需调度 · 有据可循</span></div><div className="expert-grid">{AGENTS.map((a, i) => { const Icon = expertIcons[i]; return <button key={a.id} onClick={() => onAsk(a.starter, a.id)}><Icon size={21} strokeWidth={1.55} /><strong>{a.name}</strong><p>{a.description}</p><ArrowRight size={14} /></button>; })}</div></section><section className="recent-section"><div className="section-heading"><div className="heading-with-count"><h2>继续推进</h2><span className="count-badge">{state.deals.length}</span></div><button className="text-button" onClick={() => onNavigate?.('deals')}>全部商机 <ArrowRight size={14} /></button></div><div className="home-deals">{state.deals.slice(0, 3).map(d => <button className="home-deal" key={d.id} onClick={() => onNavigate?.('deals', d.id)}><span className="company-avatar">{d.avatar || d.name[0]}</span><span className="home-deal-copy"><strong>{d.name}</strong><small>{d.nextAction}</small></span><span className="stage-tag">{d.stage}</span><ChevronRight size={16} /></button>)}</div></section></>}
    <footer className="home-footer"><ShieldCheck size={13} /><span>独立体验空间</span><i />业务数据为示例 · 重要决策请人工确认</footer>
  </div>;
}

export function DealsView(props: CoreProps) {
  return <DealsWorkspace key={props.state.role} {...props} />;
}

function DealsWorkspace({ state, mutate, notify, onAsk, initialDealId, onDealClosed, uploadFollowup }: CoreProps) {
  const [query, setQuery] = useState('');
  const [stage, setStage] = useState('全部阶段');
  const [layout, setLayout] = useState<'list' | 'board'>('list');
  const [selected, setSelected] = useState<string | null>(initialDealId || null);
  const [note, setNote] = useState('');
  const [recording, setRecording] = useState<File | null>(null);
  const [nextStage, setNextStage] = useState(() => state.deals.find(d => d.id === initialDealId)?.stage || '');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const busyRef = useRef(false);
  const alive = useRef(false);
  const operation = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; operation.current += 1; };
  }, []);
  const deal = state.deals.find(d => d.id === selected);
  const filtered = state.deals.filter(d => (stage === '全部阶段' || d.stage === stage) && `${d.name} ${d.contact} ${d.industry} ${d.owner}`.toLowerCase().includes(query.toLowerCase()));
  const close = () => { if (busyRef.current) return; operation.current += 1; setSelected(null); setNote(''); setRecording(null); setConfirm(false); setActionError(''); onDealClosed?.(); };
  const open = (d: Deal) => { if (busyRef.current) return; operation.current += 1; setSelected(d.id); setNextStage(d.stage); setNote(''); setRecording(null); setActionError(''); setConfirm(false); };
  const saveNote = async () => {
    if (!deal || (!note.trim() && !recording) || busyRef.current) return;
    busyRef.current = true; setBusy(true); setActionError('');
    const current = ++operation.current;
    try {
      if (recording) {
        if (!uploadFollowup) throw new Error('录音上传暂时不可用，请稍后重试');
        await uploadFollowup(deal.id, note.trim(), recording);
      } else await mutate('deal_note', { dealId: deal.id, text: note.trim() });
      if (!alive.current || current !== operation.current) return;
      setNote(''); setRecording(null); notify('跟进记录已保存');
    } catch (e) {
      if (alive.current && current === operation.current) setActionError(e instanceof Error ? e.message : '保存失败，请重试');
    } finally {
      if (alive.current && current === operation.current) { busyRef.current = false; setBusy(false); }
    }
  };
  const changeStage = async () => {
    if (!deal || !confirm || busyRef.current) return;
    busyRef.current = true; setBusy(true); setActionError('');
    const current = ++operation.current;
    try {
      await mutate('deal_stage', { dealId: deal.id, stage: nextStage, confirmed: true, version: deal.version });
      if (!alive.current || current !== operation.current) return;
      setConfirm(false); notify(`商机已更新至「${nextStage}」`);
    } catch (e) {
      if (alive.current && current === operation.current) { setActionError(e instanceof Error ? e.message : '阶段更新失败'); setConfirm(false); }
    } finally {
      if (alive.current && current === operation.current) { busyRef.current = false; setBusy(false); }
    }
  };
  const exportCsv = () => { const rows = [['客户名称', '联系人', '行业', '负责人', '阶段', '金额（元）', '规则健康度', '下一步行动'], ...filtered.map(d => [d.name, d.contact, d.industry, d.owner, d.stage, d.amount, d.health, d.nextAction])]; const safe = (v: unknown) => `"${String(v).replace(/^[=+@-]/, "'$&").replaceAll('"', '""')}"`; const blob = new Blob(['\uFEFF' + rows.map(r => r.map(safe).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8;' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'CTAI-示例商机.csv'; a.click(); URL.revokeObjectURL(url); notify(`已导出 ${filtered.length} 条示例商机`); };
  return <div className="business-page deals-page"><div className="page-header"><div><div className="eyebrow">CUSTOMERS & OPPORTUNITIES</div><h1 className="page-title">每一次跟进，都更有把握。</h1><p className="page-description">把客户、机会与下一步行动，放在同一处。</p></div><button className="button secondary" onClick={exportCsv}><ArrowDownToLine size={16} />导出 CSV</button></div><div className="deals-overview"><div><span>在跟商机</span><strong>{state.deals.length}<small>个</small></strong></div><div><span>商机总额</span><strong>{money(state.deals.reduce((a, d) => a + d.amount, 0))}</strong></div><div><span>重点跟进</span><strong>{state.deals.filter(d => d.priority === 'high').length}<small>个</small></strong></div><div className="overview-note"><CircleHelp size={16} /><p>示例业务数据<br /><span>健康度为规则评估，非成交概率</span></p></div></div><div className="filter-bar"><label className="search-field"><Search size={16} /><input aria-label="搜索客户与商机" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索客户、联系人或负责人" /></label><select className="select" aria-label="商机阶段" value={stage} onChange={e => setStage(e.target.value)}><option>全部阶段</option>{STAGES.map(s => <option key={s}>{s}</option>)}</select><span className="filter-count">{filtered.length} 个商机</span><div className="view-toggle" aria-label="显示方式"><button className={layout === 'list' ? 'active' : ''} onClick={() => setLayout('list')} aria-label="列表视图"><List size={17} /></button><button className={layout === 'board' ? 'active' : ''} onClick={() => setLayout('board')} aria-label="看板视图"><LayoutGrid size={17} /></button></div></div>{filtered.length === 0 ? <div className="empty-state"><Search size={28} /><h3>没有找到匹配商机</h3><p>试试其他关键词，或切换阶段。</p><button className="button secondary" onClick={() => { setQuery(''); setStage('全部阶段'); }}>清除筛选</button></div> : layout === 'list' ? <div className="table-wrap"><table className="deals-table"><thead><tr><th>客户 / 联系人</th><th>当前阶段</th><th>商机金额</th><th>规则健康度</th><th>下一步行动</th><th>负责人</th><th /></tr></thead><tbody>{filtered.map(d => <tr key={d.id}><td><button className="customer-cell" onClick={() => open(d)}><span className="company-avatar">{d.avatar || d.name[0]}</span><span><strong>{d.name}</strong><small>{d.contact} · {d.position}</small></span></button></td><td><span className="stage-tag">{d.stage}</span></td><td className="number">{money(d.amount)}</td><td><div className="health-cell"><span>{d.health}</span><i><b style={{ width: `${d.health}%` }} /></i></div></td><td className="next-action">{d.nextAction}</td><td><span className="owner-cell">{d.owner}</span></td><td><button className="icon-button" onClick={() => open(d)} aria-label={`查看${d.name}详情`}><ChevronRight size={17} /></button></td></tr>)}</tbody></table></div> : <div className="kanban">{STAGES.filter(s => stage === '全部阶段' || stage === s).map(s => <section key={s}><div className="kanban-heading"><h2>{s}</h2><span>{filtered.filter(d => d.stage === s).length}</span></div>{filtered.filter(d => d.stage === s).map(d => <button className="kanban-deal" onClick={() => open(d)} key={d.id}><strong>{d.name}</strong><span>{money(d.amount)}</span><p>{d.nextAction}</p><footer>{d.owner}<small>健康度 {d.health}</small></footer></button>)}</section>)}</div>}<p className="table-footnote">仅展示当前体验角色可见的商机 · 所有跟进与阶段变更会保存在当前体验空间</p>{deal && <Overlay title="商机详情" onClose={close} className="drawer deal-drawer"><div className="deal-drawer-content" aria-busy={busy}><div className="deal-hero"><span className="company-avatar large">{deal.avatar || deal.name[0]}</span><div><h2>{deal.name}</h2><p>{deal.industry} · {deal.contact} / {deal.position}</p></div></div><div className="deal-facts"><div><span>商机金额</span><strong>{money(deal.amount)}</strong></div><div><span>负责人</span><strong>{deal.owner}</strong></div><div><span>规则健康度</span><strong>{deal.health} / 100</strong></div></div><p className="deal-summary">{deal.summary}</p><div className="deal-section"><h3>下一步行动</h3><div className="next-action-box"><Target size={17} /><span>{deal.nextAction}</span></div><button className="button secondary full" disabled={busy} onClick={() => { if (!busyRef.current) onAsk(`请结合${deal.name}的客户资料，梳理下一步行动及需确认的问题`, 'strategy', deal.id); }}><Sparkles size={16} />请 Agent 帮我准备 <ArrowRight size={15} /></button></div><div className="deal-section"><h3>关键需求</h3><ul className="clean-list">{deal.needs.map((n, i) => <li key={i}><Check size={14} />{n}</li>)}</ul></div>{deal.risks.length > 0 && <div className="deal-section risk-box"><h3><ShieldCheck size={16} />待核对的商务风险</h3>{deal.risks.map((r, i) => <p key={i}>{r}</p>)}</div>}<div className="deal-section"><h3>推进阶段</h3><div className="stage-editor"><select className="select" aria-label="更新商机阶段" value={nextStage || deal.stage} disabled={busy} onChange={e => { if (!busyRef.current) { setNextStage(e.target.value); setConfirm(false); } }}>{STAGES.map(s => <option key={s}>{s}</option>)}</select><button className="button secondary" disabled={!nextStage || nextStage === deal.stage || busy} onClick={() => setConfirm(true)}>更新阶段</button></div>{confirm && <div className="confirm-inline"><p>确认将「{deal.name}」从{deal.stage}推进至{nextStage}？此操作会记录到商机。</p><div><button className="button ghost" disabled={busy} onClick={() => { if (!busyRef.current) setConfirm(false); }}>取消</button><button className="button primary" disabled={busy} onClick={changeStage}>{busy ? '保存中…' : '确认更新'}</button></div></div>}</div><div className="deal-section"><h3>跟进记录 <span className="muted">{deal.notes.length}</span></h3><textarea className="textarea" aria-label="填写跟进记录" placeholder="记下新的客户反馈、沟通结论或约定，也可直接上传录音…" value={note} disabled={busy} onChange={e => { if (!busyRef.current) setNote(e.target.value); }} rows={3} maxLength={5000} /><FollowupRecordingField key={deal.id} file={recording} onChange={file => { if (!busyRef.current) { setRecording(file); setActionError(''); } }} disabled={busy || !uploadFollowup}><button className="button primary" onClick={saveNote} disabled={(!note.trim() && !recording) || busy}>{busy ? <><Loader2 size={15} className="spin" />保存中…</> : '保存记录'}</button></FollowupRecordingField>{actionError && <div role="alert" className="error-message">{actionError}</div>}<div className="note-list">{[...deal.notes].reverse().map(n => <article key={n.id}><div><strong>{n.author}</strong><time>{shortDate(n.date)}</time></div><>{n.text && <p>{n.text}</p>}{n.recording && <FollowupRecordingPlayer dealId={deal.id} recording={n.recording} />}</></article>)}{!deal.notes.length && <p className="muted">还没有跟进记录，从这一条开始。</p>}</div></div></div></Overlay>}</div>;
}
