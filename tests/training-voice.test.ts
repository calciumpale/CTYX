import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createBrowserVoiceEnvironment, createTrainingVoiceController, type RecognitionPort, type RecognitionResult, type UtterancePort, type VoiceEnvironment } from '../app/lib/training-voice.ts';
import { useTrainingVoice } from '../app/lib/use-training-voice.ts';

// Only the browser/hardware boundary is doubled. All state, event validation,
// transcription, interruption and cleanup decisions run in the real controller.
function browser() {
  const recognitions: RecognitionPort[] = [];
  const utterances: UtterancePort[] = [];
  const events: string[] = [];
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const voiceListeners = new Set<() => void>();
  let timerId = 0;
  let voices: SpeechSynthesisVoice[] = [];
  let startError: Error | null = null;
  const environment: VoiceEnvironment = {
    createRecognition: () => {
      const recognition: RecognitionPort = {
        lang: '', continuous: false, interimResults: false,
        onstart: null, onresult: null, onerror: null, onend: null,
        start() { events.push('recognition:start'); if (startError) throw startError; },
        stop() { events.push('recognition:stop'); },
        abort() { events.push('recognition:abort'); },
      };
      recognitions.push(recognition);
      return recognition;
    },
    speech: {
      getVoices: () => voices,
      createUtterance: (text) => ({ text, lang: '', rate: 1, voice: null, onstart: null, onend: null, onerror: null }),
      speak(utterance) { utterances.push(utterance); events.push('speech:speak'); },
      cancel() { events.push('speech:cancel'); },
      subscribeVoices(listener) { voiceListeners.add(listener); return () => { voiceListeners.delete(listener); }; },
    },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(handle) { timers.delete(handle as number); },
  };
  return {
    environment, recognitions, utterances, events, timers, voiceListeners,
    failStart(error: Error) { startError = error; },
    setVoices(next: SpeechSynthesisVoice[]) { voices = next; for (const listener of voiceListeners) listener(); },
    elapse(delay: number) {
      for (const [id, timer] of [...timers]) if (timer.delay <= delay) { timers.delete(id); timer.callback(); }
    },
  };
}
function microphone(h: ReturnType<typeof browser>, index = 0) {
  const recognition = h.recognitions[index];
  assert.ok(recognition, 'controller must open a recognition session');
  assert.equal(typeof recognition.onresult, 'function', 'controller must process recognition events');
  return recognition;
}
function playback(h: ReturnType<typeof browser>, index = 0) {
  const utterance = h.utterances[index];
  assert.ok(utterance, 'controller must queue the customer speech');
  assert.equal(typeof utterance.onstart, 'function', 'controller must await the speech start event');
  return utterance;
}
function result(text: string, isFinal: boolean): RecognitionResult { return { isFinal, 0: { transcript: text } }; }
function setup() {
  const hardware = browser();
  const transcripts: string[] = [];
  const controller = createTrainingVoiceController({ environment: hardware.environment, onTranscript: text => { transcripts.push(text); } });
  return { ...hardware, controller, transcripts };
}
function voice(name: string, lang: string, isDefault = false): SpeechSynthesisVoice {
  return { name, lang, voiceURI: `${lang}:${name}`, default: isDefault, localService: true };
}

test('unsupported input returns an actionable error without claiming to listen', () => {
  const controller = createTrainingVoiceController({ environment: {}, onTranscript() {} });
  controller.startListening();
  assert.equal(controller.getSnapshot().ready, true);
  assert.equal(controller.getSnapshot().inputSupported, false);
  assert.equal(controller.getSnapshot().phase, 'idle');
  assert.match(controller.getSnapshot().error ?? '', /浏览器.*不支持.*语音识别/);
});

test('recognition configures Mandarin interim input and reports live listening only on start', () => {
  const h = setup();
  h.controller.startListening();
  assert.equal(h.controller.getSnapshot().phase, 'requesting');
  assert.equal(microphone(h).lang, 'zh-CN');
  assert.equal(microphone(h).continuous, true);
  assert.equal(microphone(h).interimResults, true);
  microphone(h).onstart!();
  assert.equal(h.controller.getSnapshot().phase, 'listening');
  h.controller.dispose();
});

