import test from 'node:test';
import assert from 'node:assert/strict';
import {createDigitalHumanService} from '../app/lib/digital-human-service.ts';
import {digitalHumanFixture, savedZego, zegoResponse} from './digital-human-fixture.ts';

async function readyFixture(request?: typeof fetch) {
  const f = digitalHumanFixture(); await f.store.configure('owner', savedZego);
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, options) => { calls.push(new URL(String(url)).searchParams.get('Action')!); return request ? request(url, options) : zegoResponse(url); };
  const service = createDigitalHumanService({store: f.store, bucket: f.bucket, request: fetcher, now: () => 10000});
  const added = await service.execute('owner', 'alice', {action: 'addAvatar', requestId: 'existing-avatar-request', name: '我的形象', digitalHumanId: 'private-avatar'});
  assert.ok(added.asset);
  const saved = await service.execute('owner', 'alice', {action: 'saveLive', requestId: 'save-live-request', assetId: added.asset.id, name: '产品直播', platform: '抖音', pushUrl: 'rtmp://push.example.com/live/private-stream-key'});
  assert.ok(saved.live);
  return {...f, service, calls, asset: added.asset, live: saved.live};
}
test('private avatar grants, member access and encrypted live config require no create call', async () => {
  const f = await readyFixture();
  try {
    await assert.rejects(f.service.execute('owner', 'bob', {action: 'addAvatar', requestId: 'bob-avatar-request', name: '别人的形象', digitalHumanId: 'private-avatar'}), {status: 403});
    await assert.rejects(f.service.execute('owner', 'bob', {action: 'saveLive', requestId: 'bob-live-request', assetId: f.asset.id, name: '冒用', platform: '抖音', pushUrl: 'rtmp://push.example.com/live/key'}), {status: 404});
    assert.ok(!JSON.stringify(f.live).includes('private-stream-key')); assert.ok(!JSON.stringify(f.sqlite.prepare('SELECT * FROM workbench_digital_human_lives').all()).includes('private-stream-key'));
    assert.equal(f.calls.includes('CreateLiveDigitalHumanAgentInstance'), false);
    const saved = await f.service.execute('owner', 'alice', {action: 'saveLive', requestId: 'same-save-request', liveId: f.live.id, version: f.live.version, assetId: f.asset.id, name: '改名', platform: '抖音', pushUrl: ''});
    assert.ok(saved.live?.hasPushUrl); assert.equal(saved.live?.pushUrlDisplay, 'rtmp://push.example.com/…');
  } finally {f.sqlite.close();}
});
test('durable live start/speak/stop identities and pinned credentials survive global rotation/disable', async () => {
  const bodies: Array<{action: string; appId: string; body: Record<string, unknown>}> = [];
  const f = await readyFixture(async (url, options) => { const parsed = new URL(String(url)); bodies.push({action: parsed.searchParams.get('Action')!, appId: parsed.searchParams.get('AppId')!, body: JSON.parse(String(options?.body))}); return zegoResponse(url); });
  try {
    const start = {action: 'startLive', liveId: f.live.id, version: f.live.version, requestId: 'start-request-original'};
    const started = await f.service.execute('owner', 'alice', start); assert.equal(started.live?.status, 'running');
    assert.ok((await f.service.execute('owner', 'alice', start)).live?.hasInstance);
    assert.equal(bodies.filter(b => b.action === 'CreateLiveDigitalHumanAgentInstance').length, 1);
    const spoken = await f.service.execute('owner', 'alice', {action: 'speak', liveId: f.live.id, version: started.live!.version, requestId: 'speak-original-request', text: '产品介绍'});
    assert.equal(spoken.live?.lastCommand?.status, 'accepted');
    await f.service.execute('owner', 'alice', {action: 'speak', liveId: f.live.id, version: started.live!.version, requestId: 'speak-original-request', text: '产品介绍'});
    assert.equal(bodies.filter(b => b.action === 'SendAgentInstanceTTS').length, 1);
    const conn = await f.store.connection('owner');
    await f.store.configure('owner', {...savedZego, version: conn.version, appId: '654321', secret: 'rotated-private-key', enabled: false});
    await assert.rejects(f.service.execute('owner', 'alice', {action: 'speak', liveId: f.live.id, version: spoken.live!.version, requestId: 'disabled-speak-request', text: '不可播报'}), {status: 503});
    const stopped = await f.service.execute('owner', 'alice', {action: 'stopLive', liveId: f.live.id, version: spoken.live!.version, requestId: 'stop-original-request'});
    assert.equal(stopped.live?.status, 'stopped');
    assert.equal(bodies.find(b => b.action === 'DeleteAgentInstance')?.appId, '123456');
    assert.ok(!JSON.stringify(stopped.live).includes('private-'));
  } finally {f.sqlite.close();}
});
test('unknown create/TTS never silently resubmit, generic status errors preserve running and missing code expires', async () => {
  let phase = 'normal';
  const f = await readyFixture(async url => {
    const action = new URL(String(url)).searchParams.get('Action');
    if (action === 'CreateLiveDigitalHumanAgentInstance' && phase === 'start-timeout') throw new Error('private-server-secret');
    if (action === 'SendAgentInstanceTTS' && phase === 'tts-timeout') throw new Error('private-body');
    if (action === 'QueryAgentInstanceStatus' && phase === 'query-error') return Response.json({Code: 410001034, Message: 'secret', RequestId: 'safe-request'});
    if (action === 'QueryAgentInstanceStatus' && phase === 'missing') return Response.json({Code: 410001002, Message: 'not found', RequestId: 'safe-request'});
    return zegoResponse(url);
  });
  try {
    phase = 'start-timeout';
    const command = {action: 'startLive', liveId: f.live.id, version: f.live.version, requestId: 'unknown-start-request'};
    const unknown = await f.service.execute('owner', 'alice', command); assert.equal(unknown.live?.status, 'start_unknown');
    await f.service.execute('owner', 'alice', command);
    await assert.rejects(f.service.execute('owner', 'alice', {...command, version: unknown.live!.version, requestId: 'new-start-request'}), {status: 409});
    assert.equal(f.calls.filter(a => a === 'CreateLiveDigitalHumanAgentInstance').length, 1);
  } finally {f.sqlite.close();}
  const g = await readyFixture(async url => {
    const action = new URL(String(url)).searchParams.get('Action');
    if (action === 'SendAgentInstanceTTS') throw new Error('secret');
    if (action === 'QueryAgentInstanceStatus') return Response.json({Code: phase === 'missing' ? 410001002 : 410001034, RequestId: 'safe-request'});
    return zegoResponse(url);
  });
  try {
    phase = 'normal'; const started = await g.service.execute('owner', 'alice', {action: 'startLive', liveId: g.live.id, version: g.live.version, requestId: 'normal-start-request'});
    const speak = {action: 'speak', liveId: g.live.id, version: started.live!.version, requestId: 'unknown-speak-request', text: '产品介绍'};
    const unknown = await g.service.execute('owner', 'alice', speak); assert.equal(unknown.live?.lastCommand?.status, 'unknown'); await g.service.execute('owner', 'alice', speak);
    assert.equal(g.calls.filter(a => a === 'SendAgentInstanceTTS').length, 1);
    phase = 'query-error'; const failed = await g.service.execute('owner', 'alice', {action: 'refreshLive', liveId: g.live.id, version: unknown.live!.version, requestId: 'status-request-1'}); assert.equal(failed.live?.status, 'running');
    phase = 'missing'; const expired = await g.service.execute('owner', 'alice', {action: 'refreshLive', liveId: g.live.id, version: failed.live!.version, requestId: 'status-request-2'}); assert.equal(expired.live?.status, 'stopped'); assert.equal(expired.live?.hasInstance, false);
  } finally {g.sqlite.close();}
});
test('in-flight start blocks stop/edit and refresh cannot orphan the accepted instance', async () => {
  let release: () => void = () => {}; let started: () => void = () => {};
  const waiting = new Promise<void>(resolve => {started = resolve;}); const held = new Promise<void>(resolve => {release = resolve;});
  const f = await readyFixture(async url => { if (new URL(String(url)).searchParams.get('Action') === 'CreateLiveDigitalHumanAgentInstance') { started(); await held; } return zegoResponse(url); });
  try {
    const pending = f.service.execute('owner', 'alice', {action: 'startLive', liveId: f.live.id, version: f.live.version, requestId: 'pending-start-request'});
    await waiting;
    const current = await f.store.getLive('owner', 'alice', f.live.id);
    const refreshed = await f.service.execute('owner', 'alice', {action: 'refreshLive', liveId: f.live.id, version: current.version, requestId: 'pending-refresh-request'}); assert.equal(refreshed.live?.version, current.version);
    await assert.rejects(f.service.execute('owner', 'alice', {action: 'stopLive', liveId: f.live.id, version: current.version, requestId: 'pending-stop-request'}), {status: 409});
    release(); const accepted = await pending; assert.equal(accepted.live?.status, 'running');
    const op = await f.store.operation('owner', 'alice', 'pending-start-request'); assert.equal(op?.providerInstanceId, 'instance-original'); assert.equal(op?.status, 'accepted');
  } finally {release(); f.sqlite.close();}
});

