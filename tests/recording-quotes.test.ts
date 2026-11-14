import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { assertMemberApi } from '../app/lib/member-policy.ts';
import { projectState } from '../app/lib/domain.ts';
import { recordingQuoteStore } from '../app/lib/recording-quotes.ts';
import { createSeed } from '../app/lib/seed.ts';
import type { SpeechTranscriptionJob } from '../app/lib/speech-types.ts';

const now = '2026-10-25T03:00:00.000Z';
const recording = { id: 'recording-9a83c9a6-61ce-489c-bd7a-a6dba42ee69a', name: '客户沟通.m4a', size: 20, mimeType: 'audio/mp4' };
const target = { dealId: 'deal-1', recordingId: recording.id, jobId: 'asr-recording-one', segmentIndex: 1 };
const exactText = '请先确认客户为什么重视交付时间。';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE workbench_recording_transcriptions (user_id TEXT, deal_id TEXT, recording_id TEXT, version INTEGER, data_json TEXT)');
  const db = {
    prepare(sql: string) {
      let params: SQLInputValue[] = [];
      return {
        bind(...values: SQLInputValue[]) { params = values; return this; },
        async first() { return sqlite.prepare(sql).get(...params) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...params) }; },
        async run() { return sqlite.prepare(sql).run(...params); },
      };
    },
  } as unknown as D1Database;
  const state = createSeed(now);
  const deal = state.deals[0];
  deal.notes.unshift({ id:'source-note', text:'', author:'测试', date:now, recording });
  const job: SpeechTranscriptionJob = {
    id:target.jobId, dealId:deal.id, recordingId:recording.id, status:'completed', linked:true, progress:100, message:'',
    result: { text:exactText, rawText:exactText, durationSeconds:12, model:'mock', diarization:true, dialectHint:'auto', hotwordVersion:1,
      speakers:[{id:'one',label:'讲话人 1'},{id:'two',label:'讲话人 2'}], corrections:[],
      segments:[{speaker:'one',start:1,end:2,text:'你好',rawText:'你好'},{speaker:'two',start:3,end:6,text:exactText,rawText:exactText}],
    }, createdAt:now, updatedAt:now,
  };
  sqlite.prepare('INSERT INTO workbench_recording_transcriptions VALUES (?,?,?,?,?)').run('owner', deal.id, recording.id, 1, JSON.stringify(job));
  const scope = (memberId: string, salesId = 'sales-1', manager = false, ownerId = 'owner') =>
    recordingQuoteStore(db, { ownerId, memberId, manager, state: projectState(state, manager ? 'manager' : 'sales', {salesId,displayName:'测试'}) });
  return { sqlite, scope, job };
}

test('recording quotes use the exact current transcript segment and idempotently share it within project scope', async () => {
  const { sqlite, scope } = fixture();
  try {
    const writer = scope('writer');
    const [first, repeated] = await Promise.all([writer.save({...target, text:'伪造的金句'}), writer.save(target)]);
    assert.equal(first.id, repeated.id);
    assert.equal(first.text, exactText);
    assert.equal(first.speaker, '讲话人 2');
    assert.deepEqual([first.start, first.end, first.recordingName], [3, 6, recording.name]);
    assert.equal(first.canDelete, true);
    assert.deepEqual((await writer.list()).quotes, [first]);
    assert.equal((await scope('reader').list()).quotes[0].canDelete, false);
    assert.deepEqual((await scope('other-sales','sales-2').list()).quotes, []);
    assert.deepEqual((await scope('other-owner','sales-1',true,'another').list()).quotes, []);
    await assert.rejects(scope('reader').remove(first.id), { status:403 });
    await assert.rejects(scope('other-sales','sales-2').save(target), { status:404 });
    await assert.rejects(writer.save({...target, jobId:'stale-job'}), { status:409 });
    await assert.rejects(writer.save({...target, segmentIndex:20}), { status:400 });
    await scope('manager','sales-1',true).remove(first.id);
    assert.deepEqual((await writer.list()).quotes, []);
  } finally { sqlite.close(); }
});

test('quote feed paginates without duplicates when excerpts share the same timestamp', async () => {
  const { sqlite, scope } = fixture();
  try {
    const store = scope('writer');
    await store.save(target);
    const createdAt = String(sqlite.prepare('SELECT created_at FROM workbench_recording_quotes').get()?.created_at);
    const insert = sqlite.prepare(`INSERT INTO workbench_recording_quotes
      (owner_id,id,deal_id,recording_id,job_id,segment_index,created_by,speaker,start_seconds,end_seconds,text,created_at)
      VALUES ('owner',?,'deal-1',?,'page-test',?,'writer','讲话人 2',3,6,?,?)`);
    for (let index = 0; index < 54; index++) insert.run(`fixture-${index}`, recording.id, index, exactText, createdAt);
    const first = await store.list();
    assert.equal(first.quotes.length, 50);
    assert.ok(first.nextCursor);
    const second = await store.list(first.nextCursor);
    assert.equal(second.quotes.length, 5);
    assert.equal(second.nextCursor, null);
    assert.equal(new Set([...first.quotes,...second.quotes].map(item=>item.id)).size, 55);
    await assert.rejects(store.list('invalid'), {status:400});
  } finally { sqlite.close(); }
});

test('recording quotes endpoints are available only to sales and sales managers', () => {
  for (const method of ['GET','POST','DELETE']) {
    assert.doesNotThrow(() => assertMemberApi('sales','/api/recording-quotes',method));
    assert.doesNotThrow(() => assertMemberApi('manager','/api/recording-quotes',method));
    assert.throws(() => assertMemberApi('admin','/api/recording-quotes',method), {status:403});
  }
});
