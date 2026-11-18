'use client';

import { modelDisplayName } from './CoreViews';
import { TrainingReview, TrainingReplyTip } from './TrainingReview';

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowUp, BookOpen, Check, CheckCheck, ChevronRight, FileText, GitBranch, GraduationCap, History, Info, Loader2, MessageSquare, Mic, Plus, RotateCcw, Search, Send, ShieldCheck, Sparkles, Square, Upload, Volume2, X } from 'lucide-react';
import './studio.css';
import './training-voice.css';
import './training-setup.css';
import { TrainingBrowserVoiceSelect, TrainingVoiceControls } from './TrainingVoiceControls';
import { TrainingProfileSetup, TrainingSessionProfile } from './TrainingProfileSetup';
import type { TrainingProfile } from '../lib/training-profile';
import { ApiConnectionSettings } from './ApiConnectionSettings';
import MaterialConnectionSettings from './MaterialConnectionSettings';
import ZegoConnectionSettings from './ZegoConnectionSettings';
import { EmbeddingSettings } from './EmbeddingSettings';
import { MineruConnectionSettings } from './MineruConnectionSettings';
import { CompanyConnectionSettings } from './CompanyConnectionSettings';
import { SpeechRecognitionSettings } from './SpeechRecognitionSettings';
import { DuplexVoiceControls, DuplexVoiceSelect } from './DuplexVoiceControls';
import { useTrainingVoice } from '../lib/use-training-voice';
import { useDuplexVoice } from '../lib/use-duplex-voice';
import { parseDuplexVoiceCatalog, type DuplexVoiceCatalog } from '../lib/duplex-voice';
import { createVoiceTurnQueue, type VoiceTurn, type VoiceQueueSnapshot } from '../lib/voice-turn-queue';
import { type ApiResult, type Mutate, type Skill, type ViewProps } from '../lib/types';

const customerLabel = (value: string) => value.replace(/\s*·\s*演示扮演\s*$/u, '').replace(/（体验[^）]*）/gu, '').trim();
const dateLabel = (value: string) => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function useMutation(mutate: Mutate) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const running = useRef(false);
  const perform = useCallback(async (action: string, payload?: Record<string, unknown>): Promise<ApiResult | null> => {
    if (running.current) return null;
    running.current = true;
    setBusy(true);
    setError('');
    try { return await mutate(action, payload); }
    catch (problem) { setError(problem instanceof Error ? problem.message : '操作未完成，请重试。'); return null; }
    finally { running.current = false; setBusy(false); }
  }, [mutate]);
  return { busy, error, setError, perform };
}

