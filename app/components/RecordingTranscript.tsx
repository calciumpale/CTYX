'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, CircleAlert, FileAudio, Loader2, Play, RotateCcw } from 'lucide-react';
import type { SpeechResult, SpeechTranscriptionJob } from '../lib/speech-types';
import './speech-recognition.css';

function timeLabel(value: number) {
  const seconds = Math.max(0, Math.floor(value));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = String(seconds % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}` : `${minutes}:${remainder}`;
}

async function readJob(response: Response): Promise<SpeechTranscriptionJob | null> {
  const body = await response.json().catch(() => null) as { job?: SpeechTranscriptionJob | null; error?: string } | null;
  if (!response.ok) throw new Error(body?.error || (response.status === 401 ? '登录已过期，请重新登录。' : '录音转写暂时不可用，请稍后重试。'));
  if (!body || !('job' in body)) throw new Error('转写状态返回不完整，请重新加载。');
  return body.job ?? null;
}

function TranscriptContent({ result, onSeek }: { result: SpeechResult; onSeek?: (seconds: number) => void }) {
  const [visible, setVisible] = useState(12);
  const labels = new Map(result.speakers.map(speaker => [speaker.id, speaker.label]));
  const speakerLabel = (speaker: string) => labels.get(speaker) || (speaker === 'unknown' ? (result.diarization ? '重叠或未能区分的讲话人' : '未区分讲话人') : '未标记讲话人');
  return <div className="recording-transcript-content">
    <div className="recording-transcript-meta"><span>{timeLabel(result.durationSeconds)} 录音</span><span>{result.diarization ? `${result.speakers.length} 位讲话人` : '未区分讲话人'}</span><span>{result.text.length.toLocaleString('zh-CN')} 字</span></div>
    {result.segments.length ? <><ol className="recording-transcript-segments" aria-label="按讲话人分段的录音转写">{result.segments.slice(0, visible).map((segment, index) => <li key={`${segment.start}-${segment.end}-${index}`}>
      {onSeek ? <button type="button" className="recording-transcript-time" onClick={() => onSeek(segment.start)} aria-label={`从 ${timeLabel(segment.start)} 播放录音`} title="从此处回听"><Play size={11} fill="currentColor" />{timeLabel(segment.start)}</button> : <time className="recording-transcript-time">{timeLabel(segment.start)}</time>}
      <div><div className="recording-segment-heading"><strong>{speakerLabel(segment.speaker)}</strong><time>{timeLabel(segment.start)}–{timeLabel(segment.end)}</time></div><p>{segment.text}</p></div>
    </li>)}</ol>{visible < result.segments.length && <button type="button" className="speech-text-button recording-transcript-more" onClick={() => setVisible(current => current + 25)}><ChevronDown size={15} />继续展开转写 <span>已显示 {Math.min(visible, result.segments.length)} / {result.segments.length} 段</span></button>}</> : <p className="recording-transcript-plain">{result.text || '这段录音未识别出有效文字。'}</p>}
    <details className="recording-transcript-original"><summary>识别原文与纠偏记录<span>{result.corrections.length ? `${result.corrections.reduce((sum, item) => sum + item.count, 0)} 处纠偏` : '未触发纠偏'}</span><ChevronDown size={14} /></summary><div>
      {result.corrections.length > 0 && <ul className="recording-corrections" aria-label="热词纠偏记录">{result.corrections.map((item, index) => <li key={`${item.from}-${item.to}-${index}`}><del>{item.from}</del><span aria-hidden="true">→</span><strong>{item.to}</strong><small>{item.count} 处</small></li>)}</ul>}
      <h5>识别原文</h5><p className="recording-transcript-raw">{result.rawText || '未返回识别原文。'}</p><p className="recording-transcript-source">识别模型：{result.model} · 热词表版本 {result.hotwordVersion}。时间对应语音片段，讲话人编号不代表人员身份。</p>
    </div></details>
  </div>;
}

export function RecordingTranscript({ dealId, recordingId, onSeek }: { dealId: string; recordingId: string; onSeek?: (seconds: number) => void }) {
  const id = useId();
  const [job, setJob] = useState<SpeechTranscriptionJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const alive = useRef(false);
  const busy = useRef(false);
  const startRequest = useRef<AbortController | null>(null);
  const announced = useRef<string | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; startRequest.current?.abort(); busy.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    let checks = 0;
    const poll = () => {
      if (cancelled) return;
      if (document.hidden) timer = setTimeout(poll, 8000);
      else void load();
    };
    const load = async () => {
      request = new AbortController();
      try {
        const current = await readJob(await fetch(`/api/recording-transcriptions?dealId=${encodeURIComponent(dealId)}&id=${encodeURIComponent(recordingId)}`, { signal: request.signal, credentials: 'same-origin', cache: 'no-store' }));
        if (cancelled) return;
        setJob(current); setError(''); setLoading(false);
        if (current?.status === 'completed' && current.linked && announced.current !== current.id) {
          announced.current = current.id;
          window.dispatchEvent(new CustomEvent('speech-transcription-completed', { detail: { dealId, recordingId, jobId: current.id } }));
        }
        if (current && (current.status === 'queued' || current.status === 'running' || (current.status === 'completed' && !current.linked && checks < 20))) {
          checks += 1;
          timer = setTimeout(poll, current.status === 'completed' ? 8000 : 3500);
        }
      } catch (cause) {
        if (!cancelled && !request.signal.aborted) { setError(cause instanceof Error ? cause.message : '转写状态读取失败，请重试。'); setLoading(false); }
      }
    };
    void load();
    return () => { cancelled = true; request?.abort(); if (timer) clearTimeout(timer); };
  }, [dealId, recordingId, refresh]);

  async function start() {
    if (busy.current) return;
    busy.current = true; setStarting(true); setError('');
    const abort = new AbortController(); startRequest.current = abort;
    try {
      const current = await readJob(await fetch('/api/recording-transcriptions', { method: 'POST', signal: abort.signal, credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dealId, recordingId, action: job?.status === 'failed' || job?.status === 'completed' ? 'retry' : 'start' }) }));
      if (!alive.current || abort.signal.aborted) return;
      if (!current) throw new Error('转写任务未创建，请重试。');
      setJob(current); setRefresh(value => value + 1);
    } catch (cause) {
      if (alive.current && !abort.signal.aborted) setError(cause instanceof Error ? cause.message : '任务创建失败，原录音仍已保存，可稍后重试。');
    } finally {
      if (startRequest.current === abort) { busy.current = false; if (alive.current && !abort.signal.aborted) setStarting(false); }
    }
  }

  const active = job?.status === 'queued' || job?.status === 'running';
  const status = job?.status === 'completed' ? '已完成' : job?.status === 'failed' ? '未完成' : job?.status === 'running' ? '正在识别' : job?.status === 'queued' ? '等待识别' : '';
  return <div className="recording-transcript" aria-labelledby={`${id}-title`}>
    <header className="recording-transcript-heading"><h4 id={`${id}-title`}><FileAudio size={16} />录音转写</h4>{loading && !job ? <span className="recording-transcript-status"><Loader2 size={13} className="spin" />读取状态…</span> : status && <span className="recording-transcript-status" role="status">{active ? <Loader2 size={13} className="spin" /> : job?.status === 'completed' ? <Check size={13} /> : <CircleAlert size={13} />}{status}</span>}{!loading && !active && <button type="button" className="speech-button speech-button-secondary recording-transcript-start" disabled={starting} onClick={() => void start()}>{starting ? <Loader2 size={14} className="spin" /> : job ? <RotateCcw size={14} /> : <FileAudio size={14} />}{starting ? '正在提交…' : job?.status === 'completed' ? '按最新设置重转' : job?.status === 'failed' ? '重新转写' : '转写录音'}</button>}</header>
    {active && <div className="recording-transcript-progress" role="status"><progress max={100} value={Math.max(0, Math.min(100, job.progress))} aria-label="录音转写进度" /><p>{job.message || (job.status === 'queued' ? '录音已进入队列，识别结果将在这里更新。' : '正在识别录音，结果将在这里更新。')}</p><span>原录音已保存。后台继续识别，重新打开时同步到项目。</span></div>}
    {job?.status === 'failed' && <p className="recording-transcript-failed" role="alert">{job.message || '本次转写未完成，原录音仍保留，请重试。'}</p>}
    {job?.status === 'completed' && job.result && <><p className="recording-transcript-link">{job.linked ? '已关联项目' : job.message || '转写已完成，正在关联到项目。'}</p><TranscriptContent key={job.id} result={job.result} onSeek={onSeek} /></>}
    {job?.status === 'completed' && !job.result && <p className="recording-transcript-failed" role="alert">转写已完成，但结果暂未返回。请重新读取状态。</p>}
    {error && <div className="recording-transcript-error" role="alert"><CircleAlert size={15} /><div><p>{error}</p><button type="button" className="speech-text-button" disabled={starting || loading} onClick={() => { setError(''); setLoading(true); setRefresh(value => value + 1); }}><RotateCcw size={13} />重新读取状态</button></div></div>}
  </div>;
}
