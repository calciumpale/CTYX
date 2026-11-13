import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {researchCompany,searchCompanyExpansion,QCC_ENDPOINT} from '../app/lib/company-research.ts';
import type {Deal} from '../app/lib/types.ts';

const now='2026-10-24T03:00:00.000Z';
const deal={id:'company-research-test',name:'示远科技有限公司',website:'https://www.shiyuan.example.cn/about?token=PRIVATE_TOKEN',contact:'PRIVATE_CONTACT',summary:'PRIVATE_NOTES',amount:99887766,notes:[{text:'PRIVATE_FOLLOWUP'}]} as unknown as Deal;
const qcc={appKey:'synthetic-appkey',secretKey:'synthetic-secret',endpoint:'https://api.qichacha.com/ECIV4/GetBasicDetailsByName'};
const model={key:'synthetic-model-key',url:'https://model.example.cn/v1/chat/completions',name:'general-chat'};
const rss=`<?xml version="1.0"?><rss version="2.0"><channel><item><title><![CDATA[示远科技 &amp; 产品介绍]]></title><link>https://www.shiyuan.example.cn/about</link><description><![CDATA[<b>示远科技有限公司</b>提供企业软件服务。]]></description></item><item><title>客户案例</title><link>https://www.shiyuan.example.cn/cases</link><description>服务制造业客户。</description></item></channel></rss>`;
const completion=(value:unknown)=>Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(value)}}]});
const qccResult={Status:'200',Result:{Name:'示远科技有限公司',KeyNo:'abcdef0123456789abcdef0123456789',CreditCode:'91310110SYNTHETICXX',OperName:'测试法人',StartDate:'2011-01-01',Status:'存续',RegistCapi:'100万元',Scope:'企业软件服务',Address:'某市某区',Area:{Province:'某省',City:'某市'}}};

test('QCC uses exact official endpoint, uppercase MD5 signature and seconds timestamp',async()=>{
 let requested='';let headers=new Headers();let redirect:RequestRedirect|undefined;
 const result=await researchCompany(deal,{qcc,model:null,now,request:async(input,init)=>{requested=String(input);headers=new Headers(init?.headers);redirect=init?.redirect;return Response.json(qccResult);}});
 const url=new URL(requested);const seconds=String(Math.floor(Date.parse(now)/1000));
 assert.equal(url.origin+url.pathname,QCC_ENDPOINT);assert.equal(url.searchParams.get('keyword'),deal.name);assert.equal(url.searchParams.get('key'),qcc.appKey);
 assert.equal(headers.get('Timespan'),seconds);assert.equal(headers.get('Token'),createHash('md5').update(qcc.appKey+seconds+qcc.secretKey).digest('hex').toUpperCase());assert.equal(redirect,'manual');
 assert.equal(result.provider,'qcc');assert.equal(result.companyName,deal.name);assert.equal(result.facts.find(f=>f.label==='经营状态')?.value,'存续');
 assert.equal(result.sources[0].url,'https://www.qcc.com/firm/abcdef0123456789abcdef0123456789.html');assert.ok(result.facts.every(f=>f.sourceIds.length&&f.sourceIds.every(id=>result.sources.some(s=>s.id===id))));
 assert.equal(result.status,'partial');assert.ok(result.warnings.some(w=>/配置大模型/.test(w)));assert.equal(result.modelUsed,false);
});

test('QCC unavailable falls back to real RSS sources without leaking provider errors',async()=>{
 const urls:string[]=[];
 const result=await researchCompany(deal,{qcc,model:null,now,request:async(input)=>{urls.push(String(input));return urls.length===1?Response.json({Status:'201',Message:qcc.secretKey}):new Response(rss);}});
 assert.equal(urls.length,2);assert.equal(new URL(urls[1]).hostname,'www.bing.com');assert.equal(result.provider,'web');assert.equal(result.sources.length,2);assert.match(result.summary,/企业软件/);assert.ok(!JSON.stringify(result).includes(qcc.secretKey));
});

