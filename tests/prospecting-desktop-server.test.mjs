import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat,writeFile,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {startDesktopServer} from '../tools/douyin-bridge/desktop-server.mjs';
import * as desktop from '../tools/douyin-bridge/desktop-server.mjs';

const siteOrigin='https://workbench.example.test';
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'抖音 助手 HTTP '));
 const calls=[];
 const controller={status:()=>({phase:'idle',running:false,authenticated:false,message:'尚未启动',pendingResults:0}),connect:async()=>{calls.push('connect');return controller.status();},confirmConnection:async()=>{calls.push('confirm-connect');return controller.status();},startLogin:async()=>{calls.push('login');return controller.status();},confirmLogin:async()=>{calls.push('confirm');return controller.status();},start:async()=>{calls.push('start');return controller.status();},stop:async()=>{calls.push('stop');return controller.status();}};
 const configPath=join(directory,'config.json');
 const app=await startDesktopServer({controller,configPath,siteOrigin,serviceAccess:{origin:siteOrigin,sitesToken:'private-gateway-test-token'},downloadsPath:directory});
 t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
 async function login(){const response=await fetch(`${app.origin}/api/session`,{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify({token:app.launchToken})});assert.equal(response.status,200);return {Cookie:response.headers.get('set-cookie').split(';')[0],'X-Desktop-CSRF':(await response.json()).csrf,Origin:app.origin,'Content-Type':'application/json'};}
 return{app,calls,configPath,login,directory};
}
test('desktop changes reject missing session, wrong Origin, wrong Host and form posts',async t=>{
 const f=await fixture(t);
 assert.equal((await fetch(`${f.app.origin}/api/state`)).status,401);
 const headers=await f.login();
 for(const overrides of [{Origin:'https://attacker.example'},{Origin:'null'},{'Content-Type':'text/plain'},{'X-Desktop-CSRF':'wrong'}]){
  const response=await fetch(`${f.app.origin}/api/start`,{method:'POST',headers:{...headers,...overrides},body:'{}'});assert.ok([401,403,415].includes(response.status),JSON.stringify({overrides,status:response.status}));
 }
 // Fetch normalizes Host; use HTTP directly to exercise DNS-rebinding defense.
 const forgedHost=await new Promise((resolve,reject)=>{const request=httpRequest(`${f.app.origin}/api/start`,{method:'POST',headers:{...headers,Host:'attacker.example'}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});request.on('error',reject);request.end('{}');});
 assert.equal(forgedHost,403);
 const absentOrigin={...headers};delete absentOrigin.Origin;
 assert.equal((await fetch(`${f.app.origin}/api/start`,{method:'POST',headers:absentOrigin,body:'{}'})).status,403);
 assert.equal((await fetch(`${f.app.origin}/api/start`,{headers})).status,405);
 assert.deepEqual(f.calls,[]);
});
test('pairing stays local, rejects another site, and never exposes tokens in state',async t=>{
 const f=await fixture(t),headers=await f.login();
 const config={origin:siteOrigin,deviceId:'device-test',deviceToken:'synthetic-device-token'};
 let response=await fetch(`${f.app.origin}/api/config`,{method:'POST',headers,body:JSON.stringify({config:{...config,origin:'https://attacker.example'}})});assert.equal(response.status,400);
 response=await fetch(`${f.app.origin}/api/config`,{method:'POST',headers,body:JSON.stringify({config})});assert.equal(response.status,200);
 const saved=JSON.parse(await readFile(f.configPath,'utf8'));assert.equal(saved.sitesToken,'private-gateway-test-token');assert.equal((await stat(f.configPath)).mode&0o777,0o600);
 const state=await (await fetch(`${f.app.origin}/api/state`,{headers})).text();assert.ok(JSON.parse(state).paired);assert.ok(!state.includes(config.deviceToken));assert.ok(!state.includes(saved.sitesToken));
 assert.deepEqual(f.calls,[],'import must not start login, polling or sending');
});
test('login confirmation and execution are separate explicit actions',async t=>{
 const f=await fixture(t),headers=await f.login();
 for(const path of ['login','confirm-login','start','stop'])assert.equal((await fetch(`${f.app.origin}/api/${path}`,{method:'POST',headers,body:'{}'})).status,200);
 assert.deepEqual(f.calls,['login','confirm','start','stop']);
 const html=await fetch(`${f.app.origin}/`);assert.match(html.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.equal(html.headers.get('referrer-policy'),'no-referrer');assert.equal(html.headers.get('cache-control'),'no-store');
});
test('one-click connection routes do not imply confirmation and retain the local session guard',async t=>{
 const f=await fixture(t),headers=await f.login();
 for(const path of ['connect','confirm-connect']){
  assert.equal((await fetch(`${f.app.origin}/api/${path}`,{method:'POST',headers:{...headers,Origin:'https://attacker.example'},body:'{}'})).status,403);
 }
 assert.deepEqual(f.calls,[]);
 assert.equal((await fetch(`${f.app.origin}/api/connect`,{method:'POST',headers,body:'{}'})).status,200);assert.deepEqual(f.calls,['connect']);
 assert.equal((await fetch(`${f.app.origin}/api/confirm-connect`,{method:'POST',headers,body:'{}'})).status,200);assert.deepEqual(f.calls,['connect','confirm-connect']);
});
test('automatic import selects the newest Chrome duplicate download and keeps the paired guidance',async t=>{
 const f=await fixture(t),headers=await f.login();
 const config={origin:siteOrigin,deviceId:'device-old',deviceToken:'old-device-token'};
 await writeFile(join(f.directory,'douyin-bridge.json'),JSON.stringify(config));
 await utimes(join(f.directory,'douyin-bridge.json'),1,1);
 await writeFile(join(f.directory,'douyin-bridge (1).json'),JSON.stringify({...config,deviceId:'device-new',deviceToken:'new-device-token'}));
 const response=await fetch(`${f.app.origin}/api/import-download`,{method:'POST',headers,body:'{}'});assert.equal(response.status,200);
 const saved=JSON.parse(await readFile(f.configPath,'utf8'));assert.equal(saved.deviceId,'device-new');
 const state=await(await fetch(`${f.app.origin}/api/state`,{headers})).json();assert.ok(state.paired);assert.match(state.message,/已配对|已保存/);assert.doesNotMatch(state.message,/先导入/);
});
test('an existing pairing uses the latest private service access without requiring reimport',async t=>{
 const f=await fixture(t),config={origin:siteOrigin,deviceId:'existing-device',deviceToken:'existing-device-token'};
 await writeFile(f.configPath,JSON.stringify(config),{mode:0o600});
 const effective=await desktop.readDesktopConfig(f.configPath,siteOrigin,{origin:siteOrigin,sitesToken:'latest-service-token'});
 assert.equal(effective.sitesToken,'latest-service-token');assert.equal(effective.deviceToken,config.deviceToken);
 await assert.rejects(()=>desktop.readDesktopConfig(f.configPath,'https://another.example.test',{origin:siteOrigin,sitesToken:'latest-service-token'}),/不属于/);
});
