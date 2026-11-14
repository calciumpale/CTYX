import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { assertMemberApi, executeMemberAction } from '../app/lib/member-policy.ts';
import { RECORDING_INBOX_DEAL_ID } from '../app/lib/recording-inbox-types.ts';
import { ensureRecordingInbox } from '../app/lib/recording-inbox.ts';
import { createRecordingProcessing } from '../app/lib/recording-processing.ts';
import { persistSalesWorkspace } from '../app/lib/sales-report-store.ts';
import { createSeed } from '../app/lib/seed.ts';
import type { ModelMessage } from '../app/lib/model-client.ts';
import type { SpeechTranscriptionJob } from '../app/lib/speech-types.ts';
import type { WorkbenchState } from '../app/lib/types.ts';

const at = '2026-11-14T03:00:00.000Z';
const recording = { id:'recording-9a83c9a6-61ce-489c-bd7a-a6dba42ee69a', name:'沟通录音.wav', size:1024, mimeType:'audio/wav' };
const source = { dealId:'source-deal', recordingId:recording.id, jobId:'fixture-job' };
const quote = '澄光咖啡要为陆家嘴一号店另找位置，周五前确认新店预算。';
const supported = (text: string) => ({ text, evidenceIds: ['s1'] });
const response = JSON.stringify({ companyName:'澄光咖啡', projectName:'陆家嘴一号店',
  summary:supported('讨论陆家嘴一号店的新址。'), decisions:[supported('周五前确认预算。')],
  followup:supported('周五前和客户确认新店预算。'), profile:{ goals:supported('为陆家嘴一号店另找位置。') },
});

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE workbench_workspaces (user_id TEXT PRIMARY KEY, revision INTEGER, state_json TEXT, updated_at TEXT)');
  sqlite.exec(readFileSync(new URL('../drizzle/0004_reflective_lilandra.sql', import.meta.url),'utf-8'));
  sqlite.exec(readFileSync(new URL('../drizzle/0005_nebulous_tarantula.sql', import.meta.url),'utf-8'));
  const db = {
    prepare(sql: string) {
      let params: SQLInputValue[] = [];
      return {
        bind(...values: SQLInputValue[]) { params = values; return this; },
        async first() { return sqlite.prepare(sql).get(...params) ?? null; },
        async run() { return {meta:{changes:Number(sqlite.prepare(sql).run(...params).changes)}}; },
      };
    },
    async batch(statements: {run(): Promise<unknown>}[]) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  } as unknown as D1Database;
  const state = createSeed(at);
  const base = { ...state.deals[0], ownerId:'sales-1', dataOrigin:'manual' as const, archive:undefined, notes:[], version:7,
    customerProfile:{decisionChain:'陈经理确认',goals:'原目标',concerns:'交付',budget:'原预算',timeline:'原时间'},
  };
  const target = { ...base, id:'target-deal', name:'澄光咖啡', projectName:'陆家嘴一号店' };
  state.deals = [{...base, id:source.dealId, name:'源项目', projectName:'原始录音',
    notes:[{id:'source-note',text:'上传的录音',author:'原作者',date:at,recording}]}, target,
    {...target, id:'private-deal', ownerId:'sales-2'},
  ];
  const job: SpeechTranscriptionJob = { ...source, id:source.jobId, status:'completed', progress:100, message:'', linked:false,
    createdAt:at,updatedAt:at,result:{text:quote,rawText:quote,segments:[{start:5,end:16,speaker:'two',text:quote,rawText:quote}],
      speakers:[{id:'two',label:'讲话人 2'}], corrections:[], diarization:true, durationSeconds:20, model:'asr', hotwordVersion:1,dialectHint:'auto'},
  };
  sqlite.prepare('INSERT INTO workbench_workspaces (user_id, revision, state_json) VALUES (?,?,?)').run('owner',state.revision,JSON.stringify(state));
  sqlite.prepare('INSERT INTO workbench_recording_transcriptions (user_id, deal_id, recording_id, version, updated_at, data_json) VALUES (?,?,?,?,?,?)').run('owner',source.dealId,source.recordingId,1,at,JSON.stringify(job));
  const scope = {salesId:'sales-1',displayName:'录入人',accountId:'member'};
  const context = {ownerId:'owner', memberId:'member', role:'sales' as const, salesScope:scope};
  const load = () => JSON.parse(String(sqlite.prepare('SELECT state_json FROM workbench_workspaces').get()?.state_json)) as WorkbenchState;
  const modelCalls: ModelMessage[][] = [];
  const generate = async (messages: ModelMessage[]) => { modelCalls.push(messages); return response; };
  const service = createRecordingProcessing(db);
  const apply = async (payload:Record<string, unknown>, actor = context, beforeCommit?: () => void) => {
    const before = load();
    const write = await service.prepareApply(actor,before,payload);
    const result = await executeMemberAction(before,actor.role,'recording_apply',payload,{salesScope:actor.salesScope,actorName:'录入人',now:at, trustedRecordingProcessing:write.apply});
    beforeCommit?.();
    await persistSalesWorkspace(db,actor.ownerId,before.revision,result.state,[],write.receipt,write.precondition);
    return result;
  };
  return {sqlite,db,state,target,job,load,scope,service,context,generate,modelCalls,apply};
}