test('abandoned sending intent becomes unknown without create retry and late accepted instance is retained', async () => {
  const f = digitalHumanFixture();
  let release: () => void = () => {}, began: () => void = () => {}, clock = 10000;
  const started = new Promise<void>(resolve => {began = resolve;}); const held = new Promise<void>(resolve => {release = resolve;});
  try {
    await f.store.configure('owner', savedZego); let creates = 0;
    const service = createDigitalHumanService({store: f.store, bucket: f.bucket, now: () => clock, request: async url => {if (new URL(String(url)).searchParams.get('Action') === 'CreateLiveDigitalHumanAgentInstance') {creates++; began(); await held;} return zegoResponse(url);}});
    const {asset} = await service.execute('owner', 'alice', {action: 'addAvatar', requestId: 'late-asset-request', name: '形象', digitalHumanId: 'private-avatar'}); assert.ok(asset);
    const {live} = await service.execute('owner', 'alice', {action: 'saveLive', requestId: 'late-config-request', assetId: asset.id, name: '直播', platform: '抖音', pushUrl: 'rtmp://push.example.com/live/private-key'}); assert.ok(live);
    const command = {action: 'startLive', liveId: live.id, version: live.version, requestId: 'late-start-request'};
    const pending = service.execute('owner', 'alice', command); await started;
    clock += 60001;
    const snapshot = await service.snapshot('owner', 'alice'); assert.equal(snapshot.lives[0].status, 'start_unknown');
    await service.execute('owner', 'alice', command); assert.equal(creates, 1);
    release(); const finished = await pending; assert.equal(finished.live?.status, 'running'); assert.equal(finished.live?.hasInstance, true);
    assert.equal((await f.store.operation('owner', 'alice', command.requestId))?.providerInstanceId, 'instance-original');
  } finally {release(); f.sqlite.close();}
});
test('TTS accepts multiline scripts and private grants are rechecked before start', async () => {
  const f = await readyFixture();
  try {
    const started = await f.service.execute('owner', 'alice', {action: 'startLive', liveId: f.live.id, version: f.live.version, requestId: 'multiline-start-request'}); assert.ok(started.live);
    const speak = {action: 'speak', liveId: f.live.id, version: started.live.version, requestId: 'multiline-speak-request', text: '第一行\r\n第二行'};
    const spoken = await f.service.execute('owner', 'alice', speak); assert.equal(spoken.live?.lastCommand?.text, '第一行\n第二行');
    await assert.rejects(f.service.execute('owner', 'alice', {...speak, text: '已改变'}), {status: 409});
    const stopped = await f.service.execute('owner', 'alice', {action: 'stopLive', liveId: f.live.id, version: spoken.live!.version, requestId: 'multiline-stop-request'});
    const config = await f.store.connection('owner'); await f.store.configure('owner', {...savedZego, version: config.version, avatarGrants: []});
    await assert.rejects(f.service.execute('owner', 'alice', {action: 'startLive', liveId: f.live.id, version: stopped.live!.version, requestId: 'revoked-start-request'}), {status: 403});
    assert.equal(f.calls.filter(value => value === 'CreateLiveDigitalHumanAgentInstance').length, 1);
  } finally {f.sqlite.close();}
});

