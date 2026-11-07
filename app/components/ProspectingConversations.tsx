'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowLeft, ChevronDown, Bot, Check, CircleAlert, ExternalLink, Loader2, MessageCircle, RefreshCw, Search, Send, UserRound, Users, X } from 'lucide-react';
import type { ProspectChatConversation, ProspectChatGrade, ProspectChatMessage, ProspectChatPolicy, ProspectChatSnapshot } from '../lib/prospecting-chat-types';
import { defaultChatPolicy, withinChatHours } from '../lib/prospecting-chat-policy';
import { useChatScroll } from '../lib/use-chat-scroll';
import './prospecting-conversations.css';

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
  onViewChange: (view: ChatView) => void;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
};
type ChatResult = { message?: string; chat: ProspectChatSnapshot };
type PolicyDraft = Omit<ProspectChatPolicy, 'replyDailyLimit' | 'conversationReplyLimit'> & { replyDailyLimit: string; conversationReplyLimit: string };
const stageLabels = { understanding: '了解需求', qualifying: '确认条件', contact: '邀请留资', visit: '邀约到访', handoff: '人工对接', closed: '已结束' };
const needFields = [['area', '面积'], ['category', '业态'], ['budget', '预算'], ['location', '意向位置'], ['timing', '计划时间'], ['visit', '到访安排']] as const;
const draftFromPolicy = (policy: ProspectChatPolicy = defaultChatPolicy()): PolicyDraft => ({ ...policy, libraryIds: [...policy.libraryIds], replyDailyLimit: String(policy.replyDailyLimit), conversationReplyLimit: String(policy.conversationReplyLimit) });
const policySignature = (policy: PolicyDraft) => JSON.stringify({ ...policy, libraryIds: [...policy.libraryIds].sort() });
function policyError(policy: PolicyDraft) {
  if (!/^\d+$/.test(policy.replyDailyLimit) || Number(policy.replyDailyLimit) < 1 || Number(policy.replyDailyLimit) > 80) return '每日回复上限须为 1–80 条。';
  if (!/^\d+$/.test(policy.conversationReplyLimit) || Number(policy.conversationReplyLimit) < 1 || Number(policy.conversationReplyLimit) > 30) return '每个会话 24 小时内的回复上限须为 1–30 条。';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(policy.workStart) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(policy.workEnd) || policy.workStart >= policy.workEnd) return '请选择有效的工作时间，开始时间须早于结束时间。';
  if (policy.libraryIds.length > 20) return '最多选择 20 个知识库。';
  return '';
}
const gradeLabels: Record<ProspectChatGrade, string> = { high: '高意向', medium: '一般意向', low: '待培育' };
const messageLabels: Record<ProspectChatMessage['status'], string> = { received: '已同步', queued: '等待发送', sending: '正在发送', sent: '已提交', failed: '发送失败', unknown: '结果待核对', cancelled: '已取消' };
const actorLabels: Record<ProspectChatMessage['actor'], string> = { customer: '客户', agent: 'AI 获客助手', human: '人工回复' };
const contactLabels = { phone: '手机号', wechat: '微信', email: '邮箱' };
const humanModeLabel = (conversation: ProspectChatConversation) => conversation.handoffReason === '已由销售接管' ? '人工接管中' : '需人工处理';
const errorMessage = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请刷新后重试。';
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

