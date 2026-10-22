type VoiceEnvironment = { VOICE_GATEWAY_URL?: string; VOICE_GATEWAY_SECRET?: string };

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
export async function signVoiceSession(secret:string,userId:string,sessionId:string,now=Math.floor(Date.now()/1000)):Promise<string> {
  const encode=(value:unknown)=>base64url(new TextEncoder().encode(JSON.stringify(value)));
  const body=`${encode({alg:'HS256',typ:'JWT'})}.${encode({aud:'training-voice',sub:userId,sessionId,iat:now,exp:now+300,jti:crypto.randomUUID()})}`;
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return `${body}.${base64url(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(body))))}`;
}
