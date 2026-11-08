import {DomainError} from './domain.ts';
import {encryptConnectionSecret, decryptConnectionSecret} from './connection-config.ts';
import {createDigitalHumanProvider, ZegoProviderError} from './digital-human-provider.ts';
import type {ZegoCredentials} from './digital-human-provider.ts';
import {digitalHumanHash, digitalHumanId, digitalHumanPushUrl, digitalHumanRequestId, digitalHumanScript, digitalHumanText, digitalHumanVersion, PHOTO_LIMIT, VIDEO_LIMIT, publicDigitalHumanAsset, publicDigitalHumanLive} from './digital-human-config.ts';
import type {DigitalHumanStore} from './digital-human-store.ts';
import type {DigitalHumanAsset, DigitalHumanLive, DigitalHumanOperation, DigitalHumanSnapshot, StoredDigitalHumanAsset, StoredDigitalHumanLive, StoredDigitalHumanOperation} from './digital-human-types.ts';

type Result = {asset?: DigitalHumanAsset; live?: DigitalHumanLive; avatars?: Array<{digitalHumanId: string; name: string}>; total?: number; offset?: number};
const credentialKind = (member: string, liveId: string) => `zego-live:${member}:${liveId}`;
const pushKind = (member: string, liveId: string) => `zego-push:${member}:${liveId}`;

