import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModelMessages } from '../app/lib/model-messages.ts';
import { createSeed } from '../app/lib/seed.ts';
import type { GenerationInput } from '../app/lib/domain.ts';
const input = (extra: Partial<GenerationInput> = {}): GenerationInput => ({query:'1+1等于几？只给答案',agentId:'insight',deals:[],knowledge:[],purpose:'chat',...extra});

test('main chat follows the actual latest question without a mandatory sales template',()=>{
 const messages=buildModelMessages(input());
 assert.match(messages[0].content,/优先.*当前问题/);
 assert.match(messages[0].content,/普通问答/);
 assert.match(messages[0].content,/避免连续重复同一句式/);
 assert.match(messages.at(-1)!.content,/用户当前问题：\n1\+1等于几？只给答案$/);
 assert.doesNotMatch(messages[0].content,/仅依据提供的授权客户与已发布知识/);
});
test('only verified previous conversation turns become alternating chat messages',()=>{
 const messages=buildModelMessages(input({history:[{query:'客户本次预算20万',answer:'已知预算20万。'},{query:'写一段开场',answer:'您好，我们先确认目标。'}],query:'把刚才那段缩成一句'}));
 assert.deepEqual(messages.slice(1,-1).map(({role,content})=>({role,content})),[{role:'user',content:'客户本次预算20万'},{role:'assistant',content:'已知预算20万。'},{role:'user',content:'写一段开场'},{role:'assistant',content:'您好，我们先确认目标。'}]);
 assert.match(messages.at(-1)!.content,/把刚才那段缩成一句$/);
});
test('workflow nodes retain their actual instruction, upstream outputs and approved knowledge',()=>{
 const messages=buildModelMessages(input({purpose:'workflow',instruction:'输出三条核对事项',previous:'客户预算待确认',knowledge:[{id:'k',title:'授权边界',content:'超过30天须审批',category:'政策',source:'管理者',status:'published',updatedAt:''}]}));
 assert.match(messages[0].content,/节点/);
 for(const text of ['输出三条核对事项','客户预算待确认','授权边界'])assert.ok(messages.at(-1)!.content.includes(text));
 assert.match(messages[0].content,/合成示例/);
 assert.match(messages[0].content,/不能批准/);
 assert.match(messages[0].content,/避免连续重复同一句式/);
});
test('knowledge and past assistant output never replace the latest user question',()=>{
 const messages=buildModelMessages(input({query:'只解释风险的含义',previous:'旧专家回复',history:[{query:'旧问题',answer:'旧回复'}]}));
 assert.equal(messages[1].role,'user');assert.equal(messages[2].role,'assistant');
 assert.match(messages.at(-1)!.content,/用户当前问题：\n只解释风险的含义$/);
 assert.match(messages[0].content,/资料.*指令/);
});


test('stale assessments and workflow checkpoint assessments are excluded from model facts',()=>{
 const deal=createSeed('2026-10-24T02:00:00Z').deals[0];
 deal.intelligence={status:'stale',sourceHash:'new',updatedAt:'2026-10-24',modelName:'test',message:'pending',history:[],latest:{sourceHash:'old',sourceVersion:deal.version,assessedAt:'2026-10-24',modelName:'test',insight:{score:90,grade:'A',summary:'obsolete-derived-score',dimensions:[],nextActions:[],missingInfo:[]},forecast:{kind:'estimated',probability:80,range:{low:70,high:90},confidence:'low',summary:'obsolete-derived-forecast',factors:[],nextActions:[]},warnings:[]}};
 const chat=buildModelMessages(input({deal,deals:[deal]}));assert.doesNotMatch(chat.at(-1)!.content,/obsolete-derived/);assert.match(chat[0].content,/尚未经历史数据校准/);
 deal.intelligence.status='ready';deal.intelligence.sourceHash='old';
 const workflow=buildModelMessages(input({deal,deals:[deal],purpose:'workflow'}));assert.doesNotMatch(workflow.at(-1)!.content,/obsolete-derived/);assert.match(workflow.at(-1)!.content,/历史快照/);
 const current=buildModelMessages(input({deal,deals:[deal]}));assert.match(current.at(-1)!.content,/obsolete-derived-score/);
});