test('incremental finals reach the user once while interim remains editable', () => {
  const h = setup(); h.controller.startListening();
  const recognition = microphone(h);
  recognition.onresult!({ resultIndex: 0, results: [result('您好', false)] });
  assert.equal(h.controller.getSnapshot().interimTranscript, '您好');
  assert.deepEqual(h.transcripts, []);
  recognition.onresult!({ resultIndex: 0, results: [result('您好。', true), result('想了解', false)] });
  recognition.onresult!({ resultIndex: 0, results: [result('您好。', true), result('想了解租期。', true)] });
  recognition.onresult!({ resultIndex: 1, results: [result('您好。', true), result('想了解租期。', true)] });
  assert.deepEqual(h.transcripts, ['您好。', '想了解租期。']);
  assert.equal(h.controller.getSnapshot().interimTranscript, '');
  h.controller.dispose();
});

test('stop keeps the final input until recognition ends', () => {
  const h = setup(); h.controller.startListening();
  const recognition = microphone(h); recognition.onstart!();
  h.controller.stopListening();
  assert.equal(h.controller.getSnapshot().phase, 'stopping');
  recognition.onresult!({ resultIndex: 0, results: [result('明天联系您。', true)] });
  assert.deepEqual(h.transcripts, ['明天联系您。']);
  recognition.onend!();
  assert.equal(h.controller.getSnapshot().phase, 'idle');
  assert.equal(h.timers.size, 0);
  h.controller.dispose();
});

for (const [code, message] of [
  ['not-allowed', /麦克风.*权限|权限.*麦克风/],
  ['audio-capture', /麦克风/], ['no-speech', /未.*语音|没有.*语音/],
  ['network', /网络/], ['service-not-allowed', /权限|服务/],
] as const) {
  test(`recognition error ${code} returns to idle with useful Chinese guidance`, () => {
    const h = setup(); h.controller.startListening();
    const recognition = microphone(h);
    const staleStart = recognition.onstart;
    recognition.onerror!({ error: code }); staleStart?.();
    assert.equal(h.controller.getSnapshot().phase, 'idle');
    assert.match(h.controller.getSnapshot().error ?? '', message);
    assert.equal(h.timers.size, 0);
    assert.equal(h.events.filter(item => item === 'recognition:start').length, 1);
    h.controller.dispose();
  });
}

test('synchronous start failure does not leave the microphone requesting', () => {
  const h = setup(); h.failStart(new Error('device busy'));
  h.controller.startListening();
  assert.equal(h.controller.getSnapshot().phase, 'idle');
  assert.match(h.controller.getSnapshot().error ?? '', /无法启动.*麦克风|麦克风.*无法启动/);
  h.controller.clearError();
  assert.equal(h.controller.getSnapshot().error, null);
  h.controller.dispose();
});

test('cancel ignores buffered results from the previous microphone session', () => {
  const h = setup(); h.controller.startListening();
  const oldResult = microphone(h).onresult!;
  const oldEnd = microphone(h).onend!;
  h.controller.cancelListening(); h.controller.startListening();
  oldResult({ resultIndex: 0, results: [result('不该发送', true)] }); oldEnd();
  assert.deepEqual(h.transcripts, []);
  assert.equal(h.controller.getSnapshot().phase, 'requesting');
  h.controller.dispose();
});

test('speech discards buffered microphone input before sending clean customer text', () => {
  const h = setup(); h.controller.startListening();
  const oldResult = microphone(h).onresult!;
  h.controller.speak('（演示客户） 您能再介绍一下吗？');
  oldResult({ resultIndex: 0, results: [result('扬声器回音', true)] });
  assert.deepEqual(h.transcripts, []);
  assert.equal(playback(h).text, '您能再介绍一下吗？');
  assert.equal(h.controller.getSnapshot().phase, 'preparing-speech');
  assert.ok(h.events.indexOf('recognition:abort') < h.events.indexOf('speech:speak'));
  playback(h).onstart!();
  assert.equal(h.controller.getSnapshot().phase, 'speaking');
  h.controller.dispose();
});

