import test from 'node:test';
import assert from 'node:assert/strict';
import { gatewayConfiguration, signVoiceSession } from '../app/lib/voice-session.ts';

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
