import {env} from 'cloudflare:workers';
import {DomainError,retrieveKnowledge} from './domain.ts';
import {readEffectiveModel} from './connection-store.ts';
import {requestEmbeddings} from './embedding-client.ts';
import {effectiveEmbedding} from './embedding-store.ts';
import {requestModelText} from './model-client.ts';
import {chooseProspectChatAction} from './prospecting-chat-agent.ts';
import {createProspectingService} from './prospecting-service.ts';
import {talkKnowledge} from './talktrack-domain.ts';
import {createTalkIndex} from './talktrack-index.ts';
import {workbenchKnowledge} from './knowledge-library-runtime.ts';
import type {WorkbenchState} from './types.ts';

async function retrieveLegacyChatEvidence(db:D1Database,ownerId:string,origin:string,query:string){
  const row=await db.prepare('SELECT state_json FROM workbench_workspaces WHERE user_id=?').bind(ownerId).first<{state_json:string}>();
  if(!row)return [];
  const state=JSON.parse(row.state_json) as WorkbenchState;
  // The example workspace contains synthetic prices, business names and policies.
  // Real conversations should only retrieve published operational content.
  const skills=state.skills.filter(skill=>!/示例|合成/.test(skill.source+skill.evidence));
  const sampleSkillIds=new Set(state.skills.filter(skill=>!skills.includes(skill)).map(skill=>'knowledge-'+skill.id));
  const knowledge=state.knowledge.filter(item=>!/示例|合成/.test(item.source)&&!sampleSkillIds.has(item.id));
  const lexical=retrieveKnowledge({knowledge,skills},query);
  const tracks=(state.talkTracks??[]).filter(track=>track.status==='published'&&track.weight>0);
  if(!tracks.length)return lexical;
  try{
    const embedding=await effectiveEmbedding(ownerId);
    if(!embedding)return lexical;
    const result=await requestEmbeddings(embedding,[query],{origin,timeoutMs:4500});
    const semantic=await createTalkIndex(db,ownerId).search(result.vectors[0],result.model,tracks);
    return [...lexical,...semantic.map(talkKnowledge)];
  }catch{return lexical;}
}

export function prospectingService(){
  const db=(env as Cloudflare.Env).DB;
  if(!db)throw new DomainError('获客数据库尚未连接',503);
  return createProspectingService({
    db,
    readModel:readEffectiveModel,
    decideChat:async(ownerId,origin,input)=>{
      const model=input.conversation.mode==='human'?null:await readEffectiveModel(ownerId,origin).catch(()=>null);
      return chooseProspectChatAction(input,{
        retrieve:async query=>{
          const [legacy,documents]=await Promise.all([
            retrieveLegacyChatEvidence(db,ownerId,origin,query),
            workbenchKnowledge(db,ownerId,origin,query,{libraryIds:input.policy?.libraryIds??[]}),
          ]);
          // Explicitly allowed documents take precedence within the agent's evidence budget.
          return [...documents,...legacy];
        },
        generate:model?messages=>requestModelText(model,messages,{timeoutMs:16000}):undefined,
      });
    },
  });
}
