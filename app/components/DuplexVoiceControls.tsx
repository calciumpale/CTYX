'use client';

import { Headphones, Info, Loader2, Mic, Phone, PhoneOff, Square, Volume2 } from 'lucide-react';
import type { useDuplexVoice } from '../lib/use-duplex-voice';

type Props={voice:ReturnType<typeof useDuplexVoice>;configured:boolean|null;configurationError:string;customer?:string;active:boolean;pending:number;onConnect:()=>void;onUseBrowser:()=>void};
export function DuplexVoiceControls({voice,configured,configurationError,customer,active,pending,onConnect,onUseBrowser}:Props){
  const connected=voice.phase==='connected';const connecting=voice.phase==='connecting';
  const title=connected?(voice.speaking?'客户正在说 · 你可以随时插话':pending?'你的回应正在自动保存':'正在听，请自然说话'):connecting?'正在连接语音服务':configured?'开启一场自然的对话':'尚未配置语音服务';
  const detail=connected?'麦克风持续开启。说完自动发送，开口即可打断客户。':connecting?'连接成功后才会开始传送音频。':configured?'连接后，说话、倾听和插话都在同一个对话中完成。':'完成语音服务配置后，可使用全双工带练。';
  return <section className="training-voice-panel training-duplex-panel" aria-label="全双工语音带练">
    <div className="training-voice-topline"><span className={`training-voice-browser${connected?' training-duplex-connected':''}`}><span/>{connected?'双工连接已建立':connecting?'连接中':configured===null?'检查服务配置':configured?'服务已配置 · 待连接':'服务未连接'}</span></div>
    <div className="training-voice-stage"><div className={`training-voice-orb${connected?' training-voice-orb-active training-voice-orb-listening':''}`} aria-hidden="true"><span/><div>{connecting?<Loader2 className="studio-spin" size={26}/>:voice.speaking?<Volume2 size={26}/>:connected?<Mic size={26}/>:<Headphones size={26}/>}</div></div><div className="training-voice-status" role="status" aria-live="polite"><span>{customer?customer:'持续倾听，及时回应'}</span><h2>{title}</h2><p>{detail}</p></div><div className="training-voice-actions">{connected||connecting?<button type="button" className="studio-btn studio-btn-secondary" onClick={voice.disconnect}><PhoneOff size={15}/>{connecting?'取消连接':'结束语音'}</button>:<button type="button" className="studio-btn training-voice-mic" disabled={!active||!configured} onClick={onConnect}><Phone size={15}/>{active?'连接并开始对话':'先开始一场带练'}</button>}</div></div>
    <div className="training-duplex-signals"><span className={voice.listening?'training-signal-live':''}><Mic size={12}/>{voice.listening?'麦克风持续收音':'麦克风未开启'}</span><span className={voice.speaking?'training-signal-live':''}><Volume2 size={12}/>{voice.speaking?'客户语音输出中':'客户语音待命'}</span><span>说完自动提交</span></div>
    {voice.partial&&<div className="training-voice-transcript" role="status"><span><span/>实时识别 · 说完自动发送</span><p>{voice.partial}</p></div>}
    <div className="training-voice-preferences"><label className="training-voice-select"><span>客户音色</span><select aria-label="网关客户音色" disabled={!connected||!voice.voices.length} value={voice.selectedVoice} onChange={event=>voice.setVoice(event.target.value)}>{!voice.voices.length?<option value="">连接后加载已部署的音色</option>:voice.voices.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label><span className="training-duplex-voice-detail">{voice.voices.find(item=>item.id===voice.selectedVoice)?.description||'连接后可选择语音服务提供的音色'}</span><button type="button" className="studio-btn studio-btn-ghost training-voice-stop" disabled={!voice.speaking&&!voice.pendingPlayback} onClick={voice.interrupt}><Square size={12}/>停止客户播报</button></div>
    {(voice.error||configurationError)&&<div className="training-voice-error" role="alert"><Info size={16}/><div><p>{voice.error||configurationError}</p></div></div>}
    {!connected&&<p className="training-voice-capability">可先使用浏览器语音，识别后同样自动发送。<button type="button" onClick={onUseBrowser}>切换兼容模式</button></p>}
    <p className="training-voice-privacy">语音连接期间，音频发送至已配置的语音服务处理；工作台保存文字对话，不保存原始录音。切换页面或关闭语音会停止收音。</p>
  </section>;
}
