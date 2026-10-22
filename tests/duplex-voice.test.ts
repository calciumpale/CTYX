import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const implementation = await import('../app/lib/duplex-voice.ts').catch(() => null);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function tick() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

function setup(settings: { allowInsecureLoopback?: boolean } = {}) {
  assert.ok(implementation, 'A real duplex controller must be available.');
  const events: string[] = [];
  const timers = new Map<number, () => void>();
  const sent: (string | ArrayBuffer)[] = [];
  const played: ArrayBuffer[] = [];
  const finals: { id: string; text: string }[] = [];
  const capture = deferred<void>();
  let onFrame: (frame: ArrayBuffer) => void = () => {};
  let onDrain: () => void = () => {};
  let bufferedSeconds = 0;
  let timerId = 0;
  let closeCount = 0;
  let cancelCount = 0;
  const socket = {
    readyState: 0, bufferedAmount: 0, binaryType: '',
    onopen: null as (() => void) | null,
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onerror: null as (() => void) | null,
    onclose: null as (() => void) | null,
    send(data: string | ArrayBuffer) { sent.push(data); },
    close() { this.readyState = 3; closeCount++; },
  };
  const audio = {
    resume: async () => {},
    startInput: (frame: (pcm: ArrayBuffer) => void) => { onFrame = frame; return capture.promise; },
    pendingOutputSeconds: () => bufferedSeconds,
    enqueueOutput: (pcm: ArrayBuffer, _sampleRate: number, drain: () => void) => {
      played.push(pcm); bufferedSeconds += pcm.byteLength / 48_000; onDrain = drain;
    },
    cancelOutput: () => { cancelCount++; bufferedSeconds = 0; },
    close: () => { closeCount++; },
  };
  const config = {
    url: 'wss://voice.example.test/ws', token: 'session-token',
    voices: [], defaultVoice: '', outputSampleRate: 24_000,
  };
  const ready = {
    type: 'session.ready', sampleRate: 24_000,
    voices: [{ id: 'zh-main', name: '中文女声', lang: 'zh-CN' }], defaultVoice: 'zh-main',
  };
  let fetchSession: (sessionId: string, signal: AbortSignal) => Promise<unknown> = async () => config;
  const controller = implementation.createDuplexVoiceController({
    environment: {
      allowInsecureLoopback: settings.allowInsecureLoopback,
      prepareAudioContext: () => { events.push('prepare'); return audio; },
      fetchSession: (sessionId, signal) => { events.push('fetch'); return fetchSession(sessionId, signal); },
      createSocket: () => socket,
      setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; },
      clearTimeout: handle => { timers.delete(handle as number); },
    },
    onFinal: final => finals.push(final),
  });
  const message = (data: unknown) => socket.onmessage?.({ data: typeof data === 'object' && !(data instanceof ArrayBuffer) ? JSON.stringify(data) : data });
  async function connected() {
    const connecting = controller.connect('practice-1');
    await tick(); socket.readyState = 1; socket.onopen?.();
    capture.resolve(); message(ready);
    await connecting;
  }
  return {
    controller, socket, audio, config, ready, sent, played, finals, timers, events, capture, message, connected,
    frame: (pcm: ArrayBuffer) => onFrame(pcm), drain: () => { bufferedSeconds = 0; onDrain(); },
    closes: () => closeCount, cancels: () => cancelCount,
    setFetch: (fetch: typeof fetchSession) => { fetchSession = fetch; },
    expire: () => { const callback = timers.values().next().value; assert.ok(callback); callback(); },
  };
}

test('prepares audio during the click and reports connected only after ready plus live capture', async () => {
  const h = setup();
  const promise = h.controller.connect('practice-1');
  assert.deepEqual(h.events, ['prepare']);
  assert.equal(h.controller.getSnapshot().phase, 'connecting');
  await tick(); h.socket.readyState = 1; h.socket.onopen?.();
  assert.deepEqual(JSON.parse(h.sent[0] as string), { type: 'session.start', token: 'session-token' });
  assert.deepEqual(h.controller.getSnapshot().voices, []);
  h.message(h.ready);
  assert.equal(h.controller.getSnapshot().phase, 'connecting');
  h.capture.resolve(); await promise;
  assert.equal(h.controller.getSnapshot().phase, 'connected');
  assert.equal(h.controller.getSnapshot().listening, true);
  assert.equal(h.controller.getSnapshot().selectedVoice, 'zh-main');
  h.controller.dispose();
});

