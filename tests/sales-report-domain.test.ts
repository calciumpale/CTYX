import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeed } from '../app/lib/seed.ts';
import { salesMutationEvents, salesDay, buildSalesSnapshot, validateSalesNarrative, salesModelMessages } from '../app/lib/sales-report-domain.ts';

const now='2026-10-24T10:30:00.000Z';
function workspace(){const state=createSeed(now);state.deals=[{...state.deals[0],id:'p1',stage:'线索',dataOrigin:'manual',createdAt:now,notes:[],outcome:'open',amount:1200}];return state;}
test('Shanghai report dates use true instants and reject invalid or future report dates',()=>{
  assert.equal(salesDay('2026-10-23T16:00:00.000Z'),'2026-10-24');
  assert.equal(salesDay('2026-10-23T15:59:59.000Z'),'2026-10-23');
  assert.throws(()=>salesDay('bad'),{status:400});
  assert.throws(()=>buildSalesSnapshot(workspace(),[],{},'2026-02-30',now,now),{status:400});
  assert.throws(()=>buildSalesSnapshot(workspace(),[],{},'2026-10-25',now,now),{status:400});
});
test('real mutations yield immutable deterministic events and samples never yield sales events',()=>{
  const before=workspace();const after=structuredClone(before);after.revision++;after.deals[0].stage='合同';after.deals[0].version++;
  const events=salesMutationEvents(before,after,'deal_stage',{dealId:'p1'},now);
  assert.equal(events.length,1);assert.equal(events[0].kind,'stage');assert.deepEqual(events[0].changes.stage,{before:'线索',after:'合同'});
  assert.deepEqual(salesMutationEvents(before,after,'deal_stage',{dealId:'p1'},now),events);
  after.deals[0].stage='回款';assert.equal(events[0].changes.stage.after,'合同');
  before.deals[0].dataOrigin='sample';after.deals[0].dataOrigin='sample';assert.deepEqual(salesMutationEvents(before,after,'deal_stage',{dealId:'p1'},now),[]);
  assert.deepEqual(salesMutationEvents(before,before,'deal_stage',{dealId:'p1'},now),[]);
});
test('followup and transcript events are tied to newly saved source IDs and retain the recorded owner',()=>{
  const before=workspace();const after=structuredClone(before);after.deals[0].version++;
  after.deals[0].notes=[{id:'n1',text:'客户要求周一确认交付',author:'销售',date:now}];
  const [note]=salesMutationEvents(before,after,'deal_note',{dealId:'p1'},now);assert.equal(note.kind,'followup');assert.equal(note.sourceId,'n1');assert.equal(note.ownerId,'sales-1');
  after.transcripts=[{id:'t1',dealId:'p1',employeeId:'sales-1',employeeName:'林晓',text:'客户确认预算待审批',createdAt:now,source:'pasted'}];
  const transcript=salesMutationEvents(before,after,'transcript_add',{dealId:'p1'},now).find(item=>item.kind==='transcript')!;assert.equal(transcript.sourceId,'t1');
});
test('daily metrics use exact event counts while pipeline uses manual current snapshot and bounded evidence',()=>{
  const state=workspace();state.deals[0].stage='合同';state.deals.push({...state.deals[0],id:'sample',dataOrigin:'sample',amount:999999});
  const after=structuredClone(state);after.deals[0].version++;after.deals[0].stage='回款';const events=salesMutationEvents(state,after,'deal_stage',{dealId:'p1'},now);
  const snapshot=buildSalesSnapshot(after,events,{stage:301,followup:40},'2026-10-24',now,now);
  assert.equal(snapshot.metrics.stageChanges,301);assert.equal(snapshot.metrics.followups,40);assert.equal(snapshot.metrics.openProjects,1);assert.equal(snapshot.metrics.openAmount,1200);assert.equal(snapshot.excludedSampleProjects,1);
  assert.equal(snapshot.evidence.filter(item=>item.kind==='stage').length,1);assert.ok(snapshot.limitations.some(text=>text.includes('覆盖')));
});
test('narrative rejects foreign evidence and keeps the actual model context within 24KB',()=>{
  const state=workspace();const next=structuredClone(state);next.deals[0].version++;next.deals[0].notes=[{id:'n1',text:'交付日期待确认',date:now,author:'销售'}];
  const snapshot=buildSalesSnapshot(next,salesMutationEvents(state,next,'deal_note',{dealId:'p1'},now),{followup:1},'2026-10-24',now,now);
  assert.throws(()=>validateSalesNarrative({summary:'今日有跟进',observations:[{text:'需要核对',evidenceIds:['foreign']}]},snapshot),{status:502});
  const output=validateSalesNarrative({summary:'今日有跟进',observations:[{text:'交付日期仍待确认',evidenceIds:[snapshot.evidence[0].id]}]},snapshot);assert.equal(output.observations.length,1);
  assert.ok(new TextEncoder().encode(JSON.stringify(salesModelMessages(snapshot))).length<=24000);
});
