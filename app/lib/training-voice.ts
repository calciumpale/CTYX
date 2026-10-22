export type VoicePhase = 'idle' | 'requesting' | 'listening' | 'stopping' | 'preparing-speech' | 'speaking';
export interface VoiceOption { id: string; name: string; lang: string; local: boolean }
export interface VoiceSnapshot {
  ready: boolean; inputSupported: boolean; outputSupported: boolean; phase: VoicePhase;
  interimTranscript: string; error: string | null; voices: VoiceOption[]; selectedVoice: string; rate: number;
}
export interface RecognitionResult {
  isFinal: boolean;
  readonly [index: number]: { transcript: string };
}
export interface RecognitionPort {
  lang: string; continuous: boolean; interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: { resultIndex: number; results: ArrayLike<RecognitionResult> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void; stop: () => void; abort: () => void;
}
export interface UtterancePort {
  text: string; lang: string; rate: number; voice: SpeechSynthesisVoice | null;
  onstart: (() => void) | null; onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
}
export interface VoiceEnvironment {
  createRecognition?: () => RecognitionPort;
  speech?: {
    getVoices: () => readonly SpeechSynthesisVoice[];
    createUtterance: (text: string) => UtterancePort;
    speak: (utterance: UtterancePort) => void;
    cancel: () => void;
    subscribeVoices: (listener: () => void) => () => void;
  };
  setTimeout?: (callback: () => void, delay: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}
export const initialVoiceSnapshot: VoiceSnapshot = {
  ready: false, inputSupported: false, outputSupported: false, phase: 'idle',
  interimTranscript: '', error: null, voices: [], selectedVoice: '', rate: 1,
};
export function createBrowserVoiceEnvironment(): VoiceEnvironment {
  if (typeof window === 'undefined') return {};
  const browser = window as Window & {
    SpeechRecognition?: new () => RecognitionPort;
    webkitSpeechRecognition?: new () => RecognitionPort;
    SpeechSynthesisUtterance?: new (text: string) => SpeechSynthesisUtterance;
  };
  const Recognition = browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
  const Utterance = browser.SpeechSynthesisUtterance;
  const synthesis = browser.speechSynthesis;
  return {
    createRecognition: Recognition ? () => new Recognition() : undefined,
    speech: synthesis && Utterance ? {
      getVoices: () => synthesis.getVoices(),
      createUtterance: text => new Utterance(text) as unknown as UtterancePort,
      speak: utterance => synthesis.speak(utterance as unknown as SpeechSynthesisUtterance),
      cancel: () => synthesis.cancel(),
      subscribeVoices: listener => {
        synthesis.addEventListener('voiceschanged', listener);
        return () => synthesis.removeEventListener('voiceschanged', listener);
      },
    } : undefined,
  };
}
export function createTrainingVoiceController(options: {
  environment: VoiceEnvironment; onTranscript: (text: string) => void;
}) {
  const environment = options.environment;
  const listeners = new Set<() => void>();
  const schedule = environment.setTimeout ?? ((callback: () => void, delay: number) => globalThis.setTimeout(callback, delay));
  const unschedule = environment.clearTimeout ?? ((handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  let disposed = false;
  let snapshot: VoiceSnapshot = {
    ...initialVoiceSnapshot,
    ready: true,
    inputSupported: Boolean(environment.createRecognition),
    outputSupported: Boolean(environment.speech),
  };
  type InputRun = { recognition: RecognitionPort; finals: Set<number>; timer: unknown; stopping: boolean };
  type OutputRun = { utterance: UtterancePort; timer: unknown };
  let input: InputRun | null = null;
  let output: OutputRun | null = null;
  let nativeVoices: readonly SpeechSynthesisVoice[] = [];
  let explicitVoice = false;

  function update(change: Partial<VoiceSnapshot>) {
    if (disposed) return;
    snapshot = { ...snapshot, ...change };
    for (const listener of listeners) listener();
  }
  function clearTimer(run: { timer: unknown }) {
    if (run.timer !== null) unschedule(run.timer);
    run.timer = null;
  }
  function releaseInput(run: InputRun, abort: boolean) {
    if (input === run) input = null;
    clearTimer(run);
    run.recognition.onstart = null;
    run.recognition.onresult = null;
    run.recognition.onerror = null;
    run.recognition.onend = null;
    if (abort) {
      try { run.recognition.abort(); } catch { /* Already closed by the browser. */ }
    }
  }
  function cancelListening() {
    if (disposed) return;
    if (input) {
      releaseInput(input, true);
      update({ phase: 'idle', interimTranscript: '' });
    }
  }
  function releaseOutput(run: OutputRun) {
    if (output === run) output = null;
    clearTimer(run);
    run.utterance.onstart = null;
    run.utterance.onend = null;
    run.utterance.onerror = null;
  }
  function cancelSpeechQueue() {
    try { environment.speech?.cancel(); } catch { /* A failed cancel must still invalidate old events. */ }
  }
  function stopSpeaking() {
    if (disposed) return;
    const wasSpeaking = Boolean(output);
    if (output) releaseOutput(output);
    cancelSpeechQueue();
    if (wasSpeaking) update({ phase: 'idle' });
  }
  function inputFailed(run: InputRun, message: string) {
    if (disposed || input !== run) return;
    releaseInput(run, true);
    update({ phase: 'idle', interimTranscript: '', error: message });
  }
  function recognitionError(code: string) {
    switch (code) {
      case 'not-allowed': return '麦克风权限被拒绝，请在浏览器网站设置中允许麦克风后重新点击录音。';
      case 'service-not-allowed': return '浏览器未允许语音识别服务，请检查网站权限或更换支持的浏览器。';
      case 'audio-capture': return '未找到可用麦克风，请连接麦克风并检查系统输入设备。';
      case 'no-speech': return '未检测到语音，请靠近麦克风后重新点击录音。';
      case 'network': return '语音识别网络连接失败，请检查网络后重新点击录音。';
      case 'language-not-supported': return '当前语音识别服务不支持中文，请更换浏览器后重试。';
      case 'aborted': return '语音识别已中断，请重新点击录音。';
      default: return '语音识别失败，请检查麦克风后重新点击录音。';
    }
  }
  function startListening() {
    if (disposed) return;
    // Both invalidations precede browser calls; cancel() can dispatch old events synchronously.
    cancelListening();
    stopSpeaking();
    if (!environment.createRecognition) {
      update({ phase: 'idle', error: '当前浏览器不支持语音识别，请使用文字输入或更换支持语音识别的浏览器。' });
      return;
    }
    let run: InputRun | null = null;
    try {
      const recognition = environment.createRecognition();
      run = { recognition, finals: new Set(), timer: null, stopping: false };
      const current = run;
      input = current;
      recognition.lang = 'zh-CN';
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onstart = () => {
        if (disposed || input !== current) return;
        if (!current.stopping) {
          clearTimer(current);
          update({ phase: 'listening' });
        }
      };
      recognition.onresult = event => {
        if (disposed || input !== current) return;
        const finals: string[] = [];
        const interim: string[] = [];
        for (let index = 0; index < event.results.length; index++) {
          const result = event.results[index];
          const text = result?.[0]?.transcript?.trim() ?? '';
          if (result.isFinal) {
            if (index >= event.resultIndex && !current.finals.has(index)) {
              current.finals.add(index);
              if (text) finals.push(text);
            }
          } else if (text) interim.push(text);
        }
        update({ interimTranscript: interim.join('') });
        for (const text of finals) {
          if (disposed || input !== current) break;
          options.onTranscript(text);
        }
      };
      recognition.onerror = event => inputFailed(current, recognitionError(event.error));
      recognition.onend = () => {
        if (disposed || input !== current) return;
        releaseInput(current, false);
        update({ phase: 'idle', interimTranscript: '' });
      };
      update({ phase: 'requesting', interimTranscript: '', error: null });
      current.timer = schedule(() => inputFailed(current, '麦克风启动超时，请检查权限后重新点击录音。'), 12_000);
      recognition.start();
    } catch (error) {
      const denied = error instanceof Error && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
      const missingDevice = error instanceof Error && error.name === 'NotFoundError';
      const message = denied ? recognitionError('not-allowed') : missingDevice ? recognitionError('audio-capture') : '无法启动麦克风，请检查设备是否被占用后重新点击录音。';
      if (run) inputFailed(run, message);
      else update({ phase: 'idle', interimTranscript: '', error: message });
    }
  }
  function stopListening() {
    if (disposed || !input || input.stopping) return;
    const run = input;
    run.stopping = true;
    clearTimer(run);
    update({ phase: 'stopping' });
    run.timer = schedule(() => inputFailed(run, '麦克风停止超时，已结束本次录音，请重新点击录音继续。'), 3_000);
    try { run.recognition.stop(); }
    catch { inputFailed(run, '无法结束语音识别，本次录音已取消，请重新点击录音。'); }
  }
  function outputFailed(run: OutputRun, message: string) {
    if (disposed || output !== run) return;
    releaseOutput(run);
    cancelSpeechQueue();
    update({ phase: 'idle', error: message });
  }
  function speak(text: string) {
    if (disposed) return;
    cancelListening();
    stopSpeaking();
    const cleanText = text.replace(/^\s*[（(]\s*演示客户\s*[）)]\s*[:：]?\s*/, '').trim();
    if (!cleanText) return;
    const speech = environment.speech;
    if (!speech) {
      update({ phase: 'idle', error: '当前浏览器不支持语音播放，请使用文字对话或更换浏览器。' });
      return;
    }
    let run: OutputRun | null = null;
    try {
      const utterance = speech.createUtterance(cleanText);
      run = { utterance, timer: null };
      const current = run;
      output = current;
      utterance.lang = 'zh-CN';
      utterance.rate = snapshot.rate;
      utterance.voice = nativeVoices.find(voice => voiceId(voice) === snapshot.selectedVoice) ?? null;
      utterance.onstart = () => {
        if (disposed || output !== current) return;
        clearTimer(current);
        update({ phase: 'speaking' });
        // Browser engines occasionally omit onend after audio-device interruption.
        current.timer = schedule(() => outputFailed(current, '语音播放超时，已停止播放，请点击重播。'), 180_000);
      };
      utterance.onend = () => {
        if (disposed || output !== current) return;
        releaseOutput(current);
        update({ phase: 'idle' });
      };
      utterance.onerror = () => outputFailed(current, '语音播放失败，请点击重播，或检查浏览器的声音权限。');
      update({ phase: 'preparing-speech', error: null });
      current.timer = schedule(() => outputFailed(current, '浏览器未启动语音播放，请点击重播并检查声音权限。'), 8_000);
      speech.speak(utterance);
    } catch {
      if (run) outputFailed(run, '无法启动语音播放，请点击重播或更换浏览器。');
      else update({ phase: 'idle', error: '无法启动语音播放，请点击重播或更换浏览器。' });
    }
  }
  function voiceId(voice: SpeechSynthesisVoice) { return voice.voiceURI || `${voice.lang}:${voice.name}`; }
  function refreshVoices() {
    if (disposed || !environment.speech) return;
    try {
      const preference = (voice: SpeechSynthesisVoice) => /^zh[-_]CN$/i.test(voice.lang) ? 0 : /^zh/i.test(voice.lang) ? 1 : voice.default ? 2 : 3;
      nativeVoices = [...environment.speech.getVoices()].sort((a, b) => preference(a) - preference(b));
      const voices = nativeVoices.map(voice => ({ id: voiceId(voice), name: voice.name, lang: voice.lang, local: voice.localService }));
      const selectedVoice = explicitVoice && (snapshot.selectedVoice === '' || voices.some(voice => voice.id === snapshot.selectedVoice))
        ? snapshot.selectedVoice : voices.find(voice => /^zh/i.test(voice.lang))?.id ?? '';
      update({ voices, selectedVoice });
    } catch { /* Some browsers initially expose no voices; voiceschanged will refresh them. */ }
  }
  let unsubscribeVoices: (() => void) | undefined;
  refreshVoices();
  try { unsubscribeVoices = environment.speech?.subscribeVoices(refreshVoices); }
  catch { /* Playback can still use the browser's default voice. */ }
  return {
    getSnapshot: (): VoiceSnapshot => snapshot,
    subscribe(listener: () => void) { if (!disposed) listeners.add(listener); return () => { listeners.delete(listener); }; },
    startListening, stopListening, cancelListening, speak, stopSpeaking,
    stopAll() { if (disposed) return; cancelListening(); stopSpeaking(); update({ phase: 'idle', interimTranscript: '' }); },
    setVoice(id: string) { if (id !== '' && !snapshot.voices.some(voice => voice.id === id)) return; explicitVoice = true; update({ selectedVoice: id }); },
    setRate(rate: number) { if (Number.isFinite(rate)) update({ rate: Math.min(1.25, Math.max(0.75, rate)) }); },
    clearError() { update({ error: null }); },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (input) releaseInput(input, true);
      if (output) releaseOutput(output);
      cancelSpeechQueue();
      unsubscribeVoices?.();
      listeners.clear();
    },
  };
}
