'use client';

import { Headphones, Info, Loader2, Mic, MicOff, Square, Volume2, X } from 'lucide-react';
import type { useTrainingVoice } from '../lib/use-training-voice';

type TrainingVoiceControlsProps = {
  voice: ReturnType<typeof useTrainingVoice>;
  customer?: string;
  hasSession: boolean;
  active: boolean;
  busy: boolean;
  autoSpeak: boolean;
  onAutoSpeakChange: (enabled: boolean) => void;
  onStartListening: () => void;
  onCancelListening: () => void;
  onUseText: () => void;
};

export function TrainingBrowserVoiceSelect({ voice, disabled = false }: { voice: TrainingVoiceControlsProps['voice']; disabled?: boolean }) {
  const chineseVoices = voice.voices.filter(item => /^(zh|cmn)(-|_|$)/i.test(item.lang));
  const selectedVoice = chineseVoices.some(item => item.id === voice.selectedVoice) ? voice.selectedVoice : '';
  return <label className="training-voice-select"><span>客户音色</span><select aria-label="客户中文音色" disabled={disabled || !voice.ready || !voice.outputSupported} value={selectedVoice} onChange={event => voice.setVoice(event.target.value)}><option value="">浏览器默认中文音色</option>{chineseVoices.map(item => <option key={item.id} value={item.id}>{item.name} · {item.lang}{item.local ? ' · 本机' : ''}</option>)}</select></label>;
}

