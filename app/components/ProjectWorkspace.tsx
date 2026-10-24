'use client';

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowLeft, ArrowRight, AudioLines, Building2, Check, ChevronDown, ClipboardList, ExternalLink, FileText, Loader2, MessageSquarePlus, Pencil, Plus, Search, ShieldCheck, Sparkles, Target, Users, X } from 'lucide-react';
import { AGENTS, STAGES, type ApiResult, type Deal, type View, type ViewProps } from '../lib/types';
import { money } from './CoreViews';
import { AnswerContent } from './AnswerContent';
import { FollowupRecordingField, FollowupRecordingPlayer } from './FollowupRecordingField';
import './answer-content.css';
import './project-workspace.css';

type ProjectProps = ViewProps & {
  initialDealId?: string | null;
  onDealClosed?: () => void;
  uploadFollowup?: (dealId: string, text: string, audio: File) => Promise<ApiResult>;
  onNavigate?: (view: View, id?: string) => void;
};
type Tab = 'overview' | 'profile' | 'followups' | 'agents';
type ProjectFields = { projectName: string; name: string; contact: string; position: string; industry: string; amount: string; stage: string; summary: string; needs: string; source: string; nextAction: string; website: string };
type CustomerFields = { decisionChain: string; goals: string; concerns: string; budget: string; timeline: string };
const TABS: { id: Tab; label: string }[] = [{ id: 'overview', label: '项目概览' }, { id: 'profile', label: '客户画像' }, { id: 'followups', label: '跟进记录' }, { id: 'agents', label: 'Agent 工作' }];
const PROFILE_FIELDS: { id: keyof CustomerFields; label: string; placeholder: string }[] = [
  { id: 'decisionChain', label: '决策链与关键角色', placeholder: '谁提出需求、谁参与评估、谁最终确认？' },
  { id: 'goals', label: '业务目标', placeholder: '客户希望解决的问题、预期业务结果' },
  { id: 'concerns', label: '关注点与顾虑', placeholder: '客户关心的条件、风险或尚未解决的疑问' },
  { id: 'budget', label: '预算情况', placeholder: '预算范围、审批情况，未知时可留空' },
  { id: 'timeline', label: '采购与决策时间', placeholder: '评估、决策、采购或交付的预期时间' },
];
const projectTitle = (deal: Deal) => deal.projectName || deal.name;
const dateValue = (value?: string) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const formatDate = (value?: string, withTime = false) => dateValue(value) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) }).format(new Date(value!)) : '尚未记录';
function safePublicUrl(value?: string) {
  try {
    const url = new URL(value || '');
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const local = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || !host.includes('.') || /^(?:0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host);
    return url.protocol === 'https:' && !url.username && !url.password && !local ? url.href : null;
  } catch { return null; }
}
function fieldsFor(deal?: Deal): ProjectFields {
  return { projectName: deal ? projectTitle(deal) : '', name: deal?.name || '', contact: deal?.contact || '', position: deal?.position || '', industry: deal?.industry || '', amount: deal?.amount ? String(deal.amount) : '', stage: deal?.stage || STAGES[0], summary: deal?.summary || '', needs: deal?.needs.join('\n') || '', source: deal?.source || '', nextAction: deal?.nextAction || '', website: deal?.website || '' };
}
function profileFor(deal: Deal): CustomerFields {
  return { decisionChain: deal.customerProfile?.decisionChain || '', goals: deal.customerProfile?.goals || '', concerns: deal.customerProfile?.concerns || '', budget: deal.customerProfile?.budget || '', timeline: deal.customerProfile?.timeline || '' };
}
function projectPayload(fields: ProjectFields) {
  return { ...fields, amount: fields.amount.trim() ? Number(fields.amount) : 0, needs: fields.needs.split('\n').map(value => value.trim()).filter(Boolean) };
}

