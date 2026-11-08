import {env} from 'cloudflare:workers';
import dataset from '../../../data/prospect-companies/2026-11-08.json';
import {DomainError} from '../../lib/domain.ts';
import {assertMemberOrigin,createMemberAuthStore,memberFailure,memberResponseHeaders,outerOwnerId,readMemberBody} from '../../lib/member-auth.ts';
import {previewDepartmentSetup,applyDepartmentSetup} from '../../lib/workspace-departments-store.ts';
import {validateSetupBody,verifySetupCapability} from '../../lib/workspace-setup-service.ts';
import type {SetupManifest} from '../../lib/workspace-departments-store.ts';
export const dynamic='force-dynamic';
export async function POST(request:Request){try{assertMemberOrigin(request);const body=await readMemberBody(request);validateSetupBody(body);const environment=env as Cloudflare.Env;const db=environment.DB;if(!db)throw new DomainError('数据库尚未连接',503);let ownerId:string;const capability=request.headers.get('x-ctai-setup-capability');if(capability){const verified=await verifySetupCapability(capability,environment.CONFIG_ENCRYPTION_KEY??'',body);ownerId=verified.ownerId;const outer=request.headers.get('oai-authenticated-user-id');if(outer&&outer!==ownerId)throw new DomainError('初始化归属不匹配',403);}else{ownerId=outerOwnerId(request);const member=await createMemberAuthStore({DB:db}).authenticate(ownerId,request.headers.get('cookie'));if(member?.role!=='admin')throw new DomainError('仅管理员可以初始化',403);}
 const result=body.action==='preview'?await previewDepartmentSetup(db,ownerId,dataset):await applyDepartmentSetup(db,ownerId,dataset,body.expectedManifest as SetupManifest);return Response.json(result,{headers:memberResponseHeaders});}catch(error){return memberFailure(error);}}
