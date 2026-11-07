'use client';

import { modelDisplayName } from './CoreViews';

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowUp, BookOpen, Check, CheckCheck, ChevronRight, CircleHelp, Code2, Database, FileText, GitBranch, GraduationCap, History, Info, Layers, Loader2, MessageSquare, Mic, Plus, RotateCcw, Search, Send, ShieldCheck, Sparkles, Square, Upload, Volume2, X } from 'lucide-react';
import './studio.css';
import './training-voice.css';
import { TrainingVoiceControls } from './TrainingVoiceControls';
import { TrainingProfileSetup, TrainingSessionProfile } from './TrainingProfileSetup';
import type { TrainingProfile } from '../lib/training-profile';
import { ApiConnectionSettings } from './ApiConnectionSettings';
import { EmbeddingSettings } from './EmbeddingSettings';
import { CompanyConnectionSettings } from './CompanyConnectionSettings';
import { SpeechRecognitionSettings } from './SpeechRecognitionSettings';
import { DuplexVoiceControls } from './DuplexVoiceControls';
import { useTrainingVoice } from '../lib/use-training-voice';
import { useDuplexVoice } from '../lib/use-duplex-voice';
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
  return <div className="studio-empty">{icon}<h3>{title}</h3><p>{detail}</p></div>;
}
function PageHeading({ title, description, children }: { eyebrow?: string; title: string; description: string; children?: ReactNode }) {
  return <header className="studio-heading"><div><h1>{title}</h1><p>{description}</p></div>{children && <div className="studio-heading-action">{children}</div>}</header>;
}
function BusyIcon({ busy, children }: { busy: boolean; children: ReactNode }) { return busy ? <Loader2 size={16} className="studio-spin" /> : children; }
function ModeTag({ mode, configured = false }: { mode: 'demo' | 'live'; configured?: boolean }) { return <span className={`studio-tag${mode === 'live' ? ' studio-tag-live' : ''}`}><span className="studio-status-dot" />{mode === 'demo' ? '本地生成' : configured ? '接口已配置' : '模型生成'}</span>; }

const SCENARIOS = [
  { name: '价格与价值异议', icon: <MessageSquare size={22} />, tag: '价值沟通', detail: '面对价格疑虑，练习澄清目标、说明价值与确认采购条件。', duration: '建议 3–5 轮' },
  { name: '免租期异议', icon: <ShieldCheck size={22} />, tag: '商务谈判', detail: '客户要求延长免租期，练习澄清诉求、交换条件与授权边界。', duration: '建议 3–5 轮' },
  { name: '竞品比较', icon: <Layers size={22} />, tag: '价值沟通', detail: '面对竞品价格，练习比较口径、差异价值与证据表达。', duration: '建议 3–5 轮' },
  { name: '首访剧本', icon: <MessageSquare size={22} />, tag: '客户拜访', detail: '用一次自然对话，练习开场、需求探索与下一步约定。', duration: '建议 4–6 轮' },
];

type TrainingInteractionMode = 'text' | 'voice';