test('accepted operation survives a projection CAS failure and same-intent retry does not create again', async () => {
  const f = await readyFixture();
  try {
    const original = f.store.applyOperation; let first = true;
    f.store.applyOperation = async op => {if (first) {first = false; throw new Error('projection write interrupted');} return original(op);};
    const command = {action: 'startLive', liveId: f.live.id, version: f.live.version, requestId: 'journal-retained-request'};
    await assert.rejects(f.service.execute('owner', 'alice', command));
    assert.equal((await f.store.operation('owner', 'alice', command.requestId))?.providerInstanceId, 'instance-original');
    const snapshot = await f.service.snapshot('owner', 'alice'); assert.equal(snapshot.lives[0].status, 'running');
    await f.service.execute('owner', 'alice', command);
    assert.equal(f.calls.filter(action => action === 'CreateLiveDigitalHumanAgentInstance').length, 1);
  } finally {f.sqlite.close();}
});
test('avatar rebinding is atomically denied while in use and a changed source fences pending start', async () => {
  const f = digitalHumanFixture();
  let release: () => void = () => {}, began: () => void = () => {}, hold = false, creates = 0;
  const waiting = new Promise<void>(resolve => {began = resolve;}); const gate = new Promise<void>(resolve => {release = resolve;});
  try {
    await f.store.configure('owner', savedZego);
    const service = createDigitalHumanService({store: f.store, bucket: f.bucket, request: async url => {
      const action = new URL(String(url)).searchParams.get('Action');
      if (action === 'GetDigitalHumanInfo' && hold) {hold = false; began(); await gate;}
      if (action === 'CreateLiveDigitalHumanAgentInstance') creates++;
      return zegoResponse(url);
    }});
    const time = new Date().toISOString();
    const stored = {id: 'source-asset-race', ownerId: 'owner', memberId: 'alice', requestId: 'asset-race-request', payloadHash: 'hash', version: 1, name: '源素材', sourceKind: 'photo' as const, status: 'ready' as const, fileName: 'x.png', fileKey: 'private-source-key', mime: 'image/png', size: 100, digitalHumanId: 'private-avatar', verifiedAppId: '123456', createdAt: time, updatedAt: time};
    await f.store.insertAsset(stored);
    const {live} = await service.execute('owner', 'alice', {action: 'saveLive', requestId: 'race-config-request', assetId: stored.id, name: '直播', platform: '抖音', pushUrl: 'rtmp://push.example.com/live/key'}); assert.ok(live);
    hold = true;
    const start = service.execute('owner', 'alice', {action: 'startLive', liveId: live.id, version: live.version, requestId: 'race-start-request'});
    await waiting;
    const bound = await service.execute('owner', 'alice', {action: 'bindAvatar', assetId: stored.id, version: 1, digitalHumanId: 'private-avatar'}); assert.equal(bound.asset?.version, 2);
    release(); await assert.rejects(start, {status: 409}); assert.equal(creates, 0);
    const started = await service.execute('owner', 'alice', {action: 'startLive', liveId: live.id, version: live.version, requestId: 'race-start-request2'}); assert.equal(started.live?.status, 'running');
    await assert.rejects(service.execute('owner', 'alice', {action: 'bindAvatar', assetId: stored.id, version: 2, digitalHumanId: 'private-avatar'}), {status: 409});
    assert.equal((await f.store.getAsset('owner', 'alice', stored.id)).version, 2);
  } finally {release(); f.sqlite.close();}
});
test('old AppId avatars cannot silently start in a different project', async () => {
  const f = await readyFixture();
  try {
    const config = await f.store.connection('owner'); await f.store.configure('owner', {...savedZego, version: config.version, appId: '654321', secret: 'new-project-secret'});
    await assert.rejects(f.service.execute('owner', 'alice', {action: 'startLive', liveId: f.live.id, version: f.live.version, requestId: 'old-app-start-request'}), {status: 409});
    assert.equal(f.calls.includes('CreateLiveDigitalHumanAgentInstance'), false);
  } finally {f.sqlite.close();}
});

