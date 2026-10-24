'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, ArrowUp, BarChart3, BriefcaseBusiness, ChevronDown, ChevronRight, ClipboardCheck, Loader2, MessageSquare, ShieldCheck, Sparkles, Target, Users, X } from 'lucide-react';
import { TalkTrackPicker } from './TalkLibraryView';
import type { TalkTrack } from '../lib/talktrack-types';
import { AGENTS, STAGES, type AgentId, type View, type ViewProps } from '../lib/types';

export const money = (n: number) => `¥${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(n / 10000)}万`;
export const shortDate = (value: string) => new Date(value).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
export const modelDisplayName = (name: string) => name.replace(/ · 已配置，生成时验证$/, '');
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
    dialog?.querySelector<HTMLButtonElement>('[data-dialog-initial-focus]')?.focus({preventScroll:true});
    const cancel = (e: Event) => { e.preventDefault(); closeRef.current(); };
    dialog?.addEventListener('cancel', cancel);
    return () => { dialog?.removeEventListener('cancel', cancel); dialog?.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} className={`overlay ${wide ? 'wide' : ''} ${className}`} aria-label={title} onClick={e => { if (e.target === e.currentTarget) onClose(); }}><div className="overlay-body"><div className="overlay-heading"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={19} /></button></div>{children}</div></dialog>;
}