export function TrainingVoiceControls({ voice, customer, hasSession, active, busy, autoSpeak, onAutoSpeakChange, onStartListening, onCancelListening, onUseText }: TrainingVoiceControlsProps) {
  const capturing = voice.phase === 'requesting' || voice.phase === 'listening' || voice.phase === 'stopping';
  const playing = voice.phase === 'preparing-speech' || voice.phase === 'speaking';
  const status = !voice.ready
    ? { title: '正在检查语音能力', detail: '稍候即可查看此浏览器支持的语音功能。' }
    : busy
      ? { title: '客户正在组织回应', detail: '这一轮文字对话准备好后，客户将继续与你交流。' }
      : voice.phase === 'requesting'
        ? { title: '正在请求麦克风权限', detail: '请在浏览器弹出的提示中选择允许，也可以取消识别。' }
        : voice.phase === 'listening'
          ? { title: '正在识别你的回应', detail: '自然说话，停顿后自动发送。也可点「结束本句」立即提交。' }
          : voice.phase === 'stopping'
            ? { title: '正在整理识别结果', detail: '请稍等，识别完成后将直接进入对话。' }
            : voice.phase === 'preparing-speech'
              ? { title: '正在准备客户语音', detail: '你也可以直接阅读对话，或开始说话来回应客户。' }
              : voice.phase === 'speaking'
                ? { title: '客户正在播报', detail: '先听听客户的顾虑。点击「开始说话」可以打断播报。' }
                : !hasSession
                  ? { title: '准备好，再开口', detail: '选一个场景开始陪练，客户说完就轮到你回应。' }
                  : !active
                    ? { title: '回听这一次练习', detail: '点击每条客户对话下的播放按钮，重新听听当时的沟通。' }
                    : !voice.inputSupported
                      ? { title: '用文字回应，也能听见客户', detail: '此浏览器不支持语音识别。你仍可输入文字，继续这次陪练。' }
                      : { title: '轮到你说', detail: '说出你的回应，识别完成后自动发送给客户。' };
  const StatusIcon = voice.phase === 'speaking' || voice.phase === 'preparing-speech' ? Volume2 : capturing ? Mic : Headphones;
  const animated = voice.phase !== 'idle' || busy;

  return <section className="training-voice-panel" aria-label="语音陪练控制">
    <div className="training-voice-topline"><span className="training-voice-browser"><span />兼容模式 · 轮流对话</span></div>
    <div className="training-voice-stage">
      <div className={`training-voice-orb${animated ? ' training-voice-orb-active' : ''}${capturing ? ' training-voice-orb-listening' : ''}`} aria-hidden="true"><span /><div>{busy || voice.phase === 'requesting' || voice.phase === 'stopping' ? <Loader2 size={25} className="studio-spin" /> : <StatusIcon size={26} />}</div></div>
      <div className="training-voice-status" role="status" aria-live="polite" aria-atomic="true"><span>{customer ? customer : '把练习，变成一次自然的交谈'}</span><h2>{status.title}</h2><p>{status.detail}</p></div>
      <div className="training-voice-actions">
        {capturing ? <><button type="button" className="studio-btn training-voice-mic" disabled={voice.phase !== 'listening'} onClick={voice.stopListening}>{voice.phase === 'listening' ? <Square size={14} /> : <Loader2 size={15} className="studio-spin" />}{voice.phase === 'listening' ? '结束本句' : voice.phase === 'requesting' ? '等待授权…' : '正在识别…'}</button><button type="button" className="studio-btn studio-btn-ghost" onClick={onCancelListening}><X size={14} />取消识别</button></> : active && <button type="button" className="studio-btn training-voice-mic" disabled={!voice.ready || !voice.inputSupported || busy} onClick={onStartListening}>{voice.ready && !voice.inputSupported ? <MicOff size={16} /> : <Mic size={16} />}{voice.ready && !voice.inputSupported ? '语音识别不可用' : '开始说话'}</button>}
      </div>
    </div>
    {(capturing || voice.interimTranscript) && <div className="training-voice-transcript" role="status" aria-live="polite"><span><span />实时识别 · 完成后自动发送</span><p>{voice.interimTranscript || (voice.phase === 'requesting' ? '等待麦克风权限…' : voice.phase === 'stopping' ? '正在确认最后一句…' : '正在听，请开始说话…')}</p></div>}
    <div className="training-voice-preferences">
      <TrainingBrowserVoiceSelect voice={voice} />
      <label className="training-voice-rate"><span>语速 <output>{voice.rate.toFixed(2)}×</output></span><input type="range" aria-label="客户播报语速" aria-valuetext={`${voice.rate.toFixed(2)} 倍速`} min="0.75" max="1.25" step="0.05" value={voice.rate} disabled={!voice.ready || !voice.outputSupported} onChange={event => voice.setRate(Number(event.target.value))} /></label>
      <label className="training-voice-auto"><input type="checkbox" checked={autoSpeak} disabled={!voice.ready || !voice.outputSupported} onChange={event => onAutoSpeakChange(event.target.checked)} /><span>客户自动播报</span></label>
      <button type="button" className="studio-btn studio-btn-ghost training-voice-stop" disabled={!playing} onClick={voice.stopSpeaking}><Square size={12} />停止播报</button>
    </div>
    {voice.error && <div className="training-voice-error" role="alert"><Info size={16} /><div><p>{voice.error}</p><button type="button" onClick={onUseText}>改用文字陪练</button>{voice.outputSupported && <span>也可通过对话下方按钮手动播放。</span>}</div><button type="button" className="studio-icon-button" onClick={voice.clearError} aria-label="关闭语音提示"><X size={15} /></button></div>}
    {voice.ready && (!voice.inputSupported || !voice.outputSupported) && <p className="training-voice-capability"><Info size={14} />{!voice.inputSupported && !voice.outputSupported ? '此浏览器暂不支持语音识别和语音播放，可切换到文字陪练继续。' : !voice.inputSupported ? '语音识别不可用；客户语音仍可播放，你可以输入文字回应。' : '此浏览器暂不支持客户语音播放；语音识别和文字回应仍可使用。'}<button type="button" onClick={onUseText}>切换文字陪练</button></p>}
    <p className="training-voice-privacy">语音识别由浏览器语音服务完成，可能联网。本平台仅保留文字对话，不保存原始音频。</p>
  </section>;
}