function dateLabel(value?: string) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '时间待确认';
}
function profileLink(value: string) {
  try { const url = new URL(value); if (url.protocol === 'https:' && (url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com'))) return url.href; } catch { /* Only show verified Douyin URL shapes. */ }
}

export function ProspectingConversations({ campaignId, active, view, blocked, paused, modelReady, assistantOnline, sendingAvailable, resetKey, onViewChange, onDirtyChange, onBusyChange }: Props) {
  const prefix = useId();
  const [snapshot, setSnapshot] = useState<ProspectChatSnapshot | null>(null);
  const [observedAt, setObservedAt] = useState(0);
  const [scope, setScope] = useState<'campaign' | 'global'>(campaignId ? 'campaign' : 'global');
  const [selectedId, setSelectedId] = useState('');
  const [mobileDetail, setMobileDetail] = useState(false);
  const [query, setQuery] = useState('');
  const [poolQuery, setPoolQuery] = useState('');
  const [grade, setGrade] = useState<'all' | ProspectChatGrade>('all');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [policyDraft, setPolicyDraft] = useState<PolicyDraft>(() => draftFromPolicy());
  const [policyReady, setPolicyReady] = useState(false);
  const [policyDirty, setPolicyDirty] = useState(false);
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

  const applySnapshot = useCallback((next: ProspectChatSnapshot, campaignScope = false, savedSettings = false) => {
    if (!mounted.current) return;
    setSnapshot(next); setObservedAt(Date.now());
    if (campaignScope) {
      const nextPolicy = draftFromPolicy(next.policy);
      savedPolicy.current = policySignature(nextPolicy);
      setPolicyReady(true);
      if (savedSettings || !policyDirtyRef.current) {
        setPolicyDraft(nextPolicy); setPolicyDirty(false); policyDirtyRef.current = false;
      }
    }
    if (!next.conversations.some(item => item.id === selectedRef.current)) {
      const first = next.conversations[0]?.id || '';
      selectedRef.current = first; setSelectedId(first);
    }
  }, []);

  const refresh = useCallback(async (force = false) => {
    if (busyRef.current || readInFlight.current && !force) return;
    const generation = ++epoch.current; readInFlight.current = true;
    const selected = selectedRef.current;
    try {
      const globalScope = view === 'pool' || scope === 'global' || !campaignId;
      const params = new URLSearchParams({ mode: 'chat', ...(!globalScope && campaignId ? { campaignId } : {}), ...(selected ? { conversationId: selected } : {}) });
      const next = await request<ProspectChatSnapshot>(`/api/prospecting?${params}`);
      if (mounted.current && generation === epoch.current) { applySnapshot(next, !globalScope); if (globalScope) setScope('global'); setReadError(''); }
    } catch (cause) {
      if (mounted.current && generation === epoch.current && !aborted(cause)) setReadError(errorMessage(cause));
    } finally {
      if (generation === epoch.current) { readInFlight.current = false; if (mounted.current) setLoading(false); }
    }
  }, [applySnapshot, campaignId, request, scope, view]);

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
  useEffect(() => { onDirtyChange(policyDirty || Object.values(drafts).some(value => value.trim().length > 0)); }, [drafts, onDirtyChange, policyDirty]);
  useEffect(() => {
    if (previousResetKey.current === resetKey) return;
    previousResetKey.current = resetKey;
    const frame = requestAnimationFrame(() => {
      setDrafts({}); setPolicyDraft(JSON.parse(savedPolicy.current) as PolicyDraft); setPolicyDirty(false); policyDirtyRef.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [resetKey]);
  useEffect(() => () => { onDirtyChange(false); onBusyChange(false); }, [onBusyChange, onDirtyChange]);

  async function execute(action: string, extra: Record<string, unknown>, after?: () => void) {
    if (busyRef.current || blocked || !campaignId) return;
    busyRef.current = true; epoch.current++; readInFlight.current = false;
    setBusy(action); onBusyChange(true); setError(''); setNotice('');
    try {
      const result = await request<ChatResult>('/api/prospecting', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, campaignId, ...extra }) });
      if (!mounted.current) return;
      applySnapshot(result.chat, true, action === 'chatSettings' && Boolean(extra.policy)); setReadError(''); if (action !== 'chatSync') setNotice(result.message || '会话设置已保存。'); after?.();
    } catch (cause) {
      if (mounted.current && !aborted(cause)) setError(errorMessage(cause));
    } finally {
      busyRef.current = false;
      if (mounted.current) { setBusy(''); onBusyChange(false); void refresh(true); }
    }
  }

  function selectConversation(id: string) {
    if (busyRef.current) return;
    selectedRef.current = id; setSelectedId(id); setMobileDetail(true); setError(''); setNotice('');
  }
  const conversation = snapshot?.conversations.find(item => item.id === selectedId);
  const conversations = snapshot?.conversations.filter(item => `${item.nickname} ${item.lastMessagePreview}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) || [];
  const messages = (snapshot?.messages || []).filter(message => message.conversationId === selectedId);
  const latestOutbound = messages.findLast(message => message.direction === 'outbound');
  const transcriptKey = `${active && view === 'chat' ? selectedId : ''}:${messages.map(message => `${message.id}:${message.status}`).join('|')}`;
  const { containerRef, markUserInput, onScroll, showJump, jumpToLatest } = useChatScroll(transcriptKey);
  const previousConversation = useRef('');
  useEffect(() => {
    if (!active || view !== 'chat' || previousConversation.current === selectedId) return;
    previousConversation.current = selectedId;
    const frame = requestAnimationFrame(jumpToLatest);
    return () => cancelAnimationFrame(frame);
  }, [active, jumpToLatest, selectedId, view]);
  const draft = drafts[selectedId] || '';
  const mutationBlocked = blocked || Boolean(busy);
  const settingsError = policyError(policyDraft);
  const readOnlyConversation = Boolean(!campaignId || conversation?.campaignId !== campaignId);
  const syncAvailable = view === 'chat' && Boolean(conversation) && !readOnlyConversation;
  const syncStatus = syncAvailable ? selectedSync : undefined;
  const syncPending = busy === 'chatSync' || syncStatus?.status === 'queued' || syncStatus?.status === 'running';
  const syncLabel = syncPending && snapshot?.online === false ? '启动本机助手后将继续同步'
    : syncStatus?.status === 'running' ? '正在读取抖音私信' : syncPending ? '等待本机助手同步'
    : syncStatus?.status === 'done' ? `最近同步 ${dateLabel(syncStatus.updatedAt)}`
    : syncStatus ? syncStatus.error || '上次同步未完成，可以重试。' : '';
  const canReply = Boolean(!readOnlyConversation && conversation?.mode === 'human' && conversation.status === 'active' && sendingAvailable && !mutationBlocked && !paused);
  const pool = (snapshot?.pool || []).filter(item => (grade === 'all' || item.grade === grade) && `${item.nickname} ${item.contactValue} ${item.assignedName || ''}`.toLocaleLowerCase().includes(poolQuery.trim().toLocaleLowerCase()));
  const withinWorkHours = withinChatHours(observedAt, snapshot?.policy || defaultChatPolicy());
  const agentOnline = Boolean(snapshot?.enabled && snapshot.online && !paused && modelReady && withinWorkHours);
  const agentState = !snapshot?.enabled ? 'AI 助手未开启' : paused ? '任务已暂停' : !modelReady ? '等待模型就绪' : snapshot.online ? withinWorkHours ? 'AI 助手在线' : '等待回复时段' : assistantOnline ? '等待抖音账号确认' : '等待助手上线';
  const profile = conversation ? profileLink(conversation.profileUrl) : undefined;

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
  function savePolicy(event: FormEvent) {
    event.preventDefault();
    if (!policyReady || !snapshot || settingsError || mutationBlocked || scope !== 'campaign') return;
    void execute('chatSettings', { enabled: snapshot.enabled, policy: { ...policyDraft, replyDailyLimit: Number(policyDraft.replyDailyLimit), conversationReplyLimit: Number(policyDraft.conversationReplyLimit) } });
  }

  return <section className="prospect-chat-workspace" hidden={!active} aria-label={view === 'chat' ? '聊天获客' : '留资线索池'}>
    <div className="prospect-section-heading"><div><h2>{view === 'chat' ? '客户会话' : '留资线索池'}</h2>{syncLabel && <p role="status">{syncLabel}</p>}</div>
      {syncAvailable && conversation
        ? <button className="button secondary" disabled={mutationBlocked || syncPending} onClick={() => void execute('chatSync', { conversationId: conversation.id })}>{syncPending ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}立即同步</button>
        : <button className="button ghost" disabled={mutationBlocked} onClick={() => void refresh(true)}><RefreshCw size={15} />刷新</button>}
    </div>
    {(error || readError) && <div className="prospect-message is-error" role="alert"><CircleAlert size={17} /><div><p>{error || readError}</p>{error && readError && <p>{readError}</p>}<button className="button ghost" disabled={mutationBlocked} onClick={() => void refresh(true)}>重新读取会话</button></div></div>}
    {notice && <div className="prospect-message" role="status"><Check size={17} /><p>{notice}</p><button className="icon-button" aria-label="关闭会话提示" onClick={() => setNotice('')}><X size={14} /></button></div>}
    {loading && !snapshot ? <div className="prospect-empty" role="status"><Loader2 size={25} className="spin" /><h3>正在同步会话与线索</h3></div> : !snapshot ? <div className="prospect-empty"><h3>暂时无法读取会话</h3><p>请重新读取，已保存的消息和线索会在服务恢复后显示。</p></div> : <>
      {view === 'chat' && <>
        {scope === 'campaign' && campaignId ? <div className="prospect-chat-agent">
          <div className="prospect-chat-agent-toolbar"><div className="prospect-chat-agent-title"><Bot size={17} /><strong>AI 获客助手</strong><span className={`prospect-chat-badge${agentOnline ? ' is-online' : ''}`}>{agentState}</span></div><button className={`button ${snapshot.enabled ? 'secondary' : 'primary'}`} disabled={mutationBlocked || !policyReady || !snapshot.enabled && (!modelReady || paused)} onClick={() => void execute('chatSettings', { enabled: !snapshot.enabled })}>{busy === 'chatSettings' ? <Loader2 size={15} className="spin" /> : <Bot size={15} />}{snapshot.enabled ? '关闭 AI 跟进' : '开启 AI 跟进'}</button></div>
          <details className="prospect-chat-agent-settings"><summary>跟进设置{policyDirty && <span className="prospect-chat-unsaved">未保存</span>}<ChevronDown size={13} /></summary>
            <form className="prospect-chat-policy" onSubmit={savePolicy} aria-busy={busy === 'chatSettings'}>
              <fieldset disabled={mutationBlocked || !policyReady}>
                <legend className="prospect-sr-only">当前任务的 AI 跟进设置</legend>
                <div className="prospect-chat-policy-libraries"><span id={`${prefix}-libraries-label`} className="prospect-chat-policy-label">可用于对外回复的知识库</span><p id={`${prefix}-libraries-help`}>勾选后允许引用其中的文档；原有已发布资料仍可使用。</p>
                  <div className="prospect-chat-library-options" role="group" aria-labelledby={`${prefix}-libraries-label`} aria-describedby={`${prefix}-libraries-help`}>
                    {snapshot.libraries?.length ? snapshot.libraries.map(library => <label key={library.id}><input type="checkbox" checked={policyDraft.libraryIds.includes(library.id)} disabled={!policyDraft.libraryIds.includes(library.id) && policyDraft.libraryIds.length >= 20} onChange={event => updatePolicy({ libraryIds: event.target.checked ? [...policyDraft.libraryIds, library.id] : policyDraft.libraryIds.filter(id => id !== library.id) })} /><span>{library.name}</span></label>) : <span className="prospect-chat-policy-empty">暂无可选择的知识库</span>}
                  </div>
                </div>
                <div className="prospect-chat-policy-fields">
                  <div className="prospect-field"><label htmlFor={`${prefix}-daily-limit`}>每日回复上限</label><input id={`${prefix}-daily-limit`} type="number" min={1} max={80} step={1} inputMode="numeric" value={policyDraft.replyDailyLimit} onChange={event => updatePolicy({ replyDailyLimit: event.target.value })} required /><small>1–80 条，独立于招呼配额</small></div>
                  <div className="prospect-field"><label htmlFor={`${prefix}-conversation-limit`}>单会话回复上限</label><input id={`${prefix}-conversation-limit`} type="number" min={1} max={30} step={1} inputMode="numeric" value={policyDraft.conversationReplyLimit} onChange={event => updatePolicy({ conversationReplyLimit: event.target.value })} required /><small>每个会话 24 小时内 1–30 条</small></div>
                  <div className="prospect-field prospect-chat-policy-hours"><span id={`${prefix}-hours-label`} className="prospect-chat-policy-label">工作时间 · 北京时间</span><div role="group" aria-labelledby={`${prefix}-hours-label`}><label className="prospect-sr-only" htmlFor={`${prefix}-work-start`}>开始时间</label><input id={`${prefix}-work-start`} type="time" value={policyDraft.workStart} onChange={event => updatePolicy({ workStart: event.target.value })} required /><span aria-hidden="true">—</span><label className="prospect-sr-only" htmlFor={`${prefix}-work-end`}>结束时间</label><input id={`${prefix}-work-end`} type="time" value={policyDraft.workEnd} onChange={event => updatePolicy({ workEnd: event.target.value })} required /></div><small>仅在工作时间内自动回复</small></div>
                </div>
              </fieldset>
              <div className="prospect-chat-policy-footer"><p id={`${prefix}-policy-status`} role={settingsError && policyDirty ? 'alert' : 'status'}>{settingsError && policyDirty ? settingsError : paused ? '任务暂停中，恢复后继续跟进。' : !modelReady ? '请联系管理员配置模型。' : !snapshot.online ? '连接并核验抖音账号后开始跟进。' : '保存后用于当前任务，人工接管的会话保持接管。'}</p><button className="button secondary" disabled={mutationBlocked || !policyReady || !policyDirty || Boolean(settingsError)} aria-describedby={`${prefix}-policy-status`}>{busy === 'chatSettings' ? <Loader2 size={14} className="spin" /> : <Check size={14} />}{busy === 'chatSettings' ? '正在保存' : '保存设置'}</button></div>
            </form>
          </details>
        </div> : <div className="prospect-chat-scope"><div><strong>来自留资线索池的会话</strong><p>查看线索的原始沟通内容，接管与发送由原获客任务负责。</p></div>{campaignId && <button className="button secondary" disabled={mutationBlocked} onClick={() => { selectedRef.current = ''; setSelectedId(''); setScope('campaign'); setSnapshot(null); setLoading(true); setPolicyReady(false); setMobileDetail(false); }}>返回当前任务会话</button>}</div>}
        {!snapshot.conversations.length ? <div className="prospect-empty"><MessageCircle size={27} /><h3>还没有同步的客户会话</h3><p>{scope === 'global' ? '在线索池中点击“查看会话”，查看该客户的原始沟通记录。' : '先在“评论线索”中筛选客户并发送招呼，保持本机助手运行。相关会话同步后会出现在这里。'}</p></div> : <div className={`prospect-chat-layout${mobileDetail ? ' is-detail' : ''}`}>
          <aside className="prospect-conversation-list" aria-label="客户会话列表"><div className="prospect-conversation-search"><label htmlFor={`${prefix}-search`}><Search size={15} />查找会话</label><input id={`${prefix}-search`} value={query} onChange={event => setQuery(event.target.value)} placeholder="客户昵称或最近消息" /></div><div className="prospect-conversation-items">{conversations.length ? conversations.map(item => <button key={item.id} className={`prospect-conversation-item${item.id === selectedId ? ' is-selected' : ''}${item.mode === 'human' ? ' is-human' : ''}`} aria-pressed={item.id === selectedId} disabled={Boolean(busy)} onClick={() => selectConversation(item.id)}><span className="prospect-conversation-item-head"><strong>{item.nickname || '未提供昵称'}</strong><time dateTime={item.lastMessageAt}>{dateLabel(item.lastMessageAt)}</time></span><span className="prospect-conversation-preview">{item.lastMessagePreview || '暂无消息内容'}</span><span className="prospect-conversation-item-foot"><span className={`prospect-chat-badge${item.mode === 'human' ? ' is-human' : ''}`}>{item.status === 'closed' ? '已结束' : item.mode === 'human' ? humanModeLabel(item) : 'AI 跟进'}</span>{drafts[item.id]?.trim() && <span className="prospect-chat-draft-label">有草稿</span>}</span></button>) : <p className="prospect-chat-list-empty">没有匹配的会话，试试其他昵称或消息关键词。</p>}</div></aside>
          {conversation ? <div className={`prospect-conversation-detail${conversation.mode === 'human' ? ' is-human' : ''}`}>
            <header className="prospect-conversation-header"><button className="button ghost prospect-chat-back" onClick={() => setMobileDetail(false)}><ArrowLeft size={15} />会话列表</button><div><h3>{conversation.nickname || '未提供昵称'}</h3><div className="prospect-conversation-meta"><span className={`prospect-chat-badge${conversation.mode === 'human' ? ' is-human' : ''}`}>{conversation.mode === 'human' ? <UserRound size={13} /> : <Bot size={13} />}{conversation.status === 'closed' ? '已结束' : conversation.mode === 'human' ? humanModeLabel(conversation) : 'AI 跟进'}</span>{profile && <a href={profile} target="_blank" rel="noopener noreferrer">抖音主页<ExternalLink size={12} /></a>}</div></div>{!readOnlyConversation && <button className="button secondary" disabled={mutationBlocked || conversation.status === 'closed'} onClick={() => changeMode(conversation)}>{busy === 'chatTakeover' || busy === 'chatResume' ? <Loader2 size={15} className="spin" /> : conversation.mode === 'human' ? <Bot size={15} /> : <UserRound size={15} />}{conversation.mode === 'human' ? '交还 AI 助手' : '人工接管'}</button>}</header>
            <details className="prospect-chat-needs" key={`${conversation.id}-needs`}><summary><strong>客户需求</strong><span>{conversation.memory ? stageLabels[conversation.memory.stage] : '待了解'}</span><span>{conversation.memory?.contactCaptured ? '已留资' : '未留资'}</span><ChevronDown size={13} /></summary><div className="prospect-chat-needs-body"><dl>{needFields.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{conversation.memory?.needs[key] || '未确认'}</dd></div>)}</dl>{conversation.memory?.summary && <p>{conversation.memory.summary}</p>}<p className="prospect-chat-contact-history">留资询问 {conversation.memory?.contactAsks || 0} 次 · 拒绝 {conversation.memory?.contactDeclines || 0} 次</p></div></details>
            {conversation.status === 'closed' ? <div className="prospect-chat-readonly" role="status"><CircleAlert size={16} /><p>会话已结束{conversation.closeReason ? `：${conversation.closeReason}` : '，消息记录保留。'}</p></div> : readOnlyConversation ? <div className="prospect-chat-readonly" role="status"><Users size={16} /><p>只读会话，接管与发送由原任务负责人操作。</p></div> : conversation.mode === 'human' && <div className="prospect-chat-takeover" role="status"><UserRound size={16} /><div><strong>{humanModeLabel(conversation)}，AI 助手已停止回复此会话</strong><p>{conversation.handoffReason || '完成后可交还 AI 助手继续跟进。'}</p></div></div>}
            <div className="prospect-chat-transcript" ref={containerRef} role="log" aria-label={`${conversation.nickname || '客户'}的聊天记录`} aria-live="polite" aria-relevant="additions text" onScroll={onScroll} onWheel={markUserInput} onTouchStart={markUserInput} onKeyDown={event => { if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(event.key)) markUserInput(); }} tabIndex={0}>
              {messages.length ? messages.map(message => <article key={message.id} className={`prospect-chat-message is-${message.direction} is-${message.actor}`}><header><span>{message.actor === 'customer' ? conversation.nickname || '客户' : actorLabels[message.actor]}</span><time dateTime={message.postedAt || message.createdAt}>{dateLabel(message.postedAt || message.createdAt)}</time></header><p>{message.text}</p><footer><span className={['failed', 'unknown'].includes(message.status) ? 'needs-attention' : ''}>{messageLabels[message.status]}</span>{message.error && <span>{message.error}</span>}</footer>{!readOnlyConversation && message.id === latestOutbound?.id && message.status === 'failed' && <button type="button" className="button ghost" disabled={!canReply} onClick={() => void execute('chatReply', { conversationId: conversation.id, version: conversation.version, message: message.text })}><RefreshCw size={14} />重试发送</button>}</article>) : <div className="prospect-chat-no-messages"><MessageCircle size={23} /><p>这段会话还没有同步的消息。保持助手运行，稍后刷新查看。</p></div>}
            </div>
            {showJump && <button className="button secondary prospect-chat-jump" onClick={jumpToLatest}><ArrowDown size={14} />查看最新消息</button>}
            {!readOnlyConversation && <form className="prospect-chat-composer" onSubmit={sendReply}><label htmlFor={`${prefix}-reply`}>{conversation.mode === 'human' ? '人工回复客户' : '接管后可手动回复'}</label><textarea ref={replyInput} id={`${prefix}-reply`} value={draft} rows={3} maxLength={1000} disabled={conversation.mode !== 'human' || mutationBlocked || conversation.status === 'closed'} onChange={event => setDrafts(current => ({ ...current, [selectedId]: event.target.value }))} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); sendReply(); } }} placeholder={conversation.mode === 'human' ? '输入你的回复，发送前核对客户与内容' : '点击右上角“人工接管”后，可在此回复客户'} /><div className="prospect-chat-composer-foot"><p>{conversation.status === 'closed' ? '此会话已结束，消息记录保留。' : conversation.mode !== 'human' ? '接管后，AI 助手会停止回复此会话。' : paused ? '任务已暂停，恢复任务后可发送。' : !sendingAvailable ? '请先连接助手，并在助手中确认发信账号后再发送。' : '⌘ / Ctrl + Enter 发送 · 发送状态不代表对方已读'}<span>{draft.length} / 1000</span></p><button className="button primary" disabled={!canReply || !draft.trim()}>{busy === 'chatReply' ? <Loader2 size={15} className="spin" /> : <Send size={15} />}发送回复</button></div></form>}
          </div> : <div className="prospect-empty"><MessageCircle size={26} /><h3>选择一个客户会话</h3><p>从列表中选择客户，查看消息并决定是否接管。</p></div>}
        </div>}
      </>}
      {view === 'pool' && <>
        <div className="prospect-pool-toolbar"><div className="prospect-field"><label htmlFor={`${prefix}-pool-search`}>查找留资线索</label><input id={`${prefix}-pool-search`} value={poolQuery} onChange={event => setPoolQuery(event.target.value)} placeholder="客户、联系方式或销售姓名" /></div><div className="prospect-field"><label htmlFor={`${prefix}-grade`}>意向等级</label><select id={`${prefix}-grade`} value={grade} onChange={event => setGrade(event.target.value as typeof grade)}><option value="all">全部等级</option><option value="high">高意向</option><option value="medium">一般意向</option><option value="low">待培育</option></select></div><span>可查看 {snapshot.pool.length} 条</span></div>
        {pool.length ? <div className="prospect-pool-table-wrap"><table className="prospect-pool-table"><caption className="prospect-sr-only">留资客户与销售分配</caption><thead><tr><th scope="col">客户与联系方式</th><th scope="col">意向分级</th><th scope="col">负责销售</th><th scope="col">留资详情</th></tr></thead><tbody>{pool.map(item => <tr key={item.id}><td data-label="客户与联系方式"><strong>{item.nickname || '未提供昵称'}</strong><span>{contactLabels[item.contactType]} · {item.contactValue}</span><time dateTime={item.updatedAt}>{dateLabel(item.updatedAt)}</time></td><td data-label="意向分级"><span className={`prospect-chat-badge is-grade-${item.grade}`}>{gradeLabels[item.grade]}</span><span className="prospect-pool-score">需求匹配 {item.score} / 100</span></td><td data-label="负责销售"><strong>{item.assignedName || (item.status === 'assigned' ? '销售姓名待同步' : '待分配')}</strong><span>{item.status === 'assigned' ? '已自动分配' : '暂无可分配销售，请联系管理员'}</span></td><td data-label="留资详情"><p>{item.reason || '暂无分级说明'}</p><button className="button ghost" disabled={mutationBlocked} onClick={() => { selectConversation(item.conversationId); onViewChange('chat'); }}>查看会话<ExternalLink size={13} /></button></td></tr>)}</tbody></table></div> : <div className="prospect-empty"><Users size={27} /><h3>{snapshot.pool.length ? '没有匹配的留资线索' : '暂无可查看的留资线索'}</h3><p>{snapshot.pool.length ? '调整意向等级或搜索关键词，查看其他留资线索。' : '销售查看分配给自己的线索，管理者查看团队线索。'}</p>{snapshot.pool.length ? <button className="button secondary" onClick={() => { setGrade('all'); setPoolQuery(''); }}>查看全部留资</button> : campaignId ? <button className="button secondary" onClick={() => { setScope('campaign'); selectedRef.current = ''; setSelectedId(''); onViewChange('chat'); }}>进入当前任务聊天</button> : null}</div>}
      </>}
    </>}
  </section>;
}
