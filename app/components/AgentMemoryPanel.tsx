'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Brain, ChevronDown, Loader2 } from 'lucide-react';
import { Overlay } from './CoreViews';
import './agent-memory.css';

interface MemoryTopic {
  topic: string;
  title: string;
  body: string;
  sourceIds: string[];
  updatedAt: string;
  version: number;
}

interface MemorySnapshot {
  enabled: boolean;
  topics: MemoryTopic[];
  pending: number;
}

interface MemorySource {
  runId: string;
  query: string;
  createdAt: string;
}

type MemoryAction =
  | { action: 'setEnabled'; enabled: boolean }
  | { action: 'dream' }
  | { action: 'forgetTopic'; topic: string; version: number };

type ProjectScope = { id: string; label: string };

async function requestMemoryJson(query: string, signal: AbortSignal, body?: object): Promise<Record<string, unknown>> {
  const response = await fetch(`/api/agent-memory${query}`, {
    signal,
    credentials: 'same-origin',
    cache: 'no-store',
    ...(body ? {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    } : {}),
  });
  const payload: unknown = await response.json().catch(() => null);
  const data = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : null;
  if (!response.ok || !data) {
    throw new Error(typeof data?.error === 'string' && data.error.trim() ? data.error : '助手记忆暂时无法读取，请重试。');
  }
  return data;
}

async function requestMemory(projectId: string | undefined, signal: AbortSignal, action?: MemoryAction): Promise<MemorySnapshot> {
  const query = !action && projectId ? `?${new URLSearchParams({ projectId })}` : '';
  const body = action && { ...action, ...(action.action !== 'setEnabled' && projectId ? { projectId } : {}) };
  const { enabled, topics, pending } = await requestMemoryJson(query, signal, body);
  if (typeof enabled !== 'boolean' || !Array.isArray(topics) || typeof pending !== 'number' || !Number.isInteger(pending)) {
    throw new Error('助手记忆暂时无法读取，请重试。');
  }
  return { enabled, topics, pending };
}

const memoryDate = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Singapore' });
const failureMessage = (cause: unknown) => cause instanceof Error && !(cause instanceof TypeError) ? cause.message : '暂时无法连接助手记忆，请重试。';

