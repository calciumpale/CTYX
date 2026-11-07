'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Building2, Loader2, Mic, MicOff, Plus, Square, X } from 'lucide-react';
import { createIntakeSubmissionController, MAX_INTAKE_TEXT } from '../lib/project-intake';
import type { IntakeInputMode, IntakeResponse } from '../lib/project-intake-types';
import type { ApiResult, Mutate, View, WorkbenchState } from '../lib/types';
import { useTrainingVoice } from '../lib/use-training-voice';
import './project-intake.css';

export interface ProjectIntakeProps {
  state?: Pick<WorkbenchState, 'model'>;
  mutate: Mutate;
  notify: (message: string) => void;
  onCreated?: (dealId: string) => void;
  onNavigate?: (view: View, id?: string) => void;
  onBusyChange?: (busy: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

export function ProjectIntake({ state, mutate, notify, onCreated, onBusyChange, onDirtyChange }: ProjectIntakeProps) {
  const id = useId();
  const [text, setText] = useState('');
  const [clarification, setClarification] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [response, setResponse] = useState<IntakeResponse | null>(null);
  const [composing, setComposing] = useState(false);
  const busyRef = useRef(false);
  const composingRef = useRef(false);
  const mutateRef = useRef(mutate);
  useEffect(() => { mutateRef.current = mutate; }, [mutate]);
  const submissionRef = useRef<ReturnType<typeof createIntakeSubmissionController> | null>(null);
  useEffect(() => { submissionRef.current = createIntakeSubmissionController({ mutate: (action, payload) => mutateRef.current(action, payload) }); }, []);
  const lastSubmission = useRef<{ text: string; inputMode: IntakeInputMode } | null>(null);
  const speech = useRef<{ active: boolean; base: string; original: string; target: 'text' | 'clarification'; finals: string[] }>({ active: false, base: '', original: '', target: 'text', finals: [] });
  const [speechVersion, setSpeechVersion] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const clarificationRef = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(true);
  const modelConnected = state?.model.connected !== false;
  const voice = useTrainingVoice({ onTranscript: value => {
    if (!speech.current.active || busyRef.current || !value.trim()) return;
    speech.current.finals.push(value.trim());
    const next = [speech.current.base, speech.current.finals.join('')].filter(Boolean).join('\n');
    if (speech.current.target === 'clarification') setClarification(next); else setText(next);
    setSpeechVersion(current => current + 1);
  } });
  const { phase: voicePhase, error: voiceError, interimTranscript, stopListening } = voice;
  const listening = ['requesting', 'listening', 'stopping'].includes(voicePhase);
  const dirty = Boolean(text.trim() || clarification.trim());

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onBusyChange?.(busy || listening); }, [busy, listening, onBusyChange]);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => { onBusyChange?.(false); onDirtyChange?.(false); }, [onBusyChange, onDirtyChange]);

  function clearDraft() {
    setText(''); setClarification(''); setResponse(null); setError('');
    lastSubmission.current = null;
    submissionRef.current?.reset();
    onDirtyChange?.(false);
  }
  function acceptResult(result: ApiResult, submitted: string) {
    if (result.intake) {
      setResponse(result.intake);
      setText(submitted); setClarification('');
      if (result.intake.status === 'needs_info') requestAnimationFrame(() => clarificationRef.current?.focus());
      return;
    }
    if (!result.dealId) throw new Error('尚未确认保存结果，原话已保留。请重试，系统会避免重复录入。');
    clearDraft();
    notify(result.message || '项目已建立，客户原话已保存。');
    onBusyChange?.(false);
    onCreated?.(result.dealId);
  }
  async function submitText(value: string, inputMode: IntakeInputMode, forceNew = false) {
    if (busyRef.current || composingRef.current) return;
    if (!value.trim()) { setError('请先输入或说出客户信息。'); return; }
    if (value.length > MAX_INTAKE_TEXT) { setError('客户信息最多6000字，请精简后再录入。'); return; }
    if (!modelConnected) { setError('请联系管理员配置大模型服务。当前原话已保留，也可通过页面上方的“新建项目”手动录入。'); return; }
    busyRef.current = true; setBusy(true); setError('');
    lastSubmission.current = { text: value, inputMode };
    // Preserve the complete submitted raw text even if the response never arrives.
    setText(value); setClarification('');
    try {
      const result = await submissionRef.current!.submit({ text: value, inputMode, forceNew });
      if (mounted.current && result) acceptResult(result, value);
    } catch (failure) {
      if (mounted.current) setError(`${failure instanceof Error ? failure.message : '录入未完成，请稍后重试。'} 原话已保留。`);
    } finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  const submitLatest = useRef(submitText);
  useEffect(() => { submitLatest.current = submitText; });

  // Final recognition results settle for a moment, then stop the recognizer and submit once.
  // Interim speech keeps the session open; no transcript confirmation or speech synthesis is used.
  useEffect(() => {
    if (!speech.current.active || !speech.current.finals.length || interimTranscript || voicePhase !== 'listening') return;
    const timer = window.setTimeout(() => stopListening(), 1100);
    return () => window.clearTimeout(timer);
  }, [speechVersion, interimTranscript, voicePhase, stopListening]);
  useEffect(() => {
    if (!speech.current.active || voicePhase !== 'idle') return;
    const capture = speech.current;
    speech.current.active = false;
    queueMicrotask(() => {
      if (!mounted.current) return;
      const spoken = capture.finals.join('');
      if (!spoken) {
        if (!voiceError) setError('没有识别到语音，请重新说一次，或直接输入客户信息。');
        return;
      }
      const entry = [capture.base, spoken].filter(Boolean).join('\n');
      const value = capture.target === 'clarification' ? `${capture.original}\n补充：${entry}` : entry;
      if (voiceError) { setError(`${voiceError} 已识别的原话已保留，可改用文字录入。`); return; }
      void submitLatest.current(value, 'speech');
    });
  }, [voicePhase, voiceError, speechVersion]);

  function startVoice() {
    if (busyRef.current || listening || !voice.ready) return;
    setError(''); voice.clearError();
    const target = response?.status === 'needs_info' ? 'clarification' : 'text';
    speech.current = { active: true, base: target === 'clarification' ? clarification : text, original: text, target, finals: [] };
    voice.startListening();
  }
  function cancelVoice() {
    speech.current.active = false;
    voice.cancelListening();
    setError('本次语音已结束，已识别的文字保留在输入框中。');
  }
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (composingRef.current || listening || busyRef.current) return;
    const value = response?.status === 'needs_info' && clarification.trim() ? `${text}\n补充：${clarification}` : text;
    void submitText(value, 'text');
  }
  async function saveFollowup(dealId: string) {
    if (busyRef.current || !lastSubmission.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try {
      const result = await submissionRef.current!.followup(dealId);
      if (!mounted.current || !result) return;
      if (!result.dealId) throw new Error('尚未确认跟进保存结果，请重试。');
      clearDraft(); notify(result.message || '客户原话已添加到项目跟进。'); onBusyChange?.(false); onCreated?.(result.dealId);
    } catch (failure) { if (mounted.current) setError(`${failure instanceof Error ? failure.message : '跟进保存失败，请重试。'} 原话已保留。`); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  const descriptionId = `${id}-description`;
  const statusMessage = busy ? '正在提取信息并保存项目，随后更新客户洞察和成交预测…' : listening ? voice.phase === 'requesting' ? '正在等待麦克风权限…' : voice.phase === 'stopping' ? '正在结束识别，完成后自动录入…' : '正在听，停顿后会自动录入。' : '';
  const showError = error || voice.error;
  const maxClarification = Math.max(0, MAX_INTAKE_TEXT - text.length - '\n补充：'.length);

  return <section className="project-intake" aria-labelledby={`${id}-title`} aria-busy={busy}>
    <div className="project-intake-heading"><div><h2 id={`${id}-title`}>快速录入</h2><p id={descriptionId}>输入或说出客户情况，自动建立项目。</p></div><Building2 size={22} aria-hidden="true" /></div>
    <form onSubmit={handleSubmit}>
      <label className="project-intake-label" htmlFor={`${id}-text`}>客户信息</label>
      <textarea ref={textareaRef} id={`${id}-text`} value={text} rows={3} maxLength={MAX_INTAKE_TEXT} disabled={busy || listening} aria-describedby={descriptionId} placeholder="企业名称、联系人、需求与下一步安排" onChange={event => { setText(event.target.value); setResponse(null); setClarification(''); setError(''); }} onCompositionStart={() => { composingRef.current = true; setComposing(true); }} onCompositionEnd={() => { composingRef.current = false; setComposing(false); }} />
      {response?.status === 'needs_info' && <div className="project-intake-clarification"><p role="status">{response.question || '请补充客户企业名称。'}</p><label htmlFor={`${id}-clarification`}>补充信息</label><textarea ref={clarificationRef} id={`${id}-clarification`} value={clarification} maxLength={maxClarification} rows={2} disabled={busy || listening} placeholder="补充企业名称或说明本次要录入的项目" onChange={event => setClarification(event.target.value)} onCompositionStart={() => { composingRef.current = true; setComposing(true); }} onCompositionEnd={() => { composingRef.current = false; setComposing(false); }} /></div>}
      <div className="project-intake-actions"><div className="project-intake-voice-actions">{listening ? <><button type="button" className="button secondary" onClick={() => voice.stopListening()} disabled={voice.phase === 'stopping'}><Square size={15} />结束并录入</button><button type="button" className="project-intake-cancel" onClick={cancelVoice}><X size={16} />取消语音</button></> : <button type="button" className="button secondary" onClick={startVoice} disabled={busy || !voice.ready || !voice.inputSupported}>{voice.ready && !voice.inputSupported ? <MicOff size={16} /> : <Mic size={16} />}语音录入</button>}{voice.ready && !voice.inputSupported && <span>当前浏览器请使用文字输入</span>}</div><div className="project-intake-submit"><span className="project-intake-count">{text.length + (clarification ? clarification.length + 4 : 0)} / {MAX_INTAKE_TEXT}</span><button type="submit" className="button primary" disabled={busy || listening || composing || !text.trim() || !modelConnected || (response?.status === 'needs_info' && !clarification.trim())}>{busy ? <Loader2 size={16} className="spin" /> : <ArrowRight size={16} />}{busy ? '录入中…' : response?.status === 'needs_info' ? '补充并继续录入' : '建立项目'}</button></div></div>
    </form>
    {statusMessage && <p className="project-intake-status" role="status">{listening && <span className="project-intake-listening-dot" />}{statusMessage}</p>}
    {voice.interimTranscript && <p className="project-intake-interim" aria-live="polite">{voice.interimTranscript}</p>}
    {!modelConnected && <div className="project-intake-connection"><p>自动录入需管理员配置模型。也可通过“新建项目”手动填写。</p></div>}
    {showError && <p className="project-intake-error" role="alert">{showError}</p>}
    {response?.status === 'duplicate' && <div className="project-intake-duplicates"><h3>已有相同客户的相似项目</h3><p>把这段原话补充为跟进，或为新的销售机会另建项目。</p><ul>{response.existing?.map(project => <li key={project.id}><div><strong>{project.projectName || project.name}</strong><span>{project.name}</span></div><button type="button" className="button secondary" disabled={busy} onClick={() => void saveFollowup(project.id)}>记录到此项目<ArrowRight size={15} /></button></li>)}</ul><button type="button" className="button ghost" disabled={busy} onClick={() => { const entry = lastSubmission.current; if (entry) void submitText(entry.text, entry.inputMode, true); }}><Plus size={16} />另建新项目</button></div>}
  </section>;
}
