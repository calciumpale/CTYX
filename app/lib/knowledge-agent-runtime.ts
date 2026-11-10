import {preparePropertyKnowledge} from './property-knowledge.ts';
import {canReadLegacyKnowledge} from './knowledge-content-scope.ts';
import type {KnowledgeDepartmentId} from './knowledge-department-scope.ts';
import type {KnowledgeAgentEvidence} from './knowledge-agent.ts';
import {prepareKnowledgeContext,runKnowledgeAgent} from './knowledge-agent.ts';
import type {KnowledgeAgentRequest,KnowledgeAgentTools} from './knowledge-agent.ts';
import {retrieveKnowledge} from './domain.ts';
import {effectiveEmbedding} from './embedding-store.ts';
import {requestEmbeddings} from './embedding-client.ts';
import {knowledgeModelKey} from './knowledge-library-runtime.ts';
import {createKnowledgeLibraryStore} from './knowledge-library-store.ts';
import {createTalkIndex} from './talktrack-index.ts';
import {talkKnowledge} from './talktrack-domain.ts';
import type {WorkbenchState} from './types.ts';

/** Owner and optional library allowlist are captured here, never read from model output. */
export function createWorkbenchKnowledgeAgent(db:D1Database,ownerId:string,origin:string,options:{departmentId?:KnowledgeDepartmentId|null;libraryIds?:string[];generate?:KnowledgeAgentTools['generate'];includeLegacy?:boolean}={}){
 const libraryIds=options.libraryIds===undefined?undefined:[...options.libraryIds];
 const scoped=options.departmentId!==undefined;
 let prefetched:KnowledgeAgentEvidence[]|undefined;
 const store=createKnowledgeLibraryStore(db,ownerId,scoped?{departmentId:options.departmentId}:{});
 const retrieve:KnowledgeAgentTools['retrieve']=async query=>{
  if(!ownerId)throw new Error('Knowledge owner required');
  const connection=await effectiveEmbedding(ownerId).catch(()=>null);
  let queryEmbedding:ReturnType<typeof requestEmbeddings>|undefined;
  const embed=async()=>{if(!connection)throw new Error('Embedding unavailable');return queryEmbedding??=requestEmbeddings(connection,[query],{origin,timeoutMs:4500});};
  const documents=!scoped&&libraryIds?.length===0?[]:(await store.search({query,mode:'hybrid',limit:4,...(!scoped&&libraryIds!==undefined?{libraryIds}:{}),...(connection?{modelKey:knowledgeModelKey(connection),embed:async()=>(await embed()).vectors[0]}:{})})).hits.map(hit=>({id:`knowledge-document:${hit.id}`,title:[hit.title,hit.heading].filter(Boolean).join(' · '),content:hit.context}));
  if(options.includeLegacy===false)return documents;
  const row=await db.prepare('SELECT state_json FROM workbench_workspaces WHERE user_id=?').bind(ownerId).first<{state_json:string}>();
  if(!row)return documents;
  const state=JSON.parse(row.state_json) as WorkbenchState;
  const access=(state as WorkbenchState&{_access?:Record<string,string>})._access??{};
  const allowed=(item:{id:string;departmentId?:unknown;employeeId?:string})=>!scoped||canReadLegacyKnowledge(item,access,options.departmentId??null);
  const skills=state.skills.filter(skill=>allowed(skill)&&!/示例|合成/.test(skill.source+skill.evidence));
  const sampleSkillIds=new Set(state.skills.filter(skill=>!skills.includes(skill)).map(skill=>'knowledge-'+skill.id));
  const knowledge=state.knowledge.filter(item=>allowed(item)&&!/示例|合成/.test(item.source)&&!sampleSkillIds.has(item.id));
  const tracks=(state.talkTracks??[]).filter(track=>allowed(track)&&track.status==='published'&&track.weight>0);
  const lexical=retrieveKnowledge({knowledge:[...knowledge,...tracks.map(talkKnowledge)],skills},query);
  if(!tracks.length||!connection)return [...documents,...lexical];
  try{
   const result=await embed();
   const semantic=await createTalkIndex(db,ownerId).search(result.vectors[0],result.model,tracks);
   return [...documents,...lexical,...semantic.map(talkKnowledge)];
  }catch{return [...documents,...lexical];}
 };
 const prepareProperty=(request:KnowledgeAgentRequest)=>preparePropertyKnowledge(db,ownerId,request,{...(scoped?{departmentId:options.departmentId}:{}),...(!scoped&&libraryIds!==undefined?{libraryIds}:{}),generate:options.generate});
 const tools={retrieve:async(query:string)=>prefetched??retrieve(query),generate:options.generate};
 return {preflight:async(query:string)=>{const snapshot=await store.snapshot();prefetched=await retrieve(query);return {department:options.departmentId??null,libraryIds:snapshot.libraries.map(l=>l.id).slice(0,100),sourceIds:prefetched.map(e=>e.id).slice(0,20),status:'ok' as const};},prepare:async(request:KnowledgeAgentRequest)=>(await prepareProperty(request))??prepareKnowledgeContext(request,tools),answer:async(request:KnowledgeAgentRequest)=>{const max=Math.max(1,Math.min(12000,request.maxAnswerChars??2000));const prepared=await prepareProperty({...request,maxAnswerChars:max});if(!prepared)return runKnowledgeAgent(request,tools);return max>=350&&prepared.answer&&prepared.answer.length<=max?{...prepared,action:'answer' as const}:{...prepared,answer:undefined,evidenceIds:[],action:'handoff' as const};}};
}