function ProjectForm({ fields, setFields, busy, creating, error, onSubmit, onCancel }: { fields: ProjectFields; setFields: (value: ProjectFields) => void; busy: boolean; creating: boolean; error: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onCancel: () => void }) {
  const prefix = useId();
  const field = (id: keyof ProjectFields, label: string, props: { required?: boolean; placeholder?: string; type?: string; maxLength?: number } = {}) => <label htmlFor={`${prefix}-${id}`}>{label}{!props.required && <span>选填</span>}<input id={`${prefix}-${id}`} name={id} value={fields[id]} disabled={busy} onChange={event => setFields({ ...fields, [id]: event.target.value })} {...props} /></label>;
  return <form className="project-form" onSubmit={onSubmit} aria-busy={busy}>
    <div className="project-section-heading"><div><h2>{creating ? '新建项目' : '编辑项目资料'}</h2><p>以一次销售机会为单位，集中管理客户、跟进与协作。</p></div><button type="button" className="icon-button" onClick={onCancel} disabled={busy} aria-label={creating ? '取消新建项目' : '取消编辑项目'}><X size={18} /></button></div>
    <div className="project-form-grid">
      {field('projectName', '项目名称', { required: true, placeholder: '例如：客户企业 · 年度服务采购', maxLength: 150 })}
      {field('name', '客户企业', { required: true, placeholder: '填写完整企业名称，便于补全画像', maxLength: 150 })}
      {field('contact', '联系人', { maxLength: 80, placeholder: '客户姓名' })}
      {field('position', '职位 / 角色', { maxLength: 80, placeholder: '例如：采购负责人' })}
      <label htmlFor={`${prefix}-summary`} className="project-form-wide">项目需求<span>选填</span><textarea id={`${prefix}-summary`} name="summary" value={fields.summary} disabled={busy} maxLength={3000} rows={3} placeholder="客户想解决什么问题？希望达成什么结果？" onChange={event => setFields({ ...fields, summary: event.target.value })} /></label>
      {field('nextAction', '下一步行动', { placeholder: '例如：周三确认需求清单与关键决策人', maxLength: 500 })}
      <label htmlFor={`${prefix}-stage`}>推进阶段<select id={`${prefix}-stage`} name="stage" value={fields.stage} disabled={busy} onChange={event => setFields({ ...fields, stage: event.target.value })}>{STAGES.map(stage => <option key={stage}>{stage}</option>)}</select></label>
    </div>
    <details className="project-more-fields"><summary>更多项目信息 <ChevronDown size={14} /></summary><div className="project-form-grid">
      {field('industry', '所属行业', { placeholder: '如：制造业、企业服务、零售', maxLength: 80 })}
      <label htmlFor={`${prefix}-amount`}>预计金额（元）<span>选填</span><input id={`${prefix}-amount`} name="amount" type="number" min="0" max="999999999999" step="0.01" inputMode="decimal" value={fields.amount} disabled={busy} onChange={event => setFields({ ...fields, amount: event.target.value })} placeholder="尚未确认可留空" /></label>
      {field('source', '项目来源', { placeholder: '例如：客户转介、展会、主动咨询', maxLength: 200 })}
      {field('website', '企业官网', { type: 'url', placeholder: 'https://', maxLength: 1000 })}
      <label htmlFor={`${prefix}-needs`} className="project-form-wide">关键需求<span>选填 · 每行一条</span><textarea id={`${prefix}-needs`} name="needs" value={fields.needs} disabled={busy} maxLength={5000} rows={3} placeholder={'明确产品或服务范围\n记录客户提出的关键条件'} onChange={event => setFields({ ...fields, needs: event.target.value })} /></label>
    </div></details>
    {error && <p className="project-error" role="alert">{error}</p>}
    <div className="project-form-actions"><button type="button" className="button ghost" onClick={onCancel} disabled={busy}>取消</button><button className="button primary" disabled={busy || !fields.projectName.trim() || !fields.name.trim()}>{busy ? <Loader2 size={16} className="spin" /> : <Check size={16} />}{busy ? '保存中…' : creating ? '创建项目' : '保存项目资料'}</button></div>
  </form>;
}

