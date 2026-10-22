import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceTurnQueue } from '../app/lib/voice-turn-queue.ts';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));

test('finals received during a pending save queue in order, deduplicate and retry without editing',async()=>{
  const saved:string[]=[];let release!:()=>void;let fail=true;
  const queue=createVoiceTurnQueue(async turn=>{if(turn.id==='1')await new Promise<void>(r=>{release=r;});if(turn.id==='2'&&fail)throw new Error('网络断开');saved.push(turn.text);});
  queue.enqueue({id:'1',sessionId:'s',text:'第一句'});queue.enqueue({id:'2',sessionId:'s',text:'第二句'});queue.enqueue({id:'2',sessionId:'s',text:'第二句'});
  await tick();assert.equal(queue.getSnapshot().pending,2);release();await tick();
  assert.deepEqual(saved,['第一句']);assert.equal(queue.getSnapshot().failed?.text,'第二句');
  fail=false;queue.retry();await tick();assert.deepEqual(saved,['第一句','第二句']);assert.equal(queue.getSnapshot().pending,0);
});
test('reset prevents queued turns from a previous session from being sent',async()=>{
  const sent:string[]=[];let release!:()=>void;
  const queue=createVoiceTurnQueue(async turn=>{sent.push(turn.id);if(turn.id==='1')await new Promise<void>(r=>{release=r;});});
  queue.enqueue({id:'1',sessionId:'old',text:'旧会话'});queue.enqueue({id:'2',sessionId:'old',text:'不应发送'});await tick();queue.reset();release();await tick();
  assert.deepEqual(sent,['1']);assert.equal(queue.getSnapshot().pending,0);
});