export function createDigitalHumanService(deps: {store: DigitalHumanStore; bucket?: R2Bucket; request?: typeof fetch; now?: () => number}) {
  const {store} = deps, now = deps.now ?? Date.now;
  const provider = createDigitalHumanProvider({request: deps.request, now});
  const timestamp = () => new Date(now()).toISOString();
  const encryptionKey = () => store.environment.CONFIG_ENCRYPTION_KEY ?? '';

  async function snapshot(owner: string, member: string): Promise<DigitalHumanSnapshot> {
    const assets = await store.listAssets(owner, member);
    const lives = await store.listLives(owner, member);
    const reconciled: StoredDigitalHumanLive[] = [];
    for (const live of lives) reconciled.push(await store.reconcile(owner, member, live, now()));
    return {assets: assets.map(publicDigitalHumanAsset), lives: reconciled.map(publicDigitalHumanLive), connection: await store.availability(owner)};
  }
  async function authorizedAvatar(owner: string, member: string, id: string) {
    const credentials = await store.credentials(owner), config = await store.connection(owner);
    const avatar = await provider.avatar(credentials, id);
    const fresh = await store.connection(owner);
    if (fresh.version !== config.version || !fresh.enabled || fresh.appId !== credentials.appId) throw new DomainError('ZEGO 连接已更新，请重新验证形象', 409);
    if (!avatar.isPublic && !fresh.avatarGrants.some(grant => grant.digitalHumanId === id && grant.memberId === member)) throw new DomainError('此私有形象尚未授权当前账号，请联系管理员', 403);
    return {avatar, credentials};
  }
  async function pinnedCredentials(live: StoredDigitalHumanLive): Promise<ZegoCredentials> {
    if (!live.credentialCiphertext) throw new DomainError('此实例缺少原始连接信息，请联系管理员核对', 409);
    const raw = await decryptConnectionSecret(live.credentialCiphertext, encryptionKey(), live.ownerId, credentialKind(live.memberId, live.id));
    const credentials = JSON.parse(raw) as ZegoCredentials;
    if (credentials.appId !== live.providerAppId || !credentials.serverSecret || !credentials.agentId) throw new DomainError('此实例原始连接信息无效', 409);
    return credentials;
  }
  async function createAsset(owner: string, member: string, input: Record<string, unknown>): Promise<Result> {
    const requestId = digitalHumanRequestId(input.requestId), name = digitalHumanText(input.name, 120), fileName = digitalHumanText(input.fileName, 180), sourceKind = input.sourceKind;
    if (!['photo', 'video'].includes(String(sourceKind)) || /[\\/]/.test(fileName)) throw new DomainError('源文件名称或类型无效');
    const mime = digitalHumanText(input.mime, 64).toLowerCase();
    const validMime = sourceKind === 'photo' ? ['image/png', 'image/jpeg'].includes(mime) : mime === 'video/mp4';
    const extension = fileName.split('.').at(-1)?.toLowerCase();
    if (!validMime || mime === 'image/png' && extension !== 'png' || mime === 'image/jpeg' && !['jpg', 'jpeg'].includes(extension ?? '') || mime === 'video/mp4' && extension !== 'mp4') throw new DomainError('仅支持 PNG/JPEG 照片和 MP4 视频，文件类型须一致', 415);
    if (!Number.isSafeInteger(input.size) || Number(input.size) < 12 || Number(input.size) > (sourceKind === 'photo' ? PHOTO_LIMIT : VIDEO_LIMIT)) throw new DomainError(sourceKind === 'photo' ? '照片须为20MiB以内的有效文件' : '视频须为100MiB以内的有效文件', 413);
    if (!deps.bucket) throw new DomainError('数字人私有文件存储尚未连接', 503);
    const payloadHash = await digitalHumanHash({name, fileName, sourceKind, mime, size: input.size});
    const existing = await store.assetIdentity(owner, member, requestId);
    if (existing) { if (existing.payloadHash !== payloadHash) throw new DomainError('相同提交标识的源文件已变化', 409); return {asset: publicDigitalHumanAsset(existing)}; }
    const time = timestamp();
    const asset: StoredDigitalHumanAsset = {id: `dh-asset-${crypto.randomUUID()}`, ownerId: owner, memberId: member, requestId, payloadHash, version: 1, name, fileName, sourceKind: sourceKind as 'photo' | 'video', mime, size: Number(input.size), status: 'uploading', createdAt: time, updatedAt: time};
    if (!await store.insertAsset(asset)) return createAsset(owner, member, input);
    return {asset: publicDigitalHumanAsset(asset)};
  }
  async function associateAvatar(owner: string, member: string, input: Record<string, unknown>): Promise<Result> {
    const id = digitalHumanId(input.digitalHumanId);
    if (input.action === 'bindAvatar') {
      let asset = await store.getAsset(owner, member, digitalHumanId(input.assetId));
      const readyExisting = asset.sourceKind === 'existing' && asset.status === 'ready';
      if (!readyExisting && (!asset.fileKey || !['awaiting_customization', 'ready'].includes(asset.status))) throw new DomainError('请先完整保存源文件，再关联即构返回的形象');
      const version = digitalHumanVersion(input.version);
      if (asset.version !== version) throw new DomainError('数字人记录已更新，请刷新后重试', 409);
      const {avatar, credentials} = await authorizedAvatar(owner, member, id);
      asset = await store.bindAsset({...asset, status: 'ready', digitalHumanId: id, digitalHumanName: avatar.name, verifiedAppId: credentials.appId, error: undefined}, version);
      return {asset: publicDigitalHumanAsset(asset)};
    }
    const requestId = digitalHumanRequestId(input.requestId), name = digitalHumanText(input.name, 120), payloadHash = await digitalHumanHash({name, digitalHumanId: id});
    const existing = await store.assetIdentity(owner, member, requestId);
    if (existing) { if (existing.payloadHash !== payloadHash) throw new DomainError('相同提交标识的形象已变化', 409); return {asset: publicDigitalHumanAsset(existing)}; }
    const {avatar, credentials} = await authorizedAvatar(owner, member, id), time = timestamp();
    const asset: StoredDigitalHumanAsset = {id: `dh-asset-${crypto.randomUUID()}`, ownerId: owner, memberId: member, requestId, payloadHash, version: 1, name, sourceKind: 'existing', status: 'ready', digitalHumanId: id, digitalHumanName: avatar.name, verifiedAppId: credentials.appId, createdAt: time, updatedAt: time};
    if (!await store.insertAsset(asset)) return associateAvatar(owner, member, input);
    return {asset: publicDigitalHumanAsset(asset)};
  }
  async function saveLive(owner: string, member: string, input: Record<string, unknown>): Promise<Result> {
    const requestId = digitalHumanRequestId(input.requestId), assetId = digitalHumanId(input.assetId), name = digitalHumanText(input.name, 120), platform = digitalHumanText(input.platform, 60);
    const asset = await store.getAsset(owner, member, assetId);
    if (asset.status !== 'ready' || !asset.digitalHumanId) throw new DomainError('请选择已经验证的数字人形象');
    let live = input.liveId ? await store.reconcile(owner, member, await store.getLive(owner, member, digitalHumanId(input.liveId)), now()) : null;
    if (live && (live.activeOperation || !['draft', 'stopped', 'error'].includes(live.status))) throw new DomainError('请先停止或核对当前实例，再修改直播配置', 409);
    const url = input.pushUrl === undefined || input.pushUrl === '' ? null : digitalHumanPushUrl(input.pushUrl);
    if (!live && !url) throw new DomainError('请填写直播平台提供的完整推流地址');
    const id = live?.id ?? `dh-live-${crypto.randomUUID()}`;
    const retained = live ? await decryptConnectionSecret(live.pushCiphertext, encryptionKey(), owner, pushKind(member, id)) : '';
    const clearUrl = url?.url ?? retained;
    const configHash = await digitalHumanHash({assetId, name, platform, pushUrl: clearUrl});
    if (live && live.configHash === configHash) return {live: publicDigitalHumanLive(live)};
    if (live && live.version !== digitalHumanVersion(input.version)) throw new DomainError('直播配置已更新，请刷新后重试', 409);
    const pushCiphertext = url ? await encryptConnectionSecret(url.url, encryptionKey(), owner, pushKind(member, id)) : live!.pushCiphertext;
    if (live) live = await store.saveLive({...live, assetId, name, platform, configHash, pushCiphertext, pushUrlDisplay: url?.display ?? live.pushUrlDisplay, status: 'draft', error: undefined, providerState: undefined}, live.version);
    else {
      const existing = await store.liveIdentity(owner, member, requestId);
      if (existing) { if (existing.payloadHash !== configHash) throw new DomainError('相同提交标识的直播配置已变化', 409); return {live: publicDigitalHumanLive(existing)}; }
      const time = timestamp();
      live = {id, ownerId: owner, memberId: member, requestId, payloadHash: configHash, configHash, version: 1, assetId, name, platform, pushCiphertext, pushUrlDisplay: url!.display, status: 'draft', createdAt: time, updatedAt: time};
      if (!await store.insertLive(live)) return saveLive(owner, member, input);
    }
    return {live: publicDigitalHumanLive(live)};
  }
  async function finishOperation(initial: StoredDigitalHumanOperation, credentials?: ZegoCredentials): Promise<StoredDigitalHumanLive> {
    let op = initial;
    async function persist() {
      try { await store.saveOperation(op); }
      catch (error) {
        // A write can commit before its acknowledgement is lost. Read it before retry/compensation.
        const durable = await store.operation(op.ownerId, op.memberId, op.requestId).catch(() => null);
        if (durable?.status === op.status && durable.payloadHash === op.payloadHash && durable.providerInstanceId === op.providerInstanceId) { op = durable; return; }
        throw error;
      }
    }
    // Retain external acceptance in the journal before touching the view row. Projection can reconcile later.
    try { await persist(); }
    catch {
      try { await persist(); }
      catch (error) {
        if (op.action !== 'startLive' || !op.providerInstanceId || !credentials) throw error;
        try { await provider.stop(credentials, op.providerInstanceId); op = {...op, compensated: true}; }
        catch { /* Keep the accepted instance ID so an explicit stop/query remains possible. */ }
        op = {...op, error: op.compensated ? '实例受理后保存中断，已停止本次实例；请刷新记录' : '实例已受理但保存中断，停止结果未确认；请查询实际状态'};
        await persist();
      }
    }
    return store.applyOperation(op);
  }
  async function mutateLive(owner: string, member: string, input: Record<string, unknown>): Promise<Result> {
    const id = digitalHumanId(input.liveId), requestId = digitalHumanRequestId(input.requestId), action = input.action as DigitalHumanOperation;
    const text = action === 'speak' ? digitalHumanScript(input.text) : undefined;
    if (text !== undefined && Array.from(text).length > 300) throw new DomainError('播报脚本最多300个字符');
    const previous = await store.operation(owner, member, requestId);
    let live = await store.reconcile(owner, member, await store.getLive(owner, member, id), now());
    if (action === 'speak' && input.generationId !== undefined && input.generationId !== live.generationRequestId) throw new DomainError('直播代次已更新，请刷新后重新确认播报', 409);
    const payloadHash = await digitalHumanHash({action, liveId: id, ...(text !== undefined ? {text, generationId: live.generationRequestId} : {})});
    if (previous) {
      if (previous.liveId !== id || previous.action !== action || previous.payloadHash !== payloadHash) throw new DomainError('相同提交标识的直播操作已变化', 409);
      return {live: publicDigitalHumanLive(live)};
    }
    if (live.version !== digitalHumanVersion(input.version) || live.activeOperation) throw new DomainError('直播操作正在处理或记录已更新', 409);
    let credentials: ZegoCredentials;
    let startupDigitalHumanId: string | undefined;
    let startupAssetVersion: number | undefined;
    if (action === 'startLive') {
      if (!['draft', 'stopped', 'error'].includes(live.status) || live.providerInstanceId) throw new DomainError('当前直播尚未停止或开播结果未知，禁止重复创建', 409);
      const asset = await store.getAsset(owner, member, live.assetId);
      if (asset.status !== 'ready' || !asset.digitalHumanId) throw new DomainError('数字人形象尚未准备好', 409);
      const authorized = await authorizedAvatar(owner, member, asset.digitalHumanId);
      credentials = authorized.credentials;
      if (!credentials.agentId) throw new DomainError('请管理员先配置已注册并包含 TTS 的 ZEGO AgentId', 503);
      startupDigitalHumanId = asset.digitalHumanId;
      startupAssetVersion = asset.version;
      if (asset.verifiedAppId !== credentials.appId) throw new DomainError('形象属于之前的 ZEGO AppId，请重新验证关联', 409);
      live = {...live, status: 'starting', generationRequestId: requestId, providerState: undefined, providerAppId: credentials.appId, providerInstanceId: undefined, credentialCiphertext: await encryptConnectionSecret(JSON.stringify(credentials), encryptionKey(), owner, credentialKind(member, id)), error: undefined};
    } else {
      if (action === 'speak' && !(await store.availability(owner)).enabled) throw new DomainError('ZEGO 服务已禁用，仍可查询或停止现有实例', 503);
      if (!live.providerInstanceId || action === 'speak' && live.status !== 'running' || action === 'stopLive' && !['running', 'stop_unknown'].includes(live.status)) throw new DomainError('当前实例状态不允许此操作，请先查询状态', 409);
      credentials = await pinnedCredentials(live);
      live = {...live, ...(action === 'stopLive' ? {status: 'stopping' as const} : {lastCommand: {requestId, status: 'sending' as const, text: text!, createdAt: timestamp()}}), error: undefined};
    }
    let op: StoredDigitalHumanOperation = {ownerId: owner, memberId: member, liveId: id, requestId, action, payloadHash, status: 'sending', ...(text ? {text, generationId: live.generationRequestId} : {}), ...(action === 'startLive' ? {credentialCiphertext: live.credentialCiphertext} : {providerInstanceId: live.providerInstanceId}), createdAt: timestamp()};
    live = await store.reserveOperation(live, op, startupAssetVersion);
    try {
      if (action === 'startLive') {
        const pushUrl = await decryptConnectionSecret(live.pushCiphertext, encryptionKey(), owner, pushKind(member, id));
        const providerInstanceId = await provider.start(credentials, startupDigitalHumanId!, pushUrl);
        op = {...op, status: 'accepted', providerInstanceId};
      } else if (action === 'speak') { await provider.speak(credentials, live.providerInstanceId!, text!); op = {...op, status: 'accepted'}; }
      else { await provider.stop(credentials, live.providerInstanceId!); op = {...op, status: 'accepted'}; }
    } catch (error) {
      if (action === 'stopLive' && error instanceof ZegoProviderError && error.code === 410001002) op = {...op, status: 'accepted'};
      else op = {...op, status: error instanceof ZegoProviderError && error.confirmed ? 'failed' : 'unknown', error: error instanceof ZegoProviderError ? error.message : '直播操作结果未确认，请查询现有实例；不会自动重复提交'};
    }
    return {live: publicDigitalHumanLive(await finishOperation(op, credentials))};
  }
  async function refreshLive(owner: string, member: string, input: Record<string, unknown>): Promise<Result> {
    const id = digitalHumanId(input.liveId); digitalHumanRequestId(input.requestId);
    let live = await store.reconcile(owner, member, await store.getLive(owner, member, id), now());
    if (live.activeOperation || ['starting', 'stopping', 'start_unknown', 'draft', 'stopped', 'error'].includes(live.status) || !live.providerInstanceId) return {live: publicDigitalHumanLive(live)};
    if (live.version !== digitalHumanVersion(input.version)) throw new DomainError('直播记录已更新，请刷新后重试', 409);
    const credentials = await pinnedCredentials(live);
    try {
      const state = await provider.query(credentials, live.providerInstanceId);
      live = await store.saveLive({...live, status: 'running', providerState: state, error: undefined}, live.version);
    } catch (error) {
      const current = await store.getLive(owner, member, id);
      if (current.version !== live.version) return {live: publicDigitalHumanLive(current)};
      if (error instanceof ZegoProviderError && error.code === 410001002) live = await store.saveLive({...live, status: 'stopped', providerInstanceId: undefined, providerState: undefined, error: '即构确认实例已不存在，可显式重新开播'}, live.version);
      else live = await store.saveLive({...live, error: error instanceof ZegoProviderError ? error.message : '实例状态暂时无法确认，请稍后查询'}, live.version);
    }
    return {live: publicDigitalHumanLive(live)};
  }
  async function execute(owner: string, member: string, input: Record<string, unknown>): Promise<Result> {
    if (input.action === 'createAsset') return createAsset(owner, member, input);
    if (input.action === 'bindAvatar' || input.action === 'addAvatar') return associateAvatar(owner, member, input);
    if (input.action === 'saveLive') return saveLive(owner, member, input);
    if (input.action === 'refreshLive') return refreshLive(owner, member, input);
    if (['startLive', 'stopLive', 'speak'].includes(String(input.action))) return mutateLive(owner, member, input);
    if (input.action === 'publicAvatars') {
      const offset = input.offset ?? 0;
      if (!Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > 10000) throw new DomainError('公共形象分页参数无效');
      return provider.publicAvatars(await store.credentials(owner), Number(offset));
    }
    throw new DomainError('数字人操作无效');
  }
  return {snapshot, execute};
}
export type DigitalHumanService = ReturnType<typeof createDigitalHumanService>;