test('starting the microphone interrupts speech and stale speech events cannot end listening', () => {
  const h = setup(); h.controller.speak('还想了解预算。');
  const oldEnd = playback(h).onend!;
  h.controller.startListening(); oldEnd();
  assert.equal(h.controller.getSnapshot().phase, 'requesting');
  assert.ok(h.events.lastIndexOf('speech:cancel') < h.events.indexOf('recognition:start'));
  h.controller.dispose();
});

test('replay replaces the old utterance without old events overwriting the new playback', () => {
  const h = setup(); h.controller.speak('第一句');
  const old = playback(h); const oldEnd = old.onend!; const oldStart = old.onstart!;
  h.controller.speak('第二句'); oldEnd(); oldStart();
  assert.equal(h.controller.getSnapshot().phase, 'preparing-speech');
  playback(h, 1).onstart!();
  assert.equal(h.controller.getSnapshot().phase, 'speaking');
  playback(h, 1).onend!();
  assert.equal(h.controller.getSnapshot().phase, 'idle');
  assert.equal(h.timers.size, 0);
  h.controller.dispose();
});

test('blocked speech times out with replay guidance and late start stays invalid', () => {
  const h = setup(); h.controller.speak('请介绍方案');
  const oldStart = playback(h).onstart!;
  h.elapse(8_000); oldStart();
  assert.equal(h.controller.getSnapshot().phase, 'idle');
  assert.match(h.controller.getSnapshot().error ?? '', /点击.*重播/);
  assert.equal(h.timers.size, 0);
  h.controller.dispose();
});

test('missing recognition start or end events cannot leave controls stuck', () => {
  const h = setup(); h.controller.startListening();
  h.elapse(15_000);
  assert.equal(h.controller.getSnapshot().phase, 'idle');
  assert.match(h.controller.getSnapshot().error ?? '', /超时|未能启动/);
  h.controller.startListening(); microphone(h, 1).onstart!(); h.controller.stopListening();
  h.elapse(5_000);
  assert.equal(h.controller.getSnapshot().phase, 'idle');
  assert.equal(h.timers.size, 0);
  h.controller.dispose();
});

test('asynchronous voices prefer Chinese and retain an explicit available choice', () => {
  const h = setup();
  h.setVoices([voice('English', 'en-US', true), voice('普通话', 'zh-CN'), voice('广东话', 'zh-HK')]);
  assert.equal(h.controller.getSnapshot().selectedVoice, 'zh-CN:普通话');
  assert.equal(h.controller.getSnapshot().voices[0].lang, 'zh-CN');
  h.controller.setVoice('en-US:English');
  h.setVoices([voice('普通话', 'zh-CN'), voice('English', 'en-US', true)]);
  h.controller.setRate(2);
  h.controller.speak('语速测试');
  assert.equal(playback(h).voice?.name, 'English');
  assert.equal(playback(h).rate, 1.25);
  h.controller.setRate(0.25);
  assert.equal(h.controller.getSnapshot().rate, 0.75);
  h.controller.dispose();
});

test('unsupported output reports the limitation without pretending playback started', () => {
  const controller = createTrainingVoiceController({ environment: {}, onTranscript() {} });
  controller.speak('测试');
  assert.equal(controller.getSnapshot().outputSupported, false);
  assert.equal(controller.getSnapshot().phase, 'idle');
  assert.match(controller.getSnapshot().error ?? '', /不支持.*语音播放/);
});

test('stopAll invalidates every old microphone callback without sending a final', () => {
  const h = setup(); h.controller.startListening();
  const old = microphone(h); const oldResult = old.onresult!; const oldEnd = old.onend!;
  h.controller.stopAll();
  oldResult({ resultIndex: 0, results: [result('切场景后迟到的输入', true)] }); oldEnd();
  assert.deepEqual(h.transcripts, []);
  assert.equal(h.controller.getSnapshot().phase, 'idle');
  assert.equal(h.timers.size, 0);
  h.controller.dispose();
});

