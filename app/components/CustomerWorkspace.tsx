'use client';

import { isMatchingChatRun } from '../lib/chat-request';
import { publicSourceLabel, salesReportEligible } from '../lib/sales-project-eligibility';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowLeft, ArrowUp, Building2, ChevronDown, FileText, Loader2, MoreHorizontal, PanelRight, Plus, Search, Sparkles, X } from 'lucide-react';
import { AGENTS, STAGES, type AgentId, type CustomerProfile, type Deal, type Run, type View, type ViewProps } from '../lib/types';
import type { MemberSession } from '../lib/member-types';
import { buildCustomerChatRequest, companyDirectory, customerChatHistory, selectCompanyProject, selectInitialCustomerProject, type CustomerChatRequest, type CustomerDirectoryScope } from '../lib/customer-workspace';
import { deadlineFromInput, deadlineInputValue } from '../lib/project-deadline';
import { runAnswerForDisplay, runGenerationLabel } from '../lib/run-history';
import { salesIntelligenceIsCurrent } from '../lib/sales-intelligence';
import { SALES_GRADE_LABELS } from '../lib/sales-intelligence-types';
import { AnswerContent } from './AnswerContent';
import { AgentMemoryButton } from './AgentMemoryPanel';
import { Overlay } from './CoreViews';
import { FollowupRecordingPlayer } from './FollowupRecordingField';
import { ProjectIntake } from './ProjectIntake';
import { ProjectSalesIntelligence } from './ProjectSalesIntelligence';
import './answer-content.css';
import './customer-workspace.css';

export type CustomerWorkspaceProps = ViewProps & {
  member: MemberSession;
  initialDealId?: string | null;
  initialIntent?: 'create' | 'followup' | null;
  onReload?: () => Promise<void>;
  onNavigate?: (view: View, id?: string) => void;
  onSelectedDealChange?: (id: string) => void;
  onBusyChange?: (busy: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
};
type Draft = { query: string; agent: AgentId | ''; note: string };
type FormMode = 'create' | 'edit' | 'profile' | 'lifecycle' | null;
type Fields = { name: string; projectName: string; contact: string; position: string; industry: string; summary: string; needs: string; nextAction: string; website: string; source: string; amount: string; deadline: string; stage: string };
const emptyDraft = (): Draft => ({ query: '', agent: '', note: '' });
const fieldsFor = (deal?: Deal, companyName = ''): Fields => ({ name: deal?.name || companyName, projectName: deal?.projectName || deal?.name || '', contact: deal?.contact || '', position: deal?.position || '', industry: deal?.industry || '', summary: deal?.summary || '', needs: deal?.needs.join('\n') || '', nextAction: deal?.nextAction || '', website: deal?.website || '', source: deal?.source || '', amount: deal?.amount ? String(deal.amount) : '', deadline: deadlineInputValue(deal?.deadline), stage: deal?.stage || STAGES[0] });
const profileFor = (deal?: Deal): CustomerProfile => ({ decisionChain: deal?.customerProfile?.decisionChain || '', goals: deal?.customerProfile?.goals || '', concerns: deal?.customerProfile?.concerns || '', budget: deal?.customerProfile?.budget || '', timeline: deal?.customerProfile?.timeline || '' });
const profileLabels: [keyof CustomerProfile, string][] = [['decisionChain', '决策链与关键角色'], ['goals', '业务目标'], ['concerns', '关注点与顾虑'], ['budget', '预算情况'], ['timeline', '采购与决策时间']];
const date = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '时间未记录';
const fullDate = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric' }) : '时间未记录';
const safeUrl = (value: string) => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined; } catch { return undefined; } };

