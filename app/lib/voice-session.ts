import {zlibSync} from 'fflate';
import type {SpeechHotword} from './speech-types.ts';
import {parseDuplexVoiceCatalog, type DuplexVoiceCatalog} from './duplex-voice.ts';
type VoiceEnvironment = { VOICE_GATEWAY_URL?: string; VOICE_GATEWAY_SECRET?: string };
type CatalogSocket = EventTarget & { accept(): void; send(data: string): void; close(code?: number): void };
type CatalogFetch = (url: string, init: RequestInit) => Promise<{ webSocket?: CatalogSocket | null }>;

export function gatewayConfiguration(environment: VoiceEnvironment,siteOrigin='https://production.invalid'): {url:string;secret:string}|null {
  const value=environment.VOICE_GATEWAY_URL?.trim();const secret=environment.VOICE_GATEWAY_SECRET;
  if(!value&&!secret)return null;
  if(!value||!secret||new TextEncoder().encode(secret).length<32)throw new Error('请完整配置语音网关地址与至少32字节的服务端共享密钥');
  let url:URL;try{url=new URL(value);}catch{throw new Error('语音网关地址格式不正确');}
  const loopback=(host:string)=>['127.0.0.1','localhost','[::1]'].includes(host);
  const site=new URL(siteOrigin);
  const local=url.protocol==='ws:'&&loopback(url.hostname)&&site.protocol==='http:'&&loopback(site.hostname);
  if((url.protocol!=='wss:'&&!local)||url.username||url.password||url.search||url.hash)throw new Error('语音网关须使用不含凭据或参数的WSS地址（本机HTTP调试仅允许回环WS）');
  return {url:url.href,secret};
}
function base64url(bytes:Uint8Array):string {
  let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
export async function signVoiceSession(secret:string,userId:string,sessionId:string,now=Math.floor(Date.now()/1000),hotwords:SpeechHotword[]=[],lifetimeSeconds=300):Promise<string> {
  const encode=(value:unknown)=>base64url(new TextEncoder().encode(JSON.stringify(value)));
  const active=hotwords.filter(word=>word.enabled).map(word=>({term:word.term,aliases:word.aliases,enabled:true}));
  const packed=active.length?zlibSync(new TextEncoder().encode(JSON.stringify(active))):null;
  if(packed&&packed.byteLength>7500)throw new Error('实时语音热词内容过长，请减少启用的热词或误识别写法');
  const body=`${encode({alg:'HS256',typ:'JWT'})}.${encode({aud:'training-voice',sub:userId,sessionId,iat:now,exp:now+lifetimeSeconds,jti:crypto.randomUUID(),...(packed?{speechProfile:base64url(packed)}:{})})}`;
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return `${body}.${base64url(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(body))))}`;
}

// The production gateway advertises its actual catalogue in the authenticated
// session.ready event. This short-lived server probe sends no PCM or TTS command.
export async function readGatewayVoiceCatalog(
  gateway: { url: string; secret: string }, siteOrigin: string, userId: string,
  request: CatalogFetch = fetch, signal?: AbortSignal,
): Promise<DuplexVoiceCatalog> {
  const url = new URL(gateway.url);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  const timeout = AbortSignal.timeout(4500);
  const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const unavailable = () => new Error('暂时无法提前读取实时音色。');
  abort.throwIfAborted();
  const token = await signVoiceSession(gateway.secret, userId, `catalog-${crypto.randomUUID()}`, Math.floor(Date.now() / 1000), [], 20);
  const response = await request(url.href, { headers: { Upgrade: 'websocket', Origin: siteOrigin }, redirect: 'manual', signal: abort });
  const socket = response.webSocket;
  if (!socket) throw unavailable();
  try {
    return await new Promise<DuplexVoiceCatalog>((resolve, reject) => {
      const failed = () => reject(unavailable());
      abort.addEventListener('abort', failed, { once: true });
      socket.addEventListener('error', failed, { once: true });
      socket.addEventListener('close', failed, { once: true });
      socket.addEventListener('message', event => {
        try {
          const value = (event as MessageEvent).data;
          if (typeof value !== 'string' || value.length > 200_000) return failed();
          const message = JSON.parse(value);
          if (message?.type !== 'session.ready') return failed();
          resolve(parseDuplexVoiceCatalog(message));
        } catch { failed(); }
      }, { once: true });
      abort.throwIfAborted();
      socket.accept();
      socket.send(JSON.stringify({ type: 'session.start', token }));
    });
  } finally {
    try { socket.close(1000); } catch { /* The gateway may have already closed. */ }
  }
}
