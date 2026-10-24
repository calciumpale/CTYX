import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewContract, validateContractAnalysis } from '../app/lib/contract-review.ts';
import type { ContractReviewInput } from '../app/lib/contract-types.ts';

const text='销售合同\n甲方：远山科技\n乙方：青禾服务\n第一条 乙方应在签约后五日内交付，甲方可以无期限延迟支付全部款项。\n第二条 双方应书面确认验收结果。';
const input:ContractReviewInput={text,title:'服务采购',contractType:'服务合同',ourParty:'乙方',focus:'付款和责任'};
const quote='甲方可以无期限延迟支付全部款项。';
type Prompt={clauses:{id:string;text:string;start:number}[];[key:string]:unknown};
function payload(messages:{role:'system'|'user';content:string}[]):Prompt {return JSON.parse(messages[1].content);}
function response(prompt:Prompt,overrides:Record<string,unknown>={}) {
  const clause=prompt.clauses.find(c=>c.text.includes(quote));
  return JSON.stringify({summary:'付款期限与交付义务不对等，建议先明确支付节点。',reviewedClauseIds:prompt.clauses.map(c=>c.id),findings:clause?[{clauseId:clause.id,quote,level:'high',title:'付款期限不明确',reason:'付款可被无限推迟。',suggestion:'约定明确付款时间。',replacement:'甲方应在验收通过后十个工作日内支付对应款项。'}]:[],missingItems:[],warnings:[],...overrides});
}

test('contract review uses model findings and computes exact source offsets',async()=>{
  const result=await reviewContract(input,async messages=>response(payload(messages)));
  assert.equal(result.findings.length,1);assert.equal(result.findings[0].start,text.indexOf(quote));
  assert.equal(text.slice(result.findings[0].start,result.findings[0].end),quote);
  assert.equal(result.findings[0].status,'open');assert.equal(result.findings[0].level,'high');
  assert.equal(result.coverage.characters,text.length);assert.equal(result.coverage.chunks,1);
  assert.deepEqual(validateContractAnalysis(result,text),result);
});

test('every source character is covered across bounded model batches',async()=>{
  const source=('第一条 项目条款😀。\n'+ '条件须双方确认。'.repeat(900)+'\n').repeat(4)+'最后一条：争议应协商处理。';
  const seen:{id:string;text:string;start:number}[]=[];let calls=0;
  const result=await reviewContract({...input,text:source},async messages=>{
    const p=payload(messages);calls++;seen.push(...p.clauses);
    assert.ok(p.clauses.every(c=>c.text.length<=4000));
    assert.ok(p.clauses.reduce((n,c)=>n+c.text.length,0)<=16000);
    return response(p,{missingItems:[{title:'验收期限',reason:'本段未明确。',suggestion:'结合全文核对验收期限。'}]});
  });
  assert.ok(calls>1);assert.equal(seen.map(c=>c.text).join(''),source);
  for(const c of seen)assert.equal(source.slice(c.start,c.start+c.text.length),c.text);
  assert.equal(result.coverage.clauses,seen.length);assert.equal(result.coverage.chunks,calls);
  assert.ok(result.warnings.some(s=>s.includes('跨章节')));
  assert.ok(result.missingItems.every(item=>item.title.includes('待核对')));
});

test('fabricated, ambiguous and unknown clause anchors fail the whole review',async()=>{
  for(const finding of [
    {clauseId:'clause-1',quote:'不存在的原文',level:'high'},
    {clauseId:'clause-999',quote,level:'high'},
    {clauseId:'clause-1',quote:'双方',level:'high'},
  ]){
    const source=finding.quote==='双方'?'双方约定。双方另行确认。':text;
    await assert.rejects(()=>reviewContract({...input,text:source},async messages=>response(payload(messages),{findings:[{title:'风险',reason:'原因',suggestion:'建议',replacement:'修改文本',...finding}]})),/原文|定位|条款/);
  }
});

test('omitted clause coverage, invalid levels and invalid JSON cannot be saved',async()=>{
  await assert.rejects(()=>reviewContract(input,async messages=>response(payload(messages),{reviewedClauseIds:[]})),/覆盖|条款/);
  await assert.rejects(()=>reviewContract(input,async messages=>{
    const p=payload(messages);return response(p,{findings:[{clauseId:p.clauses[0].id,quote,level:'critical',title:'风险',reason:'原因',suggestion:'建议',replacement:'替换'}]});
  }),/等级|格式/);
  await assert.rejects(()=>reviewContract(input,async()=>'{PRIVATE_PROVIDER_REPLY'),error=>error instanceof Error&&!error.message.includes('PRIVATE_PROVIDER_REPLY'));
});

test('all chunks must succeed and provider failures are not converted into synthetic reviews',async()=>{
  let calls=0;const source='文本条款。'.repeat(4000);
  await assert.rejects(()=>reviewContract({...input,text:source},async messages=>{
    if(++calls===2)throw new Error('model unavailable');return response(payload(messages));
  }),/model unavailable/);
  assert.equal(calls,2);
});

test('input rejects empty or oversized sources before the model is called',async()=>{
  let calls=0;const generate=async()=>{calls++;return '{}';};
  await assert.rejects(()=>reviewContract({...input,text:'   '},generate),/正文|内容/);
  await assert.rejects(()=>reviewContract({...input,text:'字'.repeat(80001)},generate),/80000|8 万|长度/);
  assert.equal(calls,0);
});

test('missing clauses remain unanchored and party uncertainty stays visible',async()=>{
  const result=await reviewContract({...input,ourParty:'待确认'},async messages=>response(payload(messages),{missingItems:[{title:'验收标准',reason:'正文未约定可执行标准。',suggestion:'补充验收方式与期限。'}]}));
  assert.equal(result.missingItems.length,1);assert.ok(!Object.hasOwn(result.missingItems[0],'start'));
  assert.ok(result.warnings.some(w=>w.includes('我方')&&w.includes('待确认')));
});

test('duplicate findings merge while separate risks on the same quote remain distinct',async()=>{
  const result=await reviewContract(input,async messages=>{
    const p=payload(messages);const raw=JSON.parse(response(p));return JSON.stringify({...raw,findings:[...raw.findings,...raw.findings,{...raw.findings[0],title:'交付与付款失衡'}]});
  });
  assert.equal(result.findings.length,2);assert.notEqual(result.findings[0].id,result.findings[1].id);
});

test('validator rejects tampered offsets, coverage, ids, bounds and levels',async()=>{
  const valid=await reviewContract(input,async messages=>response(payload(messages)));
  const changed=(patch:Record<string,unknown>)=>({...valid,findings:[{...valid.findings[0],...patch}]});
  for(const patch of [{start:-1},{start:NaN},{end:text.length+1},{clauseId:'unknown'},{level:'critical'},{status:'approved'},{id:''}])assert.throws(()=>validateContractAnalysis(changed(patch) as never,text));
  assert.throws(()=>validateContractAnalysis({...valid,coverage:{...valid.coverage,characters:1}},text));
  assert.throws(()=>validateContractAnalysis({...valid,missingItems:[{id:'x',title:'',reason:'x',suggestion:'x'}]},text));
});
