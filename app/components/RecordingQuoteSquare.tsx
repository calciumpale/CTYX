'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { AudioLines, Copy, Loader2, Quote, RotateCcw, Search, Trash2 } from 'lucide-react';
import type { RecordingQuote } from '../lib/recording-quotes-types';
import { Overlay } from './CoreViews';
import { AudioWaveIllustration } from './VisualIllustrations';
import './recording-quote-square.css';

export type { RecordingQuote } from '../lib/recording-quotes-types';

const quotesApi = '/api/recording-quotes';
const dayFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' });
type QuotePage = { quotes: RecordingQuote[]; nextCursor?: string | null };

async function readQuotePage(signal: AbortSignal, cursor?: string): Promise<QuotePage> {
  const url = cursor ? `${quotesApi}?${new URLSearchParams({ cursor })}` : quotesApi;
  const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', signal });
  const data = await response.json().catch(() => null) as (QuotePage & { error?: string }) | null;
  if (!response.ok) throw new Error(data?.error || '暂时无法读取金句，请重试。');
  if (!Array.isArray(data?.quotes)) throw new Error('金句列表返回不完整，请重试。');
  return data;
}

function timeLabel(value: number) {
  const seconds = Math.max(0, Math.floor(value));
  const hours = Math.floor(seconds / 3600);
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const remainder = String(seconds % 60).padStart(2, '0');
  return hours ? `${hours}:${minutes}:${remainder}` : `${minutes}:${remainder}`;
}

