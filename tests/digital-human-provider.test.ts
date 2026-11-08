import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createDigitalHumanProvider, zegoSignedUrl, ZegoProviderError} from '../app/lib/digital-human-provider.ts';

const credentials = {appId: '123456', agentId: 'agent-product', serverSecret: 'private-server-secret'};
test('ZEGO exact fixed hosts and signature v2 are deterministic without exposing secret', () => {
  const url = zegoSignedUrl('GetDigitalHumanInfo', credentials, 1700000000123, '0011223344556677');
  assert.equal(url.origin, 'https://aigc-digitalhuman-api.zegotech.cn');
  assert.equal(url.searchParams.get('SignatureVersion'), '2.0');
  assert.equal(url.searchParams.get('Timestamp'), '1700000000');
  assert.equal(url.searchParams.get('Signature'), createHash('md5').update('1234560011223344556677private-server-secret1700000000').digest('hex'));
  assert.ok(!url.href.includes('private-server-secret'));
  assert.equal(zegoSignedUrl('DeleteAgentInstance', credentials, 1700000000123, '0011223344556677').hostname, 'aigc-aiagent-api.zegotech.cn');
});
test('provider uses verified CDN create, readonly avatar endpoints and explicit TTS/delete schemas', async () => {
  const calls: Array<{action: string; body: Record<string, unknown>}> = [];
  const provider = createDigitalHumanProvider({request: async (input, options) => {
    const url = new URL(String(input));
    assert.equal(options?.method, 'POST');
    assert.equal(options?.redirect, 'manual');
    assert.equal(new Headers(options?.headers).get('Authorization'), null);
    const action = url.searchParams.get('Action')!;
    calls.push({action, body: JSON.parse(String(options?.body))});
    const data = action === 'GetDigitalHumanInfo' ? {DigitalHumanId: 'avatar-1', Name: '形象', IsPublic: true, AvatarUrl: 'https://private-preview.invalid/token'} : action === 'CreateLiveDigitalHumanAgentInstance' ? {AgentInstanceId: 'instance-1', DigitalHumanConfig: '{}'} : action === 'QueryAgentInstanceStatus' ? {Status: 'SPEAKING'} : action === 'GetDigitalHumanList' ? {Total: 1, DigitalHumans: [{DigitalHumanId: 'avatar-1', Name: '形象', IsPublic: true}]} : action === 'SendAgentInstanceTTS' ? {Round: 12} : undefined;
    return Response.json({Code: 0, Message: 'success', RequestId: 'r-1', ...(data ? {Data: data} : {})});
  }});
  assert.deepEqual(await provider.avatar(credentials, 'avatar-1'), {digitalHumanId: 'avatar-1', name: '形象', isPublic: true});
  assert.deepEqual(await provider.publicAvatars(credentials, 0), {avatars: [{digitalHumanId: 'avatar-1', name: '形象'}], total: 1, offset: 0});
  assert.equal(await provider.start(credentials, 'avatar-1', 'rtmp://push.example.com/live/private-key'), 'instance-1');
  assert.equal(await provider.query(credentials, 'instance-1'), 'SPEAKING');
  await provider.speak(credentials, 'instance-1', '商品介绍');
  await provider.stop(credentials, 'instance-1');
  assert.deepEqual(calls.find(c => c.action === 'CreateLiveDigitalHumanAgentInstance')?.body, {AgentId: 'agent-product', DigitalHuman: {DigitalHumanId: 'avatar-1', ConfigId: 'web', EncodeCode: 'H264', AlphaMode: 1}, CDN: {Url: 'rtmp://push.example.com/live/private-key'}, AdvancedConfig: {MaxIdleTime: 120}});
  assert.deepEqual(calls.find(c => c.action === 'SendAgentInstanceTTS')?.body, {AgentInstanceId: 'instance-1', Text: '商品介绍', AddHistory: false, Priority: 'Medium', SamePriorityOption: 'Enqueue'});
  assert.deepEqual(calls.find(c => c.action === 'DeleteAgentInstance')?.body, {AgentInstanceId: 'instance-1', GracefulShutdown: false});
  assert.deepEqual(calls.find(c => c.action === 'GetDigitalHumanList')?.body, {FetchMode: 2, Offset: 0, Limit: 20});
});
test('provider errors and malformed schemas never return raw body, signed URL, or secrets', async () => {
  for (const response of [Response.json({Code: 410001002, Message: 'private-server-secret rtmp://push/private-key', RequestId: 'request-safe'}), Response.json({Code: 0, Data: {Status: 'STOPPED'}}), new Response('private-secret', {status: 500})]) {
    const provider = createDigitalHumanProvider({request: async () => response});
    await assert.rejects(provider.query(credentials, 'instance'), (error: unknown) => {
      assert.ok(error instanceof ZegoProviderError);
      assert.ok(!/private-|Signature=|rtmp:/.test(error.message));
      return true;
    });
  }
});
