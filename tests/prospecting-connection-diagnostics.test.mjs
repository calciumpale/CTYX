import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,realpath,rm,stat,symlink,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

async function fixture(t){
 const directory=await realpath(await mkdtemp(join(tmpdir(),'connection-diagnostics-')));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const {createConnectionDiagnostics}=await import('../tools/douyin-bridge/connection-diagnostics.mjs');
 return{directory,path:join(directory,'private','events.json'),createConnectionDiagnostics};
}
const event={event:'state',timestamp:'2026-11-07T01:02:03.000Z',phase:'recovering',running:true,authenticated:false,errorCode:'UNAUTHENTICATED',reasonCode:'owner_proof_missing',recoveryAttempt:1};

test('connection diagnostics persist only fixed safe fields in a private bounded local file',async t=>{
 const f=await fixture(t),diagnostics=f.createConnectionDiagnostics(f.path);
 diagnostics.record({...event,accountId:'secret-account',accountName:'private-name',url:'https://private.example.test',token:'secret-token',message:'private-message',error:new Error('raw-secret'),config:{key:'secret-key'},customer:{text:'secret-customer'}});
 await diagnostics.flush();
 const persisted=await readFile(f.path,'utf8');assert.deepEqual(JSON.parse(persisted),[event]);assert.doesNotMatch(persisted,/secret|private/);
 assert.equal((await stat(f.path)).mode&0o777,0o600);assert.equal((await stat(join(f.directory,'private'))).mode&0o777,0o700);
 assert.deepEqual(await diagnostics.read(),[event]);
});

test('unknown enum values and invalid metadata cannot smuggle text into diagnostics',async t=>{
 const f=await fixture(t),diagnostics=f.createConnectionDiagnostics(f.path);
 diagnostics.record({...event,phase:'private-account',errorCode:'token_abcdef',reasonCode:'private-message',recoveryAttempt:Infinity,running:'private',timestamp:'secret-time'});
 diagnostics.record({...event,event:'secret-event'});
 await diagnostics.flush();const rows=await diagnostics.read();assert.equal(rows.length,1);
 assert.deepEqual(rows[0],{event:'state',authenticated:false});
 assert.doesNotMatch(await readFile(f.path,'utf8'),/secret|private|token|Infinity/);
});

test('concurrent diagnostic writes and restarts retain only the most recent one hundred events',async t=>{
 const f=await fixture(t),diagnostics=f.createConnectionDiagnostics(f.path);
 for(let i=0;i<180;i++)diagnostics.record({...event,timestamp:new Date(Date.UTC(2026,10,7,0,0,i)).toISOString()});
 await diagnostics.flush();const rows=await diagnostics.read();assert.equal(rows.length,100);
 assert.equal(rows[0].timestamp,'2026-11-07T00:01:20.000Z');assert.equal(rows[99].timestamp,'2026-11-07T00:02:59.000Z');
 assert.ok((await stat(f.path)).size<=65536);
 const reloaded=f.createConnectionDiagnostics(f.path);assert.deepEqual(await reloaded.read(),rows);
 reloaded.record({...event,phase:'running',authenticated:true});await reloaded.flush();assert.equal((await reloaded.read()).length,100);assert.equal((await reloaded.read()).at(-1).phase,'running');
});

test('historical diagnostic JSON is sanitized again before any read or subsequent write',async t=>{
 const f=await fixture(t);await mkdir(join(f.directory,'private'),{mode:0o700});
 await writeFile(f.path,JSON.stringify([{...event,accountName:'private-secret'}, {...event,event:'private-event'}]),{mode:0o600});
 const diagnostics=f.createConnectionDiagnostics(f.path);assert.deepEqual(await diagnostics.read(),[event]);
 diagnostics.record({...event,phase:'running'});await diagnostics.flush();assert.doesNotMatch(await readFile(f.path,'utf8'),/private|secret/);
});

test('diagnostics never follow file or parent symlinks and failure stays best effort',async t=>{
 const f=await fixture(t),victim=join(f.directory,'victim.json');await writeFile(victim,'private-victim',{mode:0o600});
 await mkdir(join(f.directory,'private'),{mode:0o700});await symlink(victim,f.path);
 const diagnostics=f.createConnectionDiagnostics(f.path);assert.doesNotThrow(()=>diagnostics.record(event));await assert.doesNotReject(()=>diagnostics.flush());assert.deepEqual(await diagnostics.read(),[event]);
 assert.equal(await readFile(victim,'utf8'),'private-victim');
 const elsewhere=join(f.directory,'elsewhere');await mkdir(elsewhere,{mode:0o700});await symlink(elsewhere,join(f.directory,'linked'));
 const linked=f.createConnectionDiagnostics(join(f.directory,'linked','events.json'));linked.record(event);await assert.doesNotReject(()=>linked.flush());
 await assert.rejects(()=>stat(join(elsewhere,'events.json')),{code:'ENOENT'});
});
