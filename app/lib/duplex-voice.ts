export interface DuplexVoiceOption { id: string; name: string; lang: string; description?: string }
export interface DuplexVoiceFinal { id: string; text: string }
export interface DuplexVoiceSnapshot {
  phase: 'idle' | 'connecting' | 'connected' | 'error';
  listening: boolean;
  inputActive: boolean;
  speaking: boolean;
  pendingPlayback: boolean;
  partial: string;
  error: string | null;
  voices: DuplexVoiceOption[];
  selectedVoice: string;
  rate: number;
}

export const initialDuplexVoiceSnapshot: DuplexVoiceSnapshot = {
  phase: 'idle', listening: false, inputActive: false, speaking: false, pendingPlayback: false,
  partial: '', error: null, voices: [], selectedVoice: '', rate: 1,
};

export interface DuplexSocket {
  readyState: number;
  bufferedAmount: number;
  binaryType: string;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(data: string | ArrayBuffer): void;
  close(): void;
}

export interface DuplexAudio {
  resume(): Promise<void>;
  startInput(onFrame: (pcm: ArrayBuffer) => void, onError: (message: string) => void): Promise<void>;
  pendingOutputSeconds(): number;
  enqueueOutput(pcm: ArrayBuffer, sampleRate: number, onDrain: () => void): void;
  cancelOutput(): void;
  close(): void;
}

export interface DuplexVoiceEnvironment {
  allowInsecureLoopback?: boolean;
  // Must construct and resume AudioContexts synchronously inside the user's click.
  prepareAudioContext(): DuplexAudio;
  fetchSession(sessionId: string, signal: AbortSignal): Promise<unknown>;
  createSocket(url: string): DuplexSocket;
  setTimeout?: (callback: () => void, delay: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export type DuplexVoiceCatalog = { voices: DuplexVoiceOption[]; defaultVoice: string };
type VoiceConfiguration = DuplexVoiceCatalog & { url: string; token: string; outputSampleRate: number };

const CONNECT_TIMEOUT_MS = 15_000;
const OUTPUT_TIMEOUT_MS = 180_000;
const OUTPUT_START_TIMEOUT_MS = 20_000;
const MAX_SOCKET_BUFFER_BYTES = 128_000;
const MAX_OUTPUT_BUFFER_SECONDS = 12;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function validSampleRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 8_000 && value <= 48_000;
}
export function parseDuplexVoiceCatalog(value: unknown, allowEmpty = false): DuplexVoiceCatalog {
  if (!isRecord(value) || !Array.isArray(value.voices) || value.voices.length > 128 || (!allowEmpty && !value.voices.length)) {
    throw new Error('语音网关没有提供可用的音色。');
  }
  const ids = new Set<string>();
  const voices = value.voices.map(voice => {
    if (!isRecord(voice) || typeof voice.id !== 'string' || !voice.id.trim() || voice.id.length > 200 || ids.has(voice.id) ||
      typeof voice.name !== 'string' || !voice.name.trim() || voice.name.length > 200 ||
      typeof voice.lang !== 'string' || !voice.lang.trim() || voice.lang.length > 200 ||
      (voice.description !== undefined && (typeof voice.description !== 'string' || voice.description.length > 500))) {
      throw new Error('语音网关音色列表格式无效。');
    }
    ids.add(voice.id);
    return { id: voice.id, name: voice.name, lang: voice.lang, ...(typeof voice.description === 'string' ? { description: voice.description } : {}) };
  });
  if (typeof value.defaultVoice !== 'string' || (voices.length ? !voices.some(voice => voice.id === value.defaultVoice) : value.defaultVoice !== '')) {
    throw new Error('语音网关默认音色不可用。');
  }
  return { voices, defaultVoice: value.defaultVoice };
}
function loopback(hostname: string): boolean { return ['localhost', '127.0.0.1', '[::1]'].includes(hostname); }
function configuration(value: unknown, allowInsecureLoopback = false): VoiceConfiguration {
  if (!isRecord(value) || typeof value.url !== 'string' || typeof value.token !== 'string' || !value.token) {
    throw new Error('语音网关返回了无效的连接信息。');
  }
  const url = new URL(value.url);
  const localSocket = allowInsecureLoopback && url.protocol === 'ws:' && loopback(url.hostname);
  if ((url.protocol !== 'wss:' && !localSocket) || url.username || url.password || url.search || url.hash) {
    throw new Error('语音网关必须使用不含凭据或参数的 WSS 安全连接。');
  }
  if (!validSampleRate(value.outputSampleRate)) throw new Error('语音网关音频格式无效。');
  return { url: url.href, token: value.token, ...parseDuplexVoiceCatalog(value, true), outputSampleRate: value.outputSampleRate };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return '麦克风或声音权限被拒绝，请允许网站使用麦克风和播放声音后重试。';
    if (error.name === 'NotFoundError') return '未找到可用麦克风，请连接输入设备后重试。';
    if (error.name === 'NotReadableError') return '麦克风无法读取，请检查系统权限或设备是否被占用。';
    return error.message || '语音连接失败，请重试。';
  }
  return '语音连接失败，请检查网络和麦克风后重试。';
}