test('an exact full speech result generates grounded model output without a project write', async t => {
  const f = fixture(); t.after(()=>f.sqlite.close());
  const draft = await f.service.generate(f.context,f.state,source,f.generate);
  assert.equal(f.modelCalls.length,1);
  assert.ok(f.modelCalls[0][1].content.includes(quote));
  assert.ok(f.modelCalls[0][1].content.includes('讲话人 2'));
  assert.equal(draft.matchedDealId,f.target.id);
  assert.equal(draft.targetVersion,f.target.version);
  assert.deepEqual(draft.evidence,[quote]);
  assert.equal(JSON.stringify(f.load()),JSON.stringify(f.state));
  assert.deepEqual(await f.service.read(f.context,f.state,source),{ draft,applied:false,appliedDealId:null });
  assert.deepEqual(await f.service.read({...f.context,memberId:'another'},f.state,source),{ draft:null,applied:false,appliedDealId:null });
  await assert.rejects(f.service.generate(f.context,f.state,{...source,targetDealId:'private-deal'},f.generate),{status:404});
  await assert.rejects(f.service.generate(f.context,f.state,{...source,jobId:'other'},f.generate),{status:409});
});

test('reviewed application is target-bound, preserves omitted fields, and persists one receipt and followup', async t => {
  const f = fixture(); t.after(()=>f.sqlite.close());
  const draft = await f.service.generate(f.context,f.state,source,f.generate);
  const payload = {...source,sourceDealId:source.dealId,dealId:f.target.id,version:f.target.version,draftId:draft.id,
    profile:{ goals:'核对一号店新址' }, followup:'与客户确认新店预算', confirmed:true};
  await assert.rejects(f.apply({...payload,confirmed:false}),{status:400});
  await assert.rejects(f.apply({...payload,dealId:source.dealId}),{status:409});
  await assert.rejects(f.apply({...payload,profile:{stage:'合同'}}),{status:400});
  await assert.rejects(f.apply(payload,{...f.context,memberId:'another'}),{status:404});
  const scan = await f.apply(payload);
  const changed = scan.state.deals.find(d=>d.id===f.target.id)!;
  assert.equal(changed.version,f.target.version+1);
  assert.deepEqual(changed.customerProfile,{...f.target.customerProfile, goals:'核对一号店新址'});
  assert.deepEqual(changed.notes.map(note=>[note.text,note.author,note.recording]),[['与客户确认新店预算','录入人',undefined]]);
  assert.equal(JSON.stringify(scan.state.deals[0]),JSON.stringify(f.state.deals[0]));
  await assert.rejects(f.apply(payload),{status:409});
  assert.deepEqual(await f.service.read(f.context,f.load(),source),{draft,applied:true,appliedDealId:f.target.id});
});

test('recording processing is limited to business members', () => {
  assert.doesNotThrow(() => assertMemberApi('sales','/api/recording-processing','GET'));
  assert.doesNotThrow(() => assertMemberApi('manager','/api/recording-processing','POST'));
  assert.throws(() => assertMemberApi('admin','/api/recording-processing','GET'),{status:403});
});

