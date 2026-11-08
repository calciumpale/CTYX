import {DomainError} from './domain.ts';
import type {ProspectDailyDiscovery,ProspectCandidate} from './prospecting-types.ts';
const day=86400000,offset=8*3600000;
function occurrence(time:string,now:number){
 if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))throw new DomainError('每日发现时间格式应为 HH:mm');
 const [h,m]=time.split(':').map(Number);
 return Math.floor((now+offset)/day)*day-offset+(h*60+m)*60000;
}
export function nextDiscoveryAt(time:string,now:number){const at=occurrence(time,now);return new Date(at>now?at:at+day).toISOString();}
export function latestDiscoveryAt(time:string,now:number){const at=occurrence(time,now);return new Date(at<=now?at:at-day).toISOString();}
export function normalizeDiscoverySchedule(value:unknown,now:number):ProspectDailyDiscovery{
 const v=value&&typeof value==='object'?value as Record<string,unknown>:{};
 if(typeof v.enabled!=='boolean')throw new DomainError('请设置每日发现开关');
 const time=typeof v.time==='string'?v.time:'09:00';occurrence(time,now);
 return{enabled:v.enabled,time,timeZone:'Asia/Shanghai',includeNewCandidates:true,...(v.enabled?{nextRunAt:nextDiscoveryAt(time,now)}:{})};
}
export function mergeDiscoveryCandidates(previous:ProspectCandidate[],incoming:ProspectCandidate[],selected:string[],time:string,runId?:string){
 const existing=new Map(previous.map(c=>[c.id,c]));const ids=new Set(selected);let added=0;
 for(const candidate of incoming.slice(0,30)){
  const old=existing.get(candidate.id);
  if(!old){added++;ids.add(candidate.id);}
  existing.set(candidate.id,{...old,...candidate,firstSeenAt:old?.firstSeenAt??time,firstRunId:old?.firstRunId??runId,videos:[...new Map([...(old?.videos??[]),...candidate.videos].map(v=>[v.id,v])).values()]});
 }
 return{candidates:[...existing.values()],selectedCandidateIds:[...ids],newAccounts:added};
}

export function discoveryVideoSlices(candidates:ProspectCandidate[],selected:string[],ordinal:number,seenIds:string[]=[],runId?:string){
 const eligible=candidates.filter(c=>selected.includes(c.id));
 const fresh=runId?eligible.filter(c=>c.firstRunId===runId):[];
 const old=eligible.filter(c=>!fresh.includes(c));
 const start=old.length?((ordinal%old.length)+old.length)%old.length:0;
 const rotated=[...old.slice(start),...old.slice(0,start)];
 const videos=[...fresh,...rotated].slice(0,30).flatMap(c=>{
  const list=c.videos;if(list.length<=2)return list;
  const unseen=list.filter(v=>!seenIds.includes(v.id));if(unseen.length)return [unseen[0],...(unseen.length>1&&ordinal%2===0?[unseen[1]]:[list[ordinal%list.length]])].filter((v,i,all)=>all.findIndex(x=>x.id===v.id)===i);
  return ordinal%2===0?[list[list.length-1],list[ordinal%(list.length-1)]]:[list[ordinal%list.length],list[(ordinal+1)%list.length]];
 });
 const unique=[...new Map(videos.map(v=>[v.id,v])).values()].slice(0,60);
 return Array.from({length:Math.ceil(unique.length/2)},(_,i)=>unique.slice(i*2,i*2+2));
}

/** All scheduling is explicit: callers invoke this only after authenticated polls. */
export function createDiscoveryPersistence(db:D1Database,now:()=>number=Date.now){
 const stamp=()=>new Date(now()).toISOString();
 async function runs(owner:string,member:string,campaign:string){
  const rows=await db.prepare('SELECT * FROM workbench_prospect_discovery_runs WHERE owner_id=? AND member_id=? AND campaign_id=? ORDER BY created_at DESC,id DESC LIMIT 30').bind(owner,member,campaign).all<{id:string;scheduled_for:string;status:string;data_json:string}>();
  return rows.results.map(r=>({...JSON.parse(r.data_json),id:r.id,scheduledFor:r.scheduled_for,status:r.status}));
 }
 async function cancel(owner:string,member:string,campaign:string){
  const time=stamp();await db.batch([
   db.prepare("UPDATE workbench_prospect_jobs SET status='cancelled',active_key=NULL,error='每日发现已取消',updated_at=? WHERE owner_id=? AND member_id=? AND campaign_id=? AND kind IN ('discover','collect') AND status IN ('queued','running') AND json_type(input_json,'$.discoveryRunId')='text'").bind(time,owner,member,campaign),
   db.prepare("UPDATE workbench_prospect_discovery_runs SET status='cancelled',data_json=json_set(data_json,'$.finishedAt',?,'$.pendingJobs',0),updated_at=? WHERE owner_id=? AND member_id=? AND campaign_id=? AND status IN ('queued','discovering','collecting')").bind(time,time,owner,member,campaign),
  ]);
 }
 return{runs,cancel};
}