export function TrainingView({ state, mutate, notify,onPendingChange,onMediaStopReady }: ViewProps & {onPendingChange?:(count:number)=>void;onMediaStopReady?:(stop:(()=>void)|null)=>void}) {
  const { busy, error, setError, perform } = useMutation(mutate);
  const [scenario, setScenario] = useState(SCENARIOS[0].name);
  const [sessionId, setSessionId] = useState<string | null>(() => state.trainingSessions.find(session => session.status === 'active')?.id ?? null);
  const [reply, setReply] = useState('');
  const [interactionMode, setInteractionMode] = useState<TrainingInteractionMode>('text');
  const [voiceTransport, setVoiceTransport] = useState<'duplex'|'browser'>('duplex');
  const [gatewayConfigured, setGatewayConfigured] = useState<boolean|null>(null);
  const [gatewayError, setGatewayError] = useState('');
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
  useEffect(()=>{
    const abort=new AbortController();
    void fetch('/api/training-voice',{credentials:'same-origin',cache:'no-store',signal:abort.signal}).then(async response=>{const data=await response.json() as {configured?:boolean;error?:string};if(!response.ok)throw new Error(data.error||'无法检查语音服务配置');setGatewayConfigured(data.configured===true);}).catch(cause=>{if(!abort.signal.aborted){setGatewayConfigured(false);setGatewayError(cause instanceof Error?cause.message:'无法检查语音服务配置');}});
    return()=>abort.abort();
  },[]);
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
  }, [session?.messages.length, sessionId]);

  const changeMode = (mode: TrainingInteractionMode) => { if(voiceQueue.pending){notify('请先等待语音保存完成，失败时可直接重试。');return;}if (mode !== interactionMode) { stopVoice(); setInteractionMode(mode); } };
  const chooseSession = (id: string | null) => {if(voiceQueue.pending){notify('请先等待语音保存完成，失败时可直接重试。');return;} stopVoice(); setSessionId(id); setDraft(''); setUnaddedTranscript(''); setError(''); pinned.current = true; };
  const start = async (profile: TrainingProfile) => {
    stopVoice();
    const result = await perform('training_start', { scenario, profile, confirmed: true });
    if (result?.session) { setSessionId(result.session.id); setDraft(''); setUnaddedTranscript(''); pinned.current = true; notify('带练已开始，可以像面对客户一样自然回应。'); }
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
    if (result) notify('本次带练已完成，复盘已保存。');
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
  const connectDuplex=()=>{if(session?.status==='active'){setGatewayError('');if(lastMessage?.role==='assistant')autoSpokenMessages.current.delete(`${session.id}:${lastMessageIndex}:${lastMessage.content}`);void duplex.connect(session.id);}};
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

  return <section className="studio-view studio-training-view">
    <header className="studio-heading training-page-heading"><div><h1>下一次沟通，先练习一次</h1><p>先确认客户画像，再和模拟客户练习一场真实的沟通。</p></div></header>
    {error && session && <Notice error>{error}</Notice>}
    <div className="studio-training-layout">
      <main className="studio-training-main">
        <div className="training-interaction-bar"><div><strong>选择你的练习方式</strong><p>{interactionMode === 'voice' ? '听客户说，再把你的回应说出来。' : '留一点思考时间，把回应写得更清楚。'}</p></div><div className="training-mode-switch" role="group" aria-label="带练方式"><button type="button" disabled={busy} aria-pressed={interactionMode === 'text'} onClick={() => changeMode('text')}><MessageSquare size={15} />文字带练</button><button type="button" disabled={busy} aria-pressed={interactionMode === 'voice'} onClick={() => changeMode('voice')}><Mic size={15} />语音带练</button></div></div>
        {interactionMode === 'text' && voice.error && <div className="training-voice-error training-voice-text-error" role="alert"><Info size={16} /><div><p>{voice.error}</p><span>文字回应仍可正常发送，也可稍后重新播放客户语音。</span></div><button type="button" className="studio-icon-button" onClick={voice.clearError} aria-label="关闭语音提示"><X size={15} /></button></div>}
        {interactionMode === 'voice' && session && <><div className="training-transport-switch" role="group" aria-label="语音连接方式"><button type="button" aria-pressed={voiceTransport==='duplex'} onClick={()=>changeTransport('duplex')}>全双工 · 自部署服务</button><button type="button" aria-pressed={voiceTransport==='browser'} onClick={()=>changeTransport('browser')}>浏览器语音 · 兼容模式</button></div>{voiceTransport==='duplex'?<DuplexVoiceControls voice={duplex} configured={gatewayConfigured} configurationError={gatewayError} customer={session ? customerLabel(session.customer) : undefined} active={session?.status==='active'} pending={voiceQueue.pending} onConnect={connectDuplex} onUseBrowser={()=>changeTransport('browser')}/>:<TrainingVoiceControls voice={voice} customer={session ? customerLabel(session.customer) : undefined} hasSession={Boolean(session)} active={session?.status === 'active'} busy={busy||voiceQueue.pending>0} autoSpeak={autoSpeak} onAutoSpeakChange={enabled => { setAutoSpeak(enabled); if (!enabled) voice.stopSpeaking(); }} onStartListening={startListening} onCancelListening={cancelListening} onUseText={() => changeMode('text')} />}</>}
        {voiceQueue.failed&&<div className="training-voice-error" role="alert"><Info size={16}/><div><p>语音暂未保存：{voiceQueue.error}</p><p>「{voiceQueue.failed.text}」</p><button type="button" onClick={()=>queueRef.current?.retry()}>直接重试保存</button><button type="button" style={{marginLeft:16}} onClick={()=>queueRef.current?.reset()}>舍弃全部待保存语音</button></div></div>}
        {!session ? <>
          <div className="studio-section-label">选择这次想练习的场景</div>
          <div className="studio-scenario-grid">{SCENARIOS.map(item => <button key={item.name} type="button" disabled={busy} className={`studio-scenario${scenario === item.name ? ' studio-scenario-selected' : ''}`} onClick={() => { stopVoice(); setScenario(item.name); setError(''); }} aria-pressed={scenario === item.name}><div className="studio-scenario-top"><span className="studio-icon-clay">{item.icon}</span><span>{item.tag}</span>{scenario === item.name && <Check size={17} />}</div><h3>{item.name}</h3><p>{item.detail}</p><small>{item.duration}</small></button>)}</div>
          <TrainingProfileSetup key={scenario} scenario={scenario} voice={interactionMode === 'voice'} busy={busy} error={error} modelConnected={state.model.connected} onEdit={() => setError('')} onConfirm={start} />
        </> : <div className="studio-session-panel">
          <div className="studio-session-head"><div className="studio-row"><span className="studio-icon-clay"><GraduationCap size={22} /></span><div><h2>{session.scenario}</h2><p>{customerLabel(session.customer)} · {session.status === 'active' ? '客户角色对话' : '已完成的练习'}</p></div></div><button type="button" className="studio-btn studio-btn-ghost" disabled={busy} onClick={() => chooseSession(null)}>新建练习<ChevronRight size={15} /></button></div>
          <TrainingSessionProfile key={session.id} profile={session.profile} mode={session.mode} />
          <div className="studio-training-chat" ref={chatRef} onScroll={event => { const target = event.currentTarget; pinned.current = target.scrollHeight - target.scrollTop - target.clientHeight < 48; lastScroll.current = Date.now(); }} aria-live="polite" aria-relevant="additions text">
            {session.messages.map((message, index) => {
              const key = `${session.id}:${index}:${message.content}`;
              const playing = speechActive && playingMessage === key;
              const unavailable=interactionMode==='voice'&&voiceTransport==='duplex'?duplex.phase!=='connected'||duplex.inputActive:!voice.ready||!voice.outputSupported||capturing;
              return <div className={`studio-training-message studio-training-${message.role}`} key={`${session.id}-${index}`}><span>{message.role === 'user' ? '我的回应' : customerLabel(session.customer)}</span><p>{message.role === 'assistant' ? message.content.replace(/^\s*[（(]\s*演示客户\s*[）)]\s*[:：]?\s*/u, '') : message.content}</p>{message.role === 'assistant' && <button type="button" className="training-message-play" disabled={unavailable} onClick={() => playCustomer(message.content, key)} aria-label={playing ? '停止客户语音' : '播放客户语音'} title={unavailable?'请连接语音服务，或切换兼容模式播放':undefined}>{playing ? <Square size={12} /> : <Volume2 size={13} />}{playing ? '停止播报' : '播放客户语音'}</button>}</div>;
            })}
            {busy && session.status === 'active' && <div className="studio-training-thinking"><Loader2 size={15} className="studio-spin" /> 正在处理本轮练习…</div>}
          </div>
          {session.status === 'active' ? <div className="studio-training-bottom">
            {unaddedTranscript && <div className="training-transcript-overflow" role="alert"><Info size={15} /><div><strong>这段语音暂未发送，请缩短表述或等待队列保存。</strong><details><summary>查看未发送的 {unaddedTranscript.length.toLocaleString('zh-CN')} 字，可选中复制</summary><p>{unaddedTranscript}</p></details><button type="button" onClick={() => setUnaddedTranscript('')}>收起提示</button></div></div>}
            {interactionMode==='text'?<form className="studio-reply-composer" onSubmit={sendReply}><label className="studio-sr-only" htmlFor="training-reply">输入你的回应</label><textarea id="training-reply" rows={3} value={reply} onChange={event => setDraft(event.target.value)} placeholder="试着回应客户的顾虑…" maxLength={4000} onKeyDown={event => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendReply(); } }} /><div><span>Enter 发送 · Shift + Enter 换行<span className="training-draft-count">{reply.length.toLocaleString('zh-CN')} / 4,000</span></span><button type="submit" className="studio-send" disabled={busy || capturing || !reply.trim()} aria-label="发送回应"><BusyIcon busy={busy}><ArrowUp size={18} /></BusyIcon></button></div></form>:<div className="training-auto-submit"><Mic size={17}/><span>{voiceQueue.pending?`${voiceQueue.pending} 段语音正在自动保存…`:'语音识别完成后直接进入对话，无需修改或点击发送。'}</span></div>}<div className="studio-training-footer"><span>{session.messages.filter(message => message.role === 'user').length} 轮回应 · 可随时结束并复盘</span><button className="studio-btn studio-btn-secondary" disabled={busy||voiceQueue.pending>0} onClick={finish}><CheckCheck size={15} />结束并复盘</button></div></div> : <div className="studio-feedback"><div className="studio-score"><div><span className="studio-eyebrow">本次练习复盘</span><h3>从证据中找到下一次的进步</h3><p>评分依据本次对话表现，帮助定位下一次练习的重点。</p></div><div className="studio-score-value">{session.score ?? '—'}<small>/ 100</small></div></div>{session.feedback?.map(item => <div className="studio-feedback-item" key={item.label}><div><strong>{item.label}</strong><span>{item.score} 分</span></div><p><b>对话依据</b>{item.evidence}</p><p><b>下次试试</b>{item.suggestion}</p></div>)}</div>}
        </div>}
      </main>
      <aside className="studio-training-aside"><div className="studio-aside-heading"><History size={17} /><h2>我的练习记录</h2><span>{history.length}</span></div>{history.length ? <div className="studio-history-list">{history.map(item => <button type="button" className={`studio-history-item${sessionId === item.id ? ' studio-history-active' : ''}`} key={item.id} disabled={busy} onClick={() => chooseSession(item.id)}><div><strong>{item.scenario}</strong><span className="studio-history-score">{item.status === 'completed' ? `${item.score ?? '—'} 分` : '进行中'}</span></div>{item.profile && <small className="training-history-customer">{item.profile.name} · {item.profile.difficulty}</small>}<small>{dateLabel(item.createdAt)} · {item.messages.filter(message => message.role === 'user').length} 轮</small></button>)}</div> : <Empty icon={<History size={26} />} title="练习从这里开始" detail="完成一次带练，你的对话和复盘会保存在这里。" />}<div className="studio-side-note"><CircleHelp size={17} /><p>客户由培训 Agent 扮演，练习对话和复盘会自动保存。</p></div></aside>
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
    <PageHeading eyebrow="FROM EXPERIENCE TO EXPERTISE" title="让好经验，成为团队的能力" description="有依据的知识，经过审核的 Skill，在下一次实战中复用。"><div className="studio-row">{manager && <button className="studio-btn studio-btn-secondary" onClick={() => { setForm('knowledge'); setError(''); }}><Upload size={16} />导入知识</button>}{canSubmitExperience && <button className="studio-btn studio-btn-primary" onClick={() => { setForm('candidate'); setError(''); }}><Plus size={16} />提交经验</button>}</div></PageHeading>
    {error && <Notice error>{error}</Notice>}
    <div className="studio-tabs" role="tablist" aria-label="知识与技能类型"><button role="tab" aria-selected={tab === 'knowledge'} className={tab === 'knowledge' ? 'studio-tab-active' : ''} onClick={() => switchTab('knowledge')}><BookOpen size={17} />知识库<span>{knowledgePool.length}</span></button><button role="tab" aria-selected={tab === 'skills'} className={tab === 'skills' ? 'studio-tab-active' : ''} onClick={() => switchTab('skills')}><Sparkles size={17} />Skill 库<span>{state.skills.filter(item => item.status === 'published').length}</span></button>{(canSubmitExperience || canReviewSkills) && <button role="tab" aria-selected={tab === 'review'} className={tab === 'review' ? 'studio-tab-active' : ''} onClick={() => switchTab('review')}><ShieldCheck size={17} />{canReviewSkills ? '审核中心' : '候选记录'}<span>{state.skills.filter(item => item.status === 'candidate').length}</span></button>}</div>
    {form ? <div className="studio-form-panel"><div className="studio-panel-heading"><div><h2>{form === 'knowledge' ? '导入团队知识' : '把一次好实践，提交为候选 Skill'}</h2><p>{form === 'knowledge' ? '支持直接粘贴文本，或读取本地文本 / Markdown 文件。确认后立即生效。' : '保留原始证据、操作步骤和适用边界。提交后由管理者本人决定是否发布。'}</p></div><button className="studio-icon-button" onClick={() => setForm(null)} aria-label="关闭表单" disabled={busy}><X size={19} /></button></div>
      {form === 'knowledge' && manager ? <form onSubmit={addKnowledge} className="studio-form"><div className="studio-import-zone"><FileText size={25} /><div><strong>{fileName || '选择文本或 Markdown 文件'}</strong><p>仅 .txt、.md、.markdown · 最多 50,000 字</p></div><button type="button" className="studio-btn studio-btn-secondary" onClick={() => fileRef.current?.click()} disabled={busy}><Upload size={15} />选择文件</button><input ref={fileRef} className="studio-sr-only" type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" onChange={event => { void importFile(event.target.files?.[0]); event.target.value = ''; }} aria-label="导入文本或 Markdown 文件" /></div><div className="studio-form-row"><label>知识标题<input required maxLength={150} value={knowledgeForm.title} onChange={event => setKnowledgeForm({ ...knowledgeForm, title: event.target.value })} placeholder="例如：产品方案、商务条款与授权规范" /></label><label>分类<input required maxLength={40} value={knowledgeForm.category} onChange={event => setKnowledgeForm({ ...knowledgeForm, category: event.target.value })} /></label></div><label>知识正文<textarea required rows={13} maxLength={50000} value={knowledgeForm.content} onChange={event => setKnowledgeForm({ ...knowledgeForm, content: event.target.value })} placeholder="粘贴知识正文，保留来源、适用范围和更新时间…" /><small>{knowledgeForm.content.length.toLocaleString()} / 50,000 字</small></label><div className="studio-form-actions"><button type="button" className="studio-btn studio-btn-ghost" onClick={() => setForm(null)} disabled={busy}>取消</button><button className="studio-btn studio-btn-primary" disabled={busy || !knowledgeForm.title.trim() || !knowledgeForm.content.trim()}><BusyIcon busy={busy}><Check size={16} /></BusyIcon>确认导入并生效</button></div></form> : <form onSubmit={addCandidate} className="studio-form"><div className="studio-form-row"><label>经验名称<input required maxLength={150} value={candidateForm.title} onChange={event => setCandidateForm({ ...candidateForm, title: event.target.value })} placeholder="为这次有效做法起一个清晰的名字" /></label><label>关联项目（可选）<select value={candidateForm.dealId} onChange={event => setCandidateForm({ ...candidateForm, dealId: event.target.value })}><option value="">不关联项目</option>{state.deals.map(deal => <option key={deal.id} value={deal.id}>{deal.projectName || deal.name}</option>)}</select></label></div><label>经验摘要<input required maxLength={1000} value={candidateForm.description} onChange={event => setCandidateForm({ ...candidateForm, description: event.target.value })} placeholder="做了什么，解决了什么问题" /></label><label>适用场景<textarea required rows={2} maxLength={2000} value={candidateForm.scenario} onChange={event => setCandidateForm({ ...candidateForm, scenario: event.target.value })} placeholder="在什么客户、阶段或条件下可以使用？" /></label><div className="studio-form-row"><label>操作步骤（每行一步）<textarea required rows={5} maxLength={5000} value={candidateForm.steps} onChange={event => setCandidateForm({ ...candidateForm, steps: event.target.value })} placeholder={'先澄清客户的具体诉求\n用证据说明方案价值\n确认双方的下一步动作'} /></label><label>适用边界（每行一条）<textarea required rows={5} maxLength={5000} value={candidateForm.boundaries} onChange={event => setCandidateForm({ ...candidateForm, boundaries: event.target.value })} placeholder={'未经批准不承诺商务条件\n缺少关键事实时先补充信息'} /></label></div><label>原始案例证据<textarea required rows={4} maxLength={5000} value={candidateForm.evidence} onChange={event => setCandidateForm({ ...candidateForm, evidence: event.target.value })} placeholder="写下可核查的对话原文、过程和实际结果；区分事实与推断。" /></label><label>证据来源<input required maxLength={1000} value={candidateForm.source} onChange={event => setCandidateForm({ ...candidateForm, source: event.target.value })} placeholder="例如：客户拜访记录，2026-10-20；或运行记录编号" /></label><div className="studio-form-actions"><span><ShieldCheck size={14} />提交后不会自动发布</span><button type="button" className="studio-btn studio-btn-ghost" disabled={busy} onClick={() => setForm(null)}>取消</button><button className="studio-btn studio-btn-primary" disabled={busy}><BusyIcon busy={busy}><Send size={15} /></BusyIcon>提交候选 Skill</button></div></form>}
    </div> : <>
      <div className="studio-filterbar"><label className="studio-search"><Search size={17} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder={tab === 'knowledge' ? '搜索知识标题、正文或来源' : '搜索场景、步骤或案例证据'} aria-label="全文搜索知识和技能" />{search && <button className="studio-icon-button" onClick={() => setSearch('')} aria-label="清空搜索"><X size={15} /></button>}</label><label className="studio-category"><span className="studio-sr-only">筛选分类</span><select value={category} onChange={event => setCategory(event.target.value)}>{categories.map(item => <option key={item}>{item}</option>)}</select></label>{tab === 'review' && <label className="studio-category"><span className="studio-sr-only">筛选审核状态</span><select value={reviewStatus} onChange={event => { setReviewStatus(event.target.value as 'candidate' | 'rejected'); setCategory('全部分类'); setSelectedId(''); setReviewNote(''); }}><option value="candidate">待审核</option><option value="rejected">已退回</option></select></label>}<span className="studio-result-count">{tab === 'knowledge' ? knowledgeItems.length : skillItems.length} 条内容</span></div>
      {tab === 'review' && <Notice>{reviewStatus === 'rejected' ? '已退回的 Skill 尚未生效。查看详情中的审核人与审核意见，核对需要补充的证据和适用边界。' : canReviewSkills ? '每个候选都需要你亲自核对证据与适用边界，填写审核意见后再发布或退回。' : '候选 Skill 正在等待管理者审核，通过后才会进入生效知识和 Agent 引用范围。'}</Notice>}
      <div className="studio-library-layout"><div className="studio-library-list">{tab === 'knowledge' ? knowledgeItems.length ? knowledgeItems.map(item => <button key={item.id} className={`studio-library-item${selectedKnowledge?.id === item.id ? ' studio-library-item-active' : ''}`} onClick={() => setSelectedId(item.id)}><div><BookOpen size={18} /><span>{item.category}</span></div><h3>{item.title}</h3><p>{item.content.slice(0, 90)}</p><small>{dateLabel(item.updatedAt)}<ChevronRight size={15} /></small></button>) : <Empty icon={<Search size={26} />} title="没有找到相关知识" detail="换一个关键词或分类，也可以导入新的团队知识。" /> : skillItems.length ? skillItems.map(item => <button key={item.id} className={`studio-library-item${selectedSkill?.id === item.id ? ' studio-library-item-active' : ''}`} onClick={() => { setSelectedId(item.id); setReviewNote(''); }}><div><Sparkles size={18} /><span>{item.category}</span><span className="studio-tag">{skillStatus(item.status)}</span></div><h3>{item.title}</h3><p>{item.description}</p><small>{item.author} · v{item.version}<ChevronRight size={15} /></small></button>) : <Empty icon={tab === 'review' ? <ShieldCheck size={28} /> : <Sparkles size={28} />} title={query ? '没有找到相关 Skill' : tab === 'review' ? reviewStatus === 'rejected' ? '暂无已退回的经验' : '暂无待审核的经验' : '暂无生效的 Skill'} detail={query ? '试试其他场景关键词，或切换分类。' : '有效经验提交并经管理者审核后，会在这里沉淀。'} />}</div>
        <article className="studio-library-detail">{tab === 'knowledge' ? selectedKnowledge ? <><div className="studio-detail-kicker"><span className="studio-tag">{selectedKnowledge.category}</span><span><Check size={13} />已生效</span></div><h2>{selectedKnowledge.title}</h2><div className="studio-detail-meta">来源：{selectedKnowledge.source} · 更新于 {dateLabel(selectedKnowledge.updatedAt)}</div><div className="studio-document-content">{selectedKnowledge.content}</div></> : <Empty icon={<BookOpen size={32} />} title="让每一次回答都有依据" detail="从左侧选择知识，阅读完整内容与来源。" /> : selectedSkill ? <><div className="studio-detail-kicker"><span className="studio-tag">{skillStatus(selectedSkill.status)}</span><span>Skill · v{selectedSkill.version}</span></div><h2>{selectedSkill.title}</h2><p className="studio-detail-description">{selectedSkill.description}</p><div className="studio-detail-meta">{selectedSkill.author} · {selectedSkill.category} · {dateLabel(selectedSkill.updatedAt)}</div><div className="studio-skill-section"><h3><GitBranch size={16} />适用场景</h3><p>{selectedSkill.scenario}</p></div><div className="studio-skill-section"><h3><CheckCheck size={16} />执行步骤</h3><ol>{selectedSkill.steps.map((step, index) => <li key={index}>{step}</li>)}</ol></div><div className="studio-skill-section"><h3><ShieldCheck size={16} />边界与限制</h3><ul>{selectedSkill.boundaries.map((boundary, index) => <li key={index}>{boundary}</li>)}</ul></div><div className="studio-evidence"><span><FileText size={15} />原始案例证据</span><p>{selectedSkill.evidence}</p><small>来源：{selectedSkill.source}</small></div>{(selectedSkill.reviewer || selectedSkill.reviewNote) && <div className="studio-skill-section"><h3>审核记录</h3><p>审核人：{selectedSkill.reviewer ?? '未记录'}</p><p>审核意见：{selectedSkill.reviewNote ?? '未填写'}</p></div>}{canReviewSkills && selectedSkill.status === 'candidate' && <div className="studio-review-box"><label>你的审核意见<textarea rows={3} maxLength={3000} value={reviewNote} onChange={event => setReviewNote(event.target.value)} placeholder="证据是否充分？哪些条件和边界需要保留？" /></label><div><button className="studio-btn studio-btn-secondary" disabled={busy || !reviewNote.trim()} onClick={() => reviewSkill('reject')}><RotateCcw size={15} />退回补充</button><button className="studio-btn studio-btn-primary" disabled={busy || !reviewNote.trim()} onClick={() => reviewSkill('publish')}><BusyIcon busy={busy}><Check size={15} /></BusyIcon>审核并发布</button></div><small>发布将同步加入团队生效知识。</small></div>}</> : <Empty icon={<Sparkles size={32} />} title="可复用的经验，需要完整的上下文" detail="选择 Skill，查看场景、步骤、证据与审核记录。" />}</article>
      </div>
    </>}
  </section>;
}