export function createDuplexVoiceController(options: {
  environment: DuplexVoiceEnvironment;
  onFinal: (final: DuplexVoiceFinal) => void;
}) {
  const env = options.environment;
  const schedule = env.setTimeout ?? ((callback: () => void, delay: number) => globalThis.setTimeout(callback, delay));
  const unschedule = env.clearTimeout ?? ((handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  const listeners = new Set<() => void>();
  let snapshot: DuplexVoiceSnapshot = { ...initialDuplexVoiceSnapshot };
  let disposed = false;
  let finalSession = '';
  const finalIds = new Set<string>();
  type Run = {
    audio: DuplexAudio; abort: AbortController; socket: DuplexSocket | null;
    closed: boolean; ready: boolean; sampleRate: number; preferredVoice: string;
    connectTimer: unknown; outputTimer: unknown;
    requestedId: string | null; currentId: string | null; finished: boolean;
    readyPromise: Promise<void>; markReady: () => void;
    done: Promise<void>; finish: () => void;
  };
  let active: Run | null = null;

  function update(change: Partial<DuplexVoiceSnapshot>) {
    if (disposed) return;
    snapshot = { ...snapshot, ...change };
    for (const listener of listeners) listener();
  }
  function current(run: Run) { return !disposed && active === run && !run.closed; }
  function clearTimer(run: Run, key: 'connectTimer' | 'outputTimer') {
    if (run[key] !== null) unschedule(run[key]);
    run[key] = null;
  }
  function release(run: Run) {
    if (run.closed) return;
    // Invalidate before close/stop: native callbacks can run synchronously.
    if (active === run) active = null;
    run.closed = true;
    clearTimer(run, 'connectTimer'); clearTimer(run, 'outputTimer');
    run.abort.abort();
    if (run.socket) {
      run.socket.onopen = null; run.socket.onmessage = null;
      run.socket.onerror = null; run.socket.onclose = null;
      try { run.socket.close(); } catch { /* Cleanup still releases audio. */ }
    }
    try { run.audio.close(); } catch { /* The audio context may already be closed. */ }
    run.finish();
  }
  function fail(run: Run, message: string) {
    if (!current(run)) return;
    release(run);
    update({ phase: 'error', listening: false, inputActive: false, speaking: false, pendingPlayback: false, partial: '', voices: [], selectedVoice: '', error: message });
  }
  function send(run: Run, data: string | ArrayBuffer): boolean {
    if (!current(run)) return false;
    if (run.socket?.readyState !== 1) {
      fail(run, '语音网关连接已断开，请重新开启语音。'); return false;
    }
    if (run.socket.bufferedAmount + (typeof data === 'string' ? data.length * 2 : data.byteLength) > MAX_SOCKET_BUFFER_BYTES) {
      fail(run, '语音网络发送积压，已停止麦克风，请检查网络后重新连接。'); return false;
    }
    try { run.socket.send(data); return true; }
    catch { fail(run, '语音数据发送失败，请检查网络后重新连接。'); return false; }
  }
  function resetOutput(run: Run) {
    run.requestedId = null; run.currentId = null; run.finished = false;
    clearTimer(run, 'outputTimer');
    run.audio.cancelOutput();
    update({ speaking: false, pendingPlayback: false });
  }
  function interrupt() {
    const run = active;
    if (!run || !current(run)) return;
    const hadOutput = Boolean(run.requestedId || run.currentId);
    resetOutput(run);
    if (hadOutput) send(run, JSON.stringify({ type: 'output.cancel' }));
  }
  function drained(run: Run, id: string) {
    if (!current(run) || run.currentId !== id || !run.finished || run.audio.pendingOutputSeconds() > 0) return;
    clearTimer(run, 'outputTimer');
    run.currentId = null; run.requestedId = null;
    update({ speaking: false, pendingPlayback: false });
  }
  function receive(run: Run, data: unknown) {
    if (!current(run)) return;
    if (data instanceof ArrayBuffer) {
      const id = run.currentId;
      if (!id || id !== run.requestedId || run.finished) return;
      if (!data.byteLength) return;
      if (data.byteLength % 2) { fail(run, '语音网关返回了无效的 PCM 音频。'); return; }
      if (run.audio.pendingOutputSeconds() + data.byteLength / (run.sampleRate * 2) > MAX_OUTPUT_BUFFER_SECONDS) {
        fail(run, '语音播放缓冲积压过多，已停止连接，请重新开启语音。'); return;
      }
      try { run.audio.enqueueOutput(data, run.sampleRate, () => drained(run, id)); }
      catch (error) { fail(run, `语音播放失败：${errorMessage(error)}`); }
      if (current(run)) update({ speaking: true, pendingPlayback: false });
      return;
    }
    if (typeof data !== 'string') { fail(run, '语音网关返回了无法读取的消息。'); return; }
    let message: unknown;
    try { message = JSON.parse(data); } catch { fail(run, '语音网关消息格式错误。'); return; }
    if (!isRecord(message) || typeof message.type !== 'string') { fail(run, '语音网关消息格式错误。'); return; }
    switch (message.type) {
      case 'session.ready':
        if (run.ready) return;
        if (!validSampleRate(message.sampleRate)) { fail(run, '语音网关音频采样率无效。'); return; }
        try {
          const catalog = parseDuplexVoiceCatalog(message);
          const preferredAvailable = catalog.voices.some(voice => voice.id === run.preferredVoice);
          update({
            voices: catalog.voices,
            selectedVoice: preferredAvailable ? run.preferredVoice : catalog.defaultVoice,
            error: run.preferredVoice && !preferredAvailable ? '所选音色已不可用，本次使用网关默认音色。' : null,
          });
        } catch (error) { fail(run, errorMessage(error)); return; }
        run.sampleRate = message.sampleRate; run.ready = true; run.markReady();
        break;
      case 'input.partial':
        if (snapshot.phase === 'connected' && typeof message.text === 'string') update({ partial: message.text, inputActive: snapshot.inputActive || Boolean(message.text) });
        break;
      case 'input.final': {
        if (snapshot.phase !== 'connected' || typeof message.id !== 'string' || !message.id || typeof message.text !== 'string') return;
        const text = message.text.trim();
        update({ partial: '', inputActive: false });
        if (!current(run) || !text || finalIds.has(message.id)) return;
        finalIds.add(message.id);
        try { options.onFinal({ id: message.id, text }); }
        catch { update({ error: '语音已识别，但自动提交失败，请检查会话后重试。' }); }
        break;
      }
      case 'input.speech.started':
        update({ inputActive: true });
        interrupt();
        break;
      case 'output.started':
        if (!run.ready || typeof message.id !== 'string' || message.id !== run.requestedId || run.currentId === message.id) return;
        run.currentId = message.id; run.finished = false;
        clearTimer(run, 'outputTimer');
        run.outputTimer = schedule(() => fail(run, '语音播放超时，已关闭连接，请重新开启语音。'), OUTPUT_TIMEOUT_MS);
        update({ speaking: false, pendingPlayback: true });
        break;
      case 'output.finished':
        if (message.id !== run.currentId || !run.currentId) return;
        run.finished = true; drained(run, run.currentId);
        break;
      case 'output.cancelled':
        if (message.id === run.currentId || message.id === run.requestedId) resetOutput(run);
        break;
      case 'error':
      case 'session.error':
        fail(run, typeof message.message === 'string' ? message.message : '语音网关服务失败，请重试。');
        break;
    }
  }

  function disconnect() {
    if (active) release(active);
    update({ phase: 'idle', listening: false, inputActive: false, speaking: false, pendingPlayback: false, partial: '', voices: [], selectedVoice: '', error: null });
  }
  async function connect(sessionId: string, preferredVoice = ''): Promise<void> {
    if (disposed) return;
    disconnect();
    if (!sessionId.trim()) { update({ phase: 'error', error: '请先选择一个训练会话。' }); return; }
    let audio: DuplexAudio;
    try {
      // No await may precede this call: browsers require a user activation for resume().
      audio = env.prepareAudioContext();
    } catch (error) { update({ phase: 'error', error: errorMessage(error) }); return; }
    if (finalSession !== sessionId) { finalSession = sessionId; finalIds.clear(); }
    let markReady!: () => void; let finish!: () => void;
    const run: Run = {
      audio, abort: new AbortController(), socket: null, closed: false, ready: false, sampleRate: 24_000, preferredVoice,
      connectTimer: null, outputTimer: null, requestedId: null, currentId: null, finished: false,
      readyPromise: new Promise<void>(resolve => { markReady = resolve; }), markReady: () => markReady(),
      done: new Promise<void>(resolve => { finish = resolve; }), finish: () => finish(),
    };
    active = run;
    update({ phase: 'connecting', voices: [], selectedVoice: '', error: null });
    run.connectTimer = schedule(() => fail(run, '语音连接或麦克风权限等待超时，请检查权限和网络后重试。'), CONNECT_TIMEOUT_MS);
    const initialize = async () => {
      await run.audio.resume();
      if (!current(run)) return;
      const config = configuration(await env.fetchSession(sessionId, run.abort.signal), env.allowInsecureLoopback);
      if (!current(run)) return;
      run.sampleRate = config.outputSampleRate;
      const socket = env.createSocket(config.url); run.socket = socket; socket.binaryType = 'arraybuffer';
      socket.onopen = () => { if (current(run)) send(run, JSON.stringify({ type: 'session.start', token: config.token })); };
      socket.onmessage = event => receive(run, event.data);
      socket.onerror = () => fail(run, '语音网关网络连接失败，请检查网关状态后重新连接。');
      socket.onclose = () => fail(run, '语音网关连接已关闭，请重新开启语音。');
      await Promise.all([
        run.readyPromise,
        run.audio.startInput(pcm => {
          if (current(run) && snapshot.phase === 'connected') send(run, pcm);
        }, message => fail(run, message)),
      ]);
      if (!current(run)) return;
      clearTimer(run, 'connectTimer');
      update({ phase: 'connected', listening: true });
    };
    // The completion race makes Stop immediate even if a permission prompt remains open.
    await Promise.race([initialize().catch(error => fail(run, errorMessage(error))), run.done]);
  }
  function speak(text: string, id: string) {
    const run = active;
    if (!run || snapshot.phase !== 'connected') { update({ error: '请先开启双工语音连接，再播放客户回复。' }); return; }
    if (snapshot.inputActive) { update({ error: '正在识别你的发言，请说完后再播放客户回复。' }); return; }
    const clean = text.replace(/^\s*[（(]\s*演示客户\s*[）)]\s*[:：]?\s*/, '').trim();
    if (!clean || !id.trim()) return;
    interrupt();
    if (!current(run)) return;
    run.requestedId = id;
    run.outputTimer = schedule(() => fail(run, '语音服务未及时开始播放，请检查服务后重新连接。'), OUTPUT_START_TIMEOUT_MS);
    update({ pendingPlayback: true, error: null });
    send(run, JSON.stringify({ type: 'output.speak', id, text: clean, voice: snapshot.selectedVoice, rate: snapshot.rate }));
  }
  function dispose() {
    if (disposed) return;
    disconnect(); disposed = true; listeners.clear(); finalIds.clear();
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    connect, disconnect, speak, interrupt, dispose,
    setVoice: (id: string) => { if (snapshot.voices.some(voice => voice.id === id)) update({ selectedVoice: id }); },
    setRate: (rate: number) => { if (Number.isFinite(rate)) update({ rate: Math.min(2, Math.max(0.5, rate)) }); },
    clearError: () => update({ error: null, ...(snapshot.phase === 'error' ? { phase: 'idle' as const } : {}) }),
  };
}

export function createBrowserDuplexVoiceEnvironment(): DuplexVoiceEnvironment {
  return {
    allowInsecureLoopback: typeof window !== 'undefined' && window.location?.protocol === 'http:' && loopback(window.location.hostname),
    prepareAudioContext: prepareBrowserAudio,
    fetchSession: async (sessionId, signal) => {
      const response = await fetch('/api/training-voice', {
        method: 'POST', credentials: 'same-origin', signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }),
      });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(isRecord(result) && typeof result.error === 'string' ? result.error : '无法连接语音服务，请检查网关配置或登录状态。');
      return result;
    },
    createSocket: url => new WebSocket(url) as unknown as DuplexSocket,
  };
}

