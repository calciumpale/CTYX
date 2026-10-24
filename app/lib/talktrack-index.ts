import { DomainError } from './domain.ts';
import { cosineSimilarity,validateVectors } from './talktrack-vectors.ts';
import {talkText} from './talktrack-domain.ts';
import type { StoredVector,TalkTrack } from './talktrack-types.ts';
export async function talkContentHash(track:TalkTrack){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(talkText(track))))].map(b=>b.toString(16).padStart(2,'0')).join('');}
/** Content-addressed vectors: a failed optimistic edit cannot overwrite the winning text's embedding. */
export function createTalkIndex(db:D1Database,userId:string){
  async function all(tracks:TalkTrack[],model:string):Promise<StoredVector[]>{
    if(!tracks.length)return [];if(tracks.length>500)throw new DomainError('内置向量库已达到500条上限，请扩容或接入外部向量库',503);
    const hashes=await Promise.all(tracks.map(talkContentHash));const results:StoredVector[]=[];
    // D1 limits bound parameters per statement. Keep each batch below 100.
    for(let at=0;at<tracks.length;at+=40){const batch=tracks.slice(at,at+40);const result=await db.prepare(`SELECT track_id,title,vector_json,model FROM workbench_talk_vectors WHERE user_id=? AND model=? AND (${batch.map(()=>'(track_id=? AND content_hash=?)').join(' OR ')})`).bind(userId,model,...batch.flatMap((t,i)=>[t.id,hashes[at+i]])).all<{track_id:string;title:string;vector_json:string;model:string}>();results.push(...result.results.map(r=>({id:r.track_id,title:r.title,vector:validateVectors([JSON.parse(r.vector_json)],1)[0],model:r.model})));}
    if(results.length!==tracks.length)throw new DomainError('向量索引与当前文本或模型不一致，请在设置中重建话术索引',409);return results;
  }
  async function upsert(track:TalkTrack,vector:number[],model:string,status=track.status){validateVectors([vector],1);await db.prepare('INSERT INTO workbench_talk_vectors (user_id,track_id,content_hash,title,vector_json,model,status,metadata_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,track_id,content_hash,model) DO UPDATE SET title=excluded.title,vector_json=excluded.vector_json,status=excluded.status,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at').bind(userId,track.id,await talkContentHash(track),track.title,JSON.stringify(vector),model,status,JSON.stringify({employeeId:track.employeeId,leadTypes:track.leadTypes,scenario:track.scenario,tag:'成单案例',version:track.version}),new Date().toISOString()).run();}
  async function search(vector:number[],model:string,tracks:TalkTrack[]):Promise<TalkTrack[]>{const approved=tracks.filter(t=>t.status==='published'&&t.weight>0);const entries=await all(approved,model);const active=new Map(approved.map(t=>[t.id,t]));return entries.map(e=>({track:active.get(e.id)!,score:cosineSimilarity(vector,e.vector)*active.get(e.id)!.weight})).filter(e=>e.score>=0.35).sort((a,b)=>b.score-a.score).slice(0,3).map(e=>e.track);}
  return {all,upsert,search};
}