test('barge in flushes output and rejects late audio while the microphone continuously streams', async () => {
  const h = setup(); await h.connected();
  h.controller.speak('客户回答', 'reply-1');
  h.message({ type: 'output.started', id: 'reply-1' });
  h.message(new ArrayBuffer(960));
  assert.equal(h.controller.getSnapshot().speaking, true);
  const pcm = new ArrayBuffer(640); h.frame(pcm);
  assert.equal(h.sent.at(-1), pcm);
  h.message({ type: 'input.speech.started' });
  assert.equal(h.controller.getSnapshot().speaking, false);
  assert.equal(h.controller.getSnapshot().listening, true);
  assert.deepEqual(JSON.parse(h.sent.at(-1) as string), { type: 'output.cancel' });
  h.message(new ArrayBuffer(960));
  h.message({ type: 'output.started', id: 'reply-1' });
  h.message(new ArrayBuffer(960));
  assert.equal(h.played.length, 1);
  h.message({ type: 'input.final', id: 'barge-turn', text: '我补充一句' });
  h.controller.speak('新回答', 'reply-2');
  h.message({ type: 'output.started', id: 'reply-1' });
  h.message(new ArrayBuffer(960));
  assert.equal(h.played.length, 1);
  h.message({ type: 'output.started', id: 'reply-2' });
  h.message(new ArrayBuffer(960));
  assert.equal(h.played.length, 2);
  h.frame(pcm); assert.equal(h.sent.at(-1), pcm);
  h.controller.dispose();
});

test('final transcripts are delivered automatically once per id across reconnects', async () => {
  const h = setup(); await h.connected();
  h.message({ type: 'input.partial', text: '我正在说' });
  assert.equal(h.controller.getSnapshot().partial, '我正在说');
  h.message({ type: 'input.final', id: 'turn-1', text: '  完整话语  ' });
  h.message({ type: 'input.final', id: 'turn-1', text: '完整话语' });
  assert.deepEqual(h.finals, [{ id: 'turn-1', text: '完整话语' }]);
  assert.equal(h.controller.getSnapshot().partial, '');
  h.controller.disconnect(); await h.connected();
  h.message({ type: 'input.final', id: 'turn-1', text: '完整话语' });
  assert.equal(h.finals.length, 1);
  h.controller.dispose();
});

test('server completion waits for audible output to drain', async () => {
  const h = setup(); await h.connected();
  h.controller.speak('你好', 'r'); h.message({ type: 'output.started', id: 'r' });
  h.message(new ArrayBuffer(960)); h.message({ type: 'output.finished', id: 'r' });
  assert.equal(h.controller.getSnapshot().speaking, true);
  h.drain();
  assert.equal(h.controller.getSnapshot().speaking, false);
  assert.equal(h.controller.getSnapshot().listening, true);
  h.controller.dispose();
});

test('disconnect releases resources and ignores saved callbacks from the old connection', async () => {
  const h = setup(); await h.connected();
  const oldMessage = h.socket.onmessage!; const oldError = h.socket.onerror!;
  h.controller.speak('你好', 'old'); h.controller.disconnect();
  assert.equal(h.closes(), 2); assert.equal(h.timers.size, 0);
  oldMessage({ data: JSON.stringify({ type: 'input.final', id: 'late', text: '不可提交' }) });
  oldError(); h.frame(new ArrayBuffer(640));
  assert.equal(h.finals.length, 0);
  assert.equal(h.controller.getSnapshot().phase, 'idle');
  assert.equal(h.controller.getSnapshot().listening, false);
  assert.equal(h.socket.onmessage, null);
});

test('permission and handshake timeout visibly fail instead of showing a false connection', async () => {
  const h = setup(); const connecting = h.controller.connect('practice-1');
  await tick(); h.socket.readyState = 1; h.socket.onopen?.();
  h.message(h.ready);
  h.expire(); await connecting;
  assert.equal(h.controller.getSnapshot().phase, 'error');
  assert.match(h.controller.getSnapshot().error ?? '', /超时/);
  assert.equal(h.controller.getSnapshot().listening, false);
  assert.equal(h.timers.size, 0);
  h.capture.resolve(); await tick();
  assert.equal(h.controller.getSnapshot().phase, 'error');
  assert.equal(h.closes(), 2);
});

test('stopping while fetching aborts credentials and prevents a late socket from opening', async () => {
  const h = setup(); const fetch = deferred<unknown>(); let signal!: AbortSignal;
  h.setFetch(async (_id, value) => { signal = value; return fetch.promise; });
  const connecting = h.controller.connect('practice-1'); await tick();
  h.controller.disconnect(); assert.equal(signal.aborted, true);
  fetch.resolve(h.config); await connecting; await tick();
  assert.equal(h.socket.onopen, null);
  assert.equal(h.controller.getSnapshot().phase, 'idle');
  assert.equal(h.closes(), 1);
});

