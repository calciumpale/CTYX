'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowDown, ChevronDown, Bot, Check, CircleAlert, Clock3, ExternalLink, Loader2, MessageCircle, RefreshCw, Send, UserRound, Users, X } from 'lucide-react';
import type { ProspectChatConversation, ProspectChatGrade, ProspectChatMessage, ProspectChatPolicy, ProspectChatSnapshot } from '../lib/prospecting-chat-types';
import { defaultChatPolicy, normalizeChatPolicy, withinChatHours } from '../lib/prospecting-chat-policy';
import { useChatScroll } from '../lib/use-chat-scroll';
import './prospecting-conversations.css';
import { ProspectingMemory, prospectMessageId } from './ProspectingMemory';
import { ProspectingFilters, ProspectingList, ProspectingPanel } from './ProspectingInbox';

type ChatView = 'chat' | 'pool';
type Props = {
  campaignId?: string;
  active: boolean;
  view: ChatView;
  blocked: boolean;
  paused: boolean;
  modelReady: boolean;
  assistantOnline: boolean;
  sendingAvailable: boolean;
  resetKey: number;
  toolbarStart?: ReactNode;
  toolbarActions?: ReactNode;
  onViewChange: (view: ChatView) => void;
  onCampaignChange?: (campaignId: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
};
type ChatResult = { message?: string; chat: ProspectChatSnapshot };
type PolicyDraft = Omit<ProspectChatPolicy, 'replyDailyLimit' | 'conversationReplyLimit' | 'replyHoursEnabled'> & { replyDailyLimit: string; conversationReplyLimit: string; replyHoursEnabled: boolean };
const draftFromPolicy = (policy: ProspectChatPolicy = defaultChatPolicy()): PolicyDraft => {
  const normalized = normalizeChatPolicy(policy);
  return { ...normalized, replyHoursEnabled: Boolean(normalized.replyHoursEnabled), libraryIds: [...normalized.libraryIds], replyDailyLimit: String(normalized.replyDailyLimit), conversationReplyLimit: String(normalized.conversationReplyLimit) };
};
const policySignature = (policy: PolicyDraft) => JSON.stringify({ ...policy, libraryIds: [...policy.libraryIds].sort() });
function policyError(policy: PolicyDraft) {
  if (!/^\d+$/.test(policy.replyDailyLimit) || Number(policy.replyDailyLimit) < 1 || Number(policy.replyDailyLimit) > 80) return '每日回复上限须为 1–80 条。';
  if (!/^\d+$/.test(policy.conversationReplyLimit) || Number(policy.conversationReplyLimit) < 1 || Number(policy.conversationReplyLimit) > 30) return '每个会话 24 小时内的回复上限须为 1–30 条。';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(policy.workStart) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(policy.workEnd) || policy.workStart >= policy.workEnd) return '请选择有效的工作时间，开始时间须早于结束时间。';
  if (policy.libraryIds.length > 20) return '最多选择 20 个知识库。';
  return '';
}
const gradeLabels: Record<ProspectChatGrade, string> = { high: '高意向', medium: '一般意向', low: '待培育' };
const messageLabels: Record<ProspectChatMessage['status'], string> = { received: '已同步', queued: '等待发送', waiting: '等待账号核验，尚未发送', sending: '正在发送', sent: '已提交', failed: '发送失败', unknown: '结果待核对', cancelled: '已取消' };
const isVerificationRecord = (message: ProspectChatMessage) => message.actor === 'agent' && message.status === 'failed' && message.retryable === true;
const actorLabels: Record<ProspectChatMessage['actor'], string> = { customer: '客户', agent: 'AI 获客助手', human: '人工回复' };
const contactLabels = { phone: '手机号', wechat: '微信', email: '邮箱' };
const humanModeLabel = (conversation: ProspectChatConversation) => conversation.handoffReason === '已由销售接管' ? '人工接管中' : '需人工处理';
const conversationModeLabel = (conversation: ProspectChatConversation) => conversation.status === 'closed'
  ? '已结束' : conversation.mode === 'human' ? humanModeLabel(conversation) : 'AI 跟进';
const handoffReason = (conversation: ProspectChatConversation) => conversation.handoffReason?.trim() || '未记录接管原因，请查看客户消息后继续跟进。';
function syncProblem(value?: string) {
  if (!value) return '上次读取未完成，请重新同步。';
  if (/账号.*(?:变化|改变|不一致)|身份.*(?:变化|改变|不一致)/.test(value)) return '无法确认发信账号，请在助手中核验原账号后重新同步。';
  if (/登录|认证|核验/.test(value)) return '抖音登录状态待确认，请在助手中完成登录核验后重新同步。';
  if (/面板|人工操作/.test(value)) return '会话面板尚未就绪，请在抖音打开此会话后重新同步。';
  if (/超时|网络|连接/.test(value)) return '会话读取暂时中断，请检查助手连接后重新同步。';
  return value;
}
const errorMessage = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请刷新后重试。';
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