test('an ASR retry racing confirmation leaves the business write and its receipt untouched', async t => {
  const f=fixture(); t.after(()=>f.sqlite.close());
  const draft=await f.service.generate(f.context,f.state,source,f.generate);
  const payload={...source,sourceDealId:source.dealId,dealId:f.target.id,version:f.target.version,draftId:draft.id,
    profile:{ goals:'确认沟通目标' },followup:'约定复访',confirmed:true};
  await assert.rejects(f.apply(payload,f.context,()=> {
    f.sqlite.prepare('UPDATE workbench_recording_transcriptions SET version=2,data_json=? WHERE recording_id=?')
      .run(JSON.stringify({...f.job,id:'new-asr-job',status:'running'}),source.recordingId);
  }),{status:409});
  assert.equal(JSON.stringify(f.load()),JSON.stringify(f.state));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS receipts FROM workbench_recording_processing_receipts').get()?.receipts,0);
  assert.deepEqual(await f.service.read(f.context,f.state,source),{draft:null,applied:false,appliedDealId:null});
});

test('unknown evidence IDs are rejected and target version changes hide old drafts', async t => {
  const f=fixture(); t.after(()=>f.sqlite.close());
  await assert.rejects(f.service.generate(f.context,f.state,source,async()=>response.replaceAll('s1','s999')), {status:502});
  assert.deepEqual(await f.service.read(f.context,f.state,source),{draft:null,applied:false,appliedDealId:null});
  const draft=await f.service.generate(f.context,f.state,source,f.generate);
  const edited=structuredClone(f.state);
  edited.deals.find(deal=>deal.id===f.target.id)!.version++;
  assert.equal((await f.service.read(f.context,edited,source)).draft,null);
  await assert.rejects(f.service.prepareApply(f.context,edited,{...source,sourceDealId:source.dealId,dealId:f.target.id,
    version:f.target.version,draftId:draft.id,profile:{goals:'确认目标'},followup:'',confirmed:true}),{status:409});
});


test('unassigned recording processing stays personal and writes only to the confirmed project', async t => {
  const f=fixture(); t.after(()=>f.sqlite.close());
  await ensureRecordingInbox(f.db);
  f.sqlite.prepare('INSERT INTO workbench_recording_inbox (owner_id,member_id,id,name,size,mime_type,created_at) VALUES (?,?,?,?,?,?,?)').run('owner','member',recording.id,recording.name,recording.size,recording.mimeType,at);
  const inboxSource={...source,dealId:RECORDING_INBOX_DEAL_ID};
  f.sqlite.prepare('UPDATE workbench_recording_transcriptions SET deal_id=?, data_json=?').run(RECORDING_INBOX_DEAL_ID,JSON.stringify({...f.job,dealId:RECORDING_INBOX_DEAL_ID}));
  await assert.rejects(f.service.generate({...f.context, memberId:'other'},f.state,inboxSource,f.generate),{status:404});
  const draft=await f.service.generate(f.context,f.state,inboxSource,f.generate);
  assert.equal(draft.matchedDealId,f.target.id);
  assert.equal(JSON.stringify(f.load()),JSON.stringify(f.state));
  const applied=await f.apply({...inboxSource,dealId:f.target.id,sourceDealId:RECORDING_INBOX_DEAL_ID,version:f.target.version,
    draftId:draft.id,profile:{goals:draft.profile.goals},followup:draft.followup,confirmed:true});
  assert.equal(applied.state.deals.find(deal=>deal.id===f.target.id)?.notes[0].text,draft.followup);
  assert.equal(applied.state.deals.some(deal=>deal.id===RECORDING_INBOX_DEAL_ID),false);
});


test('a malformed reply gets one repair and unsupported optional claims do not erase a grounded summary', async t => {
  const f=fixture(); t.after(()=>f.sqlite.close());
  let attempts=0;
  const draft=await f.service.generate(f.context,f.state,source,async messages=>{
    attempts++;
    assert.match(messages[1].content,/"id":"s1"/);
    if(attempts===1)return '{"summary":"模型未提供编号"}';
    assert.equal(messages.length,3);
    const data={summary:supported('讨论新店选址'),decisions:[{text:'无证据的承诺',evidenceIds:['s999']}],
      followup:{text:'无证据的下一步',evidenceIds:['s999']},profile:{goals:supported('考虑新店位置'),budget:{text:'',evidenceIds:[]}}};
    return '`'.repeat(3)+'json\n'+JSON.stringify(data)+'\n'+'`'.repeat(3);
  });
  assert.equal(attempts,2);
  assert.equal(draft.summary,'讨论新店选址');
  assert.deepEqual(draft.decisions,[]);
  assert.equal(draft.followup,'');
  assert.deepEqual(draft.profile,{goals:'考虑新店位置'});
  assert.deepEqual(draft.evidence,[quote]);
});
