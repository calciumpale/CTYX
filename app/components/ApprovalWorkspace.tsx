'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { AlertCircle, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, CheckCircle2, ChevronRight, ClipboardCheck, Copy, FileText, GitBranch, History, Loader2, Plus, RefreshCw, Save, Search, Send, ShieldCheck, Trash2, X } from 'lucide-react';
import type { View, WorkbenchState } from '../lib/types';
import type { ApprovalActor, ApprovalKind, ApprovalRequest, ApprovalRouteStep, ApprovalStatus, ApprovalTemplate, BusinessCondition } from '../lib/approval-types';
import type { ContractDocument } from '../lib/contract-types';
import { ApprovalClientError, decideApproval, deleteApprovalTemplate, getApproval, listApprovals, saveApprovalTemplate, submitApproval, withdrawApproval, type ApprovalListResult, type ApprovalScope } from '../lib/approval-client';
import { ContractShieldIllustration } from './VisualIllustrations';
import './studio.css';
import './approval-workspace.css';

type Props = { templatesOnly?: boolean; embeddedHeading?: boolean; state: WorkbenchState; notify: (message: string) => void; onNavigate?: (view: View, id?: string) => void; initialDealId?: string | null; initialContractId?: string | null; initialApprovalId?: string | null; onBusyChange?: (busy: boolean) => void; onDirtyChange?: (dirty: boolean) => void; onReloadWorkspace?: () => Promise<void> };
type Screen = 'list' | 'new' | 'detail' | 'templates';
type Draft = { id: string; kind: ApprovalKind; projectId: string; contractId: string; title: string; reason: string; deadline: string; conditions: BusinessCondition[]; steps: ApprovalRouteStep[]; templateId: string; previousRequestId?: string };
type TemplateDraft = { id: string; name: string; kind: ApprovalKind; steps: ApprovalRouteStep[]; version: number };
const STATUS: Record<ApprovalStatus, string> = { pending: '审批中', approved: '已通过', rejected: '已驳回', returned: '已退回', withdrawn: '已撤回', superseded: '已失效' };
const STEP_STATUS = { waiting: '待流转', pending: '审批中', approved: '已通过', rejected: '已驳回', returned: '已退回' };
const ROLES: Record<ApprovalRouteStep['role'], string> = { manager: '销售管理者', finance: '财务', legal: '法务', executive: '负责人', other: '自定义' };
const KIND: Record<ApprovalKind, string> = { business: '商务条件', contract: '合同审批' };
const EVENT = { submit: '提交申请', approve: '通过', reject: '驳回', return: '退回修改', withdraw: '撤回申请', supersede: '合同内容已变更，审批失效' };
const uid = () => crypto.randomUUID();
const date = (value?: string) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '未设置';
const normalizedEmail = (value: string) => value.trim().toLowerCase();
const isSameActor = (actor: ApprovalActor, identity: ApprovalActor | undefined) => Boolean(identity && actor.id === identity.id);
const localDateTime = (value: string) => { const at = new Date(value); return new Date(at.getTime() - at.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const route = (): ApprovalRouteStep[] => (['manager', 'finance', 'legal'] as const).map(role => ({ id: uid(), role, label: `${ROLES[role]}审批`, approverName: '', approverEmail: '' }));
const condition = (): BusinessCondition => ({ id: uid(), category: '价格与折扣', subject: '', baseline: '', proposed: '', reason: '' });
const emptyDraft = (projectId = '', contract?: ContractDocument): Draft => ({ id: uid(), kind: contract ? 'contract' : 'business', projectId, contractId: contract?.id ?? '', title: contract ? `${contract.title}审批` : '', reason: '', deadline: '', conditions: [condition()], steps: route(), templateId: '' });
const templateDraft = (template?: ApprovalTemplate): TemplateDraft => template ? { id: template.id, name: template.name, kind: template.kind, steps: template.steps.map(item => ({ ...item })), version: template.version } : { id: uid(), name: '', kind: 'business', steps: route(), version: 0 };
const signature = (value: unknown) => JSON.stringify(value);
const message = (failure: unknown) => failure instanceof Error ? failure.message : '操作未完成，编辑内容已保留，请重试。';
const routeError = (steps: ApprovalRouteStep[], identity?: ApprovalActor) => {
  if (steps.length < 1 || steps.length > 8) return '审批流程需要 1 至 8 个节点。';
  if (steps.some(step => !step.label.trim() || !step.approverName.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(step.approverEmail.trim()))) return '请为每个节点填写名称、审批人姓名和有效的登录邮箱。';
  if (identity && steps.some(step => normalizedEmail(step.approverEmail) === normalizedEmail(identity.email))) return '申请人不能审批自己的申请，请指定其他审批人。';
  return '';
};

function Status({ status }: { status: ApprovalStatus }) { return <span className={`approval-status approval-status-${status}`}>{status === 'approved' && <Check size={13} />}{STATUS[status]}</span>; }
function Empty({ title, children, icon = 'inbox' }: { title: string; children: React.ReactNode; icon?: 'inbox' | 'route' }) {
  return <div className="approval-empty">
    {icon === 'route' ? <span className="approval-empty-badge"><GitBranch size={24} /></span> : <ContractShieldIllustration />}
    <h2>{title}</h2>
    <div>{children}</div>
  </div>;
}

function RouteEditor({ steps, onChange, disabled }: { steps: ApprovalRouteStep[]; onChange: (steps: ApprovalRouteStep[]) => void; disabled: boolean }) {
  const update = (id: string, field: keyof ApprovalRouteStep, value: string) => onChange(steps.map(step => step.id === id ? { ...step, [field]: value } : step));
  const move = (index: number, direction: -1 | 1) => { const next = [...steps]; [next[index], next[index + direction]] = [next[index + direction], next[index]]; onChange(next); };
  return <div className="approval-route-editor"><ol>{steps.map((step, index) => <li key={step.id}><div className="approval-route-number" aria-label={`第 ${index + 1} 级`}>{index + 1}</div><div className="approval-route-fields"><label>节点名称<input value={step.label} maxLength={100} required disabled={disabled} onChange={event => update(step.id, 'label', event.target.value)} placeholder="例如：财务审批" /></label><label>审批职责<select value={step.role} disabled={disabled} onChange={event => update(step.id, 'role', event.target.value)}>{Object.entries(ROLES).map(([key, value]) => <option value={key} key={key}>{value}</option>)}</select></label><label>审批人姓名<input value={step.approverName} maxLength={100} required disabled={disabled} autoComplete="off" onChange={event => update(step.id, 'approverName', event.target.value)} placeholder="填写实际审批人" /></label><label>登录邮箱<input type="email" value={step.approverEmail} maxLength={254} required disabled={disabled} autoComplete="off" onChange={event => update(step.id, 'approverEmail', event.target.value)} placeholder="name@company.com" /></label></div><div className="approval-route-tools"><button type="button" className="studio-icon-button" aria-label={`上移第 ${index + 1} 级`} disabled={disabled || index === 0} onClick={() => move(index, -1)}><ArrowUp size={16} /></button><button type="button" className="studio-icon-button" aria-label={`下移第 ${index + 1} 级`} disabled={disabled || index === steps.length - 1} onClick={() => move(index, 1)}><ArrowDown size={16} /></button><button type="button" className="studio-icon-button" aria-label={`删除第 ${index + 1} 级`} disabled={disabled || steps.length === 1} onClick={() => onChange(steps.filter(item => item.id !== step.id))}><Trash2 size={16} /></button></div></li>)}</ol><button type="button" className="studio-btn studio-btn-secondary" disabled={disabled || steps.length >= 8} onClick={() => onChange([...steps, { id: uid(), role: 'other', label: '', approverName: '', approverEmail: '' }])}><Plus size={15} />添加审批节点<span className="approval-secondary">{steps.length}/8</span></button><p className="approval-hint">审批人须有本站访问权限，邮箱须与其登录账号一致。各级通过后完成审批。</p></div>;
}

function ContractSnapshot({ contract }: { contract: ContractDocument }) {
  return <div className="approval-contract-snapshot"><div className="approval-contract-meta"><strong>{contract.title}</strong><span>{contract.contractType} · 我方{contract.ourParty} · 保存版本 {contract.version}</span>{contract.focus && <p>审查重点：{contract.focus}</p>}</div><div className="approval-contract-columns"><section><h3><FileText size={17} />合同正文</h3><div className="approval-contract-text" tabIndex={0} aria-label="提交时的合同正文">{contract.text}</div></section><section><h3><ShieldCheck size={17} />已有 AI 初审意见</h3>{contract.analysis ? <div className="approval-contract-risks"><p>{contract.analysis.summary}</p><small>初审时间：{date(contract.reviewedAt)} · 人工审批需独立核对原文。</small>{contract.analysis.findings.length === 0 && <p>本次初审未标出风险条款。</p>}{contract.analysis.findings.map(finding => <article key={finding.id}><div><span className={`approval-risk approval-risk-${finding.level}`}>{({ high: '高风险', medium: '中风险', low: '低风险' })[finding.level]}</span><strong>{finding.title}</strong></div><blockquote>{finding.quote}</blockquote><p>{finding.reason}</p><p><strong>修改建议：</strong>{finding.suggestion}</p>{finding.replacement && <details><summary>查看建议条款</summary><p>{finding.replacement}</p></details>}</article>)}{contract.analysis.missingItems.map(item => <article key={item.id}><strong>缺失条款：{item.title}</strong><p>{item.reason}</p><p>{item.suggestion}</p></article>)}{contract.analysis.warnings.map((warning, index) => <p className="approval-hint" key={index}>{warning}</p>)}</div> : <div className="approval-no-review"><AlertCircle size={20} /><h4>尚未进行 AI 初审</h4><p>此申请仍可交由人工审批，请审批人直接核对合同正文。</p></div>}</section></div></div>;
}

export function ApprovalWorkspace({ templatesOnly = false, embeddedHeading = false, state, notify, onNavigate, initialDealId, initialContractId, initialApprovalId, onBusyChange, onDirtyChange, onReloadWorkspace }: Props) {
  const prefix = useId();
  const Heading=templatesOnly||embeddedHeading?'h2':'h1';
  const heading = useRef<HTMLHeadingElement>(null);
  const [screen, setScreen] = useState<Screen>(templatesOnly ? 'templates' : 'list');
  const [scope, setScope] = useState<ApprovalScope>(state.role === 'sales' ? 'mine' : 'inbox');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<ApprovalStatus | ''>('');
  const [projectId, setProjectId] = useState(initialDealId ?? '');
  const [previousInitialDealId, setPreviousInitialDealId] = useState(initialDealId);
  const [cursors, setCursors] = useState<string[]>(['']);
  const [data, setData] = useState<ApprovalListResult | null>(null);
  const [loadedListKey, setLoadedListKey] = useState('');
  const [listError, setListError] = useState('');
  const [reload, setReload] = useState(0);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<ApprovalRequest | null>(null);
  const [loadedDetailKey, setLoadedDetailKey] = useState('');
  const [detailError, setDetailError] = useState('');
  const [detailReload, setDetailReload] = useState(0);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(initialDealId ?? ''));
  const [draftBaseline, setDraftBaseline] = useState(() => signature(draft));
  const [template, setTemplate] = useState<TemplateDraft | null>(null);
  const [templateBaseline, setTemplateBaseline] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<(() => void) | null>(null);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const initialHandled = useRef('');
  const identity = data?.identity;
  const canManageTemplates=templatesOnly||state.role==='manager';
  const dirty = (screen === 'new' && signature(draft) !== draftBaseline) || (screen === 'templates' && Boolean(template && signature(template) !== templateBaseline)) || (screen === 'detail' && Boolean(note.trim()));
  const cursor = cursors[cursors.length - 1];
  const selectedContract = state.contracts?.find(item => item.id === draft.contractId && item.dealId === draft.projectId);
  const templates = data?.templates ?? [];
  const activeTemplates = templates.filter(item => item.kind === draft.kind);
  const visibleProjects = useMemo(() => { const result = new Map(state.deals.map(item => [item.id, item.projectName || item.name])); for (const item of data?.requests ?? []) if (!result.has(item.projectId)) result.set(item.projectId, item.projectName); return [...result]; }, [state.deals, data?.requests]);
  const isApplicant = detail ? isSameActor(detail.applicant, identity) : false;
  const currentStep = detail?.steps[detail.currentStep];
  const boundIdentity = detail?.history.find(event => event.action !== 'submit' && event.actor.email === identity?.email)?.actor.id;
  const canDecide = Boolean(detail?.status === 'pending' && !isApplicant && identity?.memberRole === 'manager' && currentStep?.status === 'pending' && normalizedEmail(currentStep.approverEmail) === normalizedEmail(identity.email) && normalizedEmail(detail.applicant.email) !== normalizedEmail(identity.email) && (!boundIdentity || boundIdentity === identity.id));
  const ownsProject = Boolean(isApplicant && detail && state.deals.some(item => item.id === detail.projectId));

  const openNew = useCallback((contract?: ContractDocument, previous?: ApprovalRequest) => {
    const next = previous ? { ...emptyDraft(previous.projectId, contract), kind: previous.kind, title: previous.title, reason: previous.reason, deadline: previous.deadline ? localDateTime(previous.deadline) : '', conditions: previous.snapshot.conditions?.map(item => ({ ...item, id: uid() })) ?? [condition()], steps: previous.steps.map(({ label, role, approverName, approverEmail }) => ({ id: uid(), label, role, approverName, approverEmail })), previousRequestId: previous.id } : emptyDraft(contract?.dealId || initialDealId || projectId, contract);
    setDraftBaseline(signature(next)); setDraft(next); setScreen('new'); setError(''); setConflict(false); setNote('');
  }, [initialDealId, projectId]);
  if (previousInitialDealId !== initialDealId) { setPreviousInitialDealId(initialDealId); if (initialDealId) { setProjectId(initialDealId); setCursors(['']); } }
  const sourceVersions = state.contracts?.map(item => `${item.id}:${item.version}`).join(',') ?? '';
  const listRequestKey = signature([scope, projectId, status, search, cursor, reload, initialApprovalId, initialContractId, sourceVersions]);
  const detailRequestKey = signature([selectedId, detailReload]);
  const listLoading = loadedListKey !== listRequestKey;
  const detailLoading = screen === 'detail' && loadedDetailKey !== detailRequestKey;

  useEffect(() => { const timer = setTimeout(() => { setSearch(query.trim()); setCursors(['']); }, 300); return () => clearTimeout(timer); }, [query]);
  useEffect(() => {
    const abort = new AbortController();
    void listApprovals({ scope: templatesOnly ? 'templates' : scope, projectId, status, q: search, cursor, limit: 15 }, abort.signal).then(result => {
      if (abort.signal.aborted) return;
      setData(result); setListError('');
      const entry = initialApprovalId ? `request:${initialApprovalId}` : initialContractId ? `contract:${initialContractId}` : '';
      if (!entry || initialHandled.current === entry) return;
      initialHandled.current = entry;
      if (initialApprovalId) { setSelectedId(initialApprovalId); setDetailReload(value => value + 1); setScreen('detail'); }
      else if (initialContractId) { const contract = state.contracts?.find(item => item.id === initialContractId); if (contract) openNew(contract); else setError('未找到这份已保存合同。请返回合同初审，确认保存后再发起审批。'); }
    }).catch(failure => { if (!abort.signal.aborted) setListError(message(failure)); }).finally(() => { if (!abort.signal.aborted) setLoadedListKey(listRequestKey); });
    return () => abort.abort();
  }, [scope, projectId, status, search, cursor, reload, listRequestKey, initialApprovalId, initialContractId, state.contracts, openNew, templatesOnly]);
  useEffect(() => {
    if (screen !== 'detail' || !selectedId) return;
    const abort = new AbortController();
    void getApproval(selectedId, abort.signal).then(result => { if (!abort.signal.aborted) { setDetail(result.request); setDetailError(''); setData(previous => previous ? { ...previous, identity: result.identity } : previous); } }).catch(failure => { if (!abort.signal.aborted) { setDetail(null); setDetailError(message(failure)); } }).finally(() => { if (!abort.signal.aborted) setLoadedDetailKey(detailRequestKey); });
    return () => abort.abort();
  }, [screen, selectedId, detailReload, detailRequestKey]);
  useEffect(() => { onBusyChange?.(Boolean(busy)); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => { const guard = (event: BeforeUnloadEvent) => { if (dirty || busyRef.current) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard); }, [dirty]);
  const prevScreen = useRef<Screen>(screen);
  useEffect(() => {
    if (prevScreen.current !== screen && screen !== 'list') heading.current?.focus();
    prevScreen.current = screen;
  }, [screen]);
  const clearAction = () => { setError(''); setConflict(false); setConfirmWithdraw(false); setConfirmDelete(false); setNote(''); };
  const navigate = (action: () => void) => { if (busyRef.current) return; if (dirty) { setPendingNavigation(() => action); return; } clearAction(); action(); };
  const updateDraft = <K extends keyof Draft>(field: K, value: Draft[K]) => { setDraft(previous => ({ ...previous, [field]: value })); setError(''); };
  const selectTemplate = (id: string) => { const source = templates.find(item => item.id === id && item.kind === draft.kind); setDraft(previous => ({ ...previous, templateId: id, steps: source ? source.steps.map(step => ({ ...step, id: uid() })) : route() })); };
  const start = (action: string) => { if (busyRef.current) return false; busyRef.current = true; setBusy(action); setError(''); setConflict(false); return true; };
  const finish = () => { busyRef.current = false; setBusy(''); };
  const fail = (failure: unknown) => { setError(message(failure)); setConflict(failure instanceof ApprovalClientError && failure.conflict); };
  const refresh = () => { setReload(value => value + 1); if (screen === 'detail') { setNote(''); setDetailReload(value => value + 1); } setError(''); setConflict(false); };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const invalid = routeError(draft.steps, identity); if (invalid) { setError(invalid); return; }
    if (!draft.projectId || !draft.title.trim() || !draft.reason.trim()) { setError('请填写关联项目、申请标题和申请说明。'); return; }
    if (draft.kind === 'contract' && !selectedContract) { setError('请选择一份已保存的关联项目合同。'); return; }
    if (draft.kind === 'business' && draft.conditions.some(item => !item.subject.trim() || !item.baseline.trim() || !item.proposed.trim() || !item.reason.trim())) { setError('请完整填写每条商务条件的事项、现有条件、申请条件和调整理由。'); return; }
    if (!start('submit')) return;
    try { const result = await submitApproval({ id: draft.id, projectId: draft.projectId, kind: draft.kind, title: draft.title.trim(), reason: draft.reason.trim(), ...(draft.deadline ? { deadline: new Date(draft.deadline).toISOString() } : {}), steps: draft.steps, ...(draft.kind === 'business' ? { conditions: draft.conditions } : { contractId: selectedContract!.id, contractVersion: selectedContract!.version }), ...(draft.previousRequestId ? { previousRequestId: draft.previousRequestId } : {}) }); setDraftBaseline(signature(draft)); setSelectedId(result.request.id); setDetailReload(value => value + 1); setDetail(result.request); setScreen('detail'); setReload(value => value + 1); notify(result.message || '审批申请已提交，正在等待第一级审批'); } catch (failure) { fail(failure); } finally { finish(); }
  };
  const decide = async (decision: 'approve' | 'reject' | 'return') => {
    if (!detail || !canDecide) return;
    if (decision !== 'approve' && !note.trim()) { setError('驳回或退回修改时，请先填写审批意见。'); return; }
    if (!start('decide')) return;
    try { const result = await decideApproval({ id: detail.id, version: detail.version, decision, note: note.trim() }); setDetail(result.request); setNote(''); setReload(value => value + 1); notify(result.message || `已${EVENT[decision]}`); } catch (failure) { fail(failure); } finally { finish(); }
  };
  const withdraw = async () => { if (!detail || !start('withdraw')) return; try { const result = await withdrawApproval({ id: detail.id, version: detail.version }); setDetail(result.request); setConfirmWithdraw(false); setReload(value => value + 1); notify(result.message || '审批申请已撤回'); } catch (failure) { fail(failure); } finally { finish(); } };
  const editTemplate = (source?: ApprovalTemplate) => { const next = templateDraft(source); setTemplateBaseline(signature(next)); setTemplate(next); setConfirmDelete(false); setError(''); };
  const saveTemplate = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (!template) return; const invalid = routeError(template.steps); if (invalid) { setError(invalid); return; } if (!template.name.trim()) { setError('请填写流程名称。'); return; } if (!start('template-save')) return; try { const result = await saveApprovalTemplate({ ...template, name: template.name.trim() }); const next = templateDraft(result.template); setTemplate(next); setTemplateBaseline(signature(next)); setReload(value => value + 1); notify(result.message || '审批流程已保存'); } catch (failure) { fail(failure); } finally { finish(); } };
  const removeTemplate = async () => { if (!template || !start('template-delete')) return; try { const result = await deleteApprovalTemplate({ id: template.id, version: template.version }); setTemplate(null); setTemplateBaseline(''); setConfirmDelete(false); setReload(value => value + 1); notify(result.message || '审批流程已删除'); } catch (failure) { fail(failure); } finally { finish(); } };
  const reloadWorkspace = async () => { if (!onReloadWorkspace || !start('workspace-reload')) return; try { await onReloadWorkspace(); setConflict(false); setError(''); notify('已重新读取项目和合同，请核对当前保存版本后提交'); } catch (failure) { fail(failure); } finally { finish(); } };
  const reloadTemplate = async () => { if (!start('template-reload')) return; try { const result = await listApprovals({ scope: templatesOnly ? 'templates' : 'all', limit: 15 }); setData(result); const current = result.templates.find(item => item.id === template?.id); if (current) editTemplate(current); else { setTemplate(null); setTemplateBaseline(''); } setConflict(false); setError(''); notify(current ? '已重新读取当前流程' : '该流程已被删除，请重新新建'); } catch (failure) { fail(failure); } finally { finish(); } };
  const openRequest = (id: string) => navigate(() => { setSelectedId(id); setDetailReload(value => value + 1); setScreen('detail'); });
  const back = () => navigate(() => setScreen('list'));
  const copyLink = () => { if (!detail) return; const url = new URL(window.location.href); url.search = ''; url.searchParams.set('view', 'approvals'); url.searchParams.set('approval', detail.id); void navigator.clipboard.writeText(url.toString()).then(() => notify('审批链接已复制，仅申请人与指定审批人可查看')).catch(() => notify('浏览器未允许复制，请手动复制地址。')); };

  return <div className="studio-view approval-workspace" aria-busy={Boolean(busy) || listLoading || detailLoading}>
    {!embeddedHeading && (
      <header className="page-header studio-heading approval-page-heading">
        <div>
          <Heading ref={heading} tabIndex={-1}>{templatesOnly ? '审批流程' : screen === 'new' ? '发起审批' : screen === 'detail' ? '审批详情' : '审批'}</Heading>
          {templatesOnly ? <p className="approval-subtitle">预设商务条件与合同签署的标准多级审批链路，供团队发起申请时直接选用。</p> : identity?.memberRole === 'manager' && <p className="approval-identity">审批邮箱：{identity.email}</p>}
        </div>
        <div className="approval-header-actions">
          <button type="button" className="studio-btn studio-btn-secondary" disabled={Boolean(busy) || listLoading} onClick={() => { if (screen === 'detail' && note.trim()) navigate(refresh); else refresh(); }} aria-label="刷新审批记录"><RefreshCw size={16} />刷新</button>
          {templatesOnly ? <button type="button" className="studio-btn studio-btn-primary" disabled={!identity || Boolean(busy) || !canManageTemplates} onClick={() => navigate(() => editTemplate())}><Plus size={16} />新建流程</button> : (screen === 'list' || screen === 'templates') && <button type="button" className="studio-btn studio-btn-primary" disabled={Boolean(busy) || !identity || !state.deals.length} onClick={() => navigate(() => openNew())}><Plus size={16} />发起审批</button>}
        </div>
      </header>
    )}
    {pendingNavigation && <div className="approval-confirm" role="alert"><div><strong>有尚未提交的内容</strong><p>离开后，本次填写的申请、流程修改或审批意见将不予保留。</p></div><div><button type="button" className="studio-btn studio-btn-secondary" onClick={() => setPendingNavigation(null)}>继续编辑</button><button type="button" className="studio-btn studio-btn-danger" onClick={() => { const action = pendingNavigation; setPendingNavigation(null); clearAction(); action(); }}>放弃并继续</button></div></div>}
    {error && <div className="approval-alert" role="alert"><AlertCircle size={18} /><div><p>{error}</p>{conflict && <p>{screen === 'new' && draft.kind === 'contract' ? '请重新读取项目和合同，核对最新保存版本。当前申请填写内容会保留。' : '记录可能已被其他人处理。重新读取后请核对当前状态。'}</p>}</div>{conflict && <button type="button" className="studio-btn studio-btn-secondary" disabled={Boolean(busy)} onClick={() => { if (screen === 'new' && draft.kind === 'contract' && onReloadWorkspace) void reloadWorkspace(); else if (screen === 'templates') navigate(() => { void reloadTemplate(); }); else if (screen === 'new') navigate(() => { setScope('mine'); setProjectId(draft.projectId); setCursors(['']); setScreen('list'); setReload(value => value + 1); }); else navigate(refresh); }}>{screen === 'new' && draft.kind === 'contract' && onReloadWorkspace ? '重新读取项目和合同' : screen === 'templates' ? '重新读取流程' : screen === 'new' ? '查看相关申请' : '刷新并核对'}</button>}{conflict && screen === 'new' && draft.kind === 'contract' && onReloadWorkspace && <button type="button" className="studio-btn studio-btn-ghost" disabled={Boolean(busy)} onClick={() => navigate(() => { setScope('mine'); setProjectId(draft.projectId); setCursors(['']); setScreen('list'); setReload(value => value + 1); })}>查看相关申请</button>}<button type="button" className="studio-icon-button" aria-label="收起提示" onClick={() => setError('')}><X size={16} /></button></div>}

    {(screen === 'list' || screen === 'templates') && <>{!templatesOnly && <div className="approval-subbar"><div className="approval-tabs" role="tablist" aria-label="审批分类">{([{ id: 'inbox', label: '待我审批' }, { id: 'mine', label: '我发起的' }, { id: 'all', label: '全部相关' }, { id: 'templates', label: '审批流程' }] as const).map((tab, index) => <button key={tab.id} id={`${prefix}-tab-${tab.id}`} role="tab" type="button" aria-selected={tab.id === 'templates' ? screen === 'templates' : screen === 'list' && scope === tab.id} aria-controls={`${prefix}-tabpanel`} tabIndex={(tab.id === 'templates' ? screen === 'templates' : screen === 'list' && scope === tab.id) ? 0 : -1} onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]'); const count=buttons?.length??1; const target = event.key === 'Home' ? 0 : event.key === 'End' ? count-1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + count) % count; buttons?.[target]?.focus(); buttons?.[target]?.click(); }} onClick={() => navigate(() => { if (tab.id === 'templates') setScreen('templates'); else { setScope(tab.id); setScreen('list'); setCursors(['']); } })}>{tab.label}{tab.id === 'inbox' && data && data.pendingCount > 0 && <span>{data.pendingCount}</span>}</button>)}</div>{embeddedHeading && <div className="approval-header-actions">{identity?.memberRole === 'manager' && <span className="approval-identity-pill">审批邮箱：{identity.email}</span>}<button type="button" className="studio-btn studio-btn-secondary" disabled={Boolean(busy) || listLoading} onClick={refresh} aria-label="刷新审批记录"><RefreshCw size={15} />刷新</button><button type="button" className="studio-btn studio-btn-primary" disabled={Boolean(busy) || !identity || !state.deals.length} onClick={() => navigate(() => openNew())}><Plus size={15} />发起审批</button></div>}</div>}<div id={`${prefix}-tabpanel`} role={templatesOnly ? undefined : 'tabpanel'} aria-labelledby={templatesOnly ? undefined : `${prefix}-tab-${screen === 'templates' ? 'templates' : scope}`}>
    {screen === 'list' && <><div className="approval-toolbar"><label className="approval-search"><Search size={17} /><span className="studio-sr-only">搜索审批标题、项目或申请人</span><input value={query} maxLength={200} onChange={event => setQuery(event.target.value)} placeholder="搜索审批标题、项目或申请人" />{query && <button type="button" className="studio-icon-button" aria-label="清空搜索" onClick={() => setQuery('')}><X size={15} /></button>}</label><label><span className="studio-sr-only">按状态筛选</span><select value={status} onChange={event => { setStatus(event.target.value as ApprovalStatus | ''); setCursors(['']); }}><option value="">全部状态</option>{Object.entries(STATUS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label><span className="studio-sr-only">按项目筛选</span><select value={projectId} onChange={event => { setProjectId(event.target.value); setCursors(['']); }}><option value="">全部项目</option>{visibleProjects.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label></div>
      {listLoading ? <div className="approval-loading" role="status"><Loader2 size={22} className="studio-spin" /><p>正在读取审批记录…</p></div> : listError ? <div className="approval-load-error" role="alert"><AlertCircle size={25} /><h2>审批记录读取失败</h2><p>{listError}</p><button type="button" className="studio-btn studio-btn-secondary" onClick={refresh}><RefreshCw size={15} />重新读取</button></div> : !data?.requests.length ? <Empty title={data?.nextCursor ? '本页没有符合条件的申请' : query || status || projectId ? '没有符合筛选条件的申请' : scope === 'inbox' ? '当前没有待你审批的申请' : scope === 'mine' ? '你还没有发起审批' : '尚无与你相关的审批'}><p>{data?.nextCursor ? '可继续查看下一页，或调整当前筛选。' : query || status || projectId ? '调整搜索、状态或项目筛选后再试。' : scope === 'inbox' ? '请确认发起人使用了你的登录邮箱。' : '可提交商务条件或已保存合同。'}</p>{query || status || projectId ? <button type="button" className="studio-btn studio-btn-secondary" onClick={() => { setQuery(''); setSearch(''); setStatus(''); setProjectId(''); setCursors(['']); }}>清除筛选</button> : scope !== 'inbox' && <button type="button" className="studio-btn studio-btn-primary" disabled={!identity || !state.deals.length} onClick={() => openNew()}><Plus size={15} />发起审批</button>}{!state.deals.length && scope !== 'inbox' && <p>先在项目中心建立项目，再发起审批。</p>}</Empty> : <><div className="approval-list"><div className="approval-list-head" aria-hidden="true"><span>申请与项目</span><span>当前进度</span><span>申请人</span><span>更新时间</span><span /></div><ul>{data.requests.map(item => <li key={item.id}><button type="button" className="approval-request-row" onClick={() => openRequest(item.id)}><div className="approval-request-title"><strong>{item.title}</strong><span className="approval-kind">{KIND[item.kind]}</span><small>{item.projectName} · {item.companyName}</small></div><div className="approval-request-progress"><Status status={item.status} /><small>{item.status === 'pending' ? `第 ${item.currentStep + 1}/${item.stepCount} 级 · ${item.currentApprover}` : `${item.stepCount} 级审批`}</small></div><div className="approval-request-applicant"><span>{item.applicant.name}</span><small>{item.applicant.email}</small></div><time dateTime={item.updatedAt}>{date(item.updatedAt)}</time><ChevronRight size={17} /></button></li>)}</ul></div></>}
      {!listLoading && !listError && data && (data.requests.length > 0 || data.nextCursor || cursors.length > 1) && <div className="approval-pagination"><span>第 {cursors.length} 页 · 本页 {data.requests.length} 条</span><div><button type="button" className="studio-btn studio-btn-secondary" disabled={cursors.length <= 1} onClick={() => setCursors(previous => previous.slice(0, -1))}><ArrowLeft size={15} />上一页</button><button type="button" className="studio-btn studio-btn-secondary" disabled={!data.nextCursor} onClick={() => setCursors(previous => [...previous, data.nextCursor!])}>下一页<ArrowRight size={15} /></button></div></div>}
    </>}
    {screen === 'templates' && <div className="approval-templates"><aside><div className="approval-section-heading"><h2>已保存流程</h2><button type="button" className="studio-btn studio-btn-secondary" disabled={!identity || Boolean(busy)||!canManageTemplates} onClick={() => navigate(() => editTemplate())}><Plus size={15} />新建</button></div>{listLoading && !data ? <p className="approval-hint">正在读取流程…</p> : listError ? <div className="approval-hint" role="alert">{listError}<button type="button" className="studio-btn studio-btn-secondary" onClick={refresh}>重试</button></div> : templates.length ? <ul className="approval-template-list">{templates.map(item => <li key={item.id}><button type="button" aria-pressed={template?.id === item.id} disabled={Boolean(busy)||!canManageTemplates} onClick={() => navigate(() => editTemplate(item))}><GitBranch size={18} /><span><strong>{item.name}</strong><small>{KIND[item.kind]} · {item.steps.length} 级 · {date(item.updatedAt)}</small></span><ChevronRight size={16} /></button></li>)}</ul> : <p className="approval-template-none">暂无已保存流程</p>}</aside><section className="approval-template-editor">{template ? <form className="approval-form" onSubmit={saveTemplate}><div className="approval-section-heading"><div><h2>{template.version ? '编辑审批流程' : '新建审批流程'}</h2><p>更改只用于后续申请，已提交的流程保持原样。</p></div>{template.version > 0 && <button type="button" className="studio-btn studio-btn-danger" disabled={Boolean(busy)||!canManageTemplates} onClick={() => setConfirmDelete(value => !value)}><Trash2 size={15} />删除</button>}</div><div className="approval-form-grid"><label>流程名称<input required maxLength={100} disabled={Boolean(busy)||!canManageTemplates} value={template.name} onChange={event => setTemplate({ ...template, name: event.target.value })} placeholder="例如：销售合同标准审批" /></label><label>适用类型<select disabled={Boolean(busy)||!canManageTemplates} value={template.kind} onChange={event => setTemplate({ ...template, kind: event.target.value as ApprovalKind })}><option value="business">商务条件</option><option value="contract">合同审批</option></select></label></div><h3 className="approval-route-heading">审批顺序</h3><RouteEditor steps={template.steps} disabled={Boolean(busy)||!canManageTemplates} onChange={steps => setTemplate({ ...template, steps })} />{confirmDelete && <div className="approval-confirm"><p>删除此流程后，已有申请和审批历史仍会保留。</p><div><button type="button" className="studio-btn studio-btn-secondary" disabled={Boolean(busy)||!canManageTemplates} onClick={() => setConfirmDelete(false)}>取消</button><button type="button" className="studio-btn studio-btn-danger" disabled={Boolean(busy)||!canManageTemplates} onClick={removeTemplate}>确认删除流程</button></div></div>}<div className="approval-form-actions"><button type="button" className="studio-btn studio-btn-ghost" disabled={Boolean(busy)||!canManageTemplates} onClick={() => navigate(() => setTemplate(null))}>关闭编辑</button><button type="submit" className="studio-btn studio-btn-primary" disabled={Boolean(busy) || !identity || !canManageTemplates}>{busy === 'template-save' ? <Loader2 size={16} className="studio-spin" /> : <Save size={16} />}保存流程</button></div></form> : <Empty title="暂无审批流程" icon="route"><button type="button" className="studio-btn studio-btn-primary" disabled={!identity || !canManageTemplates} onClick={() => editTemplate()}><Plus size={15} />新建流程</button></Empty>}</section></div>}
    </div></>}

    {screen === 'new' && <>
      <div className="approval-subpage-bar">
        <div className="approval-subpage-left">
          <button type="button" className="approval-back" disabled={Boolean(busy)} onClick={back}><ArrowLeft size={15} />返回审批列表</button>
          {embeddedHeading && <h2 ref={heading} tabIndex={-1} className="approval-subpage-title">{draft.previousRequestId ? '重新提交审批' : '发起审批'}</h2>}
        </div>
        {embeddedHeading && <div className="approval-header-actions">
          {identity?.memberRole === 'manager' && <span className="approval-identity-pill">审批邮箱：{identity.email}</span>}
          <button type="button" className="studio-btn studio-btn-ghost" disabled={Boolean(busy)} onClick={back}>取消</button>
          <button type="submit" form={`${prefix}-create-form`} className="studio-btn studio-btn-primary" disabled={Boolean(busy) || !identity}>{busy === 'submit' ? <Loader2 size={15} className="studio-spin" /> : <Send size={15} />}提交审批</button>
        </div>}
      </div>
      <form id={`${prefix}-create-form`} className="approval-form approval-create" onSubmit={submit}>
        <div className="approval-create-main">
          <section className="approval-section">
            <div className="approval-section-heading"><div><h2>{draft.previousRequestId ? '重新提交' : '申请信息'}</h2>{draft.previousRequestId && <p>将生成新申请，原记录与意见保留。</p>}</div></div>
            <div className="approval-form-grid">
              <label>审批类型<select disabled={Boolean(busy) || Boolean(draft.previousRequestId)} value={draft.kind} onChange={event => { const kind = event.target.value as ApprovalKind; setDraft(previous => ({ ...previous, kind, templateId: '', steps: route() })); }}><option value="business">商务条件</option><option value="contract">合同审批</option></select></label>
              <label>关联项目<select required disabled={Boolean(busy) || Boolean(draft.previousRequestId)} value={draft.projectId} onChange={event => setDraft(previous => ({ ...previous, projectId: event.target.value, contractId: '' }))}><option value="">选择项目</option>{state.deals.map(item => <option value={item.id} key={item.id}>{item.projectName || item.name} · {item.name}</option>)}</select></label>
              <label>申请标题<input required maxLength={150} disabled={Boolean(busy)} value={draft.title} onChange={event => updateDraft('title', event.target.value)} placeholder={draft.kind === 'business' ? '例如：年度合作价格与付款条件调整' : '例如：年度服务合同签署审批'} /></label>
              <label>期望完成时间<span>选填</span><input type="datetime-local" disabled={Boolean(busy)} value={draft.deadline} onChange={event => updateDraft('deadline', event.target.value)} /></label>
              <label className="approval-form-wide">申请说明<textarea className="approval-compact-textarea" required maxLength={5000} rows={2} disabled={Boolean(busy)} value={draft.reason} onChange={event => updateDraft('reason', event.target.value)} placeholder="说明申请背景、业务必要性和需要审批人重点确认的事项" /></label>
            </div>
          </section>
          {draft.kind === 'business' ? <section className="approval-section">
            <div className="approval-section-heading"><div><h2>商务条件</h2></div><button type="button" className="studio-btn studio-btn-secondary" disabled={Boolean(busy) || draft.conditions.length >= 20} onClick={() => updateDraft('conditions', [...draft.conditions, condition()])}><Plus size={15} />添加条件</button></div>
            <div className="approval-conditions-editor">{draft.conditions.map((item, index) => <fieldset key={item.id}>
              <legend className="studio-sr-only">条件 {index + 1}</legend>
              <div className="approval-condition-heading">
                <div className="approval-condition-heading-start">
                  <span className="approval-condition-badge">条件 {index + 1}</span>
                  <label>类别<select value={item.category} disabled={Boolean(busy)} onChange={event => updateDraft('conditions', draft.conditions.map(row => row.id === item.id ? { ...row, category: event.target.value } : row))}>{['价格与折扣', '付款与账期', '交付与验收', '责任与保障', '其他条件'].map(category => <option key={category}>{category}</option>)}</select></label>
                </div>
                <button type="button" className="studio-icon-button" aria-label={`删除条件 ${index + 1}`} disabled={Boolean(busy) || draft.conditions.length <= 1} onClick={() => updateDraft('conditions', draft.conditions.filter(row => row.id !== item.id))}><Trash2 size={16} /></button>
              </div>
              <div className="approval-form-grid">
                <label className="approval-form-wide">审批事项<input required maxLength={200} value={item.subject} disabled={Boolean(busy)} placeholder="例如：首付款比例与分期节点" onChange={event => updateDraft('conditions', draft.conditions.map(row => row.id === item.id ? { ...row, subject: event.target.value } : row))} /></label>
                {([{ field: 'baseline', label: '现有条件', placeholder: '填写现有标准或原约定' }, { field: 'proposed', label: '申请条件', placeholder: '填写期望执行的条件' }, { field: 'reason', label: '调整理由', placeholder: '说明调整依据及业务影响' }] as const).map(({ field, label, placeholder }) => <label key={field} className={field === 'reason' ? 'approval-form-wide' : ''}>{label}<textarea className="approval-compact-textarea" rows={2} required maxLength={2000} value={item[field]} disabled={Boolean(busy)} placeholder={placeholder} onChange={event => updateDraft('conditions', draft.conditions.map(row => row.id === item.id ? { ...row, [field]: event.target.value } : row))} /></label>)}
              </div>
            </fieldset>)}</div>
          </section> : <section className="approval-section"><div className="approval-section-heading"><div><h2>选择已保存合同</h2><p>提交已保存版本。合同修改后请先保存。</p></div></div><label className="approval-contract-picker">合同<select required value={draft.contractId} disabled={Boolean(busy) || !draft.projectId} onChange={event => { const source = state.contracts?.find(item => item.id === event.target.value); setDraft(previous => ({ ...previous, contractId: event.target.value, title: previous.title || (source ? `${source.title}审批` : '') })); }}><option value="">选择该项目的已保存合同</option>{state.contracts?.filter(item => item.dealId === draft.projectId).map(item => <option key={item.id} value={item.id}>{item.title} · 版本 {item.version} · {date(item.updatedAt)}</option>)}</select></label>{selectedContract ? <ContractSnapshot contract={selectedContract} /> : <p className="approval-hint">{draft.projectId ? '此处仅显示已关联该项目的保存合同。若没有可选合同，请先在合同初审中保存。' : '选择关联项目后，再选择合同。'}</p>}</section>}
        </div>
        <aside className="approval-create-aside">
          <section className="approval-section">
            <div className="approval-section-heading"><div><h2>审批流程</h2><p>指定实际审批人，申请人不能审批自己的申请。</p></div></div>
            <label className="approval-template-picker">使用已保存流程<select disabled={Boolean(busy)} value={draft.templateId} onChange={event => selectTemplate(event.target.value)}><option value="">自定义流程</option>{activeTemplates.map(item => <option value={item.id} key={item.id}>{item.name} · {item.steps.length} 级</option>)}</select></label>
            {!activeTemplates.length && <p className="approval-hint">尚无此类型的保存流程。可直接填写下方节点，或在“审批流程”中保存常用配置。</p>}
            <RouteEditor disabled={Boolean(busy)} steps={draft.steps} onChange={steps => updateDraft('steps', steps)} />
          </section>
          <div className="approval-submit-footer"><p>提交后保留当前内容快照。</p><div><button type="button" className="studio-btn studio-btn-ghost" disabled={Boolean(busy)} onClick={back}>取消</button><button type="submit" className="studio-btn studio-btn-primary" disabled={Boolean(busy) || !identity}>{busy === 'submit' ? <Loader2 size={16} className="studio-spin" /> : <Send size={16} />}提交审批</button></div></div>
        </aside>
      </form>
    </>}

    {screen === 'detail' && <><div className="approval-subpage-bar"><div className="approval-subpage-left"><button type="button" className="approval-back" disabled={Boolean(busy)} onClick={back}><ArrowLeft size={15} />返回审批列表</button>{embeddedHeading && <h2 ref={heading} tabIndex={-1} className="approval-subpage-title">审批详情</h2>}</div>{embeddedHeading && <div className="approval-header-actions"><button type="button" className="studio-btn studio-btn-secondary" disabled={Boolean(busy) || listLoading} onClick={() => { if (note.trim()) navigate(refresh); else refresh(); }} aria-label="刷新审批记录"><RefreshCw size={15} />刷新</button></div>}</div>{detailLoading ? <div className="approval-loading" role="status"><Loader2 size={22} className="studio-spin" /><p>正在读取申请详情…</p></div> : detailError ? <div className="approval-load-error" role="alert"><AlertCircle size={26} /><h2>暂时无法查看此申请</h2><p>{detailError}</p><p>请确认已使用申请中指定的登录邮箱访问。</p><button type="button" className="studio-btn studio-btn-secondary" onClick={() => setDetailReload(value => value + 1)}><RefreshCw size={15} />重新读取</button></div> : detail && <><header className="approval-detail-heading"><div><div className="approval-detail-tags"><span className="approval-kind">{KIND[detail.kind]}</span><Status status={detail.status} /></div><h2>{detail.title}</h2><p>{detail.applicant.name} · {detail.applicant.email} <span>提交于 {date(detail.createdAt)}</span></p></div><button type="button" className="studio-btn studio-btn-secondary" onClick={copyLink}><Copy size={15} />复制审批链接</button></header>{detail.status === 'superseded' && <div className="approval-alert"><AlertCircle size={18} /><p>关联合同内容已变更，此申请已失效，无法继续审批。申请人需核对最新保存合同并重新提交。</p></div>}<div className="approval-detail-layout"><main className="approval-detail-main"><section className="approval-section"><div className="approval-section-heading"><h2>提交快照</h2>{ownsProject && onNavigate && <button type="button" className="studio-btn studio-btn-ghost" disabled={Boolean(busy)} onClick={() => navigate(() => onNavigate('deals', detail.projectId))}>查看项目<ArrowRight size={15} /></button>}</div><dl className="approval-facts"><div><dt>关联项目</dt><dd>{detail.snapshot.project.name}</dd></div><div><dt>客户企业</dt><dd>{detail.snapshot.project.company}</dd></div><div><dt>项目阶段</dt><dd>{detail.snapshot.project.stage}</dd></div><div><dt>项目负责人</dt><dd>{detail.snapshot.project.owner}</dd></div><div><dt>项目金额</dt><dd>¥{detail.snapshot.project.amount.toLocaleString('zh-CN')}</dd></div><div><dt>期望完成</dt><dd>{date(detail.deadline)}</dd></div></dl><div className="approval-submission-reason"><h3>申请说明</h3><p>{detail.reason}</p></div>{detail.previousRequestId && <button type="button" className="studio-btn studio-btn-ghost approval-previous" onClick={() => openRequest(detail.previousRequestId!)}><History size={15} />查看上一份申请</button>}</section>{detail.kind === 'business' && <section className="approval-section"><h2>商务条件</h2><div className="approval-condition-snapshots">{detail.snapshot.conditions?.map((item, index) => <article key={item.id}><div><span>{index + 1}</span><h3>{item.subject}</h3><small>{item.category}</small></div><dl><div><dt>现有条件</dt><dd>{item.baseline}</dd></div><div><dt>申请条件</dt><dd>{item.proposed}</dd></div><div><dt>调整理由</dt><dd>{item.reason}</dd></div></dl></article>)}</div></section>}{detail.snapshot.contract && <section className="approval-section"><h2>提交时的合同</h2><ContractSnapshot contract={detail.snapshot.contract} /></section>}<section className="approval-section"><div className="approval-section-heading"><h2><History size={18} />操作历史</h2></div><ol className="approval-history">{detail.history.map(item => <li key={item.id}><span className="approval-history-icon">{item.action === 'approve' ? <Check size={16} /> : item.action === 'submit' ? <Send size={15} /> : <History size={15} />}</span><div><div><strong>{item.actor.name} · {EVENT[item.action]}</strong>{item.stepIndex !== undefined && <span>第 {item.stepIndex + 1} 级</span>}<time dateTime={item.at}>{date(item.at)}</time></div><small>{item.actor.email}</small>{item.note && <p>{item.note}</p>}</div></li>)}</ol></section></main><aside className="approval-detail-aside"><section className="approval-section approval-flow-section"><h2><GitBranch size={18} />审批进度</h2><ol className="approval-flow">{detail.steps.map((step, index) => <li key={step.id} className={`approval-flow-${step.status}`}><span className="approval-flow-number">{step.status === 'approved' ? <Check size={15} /> : index + 1}</span><div><div><strong>{step.label}</strong><small>{STEP_STATUS[step.status]}</small></div><p>{step.approverName} · {ROLES[step.role]}</p><span>{step.approverEmail}</span>{step.decidedAt && <time>{date(step.decidedAt)}</time>}{step.note && <blockquote>{step.note}</blockquote>}</div></li>)}</ol></section>{canDecide && <section className="approval-section approval-decision"><h2><ClipboardCheck size={18} />待你审批</h2><p>第 {detail.currentStep + 1} 级 · {identity?.email}</p><label>审批意见<span>驳回、退回时必填</span><textarea rows={4} maxLength={3000} value={note} disabled={Boolean(busy)} onChange={event => { setNote(event.target.value); setError(''); }} placeholder="填写判断依据或需要修改的内容" /></label><div className="approval-decision-actions"><button type="button" className="studio-btn studio-btn-primary" disabled={Boolean(busy)} onClick={() => decide('approve')}>{busy === 'decide' ? <Loader2 size={16} className="studio-spin" /> : <CheckCircle2 size={16} />}通过本级审批</button><div><button type="button" className="studio-btn studio-btn-secondary" disabled={Boolean(busy)} onClick={() => decide('return')}>退回修改</button><button type="button" className="studio-btn studio-btn-danger" disabled={Boolean(busy)} onClick={() => decide('reject')}>驳回申请</button></div></div></section>}{isApplicant && detail.status === 'pending' && <section className="approval-section approval-owner-action"><h2>申请正在流转</h2><p>待当前审批人处理。需要调整内容时，可先撤回申请。</p>{confirmWithdraw ? <div className="approval-withdraw-confirm"><p>确认撤回此申请？撤回后将停止后续审批，历史记录仍会保留。</p><div><button type="button" className="studio-btn studio-btn-ghost" disabled={Boolean(busy)} onClick={() => setConfirmWithdraw(false)}>暂不撤回</button><button type="button" className="studio-btn studio-btn-danger" disabled={Boolean(busy)} onClick={withdraw}>{busy === 'withdraw' && <Loader2 size={14} className="studio-spin" />}确认撤回</button></div></div> : <button type="button" className="studio-btn studio-btn-secondary" disabled={Boolean(busy)} onClick={() => setConfirmWithdraw(true)}>撤回申请</button>}</section>}{isApplicant && ['returned', 'rejected', 'withdrawn', 'superseded'].includes(detail.status) && <section className="approval-section approval-owner-action"><h2>修改后重新提交</h2><p>沿用原申请字段并创建新记录。{detail.kind === 'contract' ? '合同将使用当前已保存版本。' : '原申请快照及审批意见继续保留。'}</p><button type="button" className="studio-btn studio-btn-primary" disabled={Boolean(busy) || !ownsProject || (detail.kind === 'contract' && !state.contracts?.some(item => item.id === detail.snapshot.contract?.id))} onClick={() => navigate(() => openNew(state.contracts?.find(item => item.id === detail.snapshot.contract?.id), detail))}><Plus size={15} />修改并重新提交</button>{!ownsProject && <p className="approval-hint">原项目已不在当前工作区，无法继续提交。</p>}</section>}</aside></div></>}</>}
  </div>;
}
