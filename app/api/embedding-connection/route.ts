import { DomainError } from '../../lib/domain.ts';
import {assertSameOrigin,readConnectionBody} from '../../lib/connection-config.ts';
import {embeddingSnapshot,executeEmbedding} from '../../lib/embedding-store.ts';
import {requireUserId,readRole,rebuildTalkIndex} from '../../lib/server.ts';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie, oai-authenticated-user-id'};
const failure=(e:unknown)=>Response.json({error:e instanceof DomainError?e.message:'向量配置暂时不可用'},{status:e instanceof DomainError?e.status:503,headers});
export async function GET(r:Request){try{return Response.json(await embeddingSnapshot(requireUserId(r)),{headers});}catch(e){return failure(e);}}
export async function POST(r:Request){try{const user=requireUserId(r);if(readRole(r)!=='manager')throw new DomainError('需要销售管理者设置',403);assertSameOrigin(r);const input=await readConnectionBody(r) as Record<string,unknown>;if(input.action==='reindex'){await rebuildTalkIndex(user,new URL(r.url).origin);return Response.json({...await embeddingSnapshot(user),message:'话术索引已重建'},{headers});}return Response.json(await executeEmbedding(user,input,new URL(r.url).origin),{headers});}catch(e){return failure(e);}}
