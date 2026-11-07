'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { AudioLines, Check, CircleAlert, Loader2, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { SPEECH_DIALECTS, type SpeechDialect, type SpeechSettings } from '../lib/speech-types';
import './speech-recognition.css';

type HotwordDraft = { id: string; term: string; aliasesText: string; enabled: boolean };
type Draft = { dialect: SpeechDialect; diarization: boolean; speakerCount: number | null; hotwords: HotwordDraft[] };

export const DIALECT_LABELS: Record<SpeechDialect, string> = {
  auto: '自动识别', mandarin: '普通话', cantonese: '粤语', wu: '吴语', min: '闽语',
  hakka: '客家话', gan: '赣语', xiang: '湘语', jin: '晋语',
};

function toDraft(settings: SpeechSettings): Draft {
  return { dialect: settings.dialect, diarization: settings.diarization, speakerCount: settings.speakerCount,
    hotwords: settings.hotwords.map(item => ({ ...item, aliasesText: item.aliases.join('，') })) };
}

async function settingsResponse(response: Response): Promise<SpeechSettings> {
  const body = await response.json().catch(() => null) as (SpeechSettings & { error?: string }) | null;
  if (!response.ok) throw new Error(body?.error || (response.status === 401 ? '登录已过期，请重新登录。' : '语音设置暂时无法读取，请重试。'));
  if (!body || !Array.isArray(body.hotwords) || !body.capabilities) throw new Error('语音设置返回不完整，请重新加载。');
  return body;
}

