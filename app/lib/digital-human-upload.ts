import {createHash} from 'node:crypto';
import {DomainError} from './domain.ts';
import {digitalHumanHash, publicDigitalHumanAsset} from './digital-human-config.ts';
import {parseAudioRange} from './followup-recordings.ts';
import type {DigitalHumanStore} from './digital-human-store.ts';
import type {StoredDigitalHumanAsset} from './digital-human-types.ts';

export const digitalHumanPrivateHeaders = {'Cache-Control': 'private, no-store', Vary: 'Cookie, oai-authenticated-user-id', 'X-Content-Type-Options': 'nosniff'};
function validHeader(bytes: Uint8Array, mime: string): boolean {
  if (mime === 'image/png') return [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
  if (mime === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === 'video/mp4') {
    const boxSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    return boxSize >= 16 && boxSize <= 1024 * 1024 && new TextDecoder().decode(bytes.subarray(4, 8)) === 'ftyp';
  }
  return false;
}

/** Validate and hash every incoming byte while R2 consumes it with backpressure. */
export async function uploadDigitalHumanSource(store: DigitalHumanStore, bucket: R2Bucket, owner: string, member: string, id: string, version: number, request: Request, now = Date.now) {
  let asset = await store.getAsset(owner, member, id);
  if (asset.fileKey && ['awaiting_customization', 'ready'].includes(asset.status)) { await request.body?.cancel(); return publicDigitalHumanAsset(asset); }
  if (asset.sourceKind === 'existing') throw new DomainError('已有形象不接受源文件上传');
  if (asset.version !== version) throw new DomainError('源文件记录已更新，请刷新后重试', 409);
  if (asset.uploadToken && (asset.uploadUntil ?? 0) > now()) throw new DomainError('源文件仍在上传，请等待后刷新记录', 409);
  if (!request.body) throw new DomainError('请选择源文件');
  const mime = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (mime !== asset.mime) throw new DomainError('上传类型与已选源文件不一致', 415);
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) !== asset.size)) throw new DomainError('上传大小与已选源文件不一致', 413);
  const token = crypto.randomUUID();
  asset = await store.saveAsset({...asset, status: 'uploading', error: undefined, uploadToken: token, uploadUntil: now() + 5 * 60 * 1000}, asset.version);
  const key = `digital-humans/${await digitalHumanHash(owner)}/${await digitalHumanHash(member)}/${id}/${token}`;
  const reader = request.body.getReader(), digest = createHash('sha256');
  const header = new Uint8Array(12), pending: Uint8Array[] = [];
  let count = 0, headerLength = 0, checked = false, complete = false;
  const validated = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          const {done, value} = await reader.read();
          if (done) {
            if (!checked || count !== asset.size) throw new DomainError('源文件为空、格式无效或字节数不一致', checked ? 413 : 415);
            complete = true; controller.close(); return;
          }
          count += value.byteLength;
          if (count > (asset.size ?? 0)) throw new DomainError('上传字节数超过已选文件大小', 413);
          digest.update(value);
          if (!checked) {
            const length = Math.min(12 - headerLength, value.length);
            header.set(value.subarray(0, length), headerLength); headerLength += length;
            pending.push(value);
            if (headerLength < 12) continue;
            if (!validHeader(header, asset.mime!)) throw new DomainError('源文件内容与 PNG/JPEG/MP4 类型不一致', 415);
            checked = true;
            for (const part of pending) controller.enqueue(part);
            pending.length = 0;
          } else controller.enqueue(value);
          return;
        }
      } catch (error) { await reader.cancel().catch(() => {}); controller.error(error); }
    },
    async cancel(reason) { await reader.cancel(reason).catch(() => {}); },
  }, {highWaterMark: 1});
  const fixed = typeof FixedLengthStream === 'function' ? new FixedLengthStream(asset.size!) : new TransformStream<Uint8Array, Uint8Array>();
  const cancellation = new AbortController();
  const timer = setTimeout(() => cancellation.abort(), 120000);
  const pump = validated.pipeTo(fixed.writable, {signal: cancellation.signal});
  try {
    const put = bucket.put(key, fixed.readable, {httpMetadata: {contentType: asset.mime!}});
    await Promise.all([pump, put]);
    if (!complete) throw new DomainError('源文件尚未完整上传', 503);
    const current = await store.getAsset(owner, member, id);
    if (current.version !== asset.version || current.uploadToken !== token) throw new DomainError('上传租约已更新，旧上传不会覆盖新文件', 409);
    const next: StoredDigitalHumanAsset = {...asset, status: 'awaiting_customization', fileKey: key, sourceHash: digest.digest('hex'), uploadToken: undefined, uploadUntil: undefined, error: undefined};
    return publicDigitalHumanAsset(await store.saveAsset(next, asset.version));
  } catch (error) {
    cancellation.abort();
    await reader.cancel().catch(() => {});
    // A database acknowledgement can be lost after a successful commit. Never delete its referenced object.
    let definitelyUnreferenced = false;
    try {
      const committed = await store.getAsset(owner, member, id);
      if (committed.fileKey === key && ['awaiting_customization', 'ready'].includes(committed.status)) return publicDigitalHumanAsset(committed);
      definitelyUnreferenced = committed.fileKey !== key;
    } catch { /* An unreadable record cannot establish whether this object was committed. */ }
    if (!definitelyUnreferenced) throw new DomainError('源文件保存结果暂未确认，请稍后刷新同一记录；不会删除可能已保存的文件', 503);
    await bucket.delete(key).catch(() => {});
    try { await store.saveAsset({...asset, status: 'upload_failed', uploadToken: undefined, uploadUntil: undefined, error: '源文件未安全保存，请刷新记录后重试相同文件'}, asset.version); } catch { /* A newer upload owns the record. */ }
    if (error instanceof DomainError) throw error;
    throw new DomainError('源文件上传未完成，请刷新记录后重试', 503);
  } finally { clearTimeout(timer); reader.releaseLock(); }
}

export async function readDigitalHumanSource(store: DigitalHumanStore, bucket: R2Bucket, owner: string, member: string, id: string, request: Request): Promise<Response> {
  const asset = await store.getAsset(owner, member, id);
  if (!asset.fileKey || !asset.mime || !asset.size) throw new DomainError('源文件尚未完整保存', 404);
  const metadata = await bucket.head(asset.fileKey);
  if (!metadata || metadata.size !== asset.size) throw new DomainError('源文件暂时无法读取', 404);
  let range: {offset: number; length: number} | undefined;
  if (request.headers.has('range')) {
    try { range = parseAudioRange(request.headers.get('range')!, asset.size); }
    catch { return new Response(null, {status: 416, headers: {...digitalHumanPrivateHeaders, 'Content-Range': `bytes */${asset.size}`}}); }
  }
  const headers = {...digitalHumanPrivateHeaders, 'Content-Type': asset.mime, 'Content-Length': String(range?.length ?? asset.size), 'Accept-Ranges': 'bytes', 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(asset.fileName ?? 'source')}`, ...(range ? {'Content-Range': `bytes ${range.offset}-${range.offset + range.length - 1}/${asset.size}`} : {})};
  if (request.method === 'HEAD') return new Response(null, {status: range ? 206 : 200, headers});
  const object = await bucket.get(asset.fileKey, range ? {range} : undefined);
  if (!object) throw new DomainError('源文件暂时无法读取', 404);
  return new Response(object.body, {status: range ? 206 : 200, headers});
}
