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
export function createWorkbenchKnowledgeAgent(db:D1Database,ownerId:string,origin:string,options:{libraryIds?:string[];generate?:KnowledgeAgentTools['generate'];includeLegacy?:boolean}={}){
 const libraryIds=options.libraryIds===undefined?undefined:[...options.libraryIds];
 const retrieve:KnowledgeAgentTools['retrieve']=async query=>{
  if(!ownerId)throw new Error('Knowledge owner required');
  const connection=await effectiveEmbedding(ownerId).catch(()=>null);
  const documents=libraryIds?.length===0?[]:(await createKnowledgeLibraryStore(db,ownerId).search({query,mode:'hybrid',limit:4,...(libraryIds!==undefined?{libraryIds}:{}),...(connection?{modelKey:knowledgeModelKey(connection),embed:async()=>(await requestEmbeddings(connection,[query],{origin,timeoutMs:4500})).vectors[0]}:{})})).hits.map(hit=>({id:`knowledge-document:${hit.id}`,title:[hit.title,hit.heading].filter(Boolean).join(' · '),content:hit.context}));
  if(options.includeLegacy===false)return documents;
  const row=await db.prepare('SELECT state_json FROM workbench_workspaces WHERE user_id=?').bind(ownerId).first<{state_json:string}>();
  if(!row)return documents;
  const state=JSON.parse(row.state_json) as WorkbenchState;
  const skills=state.skills.filter(skill=>!/示例|合成/.test(skill.source+skill.evidence));
  const sampleSkillIds=new Set(state.skills.filter(skill=>!skills.includes(skill)).map(skill=>'knowledge-'+skill.id));
  const knowledge=state.knowledge.filter(item=>!/示例|合成/.test(item.source)&&!sampleSkillIds.has(item.id));
  const lexical=retrieveKnowledge({knowledge,skills},query);
  const tracks=(state.talkTracks??[]).filter(track=>track.status==='published'&&track.weight>0);
  if(!tracks.length||!connection)return [...documents,...lexical];
  try{
   const result=await requestEmbeddings(connection,[query],{origin,timeoutMs:4500});
   const semantic=await createTalkIndex(db,ownerId).search(result.vectors[0],result.model,tracks);
   return [...documents,...lexical,...semantic.map(talkKnowledge)];
  }catch{return [...documents,...lexical];}
 };
 const tools={retrieve,generate:options.generate};
 return {prepare:(request:KnowledgeAgentRequest)=>prepareKnowledgeContext(request,tools),answer:(request:KnowledgeAgentRequest)=>runKnowledgeAgent(request,tools)};
}
