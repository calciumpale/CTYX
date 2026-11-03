import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeMeetingSource,linkMeetingToWorkspace} from '../app/lib/meeting-analysis.ts';
import {createSeed} from '../app/lib/seed.ts';
import {salesFingerprint} from '../app/lib/sales-intelligence.ts';
import type {MeetingAnalysis,MeetingImport} from '../app/lib/meeting-import-types.ts';

const model={key:'synthetic-private-key',name:'test-chat',url:'https://model.example.com/v1/chat/completions'};
const source={minutes:'会议纪要：华星科技有限公司拟采购客户管理系统。王总参与需求评估，预算暂未确认，下周二提交方案。',transcript:'[00:01] 王总：我来自华星科技有限公司，我们需要客户管理系统，预算30万元还在审批。\n[00:15] 李明：我负责技术评估。'};
function grounded(){return {summary:'客户提出系统采购需求，预算尚在审批。',companies:[{name:'华星科技有限公司',quote:'华星科技有限公司拟采购客户管理系统。',source:'minutes',facts:[{field:'业务需求',value:'客户管理系统',quote:'华星科技有限公司拟采购客户管理系统。',source:'minutes'}]}],people:[{name:'王总',quote:'王总参与需求评估',source:'minutes',facts:[{field:'角色',value:'参与需求评估',quote:'王总参与需求评估',source:'minutes'}]},{name:'李明',quote:'李明：我负责技术评估。',source:'transcript',facts:[{field:'职责',value:'技术评估',quote:'李明：我负责技术评估。',source:'transcript'}]}],nextSteps:['核实预算审批时间','下周二提交方案']};}
const completion=(value:unknown)=>Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(value)}}]});
const pending:MeetingAnalysis={status:'pending',summary:'',companies:[],people:[],nextSteps:[]};
function fixture(overrides:Partial<MeetingImport>={}){const state=createSeed('2026-11-04T01:00:00.000Z');state.deals[0].dataOrigin='manual';state.deals[0].customerProfile={decisionChain:'人工确认的决策链',goals:'人工目标',concerns:'人工顾虑',budget:'人工核实预算',timeline:'人工确认时间'};const imported:MeetingImport={id:'meeting-import-test',dealId:state.deals[0].id,createdAt:'2026-11-04T02:00:00.000Z',createdBy:'当前销售',sourceHash:'a'.repeat(64),record:{key:'record-test',meetingRecordId:'record-1',recordFileId:'file-1',meetingCode:'123456789',subject:'客户系统采购讨论',state:'ready',kind:'audio',startedAt:'2026-11-03T08:00:00.000Z'},minutes:source.minutes,transcript:source.transcript,complete:true,warnings:[],analysis:pending,...overrides};return {state,imported};}

test('missing model keeps meeting material pending rather than inventing customer portraits',async()=>{
  const result=await analyzeMeetingSource(source,null);
  assert.equal(result.status,'needs_model');assert.deepEqual(result.companies,[]);assert.deepEqual(result.people,[]);assert.deepEqual(result.nextSteps,[]);assert.equal(result.summary,'');assert.match(result.message??'',/模型|配置/);
});

test('meeting extraction retains source-grounded entities while labels distinguish analysis from confirmed profiles',async t=>{
  let calls=0;
  t.mock.method(globalThis,'fetch',async(url:unknown,init:RequestInit)=>{calls++;assert.equal(url,model.url);const body=JSON.parse(String(init.body));assert.deepEqual(JSON.parse(body.messages[1].content),source);return completion(grounded());});
  const result=await analyzeMeetingSource(source,model);
  assert.equal(calls,1);assert.equal(result.status,'ready');assert.equal(result.companies[0].name,'华星科技有限公司');assert.equal(result.people[0].name,'王总');assert.equal(result.people[1].facts[0].source,'transcript');assert.match(result.summary,/分析|待核实/);assert.ok(result.nextSteps.every(step=>/建议|待核实/.test(step)));assert.match(result.message??'',/实名|身份|称呼/);
});

test('company names absent from their cited source are rejected',async t=>{
  const value=grounded();value.companies[0].name='海川实业有限公司';
  t.mock.method(globalThis,'fetch',async()=>completion(value));
  const result=await analyzeMeetingSource(source,model);assert.equal(result.status,'failed');assert.deepEqual(result.companies,[]);
});

test('minutes quotations cannot be relabelled as transcript quotations',async t=>{
  const value=grounded();value.companies[0].source='transcript';
  t.mock.method(globalThis,'fetch',async()=>completion(value));
  const result=await analyzeMeetingSource(source,model);assert.equal(result.status,'failed');assert.deepEqual(result.people,[]);
});

test('a real quote does not authorize an invented value or a different persons facts',async t=>{
  const values=[grounded(),grounded()];values[0].companies[0].facts[0].value='预算已批准';values[1].people[0].facts=[{field:'职责',value:'技术评估',quote:'李明：我负责技术评估。',source:'transcript'}];
  for(const value of values){t.mock.method(globalThis,'fetch',async()=>completion(value));assert.equal((await analyzeMeetingSource(source,model)).status,'failed');t.mock.restoreAll();}
});