test('dispose releases hardware, event subscriptions and timers and suppresses notifications', () => {
  const h = setup(); let notifications = 0;
  h.controller.subscribe(() => { notifications++; });
  h.controller.speak('离开页面');
  const oldStart = playback(h).onstart!;
  h.controller.dispose(); const afterDispose = notifications;
  oldStart(); h.controller.startListening(); h.setVoices([voice('普通话', 'zh-CN')]);
  assert.equal(notifications, afterDispose);
  assert.equal(h.voiceListeners.size, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.recognitions.length, 0);
  assert.ok(h.events.includes('speech:cancel'));
});

test('browser boundary is safe when server rendering without window or microphone globals', () => {
  const environment = createBrowserVoiceEnvironment();
  const controller = createTrainingVoiceController({ environment, onTranscript() {} });
  assert.equal(controller.getSnapshot().inputSupported, false);
  assert.equal(controller.getSnapshot().outputSupported, false);
  controller.dispose();
});

test('the hook renders a pending capability state on the server', () => {
  function Probe() {
    const voice = useTrainingVoice({ onTranscript() {} });
    return createElement('span', null, `${voice.ready}:${voice.inputSupported}:${voice.phase}`);
  }
  assert.equal(renderToString(createElement(Probe)), '<span>false:false:idle</span>');
});

test('missing playback end cannot leave the controls in speaking forever', () => {
  const h = setup(); h.controller.speak('播放超时测试');
  const oldEnd = playback(h).onend!;
  playback(h).onstart!(); h.elapse(180_000); oldEnd();
  assert.equal(h.controller.getSnapshot().phase, 'idle');
  assert.match(h.controller.getSnapshot().error ?? '', /超时|点击.*重播/);
  assert.equal(h.timers.size, 0);
  h.controller.dispose();
});

test('speech errors leave a replayable error and cannot invalidate a later microphone session', () => {
  const h = setup(); h.controller.speak('浏览器声音权限测试');
  playback(h).onerror!({ error: 'not-allowed' });
  assert.equal(h.controller.getSnapshot().phase, 'idle');
  assert.match(h.controller.getSnapshot().error ?? '', /重播.*权限/);
  h.controller.startListening();
  assert.equal(h.controller.getSnapshot().phase, 'requesting');
  assert.equal(h.controller.getSnapshot().error, null);
  h.controller.dispose();
});

test('without a Chinese voice the browser chooses by Mandarin language instead of an English default', () => {
  const h = setup(); h.setVoices([voice('English', 'en-US', true)]);
  h.controller.speak('你好');
  assert.equal(h.controller.getSnapshot().selectedVoice, '');
  assert.equal(playback(h).voice, null);
  assert.equal(playback(h).lang, 'zh-CN');
  h.controller.setVoice('en-US:English'); h.controller.speak('用户选择音色');
  assert.equal(playback(h, 1).voice?.name, 'English');
  h.controller.dispose();
});

test('an explicit system voice choice clears the previous voice and survives asynchronous refresh', () => {
  const h = setup(); h.setVoices([voice('普通话', 'zh-CN'), voice('English', 'en-US')]);
  h.controller.setVoice('en-US:English'); h.controller.setVoice('');
  h.setVoices([voice('普通话', 'zh-CN'), voice('English', 'en-US')]);
  h.controller.speak('使用系统音色');
  assert.equal(h.controller.getSnapshot().selectedVoice, '');
  assert.equal(playback(h).voice, null);
  h.controller.dispose();
});

test('a browser without an input device explains the missing microphone after synchronous failure', () => {
  const h = setup(); const error = new Error('No microphone'); error.name = 'NotFoundError';
  h.failStart(error); h.controller.startListening();
  assert.equal(h.controller.getSnapshot().phase, 'idle');
  assert.match(h.controller.getSnapshot().error ?? '', /未找到.*麦克风/);
  assert.equal(h.timers.size, 0);
  h.controller.dispose();
});
