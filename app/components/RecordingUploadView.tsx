'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowUpRight, AudioLines, Check, FileAudio, Loader2 } from 'lucide-react';
import { readWorkbenchResponse } from '../lib/api';
import { RECORDING_INBOX_DEAL_ID, type RecordingInboxEntry, type RecordingInboxPage } from '../lib/recording-inbox-types';
import type { RecordingQuote } from '../lib/recording-quotes-types';
import type { SpeechTranscriptionJob } from '../lib/speech-types';
import type { ApiResult, Deal, Mutate, WorkbenchState } from '../lib/types';
import { FollowupRecordingField, FollowupRecordingPlayer } from './FollowupRecordingField';
import { RecordingProcessingReview } from './RecordingProcessingReview';
import { RecordingQuoteSquare } from './RecordingQuoteSquare';
import type { RecordingQuoteSelection } from './RecordingTranscript';
import './recording-upload-view.css';

type Props = {
  state: WorkbenchState;
  initialDealId?: string | null;
  mutate: Mutate;
  uploadFollowup: (dealId: string, note: string, audio: File, sourceOnly?: boolean) => Promise<ApiResult>;
  notify: (message: string) => void;
  onNavigateProject?: (id: string) => void;
  onBusyChange?: (busy: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
};

const tabs = [{ id: 'transcription', title: '录音转写' }, { id: 'quotes', title: '金句广场' }] as const;
type Tab = (typeof tabs)[number]['id'];

function projectLabel(deal: Deal) {
  return deal.projectName && deal.projectName !== deal.name ? `${deal.name} · ${deal.projectName}` : deal.name;
}

const quoteKey = ({ jobId, segmentIndex }: RecordingQuoteSelection) => `${jobId}:${segmentIndex}`;

const recordedAt = (date: string) => Number.isFinite(Date.parse(date))
  ? new Date(date).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' })
  : '时间未记录';

async function readInbox(signal: AbortSignal, query: { cursor?: string; id?: string } = {}) {
  const response = await fetch(`/api/deal-recordings?${new URLSearchParams({ inbox: '1', ...query })}`, {
    credentials: 'same-origin', cache: 'no-store', signal,
  });
  const data = await readWorkbenchResponse<RecordingInboxPage>(response, '暂时无法读取待归属录音。');
  if (!Array.isArray(data.recordings)) throw new Error('待归属录音列表返回不完整，请重试。');
  return data;
}

function mergeInbox(current: RecordingInboxEntry[], incoming: RecordingInboxEntry[]) {
  return [...new Map([...current, ...incoming].map(item => [item.recording.id, item])).values()]
    .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0) || b.recording.id.localeCompare(a.recording.id));
}