test('unsupported verified-identity assertions and excessive entity counts fail closed',async t=>{
  const values=[grounded(),grounded(),grounded()];values[0].people[0].facts[0].field='已核实法定决策人';values[1].companies=Array.from({length:9},()=>grounded().companies[0]);values[2].people=Array.from({length:13},()=>grounded().people[0]);
  for(const value of values){t.mock.method(globalThis,'fetch',async()=>completion(value));assert.equal((await analyzeMeetingSource(source,model)).status,'failed');t.mock.restoreAll();}
});

test('model failures expose no provider secrets and leave the original meeting source unchanged',async t=>{
  const before=structuredClone(source);t.mock.method(globalThis,'fetch',async()=>{throw new Error('synthetic-private-key provider body');});
  const result=await analyzeMeetingSource(source,model);assert.equal(result.status,'failed');assert.deepEqual(source,before);assert.ok(!JSON.stringify(result).includes('synthetic-private-key'));assert.deepEqual(result.companies,[]);
});

test('empty sources do not produce profiles or call a model',async t=>{
  t.mock.method(globalThis,'fetch',async()=>{assert.fail('empty meeting cannot invoke model');});
  const result=await analyzeMeetingSource({minutes:'',transcript:''},model);assert.equal(result.status,'failed');assert.deepEqual(result.people,[]);
});

test('bounded source analysis clearly states that only a portion was analyzed',async t=>{
  const long={minutes:source.minutes+'很长的纪要。'.repeat(20000),transcript:source.transcript};
  t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{assert.ok(String(init.body).length<100000);return completion(grounded());});
  const result=await analyzeMeetingSource(long,model);assert.equal(result.status,'ready');assert.match(result.message??'',/部分|片段|前段|截断/);
});

test('linking a meeting changes sales evidence once and preserves all manually entered customer fields',async()=>{
  const {state,imported}=fixture(),before=structuredClone(state),fingerprint=await salesFingerprint(state.deals[0],state.transcripts??[]);
  const result=linkMeetingToWorkspace(state,imported),deal=result.state.deals[0];
  assert.equal(result.changed,true);assert.deepEqual(state,before);assert.equal(result.state.revision,before.revision+1);assert.equal(deal.version,before.deals[0].version+1);
  for(const key of ['name','contact','position','amount','stage','ownerId','customerProfile'] as const)assert.deepEqual(deal[key],before.deals[0][key]);
  assert.notEqual(await salesFingerprint(deal,result.state.transcripts??[]),fingerprint);assert.equal(deal.notes.filter(n=>n.id==='meeting-note-meeting-import-test').length,1);assert.equal(result.state.transcripts?.filter(t=>t.id==='transcript-meeting-meeting-import-test').length,1);assert.equal(result.state.transcripts?.find(t=>t.id==='transcript-meeting-meeting-import-test')?.source,'meeting');
  const repeated=linkMeetingToWorkspace(result.state,imported);assert.equal(repeated.changed,false);assert.deepEqual(repeated.state,result.state);
});

test('minutes-only imports never become a purported verbatim call transcript or save model guesses as source evidence',()=>{
  const {state,imported}=fixture({transcript:'',analysis:{status:'ready',summary:'绝不应被当成事实的模型总结',companies:[],people:[],nextSteps:['模型建议批准优惠']}});
  const result=linkMeetingToWorkspace(state,imported);assert.equal(result.changed,true);assert.deepEqual(result.state.transcripts,state.transcripts);const note=result.state.deals[0].notes.find(n=>n.id==='meeting-note-meeting-import-test')!;
  assert.match(note.text,/纪要/);assert.match(note.text,/摘要|非逐字|不是逐字/);assert.ok(note.text.includes(source.minutes));assert.ok(!note.text.includes('绝不应被当成事实的模型总结'));assert.ok(!note.text.includes('模型建议批准优惠'));
});

test('source excerpts are bounded without mutating or dropping the independent original import',()=>{
  const {state,imported}=fixture({minutes:'原始纪要'.repeat(10000),transcript:'真实转写'.repeat(30000)}),before=structuredClone(imported);
  const result=linkMeetingToWorkspace(state,imported),note=result.state.deals[0].notes.find(n=>n.id==='meeting-note-meeting-import-test')!,transcript=result.state.transcripts?.find(t=>t.id==='transcript-meeting-meeting-import-test');
  assert.ok(transcript);
  assert.ok(note.text.length<=5000);assert.ok(transcript.text.length<=50000);assert.match(note.text,/片段|前段|摘录/);assert.match(transcript.text,/片段|前段|摘录/);assert.deepEqual(imported,before);
});

test('a replay cannot attach an existing meeting source to a different project',()=>{
  const {state,imported}=fixture(),linked=linkMeetingToWorkspace(state,imported);
  assert.throws(()=>linkMeetingToWorkspace(linked.state,{...imported,dealId:state.deals[1].id}),{status:409});
});

test('a deleted project and exhausted transcript capacity leave the workspace untouched',()=>{
  const {state,imported}=fixture();assert.throws(()=>linkMeetingToWorkspace(state,{...imported,dealId:'missing-project'}),{status:404});
  state.transcripts=[{id:'old',dealId:state.deals[0].id,employeeId:'sales-1',employeeName:'销售',source:'file',text:'长'.repeat(500000),createdAt:imported.createdAt}];const before=structuredClone(state);
  assert.throws(()=>linkMeetingToWorkspace(state,imported),{status:413});assert.deepEqual(state,before);
});