function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <div className={`studio-notice${error ? ' studio-notice-error' : ''}`} role={error ? 'alert' : 'status'}><Info size={16} /><span>{children}</span></div>;
}
function Empty({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return <div className="studio-empty">{icon}<h3>{title}</h3>{detail && <p>{detail}</p>}</div>;
}
function PageHeading({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return <header className="studio-heading"><div><h1>{title}</h1>{description && <p>{description}</p>}</div>{children && <div className="studio-heading-action">{children}</div>}</header>;
}
function BusyIcon({ busy, children }: { busy: boolean; children: ReactNode }) { return busy ? <Loader2 size={16} className="studio-spin" /> : children; }


const SCENARIOS = [
  { name: '价格与价值异议', duration: '3–5 轮' },
  { name: '免租期异议', duration: '3–5 轮' },
  { name: '竞品比较', duration: '3–5 轮' },
  { name: '首访剧本', duration: '4–6 轮' },
];

type TrainingInteractionMode = 'text' | 'voice';

export function TrainingView({ state, mutate, notify,onPendingChange,onMediaStopReady }: ViewProps & {onPendingChange?:(count:number)=>void;onMediaStopReady?:(stop:(()=>void)|null)=>void}) {
  const { busy, error, setError, perform } = useMutation(mutate);
  const [scenario, setScenario] = useState(SCENARIOS[0].name);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [showReplyTips, setShowReplyTips] = useState(true);
  const [reviewSessionId, setReviewSessionId] = useState<string | null>(null);
  useEffect(() => {
    const restorePreference = window.setTimeout(() => {
      try { setShowReplyTips(localStorage.getItem('workbench-training-reply-tips') !== 'off'); } catch {}
    }, 0);
    return () => window.clearTimeout(restorePreference);
  }, []);
  const toggleReplyTips = () => {
    const enabled = !showReplyTips;
    setShowReplyTips(enabled);
    try { localStorage.setItem('workbench-training-reply-tips', enabled ? 'on' : 'off'); } catch {}
  };
  const [interactionMode, setInteractionMode] = useState<TrainingInteractionMode>('text');
  const [voiceTransport, setVoiceTransport] = useState<'duplex'|'browser'>('duplex');
  const [gatewayConfigured, setGatewayConfigured] = useState<boolean|null>(null);
  const [gatewayError, setGatewayError] = useState('');
  const [gatewayCatalog, setGatewayCatalog] = useState<DuplexVoiceCatalog|null>(null);
  const [preferredVoice, setPreferredVoice] = useState('');
  const [voiceQueue, setVoiceQueue] = useState<VoiceQueueSnapshot>({pending:0,failed:null,error:''});
  const [browserRevision,setBrowserRevision]=useState(0);
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [unaddedTranscript, setUnaddedTranscript] = useState('');
  const [playingMessage, setPlayingMessage] = useState<string | null>(null);
  const browserTranscript = useRef('');
  const browserAutoStop = useRef<ReturnType<typeof setTimeout>|null>(null);
  const saveVoiceTurn = useRef<(turn:VoiceTurn)=>Promise<void>>(async()=>{});
  const queueRef = useRef<ReturnType<typeof createVoiceTurnQueue>|null>(null);
  useEffect(()=>{queueRef.current=createVoiceTurnQueue(turn=>saveVoiceTurn.current(turn),snapshot=>{setVoiceQueue(snapshot);onPendingChange?.(snapshot.pending);});return()=>queueRef.current?.reset();},[onPendingChange]);
  const inputOwner = useRef<string | null>(null);
  const voiceContext = useRef({ sessionId, active: false, mode: interactionMode, busy: false, transport:voiceTransport });
  const autoSpokenMessages = useRef(new Set<string>());
  const playbackGeneration = useRef(0);
  const session = state.trainingSessions.find(item => item.id === sessionId);
  const history = [...state.trainingSessions].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const chatRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const lastScroll = useRef(0);
  const setDraft = useCallback((text: string) => { setReply(text); }, []);
  const onTranscript = useCallback((text: string) => {
    const context = voiceContext.current;
    if (!inputOwner.current || inputOwner.current !== context.sessionId || !context.active || context.mode !== 'voice' || context.transport!=='browser' || !text.trim()) return;
    browserTranscript.current += text.trim();
    setBrowserRevision(value=>value+1);
  }, []);
  const onDuplexFinal=useCallback(({id,text}:{id:string;text:string})=>{
    const context=voiceContext.current;
    if(!context.sessionId||!context.active||context.mode!=='voice'||context.transport!=='duplex')return;
    try{queueRef.current?.enqueue({id:`duplex:${id}`,sessionId:context.sessionId,text});}
    catch(cause){setGatewayError(cause instanceof Error?cause.message:'语音回应未能加入队列');setUnaddedTranscript(text);}
  },[]);
  const duplex=useDuplexVoice({onFinal:onDuplexFinal});
  const {disconnect:disconnectDuplex,speak:speakDuplex,phase:duplexPhase,inputActive:duplexInputActive,partial:duplexPartial}=duplex;
  const voice = useTrainingVoice({ onTranscript });
  const { stopAll, speak,stopListening } = voice;
  const capturing = voice.phase === 'requesting' || voice.phase === 'listening' || voice.phase === 'stopping';
  const speechActive = voice.phase === 'preparing-speech' || voice.phase === 'speaking'||duplex.speaking||duplex.pendingPlayback;
  const stopVoice = useCallback(() => { inputOwner.current = null;browserTranscript.current='';if(browserAutoStop.current)clearTimeout(browserAutoStop.current);browserAutoStop.current=null;stopAll();disconnectDuplex();setPlayingMessage(null); }, [stopAll,disconnectDuplex]);
  useEffect(()=>{onMediaStopReady?.(stopVoice);return()=>onMediaStopReady?.(null);},[onMediaStopReady,stopVoice]);

  useEffect(() => {
    voiceContext.current = { sessionId, active: session?.status === 'active', mode: interactionMode, busy,transport:voiceTransport };
    saveVoiceTurn.current=async turn=>{
      const context=voiceContext.current;
      if(context.sessionId!==turn.sessionId||!context.active||context.mode!=='voice')return;
      await mutate('training_reply',{sessionId:turn.sessionId,text:turn.text,voiceTurnId:turn.id});
    };
  }, [sessionId, session?.status, interactionMode, busy,voiceTransport,mutate]);
  useEffect(() => {
    if (interactionMode !== 'voice' || voiceTransport !== 'duplex' || gatewayCatalog !== null) return;
    const abort = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/training-voice?catalog=1', { credentials: 'same-origin', cache: 'no-store', signal: abort.signal });
        const data = await response.json() as { configured?: boolean; voices?: unknown; defaultVoice?: unknown; error?: string };
        if (!response.ok) throw new Error(data.error || '无法检查语音服务配置');
        if (abort.signal.aborted) return;
        setGatewayConfigured(data.configured === true);
        setGatewayCatalog(data.configured === true ? parseDuplexVoiceCatalog({ voices: data.voices ?? [], defaultVoice: data.defaultVoice ?? '' }, true) : { voices: [], defaultVoice: '' });
      } catch {
        if (!abort.signal.aborted) setGatewayCatalog({ voices: [], defaultVoice: '' });
      }
    })();
    return () => abort.abort();
  }, [interactionMode, voiceTransport, gatewayCatalog]);
  useEffect(() => {
    const invalidatePendingPlayback = () => { if (document.hidden) {playbackGeneration.current += 1;inputOwner.current=null;browserTranscript.current='';if(browserAutoStop.current)clearTimeout(browserAutoStop.current);browserAutoStop.current=null;} };
    document.addEventListener('visibilitychange', invalidatePendingPlayback);
    return () => document.removeEventListener('visibilitychange', invalidatePendingPlayback);
  }, []);
  // Media belongs to the selected conversation. Cleanup also invalidates late recognition results.
  useEffect(() => () => {queueRef.current?.reset();stopVoice();}, [sessionId, session?.status, interactionMode,voiceTransport,stopVoice]);
  // Browser compatibility mode waits for a pause, then stops recognition so its last
  // final result can arrive. No editable draft or manual send is involved.
  useEffect(()=>{
    if(interactionMode!=='voice'||voiceTransport!=='browser'||!inputOwner.current)return;
    if(voice.phase==='idle'){
      const text=browserTranscript.current.trim();browserTranscript.current='';const owner=inputOwner.current;inputOwner.current=null;
      if(text&&!document.hidden){try{queueRef.current?.enqueue({id:`browser:${crypto.randomUUID()}`,sessionId:owner,text});}catch(cause){setUnaddedTranscript(text);setGatewayError(cause instanceof Error?cause.message:'语音未能发送');}}
      return;
    }
    if(voice.phase!=='listening')return;
    if(browserAutoStop.current)clearTimeout(browserAutoStop.current);
    if(browserTranscript.current||voice.interimTranscript)browserAutoStop.current=setTimeout(()=>stopListening(),1400);
    return()=>{if(browserAutoStop.current)clearTimeout(browserAutoStop.current);browserAutoStop.current=null;};
  },[interactionMode,voiceTransport,voice.phase,voice.interimTranscript,stopListening,browserRevision]);
  useEffect(()=>{if(voiceQueue.failed){inputOwner.current=null;browserTranscript.current='';stopAll();disconnectDuplex();}},[voiceQueue.failed,stopAll,disconnectDuplex]);
  const lastMessage = session?.messages.at(-1);
  const lastMessageIndex = (session?.messages.length ?? 0) - 1;
  useEffect(() => {
    const duplexMode=voiceTransport==='duplex';
    if (document.hidden || interactionMode !== 'voice' || (!duplexMode&&!autoSpeak) || (duplexMode?duplexPhase!=='connected'||duplexInputActive||!!duplexPartial:!voice.ready||!voice.outputSupported||capturing) || busy || voiceQueue.pending>0 || !sessionId || session?.status !== 'active' || lastMessage?.role !== 'assistant') return;
    const key = `${sessionId}:${lastMessageIndex}:${lastMessage.content}`;
    if (autoSpokenMessages.current.has(key)) return;
    // Defer until the current effect has settled; Strict Mode cleanup must not consume playback.
    const generation = playbackGeneration.current;
    const timer = window.setTimeout(() => {
      const context = voiceContext.current;
      if (generation !== playbackGeneration.current || document.hidden || context.sessionId !== sessionId || context.mode !== 'voice' || !context.active || context.busy || (!duplexMode&&inputOwner.current)) return;
      autoSpokenMessages.current.add(key);
      setPlayingMessage(key);
      if(duplexMode)speakDuplex(lastMessage.content,crypto.randomUUID());else speak(lastMessage.content);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [interactionMode,voiceTransport,duplexPhase,duplexInputActive,duplexPartial,speakDuplex,voiceQueue.pending, autoSpeak, voice.ready, voice.outputSupported, busy, capturing, sessionId, session?.status, lastMessage?.role, lastMessage?.content, lastMessageIndex, speak]);
  useEffect(() => {
    const container = chatRef.current;
    if (container && pinned.current && Date.now() - lastScroll.current > 150) container.scrollTop = container.scrollHeight;
  }, [session?.messages.length, sessionId, showReplyTips]);

  const changeMode = (mode: TrainingInteractionMode) => { if(voiceQueue.pending){notify('请先等待语音保存完成，失败时可直接重试。');return;}if (mode !== interactionMode) { stopVoice(); setInteractionMode(mode); } };
  const chooseSession = (id: string | null) => {if(voiceQueue.pending){notify('请先等待语音保存完成，失败时可直接重试。');return;} stopVoice(); setSessionId(id); setDraft(''); setUnaddedTranscript(''); setError(''); pinned.current = true; };
  const start = async (profile: TrainingProfile) => {
    stopVoice();
    const result = await perform('training_start', { scenario, profile, confirmed: true });
    if (result?.session) { setSessionId(result.session.id); setDraft(''); setUnaddedTranscript(''); pinned.current = true; notify('陪练已开始，可以像面对客户一样自然回应。'); }
  };
  const sendReply = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!session || session.status !== 'active' || !reply.trim() || busy || capturing || voiceQueue.pending>0) return;
    stopVoice();
    const result = await perform('training_reply', { sessionId: session.id, text: reply.trim() });
    if (result) setDraft('');
  };
  const finish = async () => {
    if (!session || session.status !== 'active'||voiceQueue.pending>0) return;
    stopVoice();
    const result = await perform('training_finish', { sessionId: session.id });
    if (result?.session?.status === 'completed') setReviewSessionId(result.session.id);
  };
  const startListening = () => {
    if (!session || session.status !== 'active' || interactionMode !== 'voice' || busy || capturing || !voice.ready || !voice.inputSupported) return;
    if (lastMessage?.role === 'assistant') autoSpokenMessages.current.add(`${session.id}:${lastMessageIndex}:${lastMessage.content}`);
    inputOwner.current = session.id;
    browserTranscript.current='';
    setPlayingMessage(null);
    voice.startListening();
  };
  const cancelListening = () => { inputOwner.current = null;browserTranscript.current=''; voice.cancelListening(); };
  const changeTransport=(transport:'duplex'|'browser')=>{if(voiceQueue.pending){notify('请先等待语音保存完成，失败时可直接重试。');return;}if(transport!==voiceTransport){stopVoice();setVoiceTransport(transport);setGatewayError('');}};
  const presetVoice = gatewayCatalog?.voices.some(item => item.id === preferredVoice) ? preferredVoice : gatewayCatalog?.defaultVoice ?? '';
  const connectDuplex=()=>{if(session?.status==='active'){setGatewayError('');if(lastMessage?.role==='assistant')autoSpokenMessages.current.delete(`${session.id}:${lastMessageIndex}:${lastMessage.content}`);void duplex.connect(session.id, preferredVoice || presetVoice);}};
  const playCustomer = (text: string, key: string) => {
    if(interactionMode==='voice'&&voiceTransport==='duplex'){
      if(duplex.phase!=='connected'||duplex.inputActive)return;
      if((duplex.speaking||duplex.pendingPlayback)&&playingMessage===key){duplex.interrupt();setPlayingMessage(null);}
      else{setPlayingMessage(key);duplex.speak(text,crypto.randomUUID());}
      return;
    }
    if (capturing || !voice.ready || !voice.outputSupported) return;
    if (speechActive && playingMessage === key) { voice.stopSpeaking(); setPlayingMessage(null); }
    else { setPlayingMessage(key); voice.speak(text); }
  };

  const modeSelection = <div className="training-mode-switch" role="group" aria-label="陪练方式"><button type="button" disabled={busy} aria-pressed={interactionMode === 'text'} onClick={() => changeMode('text')}><MessageSquare size={15} aria-hidden="true" />文字陪练</button><button type="button" disabled={busy} aria-pressed={interactionMode === 'voice'} onClick={() => changeMode('voice')}><Mic size={15} aria-hidden="true" />语音陪练</button></div>;
  const transportSelection = <div className="training-transport-switch" role="group" aria-label="语音连接方式"><button type="button" disabled={busy} aria-pressed={voiceTransport === 'duplex'} onClick={() => changeTransport('duplex')}>实时语音</button><button type="button" disabled={busy} aria-pressed={voiceTransport === 'browser'} onClick={() => changeTransport('browser')}>兼容模式</button></div>;
  const setupVoice = interactionMode === 'text' ? null
    : voiceTransport === 'browser' ? <TrainingBrowserVoiceSelect voice={voice} disabled={busy} />
    : gatewayCatalog?.voices.length ? <DuplexVoiceSelect voices={gatewayCatalog.voices} selectedVoice={presetVoice} onSelect={setPreferredVoice} disabled={busy} />
    : <div className="training-setup-help">
        <Volume2 size={15} aria-hidden="true" />
        <span role="status">{!gatewayCatalog ? '正在读取实时音色。' : gatewayConfigured === false ? '语音服务未连接。' : '暂时无法提前读取实时音色。'}</span>
        {gatewayCatalog && <>
          <button type="button" className="studio-btn studio-btn-ghost" disabled={busy} onClick={() => setGatewayCatalog(null)}>重试读取</button>
          <button type="button" className="studio-btn studio-btn-ghost" disabled={busy} onClick={() => changeTransport('browser')}>切换兼容模式</button>
        </>}
      </div>;

  return <section className="studio-view studio-training-view">
    <header className="studio-heading training-page-heading"><h1>AI带练</h1><span className="training-page-subtitle">基于真实异议剧本进行多轮实战对练与六维复盘</span></header>
    {error && session && <Notice error>{error}</Notice>}
    <div className="studio-training-layout">
      <main className="studio-training-main">
        {session && <div className="training-interaction-bar"><strong>陪练方式</strong>{modeSelection}</div>}
        {interactionMode === 'text' && voice.error && <div className="training-voice-error training-voice-text-error" role="alert"><Info size={16} /><div><p>{voice.error}</p><span>文字回应仍可正常发送，也可稍后重新播放客户语音。</span></div><button type="button" className="studio-icon-button" onClick={voice.clearError} aria-label="关闭语音提示"><X size={15} /></button></div>}
        {interactionMode === 'voice' && session && <>{transportSelection}{voiceTransport==='duplex'?<DuplexVoiceControls voice={duplex} configured={gatewayConfigured} configurationError={gatewayError} customer={session ? customerLabel(session.customer) : undefined} active={session?.status==='active'} pending={voiceQueue.pending} onConnect={connectDuplex} onUseBrowser={()=>changeTransport('browser')} catalog={gatewayCatalog?.voices ?? []} preferredVoice={presetVoice} onVoiceChange={setPreferredVoice} />:<TrainingVoiceControls voice={voice} customer={session ? customerLabel(session.customer) : undefined} hasSession={Boolean(session)} active={session?.status === 'active'} busy={busy||voiceQueue.pending>0} autoSpeak={autoSpeak} onAutoSpeakChange={enabled => { setAutoSpeak(enabled); if (!enabled) voice.stopSpeaking(); }} onStartListening={startListening} onCancelListening={cancelListening} onUseText={() => changeMode('text')} />}</>}
        {voiceQueue.failed&&<div className="training-voice-error" role="alert"><Info size={16}/><div><p>语音暂未保存：{voiceQueue.error}</p><p>「{voiceQueue.failed.text}」</p><button type="button" onClick={()=>queueRef.current?.retry()}>直接重试保存</button><button type="button" style={{marginLeft:16}} onClick={()=>queueRef.current?.reset()}>舍弃全部待保存语音</button></div></div>}
        {!session ? <div className="training-setup" aria-busy={busy}>
          <section className="training-setup-card training-setup-script" aria-label="选择剧本">
            <h2>选择剧本</h2>
            <div className="studio-scenario-grid" role="group" aria-label="练习剧本">{SCENARIOS.map(item => <button key={item.name} type="button" disabled={busy} className={`studio-scenario${scenario === item.name ? ' studio-scenario-selected' : ''}`} onClick={() => { stopVoice(); setScenario(item.name); setError(''); }} aria-pressed={scenario === item.name}><span>{item.name}</span>{scenario === item.name && <Check size={14} aria-hidden="true" />}<small>{item.duration}</small></button>)}</div>
          </section>
          <TrainingProfileSetup key={scenario} scenario={scenario} voice={interactionMode === 'voice'} busy={busy} error={error} modelConnected={state.model.connected}
            modeSelection={<>{modeSelection}{interactionMode === 'voice' && transportSelection}</>}
            voiceSelection={setupVoice}
            onEdit={() => setError('')} onConfirm={start}
          />
        </div> : <div className="studio-session-panel">
          <div className="studio-session-head"><div className="studio-row"><span className="studio-icon-clay"><GraduationCap size={22} /></span><div><h2>{session.scenario}</h2><p>{customerLabel(session.customer)} · {session.status === 'active' ? '客户角色对话' : '已完成的练习'}</p></div></div><div className="training-session-actions">
            {session.status === 'active' && <button type="button" role="switch" className="training-tip-switch" aria-checked={showReplyTips} onClick={toggleReplyTips}><span className="training-tip-toggle" aria-hidden="true" />建议怎么回答</button>}
            <button type="button" className="studio-btn studio-btn-ghost" disabled={busy} onClick={() => chooseSession(null)}>新建练习<ChevronRight size={15} /></button>
          </div></div>
          <TrainingSessionProfile key={session.id} profile={session.profile} mode={session.mode} />
          <div className="studio-training-chat" ref={chatRef} onScroll={event => { const target = event.currentTarget; pinned.current = target.scrollHeight - target.scrollTop - target.clientHeight < 48; lastScroll.current = Date.now(); }} aria-live="polite" aria-relevant="additions text">
            {session.messages.map((message, index) => {
              const key = `${session.id}:${index}:${message.content}`;
              const playing = speechActive && playingMessage === key;
              const unavailable=interactionMode==='voice'&&voiceTransport==='duplex'?duplex.phase!=='connected'||duplex.inputActive:!voice.ready||!voice.outputSupported||capturing;
              return <div className={`studio-training-message studio-training-${message.role}`} key={`${session.id}-${index}`}><span>{message.role === 'user' ? '我的回应' : customerLabel(session.customer)}</span><p>{message.role === 'assistant' ? message.content.replace(/^\s*[（(]\s*演示客户\s*[）)]\s*[:：]?\s*/u, '') : message.content}</p>{message.role === 'assistant' && <button type="button" className="training-message-play" disabled={unavailable} onClick={() => playCustomer(message.content, key)} aria-label={playing ? '停止客户语音' : '播放客户语音'} title={unavailable?'请连接语音服务，或切换兼容模式播放':undefined}>{playing ? <Square size={12} /> : <Volume2 size={13} />}{playing ? '停止播报' : '播放客户语音'}</button>}
                {message.role === 'assistant' && session.status === 'active' && showReplyTips && <TrainingReplyTip message={message} scenario={session.scenario} />}
              </div>;
            })}
            {busy && session.status === 'active' && <div className="studio-training-thinking"><Loader2 size={15} className="studio-spin" /> 正在处理本轮练习…</div>}
          </div>
          {session.status === 'active' ? <div className="studio-training-bottom">
            {unaddedTranscript && <div className="training-transcript-overflow" role="alert"><Info size={15} /><div><strong>这段语音暂未发送，请缩短表述或等待队列保存。</strong><details><summary>查看未发送的 {unaddedTranscript.length.toLocaleString('zh-CN')} 字，可选中复制</summary><p>{unaddedTranscript}</p></details><button type="button" onClick={() => setUnaddedTranscript('')}>收起提示</button></div></div>}
            {interactionMode==='text'?<form className="studio-reply-composer" onSubmit={sendReply}><label className="studio-sr-only" htmlFor="training-reply">输入你的回应</label><textarea id="training-reply" rows={3} value={reply} onChange={event => setDraft(event.target.value)} placeholder="试着回应客户的顾虑…" maxLength={4000} onKeyDown={event => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendReply(); } }} /><div><span>Enter 发送 · Shift + Enter 换行<span className="training-draft-count">{reply.length.toLocaleString('zh-CN')} / 4,000</span></span><button type="submit" className="studio-send" disabled={busy || capturing || !reply.trim()} aria-label="发送回应"><BusyIcon busy={busy}><ArrowUp size={18} /></BusyIcon></button></div></form>:<div className="training-auto-submit"><Mic size={17}/><span>{voiceQueue.pending?`${voiceQueue.pending} 段语音正在自动保存…`:'语音识别后自动发送'}</span></div>}<div className="studio-training-footer"><span>{session.messages.filter(message => message.role === 'user').length} 轮回应</span><button className="studio-btn studio-btn-secondary" disabled={busy||voiceQueue.pending>0} onClick={finish}><CheckCheck size={15} />结束并复盘</button></div></div> : <div className="training-review-summary">
            <div><strong>练习复盘</strong><span>{session.score == null ? '评分暂无记录' : `${session.score} / 100 分`}</span></div>
            <button className="studio-btn studio-btn-secondary" type="button" onClick={() => setReviewSessionId(session.id)}>查看评分</button>
          </div>}
          {session.status === 'completed' && reviewSessionId === session.id && <TrainingReview session={session} onClose={() => setReviewSessionId(null)} />}
        </div>}
      </main>
      <aside className="studio-training-aside" aria-label="练习记录及复盘"><div className="studio-aside-heading"><History size={17} aria-hidden="true" /><h2>练习记录及复盘</h2><span>{history.length}</span></div>{history.length ? <div className="studio-history-list">{history.map(item => <button type="button" className={`studio-history-item${sessionId === item.id ? ' studio-history-active' : ''}`} key={item.id} disabled={busy} onClick={() => chooseSession(item.id)}><div><strong>{item.scenario}</strong><span className="studio-history-score">{item.status === 'completed' ? `${item.score ?? '—'} 分` : '进行中'}</span></div>{item.profile && <small className="training-history-customer">{item.profile.name} · {item.profile.difficulty}</small>}<small>{dateLabel(item.createdAt)} · {item.messages.filter(message => message.role === 'user').length} 轮</small></button>)}</div> : <Empty icon={<History size={24} />} title="暂无练习记录" detail="完成一次多轮对话后，这里保留逐轮记录与复盘评分。" />}</aside>
    </div>
  </section>;
}