export function SpeechRecognitionSettings() {
  const id = useId();
  const [settings, setSettings] = useState<SpeechSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState<'load' | 'save' | null>('load');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  const [refreshingCapabilities, setRefreshingCapabilities] = useState(false);
  const [capabilitiesError, setCapabilitiesError] = useState('');
  const alive = useRef(false);
  const busy = useRef(false);
  const request = useRef<AbortController | null>(null);
  const capabilityRequest = useRef<AbortController | null>(null);
  const focusNewTerm = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    capabilityRequest.current?.abort(); capabilityRequest.current = null;
    setRefreshingCapabilities(false); setCapabilitiesError('');
    setPending('load');
    setError('');
    const abort = new AbortController();
    request.current = abort;
    try {
      const data = await settingsResponse(await fetch('/api/speech-settings', { signal: abort.signal, cache: 'no-store', credentials: 'same-origin' }));
      if (!alive.current || abort.signal.aborted) return;
      setSettings(data);
      setDraft(toDraft(data));
      setConflict(false);
      setMessage('');
    } catch (cause) {
      if (alive.current && !abort.signal.aborted) setError(cause instanceof Error ? cause.message : '语音设置读取失败，请重试。');
    } finally {
      if (request.current === abort) { busy.current = false; if (alive.current && !abort.signal.aborted) setPending(null); }
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) void load(); });
    return () => { cancelled = true; alive.current = false; request.current?.abort(); request.current = null; capabilityRequest.current?.abort(); capabilityRequest.current = null; busy.current = false; };
  }, [load]);

  async function refreshCapabilities() {
    if (busy.current || capabilityRequest.current || !settings) return;
    const abort = new AbortController(); capabilityRequest.current = abort;
    setRefreshingCapabilities(true); setCapabilitiesError('');
    try {
      const data = await settingsResponse(await fetch('/api/speech-settings', { signal: abort.signal, cache: 'no-store', credentials: 'same-origin' }));
      if (!alive.current || abort.signal.aborted || capabilityRequest.current !== abort) return;
      // Refresh the live service only. The saved baseline, CAS version and
      // unsaved words remain exactly as they were when refresh was requested.
      setSettings(current => current ? { ...current, capabilities: data.capabilities } : current);
    } catch (cause) {
      if (alive.current && !abort.signal.aborted && capabilityRequest.current === abort) setCapabilitiesError(cause instanceof Error ? cause.message : '服务状态刷新失败，请重试。');
    } finally {
      if (capabilityRequest.current === abort) { capabilityRequest.current = null; if (alive.current && !abort.signal.aborted) setRefreshingCapabilities(false); }
    }
  }

  const update = (patch: Partial<Draft>) => {
    if (busy.current) return;
    setDraft(current => current ? { ...current, ...patch } : current);
    setError(''); setMessage('');
  };
  const updateWord = (wordId: string, patch: Partial<HotwordDraft>) => {
    if (draft) update({ hotwords: draft.hotwords.map(item => item.id === wordId ? { ...item, ...patch } : item) });
  };
  const dirty = !!settings && !!draft && JSON.stringify(draft) !== JSON.stringify(toDraft(settings));

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!settings || !draft || busy.current || !dirty) return;
    const hotwords = draft.hotwords.map(item => ({ id: item.id, term: item.term.trim(), enabled: item.enabled,
      aliases: [...new Set(item.aliasesText.split(/[,，、;；\n]/u).map(value => value.trim()).filter(Boolean))] }));
    if (hotwords.some(item => !item.term)) { setError('请填写每一条热词的标准词，或删除空白行。'); return; }
    if (hotwords.some(item => item.aliases.length > 5 || item.aliases.some(alias => alias.length < 2 || alias.length > 40))) {
      setError('每条热词最多填写 5 个误识别写法，每个写法为 2–40 个字。'); return;
    }
    capabilityRequest.current?.abort(); capabilityRequest.current = null;
    setRefreshingCapabilities(false); setCapabilitiesError('');
    busy.current = true; setPending('save'); setError(''); setMessage('');
    const abort = new AbortController(); request.current = abort;
    try {
      const response = await fetch('/api/speech-settings', { method: 'POST', credentials: 'same-origin', signal: abort.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: settings.version, ...draft, hotwords }) });
      if (response.status === 409 && alive.current && !abort.signal.aborted) setConflict(true);
      const data = await settingsResponse(response);
      if (!alive.current || abort.signal.aborted) return;
      setSettings(data); setDraft(toDraft(data)); setConflict(false);
      setMessage('语音设置已保存，下一次录音转写将使用新的热词表。');
    } catch (cause) {
      if (alive.current && !abort.signal.aborted) setError(cause instanceof Error ? cause.message : '保存未完成，修改内容已保留，可稍后重试。');
    } finally {
      if (request.current === abort) { busy.current = false; if (alive.current && !abort.signal.aborted) setPending(null); }
    }
  }

  const capabilities = settings?.capabilities;
  return <section id="speech-recognition-settings" className="speech-settings" aria-labelledby={`${id}-title`} aria-busy={pending !== null}>
    <header className="speech-settings-heading"><span className="speech-settings-icon" aria-hidden="true"><AudioLines size={22} /></span><div><h2 id={`${id}-title`}>语音识别</h2></div><span className="speech-service-status">{pending === 'load' ? <><Loader2 size={14} className="spin" />读取中</> : capabilities?.available ? '识别服务已连接' : capabilities?.configured ? '识别服务暂不可用' : '识别服务未配置'}</span></header>
    {pending === 'load' && !draft ? <p className="speech-loading" role="status">正在读取语音设置与识别服务状态…</p> : !draft ? <div className="speech-feedback speech-feedback-error" role="alert"><CircleAlert size={17} /><div><p>{error || '暂时无法读取语音设置。'}</p><button type="button" className="speech-text-button" onClick={() => void load()} disabled={pending !== null}><RotateCcw size={14} />重新加载</button></div></div> : <>
      <div className="speech-service-detail" aria-busy={refreshingCapabilities}><AudioLines size={16} aria-hidden="true" /><div className="speech-service-copy"><p>{capabilities?.available ? <><strong>{capabilities.model || '录音识别服务'}</strong><span>可用方言：{capabilities.dialects.map(value => DIALECT_LABELS[value as SpeechDialect] || value).join('、') || '以音频识别结果为准'}{capabilities.diarization ? ' · 支持讲话人区分' : ' · 当前服务未提供讲话人区分'}</span></> : capabilities?.message || '配置自部署语音服务后，可对已上传的录音进行识别。热词表可以先保存。'}</p><button type="button" className="speech-text-button speech-service-refresh" disabled={pending !== null || refreshingCapabilities} onClick={() => void refreshCapabilities()}>{refreshingCapabilities ? <Loader2 size={14} className="spin" /> : <RotateCcw size={14} />}{refreshingCapabilities ? '正在刷新服务状态…' : '刷新服务状态'}</button>{capabilitiesError && <p className="speech-service-refresh-error" role="alert">{capabilitiesError} 当前编辑内容已保留。</p>}</div></div>
      <form onSubmit={event => void save(event)}>
        <fieldset disabled={pending !== null} className="speech-settings-fields"><legend className="speech-sr-only">录音识别偏好与热词表</legend>
          <div className="speech-preferences">
            <label htmlFor={`${id}-dialect`}>语言与方言<select id={`${id}-dialect`} value={draft.dialect} onChange={event => update({ dialect: event.target.value as SpeechDialect })}>{SPEECH_DIALECTS.map(value => <option key={value} value={value} disabled={!!capabilities?.available && !capabilities.dialects.includes(value)}>{DIALECT_LABELS[value]}</option>)}</select></label>
            <label htmlFor={`${id}-speakers`}>讲话人数<select id={`${id}-speakers`} value={draft.speakerCount ?? 'auto'} disabled={!draft.diarization || pending !== null} onChange={event => update({ speakerCount: event.target.value === 'auto' ? null : Number(event.target.value) })}><option value="auto">自动判断</option>{Array.from({ length: 10 }, (_, index) => index + 1).map(value => <option key={value} value={value}>{value} 人</option>)}</select></label>
          </div>
          <label className="speech-diarization" htmlFor={`${id}-diarization`}><input id={`${id}-diarization`} type="checkbox" checked={draft.diarization} onChange={event => update({ diarization: event.target.checked })} /><span className="speech-diarization-copy"><strong>区分不同讲话人</strong><span>编号不代表人员身份</span></span></label>
          <div className="speech-hotwords-heading"><div><h3>热词表 <span>{draft.hotwords.length} / 50</span></h3></div><button type="button" className="speech-button speech-button-secondary" disabled={pending !== null || draft.hotwords.length >= 50} onClick={() => { const wordId = crypto.randomUUID(); focusNewTerm.current = wordId; update({ hotwords: [...draft.hotwords, { id: wordId, term: '', aliasesText: '', enabled: true }] }); }}><Plus size={16} />添加热词</button></div>
          {draft.hotwords.length ? <div className="speech-hotwords"><div className="speech-hotword-columns" aria-hidden="true"><span>标准词</span><span>常见误识别写法</span><span>启用</span><span /></div>{draft.hotwords.map((word, index) => <div className="speech-hotword-row" key={word.id}>
            <label htmlFor={`${id}-term-${word.id}`}><span className="speech-mobile-label">标准词</span><input ref={node => { if (node && focusNewTerm.current === word.id) { focusNewTerm.current = null; node.focus(); } }} id={`${id}-term-${word.id}`} aria-label={`第 ${index + 1} 条标准词`} value={word.term} maxLength={40} placeholder="如：企查查" onChange={event => updateWord(word.id, { term: event.target.value })} /></label>
            <label htmlFor={`${id}-alias-${word.id}`}><span className="speech-mobile-label">常见误识别写法</span><input id={`${id}-alias-${word.id}`} aria-label={`第 ${index + 1} 条热词的误识别写法`} aria-describedby={`${id}-aliases-help`} value={word.aliasesText} placeholder="如：企业查查，企茶茶" onChange={event => updateWord(word.id, { aliasesText: event.target.value })} /></label>
            <label className="speech-hotword-enable"><input type="checkbox" checked={word.enabled} onChange={event => updateWord(word.id, { enabled: event.target.checked })} aria-label={`启用热词 ${word.term || `第 ${index + 1} 条`}`} /><span className="speech-mobile-label">启用</span></label>
            <button type="button" className="speech-delete-button" aria-label={`删除热词 ${word.term || `第 ${index + 1} 条`}`} onClick={() => update({ hotwords: draft.hotwords.filter(item => item.id !== word.id) })}><Trash2 size={16} /><span className="speech-mobile-label">删除</span></button>
          </div>)}</div> : <div className="speech-hotwords-empty"><p>还没有添加热词</p></div>}
          <p id={`${id}-aliases-help`} className="speech-help">每条最多 5 个误识别写法，逗号分隔；留空仅作识别提示。纠正前的原文保留可查。</p>
        </fieldset>
        {error && <div className="speech-feedback speech-feedback-error" role="alert"><CircleAlert size={17} /><p>{error}{conflict && ' 当前编辑内容仍保留；重新加载会放弃这些修改。'}</p></div>}
        {message && <div className="speech-feedback" role="status"><Check size={17} /><p>{message}</p></div>}
        {conflict && <button type="button" className="speech-text-button speech-conflict-reload" disabled={pending !== null} onClick={() => void load()}><RotateCcw size={14} />放弃修改并读取最新设置</button>}
        <footer className="speech-settings-footer"><span>{pending === 'save' ? '正在保存…' : dirty ? '有未保存的修改' : '设置仅对当前账户生效'}</span><button type="submit" className="speech-button speech-button-primary" disabled={pending !== null || !dirty}>{pending === 'save' ? <Loader2 size={16} className="spin" /> : <Check size={16} />}保存</button></footer>
      </form>
    </>}
  </section>;
}
