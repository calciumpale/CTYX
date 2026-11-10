import test from 'node:test';
import assert from 'node:assert/strict';
import { createMineruTicket, readMineruTicket, readMineruUpload } from '../app/lib/knowledge-mineru.ts';
import { KNOWLEDGE_FILE_LIMIT } from '../app/lib/knowledge-library-types.ts';
import { assertMemberApi } from '../app/lib/member-policy.ts';

const endpoint = 'https://workbench.example/api/knowledge-mineru';
const key = '1234567890abcdef'.repeat(4);
const identity = { ownerId: 'workspace', memberId: 'manager' };

function upload(file: File) {
  const form = new FormData();
  form.set('file', file);
  return new Request(endpoint, { method: 'POST', body: form });
}

test('MinerU parsing and credential configuration use their respective member permissions', () => {
  for (const method of ['GET', 'POST']) {
    for (const role of ['admin', 'manager'] as const) assert.doesNotThrow(() => assertMemberApi(role, '/api/knowledge-mineru', method));
    assert.throws(() => assertMemberApi('sales', '/api/knowledge-mineru', method), { status: 403 });
    assert.doesNotThrow(() => assertMemberApi('admin', '/api/mineru-connection', method));
    assert.throws(() => assertMemberApi('manager', '/api/mineru-connection', method), { status: 403 });
  }
});

test('MinerU accepts only bounded PDF uploads and rejects renamed or oversized files', async () => {
  const original = new File(['%PDF-1.7\n'], '测试.PDF');
  assert.equal((await readMineruUpload(upload(original))).name, original.name);
  await assert.rejects(readMineruUpload(upload(new File(['fake'], 'fake.pdf'))), { status: 400 });
  await assert.rejects(readMineruUpload(upload(new File(['%PDF-1.7'], 'not.pdf.txt'))), { status: 400 });
  const oversized = new File(['%PDF-1.7', new Uint8Array(KNOWLEDGE_FILE_LIMIT)], 'large.pdf');
  await assert.rejects(readMineruUpload(upload(oversized)), { status: 413 });
});

test('a MinerU ticket hides its batch ID and cannot be replayed by another workspace or member', async () => {
  const now = 1_800_000_000_000;
  const ticket = await createMineruTicket('batch-123', key, identity, now);
  assert.doesNotMatch(ticket, /batch-123/);
  assert.equal(await readMineruTicket(ticket, key, identity, now + 500), 'batch-123');
  await assert.rejects(readMineruTicket(ticket, key, { ...identity, memberId: 'other' }, now), { status: 400 });
  await assert.rejects(readMineruTicket(ticket, key, { ...identity, ownerId: 'other' }, now), { status: 400 });
  await assert.rejects(readMineruTicket(`${ticket}.fake`, key, identity, now), { status: 400 });
  await assert.rejects(readMineruTicket(ticket, key, identity, now + 61 * 60_000), { status: 410 });
});
