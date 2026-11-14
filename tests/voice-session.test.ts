import test from 'node:test';
import assert from 'node:assert/strict';
import * as voiceSession from '../app/lib/voice-session.ts';
const { gatewayConfiguration, signVoiceSession } = voiceSession;
import {unzlibSync} from 'fflate';

test('gateway config refuses insecure or credential-bearing production URLs and weak secrets', () => {
  assert.equal(gatewayConfiguration({}), null);
  for (const url of ['http://host/ws','ws://host/ws','wss://user:secret@host/ws','wss://host/ws?token=x']) {
    assert.throws(()=>gatewayConfiguration({VOICE_GATEWAY_URL:url,VOICE_GATEWAY_SECRET:'x'.repeat(32)}));
  }
  assert.throws(()=>gatewayConfiguration({VOICE_GATEWAY_URL:'wss://voice.example.com/ws',VOICE_GATEWAY_SECRET:'short'}));
  assert.equal(gatewayConfiguration({VOICE_GATEWAY_URL:'wss://voice.example.com/ws',VOICE_GATEWAY_SECRET:'x'.repeat(32)})?.url,'wss://voice.example.com/ws');
  assert.equal(gatewayConfiguration({VOICE_GATEWAY_URL:'ws://127.0.0.1:8001/ws',VOICE_GATEWAY_SECRET:'x'.repeat(32)},'http://127.0.0.1:5173')?.url,'ws://127.0.0.1:8001/ws');
  assert.throws(()=>gatewayConfiguration({VOICE_GATEWAY_URL:'ws://127.0.0.1:8001/ws',VOICE_GATEWAY_SECRET:'x'.repeat(32)},'https://private-site.example'));
  assert.throws(()=>gatewayConfiguration({VOICE_GATEWAY_URL:'ws://remote.example/ws',VOICE_GATEWAY_SECRET:'x'.repeat(32)},'http://127.0.0.1:5173'));
});
test('live speech hotword profiles are signed, compressed and omit disabled terms',async()=>{
  const words=[{id:'enabled',term:'企查查',aliases:['企茶茶'],enabled:true},{id:'disabled',term:'未启用',aliases:[],enabled:false}];
  const token=await signVoiceSession('x'.repeat(32),'owner','session',1700000000,words);
  const claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString());
  assert.deepEqual(JSON.parse(new TextDecoder().decode(unzlibSync(Buffer.from(claims.speechProfile,'base64url')))),[{term:'企查查',aliases:['企茶茶'],enabled:true}]);
  assert.ok(new TextEncoder().encode(JSON.stringify({type:'session.start',token})).byteLength<16384);
});
test('voice tokens are expiring, session-bound HS256 signatures without exposing the secret', async () => {
  const secret='a-shared-secret-that-is-at-least-32-chars';
  const token=await signVoiceSession(secret,'user-test','training-123',1700000000);
  const [header,body,signature]=token.split('.');
  const claims=JSON.parse(Buffer.from(body,'base64url').toString());
  assert.deepEqual(JSON.parse(Buffer.from(header,'base64url').toString()),{alg:'HS256',typ:'JWT'});
  assert.equal(claims.sub,'user-test');assert.equal(claims.sessionId,'training-123');assert.equal(claims.aud,'training-voice');
  assert.equal(claims.exp-claims.iat,300);assert.ok(claims.jti);assert.ok(!token.includes(secret));
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  assert.equal(await crypto.subtle.verify('HMAC',key,Buffer.from(signature,'base64url'),new TextEncoder().encode(`${header}.${body}`)),true);
});

test('catalog reads the current gateway handshake without opening audio or exposing a ticket', async () => {
  let sent: { type: string; token: string } | undefined;
  let closed = 0;
  const socket = new EventTarget() as EventTarget & { accept(): void; send(value: string): void; close(): void };
  socket.accept = () => {};
  socket.send = value => {
    sent = JSON.parse(value);
    queueMicrotask(() => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
      type: 'session.ready', sampleRate: 24000, voices: [{ id: 'zh-real', name: '配置音色', lang: 'zh-CN', secret: 'not-for-client' }], defaultVoice: 'zh-real',
    }) })));
  };
  socket.close = () => { closed++; };
  const result = await voiceSession.readGatewayVoiceCatalog(
    { url: 'wss://voice.example.com/custom/ws', secret: 'x'.repeat(32) }, 'https://workspace.example.com', 'member-1',
    async (url, init) => {
      assert.equal(url, 'https://voice.example.com/custom/ws');
      assert.equal(init.redirect, 'manual');
      assert.equal(new Headers(init.headers).get('Origin'), 'https://workspace.example.com');
      return { webSocket: socket };
    },
  );
  assert.equal(closed, 1);
  assert.equal(sent?.type, 'session.start');
  const claims = JSON.parse(Buffer.from(sent!.token.split('.')[1], 'base64url').toString());
  assert.match(claims.sessionId, /^catalog-[\da-f-]{36}$/);
  assert.equal(claims.sub, 'member-1');
  assert.equal(claims.exp - claims.iat, 20);
  assert.deepEqual(result, { voices: [{ id: 'zh-real', name: '配置音色', lang: 'zh-CN' }], defaultVoice: 'zh-real' });
});

test('aborting a gateway catalog lookup closes the probe and discards its result', async () => {
  const abort = new AbortController();
  let closed = 0;
  const socket = Object.assign(new EventTarget(), {
    accept() {},
    send() { abort.abort(); },
    close() { closed++; },
  });
  await assert.rejects(voiceSession.readGatewayVoiceCatalog(
    { url: 'wss://voice.example.com/ws', secret: 'x'.repeat(32) }, 'https://workspace.example.com', 'member-1',
    async () => ({ webSocket: socket }), abort.signal,
  ), /暂时无法提前读取实时音色/);
  assert.equal(closed, 1);
});
