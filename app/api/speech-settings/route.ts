import {env} from 'cloudflare:workers';
import {DomainError} from '../../lib/domain.ts';
import {assertSameOrigin} from '../../lib/connection-config.ts';
import {createSpeechSettingsStore,readSpeechJson,speechCapabilities} from '../../lib/speech-settings.ts';
import {requireUserId} from '../../lib/server.ts';

export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie, oai-authenticated-user-id','X-Content-Type-Options':'nosniff'};
const failure=(error:unknown)=>Response.json({error:error instanceof DomainError?error.message:'语音设置暂时无法读取或保存，请稍后重试'},{status:error instanceof DomainError?error.status:503,headers});
export async function GET(request:Request){try{const userId=requireUserId(request);return Response.json(await createSpeechSettingsStore(env as Cloudflare.Env).snapshot(userId,new URL(request.url).origin),{headers});}catch(error){return failure(error);}}
export async function POST(request:Request){try{const userId=requireUserId(request);assertSameOrigin(request);if(!request.headers.get('content-type')?.startsWith('application/json'))throw new DomainError('请使用 JSON 格式提交语音设置',415);const input=await readSpeechJson(new Response(request.body),64000),environment=env as Cloudflare.Env;const settings=await createSpeechSettingsStore(environment).save(userId,input);return Response.json({...settings,capabilities:await speechCapabilities(environment,new URL(request.url).origin)},{headers});}catch(error){return failure(error);}}