function dateLabel(value?: string) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '时间待确认';
}
function ConversationAvatar({ nickname }: { nickname?: string }) {
  const initial = Array.from(nickname?.trim() || '')[0];
  return <span className="prospect-conversation-avatar" aria-hidden="true">{initial || <UserRound size={15} />}</span>;
}
function VerificationRecords({ messages, onInspect }: { messages: ProspectChatMessage[]; onInspect: () => void }) {
  return <details className="prospect-chat-verification-records" onToggle={onInspect}>
    <summary><span>账号核验记录（{messages.length}次，均未发送）</span><ChevronDown size={13} /></summary>
    <ol>{messages.map(message => <li key={message.id} id={prospectMessageId(message.id)} tabIndex={-1}>
      <header><span>{actorLabels[message.actor]}</span><time dateTime={message.createdAt}>{dateLabel(message.createdAt)}</time></header>
      <p>{message.text}</p><span>{message.error || '账号核验未完成，本次未发送。'}</span>
    </li>)}</ol>
  </details>;
}
function profileLink(value: string) {
  try { const url = new URL(value); if (url.protocol === 'https:' && (url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com'))) return url.href; } catch { /* Only show verified Douyin URL shapes. */ }
}

export function ProspectingConversations({ campaignId, active, view, blocked, paused, modelReady, assistantOnline, sendingAvailable, resetKey, toolbarStart, toolbarActions, onViewChange, onCampaignChange, onDirtyChange, onBusyChange }: Props) {
  const prefix = useId();
  const [loaded, setLoaded] = useState<{ snapshot: ProspectChatSnapshot; campaignScope: boolean; conversationId: string } | null>(null);
  const [observedAt, setObservedAt] = useState(0);
  const [scope, setScope] = useState<'campaign' | 'global'>(campaignId ? 'campaign' : 'global');
  const [selectedId, setSelectedId] = useState('');
  const [selectedPoolId, setSelectedPoolId] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [query, setQuery] = useState('');
  const [poolQuery, setPoolQuery] = useState('');
  const [modeFilter, setModeFilter] = useState('all');
  const [grade, setGrade] = useState<'all' | ProspectChatGrade>('all');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [readError, setReadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [policyDraft, setPolicyDraft] = useState<PolicyDraft>(() => draftFromPolicy());
  const [policyReady, setPolicyReady] = useState(false);
  const [policyDirty, setPolicyDirty] = useState(false);
  const [memoryDirty, setMemoryDirty] = useState(false);
  const policyDirtyRef = useRef(false);
  const savedPolicy = useRef(policySignature(draftFromPolicy()));
  const mounted = useRef(true);
  const selectedRef = useRef('');
  const epoch = useRef(0);
  const readInFlight = useRef(false);
  const busyRef = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  const previousResetKey = useRef(resetKey);
  const replyInput = useRef<HTMLTextAreaElement>(null);
  const selectedRow = useRef<HTMLElement>(null);
  const campaignScope = view === 'chat' && scope === 'campaign' && Boolean(campaignId);
  const snapshot = loaded?.campaignScope === campaignScope ? loaded.snapshot : undefined;
  const selectedSync = snapshot?.sync?.conversationId === selectedId ? snapshot.sync : undefined;
  const syncInProgress = snapshot?.online && (selectedSync?.status === 'queued' || selectedSync?.status === 'running');

  const request = useCallback(async <T,>(url: string, init: RequestInit = {}): Promise<T> => {
    const controller = new AbortController(); controllers.current.add(controller);
    try {
      const response = await fetch(url, { ...init, credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      let body: T & { error?: string; message?: string };
      try { body = await response.json(); } catch { throw new Error('会话服务暂时没有响应，请稍后刷新。'); }
      if (!response.ok) throw new Error(body.error || body.message || `操作未完成（${response.status}），请刷新后重试。`);
      return body;
    } finally { controllers.current.delete(controller); }
  }, []);

  const applySnapshot = useCallback((next: ProspectChatSnapshot, campaignScope: boolean, conversationId: string, settingsUpdate = false, savedSettings = false) => {
    if (!mounted.current) return;
    setLoaded(current => settingsUpdate && current?.campaignScope === campaignScope
      ? { ...current, snapshot: { ...current.snapshot, enabled: next.enabled, online: next.online, policy: next.policy, libraries: next.libraries } }
      : { snapshot: next, campaignScope, conversationId });
    setObservedAt(Date.now());
    if (campaignScope) {
      const nextPolicy = draftFromPolicy(next.policy);
      savedPolicy.current = policySignature(nextPolicy);
      setPolicyReady(true);
      if (savedSettings || !policyDirtyRef.current) {
        setPolicyDraft(nextPolicy); setPolicyDirty(false); policyDirtyRef.current = false;
      }
    }
  }, []);

  const refresh = useCallback(async (force = false) => {
    if (busyRef.current || readInFlight.current && !force) return;
    const generation = ++epoch.current; readInFlight.current = true;
    const selected = view === 'chat' ? selectedRef.current : '';
    try {
      const params = new URLSearchParams({ mode: 'chat', ...(campaignScope && campaignId ? { campaignId } : {}), ...(selected ? { conversationId: selected } : {}) });
      const next = await request<ProspectChatSnapshot>(`/api/prospecting?${params}`);
      if (mounted.current && generation === epoch.current) { applySnapshot(next, campaignScope, selected); setReadError(''); }
    } catch (cause) {
      if (mounted.current && generation === epoch.current && !aborted(cause)) setReadError(errorMessage(cause));
    } finally {
      if (generation === epoch.current) readInFlight.current = false;
    }
  }, [applySnapshot, campaignId, campaignScope, request, view]);

  useEffect(() => {
    mounted.current = true; const currentControllers = controllers.current;
    return () => { mounted.current = false; currentControllers.forEach(controller => controller.abort()); currentControllers.clear(); };
  }, []);
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => { void refresh(true); });
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, syncInProgress ? 1500 : 4000);
    return () => { cancelAnimationFrame(frame); clearInterval(timer); };
  }, [active, refresh, selectedId, syncInProgress]);
  useEffect(() => { onDirtyChange(memoryDirty || policyDirty || Object.values(drafts).some(value => value.trim().length > 0)); }, [drafts, memoryDirty, onDirtyChange, policyDirty]);
  useEffect(() => {
    if (previousResetKey.current === resetKey) return;
    previousResetKey.current = resetKey;
    const frame = requestAnimationFrame(() => {
      setDrafts({}); setPolicyDraft(JSON.parse(savedPolicy.current) as PolicyDraft); setPolicyDirty(false); setMemoryDirty(false); policyDirtyRef.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [resetKey]);
  useEffect(() => () => { onDirtyChange(false); onBusyChange(false); }, [onBusyChange, onDirtyChange]);

  async function execute(action: string, extra: Record<string, unknown>, after?: () => void) {
    if (busyRef.current || blocked || !campaignId && !(action === 'chatLearn' && extra.campaignId)) return false;
    busyRef.current = true; epoch.current++; readInFlight.current = false;
    setBusy(action); onBusyChange(true); setError(''); setNotice('');
    let succeeded = false;
    try {
      const result = await request<ChatResult>('/api/prospecting', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, campaignId, ...extra }) });
      if (!mounted.current) return false;
      if (campaignScope && action !== 'chatLearn') applySnapshot(result.chat, true, typeof extra.conversationId === 'string' ? extra.conversationId : '', action === 'chatSettings', Boolean(extra.policy));
      setReadError(''); if (action !== 'chatSync') setNotice(result.message || '会话设置已保存。'); succeeded = true; return true;
    } catch (cause) {
      if (mounted.current && !aborted(cause)) setError(errorMessage(cause));
      return false;
    } finally {
      busyRef.current = false;
      if (mounted.current) {
        setBusy(''); onBusyChange(false);
        // Workspace navigation checks its synchronous busy ref. Release it before success callbacks.
        if (succeeded && mounted.current) after?.();
        if (mounted.current && !(succeeded && action === 'chatSwitchTask' && onCampaignChange)) void refresh(true);
      }
    }
  }

  function canChangeDetail() {
    if (busyRef.current) return false;
    if (!memoryDirty) return true;
    setError('请先保存或取消记忆修改。');
    return false;
  }

  function rememberRow() {
    selectedRow.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  function selectConversation(id: string) {
    if (!canChangeDetail()) return;
    rememberRow();
    setShowSettings(false);
    selectedRef.current = id; setSelectedId(id); setReadError(''); setError(''); setNotice('');
  }

  function returnToList() {
    if (!canChangeDetail()) return;
    if (view === 'pool') setSelectedPoolId('');
    else if (settingsOpen) setShowSettings(false);
    else { selectedRef.current = ''; setSelectedId(''); }
    setReadError(''); setError('');
    requestAnimationFrame(() => {
      if (selectedRow.current?.isConnected) selectedRow.current.focus({ preventScroll: true });
      else document.getElementById(`${prefix}-${view === 'pool' ? 'pool-search' : 'search'}`)?.focus({ preventScroll: true });
    });
  }

  const conversation = loaded?.conversationId === selectedId ? snapshot?.conversations.find(item => item.id === selectedId) : undefined;
  const conversations = snapshot?.conversations.filter(item => {
    const matchesMode = modeFilter === 'all' || (item.status === 'closed' ? modeFilter === 'closed' : item.mode === modeFilter);
    return matchesMode && `${item.nickname} ${item.lastMessagePreview}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  }) || [];
  const messages = (snapshot?.messages || []).filter(message => message.conversationId === selectedId);
  const verificationRecords = messages.filter(isVerificationRecord);
  const latestOutbound = messages.findLast(message => message.direction === 'outbound');
  const transcriptKey = `${active && view === 'chat' ? selectedId : ''}:${messages.map(message => `${message.id}:${message.status}`).join('|')}`;
  const { containerRef, markUserInput, onScroll, showJump, jumpToLatest } = useChatScroll(transcriptKey, selectedId);
  const draft = drafts[selectedId] || '';
  const mutationBlocked = blocked || Boolean(busy);
  const settingsError = policyError(policyDraft);
  const readOnlyConversation = Boolean(!campaignId || conversation?.campaignId !== campaignId || conversation.memoryEditable === false || conversation.taskMemory && !conversation.taskMemory.isActive);
  const syncAvailable = view === 'chat' && Boolean(conversation) && !readOnlyConversation;
  const syncStatus = syncAvailable ? selectedSync : undefined;
  const syncPending = busy === 'chatSync' || syncStatus?.status === 'queued' || syncStatus?.status === 'running';
  const syncIssue = Boolean(syncStatus?.error || syncStatus && ['failed', 'unknown', 'cancelled'].includes(syncStatus.status));
  const lastSyncedMs = Date.parse(conversation?.lastSyncedAt || '');
  const hasSynced = Number.isFinite(lastSyncedMs);
  const syncStalled = Boolean(hasSynced && conversation?.mode === 'agent' && conversation.status === 'active' &&
    snapshot?.enabled && !paused && observedAt - lastSyncedMs >= 3 * 60_000);
  const syncLabel = syncPending && snapshot?.online === false ? '启动本机助手后将继续同步'
    : syncStatus?.status === 'running' ? '正在读取抖音私信' : syncPending ? '等待本机助手同步'
    : syncIssue ? `同步失败：${syncProblem(syncStatus?.error)}`
    : syncStalled ? '同步已停滞' : '';
  const canReply = Boolean(!readOnlyConversation && conversation?.mode === 'human' && conversation.status === 'active' && sendingAvailable && !mutationBlocked && !paused);
  const conversationById = new Map(snapshot?.conversations.map(item => [item.id, item]));
  const captureByConversation = new Map(snapshot?.pool.map(item => [item.conversationId, item]));
  const pool = (snapshot?.pool || []).filter(item => (grade === 'all' || item.grade === grade) && `${item.nickname} ${conversationById.get(item.conversationId)?.lastMessagePreview || ''} ${item.contactValue} ${item.assignedName || ''}`.toLocaleLowerCase().includes(poolQuery.trim().toLocaleLowerCase()));
  const selectedCapture = snapshot?.pool.find(item => item.id === selectedPoolId);
  const withinWorkHours = withinChatHours(observedAt, snapshot?.policy || defaultChatPolicy());
  const agentOnline = Boolean(snapshot?.enabled && snapshot.online && !paused && modelReady && withinWorkHours);
  const agentState = !snapshot?.enabled ? 'AI 助手未开启' : paused ? '任务已暂停' : !modelReady ? '等待模型就绪' : snapshot.online ? withinWorkHours ? 'AI 助手在线' : '等待回复时段' : assistantOnline ? '等待抖音账号确认' : '等待助手上线';
  const profile = conversation ? profileLink(conversation.profileUrl) : undefined;
  const settingsOpen = campaignScope && showSettings && Boolean(snapshot);
  const panelOpen = view === 'pool' ? Boolean(selectedCapture) : settingsOpen || Boolean(selectedId);

  function openSettings() {
    if (!canChangeDetail()) return;
    rememberRow();
    setShowSettings(true);
  }

  function showCurrentTask() {
    if (!canChangeDetail()) return;
    setSelectedPoolId(''); selectedRef.current = ''; setSelectedId('');
    setScope('campaign'); setPolicyReady(false); setLoaded(null); setShowSettings(false); setReadError('');
    if (view === 'pool') onViewChange('chat');
  }

  function showCapturedConversation(conversationId: string) {
    if (!canChangeDetail()) return;
    setSelectedPoolId(''); setScope('global');
    selectConversation(conversationId); onViewChange('chat');
  }

  function sendReply(event?: FormEvent) {
    event?.preventDefault();
    if (!conversation || !canReply || !draft.trim()) return;
    const id = conversation.id;
    void execute('chatReply', { conversationId: id, version: conversation.version, message: draft.trim() }, () => {
      setDrafts(current => { const next = { ...current }; delete next[id]; return next; });
      replyInput.current?.focus();
    });
  }
  function changeMode(item: ProspectChatConversation) {
    if (readOnlyConversation || item.status === 'closed') return;
    void execute(item.mode === 'human' ? 'chatResume' : 'chatTakeover', { conversationId: item.id, version: item.version });
  }
  function updatePolicy(patch: Partial<PolicyDraft>) {
    const next = { ...policyDraft, ...patch };
    const dirty = policySignature(next) !== savedPolicy.current;
    policyDirtyRef.current = dirty; setPolicyDirty(dirty); setPolicyDraft(next);
  }
  function updateReplyHours(enabled: boolean) {
    const valid = /^([01]\d|2[0-3]):[0-5]\d$/.test(policyDraft.workStart) && /^([01]\d|2[0-3]):[0-5]\d$/.test(policyDraft.workEnd) && policyDraft.workStart < policyDraft.workEnd;
    const hours = !enabled && !valid ? normalizeChatPolicy(JSON.parse(savedPolicy.current)) : policyDraft;
    updatePolicy({ replyHoursEnabled: enabled, workStart: hours.workStart, workEnd: hours.workEnd });
  }
  function savePolicy(event: FormEvent) {
    event.preventDefault();
    if (!policyReady || !snapshot || settingsError || mutationBlocked || scope !== 'campaign') return;
    void execute('chatSettings', { enabled: snapshot.enabled, policy: { ...policyDraft, replyDailyLimit: Number(policyDraft.replyDailyLimit), conversationReplyLimit: Number(policyDraft.conversationReplyLimit) } });
  }

  return <section className="prospect-chat-workspace" hidden={!active} aria-label={view === 'chat' ? '聊天获客' : '留资线索池'}>
    <ProspectingFilters className="prospect-chat-filters">
      {toolbarStart}
      <label className="prospect-sr-only" htmlFor={`${prefix}-${view === 'chat' ? 'search' : 'pool-search'}`}>{view === 'chat' ? '查找会话' : '查找留资线索'}</label>
      {view === 'chat' ? <>
        <input className="prospect-chat-filter-search" id={`${prefix}-search`} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索用户名或原文" />
        <label className="prospect-sr-only" htmlFor={`${prefix}-mode`}>会话状态</label>
        <select id={`${prefix}-mode`} value={modeFilter} onChange={event => setModeFilter(event.target.value)}>
          <option value="all">全部状态</option><option value="agent">AI 跟进</option><option value="human">人工处理</option><option value="closed">已结束</option>
        </select>
      </> : <>
        <input className="prospect-chat-filter-search" id={`${prefix}-pool-search`} type="search" value={poolQuery} onChange={event => setPoolQuery(event.target.value)} placeholder="搜索用户名、原文或销售" />
        <label className="prospect-sr-only" htmlFor={`${prefix}-grade`}>意向等级</label>
        <select id={`${prefix}-grade`} value={grade} onChange={event => setGrade(event.target.value as typeof grade)}><option value="all">全部意向</option><option value="high">高意向</option><option value="medium">一般意向</option><option value="low">待培育</option></select>
      </>}
      <div className="prospect-chat-filter-actions">
        {campaignScope && snapshot && <button className="button ghost prospect-chat-agent-settings" type="button" onClick={openSettings} aria-expanded={settingsOpen} disabled={mutationBlocked}>跟进设置{policyDirty && <span className="prospect-chat-unsaved">未保存</span>}</button>}
        {view === 'chat' && !campaignScope && campaignId && <button className="button ghost" disabled={mutationBlocked} onClick={showCurrentTask}>返回当前任务会话</button>}
        <button className="icon-button" aria-label="刷新" title="刷新" disabled={mutationBlocked} onClick={() => void refresh(true)}><RefreshCw size={15} /></button>
        {toolbarActions}
      </div>
    </ProspectingFilters>
    {(error || readError) && <div className="prospect-message is-error" role="alert"><CircleAlert size={17} /><div><p>{error || readError}</p>{error && readError && <p>{readError}</p>}{readError && <button className="button ghost" disabled={mutationBlocked} onClick={() => void refresh(true)}>重新读取会话</button>}</div></div>}
    {notice && <div className="prospect-message" role="status"><Check size={17} /><p>{notice}</p><button className="icon-button" aria-label="关闭会话提示" onClick={() => setNotice('')}><X size={14} /></button></div>}
    {!snapshot ? readError ? <div className="prospect-empty"><h3>暂时无法读取会话</h3><p>请重新读取，已保存的消息和线索会在服务恢复后显示。</p></div> : <div className="prospect-empty" role="status"><Loader2 size={25} className="spin" /><h3>正在同步会话与线索</h3></div> : <div className="prospect-inbox-split" data-panel-open={panelOpen}>
      <div className="prospect-inbox-list prospect-chat-list">
        {view === 'chat' ? conversations.length ? <ProspectingList
          label="客户会话"
          selectedId={settingsOpen ? '' : selectedId}
          onSelect={selectConversation}
          rows={conversations.map(item => {
            const captured = captureByConversation.get(item.id);
            return {
              id: item.id,
              username: item.nickname || '未提供昵称',
              text: item.lastMessagePreview || '暂无原文预览',
              intent: captured ? <span className={`prospect-chat-badge is-grade-${captured.grade}`}>{gradeLabels[captured.grade]}</span> : '未评估',
              status: <span className="prospect-chat-row-status"><span className={`prospect-chat-badge${item.mode === 'human' && item.status !== 'closed' ? ' is-human' : ''}`}>{conversationModeLabel(item)}</span>{drafts[item.id]?.trim() && <span className="prospect-chat-draft-label">有草稿</span>}</span>,
            };
          })}
        /> : <div className="prospect-empty"><MessageCircle size={24} /><h3>{snapshot.conversations.length ? '没有匹配的会话' : '还没有同步的客户会话'}</h3><p>{snapshot.conversations.length ? '调整状态或搜索关键词后重试。' : campaignScope ? '完成评论线索的招呼并同步后，会话将显示在这里。' : '在线索池中打开客户会话，查看原始沟通记录。'}</p></div> : pool.length ? <ProspectingList
          label="留资线索池"
          selectedId={selectedPoolId}
          onSelect={id => { if (canChangeDetail()) { rememberRow(); setSelectedPoolId(id); setError(''); setNotice(''); } }}
          rows={pool.map(item => ({
            id: item.id,
            username: item.nickname || '未提供昵称',
            text: conversationById.get(item.conversationId)?.lastMessagePreview || '暂无原文预览',
            intent: <span className={`prospect-chat-badge is-grade-${item.grade}`}>{gradeLabels[item.grade]}</span>,
            status: <span className="prospect-chat-badge">{item.status === 'assigned' ? '已分配' : '待分配'}</span>,
          }))}
        /> : <div className="prospect-empty"><Users size={24} /><h3>{snapshot.pool.length ? '没有匹配的留资线索' : '暂无可查看的留资线索'}</h3><p>{snapshot.pool.length ? '调整意向等级或搜索关键词后重试。' : '销售可查看分配给自己的线索，管理者可查看团队线索。'}</p>{snapshot.pool.length ? <button className="button secondary" onClick={() => { setGrade('all'); setPoolQuery(''); }}>查看全部留资</button> : campaignId && <button className="button secondary" onClick={showCurrentTask}>进入当前任务聊天</button>}</div>}
      </div>
      {view === 'chat' && settingsOpen && <ProspectingPanel key="settings" title="跟进设置" closeLabel="关闭跟进设置" onClose={returnToList} className="prospect-chat-settings-panel">
        <div className="prospect-chat-agent-toolbar">
          <span className={`prospect-chat-badge${agentOnline ? ' is-online' : ''}`}>{agentState}</span>
          <button className={`button ${snapshot.enabled ? 'secondary' : 'primary'}`} disabled={mutationBlocked || !policyReady || !snapshot.enabled && (!modelReady || paused)} onClick={() => void execute('chatSettings', { enabled: !snapshot.enabled })}>{busy === 'chatSettings' ? <Loader2 size={15} className="spin" /> : <Bot size={15} />}{snapshot.enabled ? '关闭 AI 跟进' : '开启 AI 跟进'}</button>
        </div>
            <form className="prospect-chat-policy" onSubmit={savePolicy} aria-busy={busy === 'chatSettings'}>
              <fieldset disabled={mutationBlocked || !policyReady}>
                <legend className="prospect-sr-only">当前任务的 AI 跟进设置</legend>
                <div className="prospect-chat-policy-libraries"><span id={`${prefix}-libraries-label`} className="prospect-chat-policy-label">自动回复必查知识库</span><p id={`${prefix}-libraries-help`}>每次自动回复前都会检索所属部门及共享资料。检索失败时暂停自动回复，由销售核实。</p>
                  <div className="prospect-chat-library-options" role="group" aria-labelledby={`${prefix}-libraries-label`} aria-describedby={`${prefix}-libraries-help`}>
                    {snapshot.libraries?.length ? snapshot.libraries.map(library => <label key={library.id}><input type="checkbox" checked disabled aria-label={`${library.name}，自动检索`} /><span>{library.name}</span></label>) : <span className="prospect-chat-policy-empty">暂无所属部门或共享文档库</span>}
                  </div>
                </div>
                <div className="prospect-chat-policy-fields">
                  <div className="prospect-field"><label htmlFor={`${prefix}-daily-limit`}>每日回复上限</label><input id={`${prefix}-daily-limit`} type="number" min={1} max={80} step={1} inputMode="numeric" value={policyDraft.replyDailyLimit} onChange={event => updatePolicy({ replyDailyLimit: event.target.value })} required /><small>1–80 条，独立于招呼配额</small></div>
                  <div className="prospect-field"><label htmlFor={`${prefix}-conversation-limit`}>单会话回复上限</label><input id={`${prefix}-conversation-limit`} type="number" min={1} max={30} step={1} inputMode="numeric" value={policyDraft.conversationReplyLimit} onChange={event => updatePolicy({ conversationReplyLimit: event.target.value })} required /><small>每个会话 24 小时内 1–30 条</small></div>
                  <div className="prospect-field prospect-chat-policy-hours"><span id={`${prefix}-hours-label`} className="prospect-chat-policy-label">回复时段 · 北京时间</span><label className="prospect-chat-hours-toggle"><input type="checkbox" checked={policyDraft.replyHoursEnabled} onChange={event => updateReplyHours(event.target.checked)} /><span>限定回复时段</span></label><div role="group" aria-labelledby={`${prefix}-hours-label`}><label className="prospect-sr-only" htmlFor={`${prefix}-work-start`}>开始时间</label><input id={`${prefix}-work-start`} type="time" value={policyDraft.workStart} disabled={!policyDraft.replyHoursEnabled} onChange={event => updatePolicy({ workStart: event.target.value })} required /><span aria-hidden="true">—</span><label className="prospect-sr-only" htmlFor={`${prefix}-work-end`}>结束时间</label><input id={`${prefix}-work-end`} type="time" value={policyDraft.workEnd} disabled={!policyDraft.replyHoursEnabled} onChange={event => updatePolicy({ workEnd: event.target.value })} required /></div><small>{policyDraft.replyHoursEnabled ? '仅在所选时段自动回复' : '全天回复'}</small></div>
                </div>
              </fieldset>
              <div className="prospect-chat-policy-footer"><p id={`${prefix}-policy-status`} role={settingsError && policyDirty ? 'alert' : 'status'}>{settingsError && policyDirty ? settingsError : paused ? '任务暂停中，恢复后继续跟进。' : !modelReady ? '请联系管理员配置模型。' : !snapshot.online ? '连接并核验抖音账号后开始跟进。' : '保存后用于当前任务，人工接管的会话保持接管。'}</p><button className="button secondary" disabled={mutationBlocked || !policyReady || !policyDirty || Boolean(settingsError)} aria-describedby={`${prefix}-policy-status`}>{busy === 'chatSettings' ? <Loader2 size={14} className="spin" /> : <Check size={14} />}{busy === 'chatSettings' ? '正在保存' : '保存设置'}</button></div>
            </form>
      </ProspectingPanel>}
      {view === 'chat' && selectedId && !settingsOpen && <ProspectingPanel key={selectedId} title="会话详情" closeLabel="返回会话列表" onClose={returnToList} className="prospect-chat-panel">
          {conversation ? <div className="prospect-conversation-detail">
            <header className="prospect-conversation-header">
              <div className="prospect-conversation-identity">
                <ConversationAvatar nickname={conversation.nickname} />
                <div>
                  <h3>{conversation.nickname || '未提供昵称'}</h3>
                  <div className="prospect-conversation-meta">
                    <span className={`prospect-chat-badge${conversation.mode === 'human' && conversation.status !== 'closed' ? ' is-human' : ''}`}>
                      {conversation.mode === 'human' ? <UserRound size={13} /> : <Bot size={13} />}{conversationModeLabel(conversation)}
                    </span>
                    {profile && <a href={profile} target="_blank" rel="noopener noreferrer">抖音主页<ExternalLink size={12} /></a>}
                  </div>
                </div>
              </div>
              <div className="prospect-conversation-actions">
                {syncAvailable && <button className="button ghost" disabled={mutationBlocked || syncPending}
                  onClick={() => void execute('chatSync', { conversationId: conversation.id })}>
                  {syncPending ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}立即同步
                </button>}
                {!readOnlyConversation && <button className="button secondary" disabled={mutationBlocked || conversation.status === 'closed'} onClick={() => changeMode(conversation)}>
                  {busy === 'chatTakeover' || busy === 'chatResume' ? <Loader2 size={15} className="spin" /> : conversation.mode === 'human' ? <Bot size={15} /> : <UserRound size={15} />}
                  {conversation.mode === 'human' ? '交还 AI 助手' : '人工接管'}
                </button>}
              </div>
              <div className={`prospect-chat-sync-status${syncIssue || syncStalled ? ' needs-attention' : ''}`} role="status">
                <span>{hasSynced ? <>上次同步 <time dateTime={conversation.lastSyncedAt}>{dateLabel(conversation.lastSyncedAt)}</time></> : '尚未完成可靠同步'}</span>
                {syncLabel && <span>{syncLabel}</span>}
              </div>
            </header>
            <div className="prospect-chat-tools">
              <ProspectingMemory memory={conversation.taskMemory} conversationId={conversation.id} tasks={snapshot?.memoryTasks || []}
                editable={Boolean(campaignId && conversation.campaignId === campaignId && conversation.memoryEditable !== false && conversation.status !== 'closed')}
                busy={mutationBlocked || !active} resetKey={resetKey} onDirtyChange={setMemoryDirty} onInspectSource={markUserInput}
                onEdit={edit => execute('chatMemoryEdit', { conversationId: conversation.id, ...edit })}
                onSwitch={(targetCampaignId, bindingVersion) => execute('chatSwitchTask', { conversationId: conversation.id, targetCampaignId, version: conversation.version, bindingVersion }, () => onCampaignChange?.(targetCampaignId))} />
              <div className="prospect-chat-learning">
                <button className="button ghost" disabled={mutationBlocked || !conversation.campaignId}
                  onClick={() => void execute('chatLearn', { conversationId: conversation.id, campaignId: conversation.campaignId })}>
                  {busy === 'chatLearn' ? '正在提炼…' : '提炼话术 Skill / 重试'}
                </button>
                <details className="prospect-chat-learning-help">
                  <summary>提炼条件<ChevronDown size={13} /></summary>
                  <p>对话案例需至少两轮实质客户文本及两轮已确认回复；脱敏后提炼，审核通过才供本部门使用。</p>
                </details>
              </div>
            </div>
            {conversation.status === 'closed' ? <div className="prospect-chat-readonly" role="status"><CircleAlert size={16} /><p>会话已结束{conversation.closeReason ? `：${conversation.closeReason}` : '，消息记录保留。'}</p></div> : <>
              {readOnlyConversation && <div className="prospect-chat-readonly" role="status"><Users size={16} /><p>只读会话，接管与发送由原任务负责人操作。</p></div>}
              {conversation.mode === 'human' && <div className="prospect-chat-takeover" role="status"><UserRound size={16} /><div><strong>{humanModeLabel(conversation)}，AI 助手已停止回复此会话</strong><p>{handoffReason(conversation)}</p></div></div>}
            </>}
            <div className="prospect-chat-thread">
              <div className="prospect-chat-transcript" ref={containerRef} role="log" aria-label={`${conversation.nickname || '客户'}的聊天记录`} aria-live="polite" aria-relevant="additions text" onScroll={onScroll} onWheel={markUserInput} onTouchStart={markUserInput} onKeyDown={event => { if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(event.key)) markUserInput(); }} tabIndex={0}>
                {messages.length ? messages.map(message => {
                  if (isVerificationRecord(message)) return message.id === verificationRecords[0]?.id ? <VerificationRecords key={`${conversation.id}-verification-records`} messages={verificationRecords} onInspect={markUserInput} /> : null;
                  const waiting = message.status === 'waiting';
                  return <article key={message.id} id={prospectMessageId(message.id)} tabIndex={-1} className={`prospect-chat-message is-${message.direction} is-${message.actor}${waiting ? ' is-waiting' : ''}`}>
                    <header><span>{message.actor === 'customer' ? conversation.nickname || '客户' : actorLabels[message.actor]}</span><time dateTime={message.postedAt || message.createdAt}>{dateLabel(message.postedAt || message.createdAt)}</time></header>
                    <p>{message.text}</p>
                    <footer><span className={waiting ? 'prospect-chat-wait-label' : ['failed', 'unknown'].includes(message.status) ? 'needs-attention' : ''}>{waiting && <Clock3 size={12} />}{messageLabels[message.status]}</span>
                      {waiting ? message.retryExhausted ? <span>{readOnlyConversation ? '请联系原任务负责人检查助手并同步' : '检查助手后点击立即同步'}</span> : message.retryAt && Number.isFinite(Date.parse(message.retryAt)) && <span>最早重试 <time dateTime={message.retryAt}>{dateLabel(message.retryAt)}</time></span> : message.error && <span>{message.error}</span>}
                    </footer>
                    {!readOnlyConversation && message.id === latestOutbound?.id && message.status === 'failed' && <button type="button" className="button ghost" disabled={!canReply} onClick={() => void execute('chatReply', { conversationId: conversation.id, version: conversation.version, message: message.text })}><RefreshCw size={14} />重试发送</button>}
                  </article>;
                }) : <div className="prospect-chat-no-messages"><MessageCircle size={23} /><p>这段会话还没有同步的消息。保持助手运行，稍后刷新查看。</p></div>}
              </div>
              {showJump && <button className="button secondary prospect-chat-jump" onClick={jumpToLatest}><ArrowDown size={14} />查看最新消息</button>}
            </div>
            {!readOnlyConversation && <form className="prospect-chat-composer" onSubmit={sendReply}>
              <div className="prospect-chat-compose-box">
                <label htmlFor={`${prefix}-reply`}>{conversation.mode === 'human' ? '人工回复客户' : '接管后可手动回复'}</label>
                <textarea ref={replyInput} id={`${prefix}-reply`} value={draft} rows={2} maxLength={1000}
                  disabled={conversation.mode !== 'human' || mutationBlocked || conversation.status === 'closed'}
                  onChange={event => setDrafts(current => ({ ...current, [selectedId]: event.target.value }))}
                  onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); sendReply(); } }}
                  placeholder={conversation.mode === 'human' ? '输入你的回复，发送前核对客户与内容' : '点击右上角“人工接管”后，可在此回复客户'} />
                <div className="prospect-chat-composer-foot">
                  <p>{conversation.status === 'closed' ? '此会话已结束，消息记录保留。' : conversation.mode !== 'human' ? '接管后，AI 助手会停止回复此会话。' : paused ? '任务已暂停，恢复任务后可发送。' : !sendingAvailable ? '请先连接助手，并在助手中确认发信账号后再发送。' : '⌘ / Ctrl + Enter 发送 · 发送状态不代表对方已读'}
                    <span>{draft.length} / 1000</span>
                  </p>
                  <button className="button primary" disabled={!canReply || !draft.trim()}>
                    {busy === 'chatReply' ? <Loader2 size={15} className="spin" /> : <Send size={15} />}发送回复
                  </button>
                </div>
              </div>
            </form>}
          </div> : <div className="prospect-empty" role="status">{readError ? <p>暂时无法读取该会话。</p> : <><Loader2 size={22} className="spin" /><p>正在读取客户会话</p></>}</div>}
      </ProspectingPanel>}
      {view === 'pool' && selectedCapture && <ProspectingPanel title="留资详情" closeLabel="返回线索列表" onClose={returnToList} className="prospect-capture-panel">
        <section className="prospect-capture-detail">
          <header><ConversationAvatar nickname={selectedCapture.nickname} /><h3>{selectedCapture.nickname || '未提供昵称'}</h3></header>
          <dl>
            <div><dt>{contactLabels[selectedCapture.contactType]}</dt><dd>{selectedCapture.contactValue}</dd></div>
            <div><dt>负责销售</dt><dd>{selectedCapture.assignedName || (selectedCapture.status === 'assigned' ? '销售姓名待同步' : '暂无可分配销售，请联系管理员')}</dd></div>
            <div><dt>意向</dt><dd>{gradeLabels[selectedCapture.grade]} · 需求匹配 {selectedCapture.score} / 100</dd></div>
            <div><dt>更新时间</dt><dd><time dateTime={selectedCapture.updatedAt}>{dateLabel(selectedCapture.updatedAt)}</time></dd></div>
            <div><dt>分级原因</dt><dd>{selectedCapture.reason || '暂无分级说明'}</dd></div>
          </dl>
          <button className="button secondary" disabled={mutationBlocked} onClick={() => showCapturedConversation(selectedCapture.conversationId)}>查看会话</button>
        </section>
      </ProspectingPanel>}
    </div>}
  </section>;
}
