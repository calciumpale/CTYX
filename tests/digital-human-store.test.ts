import test from 'node:test';
import assert from 'node:assert/strict';
import {digitalHumanFixture, savedZego, zegoResponse} from './digital-human-fixture.ts';

test('encrypted config, blank-secret retention, member grants and readonly draft connection testing', async () => {
  const {store, sqlite} = digitalHumanFixture();
  try {
    assert.equal((await store.connection('owner')).configured, false);
    const saved = await store.configure('owner', savedZego);
    assert.equal(saved.hasSecret, true); assert.deepEqual(saved.avatarGrants, savedZego.avatarGrants);
    assert.ok(!JSON.stringify(sqlite.prepare('SELECT * FROM workbench_api_connections').all()).includes('private-server-secret'));
    assert.equal((await store.connection('other-owner')).configured, false);
    assert.equal((await store.credentials('owner')).serverSecret, 'private-server-secret');
    const kept = await store.configure('owner', {...savedZego, version: saved.version, secret: ''});
    assert.equal((await store.credentials('owner')).serverSecret, 'private-server-secret');
    let calls = 0;
    await store.configure('owner', {...savedZego, action: 'test', version: kept.version, agentId: 'draft-agent', secret: ''}, async (url) => { calls++; assert.equal(new URL(String(url)).searchParams.get('Action'), 'GetDigitalHumanList'); return zegoResponse(url); });
    assert.equal(calls, 1); assert.equal((await store.connection('owner')).agentId, 'registered-agent');
    await assert.rejects(store.configure('owner', {...savedZego, version: saved.version}), {status: 409});
    await assert.rejects(store.configure('owner', {...savedZego, version: kept.version, avatarGrants: [{digitalHumanId: 'private-avatar', memberId: 'alice'}, {digitalHumanId: 'private-avatar', memberId: 'bob'}]}), {status: 400});
    await assert.rejects(store.configure('owner', {...savedZego, version: kept.version, avatarGrants: [{digitalHumanId: 'x', memberId: 'missing'}]}), {status: 400});
  } finally { sqlite.close(); }
});

test('avatar-only connection permits empty agent while AppId and documented AgentId bounds are validated', async () => {
  const f = digitalHumanFixture();
  try {
    const saved = await f.store.configure('owner', {...savedZego, agentId: ''});
    assert.equal(saved.configured, true); assert.equal(saved.liveReady, false); assert.equal(saved.agentId, '');
    await f.store.configure('owner', {...savedZego, action: 'test', version: saved.version, agentId: '', secret: ''}, async url => zegoResponse(url));
    await assert.rejects(f.store.configure('owner', {...savedZego, version: saved.version, appId: '4294967296'}), {status: 400});
    const next = await f.store.configure('owner', {...savedZego, version: saved.version, agentId: 'agent!#$%&()+-:;<=.>?@[]^_|~,'});
    assert.equal(next.agentId, 'agent!#$%&()+-:;<=.>?@[]^_|~,');
    await assert.rejects(f.store.configure('owner', {...savedZego, version: next.version, agentId: 'a'.repeat(129)}), {status: 400});
  } finally {f.sqlite.close();}
});
