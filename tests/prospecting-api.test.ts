import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {trustedMemberHeaders} from '../app/lib/member-auth.ts';
import {createProspectingService} from '../app/lib/prospecting-service.ts';
import type {MemberSession} from '../app/lib/member-types.ts';
import type {ProspectBridgeJob,ProspectSnapshot} from '../app/lib/prospecting-types.ts';

const origin='https://prospecting-api.test';
const actors={
 sales:{ownerId:'owner-a',member:{accountId:'member-a',username:'sales',displayName:'销售甲',role:'sales',salesId:'sales-1'}},
 manager:{ownerId:'owner-a',member:{accountId:'member-b',username:'manager',displayName:'管理者乙',role:'manager'}},
 otherTenant:{ownerId:'owner-b',member:{accountId:'member-c',username:'sales',displayName:'另一工作空间销售',role:'sales',salesId:'sales-2'}},
} satisfies Record<string,{ownerId:string;member:MemberSession}>;
type Actor=typeof actors[keyof typeof actors];
interface Credentials {deviceId:string;deviceToken:string}
interface Mutation {snapshot:ProspectSnapshot;deviceCredentials?:Credentials;campaignId?:string;message:string}
const sender={authenticated:true,accountId:'MS4wSenderApi001',accountName:'集成测试账号'};
const candidate={id:'MS4wCompetitor001',nickname:'竞品测试账号',profileUrl:'https://www.douyin.com/user/MS4wCompetitor001',description:'销售培训工具',reason:'搜索词命中的公开作品',videos:[{id:'7654321234567890',title:'销售团队如何培训',url:'https://www.douyin.com/video/7654321234567890'}]};
const comment={id:'comment-api-1',videoId:candidate.videos[0].id,text:'这个培训工具多少钱，可以试用吗？',nickname:'评论用户甲',profileUrl:'https://www.douyin.com/user/MS4wRecipient001',recipientId:'MS4wRecipient001'};

