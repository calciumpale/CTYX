import {DomainError} from '../../../lib/domain.ts';
import {assertSameOrigin} from '../../../lib/connection-config.ts';
import {digitalHumanId, digitalHumanVersion} from '../../../lib/digital-human-config.ts';
import {digitalHumanFailure, digitalHumanIdentity, digitalHumanRuntime} from '../../../lib/digital-human-runtime.ts';
import {digitalHumanPrivateHeaders, uploadDigitalHumanSource, readDigitalHumanSource} from '../../../lib/digital-human-upload.ts';

export const dynamic = 'force-dynamic';
export async function PUT(request: Request) {
  try {
    const {owner, member} = digitalHumanIdentity(request); assertSameOrigin(request);
    const url = new URL(request.url), assetId = digitalHumanId(url.searchParams.get('assetId'));
    const rawVersion = url.searchParams.get('version');
    if (!rawVersion || !/^\d+$/.test(rawVersion)) throw new DomainError('源文件记录版本无效', 409);
    const version = digitalHumanVersion(Number(rawVersion)), runtime = digitalHumanRuntime();
    if (!runtime.bucket) throw new DomainError('数字人私有文件存储尚未连接', 503);
    const asset = await uploadDigitalHumanSource(runtime.store, runtime.bucket, owner, member, assetId, version, request);
    return Response.json({asset}, {headers: digitalHumanPrivateHeaders});
  } catch (error) { return digitalHumanFailure(error); }
}
async function read(request: Request) {
  try {
    const {owner, member} = digitalHumanIdentity(request), runtime = digitalHumanRuntime();
    const assetId = digitalHumanId(new URL(request.url).searchParams.get('assetId'));
    if (!runtime.bucket) throw new DomainError('数字人私有文件存储尚未连接', 503);
    return await readDigitalHumanSource(runtime.store, runtime.bucket, owner, member, assetId, request);
  } catch (error) {
    const response = digitalHumanFailure(error);
    return request.method === 'HEAD' ? new Response(null, {status: response.status, headers: response.headers}) : response;
  }
}
export const GET = read;
export const HEAD = read;
