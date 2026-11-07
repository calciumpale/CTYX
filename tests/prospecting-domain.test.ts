import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeCampaignInput, normalizeComments, normalizeCandidates, parseMediaCrawlerExport, canAutoApprove, scoreComment, applyModelAnalysis} from '../app/lib/prospecting-domain.ts';

const base={requirements:'给中小企业提供销售培训，找销售培训软件竞品',keywords:['销售培训'],greetingTemplate:'你好，看到你的提问，我们提供销售培训。',reviewMode:'manual'};
test('campaign bounds protect query and outbound message sizes without implicit automatic sending',()=>{
  const c=normalizeCampaignInput(base);assert.equal(c.reviewMode,'manual');assert.equal(c.dailyLimit,10);
  assert.throws(()=>normalizeCampaignInput({...base,reviewMode:'yes'}));
  assert.throws(()=>normalizeCampaignInput({...base,dailyLimit:1000}));
  assert.throws(()=>normalizeCampaignInput({...base,keywords:['x'.repeat(80)]}));
});
test('browser identity only comes from a validated Douyin profile, never from arbitrary id or URL',()=>{
  const rows=normalizeComments([{id:'c1',videoId:'7654321234567890',text:'多少钱',nickname:'用户',profileUrl:'https://www.douyin.com/user/MS4wLjAB123',recipientId:'MS4wLjAB123'},{id:'c2',videoId:'7654321234567890',text:'能试用吗',profileUrl:'https://evil.test/user/a',recipientId:'a'}],'browser');
  assert.equal(rows[0].recipientId,'MS4wLjAB123');assert.equal(rows[1].recipientId,undefined);
  assert.equal(rows[1].profileUrl,undefined);assert.equal(rows[0].videoUrl,'https://www.douyin.com/video/7654321234567890');
});
test('MediaCrawler JSONL and legacy identity fields remain analysis-only and comments deduplicate',()=>{
  const input=[{comment_id:'123',aweme_id:'7654321234567890',content:'想试用',creator_hash:'abcdef1234567890',nickname:'用**',user_id:'123456',sec_uid:'MS4wLjAB123'}, {comment_id:'123',aweme_id:'7654321234567890',content:'想试用'}].map(x=>JSON.stringify(x)).join('\n');
  const rows=parseMediaCrawlerExport(input);assert.equal(rows.length,1);assert.equal(rows[0].source,'mediacrawler');assert.equal(rows[0].recipientId,undefined);assert.equal(rows[0].profileUrl,undefined);
  assert.throws(()=>parseMediaCrawlerExport('{broken'));assert.throws(()=>parseMediaCrawlerExport('[]'));
});
test('candidate identities retain evidence and cannot introduce arbitrary hosts',()=>{
  const c=normalizeCandidates([{id:'wrong',nickname:'销售培训',profileUrl:'https://www.douyin.com/user/MS4wLjAB123?foo=bar',videos:[{id:'7654321234567890',title:'软件演示'}]}]);
  assert.equal(c[0].id,'MS4wLjAB123');assert.equal(c[0].videos.length,1);
  assert.throws(()=>normalizeCandidates([{profileUrl:'javascript:alert(1)',nickname:'x'}]));
});
test('rule fallback and anonymous comments never cause automatic outreach',()=>{
  const comment=normalizeComments([{id:'c1',videoId:'7654321234567890',text:'多少钱？怎么购买？',profileUrl:'https://www.douyin.com/user/MS4wLjAB123'}],'browser')[0];
  const analysis=scoreComment(comment,normalizeCampaignInput(base));
  assert.equal(analysis.analysisSource,'rules');
  assert.equal(canAutoApprove({...comment,...analysis}, {reviewMode:'automatic',minIntentScore:0}),false);
  assert.equal(canAutoApprove({...comment,...analysis,analysisSource:'model',intentScore:99},{reviewMode:'manual',minIntentScore:70}),false);
  assert.equal(canAutoApprove({...comment,...analysis,analysisSource:'model',intentScore:99},{reviewMode:'automatic',minIntentScore:70}),true);
});
test('rule scoring separates Haiyan rental prospects from unrelated comments and seller promotion',()=>{
  const campaign=normalizeCampaignInput({...base,requirements:'为海盐商铺出租寻找有租店需求的客户',keywords:['海盐商铺出租']});
  const cases=[
    {text:'海盐这个商铺租金多少钱一个月？',high:true},
    {text:'想在海盐租个店面，可以约明天看铺吗？',high:true},
    {text:'求租海盐小商铺，预算每月3000元',high:true},
    {text:'不用转让费吗？想租',high:true},
    {text:'背景音乐叫什么？想要这首歌',high:false},
    {text:'海盐商铺出租，位置好，有需要联系我',high:false},
    {text:'海盐好漂亮，路过点赞',high:false},
    {text:'不想租了，请不要联系我',high:false},
  ];
  for(const item of cases){
    const comment=normalizeComments([{id:'intent-case',videoId:'7654321234567890',text:item.text,profileUrl:'https://www.douyin.com/user/MS4wLjAB123'}],'browser')[0];
    const result=scoreComment(comment,campaign);
    assert.equal(result.intentScore>=campaign.minIntentScore,item.high,item.text);
    assert.ok(result.reason.length>0);
    assert.equal(canAutoApprove(result,{reviewMode:'automatic',minIntentScore:70}),false);
  }
});
test('model suggestions are matched to existing records and cannot rewrite contact identity',()=>{
  const comment=normalizeComments([{id:'c1',videoId:'7654321234567890',text:'多少钱？',profileUrl:'https://www.douyin.com/user/MS4wLjAB123'}],'browser')[0];
  const result=applyModelAnalysis([comment],[{id:'c1',intentScore:90,reason:'询价',greeting:'你好，可以提供试用。',recipientId:'evil'}],normalizeCampaignInput(base));
  assert.equal(result[0].recipientId,comment.recipientId);assert.equal(result[0].analysisSource,'model');
  const incomplete=applyModelAnalysis([comment],[],normalizeCampaignInput(base));assert.equal(incomplete[0].analysisSource,'rules');
});
