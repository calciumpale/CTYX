import {DomainError} from './domain.ts';
import {meetingHash,meetingToken,sameMeetingSecret} from './meeting-import-validation.ts';
import type {MeetingImport,MeetingJobKind,MeetingJobView,MeetingBridgeJob,MeetingImportSummary,MeetingMedia} from './meeting-import-types.ts';

interface DeviceRow{id:string;owner_id:string;member_id:string;label:string;token_hash:string;enabled:number;authorized:number;last_seen_at:string|null}
interface JobRow{id:string;owner_id:string;member_id:string;device_id:string;kind:MeetingJobKind;deal_id:string|null;status:MeetingJobView['status'];input_json:string;result_json:string|null;error:string|null;created_at:string;lease_hash:string|null;lease_until:string|null;media_json:string|null}
export interface MeetingDevice{id:string;ownerId:string;memberId:string;label:string;authorized:boolean;lastSeenAt?:string}
const publicDevice=(r:DeviceRow):MeetingDevice=>({id:r.id,ownerId:r.owner_id,memberId:r.member_id,label:r.label,authorized:!!r.authorized,...(r.last_seen_at?{lastSeenAt:r.last_seen_at}:{})});
const publicJob=(r:JobRow):MeetingJobView=>({id:r.id,kind:r.kind,status:r.status,createdAt:r.created_at,...(r.kind==='search'?{search:JSON.parse(r.input_json)}:{}),...(r.error?{error:r.error}:{}),...(r.result_json?JSON.parse(r.result_json):{})});
export function createMeetingStore(db:D1Database,now:()=>number=Date.now){
 const stamp=()=>new Date(now()).toISOString();
 const findDevice=(id:string)=>db.prepare('SELECT d.* FROM workbench_meeting_devices d JOIN workbench_member_accounts a ON a.owner_id=d.owner_id AND a.account_id=d.member_id WHERE d.id=? AND d.enabled=1 AND a.enabled=1 AND a.role IN (\'sales\',\'manager\')').bind(id).first<DeviceRow>();
 async function createDevice(ownerId:string,memberId:string,label:string,firstSetup=false){
  const member=await db.prepare("SELECT account_id FROM workbench_member_accounts WHERE owner_id=? AND account_id=? AND enabled=1 AND role IN ('sales','manager')").bind(ownerId,memberId).first();if(!member)throw new DomainError('设备只能绑定启用的销售或管理者账号',403);
  const id=`md-${crypto.randomUUID()}`,token=meetingToken();
  const values=[id,ownerId,memberId,label.slice(0,80),await meetingHash(token),stamp()];
  const inserted=firstSetup?await db.prepare('INSERT INTO workbench_meeting_devices (id,owner_id,member_id,label,token_hash,created_at) SELECT ?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM workbench_meeting_devices WHERE owner_id=?)').bind(...values,ownerId).run():await db.prepare('INSERT INTO workbench_meeting_devices (id,owner_id,member_id,label,token_hash,created_at) VALUES (?,?,?,?,?,?)').bind(...values).run();
  if(!inserted.meta.changes)throw new DomainError('设备已经完成初始化',409);
  return{id,token};
 }
 async function authenticate(id:string,token:string):Promise<MeetingDevice>{const d=await findDevice(id);if(!d||!/^[a-f0-9]{64}$/.test(token)||!sameMeetingSecret(d.token_hash,await meetingHash(token)))throw new DomainError('同步设备凭证无效或已停用',401);return publicDevice(d);}
 async function device(ownerId:string,memberId:string):Promise<MeetingDevice|null>{const r=await db.prepare('SELECT d.* FROM workbench_meeting_devices d JOIN workbench_member_accounts a ON a.account_id=d.member_id AND a.owner_id=d.owner_id WHERE d.owner_id=? AND d.member_id=? AND d.enabled=1 AND a.enabled=1 ORDER BY d.created_at DESC LIMIT 1').bind(ownerId,memberId).first<DeviceRow>();return r?publicDevice(r):null;}
 async function seen(id:string,authorized:boolean){await db.prepare('UPDATE workbench_meeting_devices SET last_seen_at=?,authorized=? WHERE id=? AND enabled=1').bind(stamp(),authorized?1:0,id).run();}
 async function createJob(ownerId:string,memberId:string,deviceId:string,kind:MeetingJobKind,input:unknown,dealId?:string):Promise<MeetingJobView>{
  const d=await findDevice(deviceId);if(!d||d.owner_id!==ownerId||d.member_id!==memberId)throw new DomainError('当前账号没有已连接的同步设备',403);
  const activeKey=kind==='import'?await meetingHash(`${ownerId}\0${memberId}\0${JSON.stringify(input)}`):null;
  if(activeKey){const old=await db.prepare('SELECT * FROM workbench_meeting_jobs WHERE active_key=?').bind(activeKey).first<JobRow>();if(old)return publicJob(old);}
  const count=await db.prepare("SELECT COUNT(*) AS n FROM workbench_meeting_jobs WHERE owner_id=? AND member_id=? AND status IN ('queued','running')").bind(ownerId,memberId).first<{n:number}>();if((count?.n??0)>=5)throw new DomainError('已有多个任务正在处理，请稍后再试',429);
  const id=`mj-${crypto.randomUUID()}`,time=stamp();
  await db.prepare('INSERT OR IGNORE INTO workbench_meeting_jobs (id,owner_id,member_id,device_id,kind,deal_id,status,input_json,active_key,created_at,updated_at) VALUES (?,?,?,?,?,?,\'queued\',?,?,?,?)').bind(id,ownerId,memberId,deviceId,kind,dealId??null,JSON.stringify(input),activeKey,time,time).run();
  if(activeKey){const row=await db.prepare('SELECT * FROM workbench_meeting_jobs WHERE active_key=?').bind(activeKey).first<JobRow>();if(row)return publicJob(row);}
  return{id,kind,status:'queued',createdAt:time};
 }
 async function claim(deviceId:string):Promise<MeetingBridgeJob|null>{
  const d=await findDevice(deviceId);if(!d)throw new DomainError('同步设备已停用',401);const token=meetingToken(),hash=await meetingHash(token),time=stamp();
  await db.prepare("UPDATE workbench_meeting_jobs SET status='failed',error='同步超时，请重新导入',active_key=NULL,updated_at=? WHERE device_id=? AND ((status='running' AND lease_until<=? AND attempts>=3) OR (status IN ('queued','running') AND created_at<?))").bind(time,deviceId,time,new Date(now()-86400000).toISOString()).run();
  const r=await db.prepare("UPDATE workbench_meeting_jobs SET status='running',lease_hash=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=(SELECT id FROM workbench_meeting_jobs WHERE device_id=? AND owner_id=? AND member_id=? AND (status='queued' OR status='running' AND lease_until<=? AND attempts<3) ORDER BY created_at,id LIMIT 1) RETURNING *").bind(hash,new Date(now()+180000).toISOString(),time,deviceId,d.owner_id,d.member_id,time).first<JobRow>();
  return r?{id:r.id,leaseToken:token,kind:r.kind,input:JSON.parse(r.input_json)}:null;
 }
 async function leased(deviceId:string,jobId:string,token:string):Promise<JobRow>{
  const d=await findDevice(deviceId);const r=await db.prepare('SELECT * FROM workbench_meeting_jobs WHERE id=? AND device_id=?').bind(jobId,deviceId).first<JobRow>();
  if(!d||!r||r.owner_id!==d.owner_id||r.member_id!==d.member_id||r.status!=='running'||!r.lease_hash||!sameMeetingSecret(r.lease_hash,await meetingHash(token))||!r.lease_until||r.lease_until<=stamp())throw new DomainError('任务已失效，请刷新后重新导入',409);return r;
 }
 async function renew(deviceId:string,id:string,token:string){const row=await leased(deviceId,id,token);if(Date.parse(row.created_at)<now()-20*60000)throw new DomainError('任务处理超时',409);const result=await db.prepare("UPDATE workbench_meeting_jobs SET lease_until=?,updated_at=? WHERE id=? AND lease_hash=? AND status='running' AND lease_until>?").bind(new Date(now()+180000).toISOString(),stamp(),id,row.lease_hash,stamp()).run();if(!result.meta.changes)throw new DomainError('任务已失效',409);}
 async function complete(deviceId:string,id:string,token:string,result:unknown,error?:string){const row=await leased(deviceId,id,token);const r=await db.prepare("UPDATE workbench_meeting_jobs SET status=?,result_json=?,error=?,active_key=NULL,lease_hash=NULL,lease_until=NULL,updated_at=? WHERE id=? AND device_id=? AND status='running' AND lease_hash=? AND lease_until>?").bind(error?'failed':'done',result?JSON.stringify(result):null,error?.slice(0,700)??null,stamp(),id,deviceId,row.lease_hash,stamp()).run();if(!r.meta.changes)throw new DomainError('任务状态已改变',409);}
 async function jobs(ownerId:string,memberId:string){const r=await db.prepare('SELECT * FROM workbench_meeting_jobs WHERE owner_id=? AND member_id=? ORDER BY created_at DESC,id DESC LIMIT 12').bind(ownerId,memberId).all<JobRow>();return r.results.map(publicJob);}
 async function job(ownerId:string,memberId:string,id:string){return db.prepare('SELECT * FROM workbench_meeting_jobs WHERE owner_id=? AND member_id=? AND id=?').bind(ownerId,memberId,id).first<JobRow>();}
 async function insertImport(ownerId:string,memberId:string,deviceId:string,jobId:string,lease:string,data:MeetingImport){
  const r=await leased(deviceId,jobId,lease);if(r.owner_id!==ownerId||r.member_id!==memberId||r.deal_id!==data.dealId)throw new DomainError('会议来源与项目不一致',403);
  await db.prepare("INSERT OR IGNORE INTO workbench_meeting_imports (id,owner_id,member_id,deal_id,source_key,source_hash,data_json,created_at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM workbench_meeting_jobs WHERE id=? AND device_id=? AND owner_id=? AND member_id=? AND lease_hash=? AND status='running' AND lease_until>?)").bind(data.id,ownerId,memberId,data.dealId,data.record.recordFileId,data.sourceHash,JSON.stringify(data),data.createdAt,jobId,deviceId,ownerId,memberId,r.lease_hash,stamp()).run();
  let found=await getImport(ownerId,data.id);if(!found)throw new DomainError('任务已失效，会议未写入',409);
  if(data.media&&!found.media){
   await db.prepare("UPDATE workbench_meeting_imports SET data_json=json_set(data_json,'$.media',json(?),'$.warnings',json(?)) WHERE owner_id=? AND id=? AND source_hash=? AND json_type(data_json,'$.media') IS NULL AND EXISTS (SELECT 1 FROM workbench_meeting_jobs WHERE id=? AND device_id=? AND lease_hash=? AND status='running' AND lease_until>?)").bind(JSON.stringify(data.media),JSON.stringify(data.warnings),ownerId,found.id,found.sourceHash,jobId,deviceId,r.lease_hash,stamp()).run();found=await getImport(ownerId,data.id);
  }
  if(!found)throw new DomainError('会议来源暂时不可用',409);
  const warnings=found.media?data.warnings.filter(w=>!/(录音|音频|audio)/i.test(w)):data.warnings;
  await db.prepare("UPDATE workbench_meeting_imports SET data_json=json_set(data_json,'$.warnings',json(?)) WHERE owner_id=? AND id=? AND source_hash=? AND EXISTS (SELECT 1 FROM workbench_meeting_jobs WHERE id=? AND device_id=? AND lease_hash=? AND status='running' AND lease_until>?)").bind(JSON.stringify(warnings),ownerId,found.id,found.sourceHash,jobId,deviceId,r.lease_hash,stamp()).run();
  return (await getImport(ownerId,data.id))!;
 }
 async function getImport(ownerId:string,id:string):Promise<MeetingImport|null>{const r=await db.prepare('SELECT data_json FROM workbench_meeting_imports WHERE owner_id=? AND id=?').bind(ownerId,id).first<{data_json:string}>();return r?JSON.parse(r.data_json):null;}
 async function imports(ownerId:string,dealIds:string[]):Promise<MeetingImportSummary[]>{
  if(!dealIds.length)return[];const rows:MeetingImport[]=[];
  for(let start=0;start<dealIds.length;start+=80){const ids=dealIds.slice(start,start+80);const r=await db.prepare(`SELECT data_json FROM workbench_meeting_imports WHERE owner_id=? AND deal_id IN (${ids.map(()=>'?').join(',')}) ORDER BY created_at DESC,id DESC LIMIT 30`).bind(ownerId,...ids).all<{data_json:string}>();rows.push(...r.results.map(x=>JSON.parse(x.data_json) as MeetingImport));}
  return rows.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id)).slice(0,30).map(({minutes,transcript,...view})=>{void minutes;void transcript;return view;});
 }
 async function updateAnalysis(ownerId:string,id:string,sourceHash:string,analysis:MeetingImport['analysis']){const result=await db.prepare("UPDATE workbench_meeting_imports SET data_json=json_set(data_json,'$.analysis',json(?)) WHERE owner_id=? AND id=? AND source_hash=?").bind(JSON.stringify(analysis),ownerId,id,sourceHash).run();if(!result.meta.changes)throw new DomainError('会议版本已经更新',409);const r=await getImport(ownerId,id);if(!r)throw new DomainError('会议资料不存在',404);return r;}
 async function linked(ownerId:string,id:string){await db.prepare('UPDATE workbench_meeting_imports SET linked=1 WHERE owner_id=? AND id=?').bind(ownerId,id).run();}
 async function saveMedia(deviceId:string,id:string,token:string,media:MeetingMedia){const r=await leased(deviceId,id,token);await db.prepare("UPDATE workbench_meeting_jobs SET media_json=? WHERE id=? AND device_id=? AND status='running' AND lease_hash=? AND lease_until>? AND media_json IS NULL").bind(JSON.stringify(media),id,deviceId,r.lease_hash,stamp()).run();const current=await leased(deviceId,id,token);if(!current.media_json)throw new DomainError('任务已失效，录音未关联',409);return JSON.parse(current.media_json) as MeetingMedia;}
 return{createDevice,authenticate,device,seen,createJob,claim,leased,renew,complete,jobs,job,insertImport,getImport,imports,updateAnalysis,linked,saveMedia};
}