test('upstream error and websocket backpressure terminate capture with an actionable error', async () => {
  const h = setup(); await h.connected();
  h.socket.bufferedAmount = 1_000_000; h.frame(new ArrayBuffer(640));
  assert.equal(h.controller.getSnapshot().phase, 'error');
  assert.match(h.controller.getSnapshot().error ?? '', /积压|网络/);
  assert.equal(h.controller.getSnapshot().listening, false);
  assert.equal(h.closes(), 2);
  const other = setup(); await other.connected();
  other.message({ type: 'error', message: '识别服务不可用' });
  assert.equal(other.controller.getSnapshot().phase, 'error');
  assert.match(other.controller.getSnapshot().error ?? '', /识别服务不可用/);
  assert.deepEqual(other.controller.getSnapshot().voices, []);
});

test('bounds queued PCM and preserves service voice and rate in output requests', async () => {
  const h = setup(); await h.connected();
  h.controller.setRate(1.25); h.controller.setVoice('zh-main');
  h.controller.speak('（演示客户）你好', 'r');
  assert.deepEqual(JSON.parse(h.sent.at(-1) as string), { type: 'output.speak', id: 'r', text: '你好', voice: 'zh-main', rate: 1.25 });
  h.message({ type: 'output.started', id: 'r' });
  h.message(new ArrayBuffer(48_000 * 13));
  assert.equal(h.controller.getSnapshot().phase, 'error');
  assert.match(h.controller.getSnapshot().error ?? '', /缓冲|积压/);
  assert.equal(h.played.length, 0);
});

test('rejects an insecure gateway instead of sending session credentials', async () => {
  const h = setup(); h.setFetch(async () => ({ ...h.config, url: 'ws://voice.example.test/ws' }));
  await h.controller.connect('practice-1');
  assert.equal(h.controller.getSnapshot().phase, 'error');
  assert.equal(h.sent.length, 0); assert.equal(h.socket.onopen, null);
});

test('local HTTP development permits a loopback socket while refusing remote plaintext sockets', async () => {
  const h = setup({ allowInsecureLoopback: true });
  h.setFetch(async () => ({ ...h.config, url: 'ws://127.0.0.1:8001/ws' }));
  const connecting = h.controller.connect('practice-1');
  await tick(); h.socket.readyState = 1; h.socket.onopen?.();
  h.capture.resolve(); h.message(h.ready); await connecting;
  assert.equal(h.controller.getSnapshot().phase, 'connected'); h.controller.dispose();
  const remote = setup({ allowInsecureLoopback: true });
  remote.setFetch(async () => ({ ...remote.config, url: 'ws://192.168.1.4:8001/ws' }));
  await remote.controller.connect('practice-1');
  assert.equal(remote.controller.getSnapshot().phase, 'error');
  assert.equal(remote.sent.length, 0);
});

test('a gateway without a usable authoritative voice catalog never becomes connected', async () => {
  const h = setup(); const connecting = h.controller.connect('practice-1');
  await tick(); h.socket.readyState = 1; h.socket.onopen?.(); h.capture.resolve();
  h.message({ type: 'session.ready', sampleRate: 24_000, voices: [], defaultVoice: '' });
  await connecting;
  assert.equal(h.controller.getSnapshot().phase, 'error');
  assert.equal(h.controller.getSnapshot().listening, false);
  assert.deepEqual(h.controller.getSnapshot().voices, []);
});

test('AudioWorklet emits continuous mono little-endian PCM16 at 16 kHz across 48 kHz render quanta', async () => {
  const posted: ArrayBuffer[] = [];
  let Processor!: new (options: unknown) => {
    process(inputs: Float32Array[][]): boolean;
    port: { onmessage: (event: { data: unknown }) => void };
  };
  const source = await readFile(new URL('../public/audio-capture.worklet.js', import.meta.url), 'utf8');
  runInNewContext(source, {
    sampleRate: 48_000,
    AudioWorkletProcessor: class { port = { onmessage: null, postMessage: (pcm: ArrayBuffer) => posted.push(pcm) }; },
    registerProcessor: (_name: string, value: typeof Processor) => { Processor = value; },
  });
  const processor = new Processor({ processorOptions: { targetSampleRate: 16_000, frameSamples: 320 } });
  for (let i = 0; i < 15; i++) assert.equal(processor.process([[new Float32Array(128).fill(0.75), new Float32Array(128).fill(0.25)]]), true);
  assert.equal(posted.length, 2);
  assert.equal(posted[0].byteLength, 640);
  const bytes = new Uint8Array(posted[0]);
  assert.deepEqual(Array.from(bytes.subarray(0, 4)), [255, 63, 255, 63]);
  processor.port.onmessage({ data: { type: 'stop' } });
  assert.equal(processor.process([[new Float32Array(128).fill(1)]]), false);
  assert.equal(posted.length, 2);
});