export function RecordingQuoteSquare({ onOpenSource, refreshKey = 0 }: {
  onOpenSource: (quote: RecordingQuote) => void;
  refreshKey?: number;
}) {
  const headingId = useId();
  const searchInput = useRef<HTMLInputElement>(null);
  const pendingRemoval = useRef<AbortController | null>(null);
  const pendingPage = useRef<AbortController | null>(null);
  const [quotes, setQuotes] = useState<RecordingQuote[] | null>(null);
  const [query, setQuery] = useState('');
  const [retryKey, setRetryKey] = useState(0);
  const [readError, setReadError] = useState('');
  const [pagination, setPagination] = useState<{ token: string; cursor: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState<RecordingQuote | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState('');
  const listToken = `${refreshKey}:${retryKey}`;
  const nextCursor = pagination?.token === listToken ? pagination.cursor : null;

  useEffect(() => {
    const abort = new AbortController();
    async function read() {
      try {
        const page = await readQuotePage(abort.signal);
        if (!abort.signal.aborted) {
          setQuotes(page.quotes);
          setPagination({ token: listToken, cursor: page.nextCursor || null });
          setReadError('');
          setMoreError('');
          setLoadingMore(false);
        }
      } catch (cause) {
        if (!abort.signal.aborted) setReadError(cause instanceof Error ? cause.message : '暂时无法读取金句，请重试。');
      }
    }
    void read();
    return () => {
      abort.abort();
      pendingPage.current?.abort();
      pendingPage.current = null;
    };
  }, [listToken]);

  useEffect(() => () => pendingRemoval.current?.abort(), []);

  const term = query.trim().toLocaleLowerCase('zh-CN');
  const visible = quotes?.filter(item => [item.text, item.speaker, item.projectName, item.recordingName].some(value => value.toLocaleLowerCase('zh-CN').includes(term))) || [];

  async function loadMore() {
    if (!nextCursor || pendingPage.current) return;
    const abort = new AbortController();
    pendingPage.current = abort;
    setLoadingMore(true);
    setMoreError('');
    try {
      const page = await readQuotePage(abort.signal, nextCursor);
      if (abort.signal.aborted) return;
      setQuotes(current => [...new Map([...(current || []), ...page.quotes].map(item => [item.id, item])).values()]);
      setPagination({ token: listToken, cursor: page.nextCursor && page.nextCursor !== nextCursor ? page.nextCursor : null });
      if (!page.nextCursor || page.nextCursor === nextCursor) requestAnimationFrame(() => searchInput.current?.focus({ preventScroll: true }));
    } catch (cause) {
      if (!abort.signal.aborted) setMoreError(cause instanceof Error ? cause.message : '暂时无法读取更多金句，请重试。');
    } finally {
      if (!abort.signal.aborted) { pendingPage.current = null; setLoadingMore(false); }
    }
  }

  async function copy(quote: RecordingQuote) {
    try {
      await navigator.clipboard.writeText(quote.text);
      setNotice('金句已复制');
    } catch {
      setNotice('浏览器未允许复制，可选中文本手动复制。');
    }
  }

  async function remove(quote: RecordingQuote) {
    if (pendingRemoval.current) return;
    const abort = new AbortController();
    pendingRemoval.current = abort;
    setRemoving(true);
    setRemoveError('');
    try {
      const response = await fetch(`${quotesApi}?${new URLSearchParams({ id: quote.id })}`, {
        method: 'DELETE', credentials: 'same-origin', signal: abort.signal,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(data?.error || '金句暂时无法移除，请重试。');
      }
      if (abort.signal.aborted) return;
      setQuotes(current => current?.filter(item => item.id !== quote.id) || []);
      setConfirm(null);
      setNotice('金句已移除');
      setRetryKey(value => value + 1);
      requestAnimationFrame(() => searchInput.current?.focus({ preventScroll: true }));
    } catch (cause) {
      if (!abort.signal.aborted) setRemoveError(cause instanceof Error ? cause.message : '金句暂时无法移除，请重试。');
    } finally {
      if (!abort.signal.aborted) {
        pendingRemoval.current = null;
        setRemoving(false);
      }
    }
  }

  return <section className="recording-quote-square" aria-labelledby={headingId}>
    <header className="recording-quote-heading">
      <h2 id={headingId}>金句广场</h2>
      <label className="recording-quote-search">
        <Search size={16} aria-hidden="true" />
        <span className="sr-only">搜索金句</span>
        <input ref={searchInput} type="search" value={query} maxLength={200} onChange={event => setQuery(event.target.value)} placeholder="搜索金句、项目或讲话人" />
      </label>
    </header>
    <p className="sr-only" role="status">{notice}</p>
    {readError && <div className="recording-quote-error" role="alert"><p>{readError}</p><button type="button" className="button secondary" onClick={() => { setReadError(''); setRetryKey(value => value + 1); }}><RotateCcw size={14} aria-hidden="true" />重新加载</button></div>}
    {!quotes && !readError && <p className="recording-quote-empty" role="status"><Loader2 size={18} className="spin" aria-hidden="true" />正在读取金句</p>}
    {quotes && (quotes.length === 0 ? <div className="recording-quote-empty">
      <AudioWaveIllustration />
      <strong>暂无金句</strong>
      <p>可从录音转写原文一键收藏高转化沟通表达，供全团队复盘与学习。</p>
      <div className="recording-upload-pills" aria-hidden="true"><span>价格异议化解原话</span><span>客户核心痛点原声</span><span>关键决策推进表达</span></div>
    </div> : visible.length === 0 ? <p className="recording-quote-empty" role="status">没有匹配的金句</p> : <ul className="recording-quote-list" aria-label="已保存金句">
      {visible.map(quote => <li className="recording-quote-item" key={quote.id}>
        <blockquote>{quote.text}</blockquote>
        <div className="recording-quote-source">
          <span>{quote.projectName}</span><span>{quote.recordingName}</span><span>{quote.speaker}</span>
          <span className="recording-quote-timestamp">{timeLabel(quote.start)}–{timeLabel(quote.end)}</span>
          {Number.isFinite(Date.parse(quote.createdAt)) && <time dateTime={quote.createdAt}>{dayFormat.format(new Date(quote.createdAt))}</time>}
        </div>
        <div className="recording-quote-actions">
          <button type="button" className="button secondary" onClick={() => onOpenSource(quote)}><AudioLines size={15} aria-hidden="true" />打开录音</button>
          <button type="button" className="button ghost" onClick={() => void copy(quote)}><Copy size={14} aria-hidden="true" />复制金句</button>
          {quote.canDelete && <button type="button" className="button ghost" onClick={() => { setRemoveError(''); setConfirm(quote); }}><Trash2 size={14} aria-hidden="true" />移除金句</button>}
        </div>
      </li>)}
    </ul>)}
    {nextCursor && <footer className="recording-quote-pagination">
      {moreError && <p role="alert">{moreError}</p>}
      <button type="button" className="button secondary" aria-disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? <><Loader2 size={15} className="spin" aria-hidden="true" />正在加载</> : '加载更多'}</button>
    </footer>}
    {confirm && <Overlay title="移除金句" className="confirmation-dialog recording-quote-confirm" onClose={() => { if (!pendingRemoval.current) setConfirm(null); }}>
      <p>移除这条金句后，团队成员将无法从广场查看。原录音与转写会保留。</p>
      {removeError && <p className="recording-quote-confirm-error" role="alert">{removeError}</p>}
      <div className="contract-leave-actions">
        <button type="button" data-dialog-initial-focus="true" className="button secondary" disabled={removing} onClick={() => setConfirm(null)}>取消</button>
        <button type="button" className="button primary" disabled={removing} onClick={() => void remove(confirm)}>{removing ? <><Loader2 size={15} className="spin" aria-hidden="true" />正在移除</> : '确认移除'}</button>
      </div>
    </Overlay>}
  </section>;
}
