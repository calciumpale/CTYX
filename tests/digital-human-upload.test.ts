import test from 'node:test';
import assert from 'node:assert/strict';
import {digitalHumanFixture, pngBytes, uploadInput} from './digital-human-fixture.ts';
import {createDigitalHumanService} from '../app/lib/digital-human-service.ts';
import {uploadDigitalHumanSource, readDigitalHumanSource} from '../app/lib/digital-human-upload.ts';

test('source reservation, raw signature validation, loss-of-response retry and private ranges', async () => {
  const f = digitalHumanFixture();
  try {
    const service = createDigitalHumanService({store: f.store, bucket: f.bucket, request: async () => {throw new Error('upload must not call ZEGO');}, now: () => 10000});
    const {asset} = await service.execute('owner', 'alice', uploadInput);
    assert.ok(asset); assert.equal(asset.status, 'uploading'); assert.equal(asset.sourceUrl, undefined);
    const request = () => new Request('https://site.example/api/digital-humans/source', {method: 'PUT', headers: {'Content-Type': 'image/png'}, body: pngBytes});
    const completed = await uploadDigitalHumanSource(f.store, f.bucket, 'owner', 'alice', asset.id, asset.version, request(), () => 10000);
    assert.equal(completed.status, 'awaiting_customization'); assert.ok(completed.sourceUrl);
    const again = await uploadDigitalHumanSource(f.store, f.bucket, 'owner', 'alice', asset.id, asset.version, request(), () => 10000);
    assert.equal(again.id, asset.id); assert.equal(f.objects.size, 1);
    await assert.rejects(f.store.getAsset('owner', 'bob', asset.id), {status: 404});
    const response = await readDigitalHumanSource(f.store, f.bucket, 'owner', 'alice', asset.id, new Request('https://site.example/file', {headers: {Range: 'bytes=1-4'}}));
    assert.equal(response.status, 206); assert.deepEqual(new Uint8Array(await response.arrayBuffer()), pngBytes.subarray(1, 5));
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.equal((await readDigitalHumanSource(f.store, f.bucket, 'owner', 'alice', asset.id, new Request('https://site.example/file', {method: 'HEAD'}))).body, null);
    await assert.rejects(readDigitalHumanSource(f.store, f.bucket, 'owner', 'bob', asset.id, new Request('https://site.example/file')), {status: 404});
    assert.ok(!JSON.stringify(completed).includes((await f.store.getAsset('owner', 'alice', asset.id)).fileKey!));
  } finally {f.sqlite.close();}
});
test('invalid signature and size are failed honestly and may retry the same reservation', async () => {
  const f = digitalHumanFixture();
  try {
    const service = createDigitalHumanService({store: f.store, bucket: f.bucket});
    const {asset} = await service.execute('owner', 'alice', uploadInput); assert.ok(asset);
    await assert.rejects(uploadDigitalHumanSource(f.store, f.bucket, 'owner', 'alice', asset.id, asset.version, new Request('https://site.example', {method: 'PUT', headers: {'Content-Type': 'image/png'}, body: new Uint8Array(pngBytes.length)})), {status: 415});
    const failed = await f.store.getAsset('owner', 'alice', asset.id); assert.equal(failed.status, 'upload_failed'); assert.equal(f.objects.size, 0);
    const retried = await uploadDigitalHumanSource(f.store, f.bucket, 'owner', 'alice', asset.id, failed.version, new Request('https://site.example', {method: 'PUT', headers: {'Content-Type': 'image/png'}, body: pngBytes}));
    assert.equal(retried.status, 'awaiting_customization'); assert.equal(retried.id, asset.id);
    await assert.rejects(service.execute('owner', 'alice', {...uploadInput, requestId: 'oversized-source', size: 20 * 1024 * 1024 + 1}), {status: 413});
  } finally {f.sqlite.close();}
});