export function RecordingUploadView({ state, initialDealId, mutate, uploadFollowup, notify, onNavigateProject, onBusyChange, onDirtyChange }: Props) {
  const id = useId();
  const projects = state.deals.filter(deal => !deal.archive).sort((a, b) => projectLabel(a).localeCompare(projectLabel(b), 'zh-CN') || a.id.localeCompare(b.id));
  const [dealId, setDealId] = useState(() => state.deals.find(deal => deal.id === initialDealId)?.id ?? RECORDING_INBOX_DEAL_ID);
  const [recordingId, setRecordingId] = useState('');
  const [newRecordingId, setNewRecordingId] = useState('');
  const [sourcePosition, setSourcePosition] = useState<{ seconds: number } | null>(null);
  const [tab, setTab] = useState<Tab>('transcription');
  const [file, setFile] = useState<File | null>(null);
  const [reviewDirty, setReviewDirty] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [error, setError] = useState('');
  const [savedMessage, setSavedMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [quotePending, setQuotePending] = useState<RecordingQuoteSelection | null>(null);
  const [quoteSaved, setQuoteSaved] = useState<Set<string>>(() => new Set());
  const [quoteFeedback, setQuoteFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [quoteRefresh, setQuoteRefresh] = useState(0);
  const [inbox, setInbox] = useState<RecordingInboxEntry[]>([]);
  const [inboxCursor, setInboxCursor] = useState<string | null>(null);
  const [inboxStatus, setInboxStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [inboxError, setInboxError] = useState('');
  const [openingQuote, setOpeningQuote] = useState(false);
  const alive = useRef(false);
  const uploading = useRef(false);
  const quoteRequest = useRef<AbortController | null>(null);
  const inboxRequest = useRef<AbortController | null>(null);
  const quoteSourceRequest = useRef<AbortController | null>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const focusResult = useRef(false);
  const dirty = Boolean(file || reviewDirty);
  const busy = Boolean(saving || quotePending || reviewBusy || openingQuote);
  const deal = state.deals.find(item => item.id === dealId);
  const inInbox = dealId === RECORDING_INBOX_DEAL_ID || !deal;
  const canUpload = inInbox || Boolean(deal && !deal.archive);
  const labels = new Map<string, number>();
  const ownerLabels = new Map<string, number>();
  for (const project of projects) {
    const label = projectLabel(project);
    const ownerLabel = [label, project.owner].filter(Boolean).join(' · ');
    labels.set(label, (labels.get(label) ?? 0) + 1);
    ownerLabels.set(ownerLabel, (ownerLabels.get(ownerLabel) ?? 0) + 1);
  }
  const recordings = inInbox ? inbox : (deal?.notes ?? []).flatMap(item => item.recording ? [{ recording: item.recording, createdAt: item.date }] : [])
    .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0) || b.recording.id.localeCompare(a.recording.id));
  const selected = recordings.find(item => item.recording.id === recordingId) ?? recordings[0];
  const selectedRecordingId = selected?.recording.id;

  const loadInbox = useCallback(async (cursor?: string) => {
    if (inboxRequest.current) return;
    const controller = new AbortController();
    inboxRequest.current = controller;
    setInboxStatus('loading');
    setInboxError('');
    try {
      const data = await readInbox(controller.signal, cursor ? { cursor } : {});
      if (controller.signal.aborted) return;
      setInbox(current => mergeInbox(current, data.recordings));
      setInboxCursor(data.nextCursor === cursor ? null : data.nextCursor ?? null);
      setInboxStatus('ready');
    } catch (cause) {
      if (controller.signal.aborted) return;
      setInboxError(cause instanceof Error ? cause.message : '暂时无法读取待归属录音。');
      setInboxStatus('error');
    } finally {
      if (inboxRequest.current === controller) inboxRequest.current = null;
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      quoteRequest.current?.abort();
      inboxRequest.current?.abort();
      inboxRequest.current = null;
      quoteSourceRequest.current?.abort();
      quoteSourceRequest.current = null;
      onBusyChange?.(false);
      onDirtyChange?.(false);
    };
  }, [onBusyChange, onDirtyChange]);
  useEffect(() => {
    if (!inInbox || tab !== 'transcription' || inboxStatus !== 'idle') return;
    const timer = setTimeout(() => { void loadInbox(); }, 0);
    return () => clearTimeout(timer);
  }, [inInbox, tab, inboxStatus, loadInbox]);
  const onReviewDirty = useCallback((value: boolean) => setReviewDirty(value), []);
  const onReviewBusy = useCallback((value: boolean) => setReviewBusy(value), []);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty, busy]);
  useEffect(() => {
    if (tab !== 'transcription' || !selectedRecordingId || !focusResult.current) return;
    focusResult.current = false;
    resultHeading.current?.focus();
  }, [tab, selectedRecordingId, sourcePosition]);

  function canChangeReview() {
    return !busy && (!reviewDirty || window.confirm('有尚未写入的整理修改。要放弃这些修改吗？'));
  }

  function chooseProject(target: string) {
    setDealId(target);
    setRecordingId('');
    setNewRecordingId('');
    setSourcePosition(null);
    setSavedMessage('');
    setQuoteFeedback(null);
    setError('');
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (uploading.current || !canUpload || !file || !canChangeReview()) return;
    const target = deal?.id ?? RECORDING_INBOX_DEAL_ID;
    const existing = new Set(deal?.notes.map(item => item.id));
    uploading.current = true;
    setSaving(true);
    setError('');
    setSavedMessage('');
    try {
      const result = await uploadFollowup(target, '', file, true);
      if (!alive.current) return;
      const added = result.state.deals.find(item => item.id === target)?.notes.filter(item => item.recording && !existing.has(item.id)) ?? [];
      const recording = result.recording ?? (added.length === 1 ? added[0].recording : undefined);
      if (recording && inInbox) {
        setInbox(current => mergeInbox(current, [{ recording, createdAt: result.recordingCreatedAt ?? new Date().toISOString() }]));
      }
      setFile(null);
      setSourcePosition(null);
      setRecordingId(recording?.id ?? '');
      setNewRecordingId(recording?.id ?? '');
      setSavedMessage(result.message || '原录音已保存');
      if (recording) focusResult.current = true;
      else if (inInbox) { void loadInbox(); notify('录音已保存。请在待归属录音中选择要查看的文件。'); }
      else notify('录音已保存。请在项目的录音列表中选择要查看的文件。');
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : '录音未能保存，请稍后重试。');
    } finally {
      uploading.current = false;
      if (alive.current) setSaving(false);
    }
  }

  async function addQuote(job: SpeechTranscriptionJob, segmentIndex: number) {
    if (quoteRequest.current || job.status !== 'completed' || !job.result?.segments[segmentIndex]?.text.trim()) return;
    const abort = new AbortController();
    const selection = { jobId: job.id, segmentIndex };
    quoteRequest.current = abort;
    setQuotePending(selection);
    setQuoteFeedback(null);
    try {
      const response = await fetch('/api/recording-quotes', {
        method: 'POST', credentials: 'same-origin', signal: abort.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dealId: job.dealId, recordingId: job.recordingId, ...selection }),
      });
      await readWorkbenchResponse(response, '金句未能保存，请稍后重试。');
      if (!alive.current || abort.signal.aborted) return;
      setQuoteSaved(current => new Set(current).add(quoteKey(selection)));
      setQuoteRefresh(current => current + 1);
      setQuoteFeedback({ error: false, text: '已收藏到金句广场' });
    } catch (cause) {
      if (alive.current && !abort.signal.aborted) setQuoteFeedback({ error: true, text: cause instanceof Error ? cause.message : '金句未能保存，请稍后重试。' });
    } finally {
      if (quoteRequest.current === abort) {
        quoteRequest.current = null;
        if (alive.current) setQuotePending(null);
      }
    }
  }

  async function openQuoteSource(quote: RecordingQuote) {
    if (!canChangeReview()) return;
    if (quote.dealId === RECORDING_INBOX_DEAL_ID) {
      if (quoteSourceRequest.current) return;
      const controller = new AbortController();
      quoteSourceRequest.current = controller;
      setOpeningQuote(true);
      try {
        const data = await readInbox(controller.signal, { id: quote.recordingId });
        if (controller.signal.aborted) return;
        if (!data.recordings.some(item => item.recording.id === quote.recordingId)) throw new Error('原录音暂不可访问，请刷新工作台后再试。');
        setInbox(current => mergeInbox(current, data.recordings));
      } catch (cause) {
        if (!controller.signal.aborted) notify(cause instanceof Error ? cause.message : '原录音暂不可访问，请稍后再试。');
        return;
      } finally {
        if (quoteSourceRequest.current === controller) {
          quoteSourceRequest.current = null;
          setOpeningQuote(false);
        }
      }
    } else if (!state.deals.find(item => item.id === quote.dealId)?.notes.some(item => item.recording?.id === quote.recordingId)) {
      notify('原录音暂不可访问，请刷新工作台后再试。');
      return;
    }
    chooseProject(quote.dealId);
    setRecordingId(quote.recordingId);
    setSourcePosition({ seconds: quote.start });
    focusResult.current = true;
    setTab('transcription');
  }

  function changeTab(next: Tab) {
    if (next === tab || !canChangeReview()) return;
    if (next === 'quotes') setQuoteSaved(new Set());
    setTab(next);
  }

  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>) {
    const next = event.key === 'Home' ? tabs[0].id : event.key === 'End' ? tabs.at(-1)!.id
      : event.key === 'ArrowLeft' || event.key === 'ArrowRight' ? tabs.find(item => item.id !== tab)?.id : undefined;
    if (!next || busy) return;
    event.preventDefault();
    changeTab(next);
    document.getElementById(`${id}-tab-${next}`)?.focus();
  }

  return <div className="recording-upload-view">
    <header className="recording-upload-header">
      <h1>录音处理</h1>
      <p>上传后按讲话人转写并整理纪要。核对项目和内容后，再写入客户画像与跟进记录。</p>
    </header>
    <div className="recording-upload-tabs" role="tablist" aria-label="录音工作区">
      {tabs.map(item => <button key={item.id} type="button" role="tab" id={`${id}-tab-${item.id}`} aria-controls={`${id}-panel-${item.id}`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} disabled={busy && tab !== item.id} onClick={() => changeTab(item.id)} onKeyDown={navigateTabs}>{item.title}</button>)}
    </div>
    {quoteFeedback && <p className={`recording-upload-feedback${quoteFeedback.error ? ' is-error' : ''}`} role={quoteFeedback.error ? 'alert' : 'status'}>{quoteFeedback.text}</p>}
    <section role="tabpanel" id={`${id}-panel-transcription`} aria-labelledby={`${id}-tab-transcription`} hidden={tab !== 'transcription'}>
      {tab === 'transcription' && <div className="recording-upload-grid">
        <form className="recording-upload-panel recording-upload-form" aria-labelledby={`${id}-form-title`} aria-busy={saving} onSubmit={event => void save(event)}>
          <h2 id={`${id}-form-title`}><AudioLines size={18} aria-hidden="true" />上传录音</h2>
          <label className="recording-upload-field" htmlFor={`${id}-deal`}>
            <span>原录音项目 <small aria-hidden="true">选填</small></span>
            <select id={`${id}-deal`} value={inInbox ? RECORDING_INBOX_DEAL_ID : dealId} onChange={event => { if (canChangeReview()) chooseProject(event.target.value); }} disabled={busy} aria-describedby={`${id}-inbox-help`}>
              <option value={RECORDING_INBOX_DEAL_ID}>待归属录音</option>
              {deal?.archive && <option value={deal.id}>{projectLabel(deal)} · 已归档</option>}
              {projects.map(project => {
                const label = projectLabel(project);
                const ownerLabel = [label, project.owner].filter(Boolean).join(' · ');
                const display = (labels.get(label) ?? 0) <= 1 ? label : (ownerLabels.get(ownerLabel) ?? 0) <= 1 ? ownerLabel : `${ownerLabel} · ${project.id}`;
                return <option key={project.id} value={project.id}>{display}</option>;
              })}
            </select>
          </label>
          <p className="recording-upload-muted" id={`${id}-inbox-help`}>可先上传，转写并核对后再选写入项目。</p>
          <FollowupRecordingField file={file} onChange={next => { setFile(next); setError(''); }} disabled={busy || !canUpload}>
            <button type="submit" className="button primary" disabled={busy || !file || !canUpload}>
              {saving ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
              {saving ? '正在上传…' : '上传并转写'}
            </button>
          </FollowupRecordingField>
          {error && <p className="recording-upload-feedback is-error" role="alert">{error}</p>}
          {savedMessage && <p className="recording-upload-feedback" role="status">{savedMessage}</p>}
        </form>
        <section className="recording-upload-panel recording-upload-result" aria-labelledby={`${id}-result`}>
          <header><h2 id={`${id}-result`} tabIndex={-1} ref={resultHeading}><FileAudio size={18} aria-hidden="true" />{selected && newRecordingId === selected.recording.id ? '录音已保存' : '录音与转写'}</h2>
            {deal && onNavigateProject && <button type="button" className="button ghost" disabled={busy} onClick={() => onNavigateProject(deal.id)}>查看项目<ArrowUpRight size={14} aria-hidden="true" /></button>}
          </header>
          {recordings.length > 1 && <label className="recording-upload-field" htmlFor={`${id}-recording`}><span>{inInbox ? '待归属录音' : '项目录音'}</span><select id={`${id}-recording`} value={selectedRecordingId ?? ''} disabled={busy} onChange={event => { if (canChangeReview()) { setRecordingId(event.target.value); setSourcePosition(null); } }}>
            {recordings.map(item => <option key={item.recording.id} value={item.recording.id}>{item.recording.name} · {recordedAt(item.createdAt)}</option>)}
          </select></label>}
          {inInbox && inboxError && <p className="recording-upload-feedback is-error" role="alert">{inboxError}</p>}
          {inInbox && (inboxCursor || inboxError) && <button type="button" className="button ghost" disabled={inboxStatus === 'loading'} onClick={() => void loadInbox(inboxCursor ?? undefined)}>{inboxError ? '重新读取录音' : '加载更早的录音'}</button>}
          {selected ? <FollowupRecordingPlayer key={`${inInbox ? RECORDING_INBOX_DEAL_ID : dealId}:${selected.recording.id}`} dealId={inInbox ? RECORDING_INBOX_DEAL_ID : dealId} recording={selected.recording}
            onQuote={(job, segmentIndex) => void addQuote(job, segmentIndex)} quotePending={quotePending} sourcePosition={sourcePosition}
            isQuoteSaved={(job, segmentIndex) => quoteSaved.has(quoteKey({ jobId: job.id, segmentIndex }))}
            reviewLocked={reviewDirty || reviewBusy}
            renderCompleted={job => job.result?.text.trim() ? <RecordingProcessingReview key={`processing:${job.id}`} dealId={job.dealId} recordingId={job.recordingId} jobId={job.id}
              projects={projects} mutate={mutate} notify={notify} onBusyChange={onReviewBusy} onDirtyChange={onReviewDirty} /> : null}
          /> : <div className="recording-upload-empty">{inInbox ? inboxStatus === 'loading' || inboxStatus === 'idle' ? '正在读取待归属录音…' : inboxError ? '可重试读取或继续上传录音。' : '暂无待归属录音，上传后在这里查看转写。' : '此项目暂无录音。保存后可在这里查看转写。'}</div>}
        </section>
      </div>}
    </section>
    <section role="tabpanel" id={`${id}-panel-quotes`} aria-labelledby={`${id}-tab-quotes`} hidden={tab !== 'quotes'}>
      {tab === 'quotes' && <>{openingQuote && <p className="recording-upload-muted" role="status">正在打开原录音…</p>}<RecordingQuoteSquare refreshKey={quoteRefresh} onOpenSource={quote => void openQuoteSource(quote)} /></>}
    </section>
  </div>;
}
