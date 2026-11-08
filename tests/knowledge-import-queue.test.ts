import test from 'node:test';
import assert from 'node:assert/strict';
import { drainImportQueue, type ImportQueueItem } from '../app/components/knowledge-import-queue.ts';
function rows() { return Array.from({length:5}, (_, i) => ({id:String(i),state:'queued'} as ImportQueueItem)); }
test('two workers isolate errors and retry preserves accepted document and identity', async () => {
 const items=rows(); let active=0,max=0;
 await drainImportQueue(items,()=>false,async item=>{ active++;max=Math.max(max,active);await new Promise(resolve=>setTimeout(resolve,2));active--;if(item.id==='1'){item.document={id:'accepted'} as ImportQueueItem['document'];throw Error('index failed');}},()=>{});
 assert.equal(max,2);assert.equal(items.filter(item=>item.state==='done').length,4);assert.equal(items[1].state,'error');
 const failed=items[1]; failed.state='queued'; await drainImportQueue(items,()=>false,async item=>{assert.equal(item.id,'1');assert.equal(item.document?.id,'accepted');},()=>{});assert.equal(failed.state,'done');
});
test('stop waits for accepted work and leaves unstarted rows available to continue',async()=>{const items=rows();let stop=false;await drainImportQueue(items,()=>stop,async()=>{stop=true;await Promise.resolve();},()=>{});assert.equal(items.filter(item=>item.state==='done').length,1);assert.equal(items.filter(item=>item.state==='queued').length,4);await drainImportQueue(items,()=>false,async()=>{},()=>{});assert.ok(items.every(item=>item.state==='done'));});
