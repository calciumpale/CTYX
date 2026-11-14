'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, ChevronDown, Loader2, Sparkles, X } from 'lucide-react';
import { TalkTrackPicker } from './TalkLibraryView';
import type { TalkTrack } from '../lib/talktrack-types';
import { AGENTS, type AgentId } from '../lib/types';

export const money = (n: number) => `¥${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(n / 10000)}万`;
export const shortDate = (value: string) => new Date(value).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
export const modelDisplayName = (name: string) => name.replace(/ · 已配置，生成时验证$/, '');
export function BrandMark({ small = false }: { small?: boolean }) {
  return <svg className={small ? 'brand-mark small' : 'brand-mark'} viewBox="0 0 40 40" fill="none" aria-hidden="true">{Array.from({ length: 12 }, (_, i) => <path key={i} d="M20 3 L21.3 14.7 L20 18 L18.7 14.7 Z" fill="currentColor" transform={`rotate(${i * 30} 20 20)`} />)}<circle cx="20" cy="20" r="3.8" fill="currentColor" /></svg>;
}

export function Overlay({ children, title, onClose, className = '', wide = false, actions }: { children: ReactNode; title: string; onClose: () => void; className?: string; wide?: boolean; actions?: ReactNode }) {
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
  const close = <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={19} /></button>;
  return <dialog ref={ref} className={`overlay ${wide ? 'wide' : ''} ${className}`} aria-label={title} onClick={e => { if (e.target === e.currentTarget) onClose(); }}><div className="overlay-body"><div className="overlay-heading"><h2>{title}</h2>{actions ? <div className="overlay-heading-actions">{actions}{close}</div> : close}</div>{children}</div></dialog>;
}

export function DiscardChangesDialog({ title, onCancel, onDiscard }: {
  title: string;
  onCancel: () => void;
  onDiscard: () => void;
}) {
  return <Overlay className="confirmation-dialog" title={title} onClose={onCancel}>
    <p>未保存的更改将被丢弃。</p>
    <div className="contract-leave-actions">
      <button data-dialog-initial-focus="true" className="button secondary" onClick={onCancel}>继续编辑</button>
      <button className="button primary" onClick={onDiscard}>放弃并离开</button>
    </div>
  </Overlay>;
}

export function Composer({ onSend, placeholder = '输入问题或任务…', busy = false, compact = false, modelConnected = false, talkTracks = [], selectedTalkTrackIds, onTalkTrackChange }: { talkTracks?:TalkTrack[];selectedTalkTrackIds?:string[];onTalkTrackChange?:(ids:string[])=>void; onSend: (query: string, agentId?: AgentId, talkTrackIds?:string[]) => void; placeholder?: string; busy?: boolean; compact?: boolean; modelConnected?: boolean }) {
  const [text, setText] = useState('');
  const [agentId, setAgentId] = useState<AgentId | ''>('');
  const [localTalkIds,setLocalTalkIds]=useState<string[]>([]);
  const selectedIds=selectedTalkTrackIds??localTalkIds;
  const composing = useRef(false);
  const send = () => { if (text.trim() && !busy) { onSend(text.trim(), agentId || undefined, selectedIds); setText(''); } };
  const talkPicker = <TalkTrackPicker tracks={talkTracks} selectedIds={selectedIds} onChange={onTalkTrackChange??setLocalTalkIds} disabled={busy} compact={compact} />;
  return <div className={`composer ${compact ? 'compact' : ''}`}>
    <textarea aria-label="描述你的任务" value={text} onChange={e => setText(e.target.value)}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={e => {
        if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
      }} placeholder={placeholder} rows={compact ? 1 : 3} maxLength={6000} />
    {!compact && talkPicker}
    <div className="composer-bottom">
      <div className="composer-tools">
        <label className="agent-select"><Sparkles size={15} aria-hidden="true" />
          <select aria-label="AI 任务助手" value={agentId} onChange={e => setAgentId(e.target.value as AgentId | '')}>
            <option value="">自动选择</option>{AGENTS.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select><ChevronDown size={12} aria-hidden="true" />
        </label>
        {compact && talkPicker}
      </div>
      <div className="composer-right">
        <span className="composer-mode"><span className={`status-dot ${modelConnected ? 'connected' : ''}`} />{modelConnected ? '模型已连接' : '规则模式'}</span>
        <button aria-label="发送任务" className="send-button" onClick={send} disabled={!text.trim() || busy}>{busy ? <Loader2 size={19} className="spin" /> : <ArrowUp size={19} />}</button>
      </div>
    </div>
  </div>;
}