test('lost acknowledgement after journaling acceptance does not stop or duplicate the known instance', async () => {
  const f = await readyFixture();
  try {
    const original = f.store.saveOperation; let lost = true;
    f.store.saveOperation = async op => {await original(op); if (lost && op.status === 'accepted') {lost = false; throw new Error('accepted journal acknowledgement lost');}};
    const result = await f.service.execute('owner', 'alice', {action: 'startLive', liveId: f.live.id, version: f.live.version, requestId: 'journal-ack-lost-request'});
    assert.equal(result.live?.status, 'running');
    assert.equal(f.calls.filter(value => value === 'CreateLiveDigitalHumanAgentInstance').length, 1);
    assert.equal(f.calls.includes('DeleteAgentInstance'), false);
  } finally {f.sqlite.close();}
});

test('avatar-only credentials reject live creation before reservation when no registered AgentId exists', async () => {
  const f = await readyFixture();
  try {
    const config = await f.store.connection('owner'); await f.store.configure('owner', {...savedZego, version: config.version, agentId: ''});
    const command = {action: 'startLive', liveId: f.live.id, version: f.live.version, requestId: 'missing-agent-start-request'};
    await assert.rejects(f.service.execute('owner', 'alice', command), {status: 503});
    assert.equal(await f.store.operation('owner', 'alice', command.requestId), null);
    assert.equal(f.calls.includes('CreateLiveDigitalHumanAgentInstance'), false);
    assert.equal((await f.store.getLive('owner', 'alice', f.live.id)).status, 'draft');
  } finally {f.sqlite.close();}
});

