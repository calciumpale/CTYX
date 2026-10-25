'use client';

import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ArrowDownToLine, AudioLines, Loader2, Upload, X } from 'lucide-react';
import type { FollowupRecording } from '../lib/types';
import { RecordingTranscript } from './RecordingTranscript';
import './followup-recordings.css';

const MAX_RECORDING_BYTES = 20 * 1024 * 1024;
const AUDIO_EXTENSIONS = /\.(mp3|wav|m4a|aac|flac|ogg|webm)$/i;

function fileSize(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.ceil(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function RecordingAudio({ file, src, name, preview = false, audioRef }: { file?: File; src?: string; name: string; preview?: boolean; audioRef?: RefObject<HTMLAudioElement | null> }) {
  const internalAudio = useRef<HTMLAudioElement>(null);
  const audio = audioRef ?? internalAudio;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const hintId = useId();

  useEffect(() => {
    const element = audio.current;
    const objectUrl = file ? URL.createObjectURL(file) : null;
    const audioUrl = objectUrl || src;
    if (element && audioUrl) { element.src = audioUrl; element.load(); }
    const pauseWhenHidden = () => { if (document.hidden) element?.pause(); };
    document.addEventListener('visibilitychange', pauseWhenHidden);
    return () => {
      document.removeEventListener('visibilitychange', pauseWhenHidden);
      element?.pause();
      element?.removeAttribute('src');
      element?.load();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file, src, audio]);

  return <div className="followup-audio">
    <audio ref={audio} controls preload={preview ? 'metadata' : 'none'} aria-label={`${preview ? '试听' : '播放'}录音：${name}`} aria-describedby={hintId}
      onLoadStart={() => { setLoading(true); setError(false); }}
      onLoadedMetadata={() => { setLoading(false); setError(false); }}
      onCanPlay={() => setLoading(false)}
      onSuspend={() => setLoading(false)}
      onWaiting={() => setLoading(true)}
      onPlaying={() => setLoading(false)}
      onError={() => { setLoading(false); setError(true); }} />
    <div id={hintId} className={`followup-audio-hint${error ? ' followup-recording-error' : ''}`} role={error ? 'alert' : undefined}>
      {error ? (preview ? '浏览器暂时无法试听此录音，可更换格式后重试；也可以继续保存原文件。' : '录音加载失败，或浏览器不支持此格式。可下载原录音播放。') : loading ? <><Loader2 size={12} className="spin" />正在加载录音…</> : preview ? '保存前可先试听，文件将在保存记录后上传。' : '点击播放，回听本次沟通。'}
    </div>
  </div>;
}

export function FollowupRecordingField({ file, onChange, disabled = false, children }: { file: File | null; onChange: (file: File | null) => void; disabled?: boolean; children: ReactNode }) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const id = useId();

  return <div className="followup-recording-field">
    <input ref={input} id={`${id}-input`} className="followup-recording-input" type="file" tabIndex={-1} accept=".mp3,.wav,.m4a,.aac,.flac,.ogg,.webm" aria-label="选择跟进录音文件" aria-describedby={`${id}-help`} disabled={disabled} onChange={event => {
      const chosen = event.currentTarget.files?.[0];
      event.currentTarget.value = '';
      if (!chosen || disabled) return;
      if (!AUDIO_EXTENSIONS.test(chosen.name)) { setError('请选择 MP3、WAV、M4A、AAC、FLAC、OGG 或 WebM 音频。'); return; }
      if (!chosen.size) { setError('录音文件为空，请重新选择。'); return; }
      if (chosen.size > MAX_RECORDING_BYTES) { setError('单个录音不能超过 20 MB，请压缩或分段后上传。'); return; }
      setError('');
      onChange(chosen);
    }} />
    <div className="followup-recording-actions">
      <button type="button" className="button secondary" onClick={() => input.current?.click()} disabled={disabled} aria-controls={`${id}-input`}><Upload size={15} />{file ? '替换录音' : '上传录音'}</button>
      {children}
    </div>
    <p className="followup-recording-help" id={`${id}-help`}>MP3 / WAV / M4A / AAC / FLAC / OGG / WebM · 单个不超过 20 MB</p>
    {error && <p className="followup-recording-error" role="alert">{error}</p>}
    {file && <section className="followup-recording-card" aria-label="待上传的跟进录音">
      <div className="followup-recording-file"><AudioLines size={19} /><div><strong title={file.name}>{file.name}</strong><span>{fileSize(file.size)} · 待保存</span></div><button type="button" className="icon-button" disabled={disabled} onClick={() => { if (!disabled) { onChange(null); setError(''); } }} aria-label="移除已选择的录音"><X size={16} /></button></div>
      <RecordingAudio file={file} name={file.name} preview />
    </section>}
  </div>;
}

export function FollowupRecordingPlayer({ dealId, recording }: { dealId: string; recording: FollowupRecording }) {
  const audio = useRef<HTMLAudioElement>(null);
  const src = `/api/deal-recordings?dealId=${encodeURIComponent(dealId)}&id=${encodeURIComponent(recording.id)}`;
  const seek = (seconds: number) => {
    const element = audio.current;
    if (!element) return;
    try { element.currentTime = Math.max(0, seconds); void element.play().catch(() => undefined); }
    catch { /* The native player displays unsupported-format and loading errors. */ }
  };
  return <section className="followup-recording-card followup-recording-saved" aria-label="已保存的跟进录音">
    <div className="followup-recording-file"><AudioLines size={17} /><div><strong title={recording.name}>{recording.name}</strong><span>{fileSize(recording.size)}</span></div><a className="followup-recording-download" href={src} download={recording.name} aria-label={`下载录音：${recording.name}`}><ArrowDownToLine size={14} /><span>下载</span></a></div>
    <RecordingAudio src={src} name={recording.name} audioRef={audio} />
    <RecordingTranscript dealId={dealId} recordingId={recording.id} onSeek={seek} />
  </section>;
}
