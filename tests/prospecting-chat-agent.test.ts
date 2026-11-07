import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseProspectChatAction} from '../app/lib/prospecting-chat-agent.ts';
import type {ProspectChatAgentInput} from '../app/lib/prospecting-chat-types.ts';

const input=(text:string):ProspectChatAgentInput=>({
  campaign:{name:'海盐任务',requirements:'海盐商铺租赁，提供铺位筛选与预约看铺服务',minIntentScore:70},
  conversation:{nickname:'客户'},
  messages:[],
  inbound:{id:'in-1',text},
});
const source={id:'approved-1',title:'预约看铺',content:'可预约工作日下午看铺，具体时间由专员确认。'};

test('retrieves approved material and retains evidence IDs for a factual response',async()=>{
  const result=await chooseProspectChatAction(input('什么时间可以看铺？'),{
    retrieve:async query=>{assert.match(query,/什么时间可以看铺/);return [source];},
    generate:async messages=>{assert.match(messages[1].content,/approved-1/);return '{"action":"reply","reply":"可以预约工作日下午看铺，具体时间由专员确认。","evidenceIds":["approved-1"]}';},
  });
  assert.equal(result.action,'reply');
  assert.deepEqual(result.evidenceIds,['approved-1']);
});

test('routes sensitive issues before reaching retrieval or the model',async()=>{
  const result=await chooseProspectChatAction(input('免租两个月能写进合同吗？我的手机是 13812345678'),{
    retrieve:async()=>assert.fail('sensitive input should not reach retrieval'),
    generate:async()=>assert.fail('sensitive input should not reach the model'),
  });
  assert.equal(result.action,'handoff');
  assert.equal(result.lead?.contactValue,'13812345678');
});

test('captures only customer-provided contact details and excludes opt-outs',async()=>{
  const result=await chooseProspectChatAction(input('明天能预约看铺吗？我的微信是 shop_haiyan'),{
    retrieve:async query=>{assert.doesNotMatch(query,/shop_haiyan/);return [source];},
    generate:async messages=>{
      assert.doesNotMatch(messages[1].content,/shop_haiyan/);
      return '{"action":"reply","reply":"收到，后续会由同事联系你。","evidenceIds":[]}';
    },
  });
  assert.equal(result.lead?.contactType,'wechat');
  assert.equal(result.lead?.contactValue,'shop_haiyan');
  assert.equal(result.lead?.grade,'high');
  assert.equal((await chooseProspectChatAction(input('别再联系我，手机号是 13812345678'),{})).action,'wait');
  assert.equal((await chooseProspectChatAction(input('商家的电话 13812345678 是这个吗？'),{})).lead,undefined);
  assert.equal((await chooseProspectChatAction(input('这不是我的手机号 13812345678'),{})).lead,undefined);
  assert.equal((await chooseProspectChatAction(input('这个单号 13812345678'),{})).lead,undefined);
});

test('hands unsupported facts, model failures and invalid citations to a human',async()=>{
  assert.equal((await chooseProspectChatAction(input('店面在哪里？'),{
    generate:async()=>'{"action":"reply","reply":"就在海盐大道 100 号。","evidenceIds":[]}',
  })).action,'handoff');
  assert.equal((await chooseProspectChatAction(input('店面在哪里？'),{
    retrieve:async()=>[source],
    generate:async()=>'{"action":"reply","reply":"就在海盐大道 100 号。","evidenceIds":["fake"]}',
  })).action,'handoff');
  const result=await chooseProspectChatAction(input('本人电话 138-1234-5678'),{
    generate:async()=>{throw new Error('provider internals');},
  });
  assert.equal(result.action,'handoff');
  assert.equal(result.lead?.contactValue,'138-1234-5678');
  assert.doesNotMatch(result.reason??'',/provider/);
});

test('an open conversation can be qualified before asking for contact',async()=>{
  const result=await chooseProspectChatAction(input('你好，有兴趣'),{
    generate:async()=>'{"action":"reply","reply":"所有商铺都配有免费停车。","evidenceIds":[]}',
  });
  assert.equal(result.action,'reply');
  assert.equal(result.reply,'你好，方便说一下你最想了解哪方面吗？');
  assert.equal(result.lead,undefined);
});

test('human takeover captures a contact without asking retrieval or model providers',async()=>{
  const request=input('邮箱是 buyer@example.com，想预约明天看铺');
  request.conversation.mode='human';
  const result=await chooseProspectChatAction(request,{
    retrieve:async()=>assert.fail('human conversations are not automated'),
    generate:async()=>assert.fail('human conversations are not automated'),
  });
  assert.equal(result.action,'wait');
  assert.equal(result.lead?.contactType,'email');
  assert.equal(result.lead?.grade,'high');
});

test('rejects numerical claims when the cited source does not contain the number',async()=>{
  const result=await chooseProspectChatAction(input('什么时间可以看铺？'),{
    retrieve:async()=>[source],
    generate:async()=>'{"action":"reply","reply":"可以在 19:30 看铺。","evidenceIds":["approved-1"]}',
  });
  assert.equal(result.action,'handoff');
});

test('a valid source ID does not authorize invented inventory or removal of a negation',async()=>{
  for(const reply of ['现在有多间空铺，全部临街且带独立卫生间。','目前有空铺。']){
    const result=await chooseProspectChatAction(input('还有空铺吗？'),{
      retrieve:async()=>[{id:'inventory',title:'当前库存',content:'目前没有空铺。预计到店看铺需提前预约。'}],
      generate:async()=>JSON.stringify({action:'reply',reply,evidenceIds:['inventory']}),
    });
    assert.equal(result.action,'handoff');
  }
});

test('handles sensitive and contact messages sent as separate parts of one customer turn',async()=>{
  const request=input('方便的话回复我一下');
  request.pending=[{id:'earlier',text:'合同能改吗？'},{id:'contact',text:'我手机号是13812345678'},request.inbound];
  const result=await chooseProspectChatAction(request,{generate:async()=>assert.fail('batch handoff must precede generation')});
  assert.equal(result.action,'handoff');
  assert.equal(result.lead?.contactValue,'13812345678');
});
