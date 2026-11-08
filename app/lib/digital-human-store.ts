import {DomainError} from './domain.ts';
import {encryptConnectionSecret, decryptConnectionSecret, encryptionReady} from './connection-config.ts';
import {createDigitalHumanProvider} from './digital-human-provider.ts';
import type {ZegoCredentials} from './digital-human-provider.ts';
import {digitalHumanId, digitalHumanText} from './digital-human-config.ts';
import type {DigitalHumanAvailability, DigitalHumanEnvironment, StoredDigitalHumanAsset, StoredDigitalHumanLive, StoredDigitalHumanOperation, ZegoConnection} from './digital-human-types.ts';

const CONNECTION_KIND = 'zego_digital_human';
type ConnectionRow = {enabled: number; model_name: string; secret_ciphertext: string; version: number};
type ConnectionMetadata = {appId: string; agentId: string; avatarGrants: ZegoConnection['avatarGrants']};

export function createDigitalHumanStore(environment: DigitalHumanEnvironment) {
  const db = () => { if (!environment.DB) throw new DomainError('数字人存储尚未连接', 503); return environment.DB; };
  const row = (owner: string) => db().prepare('SELECT enabled,model_name,secret_ciphertext,version FROM workbench_api_connections WHERE user_id=? AND kind=?').bind(owner, CONNECTION_KIND).first<ConnectionRow>();
  const metadata = (value: ConnectionRow | null): ConnectionMetadata => value ? JSON.parse(value.model_name) : {appId: '', agentId: '', avatarGrants: []};
  async function connection(owner: string): Promise<ZegoConnection> {
    const current = await row(owner), config = metadata(current);
    const storageReady = !!environment.DB && !!environment.BUCKET && encryptionReady(environment.CONFIG_ENCRYPTION_KEY);
    return {configured: !!current?.secret_ciphertext, enabled: current?.enabled === 1, storageReady, liveReady: !!current?.secret_ciphertext && current.enabled === 1 && storageReady && !!config.agentId, customizationMode: 'zego_platform', appId: config.appId, agentId: config.agentId, avatarGrants: config.avatarGrants ?? [], hasSecret: !!current?.secret_ciphertext, version: current?.version ?? 0};
  }
  async function availability(owner: string): Promise<DigitalHumanAvailability> {
    const {configured, enabled, storageReady, liveReady, customizationMode} = await connection(owner);
    return {configured, enabled, storageReady, liveReady, customizationMode};
  }
  async function credentials(owner: string): Promise<ZegoCredentials> {
    const current = await row(owner);
    if (!current?.enabled || !current.secret_ciphertext) throw new DomainError('请管理员先配置并启用 ZEGO 服务', 503);
    const config = metadata(current);
    return {appId: config.appId, agentId: config.agentId, serverSecret: await decryptConnectionSecret(current.secret_ciphertext, environment.CONFIG_ENCRYPTION_KEY ?? '', owner, CONNECTION_KIND)};
  }
  async function configure(owner: string, input: Record<string, unknown>, request: typeof fetch = fetch): Promise<ZegoConnection> {
    const current = await row(owner), previous = metadata(current);
    if (!Number.isSafeInteger(input.version) || input.version !== (current?.version ?? 0)) throw new DomainError('ZEGO 配置已更新，请刷新后重试', 409);
    if (!['save', 'test'].includes(String(input.action))) throw new DomainError('ZEGO 配置操作无效');
    const appId = digitalHumanText(input.appId, 10), agentId = input.agentId === undefined ? previous.agentId : digitalHumanText(input.agentId, 128, false);
    const agentCharacters = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()+-:;<=.>?@[]^_|~,');
    if ([...agentId].some(character => !agentCharacters.has(character))) throw new DomainError('ZEGO AgentId 格式无效');
    if (!/^[1-9]\d{0,9}$/.test(appId) || Number(appId) > 4294967295) throw new DomainError('ZEGO AppId 无效');
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new DomainError('ZEGO 启用状态无效');
    const rawSecret = input.secret === undefined ? '' : digitalHumanText(input.secret, 8192, false);
    if (/\s/.test(rawSecret)) throw new DomainError('ZEGO ServerSecret 格式无效');
    if (current && appId !== previous.appId && !rawSecret) throw new DomainError('更换 AppId 时请重新填写 ServerSecret');
    const secret = rawSecret || (current ? await decryptConnectionSecret(current.secret_ciphertext, environment.CONFIG_ENCRYPTION_KEY ?? '', owner, CONNECTION_KIND) : '');
    if (!secret) throw new DomainError('请填写 ZEGO ServerSecret');
    const grants = input.avatarGrants ?? previous.avatarGrants;
    if (!Array.isArray(grants) || grants.length > 200) throw new DomainError('私有形象授权列表无效');
    const seen = new Set<string>(), avatarGrants: ZegoConnection['avatarGrants'] = [];
    for (const grant of grants) {
      if (!grant || typeof grant !== 'object' || Array.isArray(grant)) throw new DomainError('私有形象授权无效');
      const digitalId = digitalHumanId(grant.digitalHumanId), memberId = digitalHumanId(grant.memberId);
      if (seen.has(digitalId)) throw new DomainError('同一私有形象只能授权一个业务账号');
      seen.add(digitalId);
      const member = await db().prepare("SELECT account_id FROM workbench_member_accounts WHERE owner_id=? AND account_id=? AND enabled=1 AND role IN ('sales','manager')").bind(owner, memberId).first();
      if (!member) throw new DomainError('形象授权账号不存在或已停用');
      avatarGrants.push({digitalHumanId: digitalId, memberId});
    }
    if (input.action === 'test') {
      await createDigitalHumanProvider({request}).publicAvatars({appId, agentId, serverSecret: secret}, 0);
      return connection(owner);
    }
    const encrypted = await encryptConnectionSecret(secret, environment.CONFIG_ENCRYPTION_KEY ?? '', owner, CONNECTION_KIND);
    const version = (current?.version ?? 0) + 1, config = JSON.stringify({appId, agentId, avatarGrants}), enabled = input.enabled === true ? 1 : 0;
    const changed = current ? await db().prepare('UPDATE workbench_api_connections SET enabled=?,model_name=?,secret_ciphertext=?,version=?,updated_at=? WHERE user_id=? AND kind=? AND version=?').bind(enabled, config, encrypted, version, new Date().toISOString(), owner, CONNECTION_KIND, input.version).run() : await db().prepare('INSERT INTO workbench_api_connections(user_id,kind,enabled,base_url,model_name,secret_ciphertext,version,updated_at) VALUES(?,?,?,\'https://aigc-digitalhuman-api.zegotech.cn\',?,?,?,?) ON CONFLICT DO NOTHING').bind(owner, CONNECTION_KIND, enabled, config, encrypted, version, new Date().toISOString()).run();
    if (changed.meta.changes !== 1) throw new DomainError('ZEGO 配置已更新，请刷新后重试', 409);
    return connection(owner);
  }
  async function getRecord<T>(table: string, owner: string, member: string, field: string, value: string): Promise<T | null> {
    const result = await db().prepare(`SELECT data_json FROM ${table} WHERE owner_id=? AND member_id=? AND ${field}=?`).bind(owner, member, value).first<{data_json: string}>();
    return result ? JSON.parse(result.data_json) as T : null;
  }
  async function required<T>(table: string, owner: string, member: string, id: string): Promise<T> {
    const value = await getRecord<T>(table, owner, member, 'id', id);
    if (!value) throw new DomainError('数字人记录不存在', 404);
    return value;
  }
  async function listRecord<T>(table: string, owner: string, member: string): Promise<T[]> {
    const result = await db().prepare(`SELECT data_json FROM ${table} WHERE owner_id=? AND member_id=? ORDER BY updated_at DESC LIMIT 60`).bind(owner, member).all<{data_json: string}>();
    return result.results.map(value => JSON.parse(value.data_json) as T);
  }
  function recordValues(value: StoredDigitalHumanAsset | StoredDigitalHumanLive) {
    return [value.id, value.ownerId, value.memberId, value.requestId, value.payloadHash, value.version, value.status, value.updatedAt, JSON.stringify(value)];
  }
  async function insertRecord(table: string, value: StoredDigitalHumanAsset | StoredDigitalHumanLive): Promise<boolean> {
    const result = await db().prepare(`INSERT INTO ${table}(id,owner_id,member_id,request_id,payload_hash,version,status,updated_at,data_json) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,member_id,request_id) DO NOTHING`).bind(...recordValues(value)).run();
    return result.meta.changes === 1;
  }
  async function saveRecord<T extends StoredDigitalHumanAsset | StoredDigitalHumanLive>(table: string, value: T, expected: number): Promise<T> {
    const next = {...value, version: expected + 1, updatedAt: new Date().toISOString()};
    const result = await db().prepare(`UPDATE ${table} SET version=?,status=?,updated_at=?,data_json=? WHERE owner_id=? AND member_id=? AND id=? AND version=?`).bind(next.version, next.status, next.updatedAt, JSON.stringify(next), next.ownerId, next.memberId, next.id, expected).run();
    if (result.meta.changes !== 1) throw new DomainError('数字人记录已更新，请刷新后重试', 409);
    return next;
  }
  const assets = 'workbench_digital_human_assets', lives = 'workbench_digital_human_lives', operations = 'workbench_digital_human_operations';
  const getAsset = (owner: string, member: string, id: string) => required<StoredDigitalHumanAsset>(assets, owner, member, id);
  const getLive = (owner: string, member: string, id: string) => required<StoredDigitalHumanLive>(lives, owner, member, id);
  const operation = (owner: string, member: string, requestId: string) => getRecord<StoredDigitalHumanOperation>(operations, owner, member, 'request_id', requestId);
  async function bindAsset(value: StoredDigitalHumanAsset, version: number): Promise<StoredDigitalHumanAsset> {
    const next = {...value, version: version + 1, updatedAt: new Date().toISOString()};
    const result = await db().prepare(`UPDATE ${assets} SET version=?,status=?,updated_at=?,data_json=? WHERE owner_id=? AND member_id=? AND id=? AND version=? AND NOT EXISTS(SELECT 1 FROM ${lives} l WHERE l.owner_id=? AND l.member_id=? AND json_extract(l.data_json,'$.assetId')=? AND (l.status NOT IN ('draft','stopped','error') OR json_extract(l.data_json,'$.activeOperation') IS NOT NULL))`).bind(next.version, next.status, next.updatedAt, JSON.stringify(next), next.ownerId, next.memberId, next.id, version, next.ownerId, next.memberId, next.id).run();
    if (result.meta.changes !== 1) throw new DomainError('形象正在直播或记录已更新，请先停止或核对实例再重新关联', 409);
    return next;
  }
  async function reserveOperation(live: StoredDigitalHumanLive, op: StoredDigitalHumanOperation, assetVersion?: number): Promise<StoredDigitalHumanLive> {
    const next = {...live, version: live.version + 1, activeOperation: op.requestId, updatedAt: new Date().toISOString()};
    const assetGuard = assetVersion === undefined ? '' : ` AND EXISTS(SELECT 1 FROM ${assets} a WHERE a.owner_id=? AND a.member_id=? AND a.id=? AND a.version=? AND a.status='ready')`;
    const assetValues = assetVersion === undefined ? [] : [live.ownerId, live.memberId, live.assetId, assetVersion];
    const results = await db().batch([
      db().prepare(`INSERT INTO ${operations}(owner_id,member_id,request_id,live_id,action,payload_hash,status,data_json) SELECT ?,?,?,?,?,?,?,? FROM ${lives} WHERE owner_id=? AND member_id=? AND id=? AND version=? AND json_extract(data_json,'$.activeOperation') IS NULL${assetGuard} ON CONFLICT DO NOTHING`).bind(op.ownerId, op.memberId, op.requestId, op.liveId, op.action, op.payloadHash, op.status, JSON.stringify(op), live.ownerId, live.memberId, live.id, live.version, ...assetValues),
      db().prepare(`UPDATE ${lives} SET version=?,status=?,updated_at=?,data_json=? WHERE owner_id=? AND member_id=? AND id=? AND version=? AND json_extract(data_json,'$.activeOperation') IS NULL AND EXISTS(SELECT 1 FROM ${operations} WHERE owner_id=? AND member_id=? AND request_id=? AND live_id=? AND action=? AND payload_hash=? AND status='sending')`).bind(next.version, next.status, next.updatedAt, JSON.stringify(next), live.ownerId, live.memberId, live.id, live.version, op.ownerId, op.memberId, op.requestId, op.liveId, op.action, op.payloadHash),
    ]);
    if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) throw new DomainError('直播操作正在处理或记录已更新', 409);
    return next;
  }
  async function saveOperation(value: StoredDigitalHumanOperation): Promise<void> {
    const result = await db().prepare(`UPDATE ${operations} SET status=?,data_json=? WHERE owner_id=? AND member_id=? AND request_id=? AND live_id=? AND payload_hash=? AND status IN ('sending','unknown')`).bind(value.status, JSON.stringify(value), value.ownerId, value.memberId, value.requestId, value.liveId, value.payloadHash).run();
    if (result.meta.changes !== 1) throw new DomainError('直播操作结果暂未安全保存，请刷新记录', 503);
  }
  async function applyOperation(value: StoredDigitalHumanOperation): Promise<StoredDigitalHumanLive> {
    const live = await getLive(value.ownerId, value.memberId, value.liveId);
    if (value.status === 'sending') return live;
    if (value.action === 'speak' && value.generationId !== live.generationRequestId) return live;
    const lateStart = value.action === 'startLive' && live.generationRequestId === value.requestId && live.status === 'start_unknown';
    const lateStop = value.action === 'stopLive' && live.status === 'stop_unknown' && live.providerInstanceId === value.providerInstanceId;
    const lateSpeech = value.action === 'speak' && live.lastCommand?.requestId === value.requestId && live.providerInstanceId === value.providerInstanceId;
    if (live.activeOperation !== value.requestId && (!lateStart && !lateStop && !lateSpeech || live.activeOperation)) return live;
    const next = {...live, activeOperation: undefined, error: value.error};
    if (value.action === 'startLive') {
      next.status = value.compensated ? 'stopped' : value.status === 'accepted' ? 'running' : value.status === 'unknown' ? 'start_unknown' : 'error';
      next.providerInstanceId = value.compensated ? undefined : value.providerInstanceId;
      next.credentialCiphertext = value.credentialCiphertext;
      if (value.status === 'accepted') next.lastCommand = undefined;
    } else if (value.action === 'stopLive') {
      next.status = value.status === 'accepted' ? 'stopped' : value.status === 'unknown' ? 'stop_unknown' : 'running';
      if (value.status === 'accepted') { next.providerInstanceId = undefined; next.providerState = undefined; }
    } else {
      next.lastCommand = {requestId: value.requestId, status: value.status, text: value.text ?? '', createdAt: value.createdAt};
    }
    return saveRecord(lives, next, live.version);
  }
  async function reconcile(owner: string, member: string, live: StoredDigitalHumanLive, now = Date.now()): Promise<StoredDigitalHumanLive> {
    if (!live.activeOperation) return live;
    const op = await operation(owner, member, live.activeOperation);
    if (op && op.liveId !== live.id) return live;
    if (op?.status === 'sending' && now - Date.parse(op.createdAt) > 60000) {
      const unknown: StoredDigitalHumanOperation = {...op, status: 'unknown', error: '上次操作结果未确认；请查询当前实例，禁止自动重提'};
      await saveOperation(unknown);
      return applyOperation(unknown);
    }
    return op && op.status !== 'sending' ? applyOperation(op) : live;
  }
  return {
    environment, connection, availability, credentials, configure,
    getAsset, getLive, operation, bindAsset, reserveOperation, saveOperation, applyOperation, reconcile,
    listAssets: (owner: string, member: string) => listRecord<StoredDigitalHumanAsset>(assets, owner, member),
    listLives: (owner: string, member: string) => listRecord<StoredDigitalHumanLive>(lives, owner, member),
    assetIdentity: (owner: string, member: string, requestId: string) => getRecord<StoredDigitalHumanAsset>(assets, owner, member, 'request_id', requestId),
    liveIdentity: (owner: string, member: string, requestId: string) => getRecord<StoredDigitalHumanLive>(lives, owner, member, 'request_id', requestId),
    insertAsset: (value: StoredDigitalHumanAsset) => insertRecord(assets, value),
    insertLive: (value: StoredDigitalHumanLive) => insertRecord(lives, value),
    saveAsset: (value: StoredDigitalHumanAsset, version: number) => saveRecord(assets, value, version),
    saveLive: (value: StoredDigitalHumanLive, version: number) => saveRecord(lives, value, version),
  };
}
export type DigitalHumanStore = ReturnType<typeof createDigitalHumanStore>;