function prepareBrowserAudio(): DuplexAudio {
  if (typeof window === 'undefined' || !window.isSecureContext) throw new Error('双工语音需要 HTTPS 安全页面，请使用安全地址打开工作台。');
  if (!window.AudioContext || !window.AudioWorkletNode || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('当前浏览器不支持 AudioWorklet 双工采集，请使用支持该能力的现代浏览器。');
  }
  const input = new AudioContext({ sampleRate: 16_000 });
  let output: AudioContext;
  try { output = new AudioContext({ sampleRate: 24_000 }); }
  catch (error) { void input.close().catch(() => {}); throw error; }
  if (!input.audioWorklet) {
    void input.close().catch(() => {}); void output.close().catch(() => {});
    throw new Error('当前浏览器不支持 AudioWorklet 双工采集，请更换支持该能力的浏览器。');
  }
  let closed = false;
  let stream: MediaStream | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let worklet: AudioWorkletNode | null = null;
  let silent: GainNode | null = null;
  let nextOutputTime = 0;
  const scheduled = new Set<AudioBufferSourceNode>();
  // Start resume synchronously while the activation from the user's click is live.
  const resumed = Promise.all([input.resume(), output.resume()]).then(() => {
    if (!closed && (input.state !== 'running' || output.state !== 'running')) {
      throw new Error('浏览器尚未允许声音播放，请再次点击开启语音并允许声音权限。');
    }
  });
  // A rejected resume must not become unhandled before connect reaches its first await.
  void resumed.catch(() => {});

  function cancelOutput() {
    for (const node of scheduled) {
      node.onended = null;
      try { node.stop(); } catch { /* Source may already have finished. */ }
      node.disconnect();
    }
    scheduled.clear(); nextOutputTime = 0;
  }
  function stopTracks() { stream?.getTracks().forEach(track => { track.onended = null; track.stop(); }); }
  return {
    resume: () => resumed,
    async startInput(onFrame, onError) {
      const acquired = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 16_000, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false,
      });
      if (closed) { acquired.getTracks().forEach(track => track.stop()); return; }
      stream = acquired;
      if (!stream.getAudioTracks().length) throw new Error('未获取到可用麦克风音轨，请检查输入设备后重试。');
      stream.getAudioTracks().forEach(track => { track.onended = () => { if (!closed) onError('麦克风已断开或权限被收回，请重新连接设备后开启语音。'); }; });
      await input.audioWorklet.addModule('/audio-capture.worklet.js');
      if (closed) return;
      source = input.createMediaStreamSource(stream);
      worklet = new AudioWorkletNode(input, 'pcm16-capture', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
        processorOptions: { targetSampleRate: 16_000, frameSamples: 320 },
      });
      worklet.port.onmessage = event => { if (!closed && event.data instanceof ArrayBuffer) onFrame(event.data); };
      worklet.onprocessorerror = () => { if (!closed) onError('麦克风音频处理失败，请重新开启语音。'); };
      silent = input.createGain(); silent.gain.value = 0;
      source.connect(worklet); worklet.connect(silent); silent.connect(input.destination);
      if (input.state !== 'running') throw new Error('麦克风音频上下文未运行，请再次点击开启语音。');
      if (output.state !== 'running') throw new Error('声音播放已暂停，请再次点击开启语音。');
      input.onstatechange = () => { if (!closed && input.state !== 'running') onError('麦克风采集被系统暂停，请重新点击开启语音。'); };
      output.onstatechange = () => { if (!closed && output.state !== 'running') onError('声音播放被系统暂停，请重新点击开启语音。'); };
    },
    pendingOutputSeconds: () => Math.max(0, nextOutputTime - output.currentTime),
    enqueueOutput(pcm, sampleRate, onDrain) {
      if (closed || output.state !== 'running') throw new Error('声音播放已暂停，请重新点击开启语音。');
      const values = new DataView(pcm);
      const buffer = output.createBuffer(1, pcm.byteLength / 2, sampleRate);
      const channel = buffer.getChannelData(0);
      for (let index = 0; index < channel.length; index++) channel[index] = values.getInt16(index * 2, true) / 32_768;
      const node = output.createBufferSource(); node.buffer = buffer; node.connect(output.destination);
      scheduled.add(node);
      const start = Math.max(output.currentTime, nextOutputTime);
      nextOutputTime = start + buffer.duration;
      node.onended = () => {
        scheduled.delete(node); node.disconnect();
        if (!scheduled.size) nextOutputTime = 0;
        if (!closed) onDrain();
      };
      node.start(start);
    },
    cancelOutput,
    close() {
      if (closed) return;
      closed = true;
      input.onstatechange = null; output.onstatechange = null;
      stopTracks(); cancelOutput();
      if (worklet) {
        worklet.port.onmessage = null; worklet.onprocessorerror = null;
        try { worklet.port.postMessage({ type: 'stop' }); worklet.port.close(); worklet.disconnect(); }
        catch { /* Closing the contexts below also releases disconnected processors. */ }
      }
      source?.disconnect(); silent?.disconnect();
      void input.close().catch(() => {}); void output.close().catch(() => {});
      stream = null; source = null; worklet = null; silent = null;
    },
  };
}
