import {createHash, randomBytes} from 'node:crypto';
import type {DigitalHumanProviderState} from './digital-human-types.ts';

export interface ZegoCredentials {
  appId: string;
  agentId: string;
  serverSecret: string;
}
const actions = {
  GetDigitalHumanInfo: 'aigc-digitalhuman-api.zegotech.cn',
  GetDigitalHumanList: 'aigc-digitalhuman-api.zegotech.cn',
  CreateLiveDigitalHumanAgentInstance: 'aigc-aiagent-api.zegotech.cn',
  QueryAgentInstanceStatus: 'aigc-aiagent-api.zegotech.cn',
  SendAgentInstanceTTS: 'aigc-aiagent-api.zegotech.cn',
  DeleteAgentInstance: 'aigc-aiagent-api.zegotech.cn',
} as const;
type ZegoAction = keyof typeof actions;

/** Safe error metadata only. Provider bodies and signed request URLs are deliberately excluded. */
export class ZegoProviderError extends Error {
  code?: number;
  requestId?: string;
  confirmed: boolean;
  constructor(action: ZegoAction, options: {code?: number; requestId?: unknown; confirmed?: boolean} = {}) {
    const requestId = typeof options.requestId === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(options.requestId) ? options.requestId : undefined;
    super(`ZEGO ${action} 未完成${options.code !== undefined ? `（错误码 ${options.code}）` : ''}${requestId ? `，请求 ${requestId}` : ''}`);
    this.name = 'ZegoProviderError';
    this.code = options.code;
    this.requestId = requestId;
    this.confirmed = options.confirmed === true;
  }
}

export function zegoSignedUrl(action: ZegoAction, credentials: ZegoCredentials, now = Date.now(), nonce = randomBytes(8).toString('hex')): URL {
  const timestamp = String(Math.floor(now / 1000));
  const signature = createHash('md5').update(credentials.appId + nonce + credentials.serverSecret + timestamp).digest('hex');
  const url = new URL(`https://${actions[action]}/`);
  for (const [key, value] of Object.entries({Action: action, AppId: credentials.appId, SignatureNonce: nonce, Timestamp: timestamp, Signature: signature, SignatureVersion: '2.0'})) url.searchParams.set(key, value);
  return url;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,200}$/.test(value);
}
function avatarInfo(value: unknown, action: ZegoAction) {
  if (!record(value) || !identifier(value.DigitalHumanId) || typeof value.Name !== 'string' || typeof value.IsPublic !== 'boolean') throw new ZegoProviderError(action);
  return {digitalHumanId: value.DigitalHumanId, name: value.Name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200), isPublic: value.IsPublic};
}

export function createDigitalHumanProvider(deps: {request?: typeof fetch; now?: () => number; nonce?: () => string} = {}) {
  const request = deps.request ?? fetch;
  async function call(credentials: ZegoCredentials, action: ZegoAction, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      const response = await request(zegoSignedUrl(action, credentials, deps.now?.() ?? Date.now(), deps.nonce?.()), {
        method: 'POST', redirect: 'manual', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
      });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new ZegoProviderError(action); }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const {done, value} = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 128 * 1024) { await reader.cancel(); throw new ZegoProviderError(action); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const result: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!record(result) || !Number.isSafeInteger(result.Code)) throw new ZegoProviderError(action);
      if (result.Code !== 0) throw new ZegoProviderError(action, {code: result.Code as number, requestId: result.RequestId, confirmed: true});
      if (action === 'DeleteAgentInstance') return {};
      if (!record(result.Data)) throw new ZegoProviderError(action);
      return result.Data;
    } catch (error) {
      if (error instanceof ZegoProviderError) throw error;
      throw new ZegoProviderError(action);
    }
  }
  return {
    async avatar(credentials: ZegoCredentials, digitalHumanId: string) {
      const info = avatarInfo(await call(credentials, 'GetDigitalHumanInfo', {DigitalHumanId: digitalHumanId}), 'GetDigitalHumanInfo');
      if (info.digitalHumanId !== digitalHumanId) throw new ZegoProviderError('GetDigitalHumanInfo');
      return info;
    },
    async publicAvatars(credentials: ZegoCredentials, offset: number) {
      const data = await call(credentials, 'GetDigitalHumanList', {FetchMode: 2, Offset: offset, Limit: 20});
      if (!Number.isSafeInteger(data.Total) || Number(data.Total) < 0 || !Array.isArray(data.DigitalHumans) || data.DigitalHumans.length > 20) throw new ZegoProviderError('GetDigitalHumanList');
      const avatars = data.DigitalHumans.map(value => avatarInfo(value, 'GetDigitalHumanList')).filter(value => value.isPublic).map(({digitalHumanId, name}) => ({digitalHumanId, name}));
      return {avatars, total: Number(data.Total), offset};
    },
    async start(credentials: ZegoCredentials, digitalHumanId: string, pushUrl: string) {
      const data = await call(credentials, 'CreateLiveDigitalHumanAgentInstance', {
        AgentId: credentials.agentId,
        DigitalHuman: {DigitalHumanId: digitalHumanId, ConfigId: 'web', EncodeCode: 'H264', AlphaMode: 1},
        CDN: {Url: pushUrl}, AdvancedConfig: {MaxIdleTime: 120},
      });
      if (!identifier(data.AgentInstanceId)) throw new ZegoProviderError('CreateLiveDigitalHumanAgentInstance');
      return data.AgentInstanceId;
    },
    async query(credentials: ZegoCredentials, instance: string): Promise<DigitalHumanProviderState> {
      const data = await call(credentials, 'QueryAgentInstanceStatus', {AgentInstanceId: instance});
      if (!['IDLE', 'LISTENING', 'THINKING', 'SPEAKING'].includes(String(data.Status))) throw new ZegoProviderError('QueryAgentInstanceStatus');
      return data.Status as DigitalHumanProviderState;
    },
    async speak(credentials: ZegoCredentials, instance: string, text: string) {
      const data = await call(credentials, 'SendAgentInstanceTTS', {AgentInstanceId: instance, Text: text, AddHistory: false, Priority: 'Medium', SamePriorityOption: 'Enqueue'});
      if (typeof data.Round !== 'number' || !Number.isFinite(data.Round)) throw new ZegoProviderError('SendAgentInstanceTTS');
    },
    async stop(credentials: ZegoCredentials, instance: string) {
      await call(credentials, 'DeleteAgentInstance', {AgentInstanceId: instance, GracefulShutdown: false});
    },
  };
}
export type DigitalHumanProvider = ReturnType<typeof createDigitalHumanProvider>;
