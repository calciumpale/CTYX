import test from 'node:test';
import assert from 'node:assert/strict';
import {nextDiscoveryAt,latestDiscoveryAt} from '../app/lib/prospecting-discovery.ts';
test('Beijing 09:00 future activation and latest offline occurrence',()=>{
 assert.equal(nextDiscoveryAt('09:00',Date.parse('2026-11-08T01:00:00Z')),'2026-11-09T01:00:00.000Z');
 assert.equal(latestDiscoveryAt('09:00',Date.parse('2026-11-08T00:59:00Z')),'2026-11-07T01:00:00.000Z');
});
import {mergeDiscoveryCandidates,normalizeDiscoverySchedule} from '../app/lib/prospecting-discovery.ts';
test('new accounts selected while manually deselected accounts remain deselected',()=>{
 const c=(id:string)=>({id,nickname:id,profileUrl:'',description:'',reason:'',videos:[]});
 const result=mergeDiscoveryCandidates([c('old')],[c('old'),c('new')],[],'2026-11-08','run');
 assert.deepEqual(result.selectedCandidateIds,['new']);assert.equal(result.newAccounts,1);
 assert.equal(result.candidates[1].firstRunId,'run');
});
test('schedule rejects invalid times and activates strictly in future',()=>{
 assert.throws(()=>normalizeDiscoverySchedule({enabled:true,time:'25:00'},0));
 assert.equal(normalizeDiscoverySchedule({enabled:true,time:'09:00'},Date.parse('2026-11-08T01:00:00Z')).nextRunAt,'2026-11-09T01:00:00.000Z');
});
import {discoveryVideoSlices} from '../app/lib/prospecting-discovery.ts';
test('collection budget is sixty videos in two-video slices with unseen priority and old rotation',()=>{
 const candidates=Array.from({length:40},(_,i)=>({id:`a${i}`,nickname:'',profileUrl:'',description:'',reason:'',videos:Array.from({length:5},(_,j)=>({id:`${i}-${j}`,title:'',url:''}))}));
 const slices=discoveryVideoSlices(candidates,candidates.map(c=>c.id),0,['0-0','0-1','0-2','0-3']);
 assert.ok(slices.length<=30);assert.ok(slices.every(s=>s.length<=2));assert.ok(slices.flat().some(v=>v.id==='0-4'));
 const ids=candidates.flatMap(c=>c.videos.map(v=>v.id));assert.notDeepEqual(discoveryVideoSlices(candidates,candidates.map(c=>c.id),2,ids)[0],discoveryVideoSlices(candidates,candidates.map(c=>c.id),3,ids)[0]);
});

test('thirty old selected accounts cannot starve a new selected account; old accounts rotate',()=>{
 const candidates=Array.from({length:31},(_,i)=>({id:`a${i}`,nickname:'',profileUrl:'',description:'',reason:'',firstRunId:i===30?'current':'old',videos:[{id:`v${i}`,title:'',url:''}]}));
 const selected=candidates.map(c=>c.id);
 const a=discoveryVideoSlices(candidates,selected,0,[],'current').flat();
 const b=discoveryVideoSlices(candidates,selected,1,[],'current').flat();
 assert.equal(a.length,30);assert.ok(a.some(v=>v.id==='v30'));assert.equal(b.length,30);assert.ok(new Set([...a,...b].map(v=>v.id)).size===31);
});
