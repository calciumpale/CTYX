import { DomainError } from '../../../lib/domain.ts';
import { assertSalesReportOrigin, readSalesReportInput, runtimeSalesReportService, salesReportIdentity } from '../../../lib/sales-report-service.ts';
export const dynamic='force-dynamic';
/** Identity-less access is allowed only behind the existing owner-private Sites service gateway. */
export async function POST(request:Request){const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};try{
  assertSalesReportOrigin(request);const input=await readSalesReportInput(request,true);if(Object.keys(input).some(key=>key!=='cursor')||input.cursor!==undefined&&typeof input.cursor!=='string')throw new DomainError('日报任务只接受分页游标',400);
  const service=await runtimeSalesReportService(new URL(request.url).origin);
  if(request.headers.get('oai-authenticated-user-id')){if(input.cursor!==undefined)throw new DomainError('登录访问只能更新本账号日报',403);const owner=salesReportIdentity(request);const result=await service.generate(owner);const saved=(await service.list(owner,result.report.date)).report;if(!saved||saved.version!==result.report.version||saved.sourceHash!==result.report.sourceHash||saved.status!==result.report.status)throw new DomainError('日报保存后未能核对，请重新执行',503);const statuses={completed:0,running:0,waiting_config:0,failed:0};statuses[saved.status]++;return Response.json({date:result.report.date,processed:1,generated:result.report.status==='completed'&&!result.existing?1:0,existing:result.existing?1:0,waitingConfig:result.report.status==='waiting_config'?1:0,failed:result.report.status==='failed'?1:0,hasMore:false,readback:{date:result.report.date,verified:1,statuses}},{headers});}
  return Response.json(await service.dispatch(input.cursor as string|undefined),{headers});
}catch(error){return Response.json({error:error instanceof DomainError?error.message:'日报任务未完成，请稍后重试'},{status:error instanceof DomainError?error.status:503,headers});}}
