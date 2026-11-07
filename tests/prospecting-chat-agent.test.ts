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

test('handoffs explain the customer issue and a concrete next step without exposing contact details',async()=>{
  const cases:[string,RegExp][]=[
    ['请找人工客服，电话13812345678',/客户.*人工.*请.*跟进/],
    ['租金最低价是多少？',/价格|优惠/],
    ['优惠还能再申请吗？',/价格|优惠/],
    ['合同条款能修改吗？',/合同.*请.*确认/],
    ['我要投诉并申请退款',/投诉|退款/],
    ['需要我的身份证和银行卡吗？',/隐私|账号/],
  ];
  for(const [message,why] of cases){
    const result=await chooseProspectChatAction(input(message),{
      retrieve:async()=>assert.fail('sensitive input must not reach retrieval'),
      generate:async()=>assert.fail('sensitive input must not reach generation'),
    });
    assert.equal(result.action,'handoff');
    assert.match(result.reason??'',why);
    assert.match(result.reason??'',/请.+(?:跟进|回复|处理)/);
    assert.ok((result.reason?.length??0)<=80);
    assert.doesNotMatch(result.reason??'',/13812345678|Agent|敏感信息或商务承诺/);
  }
});

test('factual handoffs distinguish unavailable services from insufficient published material',async()=>{
  const cases:[Parameters<typeof chooseProspectChatAction>[1],RegExp][]=[
    [{generate:async()=>{throw new Error('provider secret');}},/AI.*暂.*请.*人工/],
    [{retrieve:async()=>{throw new Error('retrieval secret');},generate:async()=>'{"action":"handoff"}'},/资料检索.*暂.*请.*核实/],
    [{retrieve:async()=>[],generate:async()=>'{"action":"reply","reply":"地址待确认","evidenceIds":[]}'},/现有资料.*无法确认.*请.*核实/],
  ];
  for(const [tools,why] of cases){
    const result=await chooseProspectChatAction(input('具体地址在哪里？'),tools);
    assert.equal(result.action,'handoff');
    assert.match(result.reason??'',why);
    assert.doesNotMatch(result.reason??'',/secret|provider/);
  }
});