export { BuilderStudio as StudioView } from './BuilderStudio';

export { RunsView } from './RunHistoryView';

export function SettingsView({ state,onConnectionChanged }: ViewProps & {onConnectionChanged?:()=>Promise<void>}) {
  return <section className="studio-view studio-settings-view">
    <PageHeading eyebrow="YOUR WORKSPACE" title="服务连接" description="维护团队使用的大模型、语音和企业数据服务。">
      <a className="studio-btn studio-btn-secondary" href="#api-configuration"><Code2 size={16}/>API 配置</a>
    </PageHeading>
    <ApiConnectionSettings onSaved={onConnectionChanged}/>
    <SpeechRecognitionSettings/>
    <CompanyConnectionSettings provider="jinghai"/><CompanyConnectionSettings/><EmbeddingSettings/>
    <section className="studio-settings-card">
      <div className="studio-settings-card-title"><span className="studio-icon-clay"><Database size={23}/></span><div><h2>数据与执行</h2><p>当前团队共用的服务与配置</p></div><ModeTag mode={state.model.connected?'live':'demo'} configured/></div>
      <div className="studio-setting-line"><span>当前模型</span><strong>{state.model.connected?modelDisplayName(state.model.name):'未配置大模型 API'}</strong></div>
      <div className="studio-setting-line"><span>数据版本</span><strong>{state.revision}</strong></div>
      <div className="studio-setting-line"><span>持久化范围</span><strong>商机、知识、Skill、工作流、带练与运行记录</strong></div>
      <details className="studio-setting-description"><summary>数据与集成说明</summary><p>初始客户与案例为预置示例数据。当前工作空间独立保存，企业 SSO、组织架构与 CRM 尚未接入。配置的模型用于专家任务、工作流和客户带练；练习评分根据对话记录生成。</p></details>
    </section>
  </section>;
}
