'use client';

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowUpRight, AudioLines, Check, FileAudio, Loader2 } from 'lucide-react';
import { readWorkbenchResponse } from '../lib/api';
import type { RecordingQuote } from '../lib/recording-quotes-types';
import type { SpeechTranscriptionJob } from '../lib/speech-types';
import type { ApiResult, Deal, WorkbenchState } from '../lib/types';
import { FollowupRecordingField, FollowupRecordingPlayer } from './FollowupRecordingField';
import { RecordingQuoteSquare } from './RecordingQuoteSquare';
import type { RecordingQuoteSelection } from './RecordingTranscript';
import './recording-upload-view.css';

type Props = {
  state: WorkbenchState;
  initialDealId?: string | null;
  uploadFollowup: (dealId: string, note: string, audio: File) => Promise<ApiResult>;
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

export function RecordingUploadView({ state, initialDealId, uploadFollowup, notify, onNavigateProject, onBusyChange, onDirtyChange }: Props) {
  const id = useId();
  const projects = state.deals.filter(deal => !deal.archive).sort((a, b) => projectLabel(a).localeCompare(projectLabel(b), 'zh-CN') || a.id.localeCompare(b.id));
  const [dealId, setDealId] = useState(() => projects.find(deal => deal.id === initialDealId)?.id ?? (projects.length === 1 ? projects[0].id : ''));
  const [recordingId, setRecordingId] = useState('');
  const [newRecordingId, setNewRecordingId] = useState('');
  const [sourcePosition, setSourcePosition] = useState<{ seconds: number } | null>(null);
  const [tab, setTab] = useState<Tab>('transcription');
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [savedMessage, setSavedMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [quotePending, setQuotePending] = useState<RecordingQuoteSelection | null>(null);
  const [quoteSaved, setQuoteSaved] = useState<Set<string>>(() => new Set());
  const [quoteFeedback, setQuoteFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [quoteRefresh, setQuoteRefresh] = useState(0);
  const alive = useRef(false);
  const uploading = useRef(false);
  const quoteRequest = useRef<AbortController | null>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const focusResult = useRef(false);
  const dirty = Boolean(file || note.trim());
  const deal = state.deals.find(item => item.id === dealId);
  const labels = new Map<string, number>();
  const ownerLabels = new Map<string, number>();
  for (const project of projects) {
    const label = projectLabel(project);
    const ownerLabel = [label, project.owner].filter(Boolean).join(' · ');
    labels.set(label, (labels.get(label) ?? 0) + 1);
    ownerLabels.set(ownerLabel, (ownerLabels.get(ownerLabel) ?? 0) + 1);
  }
  const recordings = (deal?.notes ?? []).flatMap(item => item.recording ? [{ ...item, recording: item.recording }] : [])
    .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0) || b.id.localeCompare(a.id));
  const selected = recordings.find(item => item.recording.id === recordingId) ?? recordings[0];
  const selectedRecordingId = selected?.recording.id;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      quoteRequest.current?.abort();
      onBusyChange?.(false);
      onDirtyChange?.(false);
    };
  }, [onBusyChange, onDirtyChange]);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty && !saving && !quotePending) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty, saving, quotePending]);
  useEffect(() => {
    if (tab !== 'transcription' || !selectedRecordingId || !focusResult.current) return;
    focusResult.current = false;
    resultHeading.current?.focus();
  }, [tab, selectedRecordingId, sourcePosition]);

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
    if (uploading.current || !deal || deal.archive || !file) return;
    const target = deal.id;
    const existing = new Set(deal.notes.map(item => item.id));
    uploading.current = true;
    setSaving(true);
    setError('');
    setSavedMessage('');
    onBusyChange?.(true);
    try {
      const result = await uploadFollowup(target, note.trim(), file);
      if (!alive.current) return;
      const added = result.state.deals.find(item => item.id === target)?.notes.filter(item => item.recording && !existing.has(item.id)) ?? [];
      const recording = result.recording ?? (added.length === 1 ? added[0].recording : undefined);
      setFile(null);
      setNote('');
      setSourcePosition(null);
      setRecordingId(recording?.id ?? '');
      setNewRecordingId(recording?.id ?? '');
      setSavedMessage(result.message || '录音及跟进记录已保存');
      if (recording) focusResult.current = true;
      else notify('录音已保存。请在项目的录音列表中选择要查看的文件。');
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : '录音未能保存，请稍后重试。');
    } finally {
      uploading.current = false;
      if (alive.current) { setSaving(false); onBusyChange?.(Boolean(quoteRequest.current)); }
    }
  }

  async function addQuote(job: SpeechTranscriptionJob, segmentIndex: number) {
    if (quoteRequest.current || job.status !== 'completed' || !job.result?.segments[segmentIndex]?.text.trim()) return;
    const abort = new AbortController();
    const selection = { jobId: job.id, segmentIndex };
    quoteRequest.current = abort;
    setQuotePending(selection);
    setQuoteFeedback(null);
    onBusyChange?.(true);
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
        if (alive.current) { setQuotePending(null); onBusyChange?.(uploading.current); }
      }
    }
  }

  function openQuoteSource(quote: RecordingQuote) {
    const project = state.deals.find(item => item.id === quote.dealId);
    if (!project?.notes.some(item => item.recording?.id === quote.recordingId)) {
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
    if (uploading.current || next === tab) return;
    if (next === 'quotes') setQuoteSaved(new Set());
    setTab(next);
  }

  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>) {
    const next = event.key === 'Home' ? tabs[0].id : event.key === 'End' ? tabs.at(-1)!.id
      : event.key === 'ArrowLeft' || event.key === 'ArrowRight' ? tabs.find(item => item.id !== tab)?.id : undefined;
    if (!next) return;
    event.preventDefault();
    changeTab(next);
    document.getElementById(`${id}-tab-${next}`)?.focus();
  }

  return <div className="recording-upload-view">
    <header className="recording-upload-header">
      <h1>上传录音</h1>
      <p>把沟通录音保存到项目，转成按讲话人分段的文字。</p>
    </header>
    <div className="recording-upload-tabs" role="tablist" aria-label="录音工作区">
      {tabs.map(item => <button key={item.id} type="button" role="tab" id={`${id}-tab-${item.id}`} aria-controls={`${id}-panel-${item.id}`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} disabled={saving && tab !== item.id} onClick={() => changeTab(item.id)} onKeyDown={navigateTabs}>{item.title}</button>)}
    </div>
    {quoteFeedback && <p className={`recording-upload-feedback${quoteFeedback.error ? ' is-error' : ''}`} role={quoteFeedback.error ? 'alert' : 'status'}>{quoteFeedback.text}</p>}
    <section role="tabpanel" id={`${id}-panel-transcription`} aria-labelledby={`${id}-tab-transcription`} hidden={tab !== 'transcription'}>
      {tab === 'transcription' && <div className="recording-upload-grid">
        <form className="recording-upload-panel recording-upload-form" aria-labelledby={`${id}-form-title`} aria-busy={saving} onSubmit={event => void save(event)}>
          <h2 id={`${id}-form-title`}><AudioLines size={18} aria-hidden="true" />项目录音</h2>
          <label className="recording-upload-field" htmlFor={`${id}-deal`}>
            <span>关联项目</span>
            <select id={`${id}-deal`} value={deal?.id ?? ''} onChange={event => chooseProject(event.target.value)} disabled={saving} required>
              <option value="">请选择项目</option>
              {deal?.archive && <option value={deal.id}>{projectLabel(deal)} · 已归档</option>}
              {projects.map(project => {
                const label = projectLabel(project);
                const ownerLabel = [label, project.owner].filter(Boolean).join(' · ');
                const display = (labels.get(label) ?? 0) <= 1 ? label : (ownerLabels.get(ownerLabel) ?? 0) <= 1 ? ownerLabel : `${ownerLabel} · ${project.id}`;
                return <option key={project.id} value={project.id}>{display}</option>;
              })}
            </select>
          </label>
          {projects.length === 0 && <p className="recording-upload-muted">当前没有可上传录音的项目。</p>}
          <label className="recording-upload-field" htmlFor={`${id}-note`}>
            <span>跟进备注 <small>选填</small></span>
            <textarea id={`${id}-note`} rows={3} maxLength={5000} disabled={saving} value={note} onChange={event => setNote(event.target.value)} placeholder="记录沟通背景或需要跟进的事项" />
          </label>
          <FollowupRecordingField file={file} onChange={next => { setFile(next); setError(''); }} disabled={saving || !deal || Boolean(deal.archive)}>
            <button type="submit" className="button primary" disabled={saving || !file || !deal || Boolean(deal.archive)}>
              {saving ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
              {saving ? '正在保存…' : '保存到项目'}
            </button>
          </FollowupRecordingField>
          {error && <p className="recording-upload-feedback is-error" role="alert">{error}</p>}
          {savedMessage && <p className="recording-upload-feedback" role="status">{savedMessage}</p>}
        </form>
        <section className="recording-upload-panel recording-upload-result" aria-labelledby={`${id}-result`}>
          <header><h2 id={`${id}-result`} tabIndex={-1} ref={resultHeading}><FileAudio size={18} aria-hidden="true" />{selected && newRecordingId === selected.recording.id ? '录音已保存' : '录音与转写'}</h2>
            {deal && onNavigateProject && <button type="button" className="button ghost" disabled={saving} onClick={() => onNavigateProject(deal.id)}>查看项目<ArrowUpRight size={14} aria-hidden="true" /></button>}
          </header>
          {recordings.length > 1 && <label className="recording-upload-field" htmlFor={`${id}-recording`}><span>项目录音</span><select id={`${id}-recording`} value={selectedRecordingId ?? ''} disabled={saving} onChange={event => { setRecordingId(event.target.value); setSourcePosition(null); }}>
            {recordings.map(item => <option key={item.recording.id} value={item.recording.id}>{item.recording.name} · {recordedAt(item.date)}</option>)}
          </select></label>}
          {selected && deal ? <FollowupRecordingPlayer key={`${deal.id}:${selected.recording.id}`} dealId={deal.id} recording={selected.recording}
            onQuote={(job, segmentIndex) => void addQuote(job, segmentIndex)} quotePending={quotePending} sourcePosition={sourcePosition}
            isQuoteSaved={(job, segmentIndex) => quoteSaved.has(quoteKey({ jobId: job.id, segmentIndex }))}
          /> : <div className="recording-upload-empty">{deal ? '此项目暂无录音。保存后可在这里查看转写。' : '选择项目后可查看已有录音和转写。'}</div>}
        </section>
      </div>}
    </section>
    <section role="tabpanel" id={`${id}-panel-quotes`} aria-labelledby={`${id}-tab-quotes`} hidden={tab !== 'quotes'}>
      {tab === 'quotes' && <RecordingQuoteSquare refreshKey={quoteRefresh} onOpenSource={openQuoteSource} />}
    </section>
  </div>;
}
