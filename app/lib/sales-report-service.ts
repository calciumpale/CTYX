import { DomainError } from './domain.ts';
import {requireMemberRole} from './member-policy.ts';
import { readEffectiveModel } from './connection-store.ts';
import { requestModelText } from './model-client.ts';
import type { EffectiveModel } from './connection-config.ts';
import type { ModelMessage } from './model-client.ts';
import { buildSalesSnapshot, salesDay, salesDayBounds, salesModelMessages, validateSalesNarrative } from './sales-report-domain.ts';
import { createSalesReportStore } from './sales-report-store.ts';
import type { SalesReport, SalesReportDispatch, SalesReportList } from './sales-report-types.ts';

interface Options {now?:()=>string;modelFor?:(ownerId:string)=>Promise<EffectiveModel|null>;generateText?:(model:EffectiveModel,messages:ModelMessage[])=>Promise<string>;}
export function salesReportIdentity(request:Request):string{
  const id=request.headers.get('oai-authenticated-user-id');if(!id||id.length>512||!request.headers.get('oai-authenticated-user-email'))throw new DomainError('请先使用平台账号登录',401);
  if(requireMemberRole(request)!=='manager')throw new DomainError('需要销售管理者权限',403);return id;
}
export function assertSalesReportOrigin(request:Request):void{const origin=request.headers.get('origin');if(origin&&origin!==new URL(request.url).origin||request.headers.get('sec-fetch-site')==='cross-site')throw new DomainError('只允许从当前站点发起操作',403);}
export async function readSalesReportInput(request:Request,allowEmpty=false):Promise<Record<string,unknown>>{
  const json=request.headers.get('content-type')?.toLowerCase().includes('application/json');if(!allowEmpty&&!json)throw new DomainError('请使用JSON格式提交日报操作',415);
  if(Number(request.headers.get('content-length')??0)>2000)throw new DomainError('日报请求过大',413);
  const reader=request.body?.getReader();if(!reader){if(allowEmpty)return {};throw new DomainError('日报请求不能为空',400);}
  const chunks:Uint8Array[]=[];let size=0;try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2000){await reader.cancel();throw new DomainError('日报请求过大',413);}chunks.push(value);}}finally{reader.releaseLock();}
  if(!size&&allowEmpty)return {};if(!json)throw new DomainError('请使用JSON格式提交日报操作',415);const bytes=new Uint8Array(size);let position=0;for(const chunk of chunks){bytes.set(chunk,position);position+=chunk.byteLength;}
  let value:unknown;try{value=JSON.parse(new TextDecoder().decode(bytes));}catch{throw new DomainError('日报请求格式不正确',400);}if(!value||typeof value!=='object'||Array.isArray(value))throw new DomainError('日报请求格式不正确',400);return value as Record<string,unknown>;
}
export function createSalesReportService(db:D1Database,options:Options={}){
  const store=createSalesReportStore(db);const clock=options.now??(()=>new Date().toISOString());
  async function list(ownerId:string,date?:string):Promise<SalesReportList>{const now=clock(),today=salesDay(now);if(date)salesDayBounds(date);const [item,reports,coverageStart]=await Promise.all([store.get(ownerId,date??today),store.list(ownerId),store.coverage(ownerId)]);let report=item?.report??null;if(report?.status==='running'&&Date.parse(item?.leaseUntil??'')<=Date.parse(now))report={...report,retryable:true,message:'上次日报执行已超时，已保存的事实快照仍保留，请重试。'};return {report,reports,coverageStart,today};}
  async function generate(ownerId:string,date=salesDay(clock()),action:'generate'|'retry'|'regenerate'='generate'):Promise<{report:SalesReport;message:string;existing:boolean}>{
    const now=clock();salesDayBounds(date);if(date>salesDay(now))throw new DomainError('不能提前生成未来日报',400);
    const current=await store.get(ownerId,date);const expired=current?.report.status==='running'&&Date.parse(current.leaseUntil??'')<=Date.parse(now);
    if(current&&!expired&&(current.report.status==='running'||action==='generate'||action==='retry'&&current.report.status==='completed'))return {report:current.report,message:current.report.status==='running'?'日报正在生成，请稍后刷新':'该日期日报已保存',existing:true};
    let snapshot=current?.report.snapshot;
    if(!snapshot||action==='regenerate'){
      snapshot=undefined;
      for(let attempt=0;attempt<3;attempt++){
        const state=await store.workspace(ownerId);const capturedAt=clock();const coverageStart=await store.coverage(ownerId,capturedAt)??capturedAt;const [source,pending]=await Promise.all([store.events(ownerId,date,capturedAt),store.pendingApprovals(ownerId)]);
        if((await store.workspace(ownerId)).revision!==state.revision)continue;
        snapshot=buildSalesSnapshot(state,source.events,source.counts,date,capturedAt,coverageStart,pending,source.ownerCounts);break;
      }
      if(!snapshot)throw new DomainError('项目记录正在更新，尚未生成日报；请稍后重试',409);
    }
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(snapshot)));const sourceHash=[...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
    let report:SalesReport={date,status:'running',mode:'facts',generatedAt:now,updatedAt:now,version:(current?.report.version??0)+1,sourceHash,snapshot,message:'正在整理已保存的销售记录'};
    const token=await store.claim(ownerId,date,report,current?.report.version??0,now);
    if(!token){const winner=await store.get(ownerId,date);if(!winner)throw new DomainError('日报任务尚未取得执行权，请刷新后重试',409);return {report:winner.report,message:'该日期的日报任务已由另一请求处理',existing:true};}
    try{
      if(snapshot.eventCount===0){report={...report,status:'completed',message:'截至本次统计时间，事件覆盖范围内没有新增业务变更；已保存当前项目快照。'};}
      else{
        const model=await (options.modelFor?.(ownerId)??Promise.resolve(null));
        if(!model)report={...report,status:'waiting_config',message:'事实统计已保存。配置并启用大模型 API 后可重试生成管理摘要。'};
        else{const raw=await (options.generateText??requestModelText)(model,salesModelMessages(snapshot));let data:unknown;try{data=JSON.parse(raw.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));}catch{throw new DomainError('日报模型未返回有效结构，请重试',502);}const narrative=validateSalesNarrative(data,snapshot);report={...report,status:'completed',mode:'model',narrative,modelName:model.name,message:'事实统计与执行助手摘要已保存'};}
      }
    }catch{report={...report,status:'failed',mode:'facts',message:'管理摘要暂时未生成，事实统计已保存；请检查模型配置或稍后重试。'};}
    report.updatedAt=clock();await store.finish(ownerId,date,token,report);return {report,message:report.message,existing:false};
  }
  async function dispatch(cursor?:string):Promise<SalesReportDispatch>{
    const date=salesDay(clock());let after='';if(cursor){try{const parsed=JSON.parse(decodeURIComponent(atob(cursor))) as {date:string;after:string};if(parsed.date!==date||typeof parsed.after!=='string'||!parsed.after||parsed.after.length>512)throw new Error();after=parsed.after;}catch{throw new DomainError('日报任务游标无效或已跨日期，请从首批重新执行',400);}}
    const page=await store.accounts(after);const result:SalesReportDispatch={date,processed:0,generated:0,existing:0,waitingConfig:0,failed:0,hasMore:page.hasMore,readback:{date,verified:0,statuses:{completed:0,running:0,waiting_config:0,failed:0}}};
    for(const id of page.ids){result.processed++;try{
      const previous=await store.get(id,date);const scheduledCutoff=`${date}T18:30:00+08:00`;const refresh=previous&&Date.parse(clock())>=Date.parse(scheduledCutoff)&&Date.parse(previous.report.snapshot.cutoffAt)<Date.parse(scheduledCutoff);
      const output=await generate(id,date,refresh?'regenerate':'generate');const saved=await store.get(id,date);if(!saved||saved.report.version!==output.report.version||saved.report.sourceHash!==output.report.sourceHash||saved.report.status!==output.report.status)throw new Error('readback');result.readback.verified++;result.readback.statuses[saved.report.status]++;
      if(output.report.status==='failed')result.failed++;else if(output.report.status==='waiting_config')result.waitingConfig++;else if(output.existing)result.existing++;else if(output.report.status==='completed')result.generated++;else result.existing++;
    }catch{result.failed++;}}
    if(page.hasMore&&page.ids.length)result.nextCursor=btoa(encodeURIComponent(JSON.stringify({date,after:page.ids[page.ids.length-1]})));return result;
  }
  return {list,generate,dispatch};
}
export async function runtimeSalesReportService(origin:string){const {env}=await import('cloudflare:workers');const database=(env as {DB?:D1Database}).DB;if(!database)throw new DomainError('日报数据库尚未连接，请稍后重试',503);return createSalesReportService(database,{modelFor:ownerId=>readEffectiveModel(ownerId,origin)});}