test('concurrent conflicting operation identity cannot mutate the losing live or duplicate snapshot IDs', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => {release = resolve;}); let creates = 0;
  const f = await readyFixture(async url => {if (new URL(String(url)).searchParams.get('Action') === 'CreateLiveDigitalHumanAgentInstance') {creates++; await gate;} return zegoResponse(url);});
  try {
    const {live: second} = await f.service.execute('owner', 'alice', {action: 'saveLive', requestId: 'second-live-config-request', assetId: f.asset.id, name: '第二场', platform: '抖音', pushUrl: 'rtmp://push.example.com/live/second-key'}); assert.ok(second);
    const original = f.store.operation; let reads = 0, releaseBarrier: () => void = () => {};
    const barrier = new Promise<void>(resolve => {releaseBarrier = resolve;});
    f.store.operation = async (...args) => {
      const value = await original(...args);
      if (args[2] === 'shared-concurrent-request' && reads < 2) {reads++; if (reads === 2) releaseBarrier(); await barrier;}
      return value;
    };
    const lives = [f.live, second];
    const results = await Promise.allSettled(lives.map(live => f.service.execute('owner', 'alice', {action: 'startLive', liveId: live.id, version: live.version, requestId: 'shared-concurrent-request'}).catch(error => {release(); throw error;})));
    assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
    const loserIndex = results.findIndex(value => value.status === 'rejected');
    const rejected = results[loserIndex]; assert.equal(rejected.status === 'rejected' ? rejected.reason.status : undefined, 409);
    const loser = await f.store.getLive('owner', 'alice', lives[loserIndex].id);
    assert.equal(loser.status, 'draft'); assert.equal(loser.version, lives[loserIndex].version); assert.equal(loser.activeOperation, undefined);
    assert.equal(creates, 1);
    const snapshot = await f.service.snapshot('owner', 'alice');
    assert.deepEqual(snapshot.lives.map(live => live.id).sort(), lives.map(live => live.id).sort());
  } finally {release(); f.sqlite.close();}
});
test('accepted restart clears current speech and scopes identical script intents to the recovered generation', async () => {
  let creates = 0, utterances = 0;
  const f = await readyFixture(async url => {
    const action = new URL(String(url)).searchParams.get('Action');
    if (action === 'CreateLiveDigitalHumanAgentInstance') return Response.json({Code: 0, Data: {AgentInstanceId: 'instance-' + (++creates)}});
    if (action === 'SendAgentInstanceTTS') {utterances++; if (creates === 1) throw new Error('first generation speech result unknown');}
    return zegoResponse(url);
  });
  try {
    const startA = {action: 'startLive', liveId: f.live.id, version: f.live.version, requestId: 'generation-start-a'};
    const {live: first} = await f.service.execute('owner', 'alice', startA); assert.ok(first);
    const speechA = {action: 'speak', liveId: first.id, version: first.version, requestId: 'generation-speech-a', text: 'hello', generationId: 'generation-start-a'};
    const {live: spokenA} = await f.service.execute('owner', 'alice', speechA); assert.ok(spokenA);
    await f.service.execute('owner', 'alice', speechA); assert.equal(utterances, 1);
    const {live: stopped} = await f.service.execute('owner', 'alice', {action: 'stopLive', liveId: first.id, version: spokenA.version, requestId: 'generation-stop-a'}); assert.ok(stopped);
    const originalApply = f.store.applyOperation;
    f.store.applyOperation = async op => {if (op.requestId === 'generation-start-b') throw new Error('accepted restart projection response lost'); return originalApply(op);};
    await assert.rejects(f.service.execute('owner', 'alice', {action: 'startLive', liveId: first.id, version: stopped.version, requestId: 'generation-start-b'}));
    f.store.applyOperation = originalApply;
    const recovered = (await f.service.snapshot('owner', 'alice')).lives.find(live => live.id === first.id)!;
    assert.equal(recovered.status, 'running'); assert.equal(recovered.hasInstance, true); assert.equal(recovered.lastCommand, undefined);
    assert.equal(recovered.generationId, 'generation-start-b');
    await assert.rejects(f.service.execute('owner', 'alice', {...speechA, version: recovered.version}), {status: 409});
    await assert.rejects(f.service.execute('owner', 'alice', {...speechA, version: recovered.version, generationId: 'generation-start-b'}), {status: 409});
    const speechB = {...speechA, version: recovered.version, requestId: 'generation-speech-b', generationId: 'generation-start-b'};
    const {live: spokenB} = await f.service.execute('owner', 'alice', speechB);
    await f.service.execute('owner', 'alice', speechB);
    assert.equal(spokenB?.lastCommand?.status, 'accepted'); assert.equal(utterances, 2); assert.equal(creates, 2);
    const historicalA = await f.store.operation('owner', 'alice', speechA.requestId); assert.equal(historicalA?.status, 'unknown');
    assert.equal((await f.store.operation('owner', 'alice', speechB.requestId))?.status, 'accepted');
    const lateA = {...historicalA!, status: 'accepted' as const};
    await f.store.saveOperation(lateA);
    const unchangedB = await f.store.applyOperation(lateA);
    assert.equal(unchangedB.generationRequestId, 'generation-start-b');
    assert.equal(unchangedB.lastCommand?.requestId, speechB.requestId);
    assert.equal(unchangedB.version, spokenB!.version);
  } finally {f.sqlite.close();}
});
test('ready existing avatars can reverify after AppId changes while upload and active-live fences remain', async () => {
  const f = await readyFixture();
  try {
    const config = await f.store.connection('owner'); await f.store.configure('owner', {...savedZego, version: config.version, appId: '654321', secret: 'new-project-secret'});
    const result = await f.service.execute('owner', 'alice', {action: 'bindAvatar', assetId: f.asset.id, version: f.asset.version, digitalHumanId: 'private-avatar'}); assert.ok(result.asset);
    assert.equal(result.asset.sourceKind, 'existing'); assert.equal(result.asset.status, 'ready'); assert.equal(result.asset.sourceUrl, undefined);
    assert.equal((await f.store.getAsset('owner', 'alice', f.asset.id)).verifiedAppId, '654321');
    const source = await f.store.getAsset('owner', 'alice', f.asset.id);
    await f.store.insertAsset({...source, id: 'uncommitted-photo', requestId: 'uncommitted-photo-request', sourceKind: 'photo', status: 'ready'});
    await assert.rejects(f.service.execute('owner', 'alice', {action: 'bindAvatar', assetId: 'uncommitted-photo', version: source.version, digitalHumanId: 'private-avatar'}), {status: 400});
    const {live: running} = await f.service.execute('owner', 'alice', {action: 'startLive', liveId: f.live.id, version: f.live.version, requestId: 'reverified-start-request'}); assert.ok(running);
    await assert.rejects(f.service.execute('owner', 'alice', {action: 'bindAvatar', assetId: f.asset.id, version: result.asset.version, digitalHumanId: 'private-avatar'}), {status: 409});
  } finally {f.sqlite.close();}
});
