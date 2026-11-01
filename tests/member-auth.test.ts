import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createMemberAuthStore,memberCookie,clearMemberCookie,outerOwnerId,stripMemberHeaders,trustedMemberHeaders,memberRouteAccess,assertMemberOrigin,readMemberBody} from '../app/lib/member-auth.ts';

function fixture(){
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE workbench_member_accounts (account_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,username TEXT NOT NULL,display_name TEXT NOT NULL,role TEXT NOT NULL,sales_id TEXT,enabled INTEGER NOT NULL,password_salt TEXT NOT NULL,password_hash TEXT NOT NULL,password_iterations INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(owner_id,username)); CREATE TABLE workbench_member_sessions (token_hash TEXT PRIMARY KEY,owner_id TEXT NOT NULL,account_id TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at TEXT NOT NULL); CREATE TABLE workbench_member_login_limits (owner_id TEXT PRIMARY KEY,attempts INTEGER NOT NULL,window_start INTEGER NOT NULL);`);
  let time=Date.parse('2026-11-01T00:00:00Z');
  const db={prepare(sql:string){let args:unknown[]=[];return {bind(...values:unknown[]){args=values;return this;},async first(){return sqlite.prepare(sql).get(...args as (string|number|null)[])??null;},async all(){return {results:sqlite.prepare(sql).all(...args as (string|number|null)[])};},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args as (string|number|null)[]).changes)}};}};}} as unknown as D1Database;
  return {sqlite,store:createMemberAuthStore({DB:db,now:()=>time}),advance(ms:number){time+=ms;}};
}
const cookie=(token:string)=>`ctai_member_session=${token}`;
test('bootstrap creates isolated salted password hashes once and never resets existing credentials',async()=>{
  const {store,sqlite}=fixture();await store.bootstrap('owner-one');await store.bootstrap('owner-two');
  const rows=sqlite.prepare('SELECT * FROM workbench_member_accounts').all();assert.equal(rows.length,6);
  assert.equal(new Set(rows.map(row=>row.password_salt)).size,6);assert.equal(new Set(rows.map(row=>row.password_hash)).size,6);
  assert.ok(rows.every(row=>row.password_hash!=='admin'&&Number(row.password_iterations)>=100000));
  sqlite.prepare("UPDATE workbench_member_accounts SET password_hash='changed' WHERE owner_id='owner-one' AND username='sales'").run();await store.bootstrap('owner-one');
  assert.equal(sqlite.prepare("SELECT password_hash FROM workbench_member_accounts WHERE owner_id='owner-one' AND username='sales'").get()?.password_hash,'changed');
});
test('each account logs in with its role and public responses contain no hash, salt or token',async()=>{
  const {store,sqlite}=fixture();for(const role of ['sales','manager','admin']){const login=await store.login('owner',role,'admin');assert.equal(login.member.role,role);assert.equal(login.member.username,role);assert.equal(login.token.length,64);const session=await store.authenticate('owner',cookie(login.token));assert.deepEqual(session,login.member);assert.equal((await store.authenticate('another-owner',cookie(login.token))),null);assert.ok(!JSON.stringify(session).includes('password'));assert.ok(!JSON.stringify(session).includes(login.token));assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workbench_member_sessions WHERE token_hash=?').get(login.token)?.n,0);}
});
test('expired, malformed and revoked sessions cannot authenticate',async()=>{
  const {store,advance}=fixture();const first=await store.login('owner','sales','admin');assert.equal(await store.authenticate('owner','ctai_member_session=invalid'),null);await store.logout('owner',cookie(first.token));assert.equal(await store.authenticate('owner',cookie(first.token)),null);const next=await store.login('owner','manager','admin');advance(8*60*60*1000);assert.equal(await store.authenticate('owner',cookie(next.token)),null);
});
test('failed credentials share a generic error and owner-scoped rate limits cannot be evaded with invented usernames',async()=>{
  const {store,advance}=fixture();for(let i=0;i<5;i++)await assert.rejects(store.login('owner',i%2?'sales':'unknown','wrong'),{status:401,message:'账号或密码不正确'});await assert.rejects(store.login('owner','admin','admin'),{status:429});assert.equal((await store.login('other-owner','admin','admin')).member.role,'admin');advance(15*60*1000);assert.equal((await store.login('owner','admin','admin')).member.role,'admin');
});
test('only administrators can manage bounded account display names and activation; sessions revoke on disable',async()=>{
  const {store}=fixture();const admin=await store.login('owner','admin','admin');const sales=await store.login('owner','sales','admin');const manager=await store.login('owner','manager','admin');const members=await store.list('owner',admin.member);assert.equal(members.length,3);assert.ok(!JSON.stringify(members).includes('password'));await assert.rejects(store.list('owner',sales.member),{status:403});await assert.rejects(store.list('other-owner',admin.member),{status:403});await assert.rejects(store.update('owner',admin.member,{accountId:admin.member.accountId,enabled:false}),{status:409});await assert.rejects(store.update('owner',admin.member,{accountId:sales.member.accountId,role:'admin'}),{status:400});await store.update('owner',admin.member,{accountId:sales.member.accountId,displayName:'销售张三',enabled:false});assert.equal(await store.authenticate('owner',cookie(sales.token)),null);await assert.rejects(store.login('owner','sales','admin'),{status:401});assert.ok(await store.authenticate('owner',cookie(manager.token)));await store.update('owner',admin.member,{accountId:sales.member.accountId,enabled:true});assert.equal((await store.login('owner','sales','admin')).member.displayName,'销售张三');
});
test('session cookies are opaque, HttpOnly and Secure on HTTPS with matching expiration',()=>{
  const value=memberCookie('a'.repeat(64),new Request('https://example.com'));assert.match(value,/HttpOnly/);assert.match(value,/SameSite=Lax/);assert.match(value,/Secure/);assert.match(value,/Max-Age=28800/);assert.ok(!memberCookie('a'.repeat(64),new Request('http://127.0.0.1')).includes('Secure'));assert.match(clearMemberCookie(new Request('https://example.com')),/Max-Age=0/);
});
test('outer Sites identity is required and all client member metadata is removed before trusted injection',()=>{
  assert.throws(()=>outerOwnerId(new Request('https://example.com',{headers:{'oai-authenticated-user-id':'owner'}})),{status:401});const original=new Headers({'oai-authenticated-user-id':'owner','oai-authenticated-user-email':'owner@example.com','x-ctai-member-authenticated':'1','x-ctai-member-role':'admin','x-ctai-member-future':'forged'});const headers=stripMemberHeaders(original);assert.equal(headers.get('x-ctai-member-role'),null);assert.equal(headers.get('x-ctai-member-future'),null);assert.equal(headers.get('oai-authenticated-user-id'),'owner');assert.equal(original.get('x-ctai-member-role'),'admin');const trusted=trustedMemberHeaders(headers,{accountId:'member-one',username:'sales',displayName:'林晓',role:'sales',salesId:'sales-1'});assert.equal(trusted.get('x-ctai-member-authenticated'),'1');assert.equal(trusted.get('x-ctai-member-role'),'sales');assert.equal(decodeURIComponent(trusted.get('x-ctai-member-display-name')!), '林晓');
});

test('maintenance exceptions preserve private service jobs while human owners require the manager session',()=>{
  const request=(path:string,headers:Record<string,string>={})=>new Request('https://app.example'+path,{headers});
  assert.equal(memberRouteAccess(request('/api/workspace-session')),'session');
  for(const path of ['/api/sales-reports/maintenance','/api/talktracks/maintenance']){
    assert.equal(memberRouteAccess(request(path)),'service');
    assert.equal(memberRouteAccess(request(path,{'oai-authenticated-user-id':'owner','oai-authenticated-user-email':'owner@example.com'})),path.includes('sales-reports')?'manager':'operator');
    assert.equal(memberRouteAccess(request(path,{'oai-authenticated-user-email':'owner@example.com'})),path.includes('sales-reports')?'manager':'operator');
  }
  for(const path of ['/api/sales-reports/maintenance/extra','/api/talktracks/maintenance-anything','/api/workspace-session/extra','/api/%77orkspace-session'])assert.equal(memberRouteAccess(request(path)),'member');
});
test('login body limits and same-origin guards reject browser cross-site requests',async()=>{
  const req=(headers:Record<string,string>,body='{}')=>new Request('https://app.example/api/workspace-session',{method:'POST',headers,body});
  assert.throws(()=>assertMemberOrigin(req({origin:'https://attacker.example'})),{status:403});
  assert.throws(()=>assertMemberOrigin(req({'sec-fetch-site':'cross-site'})),{status:403});
  assert.doesNotThrow(()=>assertMemberOrigin(req({origin:'https://app.example'})));
  await assert.rejects(readMemberBody(req({'content-type':'text/plain'})),{status:415});
  await assert.rejects(readMemberBody(req({'content-type':'application/json'},'x'.repeat(4097))),{status:413});
  await assert.rejects(readMemberBody(req({'content-type':'application/json'},'[]')),{status:400});
});
test('login rotates the current cookie and logout cannot revoke another owners session',async()=>{
  const {store}=fixture();const original=await store.login('owner','sales','admin');
  const next=await store.login('owner','admin','admin',cookie(original.token));assert.equal(await store.authenticate('owner',cookie(original.token)),null);
  await store.logout('different-owner',cookie(next.token));assert.ok(await store.authenticate('owner',cookie(next.token)));
  assert.equal(await store.authenticate('owner',cookie(next.token)+'; '+cookie(original.token)),null);
});
