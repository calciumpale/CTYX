import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultChatPolicy, normalizeChatPolicy, withinChatHours, initialChatMemory, normalizeChatMemory, isChatOptOut} from '../app/lib/prospecting-chat-policy.ts';

test('policy uses independent defaults and clamps limits without accepting invalid work hours',()=>{
  const first=defaultChatPolicy();
  first.libraryIds.push('changed');
  assert.deepEqual(defaultChatPolicy(),{libraryIds:[],replyDailyLimit:30,conversationReplyLimit:12,replyHoursEnabled:false,workStart:'08:30',workEnd:'21:30'});
  assert.deepEqual(normalizeChatPolicy({libraryIds:[' a ','a','',1,'b'],replyDailyLimit:999,conversationReplyLimit:0,workStart:'22:00',workEnd:'08:00'}),{
    libraryIds:['a','b'],replyDailyLimit:80,conversationReplyLimit:1,replyHoursEnabled:false,workStart:'08:30',workEnd:'21:30',
  });
  assert.equal(normalizeChatPolicy({replyDailyLimit:'bad',conversationReplyLimit:4.9,workStart:'8:30',workEnd:'25:00'}).conversationReplyLimit,4);
  assert.deepEqual(normalizeChatPolicy(null),defaultChatPolicy());
});

test('incoming replies are allowed overnight by default and legacy default hours stay unrestricted',()=>{
  const night=Date.parse('2026-11-07T18:00:00Z'); // 02:00 in Shanghai.
  assert.equal(withinChatHours(night,defaultChatPolicy()),true);
  const legacy=normalizeChatPolicy({workStart:'08:30',workEnd:'21:30'});
  assert.equal(legacy.replyHoursEnabled,false);
  assert.equal(withinChatHours(night,legacy),true);
  assert.equal(withinChatHours(night,normalizeChatPolicy(null)),true);
});

test('explicit reply-hour choices override defaults and preserve the stored window',()=>{
  const night=Date.parse('2026-11-07T18:00:00Z');
  const enabled=normalizeChatPolicy({replyHoursEnabled:true,workStart:'08:30',workEnd:'21:30'});
  assert.equal(enabled.replyHoursEnabled,true);
  assert.equal(withinChatHours(night,enabled),false);
  const disabled=normalizeChatPolicy({replyHoursEnabled:false,workStart:'09:00',workEnd:'18:00'});
  assert.equal(disabled.replyHoursEnabled,false);
  assert.equal(disabled.workStart,'09:00');
  assert.equal(disabled.workEnd,'18:00');
  assert.equal(withinChatHours(night,disabled),true);
});

test('legacy custom valid windows keep limiting replies and malformed windows do not opt in',()=>{
  const night=Date.parse('2026-11-07T18:00:00Z');
  const legacy=normalizeChatPolicy(JSON.stringify({workStart:'09:00',workEnd:'18:00'}));
  assert.equal(legacy.replyHoursEnabled,true);
  assert.equal(withinChatHours(night,legacy),false);
  assert.equal(withinChatHours(Date.parse('2026-11-07T02:00:00Z'),legacy),true);
  assert.equal(normalizeChatPolicy({workStart:'22:00',workEnd:'08:00'}).replyHoursEnabled,false);
});

test('limited reply hours use Shanghai time with inclusive opening and exclusive closing',()=>{
  const policy={...defaultChatPolicy(),replyHoursEnabled:true};
  assert.equal(withinChatHours(Date.parse('2026-11-07T00:29:59Z'),policy),false);
  assert.equal(withinChatHours(Date.parse('2026-11-07T00:30:00Z'),policy),true);
  assert.equal(withinChatHours(Date.parse('2026-11-07T13:29:59Z'),policy),true);
  assert.equal(withinChatHours(Date.parse('2026-11-07T13:30:00Z'),policy),false);
  assert.equal(withinChatHours(Number.NaN,policy),false);
  assert.equal(withinChatHours(Date.parse('2026-11-07T01:00:00Z'),{...policy,workStart:'09:00',workEnd:'10:00'}),true);
});

test('unrestricted replies still reject invalid timestamps',()=>{
  const policy=defaultChatPolicy();
  for(const now of [Number.NaN,Number.POSITIVE_INFINITY,Number.NEGATIVE_INFINITY,8.64e15+1])assert.equal(withinChatHours(now,policy),false);
});

test('memory normalization validates persisted values and never exposes contact details in summary',()=>{
  const empty=initialChatMemory();
  empty.needs.area='changed';
  assert.deepEqual(initialChatMemory(),{needs:{},stage:'understanding',contactCaptured:false,contactDeclines:0,contactAsks:0,summary:''});
  const result=normalizeChatMemory({needs:{area:' 100平 ',category:99,arbitrary:'bad'},stage:'invented',contactCaptured:'true',contactDeclines:-4,contactAsks:2.8,summary:'本人电话13812345678，微信shop_haiyan，邮箱 buyer@example.com'});
  assert.deepEqual(result.needs,{area:'100平'});
  assert.equal(result.stage,'understanding');
  assert.equal(result.contactCaptured,false);
  assert.equal(result.contactDeclines,0);
  assert.equal(result.contactAsks,2);
  assert.doesNotMatch(result.summary,/13812345678|shop_haiyan|buyer@example.com/);
  assert.deepEqual(normalizeChatMemory(null),initialChatMemory());
});

test('bare refusal uses the exact preceding need question without weakening explicit stop requests',()=>{
  assert.equal(isChatOptOut('不需要'),true);
  assert.equal(isChatOptOut('不需要','您是否需要实地看场？'),false);
  assert.equal(isChatOptOut('不需要','需要帮你预约线下看铺吗？'),false);
  assert.equal(isChatOptOut('不需要，谢谢','您方便自愿留一个常用电话或邮箱吗？'),false);
  assert.equal(isChatOptOut('别再联系我','您是否需要实地看场？'),true);
  assert.equal(isChatOptOut('不需要转让费'),false);
  assert.equal(isChatOptOut('不想给手机号'),false);
});
test('neutral contact invitation refusal does not mean platform-wide opt out',()=>{
 assert.equal(isChatOptOut('不用了','方便留一个可联系到您的方式吗？'),false);
 assert.equal(isChatOptOut('不方便','方便留一个可联系到您的方式吗？'),false);
 assert.equal(isChatOptOut('不要再联系我','方便留一个可联系到您的方式吗？'),true);
});