function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 for(const file of readdirSync(new URL('../drizzle/',import.meta.url)).filter(name=>name.endsWith('.sql')).sort()){
  sqlite.exec(readFileSync(new URL(`../drizzle/${file}`,import.meta.url),'utf8'));
 }
 const insert=sqlite.prepare('INSERT INTO workbench_member_accounts(account_id,owner_id,username,display_name,role,sales_id,enabled,password_salt,password_hash,password_iterations,created_at,updated_at) VALUES (?,?,?,?,?,?,1,?,?,100000,?,?)');
 for(const {ownerId,member} of Object.values(actors))insert.run(member.accountId,ownerId,member.username,member.displayName,member.role,'salesId' in member?member.salesId:null,'test-only-salt','test-only-hash','2026-11-05T00:00:00.000Z','2026-11-05T00:00:00.000Z');
 const db={
  prepare(sql:string){
   let values:unknown[]=[];
   return{
    bind(...args:unknown[]){values=args;return this;},
    async first(){return sqlite.prepare(sql).get(...values as never[])??null;},
    async all(){return{results:sqlite.prepare(sql).all(...values as never[])};},
    async run(){return{meta:{changes:Number(sqlite.prepare(sql).run(...values as never[]).changes)}};},
   };
  },
  async batch(statements:{run:()=>Promise<unknown>}[]){
   sqlite.exec('BEGIN');
   try{const results=[];for(const statement of statements)results.push(await statement.run());sqlite.exec('COMMIT');return results;}
   catch(error){sqlite.exec('ROLLBACK');throw error;}
  },
 } as unknown as D1Database;
 const service=createProspectingService({db,readModel:async(ownerId,siteOrigin)=>{
  assert.ok(['owner-a','owner-b'].includes(ownerId));assert.equal(siteOrigin,origin);return null;
 }});
 function business(actor:Actor=actors.sales,input?:Record<string,unknown>,campaignId?:string){
  const headers=trustedMemberHeaders(new Headers({'oai-authenticated-user-id':actor.ownerId,'oai-authenticated-user-email':`${actor.ownerId}@example.test`}),actor.member);
  if(input){headers.set('Origin',origin);headers.set('Content-Type','application/json');}
  const query=campaignId?`?campaignId=${encodeURIComponent(campaignId)}`:'';
  return service.handle(new Request(`${origin}/api/prospecting${query}`,{method:input?'POST':'GET',headers,...(input?{body:JSON.stringify(input)}:{})}));
 }
 function bridge(credentials:Credentials,action:'poll'|'heartbeat'|'complete',input:Record<string,unknown>={}){
  return service.bridge(new Request(`${origin}/api/prospecting-bridge/${action}`,{method:'POST',headers:{Authorization:`Bearer ${credentials.deviceToken}`,'Content-Type':'application/json'},body:JSON.stringify({...input,deviceId:credentials.deviceId})}),action);
 }
 return{sqlite,business,bridge};
}
async function body<T>(response:Response,expectedStatus=200):Promise<T>{
 const value=await response.json();assert.equal(response.status,expectedStatus,JSON.stringify(value));
 assert.match(response.headers.get('cache-control')??'',/no-store/);
 return value as T;
}
async function connect(f:ReturnType<typeof fixture>,actor:Actor=actors.sales){
 const result=await body<Mutation>(await f.business(actor,{action:'connect',label:'API集成测试本机'}));
 assert.ok(result.deviceCredentials);assert.match(result.deviceCredentials.deviceToken,/^[a-f0-9]{64}$/);
 return result.deviceCredentials;
}
async function create(f:ReturnType<typeof fixture>,actor:Actor=actors.sales){
 const result=await body<Mutation>(await f.business(actor,{action:'create',requirements:'中小企业销售培训工具，面向希望提升销售能力的团队',keywords:[],reviewMode:'manual',greetingTemplate:'你好，可以介绍培训工具的试用方式。',minIntentScore:70,maxCommentsPerVideo:30,dailyLimit:10}));
 assert.ok(result.campaignId);assert.equal(result.snapshot.campaign?.id,result.campaignId);assert.equal(result.snapshot.modelReady,false);assert.ok(result.snapshot.campaign!.keywords.length>0);
 return result.campaignId;
}
async function claim(f:ReturnType<typeof fixture>,credentials:Credentials,kind:ProspectBridgeJob['kind']){
 const result=await body<{job:ProspectBridgeJob|null}>(await f.bridge(credentials,'poll',sender));
 assert.ok(result.job,`expected a ${kind} job`);assert.equal(result.job.kind,kind);assert.match(result.job.leaseToken,/^[a-f0-9]{64}$/);
 return result.job;
}
async function complete(f:ReturnType<typeof fixture>,credentials:Credentials,job:ProspectBridgeJob,result:Record<string,unknown>){
 const response=await body<{ok:boolean}>(await f.bridge(credentials,'complete',{jobId:job.id,leaseToken:job.leaseToken,result}));assert.equal(response.ok,true);
}