test('missing QCC credentials searches public identity and leaves no-model result partial',async()=>{
 let query='';const result=await researchCompany(deal,{qcc:null,model:null,now,request:async(input)=>{query=String(input);return new Response(rss);}});
 assert.match(decodeURIComponent(query),/示远科技有限公司/);assert.equal(result.sources[0].title,'示远科技 & 产品介绍');assert.equal(result.status,'partial');assert.equal(result.updatedAt,now);assert.ok(result.warnings.some(w=>/配置大模型/.test(w)));
 for(const privateText of ['PRIVATE_CONTACT','PRIVATE_NOTES','PRIVATE_FOLLOWUP','99887766','PRIVATE_TOKEN'])assert.ok(!query.includes(privateText));
});

test('no search results never calls the model or invents facts',async()=>{
 let calls=0;const result=await researchCompany(deal,{qcc:null,model,now,request:async()=>{calls++;return new Response('<rss><channel></channel></rss>');}});
 assert.equal(calls,1);assert.equal(result.status,'partial');assert.deepEqual(result.facts,[]);assert.deepEqual(result.sources,[]);assert.equal(result.modelUsed,false);assert.ok(result.warnings.some(w=>/暂无.*公开资料/.test(w)));
});

test('model receives only public identity and snippets, and fabricated source IDs are discarded',async()=>{
 let sent='';let calls=0;
 const result=await researchCompany(deal,{qcc:null,model,now,request:async(_input,init)=>{calls++;if(calls===1)return new Response(rss);sent=String(init?.body);return completion({summary:'提供企业软件服务，采购需求待确认。',facts:[{label:'主营业务',value:'企业软件',sourceIds:['web-1']},{label:'虚构财务',value:'999亿元',sourceIds:['invented-source']}]});}});
 assert.equal(calls,2);assert.equal(result.modelUsed,true);assert.equal(result.facts.length,1);assert.equal(result.facts[0].label,'主营业务');assert.deepEqual(result.facts[0].sourceIds,['web-1']);assert.match(result.summary,/待核实/);assert.ok(result.warnings.some(w=>/核实/.test(w)));
 for(const text of ['PRIVATE_CONTACT','PRIVATE_NOTES','PRIVATE_FOLLOWUP','99887766','PRIVATE_TOKEN'])assert.ok(!sent.includes(text));
 assert.match(sent,/不可信|不能.*指令/);
});

test('unsafe QCC endpoints never receive secrets and unsafe source URLs are excluded',async()=>{
 for(const endpoint of ['https://api.qichacha.com.attacker.cn/ECIV4/GetBasicDetailsByName','http://127.0.0.1/','https://user:pass@api.qichacha.com/ECIV4/GetBasicDetailsByName']){
  const requested:string[]=[];
  const result=await researchCompany(deal,{qcc:{...qcc,endpoint},model:null,now,request:async(input)=>{requested.push(String(input));return new Response('<rss><channel><item><title>Bad</title><link>http://127.0.0.1/private</link><description>x</description></item><item><title>Bad 2</title><link>https://user:pass@public.example.cn</link></item><item><title>Bad 3</title><link>javascript:alert(1)</link></item></channel></rss>');}});
  assert.equal(requested.length,1);assert.equal(new URL(requested[0]).hostname,'www.bing.com');assert.ok(!requested[0].includes(qcc.appKey));assert.equal(result.sources.length,0);
 }
});

test('malicious website is never fetched or sent as a query URL',async()=>{
 for(const website of ['http://127.0.0.1/private','http://2130706433/secret','https://evil:PRIVATE_TOKEN@public.example.cn','https://localhost/','https://metadata.internal/']){
  const requested:string[]=[];await researchCompany({...deal,website} as Deal,{qcc:null,model:null,now,request:async(input)=>{requested.push(String(input));return new Response(rss);}});
  assert.equal(requested.length,1);assert.equal(new URL(requested[0]).hostname,'www.bing.com');assert.ok(!decodeURIComponent(requested[0]).includes(website));assert.ok(!requested[0].includes('PRIVATE_TOKEN'));
 }
});

test('oversized and entity-bearing RSS fail safely with no fabricated data',async()=>{
 for(const body of ['x'.repeat(300000),'<!DOCTYPE rss [<!ENTITY x SYSTEM "http://127.0.0.1/">]><rss><channel><item><title>&x;</title></item></channel></rss>']){
  const result=await researchCompany(deal,{qcc:null,model:null,now,request:async()=>new Response(body)});assert.equal(result.sources.length,0);assert.equal(result.facts.length,0);assert.equal(result.status,'partial');assert.ok(result.warnings.length>0);
 }
});