export function Composer({ onSend, placeholder = '今天有什么销售任务，交给我一起完成…', busy = false, compact = false, modelConnected = false, talkTracks = [], selectedTalkTrackIds, onTalkTrackChange }: { talkTracks?:TalkTrack[];selectedTalkTrackIds?:string[];onTalkTrackChange?:(ids:string[])=>void; onSend: (query: string, agentId?: AgentId, talkTrackIds?:string[]) => void; placeholder?: string; busy?: boolean; compact?: boolean; modelConnected?: boolean }) {
  const [text, setText] = useState('');
  const [agentId, setAgentId] = useState<AgentId | ''>('');
  const [localTalkIds,setLocalTalkIds]=useState<string[]>([]);
  const selectedIds=selectedTalkTrackIds??localTalkIds;
  const composing = useRef(false);
  const send = () => { if (text.trim() && !busy) { onSend(text.trim(), agentId || undefined, selectedIds); setText(''); } };
  return <div className={`composer ${compact ? 'compact' : ''}`}><textarea aria-label="描述你的任务" value={text} onChange={e => setText(e.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={e => { if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return; if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} placeholder={placeholder} rows={compact ? 2 : 3} maxLength={6000} /><TalkTrackPicker tracks={talkTracks} selectedIds={selectedIds} onChange={onTalkTrackChange??setLocalTalkIds} disabled={busy}/><div className="composer-bottom"><label className="agent-select"><Sparkles size={15} /><select aria-label="任务专家" value={agentId} onChange={e => setAgentId(e.target.value as AgentId | '')}><option value="">智能调度</option>{AGENTS.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select><ChevronDown size={12} /></label><div className="composer-right"><span className="composer-mode"><span className={`status-dot ${modelConnected ? 'connected' : ''}`} />{modelConnected ? '模型生成' : '本地生成'}</span><button aria-label="发送任务" className="send-button" onClick={send} disabled={!text.trim() || busy}>{busy ? <Loader2 size={19} className="spin" /> : <ArrowUp size={19} />}</button></div></div></div>;
}

type CoreProps = ViewProps & { onNavigate?: (view: View, id?: string) => void };
export function HomeView({ state, onAsk, onNavigate }: CoreProps) {
  const manager = state.role === 'manager';
  const realProjects = state.deals.filter(deal=>deal.dataOrigin==='manual');
  const openProjects = realProjects.filter(deal=>!deal.outcome||deal.outcome==='open');
  const allRisks = openProjects.filter(d => d.priority === 'high' || d.risks.length > 0);
  const risks = allRisks.slice(0, 3);
  const candidates = state.skills.filter(s => s.status === 'candidate');
  const total = openProjects.reduce((a, d) => a + d.amount, 0);
  const name = state.viewer.name;
  const activeProject = state.deals.find(deal => deal.dataOrigin === 'manual') || state.deals[0];
  const projectTitle = activeProject?.projectName || activeProject?.name;
  const visit = () => activeProject ? onAsk(`为「${projectTitle}」准备一份拜访方案，梳理客户需求、开场话术和关键问题`, 'strategy', activeProject.id) : onNavigate?.('deals');
  return <div className={`home-view ${manager ? 'manager-home' : ''}`}>
    {manager ? <><div className="page-header"><div><h1 className="page-title">把目光，放在关键处。</h1><p className="page-description">{name}，本工作空间的项目进展与待办已整理在这里。</p></div></div><div className="manager-summary"><div><span>在跟商机金额</span><strong>{money(total)}</strong><small>{openProjects.length} 个在跟项目 · 用户录入金额合计</small></div><div><span>需要你的介入</span><strong>{allRisks.length}<small>项</small></strong><small>优先商机与商务条件待核对</small></div><button onClick={() => onNavigate?.('knowledge')}><span>候选 Skill 待审核</span><strong>{candidates.length}<small>项</small></strong><small>由你亲自确认发布 <ArrowRight size={14} /></small></button></div><div className="manager-columns"><section className="card funnel-card"><div className="section-heading"><h2>项目推进漏斗</h2><span>按当前阶段</span></div><div className="funnel-list">{STAGES.map((stage, index) => { const count = openProjects.filter(d => d.stage === stage).length; return <button key={stage} onClick={() => onNavigate?.('deals')}><span className="funnel-stage">{stage}</span><span className="funnel-track"><i style={{ width: `${Math.max(8, count / Math.max(1, openProjects.length) * 100)}%`, opacity: 1 - index * 0.12 }} /></span><b>{count}</b></button>; })}</div><p className="fine-print">规则健康度用于安排跟进顺序，不代表成交概率。</p></section><section className="card intervention-card"><div className="section-heading"><h2>值得介入的商机</h2><button className="text-button" onClick={() => onNavigate?.('deals')}>查看全部 <ArrowRight size={14} /></button></div>{risks.map(d => <button className="intervention-row" key={d.id} onClick={() => onNavigate?.('deals', d.id)}><span className="company-avatar">{d.avatar || d.name.slice(0, 1)}</span><span><strong>{d.name}</strong><small>{d.risks[0] || d.nextAction}</small></span><ChevronRight size={16} /></button>)}{!risks.length&&<p className="fine-print">当前没有需要优先介入的真实项目。</p>}</section></div><section className="review-strip"><BarChart3 size={22} /><div><strong>每天 18:30，汇总销售进展。</strong><p>按北京时间整理本工作空间真实录入的项目、跟进与待办，保留历史日报。</p></div><button className="button secondary" onClick={()=>onNavigate?.('reports')}>查看销售日报 <ArrowRight size={15} /></button></section><section className="review-strip"><ClipboardCheck size={22} /><div><strong>让实战经验，成为团队的下一次底气。</strong><p>{candidates.length ? `有 ${candidates.length} 项候选 Skill 等待核对来源、步骤与适用边界。` : '目前没有待审核 Skill，可以从一次任务运行中沉淀候选。'}</p></div><button className="button secondary" onClick={() => onNavigate?.('knowledge')}>查看候选 <ArrowRight size={15} /></button></section><div className="manager-ask"><h2>也可以，直接交给你的管理 Agent。</h2><Composer talkTracks={state.talkTracks??[]} onSend={(q,a,ids)=>onAsk(q,a,undefined,ids)} modelConnected={state.model.connected} placeholder="例如：梳理本工作空间的商机风险，并给出跟进建议" compact /></div></> : <><section className="welcome"><div className="welcome-intro"><BrandMark /><h1>{name}，今天想推进什么？</h1><p>把客户问题交给我，把更多时间留给客户。</p></div><Composer talkTracks={state.talkTracks??[]} onSend={(q,a,ids)=>onAsk(q,a,undefined,ids)} modelConnected={state.model.connected} /><div className="suggestions"><button onClick={visit}><span><BriefcaseBusiness size={18} />准备一次拜访</span><p>带着客户洞察，聊到关键处</p><ArrowRight size={15} /></button><button onClick={() => onAsk('本周哪些商机值得优先跟进？请列出依据和下一步行动', 'opportunity')}><span><Target size={18} />梳理重点商机</span><p>理清优先级，找到下一步</p><ArrowRight size={15} /></button><button onClick={() => onNavigate?.('training')}><span><MessageSquare size={18} />练习一场谈判</span><p>重要对话之前，先练习一次</p><ArrowRight size={15} /></button></div></section><section className="expert-section"><div className="section-heading"><h2>五位专家，协作完成</h2><span>按需调度 · 有据可循</span></div><div className="expert-grid">{AGENTS.map((a, i) => { const Icon = expertIcons[i]; return <button key={a.id} onClick={() => onAsk(activeProject ? `围绕项目「${projectTitle}」，${a.starter}` : a.starter, a.id, activeProject?.id)}><Icon size={21} strokeWidth={1.55} /><strong>{a.name}</strong><p>{a.description}</p><ArrowRight size={14} /></button>; })}</div></section><section className="recent-section"><div className="section-heading"><div className="heading-with-count"><h2>继续推进</h2><span className="count-badge">{state.deals.length}</span></div><button className="text-button" onClick={() => onNavigate?.('deals')}>全部项目 <ArrowRight size={14} /></button></div><div className="home-deals">{state.deals.slice(0, 3).map(d => <button className="home-deal" key={d.id} onClick={() => onNavigate?.('deals', d.id)}><span className="company-avatar">{d.avatar || d.name[0]}</span><span className="home-deal-copy"><strong>{d.projectName || d.name}</strong><small>{d.name} · {d.nextAction}</small></span><span className="stage-tag">{d.stage}</span><ChevronRight size={16} /></button>)}</div></section></>}
    <footer className="home-footer"><ShieldCheck size={13} /><span>重要决策与商务条件请人工确认</span></footer>
  </div>;
}