test('API workflow discovers real-shaped sources, collects comments, binds edited approval and records submitted once',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());
 const initial=await body<ProspectSnapshot>(await f.business());assert.deepEqual(initial.campaigns,[]);assert.deepEqual(initial.leads,[]);assert.equal(initial.device.online,false);
 const credentials=await connect(f);
 const storedToken=f.sqlite.prepare('SELECT token_hash FROM workbench_prospect_devices WHERE id=?').get(credentials.deviceId)!;
 assert.notEqual(storedToken.token_hash,credentials.deviceToken);
 assert.deepEqual(await body<{job:null}>(await f.bridge(credentials,'poll',sender)),{job:null});
 const campaignId=await create(f);
 const discovery=await body<Mutation>(await f.business(actors.sales,{action:'discover',campaignId}));
 assert.equal(discovery.snapshot.jobs.length,1);assert.equal(discovery.snapshot.jobs[0].status,'queued');
 const discoveryJob=await claim(f,credentials,'discover');assert.equal(discoveryJob.campaignId,campaignId);assert.deepEqual(discoveryJob.input.keywords,discovery.snapshot.campaign!.keywords);
 await complete(f,credentials,discoveryJob,{candidates:[candidate]});
 const discovered=await body<ProspectSnapshot>(await f.business(actors.sales,undefined,campaignId));
 assert.equal(discovered.campaign?.candidates.length,1);assert.equal(discovered.campaign?.candidates[0].profileUrl,candidate.profileUrl);assert.deepEqual(discovered.campaign?.candidates[0].videos,candidate.videos);
 assert.equal(discovered.device.authenticated,true);assert.equal(discovered.device.accountId,sender.accountId);
 assert.ok(!JSON.stringify(discovered).includes(credentials.deviceToken));assert.ok(!('tokenHash' in discovered.device));

 const collecting=await body<Mutation>(await f.business(actors.sales,{action:'collect',campaignId,candidateIds:[candidate.id]}));
 assert.deepEqual(collecting.snapshot.campaign?.selectedCandidateIds,[candidate.id]);
 const collectJob=await claim(f,credentials,'collect');assert.deepEqual(collectJob.input.videos,candidate.videos);assert.equal(collectJob.input.maxCommentsPerVideo,30);
 await complete(f,credentials,collectJob,{comments:[comment],warnings:[]});
 const collected=await body<ProspectSnapshot>(await f.business(actors.sales,undefined,campaignId));
 assert.equal(collected.leads.length,1);const lead=collected.leads[0];
 assert.equal(lead.text,comment.text);assert.equal(lead.videoUrl,candidate.videos[0].url);assert.equal(lead.recipientId,comment.recipientId);assert.equal(lead.analysisSource,'rules');assert.equal(lead.status,'pending');
 assert.equal(collected.jobs.filter(job=>job.kind==='send').length,0,'unreviewed rule output must not send');
 const greeting='你好，看到你想了解试用，可以先听听你们的培训需求吗？';
 const reviewed=await body<Mutation>(await f.business(actors.sales,{action:'review',campaignId,leadId:lead.id,version:lead.version,decision:'approve',greeting}));
 assert.equal(reviewed.snapshot.leads[0].status,'queued');assert.equal(reviewed.snapshot.leads[0].greeting,greeting);assert.equal(reviewed.snapshot.leads[0].reviewedBy,actors.sales.member.displayName);assert.ok(reviewed.snapshot.leads[0].version>lead.version);
 await body<{error:string}>(await f.business(actors.sales,{action:'review',campaignId,leadId:lead.id,version:lead.version,decision:'approve',greeting:'重复审核不得覆盖文案'}),409);
 const sendJob=await claim(f,credentials,'send');
 assert.equal(sendJob.input.message,greeting);assert.equal(sendJob.input.recipientId,comment.recipientId);assert.equal(sendJob.input.profileUrl,comment.profileUrl);assert.equal(sendJob.input.senderAccountId,sender.accountId);
 const sending=await body<ProspectSnapshot>(await f.business(actors.sales,undefined,campaignId));assert.equal(sending.leads[0].status,'sending');
 assert.deepEqual(await body<{ok:boolean}>(await f.bridge(credentials,'heartbeat',{jobId:sendJob.id,leaseToken:sendJob.leaseToken})),{ok:true});
 await complete(f,credentials,sendJob,{outcome:'submitted',evidence:'测试夹具模拟浏览器看到新提交消息；未调用外部服务'});
 await complete(f,credentials,sendJob,{outcome:'submitted',evidence:'模拟重复上报相同完成结果'});
 const finished=await body<ProspectSnapshot>(await f.business(actors.sales,undefined,campaignId));
 assert.equal(finished.leads[0].status,'submitted');assert.equal(finished.jobs.filter(job=>job.kind==='send').length,1);
 const sent=finished.jobs.find(job=>job.id===sendJob.id)!;assert.equal(sent.status,'done');assert.match(sent.summary??'',/已提交/);assert.match(sent.summary??'',/未验证送达/);
 assert.deepEqual(await body<{job:null}>(await f.bridge(credentials,'poll',sender)),{job:null},'completed send must not be offered again');
});

