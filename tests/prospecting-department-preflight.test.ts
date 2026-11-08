import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseProspectChatAction} from '../app/lib/prospecting-chat-agent.ts';
import type {ProspectChatAgentInput} from '../app/lib/prospecting-chat-types.ts';
const input=(text:string):ProspectChatAgentInput=>({campaign:{name:'任务',requirements:'',minIntentScore:70},conversation:{nickname:'客户'},messages:[],inbound:{id:'m1',text}});
for(const text of ['您好','电话13800138000','预算三千','我之前说的面积是多少？','[图片消息]'])test(`mandatory lookup precedes automatic reply: ${text}`,async()=>{
 const request=input(text);if(text==='[图片消息]')request.inbound.contentType='image';
 let calls=0;const knowledgeLookup={department:'zs' as const,libraryIds:['zs-doc','shared'],sourceIds:[],status:'ok' as const};
 const result=await chooseProspectChatAction(request,{preflightKnowledge:async()=>{calls++;return knowledgeLookup;}});
 assert.equal(calls,1);assert.equal(result.action,'reply');assert.deepEqual(result.knowledgeLookup,knowledgeLookup);
 const failure=await chooseProspectChatAction(request,{preflightKnowledge:async()=>{throw new Error('private secret');}});
 assert.equal(failure.action,'wait');assert.equal(failure.knowledgeLookup?.status,'failed');assert.doesNotMatch(JSON.stringify(failure),/private secret/);
});
for(const text of ['不要再联系我','我要找人工'])test(`nonautomatic branch skips lookup: ${text}`,async()=>{
 const result=await chooseProspectChatAction(input(text),{preflightKnowledge:async()=>{throw new Error('must not retrieve');}});
 assert.notEqual(result.action,'reply');assert.equal(result.knowledgeLookup,undefined);
});
