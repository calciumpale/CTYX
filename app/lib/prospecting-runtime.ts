import {env} from 'cloudflare:workers';
import {DomainError} from './domain.ts';
import {readEffectiveModel} from './connection-store.ts';
import {requestModelText} from './model-client.ts';
import {chooseProspectChatAction} from './prospecting-chat-agent.ts';
import {createProspectingService} from './prospecting-service.ts';
import {understandTaskMemory} from './prospecting-memory.ts';
import {createWorkbenchKnowledgeAgent} from './knowledge-agent-runtime.ts';

export function prospectingService(){
 const db=(env as Cloudflare.Env).DB;
 if(!db)throw new DomainError('获客数据库尚未连接',503);
 return createProspectingService({
  db,readModel:readEffectiveModel,
  rememberChat:async(ownerId,origin,state,messages,options)=>{
   const model=await readEffectiveModel(ownerId,origin).catch(()=>null);
   return understandTaskMemory(state,messages,options,model?m=>requestModelText(model,m,{timeoutMs:8000}):undefined);
  },
  decideChat:async(ownerId,origin,input)=>{
   const model=input.conversation.mode==='human'?null:await readEffectiveModel(ownerId,origin).catch(()=>null);
   const knowledge=createWorkbenchKnowledgeAgent(db,ownerId,origin,{
    libraryIds:input.policy?.libraryIds??[],
    generate:model?(messages,options)=>requestModelText(model,messages,{timeoutMs:options?.phase==='route'?8000:12000}):undefined,
   });
   return chooseProspectChatAction(input,{answerKnowledge:request=>knowledge.answer(request)});
  },
 });
}
