import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeScheduleDraft, scheduleDate, scheduleDay, scheduleRange, scheduleStatus } from '../app/lib/schedule-domain.ts';
const draft = {kind:'event',title:'客户沟通',startAt:'2026-11-07T10:00:00+08:00',endAt:'2026-11-07T11:00:00+08:00',allDay:false,dealId:null,location:'会议室',notes:''};
test('Shanghai date ranges are exclusive, bounded and reject impossible civil dates',()=>{
  assert.equal(scheduleDate('2026-11-07'),'2026-11-06T16:00:00.000Z');
  assert.equal(scheduleDay('2026-11-06T17:00:00.000Z'),'2026-11-07');
  assert.deepEqual(scheduleRange('2026-11-01','2026-12-01'),{start:'2026-10-31T16:00:00.000Z',end:'2026-11-30T16:00:00.000Z'});
  for(const date of ['2026-02-29','2026-13-01','2026-01-32','26-01-01','2026-1-01','0000-01-01'])assert.throws(()=>scheduleDate(date),{status:400});
  for(const [a,b] of [['2026-11-07','2026-11-07'],['2026-11-08','2026-11-07'],['2026-01-01','2026-03-05']])assert.throws(()=>scheduleRange(a,b),{status:400});
});
test('drafts normalize explicit instants and require a forward interval without date rollover',()=>{
  const result=normalizeScheduleDraft(draft);assert.equal(result.startAt,'2026-11-07T02:00:00.000Z');assert.equal(result.endAt,'2026-11-07T03:00:00.000Z');
  for(const bad of [
    {...draft,startAt:'2026-02-30T10:00:00+08:00'}, {...draft,startAt:'2026-11-07T10:00'},
    {...draft,endAt:draft.startAt},{...draft,startAt:'2026-11-07T24:00:00+08:00'},
    {...draft,startAt:'2026-11-07T10:00:00+14:01'}, {...draft,title:' '}, {...draft,title:'x'.repeat(121)},
    {...draft,ownerAccountId:'someone'}, {...draft,allDay:'false'}, {...draft,startAt:null,endAt:null},
  ])assert.throws(()=>normalizeScheduleDraft(bad),{status:400});
});
test('unscheduled tasks and visits have no half interval; all-day items use full Shanghai days',()=>{
  assert.equal(normalizeScheduleDraft({...draft,kind:'visit',startAt:null,endAt:null}).startAt,null);
  assert.equal(normalizeScheduleDraft({...draft,kind:'task',startAt:null,endAt:null}).kind,'task');
  assert.throws(()=>normalizeScheduleDraft({...draft,kind:'task',startAt:null}),{status:400});
  const day=normalizeScheduleDraft({...draft,allDay:true,startAt:'2026-11-07T00:00:00+08:00',endAt:'2026-11-08T00:00:00+08:00'});
  assert.equal(day.endAt,'2026-11-07T16:00:00.000Z');
  assert.throws(()=>normalizeScheduleDraft({...draft,allDay:true}),{status:400});
  assert.throws(()=>normalizeScheduleDraft({...draft,kind:'visit',allDay:true,startAt:null,endAt:null}),{status:400});
});

test('enum values reject coercible arrays and objects before persistence',()=>{
  for(const kind of [['task'],['event'],{toString:()=> 'visit'}])assert.throws(()=>normalizeScheduleDraft({...draft,kind}),{status:400});
  for(const status of [['pending'],['completed'],{toString:()=> 'cancelled'}])assert.throws(()=>scheduleStatus(status),{status:400});
});