function browserAudio(t: TestContext) {
  const permission = deferred<MediaStream>();
  const contexts: FakeContext[] = [];
  const captureOptions: unknown[] = [];
  const track = { onended: null, stopped: 0, stop() { this.stopped++; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  class FakeNode {
    gain = { value: 1 };
    connect() {}
    disconnect() {}
  }
  class FakeContext {
    state = 'running'; currentTime = 0; sampleRate: number;
    destination = {};
    onstatechange: (() => void) | null = null;
    audioWorklet = { addModule: async () => {} };
    constructor(options: { sampleRate: number }) { this.sampleRate = options.sampleRate; contexts.push(this); }
    resume() { return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createMediaStreamSource() { return new FakeNode(); }
    createGain() { return new FakeNode(); }
  }
  class FakeWorklet extends FakeNode {
    port = { onmessage: null, postMessage() {}, close() {} };
    onprocessorerror = null;
  }
  const replacements: Record<string, unknown> = {
    window: { isSecureContext: true, AudioContext: FakeContext, AudioWorkletNode: FakeWorklet },
    AudioContext: FakeContext,
    AudioWorkletNode: FakeWorklet,
    navigator: { mediaDevices: { getUserMedia: async (options: unknown) => { captureOptions.push(options); return permission.promise; } } },
  };
  for (const [key, value] of Object.entries(replacements)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  assert.ok(implementation);
  return { audio: implementation.createBrowserDuplexVoiceEnvironment().prepareAudioContext(), permission, stream, track, contexts, captureOptions };
}

test('a late microphone permission grant after Stop stops the newly acquired physical track', async t => {
  const h = browserAudio(t);
  const started = h.audio.startInput(() => assert.fail('Capture is already closed'), () => {});
  h.audio.close();
  assert.equal(h.contexts.length, 2);
  assert.notEqual(h.contexts[0], h.contexts[1]);
  assert.deepEqual(h.contexts.map(context => context.state), ['closed', 'closed']);
  h.permission.resolve(h.stream); await started;
  assert.equal(h.track.stopped, 1);
  assert.deepEqual(h.captureOptions, [{ audio: { channelCount: 1, sampleRate: 16_000, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }]);
});

test('a suspended capture context reports lost audio instead of claiming to listen forever', async t => {
  const h = browserAudio(t); const errors: string[] = [];
  h.permission.resolve(h.stream);
  await h.audio.startInput(() => {}, error => errors.push(error));
  h.contexts[0].state = 'suspended'; h.contexts[0].onstatechange?.();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /麦克风|暂停/);
  h.audio.close(); assert.equal(h.track.stopped, 1);
});

test('gateway session.error reports failure and stops both input and output', async () => {
  const h = setup(); await h.connected();
  h.message({ type: 'session.error', message: '流式识别模型加载失败' });
  assert.equal(h.controller.getSnapshot().phase, 'error');
  assert.match(h.controller.getSnapshot().error ?? '', /模型加载失败/);
  assert.equal(h.closes(), 2);
});

test('an older customer reply cannot start playback during the next spoken user turn', async () => {
  const h = setup(); await h.connected();
  h.message({ type: 'input.speech.started' });
  assert.equal(h.controller.getSnapshot().inputActive, true);
  const before = h.sent.length;
  h.controller.speak('上一轮迟到的客户回答', 'old-reply');
  assert.equal(h.sent.length, before);
  assert.equal(h.controller.getSnapshot().listening, true);
  h.message({ type: 'input.partial', text: '我接着说' });
  h.message({ type: 'input.final', id: 'next-turn', text: '我接着说' });
  assert.equal(h.controller.getSnapshot().inputActive, false);
  h.controller.speak('本轮客户回答', 'new-reply');
  assert.equal(JSON.parse(h.sent.at(-1) as string).id, 'new-reply');
  h.controller.disconnect();
  assert.equal(h.controller.getSnapshot().inputActive, false);
});
