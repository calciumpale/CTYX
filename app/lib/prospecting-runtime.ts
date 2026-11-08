import {captureConversation} from './conversation-learning.ts';
import {learnConversation} from './conversation-learning-worker.ts';
import {loadWorkspace,saveWorkspace} from './server.ts';
import {runPlaybookFeedback} from './playbook-graph.ts';
import {knowledgeDepartmentForSalesId} from './knowledge-department-scope.ts';
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
  learnChat:async(ownerId,memberId,conversationId,campaignId,origin)=>{const source=await captureConversation(db,ownerId,memberId,conversationId,campaignId);const model=await readEffectiveModel(ownerId,origin).catch(()=>null);const job=await learnConversation(source,{load:()=>loadWorkspace(ownerId,origin),save:(revision,state)=>saveWorkspace(ownerId,revision,state),generate:model?async transcripts=>(await runPlaybookFeedback({transcripts,existing:[],sourceKind:'conversation'},{generate:messages=>requestModelText(model,messages,{timeoutMs:20000})})).candidates.map(c=>c.draft):undefined});return {message:job.message};},
  rememberChat:async(ownerId,origin,state,messages,options)=>{
   const model=await readEffectiveModel(ownerId,origin).catch(()=>null);
   return understandTaskMemory(state,messages,options,model?m=>requestModelText(model,m,{timeoutMs:8000}):undefined);
  },
  decideChat:async(ownerId,origin,input)=>{
   const account=input.memberId?await db.prepare('SELECT sales_id FROM workbench_member_accounts WHERE owner_id=? AND account_id=? AND enabled=1 AND role=\'sales\'').bind(ownerId,input.memberId).first<{sales_id:string}>():null;
   const departmentId=knowledgeDepartmentForSalesId(account?.sales_id);
   const model=input.conversation.mode==='human'?null:await readEffectiveModel(ownerId,origin).catch(()=>null);
   const knowledge=createWorkbenchKnowledgeAgent(db,ownerId,origin,{
    departmentId,
    generate:model?(messages,options)=>requestModelText(model,messages,{timeoutMs:options?.phase==='route'?8000:12000}):undefined,
   });
   return chooseProspectChatAction(input,{preflightKnowledge:async query=>{if(!departmentId)throw new Error('Sales department unavailable');try{return await knowledge.preflight(query);}catch{return{department:departmentId,libraryIds:[],sourceIds:[],status:'failed'};}},answerKnowledge:request=>knowledge.answer(request)});
  },
 });
}