test('invalid model JSON preserves verified sources and exposes no secret/error body',async()=>{
 let calls=0;const result=await researchCompany(deal,{qcc:null,model,now,request:async()=>++calls===1?new Response(rss):new Response(`provider failure ${model.key}`,{status:503})});
 assert.equal(result.sources.length,2);assert.equal(result.modelUsed,false);assert.equal(result.status,'partial');assert.ok(result.warnings.some(w=>/整理|模型/.test(w)));assert.ok(!JSON.stringify(result).includes(model.key));
});

test('missing QCC KeyNo links to official API documentation with explicit provenance',async()=>{
 const result=await researchCompany(deal,{qcc,model:null,now,request:async()=>Response.json({...qccResult,Result:{...qccResult.Result,KeyNo:'../../../unsafe'}})});
 assert.equal(result.sources[0].url,'https://openapi.qcc.com/dataApi/410');assert.match(result.sources[0].title,/企查查.*接口/);
});

test('QCC results for a different company cannot be merged into the selected company',async()=>{
 let calls=0;const result=await researchCompany(deal,{qcc,model:null,now,request:async()=>++calls===1?Response.json({...qccResult,Result:{...qccResult.Result,Name:'另一家公司有限公司'}}):new Response(rss)});
 assert.equal(result.companyName,deal.name);assert.equal(result.provider,'web');assert.equal(result.facts.length,0);
});

test('deadline includes a stalled response body and cancels the reader',async(context)=>{
 context.mock.timers.enable({apis:['setTimeout']});let cancelled=false;let signal:AbortSignal|undefined;
 const pending=researchCompany(deal,{qcc:null,model:null,now,request:async(_input,init)=>{signal=init?.signal as AbortSignal;return new Response(new ReadableStream({start(){},cancel(){cancelled=true;}}));}});
 await Promise.resolve();await Promise.resolve();context.mock.timers.tick(10001);
 const result=await pending;assert.equal(result.sources.length,0);assert.equal(signal?.aborted,true);assert.equal(cancelled,true);assert.match(result.warnings.join('；'),/检索.*不可用/);
});

test('regional search redirects retry only the fixed Bing China endpoint without following Location',async()=>{
 const requests:{url:string;redirect:RequestRedirect|undefined}[]=[];
 const result=await researchCompany(deal,{qcc:null,model:null,now,request:async(input,init)=>{requests.push({url:String(input),redirect:init?.redirect});return requests.length===1?new Response('',{status:302,headers:{Location:'http://127.0.0.1/secret'}}):new Response(rss);}});
 assert.equal(requests.length,2);assert.equal(new URL(requests[0].url).hostname,'www.bing.com');assert.equal(new URL(requests[1].url).hostname,'cn.bing.com');assert.ok(requests.every(r=>r.redirect==='manual'));assert.equal(result.sources.length,2);
});

test('Workers-compatible fetch policy retrieves public sources without enabling redirect following',async()=>{
 const result=await researchCompany(deal,{qcc:null,model:null,now,request:async(_input,init)=>{
  // workerd's Request only accepts follow/manual; the real Miniflare reproduction rejects error immediately.
  if(init?.redirect==='error')throw new TypeError('Unsupported redirect policy');
  assert.equal(init?.redirect,'manual');return new Response(rss);
 }});
 assert.equal(result.sources.length,2);assert.equal(result.provider,'web');
});

const expansionItem=(title:string,description:string,url:string)=>`<item><title><![CDATA[${title}]]></title><link>${url}</link><description><![CDATA[${description}]]></description></item>`;
const expansionFeed=(...items:string[])=>`<?xml version="1.0"?><rss version="2.0"><channel>${items.join('')}</channel></rss>`;

