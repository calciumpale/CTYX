'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Check, ChevronDown, CircleAlert, Copy, Download, ExternalLink, FileUp, Loader2, Monitor, Pause, Play, Plus, RefreshCw, Search, Send, Unplug, Users, X } from 'lucide-react';
import type { ProspectCampaign, ProspectDeviceView, ProspectJobView, ProspectLead, ProspectLeadStatus, ProspectReviewMode, ProspectSnapshot } from '../lib/prospecting-types';
import { Overlay } from './CoreViews';
import { ProspectingConversations } from './ProspectingConversations';
import './prospecting-workspace.css';

type PostResult = { snapshot: ProspectSnapshot; deviceCredentials?: { deviceId: string; deviceToken: string }; campaignId?: string; message?: string };
type Draft = { version: number; greeting: string };
type LeaveGuard = (proceed: () => void) => boolean;
const leadLabels: Record<ProspectLeadStatus, string> = { pending: '待审核', rejected: '已拒绝', queued: '等待发送', sending: '正在发送', submitted: '已提交', failed: '发送失败', unknown: '待核对', unreachable: '暂不可联系' };
const jobLabels = { queued: '排队中', running: '进行中', done: '已完成', failed: '未完成', unknown: '待核对', cancelled: '已取消' };
const jobKinds = { discover: '发现竞品账号', collect: '采集评论', send: '发送招呼', readConversation: '同步客户会话', reply: '发送聊天回复' };
const keywordsFrom = (value: string) => [...new Set(value.split(/[\n,，;；]/).map(word => word.trim()).filter(Boolean))];
const readableError = (error: unknown) => error instanceof Error ? error.message : '这次操作未完成，请稍后重试。';
const cancelled = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const contactable = (lead: ProspectLead) => lead.source === 'browser' && Boolean(lead.recipientId && sourceHref(lead.profileUrl));
function sourceHref(value?: string): string | undefined {
  if (!value) return;
  try { const url = new URL(value); if (url.protocol === 'https:' && (url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com'))) return url.href; } catch { /* Untrusted imported links remain plain text. */ }
}
function dateLabel(value?: string): string {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '时间待确认';
}
function SourceLink({ href, children }: { href?: string; children: React.ReactNode }) {
  const safe = sourceHref(href);
  return safe ? <a href={safe} target="_blank" rel="noopener noreferrer">{children}<ExternalLink size={12} /></a> : null;
}

type DiscoveryNotice = { title: string; message: string; action: 'resume' | 'connect' | 'discover' | 'history'; label: string; pending?: boolean; detail?: string };
function discoveryNotice(campaign: ProspectCampaign, device: ProspectDeviceView | undefined, jobs: ProspectJobView[]): DiscoveryNotice | undefined {
  const searches = jobs.filter(job => job.kind === 'discover').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (campaign.status === 'paused') return {
    title: '任务已暂停', action: 'resume', label: '恢复任务',
    message: `暂停期间不能发起新的账号搜索。先恢复任务，${device?.online && device.authenticated ? '再点击“发现竞品账号”。' : '再到本机助手点击“连接抖音”，连接后点击“发现竞品账号”。'}恢复任务不会自动发起搜索。`,
    ...(!jobs.length ? { detail: '此任务还没有发起过账号搜索。' } : {}),
  };
  if (!device?.id) return { title: '尚未配对本机助手', message: '展开连接说明，创建并下载配对配置。在本机助手导入后，点击“连接抖音”。', action: 'connect', label: '查看连接步骤' };
  if (!device.online) return device.lastSeenAt
    ? { title: '本机同步助手已离线', message: `最近上线：${dateLabel(device.lastSeenAt)}。打开“抖音获客助手”，点击“连接抖音”。恢复连接后可以继续搜索。`, action: 'connect', label: '查看连接步骤' }
    : { title: '已配对，助手尚未上线', message: '打开“抖音获客助手”，导入配对配置后点击“连接抖音”。页面显示已连接后，可以发起搜索。', action: 'connect', label: '查看连接步骤' };
  if (!device.authenticated) return { title: '助手在线，等待抖音账号确认', message: device.message || '如果抖音提示登录，请在打开的浏览器里扫码。', action: 'connect', label: '查看连接状态' };
  const active = searches.find(job => job.status === 'queued' || job.status === 'running');
  if (active) return { title: active.status === 'queued' ? '搜索已排队，等待助手执行' : '正在搜索真实账号', message: active.status === 'queued' ? '搜索请求已创建，助手尚未开始执行。保持助手运行，结果返回后会自动显示。' : '助手正在读取抖音公开视频搜索结果。保持专用浏览器开启，结果返回后会自动显示。', action: 'history', label: '查看执行记录', pending: true };
  const latest = searches[0];
  if (latest?.status === 'failed' || latest?.status === 'unknown') return { title: '上次搜索未完成', message: '这次搜索没有成功完成，不能据此判断没有相关账号。请根据失败提示检查专用浏览器后重新搜索，也可以先点击关键词查看公开视频。', detail: latest.error || latest.summary, action: 'discover', label: '重新发现账号' };
  if (latest?.status === 'cancelled') return { title: '上次搜索已取消', message: '取消的搜索不会自动重新执行。确认助手已连接后，点击“重新发现账号”发起新的搜索。', action: 'discover', label: '重新发现账号' };
  if (campaign.candidates.length) return;
  if (latest?.status === 'done') return { title: '搜索已完成，未发现可用账号', message: '本次搜索没有返回可用的账号和视频来源。可以先点击关键词核对抖音公开搜索结果，再重新搜索；也可以新建任务调整关键词。', action: 'discover', label: '重新发现账号' };
  return { title: jobs.length ? '当前没有进行中的账号搜索' : '尚未发起账号搜索', message: '需求已保存，本机助手已连接。点击“发现竞品账号”开始搜索，结果返回后会显示真实账号和视频来源。', action: 'discover', label: '发现竞品账号' };
}

function collectionEmptyNotice(job?: ProspectJobView) {
  if (job?.status === 'queued' || job?.status === 'running') return { title: '采集结果尚未返回', message: '采集任务已创建，评论返回后会自动显示。请保持本机助手和专用浏览器开启。' };
  if (job?.status === 'failed' || job?.status === 'unknown') return { title: '采集未完成，尚未保存评论', message: '请先查看采集错误，并在专用浏览器检查评论面板后重新采集。读取失败不代表视频没有评论。' };
  if (job?.status === 'cancelled') return { title: '上次采集已取消', message: '这次采集没有继续执行。恢复任务并确认助手已连接后，重新选择账号采集评论。' };
  if (job?.status === 'done') return job.warnings?.length
    ? { title: '本次未保存评论，请查看采集提示', message: '助手没有返回评论，并给出了采集提示，不能据此判断视频没有评论。请先在专用浏览器核对来源视频的评论面板，再重新采集。' }
    : { title: '本次采集未返回评论', message: '本次采集已结束，保存的评论为 0 条。这只代表本次读取结果，请核对来源视频的评论面板后再决定是否重新采集。' };
  return { title: '尚未采集评论', message: '先选择竞品账号并采集评论，也可以导入已有的评论文件。' };
}

function CampaignForm({ busy, modelReady, onCreate, onCancel, onDirtyChange }: { busy: boolean; modelReady: boolean; onCreate: (input: Record<string, unknown>) => void; onCancel?: () => void; onDirtyChange: (dirty: boolean) => void }) {
  const id = useId();
  const [requirements, setRequirements] = useState('');
  const [keywords, setKeywords] = useState('');
  const [reviewMode, setReviewMode] = useState<ProspectReviewMode>('manual');
  const [greetingTemplate, setGreetingTemplate] = useState('你好，看到你在评论区提到的需求，方便进一步了解一下吗？');
  const [score, setScore] = useState(70);
  const [maxComments, setMaxComments] = useState(30);
  const [dailyLimit, setDailyLimit] = useState(10);
  const [formError, setFormError] = useState('');
  function submit(event: FormEvent) {
    event.preventDefault();
    const words = keywordsFrom(keywords);
    if (!requirements.trim() || !greetingTemplate.trim()) { setFormError('请填写产品与客群要求和招呼参考。'); return; }
    if (words.length > 5 || words.some(word => word.length > 40)) { setFormError('最多填写 5 个搜索词，每个词不超过 40 个字符。'); return; }
    setFormError('');
    onCreate({ action: 'create', requirements: requirements.trim(), keywords: words, reviewMode, greetingTemplate: greetingTemplate.trim(), minIntentScore: score, maxCommentsPerVideo: maxComments, dailyLimit });
  }
  return <form className="prospect-create" onSubmit={submit} onChange={() => onDirtyChange(true)}>
    <div className="prospect-section-heading"><div><h2>新建获客任务</h2></div>{onCancel && <button type="button" className="button ghost" disabled={busy} onClick={onCancel}>返回任务</button>}</div>
    <div className="prospect-field"><label htmlFor={`${id}-requirements`}>产品与目标客群</label><textarea id={`${id}-requirements`} disabled={busy} required minLength={5} maxLength={2000} rows={4} value={requirements} onChange={event => setRequirements(event.target.value)} placeholder="例如：我们提供中小企业财税服务，想找到正在咨询公司注册、代理记账和税务办理的创业者。" /></div>
    <div className="prospect-field"><label htmlFor={`${id}-keywords`}>竞品搜索词（可选）</label><input id={`${id}-keywords`} disabled={busy} maxLength={204} value={keywords} onChange={event => setKeywords(event.target.value)} placeholder="例如：公司注册，代理记账，创业财税" /><small>最多 5 个词，用逗号分隔，每词不超过 40 字。留空时自动从需求提取。</small></div>
    <div className="prospect-field"><label htmlFor={`${id}-greeting`}>招呼参考</label><textarea id={`${id}-greeting`} disabled={busy} required maxLength={300} rows={3} value={greetingTemplate} onChange={event => setGreetingTemplate(event.target.value)} placeholder="介绍你能提供的帮助，作为生成招呼草稿的参考。" /><small>有模型时生成草稿；未配置模型时直接使用此文案。</small></div>
    <fieldset className="prospect-mode"><legend>发送方式</legend><label className={reviewMode === 'manual' ? 'is-selected' : ''}><input type="radio" name={`${id}-mode`} disabled={busy} checked={reviewMode === 'manual'} onChange={() => setReviewMode('manual')} /><span><strong>人工审核后发送</strong><small>批准后进入发送队列。</small></span></label><label className={reviewMode === 'automatic' ? 'is-selected' : ''}><input type="radio" name={`${id}-mode`} disabled={busy} checked={reviewMode === 'automatic'} onChange={() => setReviewMode('automatic')} /><span><strong>符合条件时自动发送</strong><small>模型评分达标且身份可联系时自动排队。</small></span></label></fieldset>
    {reviewMode === 'automatic' && <p className="prospect-context-note"><CircleAlert size={16} />{modelReady ? '采集完成后可能自动发出招呼，请先核对需求、文案和每日上限。' : '当前模型未就绪。评论可以先采集和规则初筛，但会等待人工审核，不会自动发送。'}</p>}
    <details className="prospect-options"><summary>筛选与发送设置<ChevronDown size={15} /></summary><div className="prospect-number-fields"><div className="prospect-field"><label htmlFor={`${id}-score`}>自动发送最低评分</label><input id={`${id}-score`} disabled={busy} type="number" required min={0} max={100} value={score} onChange={event => setScore(Number(event.target.value))} /><small>0–100 分；人工审核可自行判断。</small></div><div className="prospect-field"><label htmlFor={`${id}-comments`}>每个视频最多采集</label><input id={`${id}-comments`} disabled={busy} type="number" required min={1} max={50} value={maxComments} onChange={event => setMaxComments(Number(event.target.value))} /><small>条评论，实际数量以页面可读为准。</small></div><div className="prospect-field"><label htmlFor={`${id}-limit`}>每日最多发送</label><input id={`${id}-limit`} disabled={busy} type="number" required min={1} max={30} value={dailyLimit} onChange={event => setDailyLimit(Number(event.target.value))} /><small>本任务最多 30 条；这是本地保护上限。</small></div></div></details>
    {formError && <p className="prospect-inline-error" role="alert">{formError}</p>}
    <div className="prospect-form-footer"><button className="button primary" disabled={busy}>{busy ? <Loader2 size={16} className="spin" /> : <ArrowRight size={16} />}创建任务</button></div>
  </form>;
}

export function ProspectingWorkspace({ onGuardReady }: { onGuardReady?: (guard: LeaveGuard | null) => void }) {
  const prefix = useId();
  const [snapshot, setSnapshot] = useState<ProspectSnapshot | null>(null);
  const [campaignId, setCampaignId] = useState('');
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState<'candidates' | 'leads' | 'chat' | 'pool' | 'history'>('candidates');
  const [filter, setFilter] = useState<'all' | 'highIntent' | 'pending' | 'submitted' | 'attention'>('all');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedCandidates, setSelectedCandidates] = useState<string[]>([]);
  const [selectedLeads, setSelectedLeads] = useState<Record<string, number>>({});
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [formDirty, setFormDirty] = useState(false);
  const [chatDirty, setChatDirty] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatResetKey, setChatResetKey] = useState(0);
  const chatBusyRef = useRef(false);
  const onChatBusyChange = useCallback((value: boolean) => { chatBusyRef.current = value; setChatBusy(value); }, []);
  const [leaveRequested, setLeaveRequested] = useState(false);
  const pendingLeave = useRef<(() => void) | null>(null);
  const [deviceLabel, setDeviceLabel] = useState('我的抖音浏览器');
  const [credentials, setCredentials] = useState<PostResult['deviceCredentials']>();
  const [advancedCdp, setAdvancedCdp] = useState('');
  const [disconnectConfirm, setDisconnectConfirm] = useState(false);
  const [importContent, setImportContent] = useState('');
  const [importName, setImportName] = useState('');
  const mounted = useRef(true);
  const activeCampaign = useRef('');
  const epoch = useRef(0);
  const busyRef = useRef(false);
  const readInFlight = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  const importReadGeneration = useRef(0);
  const connectionDetails = useRef<HTMLDetailsElement>(null);

  const request = useCallback(async <T,>(url: string, init: RequestInit = {}): Promise<T> => {
    const controller = new AbortController(); controllers.current.add(controller);
    try {
      const response = await fetch(url, { ...init, credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      let body: T & { error?: string; message?: string };
      try { body = await response.json(); } catch { throw new Error('获客服务暂时没有响应，请稍后刷新。'); }
      if (!response.ok) throw new Error(body.error || body.message || `操作未完成（${response.status}），请刷新后重试。`);
      return body;
    } finally { controllers.current.delete(controller); }
  }, []);
  const applySnapshot = useCallback((next: ProspectSnapshot, preferred?: string) => {
    if (!mounted.current) return;
    setSnapshot(next);
    const selected = preferred || next.campaign?.id || '';
    activeCampaign.current = selected; setCampaignId(selected);
  }, []);
  const refresh = useCallback(async (id = activeCampaign.current, force = false) => {
    if (busyRef.current || readInFlight.current && !force) return;
    const generation = ++epoch.current; readInFlight.current = true;
    try {
      const next = await request<ProspectSnapshot>(`/api/prospecting${id ? `?campaignId=${encodeURIComponent(id)}` : ''}`);
      if (mounted.current && generation === epoch.current) { applySnapshot(next); setReadError(''); }
    } catch (cause) { if (mounted.current && generation === epoch.current && !cancelled(cause)) setReadError(readableError(cause)); }
    finally { if (generation === epoch.current) { readInFlight.current = false; if (mounted.current) setLoading(false); } }
  }, [applySnapshot, request]);
  useEffect(() => {
    mounted.current = true; const activeControllers = controllers.current;
    const frame = requestAnimationFrame(() => { void refresh(); });
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 4000);
    return () => { mounted.current = false; cancelAnimationFrame(frame); clearInterval(timer); activeControllers.forEach(controller => controller.abort()); activeControllers.clear(); readInFlight.current = false; };
  }, [refresh]);
  const post = (input: Record<string, unknown>) => request<PostResult>('/api/prospecting', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  async function execute(label: string, operation: () => Promise<PostResult>, after?: (result: PostResult) => void) {
    if (busyRef.current || chatBusyRef.current) return;
    busyRef.current = true; epoch.current++; readInFlight.current = false; setBusy(label); setError(''); setNotice('');
    try {
      const result = await operation();
      if (!mounted.current) return;
      applySnapshot(result.snapshot, result.campaignId); setReadError(''); setError('');
      if (result.deviceCredentials) setCredentials(result.deviceCredentials);
      setNotice(result.message || '操作已保存。'); after?.(result);
    } catch (cause) { if (mounted.current && !cancelled(cause)) setError(readableError(cause)); }
    finally { busyRef.current = false; if (mounted.current) setBusy(''); }
  }
  const hasUnsaved = chatDirty || formDirty || Object.keys(drafts).length > 0 || Boolean(importContent.trim()) || Boolean(credentials);
  const guardLeave = useCallback((proceed: () => void) => {
    if (busyRef.current || chatBusyRef.current) { setError('当前操作正在保存，请等待完成后再离开。'); return false; }
    if (hasUnsaved) { pendingLeave.current = proceed; setLeaveRequested(true); return false; }
    return true;
  }, [hasUnsaved]);
  useEffect(() => { onGuardReady?.(guardLeave); return () => onGuardReady?.(null); }, [guardLeave, onGuardReady]);
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => { if (hasUnsaved || busyRef.current || chatBusyRef.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', protect); return () => window.removeEventListener('beforeunload', protect);
  }, [hasUnsaved]);
  function guarded(proceed: () => void) { if (guardLeave(proceed)) proceed(); }
  function discardDrafts() { importReadGeneration.current++; setChatResetKey(value => value + 1); setChatDirty(false); setDrafts({}); setFormDirty(false); setImportContent(''); setImportName(''); setCredentials(undefined); setAdvancedCdp(''); }
  function selectCampaign(id: string) {
    if (id === activeCampaign.current && !creating) return;
    guarded(() => { discardDrafts(); activeCampaign.current = id; setCampaignId(id); setCreating(false); setSelectedCandidates([]); setSelectedLeads({}); setNotice(''); setLoading(true); setTab('candidates'); setFilter('all'); void refresh(id, true); });
  }
  const campaign = snapshot?.campaign?.id === campaignId ? snapshot.campaign : undefined;
  const leads = campaign ? snapshot?.leads || [] : [];
  const jobs = campaign ? snapshot?.jobs || [] : [];
  const visibleJobs = jobs.filter(job => job.kind !== 'readConversation');
  const device = snapshot?.device;
  const connected = Boolean(device?.online && device.authenticated);
  const readOnlyAccount = Boolean(device?.accountId?.startsWith('dy-readonly-'));
  const paused = campaign?.status === 'paused';
  const operationBusy = Boolean(busy) || chatBusy;
  const available = connected && !paused && !operationBusy && !loading;
  const sendingAvailable = available && !readOnlyAccount;
  const selfRecipient = (lead: ProspectLead) => Boolean(connected && !readOnlyAccount && device?.accountId && lead.recipientId === device.accountId);
  const discovery = campaign ? discoveryNotice(campaign, device, jobs) : undefined;
  const discoveryPending = jobs.some(job => job.kind === 'discover' && ['queued', 'running'].includes(job.status));
  const latestCollection = jobs.filter(job => job.kind === 'collect').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const emptyCollection = collectionEmptyNotice(latestCollection);
  const candidateOptions = campaign?.candidates.filter(item => item.videos.length > 0) || [];
  const selectedCandidateIds = selectedCandidates.filter(id => candidateOptions.some(item => item.id === id));
  const automaticLead = (lead: ProspectLead) => campaign?.reviewMode === 'automatic' && Boolean(snapshot?.modelReady) && !(lead.analysisSource === 'rules' && lead.error) && !(lead as ProspectLead & { autoSuppressed?: number | boolean }).autoSuppressed;
  const draftKey = (lead: ProspectLead) => `${lead.campaignId}:${lead.id}`;
  const draftFor = (lead: ProspectLead) => drafts[draftKey(lead)];
  const draftConflict = (lead: ProspectLead) => Boolean(draftFor(lead) && draftFor(lead).version !== lead.version);
  const eligible = leads.filter(lead => lead.status === 'pending' && contactable(lead) && !selfRecipient(lead) && !automaticLead(lead));
  const pendingCount = leads.filter(lead => lead.status === 'pending').length;
  const unreachableCount = leads.filter(lead => lead.status === 'unreachable').length;
  const attentionCount = leads.filter(lead => ['unknown', 'failed', 'unreachable'].includes(lead.status)).length;
  const highIntent = (lead: ProspectLead) => Boolean(campaign && lead.intentScore >= campaign.minIntentScore);
  const highIntentCount = leads.filter(highIntent).length;
  const modelScoredCount = leads.filter(lead => lead.analysisSource === 'model').length;
  const displayed = leads.filter(lead => filter === 'all' || filter === 'highIntent' && highIntent(lead) || filter === 'pending' && lead.status === 'pending' || filter === 'submitted' && lead.status === 'submitted' || filter === 'attention' && ['unknown', 'failed', 'unreachable'].includes(lead.status)).sort((a, b) => b.intentScore - a.intentScore || a.id.localeCompare(b.id));
  const selected = eligible.filter(lead => selectedLeads[lead.id] === lead.version && displayed.some(item => item.id === lead.id));
  const greetingFor = (lead: ProspectLead) => draftFor(lead)?.greeting ?? lead.greeting;
  function changeLeadFilter(next: typeof filter) { setFilter(next); setSelectedLeads({}); }
  function discardLeadDraft(lead: ProspectLead) { setDrafts(values => { const next = { ...values }; delete next[draftKey(lead)]; return next; }); }
  const campaignAction = (action: string, extra: Record<string, unknown> = {}) => { if (campaign) void execute(action, () => post({ action, campaignId: campaign.id, ...extra })); };
  function actOnDiscovery() {
    if (!discovery) return;
    if (discovery.action === 'connect') {
      const details = connectionDetails.current;
      if (details) { details.open = true; details.scrollIntoView({ block: 'start' }); details.querySelector('summary')?.focus({ preventScroll: true }); }
    } else if (discovery.action === 'history') setTab('history');
    else campaignAction(discovery.action);
  }
  function review(lead: ProspectLead, decision: 'approve' | 'reject') {
    if (!campaign || decision === 'approve' && (!sendingAvailable || selfRecipient(lead))) return;
    void execute(lead.id, () => post({ action: 'review', campaignId: campaign.id, leadId: lead.id, version: lead.version, decision, greeting: greetingFor(lead) }), () => discardLeadDraft(lead));
  }
  function retrySend(lead: ProspectLead) {
    if (!campaign || !sendingAvailable || !contactable(lead) || selfRecipient(lead) || !['failed', 'unknown'].includes(lead.status)) return;
    void execute(lead.id, () => post({ action: 'retrySend', campaignId: campaign.id, leadId: lead.id, version: lead.version }));
  }
  function approveSelected() {
    if (!campaign || !sendingAvailable || !selected.length || selected.some(draftConflict)) return;
    const items = selected.map(lead => ({ id: lead.id, version: lead.version, greeting: greetingFor(lead) }));
    void execute('batch', async () => {
      let result: PostResult | undefined; let completed = 0;
      try {
        for (const item of items) {
          result = await post({ action: 'review', campaignId: campaign.id, leadId: item.id, version: item.version, decision: 'approve', greeting: item.greeting });
          completed++; if (mounted.current) { applySnapshot(result.snapshot); setDrafts(values => { const next = { ...values }; delete next[`${campaign.id}:${item.id}`]; return next; }); }
        }
      } catch (cause) { throw new Error(`已处理 ${completed} 条，后续操作已停止。${readableError(cause)} 请核对列表后再继续。`); }
      return { ...result!, message: `${completed} 条评论已完成审核，发送结果以任务记录为准。` };
    }, () => setSelectedLeads({}));
  }
  const configuration = credentials ? JSON.stringify({ origin: typeof window === 'undefined' ? '' : window.location.origin, deviceId: credentials.deviceId, deviceToken: credentials.deviceToken, ...(advancedCdp.trim() ? { cdpUrl: advancedCdp.trim() } : {}) }, null, 2) : '';
  async function copyConfig() { try { await navigator.clipboard.writeText(configuration); setNotice('配对配置已复制，请保存到本机同步助手。'); } catch { setError('浏览器未允许复制，请下载配置文件，或选中配置手动复制。'); } }
  function downloadConfig() {
    const url = URL.createObjectURL(new Blob([configuration], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = 'douyin-bridge.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); setNotice('配对配置已下载，请妥善保存在本机。');
  }
  async function readImport(file?: File) {
    if (!file) return;
    const generation = ++importReadGeneration.current; const forCampaign = activeCampaign.current;
    if (file.size > 1500000) { setError('导入文件不能超过 1.5MB，请减少评论数量后再导入。'); return; }
    try { const content = await file.text(); if (mounted.current && generation === importReadGeneration.current && forCampaign === activeCampaign.current) { setImportContent(content); setImportName(file.name); setError(''); } } catch { if (mounted.current && generation === importReadGeneration.current && forCampaign === activeCampaign.current) setError('文件没有读取成功，请重新选择。'); }
  }

  return <div className="prospect-workspace">
    <header className="prospect-heading"><div><h1>抖音获客</h1></div><div className="prospect-heading-actions"><button className="button secondary" disabled={operationBusy} aria-pressed={tab === 'pool' && !creating} onClick={() => { const openPool = () => { setCreating(false); setTab('pool'); }; if (creating) guarded(() => { discardDrafts(); openPool(); }); else openPool(); }}><Users size={16} />留资线索池</button>{Boolean(snapshot && (snapshot.campaigns.length || tab === 'pool' || tab === 'chat')) && !creating && <button className="button secondary" disabled={operationBusy} onClick={() => guarded(() => { discardDrafts(); setCreating(true); setNotice(''); })}><Plus size={16} />新建任务</button>}</div></header>
    <details className="prospect-connection" ref={connectionDetails}>
      <summary><Monitor size={18} /><span><strong>{connected ? `${device?.accountName || '抖音账号'} · 已连接` : device?.online ? '同步助手在线，等待抖音账号确认' : device?.id ? '同步助手离线' : '连接你的抖音账号'}</strong>{connected && readOnlyAccount && <small>私信身份待验证</small>}</span><ChevronDown size={16} /></summary>
      <div className="prospect-connection-body"><p>Mac 上打开“抖音获客助手”，点击“连接抖音”。助手会复用已确认的登录状态，抖音提示登录时再在浏览器里扫码。使用时保持电脑、助手和浏览器运行。</p><p>首次使用先在下方创建并下载配对配置，在助手里导入一次。</p><details className="prospect-options"><summary>命令行安装方式<ChevronDown size={14} /></summary><p>使用命令行需安装 Node.js 22.13 或更新版本。</p>
        <div className="prospect-inline-actions"><a className="button secondary" href="/downloads/douyin-bridge.zip" download="douyin-bridge.zip"><Download size={15} />下载命令行助手</a><span>ZIP 源码包，不含账号凭证</span></div>
        <ol><li>在下方创建配对配置，将 <code>douyin-bridge.json</code> 下载到电脑的“下载”文件夹。</li><li>下载并解压本机助手，进入解压后的 <code>douyin-bridge</code> 目录，在该目录打开终端。</li><li>依次执行下方命令，完成浏览器登录后启动助手。页面会自动更新连接状态。</li></ol>
        <pre className="prospect-setup-commands" aria-label="本机助手安装与启动命令"><code>{'npm ci\nnpx playwright install chromium\nnode bridge.mjs setup --input ~/Downloads/douyin-bridge.json\nnode bridge.mjs login\nnode bridge.mjs run'}</code></pre>
        <p className="prospect-secondary">首次安装时执行前两条命令；配对完成后，日常使用只需在助手目录运行 <code>node bridge.mjs run</code>。私有站点还需向管理员获取 <code>sitesToken</code>，按助手 README 添加到本机配置；下载包和页面均不包含该访问凭证。</p></details>
        <details className="prospect-options"><summary>已有项目源码时如何启动<ChevronDown size={14} /></summary><p>助手位于项目内的 <code>tools/douyin-bridge</code> 目录，可按该目录中的 README 安装。无需重复下载 ZIP；配对配置仍从此页面生成。</p></details>
        {device?.message && <p className="prospect-context-note">{device.message}</p>}
        {device?.lastSeenAt && <p className="prospect-secondary">最近连接：{dateLabel(device.lastSeenAt)}{device.label ? ` · ${device.label}` : ''}</p>}
        {!device?.id && !credentials && <form className="prospect-connect-form" onSubmit={event => { event.preventDefault(); void execute('connect', () => post({ action: 'connect', label: deviceLabel, ...(activeCampaign.current ? { campaignId: activeCampaign.current } : {}) })); }}><div className="prospect-field"><label htmlFor={`${prefix}-device`}>设备名称</label><input id={`${prefix}-device`} maxLength={80} required value={deviceLabel} onChange={event => setDeviceLabel(event.target.value)} /></div><button className="button secondary" disabled={operationBusy || !snapshot}>{busy === 'connect' ? <Loader2 className="spin" size={15} /> : <Monitor size={15} />}创建配对配置</button></form>}
        {credentials && <section className="prospect-credentials"><h3>保存这份配对配置</h3><p>凭证仅在本次创建后显示，关闭页面后无法再次查看。请保存在这台电脑，不要分享。</p><details className="prospect-options"><summary>连接现有浏览器（高级）<ChevronDown size={14} /></summary><div className="prospect-field"><label htmlFor={`${prefix}-cdp`}>本机浏览器调试地址（可选）</label><input id={`${prefix}-cdp`} type="url" value={advancedCdp} onChange={event => setAdvancedCdp(event.target.value)} placeholder="http://127.0.0.1:9222" /><small>通常留空，由同步助手管理专用浏览器。</small></div></details><textarea aria-label="一次性配对配置" readOnly value={configuration} rows={7} spellCheck={false} /><div className="prospect-inline-actions"><button type="button" className="button secondary" onClick={() => void copyConfig()}><Copy size={15} />复制配置</button><button type="button" className="button secondary" onClick={downloadConfig}><Download size={15} />下载配置</button><button type="button" className="button ghost" onClick={() => { setCredentials(undefined); setAdvancedCdp(''); }}>已保存，关闭凭证</button></div></section>}
        {device?.id && !credentials && <div className="prospect-inline-actions">{disconnectConfirm ? <><span>断开后，助手将不能再领取任务。</span><button className="button secondary" disabled={operationBusy} onClick={() => void execute('disconnect', () => post({ action: 'disconnect', ...(activeCampaign.current ? { campaignId: activeCampaign.current } : {}) }), () => { setDisconnectConfirm(false); setCredentials(undefined); })}>确认断开</button><button className="button ghost" disabled={operationBusy} onClick={() => setDisconnectConfirm(false)}>取消</button></> : <button className="button ghost" disabled={operationBusy} onClick={() => setDisconnectConfirm(true)}><Unplug size={15} />断开设备连接</button>}</div>}
      </div>
    </details>
    {(error || readError) && <div className="prospect-message is-error" role="alert"><CircleAlert size={17} /><div><p>{error || readError}</p>{error && readError && <p>{readError}</p>}<button className="button ghost" disabled={operationBusy} onClick={() => void refresh(activeCampaign.current, true)}><RefreshCw size={14} />刷新状态</button></div></div>}
    {notice && <div className="prospect-message" role="status"><Check size={17} /><p>{notice}</p><button className="icon-button" aria-label="关闭提示" onClick={() => setNotice('')}><X size={14} /></button></div>}
    {loading && !snapshot ? <div className="prospect-empty" role="status"><Loader2 size={24} className="spin" /><h2>正在读取获客任务</h2></div> : !snapshot ? <div className="prospect-empty"><h2>暂时无法读取任务</h2><p>请刷新状态，已保存的任务会在服务恢复后显示。</p></div> : <>
      {snapshot.campaigns.length > 0 && <div className="prospect-task-picker"><label htmlFor={`${prefix}-campaign`}>当前任务</label><select id={`${prefix}-campaign`} value={campaignId} disabled={operationBusy} onChange={event => selectCampaign(event.target.value)}>{snapshot.campaigns.map(item => <option key={item.id} value={item.id}>{item.name}{item.status === 'paused' ? ' · 已暂停' : ''}</option>)}</select>{loading && <Loader2 size={16} className="spin" aria-label="切换任务中" />}</div>}
      {(creating || snapshot.campaigns.length === 0 && tab !== 'pool' && tab !== 'chat') && <CampaignForm busy={operationBusy} modelReady={snapshot.modelReady} onDirtyChange={setFormDirty} onCreate={input => void execute('create', () => post(input), () => { setCreating(false); setFormDirty(false); setSelectedCandidates([]); setSelectedLeads({}); setDrafts({}); setTab('candidates'); })} onCancel={campaign ? () => guarded(() => { discardDrafts(); setCreating(false); }) : undefined} />}
      {!creating && campaign && <>
        {tab !== 'pool' && <CampaignSummary campaign={campaign} busy={operationBusy} onToggle={() => campaignAction(paused ? 'resume' : 'pause')} />}
        {paused && tab !== 'pool' && <p className="prospect-context-note"><Pause size={16} />任务已暂停。待发送项不会继续执行；已经提交的发送不会被撤回。</p>}
        {!snapshot.modelReady && tab !== 'pool' && <p className="prospect-context-note"><CircleAlert size={16} />模型暂未就绪，评论将使用规则初筛并等待人工审核。请联系管理员配置模型。</p>}
        <div className="prospect-tabs" aria-label="获客任务内容"><button aria-pressed={tab === 'candidates'} onClick={() => setTab('candidates')}>竞品账号<span>{campaign.candidates.length}</span></button><button aria-pressed={tab === 'leads'} onClick={() => setTab('leads')}>评论线索<span>{leads.length}</span></button><button aria-pressed={tab === 'chat'} onClick={() => setTab('chat')}>聊天获客</button><button aria-pressed={tab === 'pool'} onClick={() => setTab('pool')}>留资线索池</button><button aria-pressed={tab === 'history'} onClick={() => setTab('history')}>执行记录<span>{visibleJobs.length}</span></button></div>
        {tab === 'candidates' && <section className="prospect-section"><div className="prospect-section-heading"><div><h2>竞品账号</h2><div className="prospect-inline-actions" aria-label="抖音公开视频关键词搜索"><span>搜索词：</span>{campaign.keywords.map(keyword => <SourceLink key={keyword} href={`https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=video`}>{keyword}</SourceLink>)}</div></div><button className="button secondary" disabled={!available || discoveryPending} onClick={() => campaignAction('discover')}><Search size={16} />{campaign.candidates.length ? '重新发现账号' : '发现竞品账号'}</button></div>
          {discovery && <div className={campaign.candidates.length ? 'prospect-message' : 'prospect-empty'} role="status">
            {discovery.pending ? <Loader2 size={27} className="spin" /> : paused ? <Pause size={27} /> : !connected ? <Monitor size={27} /> : <Users size={27} />}
            <div><h3>{discovery.title}</h3><p>{discovery.message}</p>{discovery.detail && <p className="prospect-inline-error">{discovery.detail}</p>}<button className="button secondary" disabled={operationBusy || loading || discovery.action === 'discover' && (!available || discoveryPending)} onClick={actOnDiscovery}>{discovery.action === 'resume' ? <Play size={15} /> : discovery.action === 'discover' ? <Search size={15} /> : null}{discovery.label}</button></div>
          </div>}
          {campaign.candidates.length ? <><div className="prospect-selection-toolbar"><label><input type="checkbox" disabled={operationBusy} checked={candidateOptions.length > 0 && candidateOptions.every(item => selectedCandidateIds.includes(item.id))} onChange={event => setSelectedCandidates(event.target.checked ? candidateOptions.map(item => item.id) : [])} />选择全部账号</label><span>已选 {selectedCandidateIds.length} 个</span></div><div className="prospect-candidates">{campaign.candidates.map(item => <article key={item.id} className={selectedCandidateIds.includes(item.id) ? 'prospect-candidate is-selected' : 'prospect-candidate'}><label className="prospect-candidate-choice"><input type="checkbox" disabled={operationBusy || !item.videos.length} checked={selectedCandidateIds.includes(item.id)} onChange={event => setSelectedCandidates(ids => event.target.checked ? [...ids, item.id] : ids.filter(id => id !== item.id))} /><span><strong>{item.nickname}</strong>{item.description && <span>{item.description}</span>}</span></label><details className="prospect-candidate-detail"><summary>来源与匹配依据<span>{item.videos.length} 个视频</span><ChevronDown size={13} /></summary>{item.reason && <p>{item.reason}</p>}<SourceLink href={item.profileUrl}>查看账号</SourceLink><ul>{item.videos.map(video => <li key={video.id}><SourceLink href={video.url}>{video.title || '查看来源视频'}</SourceLink></li>)}</ul>{!item.videos.length && <p className="prospect-secondary">暂无可采集的来源视频。</p>}</details></article>)}</div><div className="prospect-form-footer"><button className="button primary" disabled={!available || !selectedCandidateIds.length || jobs.some(job => job.kind === 'collect' && ['queued', 'running'].includes(job.status))} onClick={() => { void execute('collect', () => post({ action: 'collect', campaignId: campaign.id, candidateIds: selectedCandidateIds }), () => { setTab('leads'); setFilter('all'); }); }}><ArrowRight size={16} />采集所选账号评论</button><span>每个来源视频最多读取 {campaign.maxCommentsPerVideo} 条。</span></div></> : null}
        </section>}
        {tab === 'leads' && <section className="prospect-section"><div className="prospect-section-heading"><div><h2>评论线索</h2><p>批准后排队发送；“已提交”不代表送达或已读。</p></div><button className="button secondary" disabled={operationBusy || paused || !leads.length || !snapshot.modelReady} onClick={() => campaignAction('analyze')}><RefreshCw size={15} />重新分析</button></div>
          <div className="prospect-intent-summary"><div><strong>{highIntentCount} 条高意向</strong><span>共 {leads.length} 条</span><details className="prospect-score-details"><summary>评分说明<ChevronDown size={13} /></summary><p>高意向 ≥ {campaign.minIntentScore} / 100 分，按评分排序，包含无主页评论。模型评分 {modelScoredCount} 条，规则初筛 {leads.length - modelScoredCount} 条；发送需可联系身份并遵循审核设置。</p></details></div><button className="button secondary" onClick={() => changeLeadFilter(filter === 'highIntent' ? 'all' : 'highIntent')}>{filter === 'highIntent' ? '查看全部评论' : '只看高意向'}</button></div>
          {readOnlyAccount && <p id={`${prefix}-send-identity`} className="prospect-context-note" role="status"><CircleAlert size={16} /><span>当前账号可搜索和采集，尚未核实发信身份。请在 Mac 助手中停止同步，再点“连接抖音”，按提示核对账号。</span></p>}
          <div className="prospect-review-toolbar"><label htmlFor={`${prefix}-filter`}>查看<select id={`${prefix}-filter`} value={filter} onChange={event => changeLeadFilter(event.target.value as typeof filter)}><option value="all">全部评论（{leads.length}）</option><option value="highIntent">高意向（{highIntentCount}）</option><option value="pending">待审核（{pendingCount}）</option><option value="submitted">已提交</option><option value="attention">需要处理（{attentionCount}）</option></select></label>{filter === 'pending' && eligible.length > 0 && <label><input type="checkbox" disabled={operationBusy} checked={eligible.every(lead => selectedLeads[lead.id] === lead.version)} onChange={event => setSelectedLeads(event.target.checked ? Object.fromEntries(eligible.map(lead => [lead.id, lead.version])) : {})} />选择可联系项</label>}<button className="button secondary" aria-describedby={readOnlyAccount ? `${prefix}-send-identity` : undefined} disabled={!sendingAvailable || !selected.length || selected.some(lead => !greetingFor(lead).trim() || draftConflict(lead))} onClick={approveSelected}>{busy === 'batch' ? <Loader2 size={15} className="spin" /> : <Check size={15} />}批准所选{selected.length ? `（${selected.length}）` : ''}</button></div>
          {jobs.some(job => job.kind === 'collect' && ['queued', 'running'].includes(job.status)) && <p className="prospect-context-note" role="status"><Loader2 size={16} className="spin" />正在采集评论并筛选线索，完成后自动刷新。</p>}
          {latestCollection && (latestCollection.warnings?.length || latestCollection.error) ? <div className="prospect-message" role="status"><CircleAlert size={17} /><div><strong>{latestCollection.status === 'done' ? '上次采集提示' : '上次采集未完成'}</strong><p className="prospect-secondary">{dateLabel(latestCollection.updatedAt)}{latestCollection.summary ? ` · ${latestCollection.summary}` : ''}</p>{latestCollection.error && <p>{latestCollection.error}</p>}{latestCollection.warnings?.map((warning, index) => <p key={index}>{warning}</p>)}<button className="button ghost" onClick={() => setTab('history')}>查看执行记录</button></div></div> : null}
          {displayed.length ? <div className="prospect-leads">{displayed.map(lead => {
            const auto = automaticLead(lead);
            const self = selfRecipient(lead);
            const draft = draftFor(lead);
            const conflict = draftConflict(lead);
            const pending = lead.status === 'pending';
            const retryable = lead.status === 'failed' || lead.status === 'unknown';
            const canReject = pending || lead.status === 'unreachable';
            return <article key={lead.id} className="prospect-lead">
              <header><label>{pending && !auto && <input type="checkbox" disabled={operationBusy || !contactable(lead) || self || conflict} checked={!self && selectedLeads[lead.id] === lead.version} onChange={event => setSelectedLeads(values => { const next = { ...values }; if (event.target.checked) next[lead.id] = lead.version; else delete next[lead.id]; return next; })} />}<strong>{lead.nickname || '未提供昵称'}</strong></label><span className={`prospect-status is-${lead.status}`}>{leadLabels[lead.status]}</span>{highIntent(lead) && <span className="prospect-intent-badge" title={`达到当前任务阈值：≥ ${campaign.minIntentScore} 分`}>高意向</span>}<span className="prospect-score">意向 {lead.intentScore} / 100 分</span></header>
              <blockquote>{lead.text}</blockquote>
              <div className="prospect-source"><SourceLink href={lead.videoUrl}>评论来源</SourceLink><SourceLink href={lead.profileUrl}>用户主页</SourceLink><span>{lead.source === 'mediacrawler' ? '导入评论' : '浏览器采集'} · {lead.analysisSource === 'model' ? '模型分析' : '规则初筛'}</span></div>
              <p className="prospect-reason"><strong>评分理由：</strong>{lead.reason || '暂无评分理由，可重新分析后查看。'}</p>
              {self && <p id={`${prefix}-self-${lead.id}`} className="prospect-inline-help">当前登录账号，不能给自己发私信。</p>}
              {lead.error && <p className="prospect-inline-error" role="alert"><CircleAlert size={14} /> {lead.error}</p>}
              {pending && auto && <p className="prospect-inline-help">{paused ? '任务已暂停。恢复后，本线索仍按自动策略处理；这里的文案仅供查看。' : '此线索由后台自动分析与筛选，达到条件后会使用服务端文案发送。处理期间不开放本地编辑，可在上方暂停任务。'}</p>}
              {pending && !auto ? <>
                <div className="prospect-field"><label htmlFor={`${prefix}-greeting-${lead.id}`}>发送前可编辑招呼</label><textarea id={`${prefix}-greeting-${lead.id}`} rows={3} maxLength={300} value={greetingFor(lead)} disabled={operationBusy} onChange={event => setDrafts(values => ({ ...values, [draftKey(lead)]: { version: values[draftKey(lead)]?.version ?? lead.version, greeting: event.target.value } }))} /></div>
                {conflict && <div className="prospect-draft-conflict" role="status"><p>这条线索的分析或状态已更新，你的文案已保留。核对最新内容后再审核。</p><details><summary>查看最新分析文案</summary><p>{lead.greeting}</p></details><div className="prospect-inline-actions"><button className="button secondary" disabled={operationBusy} onClick={() => setDrafts(values => ({ ...values, [draftKey(lead)]: { version: lead.version, greeting: draft!.greeting } }))}>保留我的文案，确认新版本</button><button className="button ghost" disabled={operationBusy} onClick={() => discardLeadDraft(lead)}>使用最新草稿</button></div></div>}
                {paused && <p className="prospect-inline-help">任务已暂停，可先修改文案；恢复任务后再批准或拒绝。</p>}
                {!contactable(lead) && <p className="prospect-inline-help">没有可联系的公开身份，不能发送私信。</p>}
                {readOnlyAccount && <p className="prospect-inline-help">发送暂不可用，请先在 Mac 助手确认发信账号。招呼草稿仍可编辑，也可拒绝线索。</p>}
                <footer><button className="button primary" aria-describedby={self ? `${prefix}-self-${lead.id}` : readOnlyAccount ? `${prefix}-send-identity` : undefined} disabled={!sendingAvailable || !contactable(lead) || self || conflict || !greetingFor(lead).trim()} onClick={() => review(lead, 'approve')}>{busy === lead.id ? <Loader2 size={15} className="spin" /> : <Send size={15} />}批准并发送</button><button className="button ghost" disabled={operationBusy || paused} onClick={() => review(lead, 'reject')}>拒绝</button></footer>
              </> : <>
                {lead.greeting && <details className="prospect-sent-copy"><summary>{retryable ? '查看重试使用的原招呼' : '查看招呼文案'}<ChevronDown size={14} /></summary><p>{lead.greeting}</p></details>}
                {draft && <div className="prospect-draft-conflict" role="status"><p>你的本地文案尚未提交，当前处理状态不会使用这份草稿。</p><details><summary>查看保留的本地草稿</summary><p>{draft.greeting}</p></details><button className="button ghost" disabled={operationBusy} onClick={() => discardLeadDraft(lead)}>丢弃这份本地草稿</button></div>}
                {lead.status === 'unreachable' && <p className="prospect-inline-help">没有可联系的公开身份，仅供分析，不能发送私信。可拒绝这条线索。</p>}
                {retryable && <><p className="prospect-inline-help">{lead.status === 'unknown' ? '助手会先核对抖音会话，再决定是否重发。重试沿用上次已批准的招呼文案。' : '重试沿用上次已批准的招呼文案，助手会先核对会话再执行。'}</p>{!busy && !loading && !sendingAvailable && <p className="prospect-inline-help">{paused ? '任务已暂停，恢复任务后可重试。' : !connected ? '请先连接助手并确认抖音登录，再重试发送。' : '请先在 Mac 助手确认发信账号，再重试发送。'}</p>}<footer><button className="button primary" aria-describedby={self ? `${prefix}-self-${lead.id}` : readOnlyAccount ? `${prefix}-send-identity` : undefined} disabled={!sendingAvailable || !contactable(lead) || self} onClick={() => retrySend(lead)}>{busy === lead.id ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}{lead.status === 'unknown' ? '核对并重试' : '重试发送'}</button></footer></>}
                {canReject && <button className="button ghost" disabled={operationBusy || paused} onClick={() => review(lead, 'reject')}>拒绝</button>}
              </>}
            </article>;
          })}</div> : <div className="prospect-empty"><Search size={26} /><h3>{leads.length ? filter === 'highIntent' ? `暂无达到 ${campaign.minIntentScore} 分的评论` : filter === 'pending' ? '当前没有待审核评论' : '当前筛选下没有评论' : emptyCollection.title}</h3><p>{leads.length ? filter === 'highIntent' ? `已评分 ${leads.length} 条评论，暂未达到当前任务的高意向阈值。可以查看全部评论，核对每条评分来源和理由。` : `已保存 ${leads.length} 条评论。${unreachableCount ? `其中 ${unreachableCount} 条暂不可联系，例如缺少公开主页身份；这些评论仍可查看和分析。` : '当前没有符合此筛选状态的评论。'}切换为全部评论即可查看。` : emptyCollection.message}</p>{leads.length > 0 ? <button className="button primary" onClick={() => changeLeadFilter('all')}>查看全部评论（{leads.length}）</button> : latestCollection && !['queued', 'running'].includes(latestCollection.status) ? <button className="button secondary" onClick={() => setTab('history')}>查看采集记录</button> : !latestCollection ? <button className="button secondary" onClick={() => setTab('candidates')}>选择账号并采集评论</button> : null}</div>}
          <details className="prospect-import"><summary><FileUp size={16} />导入已有评论<ChevronDown size={15} /></summary><p>支持评论 JSON / JSONL，例如已有的 MediaCrawler 导出。每次最多 300 条、1.5MB。导入评论仅用于分析，不会用于发送私信。</p><div className="prospect-field"><label htmlFor={`${prefix}-file`}>选择文件</label><input id={`${prefix}-file`} type="file" accept=".json,.jsonl,.ndjson,application/json" disabled={operationBusy} onChange={event => void readImport(event.target.files?.[0])} />{importName && <small>已读取：{importName}</small>}</div><div className="prospect-field"><label htmlFor={`${prefix}-import`}>或粘贴评论数据</label><textarea id={`${prefix}-import`} rows={5} value={importContent} disabled={operationBusy} onChange={event => { importReadGeneration.current++; setImportContent(event.target.value); setImportName(''); }} placeholder="粘贴 JSON 数组或逐行 JSON 数据" spellCheck={false} /></div><button className="button secondary" disabled={operationBusy || !importContent.trim()} onClick={() => void execute('import', () => post({ action: 'import', campaignId: campaign.id, content: importContent }), () => { setImportContent(''); setImportName(''); setFilter('all'); })}><FileUp size={15} />导入并筛选</button></details>
        </section>}
        {tab === 'history' && <section className="prospect-section"><div className="prospect-section-heading"><div><h2>每一步都有记录</h2><p>采集和发送任务独立处理，离开此页面不会中断已排队任务。</p></div><button className="button ghost" disabled={operationBusy} onClick={() => void refresh(activeCampaign.current, true)}><RefreshCw size={15} />刷新</button></div>{visibleJobs.length ? <div className="prospect-jobs">{visibleJobs.map(job => <article key={job.id}><div><strong>{jobKinds[job.kind]}</strong><span className={`prospect-status is-${job.status}`}>{jobLabels[job.status]}</span><time dateTime={job.createdAt}>{dateLabel(job.createdAt)}</time></div>{job.summary && <p>{job.summary}</p>}{job.error && <p className="prospect-inline-error">{job.error}</p>}{job.kind === 'collect' && Boolean(job.warnings?.length) && <div><strong>采集提示</strong>{job.warnings?.map((warning, index) => <p key={index}>{warning}</p>)}</div>}{job.status === 'unknown' && <p>{job.kind === 'reply' ? '回复结果尚未确认，请在聊天获客中核对消息记录与抖音原会话。' : '结果尚未确认。可在原评论点击“核对并重试”，助手会先检查抖音会话。'}</p>}</article>)}</div> : <div className="prospect-empty"><h3>还没有执行记录</h3><p>开始发现账号、采集评论或发送招呼后，这里会保留真实处理结果。</p></div>}</section>}
      </>}
      {!creating && <ProspectingConversations key={campaign?.id || 'global'} campaignId={campaign?.id} active={tab === 'chat' || tab === 'pool'} view={tab === 'pool' ? 'pool' : 'chat'} blocked={Boolean(busy) || loading} paused={Boolean(paused)} modelReady={snapshot.modelReady} assistantOnline={Boolean(device?.online)} sendingAvailable={Boolean(connected && !readOnlyAccount && !paused && !busy && !loading)} resetKey={chatResetKey} onViewChange={setTab} onDirtyChange={setChatDirty} onBusyChange={onChatBusyChange} />}
    </>}
    {leaveRequested && <Overlay className="confirmation-dialog" title="有尚未保存的获客内容" onClose={() => { setLeaveRequested(false); pendingLeave.current = null; }}><p>继续会丢弃未提交的需求、招呼草稿、聊天回复或导入内容。尚未保存的一次性配对配置也会关闭。</p><div className="contract-leave-actions"><button data-dialog-initial-focus="true" className="button secondary" onClick={() => { setLeaveRequested(false); pendingLeave.current = null; }}>继续编辑</button><button className="button primary" onClick={() => { const proceed = pendingLeave.current; pendingLeave.current = null; discardDrafts(); setLeaveRequested(false); proceed?.(); }}>放弃更改并继续</button></div></Overlay>}
  </div>;
}

function CampaignSummary({ campaign, busy, onToggle }: { campaign: ProspectCampaign; busy: boolean; onToggle: () => void }) {
  return <section className="prospect-campaign-summary"><details><summary><span>任务要求</span><span className="prospect-status">{campaign.status === 'paused' ? '已暂停' : '运行中'}</span><span className="prospect-secondary">{campaign.reviewMode === 'manual' ? '人工审核' : '自动发送'} · 每日 {campaign.dailyLimit} 条</span><ChevronDown size={14} /></summary><p>{campaign.requirements}</p><div className="prospect-policy"><span>{campaign.reviewMode === 'manual' ? '人工审核后发送' : `模型评分 ≥ ${campaign.minIntentScore} 分自动发送`}</span><span>每视频最多采集 {campaign.maxCommentsPerVideo} 条</span></div></details><button className="button secondary" disabled={busy} onClick={onToggle}>{campaign.status === 'paused' ? <Play size={15} /> : <Pause size={15} />}{campaign.status === 'paused' ? '恢复任务' : '暂停任务'}</button></section>;
}