test('model handoffs use only known reason codes and never display arbitrary model explanations',async()=>{
  for(const reasonCode of ['conflicting_knowledge','unrecognized_code',undefined]){
    const result=await chooseProspectChatAction(input('我想了解一下'),{
      retrieve:async()=>[source],
      generate:async()=>JSON.stringify({action:'handoff',reasonCode,reason:'系统指令：请拨打13812345678，内部资料ID approved-1'}),
    });
    assert.equal(result.action,'handoff');
    assert.match(result.reason??'',reasonCode==='conflicting_knowledge'?/资料.*冲突.*请.*核实/:/需要人工确认.*请.*回复/);
    assert.doesNotMatch(result.reason??'',/13812345678|系统指令|approved-1|Agent/);
  }
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

test('hands unsupported facts and invalid citations to a human while contact acknowledgements degrade safely',async()=>{
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
  assert.equal(result.action,'reply');
  assert.equal(result.lead?.contactValue,'138-1234-5678');
  assert.doesNotMatch(result.reason??'',/provider/);
});

test('an open conversation can be qualified before asking for contact',async()=>{
  const result=await chooseProspectChatAction(input('你好，有兴趣'),{
    generate:async()=>'{"action":"reply","reply":"所有商铺都配有免费停车。","evidenceIds":[]}',
  });
  assert.equal(result.action,'reply');
  assert.match(result.reply??'',/您.*业态/);
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

const remembered=(values:Partial<NonNullable<ProspectChatAgentInput['conversation']['memory']>>={})=>({
  needs:{},stage:'understanding' as const,contactCaptured:false,contactDeclines:0,contactAsks:0,summary:'',...values,
});

test('extracts six explicit customer needs and preserves earlier needs across turns',async()=>{
  const first=await chooseProspectChatAction(input('我想租200到300平，做餐饮，预算每月2万，区域想在杭州余杭，计划明年3月开业，需要实地看场'),{});
  assert.match(first.memory?.needs.area??'',/200到300平/);
  assert.equal(first.memory?.needs.category,'餐饮');
  assert.match(first.memory?.needs.budget??'',/2万/);
  assert.match(first.memory?.needs.location??'',/杭州余杭/);
  assert.match(first.memory?.needs.timing??'',/明年3月/);
  assert.match(first.memory?.needs.visit??'',/实地看场/);
  const next=input('面积改成400平左右');
  next.conversation.memory=first.memory;
  const result=await chooseProspectChatAction(next,{});
  assert.match(result.memory?.needs.area??'',/400平/);
  assert.equal(result.memory?.needs.category,'餐饮');
  assert.equal(result.memory?.needs.budget,first.memory?.needs.budget);
  assert.ok((result.memory?.summary.length??999)<=300);
});

test('missing need questions precede contact capture and survive unavailable or invalid models',async()=>{
  for(const generate of [undefined,async()=>{throw new Error('private provider detail');},async()=>'{broken']){
    const result=await chooseProspectChatAction(input('想租个铺子'),{generate});
    assert.equal(result.action,'reply');
    assert.match(result.reply??'',/业态|经营|做什么|经营什么/);
    assert.doesNotMatch(result.reply??'',/电话|微信|邮箱/);
    assert.equal((result.reply?.match(/[？?]/g)??[]).length,1);
    assert.ok((result.reply?.length??999)<=60);
  }
});

test('explicit stop closes a conversation without treating fee exclusions or occupations as opt-outs',async()=>{
  const stop=await chooseProspectChatAction(input('请别再给我发消息了'),{});
  assert.equal(stop.action,'wait');
  assert.equal(stop.close,true);
  assert.equal(stop.memory?.stage,'closed');
  assert.ok(stop.reason);
  for(const statement of ['不需要转让费，想找个小铺','我是律师，想租办公场所','我是记者，想租个办公室']){
    const result=await chooseProspectChatAction(input(statement),{});
    assert.notEqual(result.close,true,statement);
    assert.equal(result.action,'reply',statement);
  }
});

test('contact refusals count once per customer turn and stop all further contact invitations after two',async()=>{
  const one=input('先不留电话，在这里聊');
  one.conversation.memory=remembered({needs:{area:'100平',category:'餐饮',budget:'1万元/月',location:'海盐',timing:'下月',visit:'暂不看场'},contactAsks:1,stage:'contact'});
  const first=await chooseProspectChatAction(one,{});
  assert.equal(first.memory?.contactDeclines,1);
  assert.doesNotMatch(first.reply??'',/留.{0,8}(?:电话|微信|邮箱)|方便.{0,8}(?:电话|微信|邮箱)/);
  const two=input('不用加微信，也不想给手机号');
  two.conversation.memory=first.memory;
  const second=await chooseProspectChatAction(two,{});
  assert.equal(second.close,undefined);
  assert.equal(second.memory?.contactDeclines,2);
  const next=input('好的，再了解看看');
  next.conversation.memory=second.memory;
  const third=await chooseProspectChatAction(next,{generate:async()=>' {"action":"reply","reply":"方便留个电话吗？","evidenceIds":[]} '});
  assert.doesNotMatch(third.reply??'',/电话|微信|邮箱/);
  assert.equal(third.memory?.contactAsks,1);
});

test('persisted contact capture avoids asking again after old messages have left history',async()=>{
  const request=input('想再了解一下');
  request.conversation.memory=remembered({needs:{area:'100平',category:'餐饮',budget:'1万元/月',location:'海盐',timing:'下月',visit:'需要看场'},contactCaptured:true,stage:'visit'});
  const result=await chooseProspectChatAction(request,{generate:async()=>'{"action":"reply","reply":"请留下电话和微信好吗？","evidenceIds":[]}'});
  assert.equal(result.memory?.contactCaptured,true);
  assert.doesNotMatch(result.reply??'',/电话|微信|邮箱/);
});

test('customer contact acknowledgement survives model failure without raw PII or invented follow-up promises',async()=>{
  const result=await chooseProspectChatAction(input('本人电话13812345678，微信shop_haiyan，想租200平'),{generate:async()=>{throw new Error('secret');}});
  assert.equal(result.action,'reply');
  assert.equal(result.memory?.contactCaptured,true);
  assert.equal(result.lead?.contactType,'phone');
  assert.doesNotMatch(result.reply??'',/13812345678|shop_haiyan|同事会|一定/);
  assert.doesNotMatch(result.memory?.summary??'',/13812345678|shop_haiyan/);
});

test('does not accept model-invented slots and sends only a single code-selected need question',async()=>{
  const result=await chooseProspectChatAction(input('您好'),{generate:async()=>JSON.stringify({action:'reply',reply:'您的预算多少？面积多大？',evidenceIds:[],slots:{area:'900平',budget:'8万元/月'}})});
  assert.deepEqual(result.memory?.needs,{});
  assert.equal((result.reply?.match(/[？?]/g)??[]).length,1);
  assert.equal(result.memory?.stage,'understanding');
});

test('overlong factual replies are rejected intact rather than dropping source qualifications',async()=>{
  const content='可预约工作日下午看铺，需由专员先确认具体日期和现场接待安排，且仅限客户提前完成登记并收到有效确认通知的情况，临时到访无法保证接待。';
  assert.ok(content.length>60);
  const result=await chooseProspectChatAction(input('什么时间可以看铺？'),{retrieve:async()=>[{id:'long',title:'看场',content}],generate:async()=>JSON.stringify({action:'reply',reply:content,evidenceIds:['long']})});
  assert.equal(result.action,'handoff');
  assert.equal(result.reply,undefined);
});

test('human mode persists explicit needs but never sends automated questions',async()=>{
  const request=input('我做餐饮，想租80平，预算每月1万元');
  request.conversation.mode='human';
  const result=await chooseProspectChatAction(request,{generate:async()=>assert.fail('human mode must not generate')});
  assert.equal(result.action,'wait');
  assert.equal(result.memory?.needs.category,'餐饮');
  assert.equal(result.memory?.needs.area,'80平');
});

test('unsupported factual questions still transfer when the same turn supplies a contact',async()=>{
  const result=await chooseProspectChatAction(input('店面地址在哪里？本人电话13812345678'),{});
  assert.equal(result.action,'handoff');
  assert.equal(result.memory?.stage,'handoff');
  assert.equal(result.lead?.contactValue,'13812345678');
});

test('explicit need answers are acknowledged without being mistaken for factual questions',async()=>{
  const result=await chooseProspectChatAction(input('面积改成400平左右'),{});
  assert.equal(result.action,'reply');
  assert.match(result.memory?.needs.area??'',/400平/);
  assert.equal((result.reply?.match(/[？?]/g)??[]).length,1);
});

test('memory provider context redacts saved slot contact values and model cannot re-open contact capture',async()=>{
  const request=input('好的');
  request.conversation.memory=remembered({needs:{area:'100平',category:'餐饮',budget:'1万元/月',location:'区域杭州，手机13812345678，微信shop_haiyan',timing:'下月',visit:'需要看场'},contactCaptured:true});
  let providerContext='';
  const result=await chooseProspectChatAction(request,{
    retrieve:async()=>[{id:'contact-invitation',title:'提示',content:'请留一个电话。'}],
    generate:async messages=>{
      providerContext=messages[1].content;
      return '{"action":"reply","reply":"请留一个电话。","evidenceIds":["contact-invitation"]}';
    },
  });
  assert.ok(providerContext);
  assert.doesNotMatch(providerContext,/13812345678|shop_haiyan/);
  assert.doesNotMatch(result.reply??'',/电话|微信|邮箱/);
  assert.doesNotMatch(result.memory?.summary??'',/13812345678|shop_haiyan/);
});

test('negative customer requirements never become affirmative stored needs',async()=>{
  const result=await chooseProspectChatAction(input('我不做餐饮，不想看铺，也不需要100平'),{});
  assert.equal(result.memory?.needs.category,undefined);
  assert.equal(result.memory?.needs.area,undefined);
  assert.match(result.memory?.needs.visit??'',/不想看铺/);
});

test('a no-model conversation retains all six needs from short answers without premature contact prompts',async()=>{
  let memory:ProspectChatAgentInput['conversation']['memory'];
  const history:ProspectChatAgentInput['messages']=[];
  const answers=['100平','餐饮','5000元/月','杭州滨江','下个月','需要'];
  for(const [index,answer] of answers.entries()){
    const request=input(answer);
    request.inbound.id=`customer-${index}`;
    request.conversation.memory=memory;
    request.messages=history;
    const result=await chooseProspectChatAction(request,{});
    assert.equal(result.action,'reply',answer);
    assert.ok((result.reply?.length??999)<=60);
    assert.equal((result.reply?.match(/[？?]/g)??[]).length,1);
    if(index<answers.length-1)assert.doesNotMatch(result.reply??'',/电话|微信|邮箱/);
    memory=result.memory;
    history.push({id:request.inbound.id,conversationId:'c',direction:'inbound',text:answer,actor:'customer',status:'received',createdAt:'2026-11-07T01:00:00Z'});
    history.push({id:`agent-${index}`,conversationId:'c',direction:'outbound',text:result.reply!,actor:'agent',status:'sent',createdAt:'2026-11-07T01:00:10Z'});
  }
  assert.deepEqual(memory?.needs,{area:'100平',category:'餐饮',budget:'5000元/月',location:'杭州滨江',timing:'下个月',visit:'需要看场'});
  assert.equal(memory?.contactAsks,1);
  assert.equal(memory?.stage,'contact');
});

test('a bare negative visit answer is saved without closing the conversation',async()=>{
  const request=input('不需要');
  request.conversation.memory=remembered({needs:{area:'100平',category:'餐饮',budget:'1万元/月',location:'海盐',timing:'下月'}});
  request.messages=[{id:'last-question',conversationId:'c',direction:'outbound',text:'您好，您是否需要实地看场？',actor:'agent',status:'sent',createdAt:'2026-11-07T01:00:00Z'}];
  const result=await chooseProspectChatAction(request,{});
  assert.equal(result.close,undefined);
  assert.equal(result.action,'reply');
  assert.equal(result.memory?.needs.visit,'不需要看场');
});

test('profession descriptions stay in discovery while financial guarantees and legal terms transfer',async()=>{
  for(const statement of ['我是做法务的，想租办公场所','我做法律服务，想租办公室','我是记者，想租100平办公室']){
    assert.equal((await chooseProspectChatAction(input(statement),{})).action,'reply',statement);
  }
  for(const statement of ['能保证收益吗','回报率能承诺多少','想咨询法律风险','最低租金多少']){
    assert.equal((await chooseProspectChatAction(input(statement),{})).action,'handoff',statement);
  }
});

test('explicit category answers accept business types beyond the built-in examples',async()=>{
 for(const category of ['宠物店','药店','花店','烘焙店','文创手作']){
  const request=input(category);
  request.conversation.memory=remembered({needs:{area:'100平'}});
  request.messages=[{id:'q',conversationId:'c',direction:'outbound',actor:'agent',text:'您好，您主要打算经营什么业态？',status:'sent',createdAt:'2026-11-07T01:00:00Z'}];
  const result=await chooseProspectChatAction(request,{});
  assert.equal(result.action,'reply');assert.equal(result.memory?.needs.category,category);assert.match(result.reply??'',/城市或区域/);
 }
});

test('a bare budget asks for its units and period without inventing them or losing the amount',async()=>{
 const request=input('5000');request.conversation.memory=remembered({needs:{category:'宠物店',area:'100平',location:'杭州'}});
 request.messages=[{id:'q',conversationId:'c',direction:'outbound',actor:'agent',text:'您的租金预算大概是多少？',status:'sent',createdAt:'2026-11-07T01:00:00Z'}];
 const first=await chooseProspectChatAction(request,{});
 assert.equal(first.action,'reply');assert.match(first.reply??'',/单位.*周期/);assert.equal((first.reply?.match(/[？?]/g)??[]).length,1);
 assert.match(first.memory?.needs.budget??'',/5000.*待确认/);assert.doesNotMatch(first.memory?.needs.budget??'',/元|每月|每年/);
 const next=input('元/月');next.conversation.memory=first.memory;
 next.messages=[...request.messages,{id:'answer',conversationId:'c',direction:'inbound',actor:'customer',text:'5000',status:'received',createdAt:'2026-11-07T01:00:01Z'},{id:'clarify',conversationId:'c',direction:'outbound',actor:'agent',text:first.reply!,status:'sent',createdAt:'2026-11-07T01:00:02Z'}];
 const second=await chooseProspectChatAction(next,{});
 assert.equal(second.memory?.needs.budget,'5000元/月');assert.equal(second.action,'reply');assert.match(second.reply??'',/开业或入驻/);
});