test('expansion search sends only the company name and fixed topic to Bing and preserves a bounded set of source leads',async()=>{
 const title='示远科技有限公司宣布开设新店';
 const snippet='示远科技有限公司在本地发布了新店选址公告。';
 const items=Array.from({length:12},(_,i)=>expansionItem(title,snippet,`https://news.example.cn/notice/${i}?src=official`));
 const requests:string[]=[];
 const result=await searchCompanyExpansion(deal,async(input,init)=>{
  requests.push(String(input));const url=new URL(String(input));
  assert.equal(url.origin,'https://www.bing.com');
  assert.equal(url.pathname,'/search');assert.equal(url.searchParams.get('format'),'rss');
  assert.match(url.searchParams.get('q')!,/^"示远科技有限公司" /);
  assert.match(url.searchParams.get('q')!,/开店|扩店|选址/);
  assert.equal(init?.method,'GET');assert.equal(init?.redirect,'manual');
  assert.equal(init?.body,undefined);
  return new Response(expansionFeed(...items));
 });
 assert.equal(requests.length,1);
 for(const value of ['PRIVATE_CONTACT','PRIVATE_NOTES','PRIVATE_FOLLOWUP','99887766','PRIVATE_TOKEN','shiyuan.example.cn'])assert.ok(!requests[0].includes(value));
 assert.equal(result.status,'partial');assert.equal(result.provider,'web');assert.equal(result.modelUsed,false);
 assert.deepEqual(result.facts,[]);
 assert.equal(result.sources.length,5);
 assert.deepEqual(result.sources.map(source=>source.id),['expansion-web-1','expansion-web-2','expansion-web-3','expansion-web-4','expansion-web-5']);
 assert.equal(result.sources[0].url,'https://news.example.cn/notice/0?src=official');
 assert.equal(result.sources[0].title,title);assert.equal(result.sources[0].snippet,snippet);
 assert.match(result.warnings.join(''),/待核实/);
});

test('expansion search ignores directory-only hits, partial or prefixed names, duplicate and invalid URLs',async()=>{
 const items=[
  expansionItem('示远科技有限公司 - 企业名录','注册地址为某市某区。','https://directory.example.cn/company'),
  expansionItem('示远科技集团扩店','示远科技集团公开新店选址。','https://news.example.cn/other'),
  expansionItem('北京示远科技有限公司开设新店','北京示远科技有限公司选址。','https://news.example.cn/prefix'),
  expansionItem('行业动态','近日示远科技有限公司宣布拓店。','https://news.example.cn/same'),
  expansionItem('示远科技有限公司 - 门店动态','新店选址启动。','https://news.example.cn/same'),
  expansionItem('示远科技有限公司 - 新店选址','示远科技有限公司开始扩店。','http://127.0.0.1/invalid'),
  expansionItem('企业动态','示远科技有限公司发布年报。远宁商贸有限公司开设新店。','https://news.example.cn/unrelated-sentence'),
  expansionItem('示远科技有限公司','其他企业：远宁商贸有限公司开设新店。','https://news.example.cn/unrelated-company'),
 ];
 const result=await searchCompanyExpansion(deal,async()=>new Response(expansionFeed(...items)));
 assert.deepEqual(result.sources.map(source=>source.url),['https://news.example.cn/same']);
 const empty=await searchCompanyExpansion(deal,async()=>new Response(expansionFeed(...items.slice(0,3))));
 assert.deepEqual(empty.sources,[]);assert.deepEqual(empty.facts,[]);
 assert.match(empty.summary,/未找到/);
});

test('malformed feeds and provider outages fail with a generic message after only fixed-host retries',async()=>{
 for(const response of [
  ()=>new Response('<html>PRIVATE_PROVIDER_BODY</html>'),
  ()=>new Response('<rss><channel><item>truncated'),
  ()=>new Response('<rss><channel><item>truncated</channel></rss>'),
  ()=>new Response('PRIVATE_PROVIDER_BODY',{status:503}),
  ()=>new Response('',{status:302,headers:{location:'http://127.0.0.1/private'}}),
 ]){
  const requests:string[]=[];
  await assert.rejects(searchCompanyExpansion(deal,async(input,init)=>{
   requests.push(new URL(String(input)).hostname);
   assert.equal(init?.redirect,'manual');
   return response();
  }),{message:'Public search unavailable'});
  assert.deepEqual(requests,['www.bing.com','cn.bing.com']);
 }
});
