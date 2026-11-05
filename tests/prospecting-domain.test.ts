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
test('model suggestions are matched to existing records and cannot rewrite contact identity',()=>{
  const comment=normalizeComments([{id:'c1',videoId:'7654321234567890',text:'多少钱？',profileUrl:'https://www.douyin.com/user/MS4wLjAB123'}],'browser')[0];
  const result=applyModelAnalysis([comment],[{id:'c1',intentScore:90,reason:'询价',greeting:'你好，可以提供试用。',recipientId:'evil'}],normalizeCampaignInput(base));
  assert.equal(result[0].recipientId,comment.recipientId);assert.equal(result[0].analysisSource,'model');
  const incomplete=applyModelAnalysis([comment],[],normalizeCampaignInput(base));assert.equal(incomplete[0].analysisSource,'rules');
});