function MemorySources({ topic, projectId }: { topic: string; projectId?: string }) {
  const id = useId();
  const [sources, setSources] = useState<MemorySource[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function load() {
    if (sources || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const query = new URLSearchParams({ topic, ...(projectId ? { projectId } : {}) });
      const { sources } = await requestMemoryJson(`?${query}`, controller.signal);
      if (!Array.isArray(sources)) throw new Error('暂时无法读取原始记录，请重试。');
      if (!controller.signal.aborted) setSources(sources);
    } catch (cause) {
      if (!controller.signal.aborted) setError(failureMessage(cause));
    } finally {
      if (!controller.signal.aborted) { request.current = null; setBusy(false); }
    }
  }

  return <div className="agent-memory-sources">
    <button type="button" className="button ghost" aria-expanded={expanded} aria-controls={id} onClick={() => { setExpanded(!expanded); if (!expanded) void load(); }}>
      {expanded ? '收起依据' : '查看依据'}
    </button>
    <div id={id} hidden={!expanded}>
      {busy && <p className="agent-memory-status" role="status"><Loader2 size={14} className="spin" aria-hidden="true" />正在读取依据</p>}
      {error && <div className="agent-memory-error" role="alert"><p>{error}</p><button type="button" className="button secondary" onClick={() => void load()}>重试</button></div>}
      {sources && (sources.length > 0 ? <ul>{sources.map(source => <li key={source.runId}>
        <p>{source.query}</p>
        {Number.isFinite(Date.parse(source.createdAt)) && <time dateTime={source.createdAt}>{memoryDate.format(new Date(source.createdAt))}</time>}
      </li>)}</ul> : <p className="agent-memory-empty">暂无可查看的原始记录</p>)}
    </div>
  </div>;
}

export function AgentMemoryButton({ project, disabled }: { project?: ProjectScope; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const label = project ? '查看项目记忆' : '查看个人记忆';
  return <>
    <button type="button" className="button ghost agent-memory-trigger" aria-label={label} title={label} aria-haspopup="dialog" disabled={disabled} onClick={() => setOpen(true)}>
      <Brain size={17} aria-hidden="true" /><span>记忆</span>
    </button>
    {open && <AgentMemoryPanel key={project?.id ?? 'personal'} project={project} onClose={() => setOpen(false)} />}
  </>;
}

export function AgentMemoryPanel({ project, onClose }: { project?: ProjectScope; onClose?: () => void }) {
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<MemoryAction['action'] | 'load' | null>('load');
  const [confirmTopic, setConfirmTopic] = useState<string | null>(null);
  const operation = useRef<AbortController | null>(null);
  const topicElements = useRef(new Map<string, HTMLDetailsElement>());
  const projectId = project?.id;

  useEffect(() => {
    const controller = new AbortController();
    operation.current = controller;
    void requestMemory(projectId, controller.signal).then(data => {
      if (!controller.signal.aborted) setSnapshot(data);
    }).catch(cause => {
      if (!controller.signal.aborted) setError(failureMessage(cause));
    }).finally(() => {
      if (!controller.signal.aborted) { operation.current = null; setBusy(null); }
    });
    return () => { operation.current?.abort(); controller.abort(); };
  }, [projectId]);

  async function perform(action?: MemoryAction) {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(action?.action ?? 'load');
    setError('');
    setNotice('');
    try {
      const data = await requestMemory(projectId, controller.signal, action);
      if (controller.signal.aborted) return;
      // The account switch returns the personal snapshot. Keep the open project scope.
      setSnapshot(current => projectId && action?.action === 'setEnabled' && current ? { ...current, enabled: data.enabled } : data);
      if (action?.action === 'dream') setNotice('整理完成');
      if (action?.action === 'forgetTopic') { setConfirmTopic(null); setNotice('已忘记此主题'); }
    } catch (cause) {
      if (!controller.signal.aborted) setError(failureMessage(cause));
    } finally {
      if (!controller.signal.aborted) { operation.current = null; setBusy(null); }
    }
  }

  const content = <section className="agent-memory-content" aria-label={onClose ? undefined : '项目记忆'} aria-busy={busy !== null}>
      {onClose && <div className="agent-memory-scope">
        <strong>{project?.label ?? '个人记忆'}</strong>
        <p>{project ? '此处显示当前项目内形成的记忆主题。' : '此处显示你的通用偏好与可复用经验。'}</p>
      </div>}
      {error && <div className="agent-memory-error" role="alert"><p>{error}</p><button type="button" className="button secondary" onClick={() => { setConfirmTopic(null); void perform(); }}>重新加载</button></div>}
      {!snapshot && busy === 'load' && <p className="agent-memory-status" role="status"><Loader2 size={16} className="spin" aria-hidden="true" />正在加载记忆</p>}
      {snapshot && <>
        <div className="agent-memory-setting">
          <div><strong>使用跨对话记忆</strong><p>对本账号的个人和项目对话生效。</p></div>
          <button type="button" role="switch" aria-label="使用跨对话记忆" aria-checked={snapshot.enabled} className="button secondary" disabled={busy !== null} onClick={() => void perform({ action: 'setEnabled', enabled: !snapshot.enabled })}>
            {snapshot.enabled ? '已启用' : '已暂停'}
          </button>
        </div>
        <div className="agent-memory-review">
          <p><strong>{snapshot.pending} 条记录待整理</strong><span>整理时会对照原始对话核对笔记，再更新记忆主题。</span></p>
          <button type="button" className="button secondary" disabled={!snapshot.enabled || busy !== null || snapshot.pending === 0} onClick={() => void perform({ action: 'dream' })}>
            {busy === 'dream' ? <><Loader2 size={15} className="spin" aria-hidden="true" />整理中</> : '立即整理'}
          </button>
        </div>
        {notice && <p className="agent-memory-status" role="status">{notice}</p>}
        <div className="agent-memory-topics">
          <h3>已核对的记忆</h3>
          {snapshot.topics.length === 0 ? <p className="agent-memory-empty">暂无已核对的记忆</p> : snapshot.topics.map(item => {
            const related = snapshot.topics.filter(other => other.topic !== item.topic && other.sourceIds.some(id => item.sourceIds.includes(id))).slice(0, 3);
            return <details className="agent-memory-topic" key={item.topic} ref={element => {
              if (element) topicElements.current.set(item.topic, element);
              else topicElements.current.delete(item.topic);
            }}>
              <summary><strong>{item.title}</strong><small>{item.sourceIds.length} 条原始记录</small><ChevronDown size={15} aria-hidden="true" /></summary>
              <div className="agent-memory-topic-body">
                <p>{item.body}</p>
                {related.length > 0 && <div className="agent-memory-related"><span>关联主题</span>{related.map(topic => <button type="button" className="button ghost" key={topic.topic} onClick={() => {
                  const detail = topicElements.current.get(topic.topic);
                  if (detail) { detail.open = true; detail.querySelector('summary')?.focus(); }
                }}>{topic.title}</button>)}</div>}
                <footer>
                  {Number.isFinite(Date.parse(item.updatedAt)) && <time dateTime={item.updatedAt}>更新于 {memoryDate.format(new Date(item.updatedAt))}</time>}
                  <button type="button" className="button ghost" disabled={busy !== null} aria-expanded={confirmTopic === item.topic} onClick={() => setConfirmTopic(item.topic)}>忘记此主题</button>
                </footer>
                {item.sourceIds.length > 0 && <MemorySources key={item.version} topic={item.topic} projectId={projectId} />}
                {confirmTopic === item.topic && <div className="agent-memory-confirm">
                  <p>忘记后，助手会停止使用「{item.title}」。</p>
                  <div><button type="button" className="button secondary" disabled={busy !== null} onClick={() => setConfirmTopic(null)}>取消</button><button type="button" className="button danger" disabled={busy !== null} onClick={() => void perform({ action: 'forgetTopic', topic: item.topic, version: item.version })}>确定忘记</button></div>
                </div>}
              </div>
            </details>;
          })}
        </div>
      </>}
    </section>;
  return onClose
    ? <Overlay title={project ? '项目记忆' : '助手记忆'} onClose={onClose} className="agent-memory-dialog">{content}</Overlay>
    : content;
}