test('lost upload commit acknowledgement does not delete the committed private source', async () => {
  const f = digitalHumanFixture();
  try {
    const service = createDigitalHumanService({store: f.store, bucket: f.bucket});
    const {asset} = await service.execute('owner', 'alice', uploadInput); assert.ok(asset);
    const originalSave = f.store.saveAsset;
    f.store.saveAsset = async (value, version) => {
      const saved = await originalSave(value, version);
      if (value.status === 'awaiting_customization') throw new Error('lost commit acknowledgement');
      return saved;
    };
    const saved = await uploadDigitalHumanSource(f.store, f.bucket, 'owner', 'alice', asset.id, asset.version, new Request('https://site.example', {method: 'PUT', headers: {'Content-Type': 'image/png'}, body: pngBytes}));
    assert.equal(saved.status, 'awaiting_customization'); assert.equal(f.objects.size, 1);
    assert.equal((await readDigitalHumanSource(f.store, f.bucket, 'owner', 'alice', asset.id, new Request('https://site.example'))).status, 200);
  } finally {f.sqlite.close();}
});
test('expired upload attempts cannot replace or delete the newer attempt object', async () => {
  const f = digitalHumanFixture(); let finish: () => void = () => {};
  try {
    let clock = 10000, started: () => void = () => {}, puts = 0;
    const began = new Promise<void>(resolve => {started = resolve;});
    const bucket = {...f.bucket, async put(...args: Parameters<R2Bucket['put']>) { puts++; if (puts === 1) started(); return f.bucket.put(...args); }} as R2Bucket;
    const service = createDigitalHumanService({store: f.store, bucket});
    const {asset} = await service.execute('owner', 'alice', uploadInput); assert.ok(asset);
    const stream = new ReadableStream<Uint8Array>({start(controller) {controller.enqueue(pngBytes); finish = () => {controller.close(); finish = () => {};};}});
    const first = uploadDigitalHumanSource(f.store, bucket, 'owner', 'alice', asset.id, asset.version, new Request('https://site.example', {method: 'PUT', headers: {'Content-Type': 'image/png'}, body: stream, duplex: 'half'} as RequestInit), () => clock);
    await began; const claimed = await f.store.getAsset('owner', 'alice', asset.id);
    const file = () => new Request('https://site.example', {method: 'PUT', headers: {'Content-Type': 'image/png'}, body: pngBytes});
    await assert.rejects(uploadDigitalHumanSource(f.store, bucket, 'owner', 'alice', asset.id, claimed.version, file(), () => clock), {status: 409});
    clock += 300001;
    const current = await uploadDigitalHumanSource(f.store, bucket, 'owner', 'alice', asset.id, claimed.version, file(), () => clock);
    finish(); await assert.rejects(first, {status: 409});
    assert.equal(current.status, 'awaiting_customization'); assert.equal(f.objects.size, 1);
    const record = await f.store.getAsset('owner', 'alice', asset.id); assert.equal(record.version, current.version); assert.ok(f.objects.has(record.fileKey!));
  } finally {finish(); f.sqlite.close();}
});
test('large MP4 uploads are streamed with bounded read-ahead and exact byte limits', async () => {
  const f = digitalHumanFixture();
  try {
    const total = 80 * 1024 * 1024, chunkSize = 256 * 1024;
    let produced = 0, consumed = 0, ahead = 0;
    const bucket = {...f.bucket, async put(_key: string, body: ReadableStream<Uint8Array>) {
      assert.ok(body instanceof ReadableStream);
      const reader = body.getReader();
      while (true) {const {done, value} = await reader.read(); if (done) break; consumed += value.length; await Promise.resolve();}
      return {};
    }} as unknown as R2Bucket;
    const service = createDigitalHumanService({store: f.store, bucket});
    const {asset} = await service.execute('owner', 'alice', {...uploadInput, requestId: 'large-video-request', sourceKind: 'video', fileName: 'source.mp4', mime: 'video/mp4', size: total}); assert.ok(asset);
    const stream = new ReadableStream<Uint8Array>({pull(controller) {
      if (produced === total) {controller.close(); return;}
      const bytes = new Uint8Array(chunkSize); if (!produced) {bytes.set([0,0,0,16,102,116,121,112,105,115,111,109], 0);}
      produced += bytes.length; ahead = Math.max(ahead, produced - consumed); controller.enqueue(bytes);
    }});
    const result = await uploadDigitalHumanSource(f.store, bucket, 'owner', 'alice', asset.id, asset.version, new Request('https://site.example', {method: 'PUT', headers: {'Content-Type': 'video/mp4'}, body: stream, duplex: 'half'} as RequestInit));
    assert.equal(result.status, 'awaiting_customization'); assert.equal(consumed, total); assert.ok(ahead <= 5 * chunkSize, `read ahead ${ahead}`);
  } finally {f.sqlite.close();}
});

test('uncertain upload commit and failed verification read retain bytes for same-reservation recovery', async () => {
  const f = digitalHumanFixture();
  try {
    const service = createDigitalHumanService({store: f.store, bucket: f.bucket});
    const {asset} = await service.execute('owner', 'alice', uploadInput); assert.ok(asset);
    const originalSave = f.store.saveAsset, originalGet = f.store.getAsset;
    let committed = false, readFailed = false;
    f.store.saveAsset = async (value, version) => {
      const saved = await originalSave(value, version);
      if (value.fileKey) {committed = true; throw new Error('committed but acknowledgement lost');}
      return saved;
    };
    f.store.getAsset = async (...args) => {
      if (committed && !readFailed) {readFailed = true; throw new Error('temporary verification read outage');}
      return originalGet(...args);
    };
    const file = () => new Request('https://site.example', {method: 'PUT', headers: {'Content-Type': 'image/png'}, body: pngBytes});
    await assert.rejects(uploadDigitalHumanSource(f.store, f.bucket, 'owner', 'alice', asset.id, asset.version, file()), {status: 503});
    const stored = await originalGet('owner', 'alice', asset.id);
    assert.equal(stored.status, 'awaiting_customization'); assert.ok(stored.fileKey);
    assert.equal(f.objects.has(stored.fileKey), true, 'an unreadable commit cannot justify deleting possibly committed bytes');
    f.store.getAsset = originalGet; f.store.saveAsset = originalSave;
    const recovered = await service.execute('owner', 'alice', uploadInput);
    assert.equal(recovered.asset?.id, asset.id); assert.equal(recovered.asset?.status, 'awaiting_customization');
    const retried = await uploadDigitalHumanSource(f.store, f.bucket, 'owner', 'alice', asset.id, asset.version, file());
    assert.equal(retried.id, asset.id); assert.equal(f.objects.size, 1);
    const response = await readDigitalHumanSource(f.store, f.bucket, 'owner', 'alice', asset.id, new Request('https://site.example'));
    assert.equal(response.status, 200); assert.deepEqual(new Uint8Array(await response.arrayBuffer()), pngBytes);
  } finally {f.sqlite.close();}
});