export function ProjectsView({ state, mutate, notify, onAsk, initialDealId, onDealClosed, uploadFollowup, onNavigate }: ProjectProps) {
  const [selectedId, setSelectedId] = useState<string | null>(initialDealId || null);
  const [tab, setTab] = useState<Tab>('overview');
  const [query, setQuery] = useState('');
  const [stageFilter, setStageFilter] = useState('all');
  const [creating, setCreating] = useState(false);
  const [pickingFollowup, setPickingFollowup] = useState(false);
  const [followupProjectId, setFollowupProjectId] = useState('');
  const [fields, setFields] = useState<ProjectFields>(() => fieldsFor());
  const [editing, setEditing] = useState<'project' | 'profile' | null>(null);
  const [customerFields, setCustomerFields] = useState<CustomerFields>({ decisionChain: '', goals: '', concerns: '', budget: '', timeline: '' });
  const [note, setNote] = useState('');
  const [recording, setRecording] = useState<File | null>(null);
  const [nextStage, setNextStage] = useState('');
  const [confirmStage, setConfirmStage] = useState(false);
  const [busy, setBusy] = useState<'create' | 'edit' | 'profile' | 'followup' | 'stage' | 'enrich' | null>(null);
  const [error, setError] = useState('');
  const busyRef = useRef(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const prefix = useId();
  const deal = state.deals.find(item => item.id === selectedId);
  const matchingProjects = state.deals.filter(item => (stageFilter === 'all' || item.stage === stageFilter) && `${projectTitle(item)} ${item.name} ${item.contact} ${item.industry} ${item.owner} ${item.nextAction}`.toLowerCase().includes(query.trim().toLowerCase()));
  const linkedRuns = deal ? state.runs.filter(run => run.dealId === deal.id).sort((a, b) => dateValue(b.createdAt) - dateValue(a.createdAt)) : [];
  const notes = deal ? [...deal.notes].sort((a, b) => dateValue(b.date) - dateValue(a.date)) : [];

  useEffect(() => {
    const protectSaving = (event: BeforeUnloadEvent) => { if (busyRef.current) event.preventDefault(); };
    window.addEventListener('beforeunload', protectSaving);
    return () => window.removeEventListener('beforeunload', protectSaving);
  }, []);

  const openProject = (item: Deal, target: Tab = 'overview') => {
    if (busyRef.current) return;
    setSelectedId(item.id); setTab(target); setCreating(false); setPickingFollowup(false); setEditing(null); setError(''); setNote(''); setRecording(null); setNextStage(item.stage); setConfirmStage(false);
    requestAnimationFrame(() => target === 'followups' ? noteRef.current?.focus() : titleRef.current?.focus());
  };
  const backToProjects = () => {
    if (busyRef.current) return;
    setSelectedId(null); setEditing(null); setError(''); setNote(''); setRecording(null); onDealClosed?.();
    requestAnimationFrame(() => document.getElementById(`${prefix}-projects-heading`)?.focus());
  };
  const activateTab = (value: Tab) => { if (!busyRef.current) { setTab(value); setEditing(null); setError(''); } };
  const tabKeyboard = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const target = event.key === 'ArrowRight' ? (index + 1) % TABS.length : event.key === 'ArrowLeft' ? (index + TABS.length - 1) % TABS.length : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : null;
    if (target === null || busyRef.current) return;
    event.preventDefault(); activateTab(TABS[target].id); tabsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[target]?.focus();
  };
  const begin = (kind: NonNullable<typeof busy>) => { if (busyRef.current) return false; busyRef.current = true; setBusy(kind); setError(''); return true; };
  const finish = () => { busyRef.current = false; setBusy(null); };
  const saveProject = async (event: FormEvent<HTMLFormElement>, isNew: boolean) => {
    event.preventDefault();
    if ((!isNew && !deal) || !begin(isNew ? 'create' : 'edit')) return;
    try {
      const result = await mutate(isNew ? 'deal_create' : 'deal_update', { ...projectPayload(fields), ...(!isNew && deal ? { dealId: deal.id, version: deal.version } : {}) });
      if (isNew) { const id = result.dealId; if (id) { setSelectedId(id); setTab('overview'); } setCreating(false); }
      setEditing(null); notify(isNew ? '项目已创建' : '项目资料已保存');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败，请重试'); }
    finally { finish(); }
  };
  const saveCustomer = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!deal || !begin('profile')) return;
    try { await mutate('deal_update', { dealId: deal.id, version: deal.version, customerProfile: customerFields }); setEditing(null); notify('客户画像已保存'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败，请重试'); }
    finally { finish(); }
  };
  const saveFollowup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!deal || (!note.trim() && !recording) || !begin('followup')) return;
    try {
      if (recording) { if (!uploadFollowup) throw new Error('录音上传暂时不可用，请稍后重试'); await uploadFollowup(deal.id, note.trim(), recording); }
      else await mutate('deal_note', { dealId: deal.id, text: note.trim() });
      setNote(''); setRecording(null); notify('跟进记录已保存');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败，请重试'); }
    finally { finish(); }
  };
  const updateStage = async () => {
    if (!deal || !confirmStage || !begin('stage')) return;
    try { await mutate('deal_stage', { dealId: deal.id, version: deal.version, stage: nextStage, confirmed: true }); setConfirmStage(false); notify('项目阶段已更新'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '阶段更新失败，请重试'); setConfirmStage(false); }
    finally { finish(); }
  };
  const enrichCompany = async () => {
    if (!deal || !begin('enrich')) return;
    try {
      const result = await mutate('deal_enrich', { dealId: deal.id, version: deal.version });
      const profile = result.state.deals.find(item => item.id === deal.id)?.companyProfile;
      notify(profile?.sources.length ? '企业画像已更新' : '暂未检索到有效公开资料，请核对企业全称后重试');
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : '企业资料补全失败，请重试'); }
    finally { finish(); }
  };
  const ask = (queryText: string, agentId: 'insight' | 'strategy' | 'opportunity' | 'risk') => { if (deal && !busyRef.current) onAsk(queryText, agentId, deal.id); };
  const showFollowup = () => { if (busyRef.current) return; setTab('followups'); setEditing(null); setError(''); requestAnimationFrame(() => noteRef.current?.focus()); };

  if (!deal) return <div className="business-page project-workspace">
    <header className="page-header project-page-header"><div><h1 id={`${prefix}-projects-heading`} className="page-title" tabIndex={-1}>项目中心</h1><p className="page-description">从第一条商机到每一次跟进，让客户信息与行动围绕项目汇聚。</p></div><div className="project-header-actions"><button className="button secondary" disabled={!state.deals.length || !!busy} onClick={() => { setPickingFollowup(!pickingFollowup); setCreating(false); setError(''); }}><MessageSquarePlus size={16} />记录跟进</button><button className="button primary" disabled={!!busy} onClick={() => { setFields(fieldsFor()); setCreating(true); setPickingFollowup(false); setError(''); }}><Plus size={17} />新建项目</button></div></header>
    {creating && <section className="project-create-panel"><ProjectForm fields={fields} setFields={setFields} busy={!!busy} creating error={error} onSubmit={event => { void saveProject(event, true); }} onCancel={() => { if (!busyRef.current) { setCreating(false); setError(''); } }} /></section>}
    {pickingFollowup && <form className="project-followup-picker" onSubmit={event => { event.preventDefault(); const item = state.deals.find(project => project.id === followupProjectId); if (item) openProject(item, 'followups'); }}><label htmlFor={`${prefix}-followup-project`}>为哪个项目记录跟进？<select id={`${prefix}-followup-project`} value={followupProjectId} onChange={event => setFollowupProjectId(event.target.value)} required><option value="">选择项目</option>{state.deals.map(item => <option key={item.id} value={item.id}>{projectTitle(item)} · {item.name}</option>)}</select></label><button className="button primary" disabled={!followupProjectId}>开始记录 <ArrowRight size={15} /></button><button className="icon-button" type="button" onClick={() => setPickingFollowup(false)} aria-label="取消选择项目"><X size={17} /></button></form>}
    <div className="project-toolbar"><label className="project-search"><Search size={17} /><input value={query} onChange={event => setQuery(event.target.value)} aria-label="搜索项目" placeholder="搜索项目、客户企业或联系人" />{query && <button type="button" onClick={() => setQuery('')} aria-label="清除搜索"><X size={14} /></button>}</label><select className="select" aria-label="筛选项目阶段" value={stageFilter} onChange={event => setStageFilter(event.target.value)}><option value="all">全部阶段</option>{STAGES.map(stage => <option key={stage}>{stage}</option>)}</select><span className="project-list-count">{matchingProjects.length} 个项目</span></div>
    {matchingProjects.length ? <section className="project-list" aria-label="项目列表"><div className="project-list-head" aria-hidden="true"><span>项目 / 客户企业</span><span>阶段</span><span>下一步行动</span><span>最近跟进</span><span /></div><ul>{matchingProjects.map(item => <li key={item.id}>
      <button className="project-name-button" onClick={() => openProject(item)}><span className="project-company-avatar"><Building2 size={20} /></span><span><strong>{projectTitle(item)}</strong><small>{item.name}{item.contact ? ` · ${item.contact}` : ''}</small></span></button>
      <span className="project-stage"><span className="stage-tag">{item.stage}</span><small>{item.owner || '尚未分配'}</small></span><p className="project-next-action">{item.nextAction || '待安排下一步行动'}</p><time className="project-last-contact">{dateValue(item.lastContact) ? formatDate(item.lastContact) : '暂无跟进'}</time><button className="button ghost project-row-followup" onClick={() => openProject(item, 'followups')} aria-label={`为${projectTitle(item)}新增跟进`}><Plus size={14} />新增跟进</button>
    </li>)}</ul></section> : <section className="project-empty"><Building2 size={30} /><h2>{state.deals.length ? '没有找到匹配的项目' : '从你的第一个项目开始'}</h2><p>{state.deals.length ? '尝试其他项目名称、企业名称，或清除筛选。' : '录入商机与客户企业，随后添加文字或录音跟进，逐步完善客户画像。'}</p><button className="button secondary" onClick={() => { if (state.deals.length) { setQuery(''); setStageFilter('all'); } else { setFields(fieldsFor()); setCreating(true); } }}>{state.deals.length ? '清除筛选' : <><Plus size={15} />新建项目</>}</button></section>}
  </div>;

  const companyProfile = deal.companyProfile;
  const website = safePublicUrl(deal.website);
  return <div className="business-page project-workspace project-detail" aria-busy={!!busy}>
    <button className="project-back" disabled={!!busy} onClick={backToProjects}><ArrowLeft size={16} />返回项目</button>
    <header className="project-detail-heading"><div><div className="project-entity-label"><Building2 size={15} />{deal.name}<span className="stage-tag">{deal.stage}</span></div><h1 className="page-title" ref={titleRef} tabIndex={-1}>{projectTitle(deal)}</h1><p>{deal.contact ? `${deal.contact}${deal.position ? ` · ${deal.position}` : ''}` : '联系人待补充'}<span>负责人 {deal.owner || '待分配'}</span></p></div><button className="button primary" disabled={!!busy} onClick={showFollowup}><MessageSquarePlus size={16} />新增跟进</button></header>
    <div className="project-tabs" role="tablist" aria-label="项目详情" ref={tabsRef}>{TABS.map((item, index) => <button key={item.id} role="tab" id={`${prefix}-tab-${item.id}`} aria-controls={`${prefix}-panel-${item.id}`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} disabled={!!busy} onClick={() => activateTab(item.id)} onKeyDown={event => tabKeyboard(event, index)}>{item.label}{item.id === 'followups' && <span>{notes.length}</span>}</button>)}</div>
    {error && !editing && <div className="project-error project-action-error" role="alert">{error}</div>}
    <section id={`${prefix}-panel-overview`} aria-labelledby={`${prefix}-tab-overview`} role="tabpanel" hidden={tab !== 'overview'} tabIndex={0}>
      {editing === 'project' ? <ProjectForm fields={fields} setFields={setFields} busy={!!busy} creating={false} error={error} onSubmit={event => { void saveProject(event, false); }} onCancel={() => { if (!busyRef.current) { setEditing(null); setError(''); } }} /> : <>
        <div className="project-overview-grid"><section className="project-section project-overview-main"><div className="project-section-heading"><h2>项目需求</h2><button className="project-text-button" disabled={!!busy} onClick={() => { setFields(fieldsFor(deal)); setEditing('project'); setError(''); }}><Pencil size={14} />编辑资料</button></div><p className="project-summary">{deal.summary || '还没有项目说明，先记下客户的需求与合作目标。'}</p>{deal.needs.length > 0 && <ul className="project-needs">{deal.needs.map((need, index) => <li key={index}><Check size={15} /><span>{need}</span></li>)}</ul>}<div className="project-next-box"><Target size={19} /><div><span>下一步行动</span><p>{deal.nextAction || '待安排下一步行动'}</p></div></div><button className="project-text-button" disabled={!!busy} onClick={() => ask(`请为「${projectTitle(deal)}」整理下一步行动与沟通方案，结合当前客户资料和跟进记录，区分已知事实与待确认事项。`, 'strategy')}>请策略方案 Agent 帮我准备 <ArrowRight size={14} /></button></section>
        <aside className="project-section"><h2>项目资料</h2><dl className="project-facts"><div><dt>客户企业</dt><dd>{deal.name}</dd></div><div><dt>所属行业</dt><dd>{deal.industry || '待补充'}</dd></div><div><dt>预计金额</dt><dd>{deal.amount > 0 ? money(deal.amount) : '待确认'}</dd></div><div><dt>项目来源</dt><dd>{deal.source || '待补充'}</dd></div><div><dt>企业官网</dt><dd>{website ? <a href={website} target="_blank" rel="noopener noreferrer">访问官网 <ExternalLink size={12} /></a> : deal.website || '待补充'}</dd></div></dl></aside></div>
        {deal.risks.length > 0 && <section className="project-section project-risk"><h2><ShieldCheck size={17} />需关注的商务事项</h2><ul>{deal.risks.map((risk, index) => <li key={index}>{risk}</li>)}</ul></section>}
        <section className="project-section project-stage-section"><div><h2>推进阶段</h2><p>阶段变更会保留在项目活动中。</p></div><div className="project-stage-actions"><select className="select" value={nextStage || deal.stage} aria-label="更新项目阶段" disabled={!!busy} onChange={event => { setNextStage(event.target.value); setConfirmStage(false); }}>{STAGES.map(stage => <option key={stage}>{stage}</option>)}</select><button className="button secondary" disabled={!!busy || !nextStage || nextStage === deal.stage} onClick={() => setConfirmStage(true)}>更新阶段</button></div>{confirmStage && <div className="project-stage-confirm"><p>确认将项目从「{deal.stage}」更新到「{nextStage}」？</p><div><button className="button ghost" disabled={!!busy} onClick={() => setConfirmStage(false)}>取消</button><button className="button primary" disabled={!!busy} onClick={() => { void updateStage(); }}>{busy === 'stage' && <Loader2 size={14} className="spin" />}确认更新</button></div></div>}</section>
      </>}
    </section>
    <section id={`${prefix}-panel-profile`} aria-labelledby={`${prefix}-tab-profile`} role="tabpanel" hidden={tab !== 'profile'} tabIndex={0}>
      <section className="project-section"><div className="project-section-heading"><div><h2>客户画像</h2><p>把沟通中确认的信息留在这里，供项目协作与 Agent 分析使用。</p></div>{editing !== 'profile' && <button className="button secondary" disabled={!!busy} onClick={() => { setCustomerFields(profileFor(deal)); setEditing('profile'); setError(''); }}><Pencil size={14} />编辑画像</button>}</div>
        {editing === 'profile' ? <form className="project-form project-customer-form" onSubmit={event => { void saveCustomer(event); }}><div className="project-form-grid">{PROFILE_FIELDS.map(field => <label key={field.id} className={field.id === 'decisionChain' ? 'project-form-wide' : undefined} htmlFor={`${prefix}-profile-${field.id}`}>{field.label}<textarea id={`${prefix}-profile-${field.id}`} rows={3} value={customerFields[field.id]} disabled={!!busy} maxLength={2000} placeholder={field.placeholder} onChange={event => setCustomerFields({ ...customerFields, [field.id]: event.target.value })} /></label>)}</div>{error && <p className="project-error" role="alert">{error}</p>}<div className="project-form-actions"><button type="button" className="button ghost" disabled={!!busy} onClick={() => { setEditing(null); setError(''); }}>取消</button><button className="button primary" disabled={!!busy}>{busy === 'profile' ? <Loader2 size={15} className="spin" /> : <Check size={15} />}保存画像</button></div></form> : <dl className="project-customer-grid">{PROFILE_FIELDS.map(field => <div key={field.id}><dt>{field.label}</dt><dd>{deal.customerProfile?.[field.id] || '待沟通补充'}</dd></div>)}</dl>}
      </section>
      <section className="project-section project-company-profile"><div className="project-section-heading"><div><h2>企业公开资料</h2><p>客户洞察 Agent 补全企业背景，保留来源与核实线索。</p></div><button className="button primary" disabled={!!busy} onClick={() => { void enrichCompany(); }}>{busy === 'enrich' ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />}{busy === 'enrich' ? '正在检索企业资料…' : companyProfile ? '更新企业画像' : '补全企业画像'}</button></div>
        {companyProfile ? <><div className="project-profile-meta"><span>{companyProfile.provider === 'qcc' ? '企查查' : '公开网络资料'}</span><span>{companyProfile.status === 'partial' ? '部分信息待核实' : '已获取资料'}</span><time>更新于 {formatDate(companyProfile.updatedAt, true)}</time></div>{companyProfile.summary && <p className="project-summary">{companyProfile.summary}</p>}<dl className="project-company-facts">{companyProfile.facts.map((fact, index) => <div key={`${fact.label}-${index}`}><dt>{fact.label}</dt><dd>{fact.value}{fact.sourceIds.length > 0 && <span className="project-fact-sources">{fact.sourceIds.map(id => { const source = companyProfile.sources.find(item => item.id === id); const url = safePublicUrl(source?.url); return url ? <a key={id} href={url} target="_blank" rel="noopener noreferrer" aria-label={`来源：${source?.title}`}>[{companyProfile.sources.findIndex(item => item.id === id) + 1}]</a> : null; })}</span>}</dd></div>)}</dl>{companyProfile.warnings.length > 0 && <div className="project-profile-warnings"><ShieldCheck size={16} /><ul>{companyProfile.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}<details className="project-profile-sources"><summary>资料来源 <span>{companyProfile.sources.length}</span></summary><ol>{companyProfile.sources.map(source => { const url = safePublicUrl(source.url); return <li key={source.id}>{url ? <a href={url} target="_blank" rel="noopener noreferrer">{source.title}<ExternalLink size={12} /></a> : <span>{source.title}</span>}<small>{source.provider === 'qcc' ? '企查查' : '公开网页'} · 获取于 {formatDate(source.retrievedAt, true)}</small>{source.snippet && <details className="project-source-snippet"><summary>查看检索摘录</summary><p>{source.snippet}</p></details>}</li>; })}</ol></details></> : <div className="project-profile-empty"><Building2 size={26} /><p>尚未补全这家企业的公开资料。</p><span>工商与经营信息会附上来源，无法确认的信息将标为待核实。</span></div>}
        <details className="project-profile-method"><summary>资料获取方式</summary><p>优先使用已配置的企查查接口；未配置时检索公开网络资料。仅使用企业名称与官网检索，人工填写的客户画像会单独保留。</p><button className="project-text-button" disabled={!!busy} onClick={() => onNavigate?.('settings')}>配置企查查 API <ArrowRight size={13} /></button></details>
      </section>
    </section>
    <section id={`${prefix}-panel-followups`} aria-labelledby={`${prefix}-tab-followups`} role="tabpanel" hidden={tab !== 'followups'} tabIndex={0}>
      <section className="project-section project-followup-composer"><div className="project-section-heading"><div><h2>新增跟进</h2><p>记录客户反馈、沟通结论和下一步约定，或上传本次沟通录音。</p></div><AudioLines size={21} /></div><form onSubmit={event => { void saveFollowup(event); }}><label className="project-note-label" htmlFor={`${prefix}-note`}>文字记录</label><textarea id={`${prefix}-note`} ref={noteRef} className="textarea" value={note} disabled={!!busy} rows={5} maxLength={5000} placeholder="这次沟通了什么？客户有哪些反馈？双方约定了什么？" onChange={event => setNote(event.target.value)} /><FollowupRecordingField key={deal.id} file={recording} onChange={file => { if (!busyRef.current) { setRecording(file); setError(''); } }} disabled={!!busy || !uploadFollowup}><button className="button primary" type="submit" disabled={!!busy || (!note.trim() && !recording)}>{busy === 'followup' ? <Loader2 size={15} className="spin" /> : <Check size={15} />}{busy === 'followup' ? '保存中…' : '保存跟进'}</button></FollowupRecordingField></form></section>
      <section className="project-followup-history"><h2>跟进记录 <span>{notes.length}</span></h2>{notes.length ? <ol>{notes.map(item => <li key={item.id}><article><header><span className="project-note-avatar">{item.author.slice(-1) || '记'}</span><div><strong>{item.author || '项目成员'}</strong><time>{formatDate(item.date, true)}</time></div><span className="project-note-kind">{item.recording ? '沟通录音' : '文字跟进'}</span></header>{item.text && <p>{item.text}</p>}{item.recording && <FollowupRecordingPlayer dealId={deal.id} recording={item.recording} />}</article></li>)}</ol> : <div className="project-empty project-empty-compact"><ClipboardList size={27} /><h3>还没有跟进记录</h3><p>在上方留下第一条文字或录音，项目的信息会逐步完整。</p></div>}</section>
    </section>
    <section id={`${prefix}-panel-agents`} aria-labelledby={`${prefix}-tab-agents`} role="tabpanel" hidden={tab !== 'agents'} tabIndex={0}>
      <div className="project-agent-actions"><button disabled={!!busy} onClick={() => ask(`请基于「${projectTitle(deal)}」的客户资料与跟进记录，分析客户目标、关键决策人、需求缺口及待确认问题，区分事实与推断。`, 'insight')}><Users size={21} /><strong>分析客户</strong><p>梳理需求、决策链与沟通切入点</p><ArrowRight size={16} /></button><button disabled={!!busy} onClick={() => ask(`请为「${projectTitle(deal)}」制定下一次沟通的推进方案，列出目标、提问顺序、建议话术与下一步约定。`, 'strategy')}><Target size={21} /><strong>准备推进方案</strong><p>让下一次沟通有目标、有行动</p><ArrowRight size={16} /></button></div>
      <section className="project-linked-runs"><div className="project-section-heading"><h2>项目任务记录 <span>{linkedRuns.length}</span></h2><button className="project-text-button" onClick={() => onNavigate?.('runs')} disabled={!!busy}>全部运行记录 <ArrowRight size={14} /></button></div>{linkedRuns.length ? linkedRuns.map(run => <details key={run.id} className="project-linked-run"><summary><FileText size={17} /><span><strong>{run.query}</strong><small>{run.agentIds.map(id => AGENTS.find(agent => agent.id === id)?.name || id).join(' · ')}<time>{formatDate(run.createdAt, true)}</time></small></span><ChevronDown size={16} /></summary><div className="project-run-answer"><AnswerContent text={run.answer} />{run.status === 'failed' && <p className="project-error">本次任务未完成，可到运行记录查看执行过程。</p>}</div></details>) : <div className="project-empty project-empty-compact"><Sparkles size={27} /><h3>还没有关联任务</h3><p>从上方开始分析或制定方案，结果会自动关联到当前项目。</p></div>}</section>
    </section>
  </div>;
}