export function CustomerWorkspace({ state, member, mutate, notify, initialDealId, initialIntent, onReload, onNavigate, onSelectedDealChange, onBusyChange, onDirtyChange }: CustomerWorkspaceProps) {
  const id = useId();
  const [directoryScope, setDirectoryScope] = useState<CustomerDirectoryScope>(() => state.deals.some(item => item.id === initialDealId && item.archive) ? 'archived' : 'active');
  const companies = useMemo(() => companyDirectory(state.deals, directoryScope), [state.deals, directoryScope]);
  const archiveCount = state.deals.filter(item => item.archive).length;
  const [selectedId, setSelectedId] = useState<string | null>(() => selectInitialCustomerProject(companies, initialDealId));
  const [search, setSearch] = useState('');
  const [profileOpen, setProfileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<'directory' | 'chat' | 'profile'>(initialDealId ? 'chat' : 'directory');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [returnedRuns, setReturnedRuns] = useState<Run[]>([]);
  const [pending, setPending] = useState<CustomerChatRequest | null>(null);
  const [failures, setFailures] = useState<Record<string, { request: CustomerChatRequest; error: string }>>({});
  const [busy, setBusy] = useState(false);
  const [intakeBusy, setIntakeBusy] = useState(false);
  const [assessmentBusy, setAssessmentBusy] = useState(false);
  const [intakeDirty, setIntakeDirty] = useState(false);
  const [mode, setMode] = useState<FormMode>(initialIntent === 'create' ? 'create' : null);
  const [fields, setFields] = useState<Fields>(() => fieldsFor());
  const [createOwnerId, setCreateOwnerId] = useState('manager');
  const [customerFields, setCustomerFields] = useState<CustomerProfile>(() => profileFor());
  const [formBaseline, setFormBaseline] = useState('');
  const [formTarget, setFormTarget] = useState<{ dealId: string; version: number } | null>(null);
  const [confirmManualSave, setConfirmManualSave] = useState(false);
  const [error, setError] = useState('');
  const [stage, setStage] = useState('');
  const [outcome, setOutcome] = useState('open');
  const [confirmed, setConfirmed] = useState(false);
  const [showLatest, setShowLatest] = useState(false);
  const localBusy = useRef(false), childBusy = useRef({ intake: false, assessment: false });
  const dirtyRef = useRef(false), lastInitial = useRef(initialDealId);
  const remembered = useRef<Record<string, string>>({});
  const scopeSelection = useRef<Partial<Record<CustomerDirectoryScope, string>>>({});
  const menu = useRef<HTMLDetailsElement>(null);
  const assessment = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null), composer = useRef<HTMLTextAreaElement>(null), stream = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const deal = state.deals.find(item => item.id === selectedId);
  const currentInsight = deal && !assessmentBusy && salesIntelligenceIsCurrent(deal) ? deal.intelligence?.latest?.insight : undefined;
  const intentGrade = currentInsight?.grade;
  const intentScore = intentGrade ? currentInsight.score : null;
  let intentLabel = '尚未评估';
  if (assessmentBusy) intentLabel = '评估中';
  else if (intentGrade && intentScore !== null) intentLabel = `${intentGrade} · ${SALES_GRADE_LABELS[intentGrade]}`;
  else if (currentInsight) intentLabel = '资料不足';
  else if (deal?.intelligence?.latest) intentLabel = '待重新评估';
  const company = companies.find(item => item.projects.some(project => project.id === selectedId));
  const draft = selectedId ? drafts[selectedId] || emptyDraft() : emptyDraft();
  const locked = busy || intakeBusy || assessmentBusy;
  const isBusy = () => localBusy.current || childBusy.current.intake || childBusy.current.assessment;
  const unavailable = !!initialDealId && !state.deals.some(item => item.id === initialDealId) && !selectedId;
  const allRuns = useMemo(() => [...new Map([...state.runs, ...returnedRuns].map(run => [run.id, run])).values()], [state.runs, returnedRuns]);
  const history = useMemo(() => customerChatHistory(allRuns, selectedId), [allRuns, selectedId]);
  const failure = selectedId ? failures[selectedId] : undefined;
  const formValue = JSON.stringify(mode === 'profile' ? customerFields : mode === 'lifecycle' ? { stage, outcome, confirmed } : { ...fields, ...(mode === 'create' && member.role === 'manager' ? { ownerId: createOwnerId } : {}) });
  const formDirty = !!mode && (formBaseline ? formValue !== formBaseline : mode === 'create' && formValue !== JSON.stringify({ ...fieldsFor(), ...(member.role === 'manager' ? { ownerId: 'manager' } : {}) }));
  const dirty = Object.values(drafts).some(value => value.query.length > 0 || value.note.length > 0) || Object.keys(failures).length > 0 || intakeDirty || formDirty;
  const filtered = companies.filter(item => `${item.name} ${item.projects.map(project => `${project.projectName || ''} ${project.contact} ${project.owner}`).join(' ')}`.toLocaleLowerCase('zh-CN').includes(search.trim().toLocaleLowerCase('zh-CN')));
  const onIntakeBusy = useCallback((value: boolean) => { childBusy.current.intake = value; setIntakeBusy(value); }, []);
  const onAssessmentBusy = useCallback((value: boolean) => { childBusy.current.assessment = value; setAssessmentBusy(value); }, []);
  const onIntakeDirty = useCallback((value: boolean) => setIntakeDirty(value), []);

  useEffect(() => {
    setProfileOpen(window.matchMedia('(min-width: 1201px)').matches);
    const media = window.matchMedia('(max-width: 700px)');
    const update = () => setIsMobile(media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => { if (selectedId) onSelectedDealChange?.(selectedId); }, [selectedId, onSelectedDealChange]);
  useEffect(() => { dirtyRef.current = dirty; onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(locked); }, [locked, onBusyChange]);
  useEffect(() => () => { onBusyChange?.(false); onDirtyChange?.(false); }, [onBusyChange, onDirtyChange]);
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => { if (dirtyRef.current || localBusy.current || childBusy.current.intake || childBusy.current.assessment) event.preventDefault(); };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, []);
  useEffect(() => {
    if (!mode) return;
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => element?.close();
  }, [mode]);
  useEffect(() => {
    if (lastInitial.current === initialDealId) return;
    lastInitial.current = initialDealId;
    if (initialDealId === selectedId) return;
    if (!isBusy() && !mode) {
      const scope = state.deals.some(item => item.id === initialDealId && item.archive) ? 'archived' : 'active';
      setDirectoryScope(scope); setSelectedId(selectInitialCustomerProject(companyDirectory(state.deals, scope), initialDealId)); setMobilePanel(initialDealId ? 'chat' : 'directory'); followLatest.current = true;
    }
  }, [initialDealId, state.deals, mode, selectedId]);
  useEffect(() => {
    if (initialIntent === 'followup' && selectedId) { setMobilePanel('chat'); composer.current?.focus(); }
  }, [initialIntent, selectedId]);
  const historyKey = history.map(run => run.id).join('|');
  useEffect(() => {
    if (!followLatest.current) return;
    const frame = requestAnimationFrame(() => { const element = stream.current; if (element) element.scrollTop = element.scrollHeight; setShowLatest(false); });
    return () => cancelAnimationFrame(frame);
  }, [selectedId, historyKey, pending, failure]);

  const updateDraft = (values: Partial<Draft>, target = selectedId) => { if (target) setDrafts(current => ({ ...current, [target]: { ...(current[target] || emptyDraft()), ...values } })); };
  const selectProject = (target: string | null) => {
    if (isBusy()) { notify('正在处理当前项目，请稍候再切换。'); return; }
    if (mode) { notify('请先保存或取消当前资料修改。'); return; }
    if (!target || !state.deals.some(item => item.id === target)) return;
    const ownerCompany = companies.find(item => item.projects.some(project => project.id === target));
    if (ownerCompany) remembered.current[ownerCompany.key] = target;
    followLatest.current = true; setSelectedId(target); setMobilePanel('chat'); setError('');
  };
  const switchDirectory = (scope: CustomerDirectoryScope) => {
    if (scope === directoryScope || isBusy()) return;
    if (mode) { notify('请先保存或取消当前资料修改。'); return; }
    if (selectedId) scopeSelection.current[directoryScope] = selectedId;
    const next = companyDirectory(state.deals, scope);
    const preferred = scopeSelection.current[scope];
    setDirectoryScope(scope); setSelectedId(selectInitialCustomerProject(next, preferred) || selectInitialCustomerProject(next)); setError(''); followLatest.current = true;
  };
  const openForm = (target: NonNullable<FormMode>, newCompany = false) => {
    if (isBusy()) return;
    if (menu.current) menu.current.open = false;
    const nextFields = target === 'create' ? fieldsFor(undefined, newCompany ? '' : company?.name) : fieldsFor(deal);
    const nextProfile = profileFor(deal), nextStage = deal?.stage || STAGES[0], nextOutcome = deal?.outcome || 'open';
    setFormTarget(target !== 'create' && deal ? { dealId: deal.id, version: deal.version } : null);
    setFields(nextFields); setCreateOwnerId('manager'); setCustomerFields(nextProfile); setStage(nextStage); setOutcome(nextOutcome); setConfirmed(false); setError(''); setIntakeDirty(false);
    setFormBaseline(JSON.stringify(target === 'profile' ? nextProfile : target === 'lifecycle' ? { stage: nextStage, outcome: nextOutcome, confirmed: false } : { ...nextFields, ...(target === 'create' && member.role === 'manager' ? { ownerId: 'manager' } : {}) }));
    setMode(target);
  };
  const closeForm = () => {
    if (isBusy()) return;
    if ((formDirty || intakeDirty) && !window.confirm('放弃尚未保存的资料修改？')) return;
    setMode(null); setIntakeDirty(false); setError('');
  };
  const begin = () => { if (isBusy()) return false; localBusy.current = true; setBusy(true); setError(''); return true; };
  const finish = () => { localBusy.current = false; setBusy(false); };
  const perform = async (action: string, payload: Record<string, unknown>, message: string) => {
    if (!begin()) return false;
    try { const result = await mutate(action, payload); notify(result.message || message); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败，请重试。'); return false; }
    finally { finish(); }
  };
  const saveForm = async (event?: FormEvent<HTMLFormElement>, discardIntake = false) => {
    event?.preventDefault();
    if (mode === 'create' && intakeDirty && !discardIntake) { setConfirmManualSave(true); return; }
    if (!mode || mode === 'lifecycle' || (!formTarget && mode !== 'create') || !begin()) return;
    const targetId = formTarget?.dealId, version = formTarget?.version;
    try {
      const result = await mutate(mode === 'create' ? 'deal_create' : 'deal_update', mode === 'profile'
        ? { dealId: targetId, version, customerProfile: customerFields }
        : { ...fields, amount: fields.amount.trim() ? Number(fields.amount) : 0, deadline: deadlineFromInput(fields.deadline), needs: fields.needs.split('\n').map(value => value.trim()).filter(Boolean), ...(mode !== 'create' ? { dealId: targetId, version } : member.role === 'manager' ? { ownerId: createOwnerId } : {}) });
      setMode(null); setIntakeDirty(false); notify(mode === 'create' ? '企业项目已创建' : '资料已保存');
      if (result.dealId && mode === 'create') { setDirectoryScope('active'); followLatest.current = true; setSelectedId(result.dealId); setMobilePanel('chat'); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败，请重试。'); }
    finally { finish(); }
  };
  const send = async (request: CustomerChatRequest) => {
    if (!request.query.trim() || !state.deals.some(item => item.id === request.dealId) || !begin()) return;
    // Capture the request once: retries keep both the exact text and the historical context IDs.
    setPending(request); followLatest.current = true;
    setFailures(current => { const next = { ...current }; delete next[request.dealId]; return next; });
    try {
      const result = await mutate('chat', { ...request });
      const run = result.run;
      if (!isMatchingChatRun(run, request)) throw new Error('本次未返回当前项目的完整回答，原话已保留，请重试。');
      setReturnedRuns(current => [...current.filter(item => item.id !== run.id), run]);
      setDrafts(current => { const previous = current[request.dealId] || emptyDraft(); return { ...current, [request.dealId]: { ...previous, query: previous.query === request.query ? '' : previous.query } }; });
    } catch (cause) { setFailures(current => ({ ...current, [request.dealId]: { request, error: cause instanceof Error ? cause.message : '生成未完成，请重试。' } })); }
    finally { setPending(null); finish(); }
  };
  const submitChat = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!deal || isBusy() || !draft.query.trim()) return;
    void send(buildCustomerChatRequest({ query: draft.query, dealId: deal.id, runs: allRuns, ...(draft.agent ? { agentId: draft.agent } : {}) }));
  };
  const saveNote = async () => {
    if (!deal || !draft.note.trim()) return;
    const target = deal.id, text = draft.note;
    if (await perform('deal_note', { dealId: target, text }, '客户原话已保存')) updateDraft({ note: '' }, target);
  };
  const navigate = (view: View) => { if (!isBusy()) onNavigate?.(view, deal?.id); };

  const fieldsForm = (creating: boolean) => <>
    <div className="cw-form-grid">
      <label htmlFor={`${id}-company`}>客户企业<input id={`${id}-company`} required maxLength={150} value={fields.name} onChange={event => setFields({ ...fields, name: event.target.value })} /></label>
      <label htmlFor={`${id}-project`}>项目名称<input id={`${id}-project`} required maxLength={150} value={fields.projectName} onChange={event => setFields({ ...fields, projectName: event.target.value })} /></label>
      <label htmlFor={`${id}-contact`}>联系人<input id={`${id}-contact`} maxLength={80} value={fields.contact} onChange={event => setFields({ ...fields, contact: event.target.value })} /></label>
      <label htmlFor={`${id}-position`}>职位 / 角色<input id={`${id}-position`} maxLength={80} value={fields.position} onChange={event => setFields({ ...fields, position: event.target.value })} /></label>
      <label className="cw-wide" htmlFor={`${id}-summary`}>需求与背景<textarea id={`${id}-summary`} rows={3} maxLength={3000} value={fields.summary} onChange={event => setFields({ ...fields, summary: event.target.value })} /></label>
      <label className="cw-wide" htmlFor={`${id}-next`}>下一步行动<input id={`${id}-next`} maxLength={500} value={fields.nextAction} onChange={event => setFields({ ...fields, nextAction: event.target.value })} /></label>
      <label htmlFor={`${id}-deadline`}>下一步截止时间 · 北京时间<input id={`${id}-deadline`} type="datetime-local" value={fields.deadline} onChange={event => setFields({ ...fields, deadline: event.target.value })} /></label>
      {creating && <label htmlFor={`${id}-stage`}>初始阶段<select id={`${id}-stage`} value={fields.stage} onChange={event => setFields({ ...fields, stage: event.target.value })}>{STAGES.map(value => <option key={value}>{value}</option>)}</select></label>}
      {creating && member.role === 'manager' && <label htmlFor={`${id}-owner`}>项目负责人<select id={`${id}-owner`} value={createOwnerId} onChange={event => setCreateOwnerId(event.target.value)}><option value="manager">我负责</option>{(state.salesOwners || []).map(owner => <option key={owner.salesId} value={owner.salesId}>{owner.displayName}</option>)}</select></label>}
    </div>
    <details className="cw-form-more"><summary>更多项目信息 <ChevronDown size={14} /></summary><div className="cw-form-grid">
      <label htmlFor={`${id}-industry`}>行业<input id={`${id}-industry`} maxLength={80} value={fields.industry} onChange={event => setFields({ ...fields, industry: event.target.value })} /></label>
      <label htmlFor={`${id}-amount`}>预计金额（元）<input id={`${id}-amount`} type="number" min="0" max="999999999999" step="0.01" value={fields.amount} onChange={event => setFields({ ...fields, amount: event.target.value })} /></label>
      <label htmlFor={`${id}-website`}>企业官网<input id={`${id}-website`} type="url" maxLength={1000} value={fields.website} onChange={event => setFields({ ...fields, website: event.target.value })} /></label>
      <label htmlFor={`${id}-source`}>项目来源<input id={`${id}-source`} maxLength={200} value={fields.source} onChange={event => setFields({ ...fields, source: event.target.value })} /></label>
      <label htmlFor={`${id}-needs`} className="cw-wide">关键需求 · 每行一条<textarea id={`${id}-needs`} rows={3} maxLength={5000} value={fields.needs} onChange={event => setFields({ ...fields, needs: event.target.value })} /></label>
    </div></details>
  </>;

  return <div className={`customer-workspace${profileOpen ? ' cw-profile-open' : ''}`} data-mobile-panel={mobilePanel}>
    <aside className="cw-directory" aria-label="企业通讯录">
      <header className="cw-directory-heading"><div><h1>项目跟进</h1><span>{companies.length} 家企业</span></div><button className="button ghost" aria-label="新建企业或项目" title="新建企业或项目" disabled={locked} onClick={() => openForm('create', true)}><Plus size={17} /></button></header>
      <div className="cw-directory-scope" role="group" aria-label="企业目录范围"><button type="button" aria-pressed={directoryScope === 'active'} disabled={locked} onClick={() => switchDirectory('active')}>当前企业</button><button type="button" aria-pressed={directoryScope === 'archived'} disabled={locked} onClick={() => switchDirectory('archived')}>归档历史<span>{archiveCount}</span></button></div>
      <div className="cw-directory-search"><label htmlFor={`${id}-search`}><Search size={15} /><span className="sr-only">搜索企业、项目或联系人</span></label><input id={`${id}-search`} placeholder="搜索企业、项目或联系人" value={search} onChange={event => setSearch(event.target.value)} /></div>
      <nav className="cw-company-list" aria-label="可访问企业">{filtered.map(item => <button key={item.key} className={`cw-company${company?.key === item.key ? ' selected' : ''}`} aria-current={company?.key === item.key ? 'true' : undefined} disabled={locked} onClick={() => selectProject(selectCompanyProject(item, remembered.current[item.key] || (company?.key === item.key ? selectedId : null)))}><span className="cw-company-avatar" aria-hidden="true">{item.name.slice(0, 1)}</span><span className="cw-company-copy"><strong>{item.name}</strong><span>{item.projects.length > 1 ? `${item.projects.length} 个项目` : item.projects[0].dataOrigin === 'research' ? publicSourceLabel(item.projects[0]) : item.projects[0].contact || item.projects[0].industry || '待补充联系人'}</span></span>{item.projects.some(project => drafts[project.id]?.query || drafts[project.id]?.note || failures[project.id]) && <span className="cw-draft-dot" title="有未保存草稿" aria-label="有未保存草稿" />}</button>)}</nav>
      {!filtered.length && <div className="cw-directory-empty"><Building2 size={24} /><p>{search ? '没有匹配的企业或项目' : directoryScope === 'archived' ? '暂无归档企业' : '暂无当前企业'}</p>{!search && <button className="button secondary" disabled={locked} onClick={() => openForm('create', true)}>新建企业</button>}</div>}
      <footer className="cw-directory-footer">{directoryScope === 'archived' ? '历史资料与原项目链接继续保留' : member.role === 'sales' ? '显示你有权限访问的企业' : '显示当前团队可访问企业'}</footer>
    </aside>

    <section className="cw-conversation" aria-label="企业 AI 对话">
      {deal ? <>
        <header className="cw-chat-header"><button className="button ghost cw-mobile-back" aria-label="返回企业通讯录" disabled={locked} onClick={() => setMobilePanel('directory')}><ArrowLeft size={17} /></button><div className="cw-chat-title"><h2>{company?.name || deal.name}</h2><div>{company && company.projects.length > 1 ? <label className="cw-project-select"><span className="sr-only">选择企业项目</span><select value={deal.id} disabled={locked} onChange={event => selectProject(event.target.value)}>{company.projects.map(project => <option key={project.id} value={project.id}>{project.projectName || project.name}</option>)}</select></label> : <span>{deal.projectName || '企业项目'}</span>}{deal.archive && <span className="cw-stage">已归档</span>}{deal.dataOrigin === 'research' && <span className="cw-stage">{publicSourceLabel(deal)}</span>}<span className="cw-stage">{deal.stage}{deal.outcome === 'won' ? ' · 已成单' : deal.outcome === 'lost' ? ' · 已结束' : ''}</span></div></div><div className="cw-header-actions">{member.role !== 'admin' && <AgentMemoryButton key={deal.id} project={{ id: deal.id, label: deal.projectName || deal.name }} disabled={locked} />}<button className="button ghost" aria-label="查看客户资料" title="客户资料与销售分析" aria-expanded={isMobile ? mobilePanel === 'profile' : profileOpen} aria-controls={`${id}-insights`} disabled={locked} onClick={() => { setProfileOpen(value => isMobile || !value); setMobilePanel('profile'); }}><PanelRight size={17} /><span>客户资料</span></button><details className="cw-actions" ref={menu} onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}><summary aria-label="项目操作" title="项目操作"><MoreHorizontal size={18} /></summary><div><button disabled={locked} onClick={() => openForm('edit')}>编辑项目资料</button><button disabled={locked} onClick={() => openForm('profile')}>编辑客户画像</button><button disabled={locked} onClick={() => openForm('create')}>为此企业新增项目</button><button disabled={locked} onClick={() => openForm('lifecycle')}>推进阶段与结果</button>{onNavigate && <button disabled={locked} onClick={() => navigate('contracts')}>查看项目合同</button>}</div></details></div></header>
        {deal.archive && <div className="cw-record-status" role="status"><strong>归档历史</strong><p>{fullDate(deal.archive.at)} · {deal.archive.reason}。历史对话与资料继续保留。</p></div>}
        <div className="cw-chat-stream" ref={stream} tabIndex={0} aria-label="当前项目对话历史" onScroll={() => { const element = stream.current; if (!element) return; followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; setShowLatest(!followLatest.current); }}>
          {!history.length && !pending && <div className="cw-chat-welcome"><div className="cw-welcome-mark"><Sparkles size={24} /></div><h3>{deal.dataOrigin === 'research' && !salesReportEligible(deal) ? '了解' : '一起推进'}{company?.name || deal.name}</h3><p>{deal.dataOrigin === 'research' && !salesReportEligible(deal) ? '先核对公开资料、适用场景与负责部门，记录实际沟通后再补充客户事实。' : '结合当前项目的资料，梳理需求、准备沟通和确认下一步。'}</p><div>{[{ label: '梳理客户需求', query: '请结合当前项目资料梳理客户需求、决策人及待确认信息', agent: 'insight' }, { label: '准备下一次沟通', query: '请为当前项目准备下一次沟通的议程、开场和需确认的问题', agent: 'strategy' }, { label: '分析推进重点', query: '请分析当前项目的推进重点、风险和下一步行动', agent: 'opportunity' }].map(item => <button className="button secondary" key={item.agent} disabled={locked} onClick={() => { updateDraft({ query: item.query, agent: item.agent as AgentId }); composer.current?.focus(); }}>{item.label}</button>)}</div></div>}
          {history.map(run => <article className="cw-chat-turn" key={run.id}><div className="cw-user-message">{run.query}</div><div className="cw-assistant-label"><Sparkles size={15} /><strong>AI 营销助手</strong><span>{runGenerationLabel(run)}</span></div>{run.answer ? <AnswerContent text={runAnswerForDisplay(run.answer)} /> : <p className="cw-muted">此次运行尚未返回回答。</p>}{run.status && run.status !== 'completed' && <p className="cw-error">{run.status === 'failed' ? '本次任务未完成。' : `任务状态：${run.status}`}</p>}{run.citations.length > 0 && <details className="cw-citations"><summary>参考来源 · {run.citations.length} <ChevronDown size={13} /></summary>{run.citations.map((citation, index) => <details key={`${citation.id}:${index}`}><summary>{citation.title}</summary><p>{citation.excerpt}</p></details>)}</details>}<div className="cw-turn-footer"><time>{date(run.createdAt)}</time>{run.steps.length > 0 && <details><summary>处理过程 <ChevronDown size={12} /></summary><ol>{run.steps.map(step => <li key={step.id}><strong>{step.title}</strong><p>{step.detail}</p></li>)}</ol></details>}<button type="button" onClick={() => void navigator.clipboard.writeText(run.answer).then(() => notify('已复制回答')).catch(() => notify('浏览器未允许复制，请选择文本复制。'))}>复制</button></div></article>)}
          {pending?.dealId === deal.id && <div className="cw-chat-turn" role="status"><div className="cw-user-message">{pending.query}</div><p className="cw-thinking"><Loader2 size={16} className="spin" />正在结合当前项目资料思考…</p></div>}
          {failure && <div className="cw-failed" role="alert"><p className="cw-failed-query">{failure.request.query}</p><p>{failure.error}</p><button className="button secondary" disabled={locked} onClick={() => void send(failure.request)}>重试本次问题</button><button className="button ghost" disabled={locked} onClick={() => setFailures(current => { const next = { ...current }; delete next[deal.id]; return next; })}>关闭错误提示</button></div>}
        </div>
        {showLatest && <button className="button secondary cw-jump" onClick={() => { followLatest.current = true; stream.current?.scrollTo({ top: stream.current.scrollHeight, behavior: 'smooth' }); setShowLatest(false); }}><ArrowDown size={14} />最新消息</button>}
        <form className="cw-composer" onSubmit={submitChat}><label htmlFor={`${id}-query`} className="sr-only">向 AI 询问当前项目</label><textarea ref={composer} id={`${id}-query`} value={draft.query} onChange={event => updateDraft({ query: event.target.value })} disabled={locked} maxLength={6000} rows={3} placeholder={`关于${company?.name || deal.name}，你想了解什么？`} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /><div className="cw-composer-tools"><label htmlFor={`${id}-agent`}><span className="sr-only">选择 AI 助手</span><select id={`${id}-agent`} value={draft.agent} onChange={event => updateDraft({ agent: event.target.value as Draft['agent'] })} disabled={locked}><option value="">自动选择助手</option>{AGENTS.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label><span>{state.model.connected ? '结合当前项目资料' : '客户洞察需连接大模型'}</span><button className="button primary" type="submit" disabled={locked || !draft.query.trim()} aria-label="发送当前项目问题">{pending ? <Loader2 size={16} className="spin" /> : <ArrowUp size={16} />}发送</button></div></form>
      </> : <div className="cw-no-selection"><Building2 size={32} /><h2>{unavailable ? '该项目不可访问' : '选择一家企业，开始推进'}</h2><p>{unavailable ? '项目可能已移除，或当前账号没有访问权限。请从企业通讯录选择可访问项目。' : '企业资料、对话和下一步建议都会保留在这里。'}</p><button className="button secondary cw-mobile-show-directory" onClick={() => setMobilePanel('directory')}>查看企业通讯录</button><button className="button secondary" disabled={locked} onClick={() => openForm('create', true)}><Plus size={15} />新建企业或项目</button></div>}
    </section>

    <aside className="cw-insights" id={`${id}-insights`} aria-label="客户资料与销售分析">
      <header className="cw-insights-heading">
        <button className="button ghost cw-mobile-back" aria-label="返回项目对话" disabled={locked} onClick={() => setMobilePanel('chat')}><ArrowLeft size={17} /></button>
        <h2>客户资料</h2>
        {deal && <button type="button" className="button secondary cw-intent-summary" aria-controls={`${id}-assessment`} title="查看 AI 销售分析" onClick={() => {
          assessment.current?.scrollIntoView({ block: 'start' });
          assessment.current?.focus({ preventScroll: true });
        }}>
          <span>{intentLabel}</span>
          {intentScore !== null && <span className="cw-intent-score"><span className="sr-only">意向评分 </span><strong>{intentScore}</strong> / 100</span>}
          <ChevronDown size={12} aria-hidden="true" />
          <span className="sr-only">，查看 AI 销售分析</span>
        </button>}
        <button className="button ghost" aria-label="收起客户资料" onClick={() => { setProfileOpen(false); setMobilePanel('chat'); }}><X size={17} /></button>
      </header>
      {deal ? <div className="cw-insights-body">{error && !mode && <p className="cw-error" role="alert">{error}</p>}<section className="cw-profile-section"><div className="cw-section-heading"><h3>企业与联系人</h3><button disabled={locked} onClick={() => openForm('edit')}>编辑</button></div><h4>{deal.name}</h4><dl className="cw-profile-facts"><div><dt>联系人</dt><dd>{deal.contact || '待补充'}{deal.position ? ` · ${deal.position}` : ''}</dd></div><div><dt>行业</dt><dd>{deal.industry || '待补充'}</dd></div><div><dt>负责人</dt><dd>{deal.owner}</dd></div><div><dt>项目</dt><dd>{deal.projectName || '未填写项目名称'}</dd></div>{deal.deadline && <div><dt>截止时间</dt><dd>{date(deal.deadline)}</dd></div>}</dl>{deal.summary && <p>{deal.summary}</p>}<div className="cw-section-heading"><h3>客户确认资料</h3><button disabled={locked} onClick={() => openForm('profile')}>补充</button></div><dl className="cw-profile-facts">{profileLabels.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{deal.customerProfile?.[key] || '待确认'}</dd></div>)}</dl>{deal.needs.length > 0 && <><h3>关键需求</h3><ul>{deal.needs.map((need, index) => <li key={index}>{need}</li>)}</ul></>}</section>
        <section className="cw-profile-section"><div className="cw-section-heading"><h3>公开企业资料</h3><button disabled={locked} onClick={() => void perform('deal_enrich', { dealId: deal.id, version: deal.version }, '企业资料已更新')}>{busy ? '处理中…' : deal.companyProfile ? '更新' : '补全'}</button></div>{deal.companyProfile ? <><p className="cw-muted">{deal.companyProfile.status === 'partial' ? '部分资料待核实' : '已整理公开资料'} · 核验时间：{fullDate(deal.companyProfile.updatedAt)}</p><p>{deal.companyProfile.summary || '暂未形成企业摘要。'}</p><dl className="cw-profile-facts">{deal.companyProfile.facts.map((fact, index) => <div key={index}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>{deal.companyProfile.warnings.map((warning, index) => <p key={index} className="cw-muted">{warning}</p>)}<details className="cw-sources"><summary>资料来源 · {deal.companyProfile.sources.length}<ChevronDown size={13} /></summary>{deal.companyProfile.sources.map((source, index) => <p key={`${source.id}:${index}`}>{safeUrl(source.url) ? <a href={safeUrl(source.url)} target="_blank" rel="noopener noreferrer">{source.title}</a> : source.title}<small>{source.snippet?.split('\n').find(line => line.startsWith('资料日期：')) || '资料日期未标注'} · 核验时间：{fullDate(source.retrievedAt)}</small>{source.snippet && <span className="cw-source-excerpt">{source.snippet}</span>}</p>)}</details></> : <p className="cw-muted">尚未补全公开资料。先核对企业全称，再检索有来源的企业信息。</p>}</section>
        <div id={`${id}-assessment`} ref={assessment} tabIndex={-1}>
          <ProjectSalesIntelligence key={deal.id} deal={deal} mutate={mutate} notify={notify} modelConnected={state.model.connected} disabled={locked} onBusyChange={onAssessmentBusy} onReload={onReload} />
        </div>
        <section className="cw-profile-section cw-next-action"><h3>当前下一步</h3><p>{deal.nextAction || '尚未填写下一步。可让 AI 梳理待确认信息，再与客户核对。'}</p><button className="button secondary" disabled={locked} onClick={() => { updateDraft({ query: '请结合当前项目已确认的信息与资料缺口，给出下一步行动、沟通问题及理由', agent: 'strategy' }); setMobilePanel('chat'); composer.current?.focus(); }}>与 AI 讨论下一步</button></section>
        <details className="cw-materials"><summary><FileText size={15} />项目资料 <span>{deal.notes.length} 条原话</span><ChevronDown size={14} /></summary><div><label htmlFor={`${id}-note`}>保存客户原话或沟通事实</label><textarea id={`${id}-note`} rows={3} maxLength={4000} disabled={locked} value={draft.note} onChange={event => updateDraft({ note: event.target.value })} placeholder="只记录已确认的原话、事实与约定" /><button className="button secondary" disabled={locked || !draft.note.trim()} onClick={() => void saveNote()}>保存原话</button>{[...deal.notes].sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0)).map(note => <article className="cw-saved-note" key={note.id}><p>{note.text}</p><small>{note.author} · {date(note.date)}</small>{note.recording && <FollowupRecordingPlayer dealId={deal.id} recording={note.recording} />}</article>)}{(state.transcripts || []).filter(item => item.dealId === deal.id).map(item => <details className="cw-saved-note" key={item.id}><summary>通话转写 · {date(item.createdAt)}</summary><p>{item.text}</p></details>)}</div></details>
      </div> : <p className="cw-muted">选择项目后查看客户资料。</p>}
    </aside>

    {mode && <dialog className="cw-dialog" ref={dialog} aria-labelledby={`${id}-form-title`} onCancel={event => { event.preventDefault(); closeForm(); }}><header><h2 id={`${id}-form-title`}>{mode === 'create' ? '新建企业项目' : mode === 'edit' ? '编辑项目资料' : mode === 'profile' ? '编辑客户画像' : '推进阶段与结果'}</h2><button className="button ghost" aria-label="关闭资料编辑" disabled={locked} onClick={closeForm}><X size={18} /></button></header>
      {mode === 'create' && <details className="cw-intake-option"><summary>用 AI 录入客户信息<ChevronDown size={14} /></summary><ProjectIntake state={state} mutate={mutate} notify={notify} onBusyChange={onIntakeBusy} onDirtyChange={onIntakeDirty} onCreated={target => { setIntakeDirty(false); if (formDirty) { notify('AI 项目已创建，手动录入草稿仍保留；可以继续保存为另一项目，或取消编辑。'); return; } setMode(null); setDirectoryScope('active'); followLatest.current = true; setSelectedId(target); setMobilePanel('chat'); }} /></details>}
      {mode !== 'lifecycle' ? <form onSubmit={saveForm} aria-busy={locked}><fieldset disabled={locked}>{mode === 'profile' ? <div className="cw-form-grid">{profileLabels.map(([key, label]) => <label className="cw-wide" key={key} htmlFor={`${id}-profile-${key}`}>{label}<textarea id={`${id}-profile-${key}`} rows={2} maxLength={2000} value={customerFields[key]} onChange={event => setCustomerFields({ ...customerFields, [key]: event.target.value })} /></label>)}</div> : fieldsForm(mode === 'create')}</fieldset>{error && <p className="cw-error" role="alert">{error}</p>}<footer><button className="button ghost" type="button" disabled={locked} onClick={closeForm}>取消</button><button className="button primary" disabled={locked || (mode !== 'profile' && (!fields.name.trim() || !fields.projectName.trim()))}>{busy ? <Loader2 size={15} className="spin" /> : null}{mode === 'create' ? '创建项目' : '保存资料'}</button></footer></form> : deal && <div className="cw-lifecycle"><p>当前项目：{deal.projectName || deal.name} · {deal.owner}</p><label htmlFor={`${id}-lifecycle-stage`}>推进阶段<select id={`${id}-lifecycle-stage`} disabled={locked} value={stage} onChange={event => { setStage(event.target.value); setConfirmed(false); }}>{STAGES.map(value => <option key={value}>{value}</option>)}</select></label><label htmlFor={`${id}-outcome`}>项目结果<select id={`${id}-outcome`} disabled={locked} value={outcome} onChange={event => { setOutcome(event.target.value); setConfirmed(false); }}><option value="open">继续推进</option><option value="won">确认成单</option><option value="lost">结束未成单项目</option></select></label><label className="cw-confirm"><input type="checkbox" checked={confirmed} disabled={locked} onChange={event => setConfirmed(event.target.checked)} />我已核实客户事实，确认手动更新此项目</label>{error && <p className="cw-error" role="alert">{error}</p>}<footer><button className="button secondary" disabled={locked || !formTarget || !confirmed || stage === deal.stage} onClick={async () => { if (formTarget && await perform('deal_stage', { ...formTarget, stage, confirmed: true }, '阶段已更新')) setMode(null); }}>更新阶段</button><button className="button primary" disabled={locked || !formTarget || !confirmed || outcome === (deal.outcome || 'open')} onClick={async () => { if (formTarget && await perform('deal_outcome', { ...formTarget, outcome, confirmed: true }, '项目结果已更新')) setMode(null); }}>确认结果</button></footer></div>}
    </dialog>}
    {confirmManualSave && <Overlay className="confirmation-dialog" title="AI 录入草稿尚未保存" onClose={() => setConfirmManualSave(false)}><p>继续创建手动项目将放弃尚未提交的 AI 录入原话。</p><div className="contract-leave-actions"><button data-dialog-initial-focus="true" className="button secondary" onClick={() => setConfirmManualSave(false)}>继续编辑</button><button className="button primary" onClick={() => { setConfirmManualSave(false); void saveForm(undefined, true); }}>放弃 AI 草稿并创建项目</button></div></Overlay>}
  </div>;
}