type KnowledgeTab = 'knowledge' | 'skills' | 'review';
type KnowledgeForm = { title: string; content: string; category: string };
type CandidateForm = { title: string; description: string; scenario: string; steps: string; boundaries: string; evidence: string; source: string; dealId: string };
const emptyCandidate = (): CandidateForm => ({ title: '', description: '', scenario: '', steps: '', boundaries: '', evidence: '', source: '', dealId: '' });
const skillStatus = (status: Skill['status']) => ({ candidate: '待审核', published: '已生效', rejected: '已退回' })[status];

export function KnowledgeView({ state, mutate, notify, canReviewSkills = state.role === 'manager', canSubmitExperience = true, initialTab = 'knowledge' }: ViewProps & { canReviewSkills?: boolean; canSubmitExperience?: boolean; initialTab?:KnowledgeTab }) {
  const manager = state.role === 'manager';
  const { busy, error, setError, perform } = useMutation(mutate);
  const [tab, setTab] = useState<KnowledgeTab>(initialTab);
  const [reviewStatus, setReviewStatus] = useState<'candidate' | 'rejected'>('candidate');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('全部分类');
  const [selectedId, setSelectedId] = useState('');
  const [form, setForm] = useState<'knowledge' | 'candidate' | null>(null);
  const [knowledgeForm, setKnowledgeForm] = useState<KnowledgeForm>({ title: '', content: '', category: '业务知识' });
  const [candidateForm, setCandidateForm] = useState<CandidateForm>(emptyCandidate);
  const [reviewNote, setReviewNote] = useState('');
  const [fileName, setFileName] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const query = search.trim().toLowerCase();
  const skillPool = state.skills.filter(skill => tab === 'review' ? skill.status === reviewStatus : skill.status === 'published');
  const knowledgePool = state.knowledge.filter(item => item.status === 'published');
  const categories = ['全部分类', ...new Set((tab === 'knowledge' ? knowledgePool : skillPool).map(item => item.category))];
  const knowledgeItems = knowledgePool.filter(item => (category === '全部分类' || item.category === category) && `${item.title} ${item.category} ${item.content} ${item.source}`.toLowerCase().includes(query));
  const skillItems = skillPool.filter(item => (category === '全部分类' || item.category === category) && `${item.title} ${item.description} ${item.scenario} ${item.steps.join(' ')} ${item.boundaries.join(' ')} ${item.evidence} ${item.source} ${item.reviewer ?? ''} ${item.reviewNote ?? ''}`.toLowerCase().includes(query));
  const selectedKnowledge = knowledgeItems.find(item => item.id === selectedId) ?? knowledgeItems[0];
  const selectedSkill = skillItems.find(item => item.id === selectedId) ?? skillItems[0];
  const switchTab = (value: KnowledgeTab) => { setTab(value); setReviewStatus('candidate'); setCategory('全部分类'); setSelectedId(''); setForm(null); setReviewNote(''); setError(''); };
  const addKnowledge = async (event: FormEvent) => {
    event.preventDefault();
    const result = await perform('knowledge_add', { ...knowledgeForm, title: knowledgeForm.title.trim(), content: knowledgeForm.content.trim() });
    if (result) { setForm(null); setKnowledgeForm({ title: '', content: '', category: '业务知识' }); setFileName(''); setSearch(''); setCategory('全部分类'); setSelectedId(result.state.knowledge.find(item => !state.knowledge.some(old => old.id === item.id))?.id ?? ''); notify('知识已导入并生效。'); }
  };
  const addCandidate = async (event: FormEvent) => {
    event.preventDefault();
    const result = await perform('skill_candidate', { ...candidateForm, dealId: candidateForm.dealId || undefined, steps: candidateForm.steps.split('\n').map(line => line.trim()).filter(Boolean), boundaries: candidateForm.boundaries.split('\n').map(line => line.trim()).filter(Boolean) });
    if (result) { setForm(null); setCandidateForm(emptyCandidate()); setTab('review'); setReviewStatus('candidate'); setCategory('全部分类'); setSearch(''); setSelectedId(result.state.skills.find(item => !state.skills.some(old => old.id === item.id))?.id ?? ''); notify('候选 Skill 已提交，等待管理者本人审核。'); }
  };
  const reviewSkill = async (decision: 'publish' | 'reject') => {
    if (!selectedSkill || !reviewNote.trim()) { setError('请先填写审核意见，说明发布依据或需要补充的内容。'); return; }
    const result = await perform('skill_review', { skillId: selectedSkill.id, decision, note: reviewNote.trim(), version: selectedSkill.version });
    if (result) { setReviewNote(''); if (decision === 'reject') { setReviewStatus('rejected'); setCategory('全部分类'); } notify(decision === 'publish' ? 'Skill 已由你审核发布，生效知识已同步。' : '候选 Skill 已退回并保存审核意见。'); }
  };
  const importFile = async (file: File | undefined) => {
    if (!file) return;
    if (!/\.(txt|md|markdown)$/i.test(file.name)) { setError('仅支持 UTF-8 文本或 Markdown 文件（.txt / .md / .markdown）。'); return; }
    if (file.size > 250000) { setError('文件过大，请导入 50,000 字以内的文本内容。'); return; }
    try { const content = await file.text(); if (content.length > 50000) { setError('内容超过 50,000 字，请拆分后导入。'); return; } setKnowledgeForm(previous => ({ ...previous, title: previous.title || file.name.replace(/\.[^.]+$/, ''), content })); setFileName(file.name); setError(''); }
    catch { setError('无法读取文件，请检查编码或直接粘贴文本。'); }
  };
  return <section className="studio-view">
    <PageHeading title="知识库" />
    {error && <Notice error>{error}</Notice>}
    <div className="studio-tabs-bar"><div className="studio-tabs" role="tablist" aria-label="知识与技能类型"><button role="tab" aria-selected={tab === 'knowledge'} className={tab === 'knowledge' ? 'studio-tab-active' : ''} onClick={() => switchTab('knowledge')}><BookOpen size={16} />知识库<span>{knowledgePool.length}</span></button><button role="tab" aria-selected={tab === 'skills'} className={tab === 'skills' ? 'studio-tab-active' : ''} onClick={() => switchTab('skills')}><Sparkles size={16} />Skill 库<span>{state.skills.filter(item => item.status === 'published').length}</span></button>{(canSubmitExperience || canReviewSkills) && <button role="tab" aria-selected={tab === 'review'} className={tab === 'review' ? 'studio-tab-active' : ''} onClick={() => switchTab('review')}><ShieldCheck size={16} />{canReviewSkills ? '审核中心' : '候选记录'}<span>{state.skills.filter(item => item.status === 'candidate').length}</span></button>}</div>{(manager || canSubmitExperience) && <div className="studio-row">{form ? <button type="button" className="studio-btn studio-btn-secondary" disabled={busy} onClick={() => setForm(null)}><ArrowLeft size={15} />返回知识列表</button> : <>{manager && <button className="studio-btn studio-btn-secondary" onClick={() => { setForm('knowledge'); setError(''); }}><Upload size={15} />导入知识</button>}{canSubmitExperience && <button className="studio-btn studio-btn-primary" onClick={() => { setForm('candidate'); setError(''); }}><Plus size={15} />提交经验</button>}</>}</div>}</div>
    {form ? <div className="studio-form-panel"><div className="studio-panel-heading"><div><h2>{form === 'knowledge' ? '导入团队知识' : '提交经验'}</h2><p>{form === 'knowledge' ? 'TXT / Markdown / 粘贴文本 · 导入后立即生效' : '保留原始证据，提交后由管理者审核发布为团队生效 Skill。'}</p></div><button className="studio-icon-button" onClick={() => setForm(null)} aria-label="关闭表单" disabled={busy}><X size={19} /></button></div>
      {form === 'knowledge' && manager ? <form onSubmit={addKnowledge} className="studio-form"><div className="studio-import-zone"><FileText size={25} /><div><strong>{fileName || '选择文本或 Markdown 文件'}</strong><p>仅 .txt、.md、.markdown · 最多 50,000 字</p></div><button type="button" className="studio-btn studio-btn-secondary" onClick={() => fileRef.current?.click()} disabled={busy}><Upload size={15} />选择文件</button><input ref={fileRef} className="studio-sr-only" type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" onChange={event => { void importFile(event.target.files?.[0]); event.target.value = ''; }} aria-label="导入文本或 Markdown 文件" /></div><div className="studio-form-row"><label>知识标题<input required maxLength={150} value={knowledgeForm.title} onChange={event => setKnowledgeForm({ ...knowledgeForm, title: event.target.value })} placeholder="例如：产品方案、商务条款与授权规范" /></label><label>分类<input required maxLength={40} value={knowledgeForm.category} onChange={event => setKnowledgeForm({ ...knowledgeForm, category: event.target.value })} /></label></div><label>知识正文<textarea required rows={9} maxLength={50000} value={knowledgeForm.content} onChange={event => setKnowledgeForm({ ...knowledgeForm, content: event.target.value })} placeholder="粘贴知识正文，保留来源、适用范围和更新时间…" /><small>{knowledgeForm.content.length.toLocaleString()} / 50,000 字</small></label><div className="studio-form-actions"><button type="button" className="studio-btn studio-btn-ghost" onClick={() => setForm(null)} disabled={busy}>取消</button><button className="studio-btn studio-btn-primary" disabled={busy || !knowledgeForm.title.trim() || !knowledgeForm.content.trim()}><BusyIcon busy={busy}><Check size={16} /></BusyIcon>确认导入并生效</button></div></form> : <form onSubmit={addCandidate} className="studio-form"><div className="studio-form-row"><label>经验名称<input required maxLength={150} value={candidateForm.title} onChange={event => setCandidateForm({ ...candidateForm, title: event.target.value })} placeholder="为这次有效做法起一个清晰的名字" /></label><label>关联项目（可选）<select value={candidateForm.dealId} onChange={event => setCandidateForm({ ...candidateForm, dealId: event.target.value })}><option value="">不关联项目</option>{state.deals.map(deal => <option key={deal.id} value={deal.id}>{deal.projectName || deal.name}</option>)}</select></label></div><div className="studio-form-row"><label>经验摘要<input required maxLength={1000} value={candidateForm.description} onChange={event => setCandidateForm({ ...candidateForm, description: event.target.value })} placeholder="做了什么，解决了什么问题" /></label><label>证据来源<input required maxLength={1000} value={candidateForm.source} onChange={event => setCandidateForm({ ...candidateForm, source: event.target.value })} placeholder="例如：客户拜访记录，2026-10-20；或运行记录编号" /></label></div><div className="studio-form-row"><label>适用场景<textarea required rows={2} maxLength={2000} value={candidateForm.scenario} onChange={event => setCandidateForm({ ...candidateForm, scenario: event.target.value })} placeholder="在什么客户、阶段或条件下可以使用？" /></label><label>原始案例证据<textarea required rows={2} maxLength={5000} value={candidateForm.evidence} onChange={event => setCandidateForm({ ...candidateForm, evidence: event.target.value })} placeholder="写下可核查的对话原文、过程和实际结果；区分事实与推断。" /></label></div><div className="studio-form-row"><label>操作步骤（每行一步）<textarea required rows={3} maxLength={5000} value={candidateForm.steps} onChange={event => setCandidateForm({ ...candidateForm, steps: event.target.value })} placeholder={'先澄清客户的具体诉求\n用证据说明方案价值\n确认双方的下一步动作'} /></label><label>适用边界（每行一条）<textarea required rows={3} maxLength={5000} value={candidateForm.boundaries} onChange={event => setCandidateForm({ ...candidateForm, boundaries: event.target.value })} placeholder={'未经批准不承诺商务条件\n缺少关键事实时先补充信息'} /></label></div><div className="studio-form-actions"><span><ShieldCheck size={14} />提交后不会自动发布，需管理者审核生效</span><button type="button" className="studio-btn studio-btn-ghost" disabled={busy} onClick={() => setForm(null)}>取消</button><button className="studio-btn studio-btn-primary" disabled={busy}><BusyIcon busy={busy}><Send size={15} /></BusyIcon>提交候选 Skill</button></div></form>}
    </div> : <>
      <div className="studio-filterbar"><label className="studio-search"><Search size={17} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder={tab === 'knowledge' ? '搜索知识标题、正文或来源' : '搜索场景、步骤或案例证据'} aria-label="全文搜索知识和技能" />{search && <button className="studio-icon-button" onClick={() => setSearch('')} aria-label="清空搜索"><X size={15} /></button>}</label><label className="studio-category"><span className="studio-sr-only">筛选分类</span><select value={category} onChange={event => setCategory(event.target.value)}>{categories.map(item => <option key={item}>{item}</option>)}</select></label>{tab === 'review' && <label className="studio-category"><span className="studio-sr-only">筛选审核状态</span><select value={reviewStatus} onChange={event => { setReviewStatus(event.target.value as 'candidate' | 'rejected'); setCategory('全部分类'); setSelectedId(''); setReviewNote(''); }}><option value="candidate">待审核</option><option value="rejected">已退回</option></select></label>}<span className="studio-result-count">{tab === 'knowledge' ? knowledgeItems.length : skillItems.length} 条内容</span></div>
      {tab === 'review' && <Notice>{reviewStatus === 'rejected' ? '已退回，尚未生效。请核对审核意见。' : canReviewSkills ? '核对证据与适用边界，填写审核意见后发布或退回。' : '待管理者审核，通过后生效。'}</Notice>}
      <div className="studio-library-layout"><div className="studio-library-list">{tab === 'knowledge' ? knowledgeItems.length ? knowledgeItems.map(item => <button key={item.id} className={`studio-library-item${selectedKnowledge?.id === item.id ? ' studio-library-item-active' : ''}`} onClick={() => setSelectedId(item.id)}><div><BookOpen size={18} /><span>{item.category}</span></div><h3>{item.title}</h3><p>{item.content.slice(0, 90)}</p><small>{dateLabel(item.updatedAt)}<ChevronRight size={15} /></small></button>) : <Empty icon={<Search size={26} />} title="没有找到相关知识" detail="换一个关键词或分类，也可以导入新的团队知识。" /> : skillItems.length ? skillItems.map(item => <button key={item.id} className={`studio-library-item${selectedSkill?.id === item.id ? ' studio-library-item-active' : ''}`} onClick={() => { setSelectedId(item.id); setReviewNote(''); }}><div><Sparkles size={18} /><span>{item.category}</span><span className="studio-tag">{skillStatus(item.status)}</span></div><h3>{item.title}</h3><p>{item.description}</p><small>{item.author} · v{item.version}<ChevronRight size={15} /></small></button>) : <Empty icon={tab === 'review' ? <ShieldCheck size={28} /> : <Sparkles size={28} />} title={query ? '没有找到相关 Skill' : tab === 'review' ? reviewStatus === 'rejected' ? '暂无已退回的经验' : '暂无待审核的经验' : '暂无生效的 Skill'} detail={query ? '试试其他场景关键词，或切换分类。' : '提交经验并经管理者审核后生效。'} />}</div>
        <article className="studio-library-detail">{tab === 'knowledge' ? selectedKnowledge ? <><div className="studio-detail-kicker"><span className="studio-tag">{selectedKnowledge.category}</span><span><Check size={13} />已生效</span></div><h2>{selectedKnowledge.title}</h2><div className="studio-detail-meta">来源：{selectedKnowledge.source} · 更新于 {dateLabel(selectedKnowledge.updatedAt)}</div><div className="studio-document-content">{selectedKnowledge.content}</div></> : <Empty icon={<BookOpen size={32} />} title="请选择知识" detail="" /> : selectedSkill ? <><div className="studio-detail-kicker"><span className="studio-tag">{skillStatus(selectedSkill.status)}</span><span>Skill · v{selectedSkill.version}</span></div><h2>{selectedSkill.title}</h2><p className="studio-detail-description">{selectedSkill.description}</p><div className="studio-detail-meta">{selectedSkill.author} · {selectedSkill.category} · {dateLabel(selectedSkill.updatedAt)}</div><div className="studio-skill-section"><h3><GitBranch size={16} />适用场景</h3><p>{selectedSkill.scenario}</p></div><div className="studio-skill-section"><h3><CheckCheck size={16} />执行步骤</h3><ol>{selectedSkill.steps.map((step, index) => <li key={index}>{step}</li>)}</ol></div><div className="studio-skill-section"><h3><ShieldCheck size={16} />边界与限制</h3><ul>{selectedSkill.boundaries.map((boundary, index) => <li key={index}>{boundary}</li>)}</ul></div><div className="studio-evidence"><span><FileText size={15} />原始案例证据</span><p>{selectedSkill.evidence}</p><small>来源：{selectedSkill.source}</small></div>{(selectedSkill.reviewer || selectedSkill.reviewNote) && <div className="studio-skill-section"><h3>审核记录</h3><p>审核人：{selectedSkill.reviewer ?? '未记录'}</p><p>审核意见：{selectedSkill.reviewNote ?? '未填写'}</p></div>}{canReviewSkills && selectedSkill.status === 'candidate' && <div className="studio-review-box"><label>你的审核意见<textarea rows={3} maxLength={3000} value={reviewNote} onChange={event => setReviewNote(event.target.value)} placeholder="证据是否充分？哪些条件和边界需要保留？" /></label><div><button className="studio-btn studio-btn-secondary" disabled={busy || !reviewNote.trim()} onClick={() => reviewSkill('reject')}><RotateCcw size={15} />退回补充</button><button className="studio-btn studio-btn-primary" disabled={busy || !reviewNote.trim()} onClick={() => reviewSkill('publish')}><BusyIcon busy={busy}><Check size={15} /></BusyIcon>审核并发布</button></div><small>发布将同步加入团队生效知识。</small></div>}</> : <Empty icon={<Sparkles size={32} />} title="请选择 Skill" detail="" />}</article>
      </div>
    </>}
  </section>;
}

export { BuilderStudio as StudioView } from './BuilderStudio';

export { RunsView } from './RunHistoryView';

const SERVICE_TABS = [
  { id: 'llm', label: '大模型' },
  { id: 'material', label: '营销素材' },
  { id: 'zego', label: '数字人' },
  { id: 'speech', label: '语音识别' },
  { id: 'meeting', label: '腾讯会议' },
  { id: 'company', label: '企业数据' },
  { id: 'embedding', label: '向量检索' },
  { id: 'mineru', label: '文档解析' },
] as const;

export function SettingsView({ state, onConnectionChanged, meetingSettings }: ViewProps & { onConnectionChanged?: () => Promise<void>; meetingSettings?: ReactNode }) {
  const [activeService, setActiveService] = useState<(typeof SERVICE_TABS)[number]['id']>('llm');
  const hasMeetingSettings = Boolean(meetingSettings);
  const visibleServiceTabs = hasMeetingSettings ? SERVICE_TABS : SERVICE_TABS.filter(item => item.id !== 'meeting');
  useEffect(() => {
    const openLinkedService = () => {
      const linked = SERVICE_TABS.find(item => window.location.hash === `#${item.id}-connection`);
      if (linked && (linked.id !== 'meeting' || hasMeetingSettings)) setActiveService(linked.id);
    };
    openLinkedService();
    window.addEventListener('hashchange', openLinkedService);
    return () => window.removeEventListener('hashchange', openLinkedService);
  }, [hasMeetingSettings]);
  const panels: Record<typeof activeService, ReactNode> = {
    llm: <ApiConnectionSettings onSaved={onConnectionChanged}/>,
    material: <MaterialConnectionSettings onConnectionChanged={onConnectionChanged}/>,
    zego: <ZegoConnectionSettings onConnectionChanged={onConnectionChanged}/>,
    speech: <SpeechRecognitionSettings/>,
    meeting: meetingSettings,
    company: <><CompanyConnectionSettings provider="jinghai"/><CompanyConnectionSettings/></>,
    embedding: <EmbeddingSettings/>,
    mineru: <MineruConnectionSettings/>,
  };
  return <section className="studio-view studio-settings-view">
    <PageHeading title="服务连接" description="统一配置大模型推理、营销素材生成、数字人直播、语音与会议接入及企业数据接口。"/>
    <div className="studio-service-nav" role="tablist" aria-label="服务连接">
      {visibleServiceTabs.map((item, index) => <button key={item.id} id={`service-tab-${item.id}`} type="button" role="tab"
        aria-selected={activeService === item.id} aria-controls={`${item.id}-connection`} tabIndex={activeService === item.id ? 0 : -1}
        className={activeService === item.id ? 'is-active' : ''} onClick={() => setActiveService(item.id)}
        onKeyDown={event => {
          const count = visibleServiceTabs.length;
          const destinations: Record<string, number> = { ArrowLeft: (index + count - 1) % count, ArrowRight: (index + 1) % count, Home: 0, End: count - 1 };
          if (!Object.hasOwn(destinations, event.key)) return;
          event.preventDefault();
          const next = visibleServiceTabs[destinations[event.key]];
          setActiveService(next.id);
          document.getElementById(`service-tab-${next.id}`)?.focus();
        }}>{item.label}</button>)}
    </div>
    {visibleServiceTabs.map(item => <div key={item.id} role="tabpanel" id={`${item.id}-connection`}
      aria-labelledby={`service-tab-${item.id}`} hidden={activeService !== item.id}
      className={item.id === 'meeting' ? 'studio-meeting-settings' : undefined}>{panels[item.id]}</div>)}
    <details className="studio-setting-description studio-workspace-data"><summary>工作空间数据与运行环境</summary>
      <dl><div><dt>当前模型</dt><dd>{state.model.connected?modelDisplayName(state.model.name):'未配置'}</dd></div><div><dt>数据版本</dt><dd>{state.revision}</dd></div></dl>
      <p>客户与案例包含预置示例。企业 SSO、组织架构与 CRM 尚未接入；业务数据保存在当前工作空间。</p>
    </details>
  </section>;
}