test('API scopes campaigns to their member and tenant; device and lease credentials cannot cross those scopes',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const credentials=await connect(f);const otherCredentials=await connect(f,actors.manager);
 await body(await f.bridge(credentials,'poll',sender));const campaignId=await create(f);
 for(const actor of [actors.manager,actors.otherTenant]){
  const own=await body<ProspectSnapshot>(await f.business(actor));assert.deepEqual(own.campaigns,[]);assert.deepEqual(own.leads,[]);
  await body<{error:string}>(await f.business(actor,undefined,campaignId),404);
  await body<{error:string}>(await f.business(actor,{action:'discover',campaignId}),404);
  await body<{error:string}>(await f.business(actor,{action:'collect',campaignId,candidateIds:[candidate.id]}),404);
 }
 await body<{error:string}>(await f.bridge({...credentials,deviceToken:'0'.repeat(64)},'poll',sender),401);
 await body<{error:string}>(await f.bridge({...credentials,deviceToken:otherCredentials.deviceToken},'poll',sender),401);
 await body(await f.business(actors.sales,{action:'discover',campaignId}));const job=await claim(f,credentials,'discover');
 assert.deepEqual(await body<{job:null}>(await f.bridge(otherCredentials,'poll',{...sender,accountId:'MS4wOtherSender001'})),{job:null});
 await body<{error:string}>(await f.bridge(otherCredentials,'complete',{jobId:job.id,leaseToken:job.leaseToken,result:{candidates:[candidate]}}),409);
 await body<{error:string}>(await f.bridge(credentials,'complete',{jobId:job.id,leaseToken:'f'.repeat(64),result:{candidates:[candidate]}}),409);
 const untouched=await body<ProspectSnapshot>(await f.business(actors.sales,undefined,campaignId));assert.equal(untouched.jobs[0].status,'running');assert.deepEqual(untouched.campaign?.candidates,[]);
 await complete(f,credentials,job,{candidates:[candidate]});
});

test('disabled business member immediately loses API and device access, including an already leased job',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const credentials=await connect(f);await body(await f.bridge(credentials,'poll',sender));const campaignId=await create(f);
 await body(await f.business(actors.sales,{action:'discover',campaignId}));const job=await claim(f,credentials,'discover');
 f.sqlite.prepare('UPDATE workbench_member_accounts SET enabled=0 WHERE owner_id=? AND account_id=?').run(actors.sales.ownerId,actors.sales.member.accountId);
 await body<{error:string}>(await f.business(actors.sales,undefined,campaignId),403);
 await body<{error:string}>(await f.business(actors.sales,{action:'create',requirements:'停用账号不应创建获客任务',keywords:['销售培训']}),403);
 await body<{error:string}>(await f.bridge(credentials,'poll',sender),401);
 await body<{error:string}>(await f.bridge(credentials,'heartbeat',{jobId:job.id,leaseToken:job.leaseToken}),401);
 await body<{error:string}>(await f.bridge(credentials,'complete',{jobId:job.id,leaseToken:job.leaseToken,result:{candidates:[candidate]}}),401);
 const unchanged=f.sqlite.prepare('SELECT status FROM workbench_prospect_jobs WHERE id=?').get(job.id)!;assert.equal(unchanged.status,'running');
 const rawCampaign=f.sqlite.prepare('SELECT data_json FROM workbench_prospect_campaigns WHERE id=?').get(campaignId)!;assert.deepEqual(JSON.parse(String(rawCampaign.data_json)).candidates,[]);
});
