import {DomainError} from './domain.ts';
import type {MemberRole,MemberSession,WorkspaceMember} from './member-types.ts';

export const MEMBER_COOKIE='ctai_member_session';
const SESSION_SECONDS=8*60*60;
const WINDOW_SECONDS=15*60;
const MAX_ATTEMPTS=5;
// Cloudflare WebCrypto supports up to 100,000 PBKDF2 iterations per derivation.
const PASSWORD_ITERATIONS=100000;
const encoder=new TextEncoder();
type AccountRow={account_id:string;owner_id:string;username:string;display_name:string;role:string;sales_id:string|null;enabled:number;password_salt:string;password_hash:string;password_iterations:number};
const role=(value:string):value is MemberRole=>['sales','manager','admin'].includes(value);
const hex=(bytes:Uint8Array)=>Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
const random=(size:number)=>hex(crypto.getRandomValues(new Uint8Array(size)));
const sha256=async(value:string)=>hex(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value))));
export async function passwordHash(password:string,salt:string,iterations:number):Promise<string>{
  const key=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
  return hex(new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:encoder.encode(salt),iterations},key,256)));
}
function sameHash(left:string,right:string):boolean{let mismatch=left.length^right.length;for(let i=0;i<Math.max(left.length,right.length);i++)mismatch|=(left.charCodeAt(i)||0)^(right.charCodeAt(i)||0);return mismatch===0;}
function owner(value:string):string{if(!value||value.length>512||/[\u0000-\u001f\u007f]/.test(value))throw new DomainError('请先使用平台账号登录',401);return value;}
function publicMember(row:AccountRow):MemberSession{
  if(!role(row.role)||row.role==='sales'&&!row.sales_id)throw new DomainError('账号状态异常，请联系管理员',403);
  return {accountId:row.account_id,username:row.username,displayName:row.display_name,role:row.role,...(row.sales_id?{salesId:row.sales_id}:{})};
}
function tokenFromCookie(cookies:string|null|undefined):string|null{
  const values=(cookies??'').split(';').map(item=>item.trim()).filter(item=>item.startsWith(`${MEMBER_COOKIE}=`));
  if(values.length!==1)return null;
  const value=values[0].slice(MEMBER_COOKIE.length+1);return /^[a-f0-9]{64}$/.test(value)?value:null;
}
/** Requires both unmodified identity headers from the outer private Sites boundary. */
export function outerOwnerId(request:Request):string{
  const id=request.headers.get('oai-authenticated-user-id');const email=request.headers.get('oai-authenticated-user-email');
  if(!id||!email||email.length>512||/[\u0000-\u001f\u007f]/.test(email))throw new DomainError('请先使用平台账号登录',401);
  return owner(id);
}
export function stripMemberHeaders(original:Headers):Headers{
  const headers=new Headers(original);for(const name of [...headers.keys()])if(name.startsWith('x-ctai-member-'))headers.delete(name);return headers;
}
export function trustedMemberHeaders(original:Headers,member:MemberSession):Headers{
  const headers=stripMemberHeaders(original);
  headers.set('x-ctai-member-authenticated','1');headers.set('x-ctai-member-role',member.role);headers.set('x-ctai-member-username',member.username);headers.set('x-ctai-member-account-id',member.accountId);headers.set('x-ctai-member-display-name',encodeURIComponent(member.displayName));
  if(member.salesId)headers.set('x-ctai-member-sales-id',member.salesId);
  return headers;
}
/** Only the two existing owner-private Sites service jobs may omit a member session.
 * Human requests always retain their outer identity and must pass app authorization. */
export function memberRouteAccess(request:Request):'session'|'service'|'manager'|'operator'|'member'{
  const path=new URL(request.url).pathname.replace(/\/$/,'');
  if(path==='/api/workspace-setup'&&request.method==='POST'&&request.headers.has('x-ctai-setup-capability'))return 'service';
  if(path==='/api/workspace-session')return 'session';
  if(['/api/meeting-bridge/setup','/api/meeting-bridge/poll','/api/meeting-bridge/heartbeat','/api/meeting-bridge/complete','/api/meeting-bridge/media'].includes(path)&&request.method==='POST')return 'service';
  if(['/api/prospecting-bridge/status','/api/prospecting-bridge/poll','/api/prospecting-bridge/heartbeat','/api/prospecting-bridge/complete'].includes(path)&&request.method==='POST')return 'service';
  if(path==='/api/sales-reports/maintenance'||path==='/api/talktracks/maintenance'){
    if(!request.headers.get('oai-authenticated-user-id')&&!request.headers.get('oai-authenticated-user-email'))return 'service';
    return path==='/api/sales-reports/maintenance'?'manager':'operator';
  }
  return 'member';
}
export function memberCookie(token:string,request:Request):string{
  if(!/^[a-f0-9]{64}$/.test(token))throw new DomainError('登录状态无效',401);
  return `${MEMBER_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${new URL(request.url).protocol==='https:'?'; Secure':''}`;
}
export function clearMemberCookie(request:Request):string{return `${MEMBER_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${new URL(request.url).protocol==='https:'?'; Secure':''}`;}
export const memberResponseHeaders={'Cache-Control':'private, no-store','Vary':'Cookie, oai-authenticated-user-id','X-Content-Type-Options':'nosniff'};
export function memberFailure(error:unknown):Response{
  const message=error instanceof DomainError?error.message:'账号服务暂时不可用，请稍后重试';
  return Response.json({error:message,message},{status:error instanceof DomainError?error.status:503,headers:memberResponseHeaders});
}
export function assertMemberOrigin(request:Request):void{
  const origin=request.headers.get('origin');if((origin&&origin!==new URL(request.url).origin)||request.headers.get('sec-fetch-site')==='cross-site')throw new DomainError('只允许从当前站点操作',403);
}
export async function readMemberBody(request:Request):Promise<Record<string,unknown>>{
  if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))throw new DomainError('请使用 JSON 格式提交请求',415);
  const reader=request.body?.getReader();if(!reader)throw new DomainError('请求内容不能为空');let length=0;const chunks:Uint8Array[]=[];
  try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>4096){await reader.cancel();throw new DomainError('请求内容过大',413);}chunks.push(value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.byteLength;}
  let parsed:unknown;try{parsed=JSON.parse(new TextDecoder().decode(bytes));}catch{throw new DomainError('请求格式不正确');}if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new DomainError('请求格式不正确');return parsed as Record<string,unknown>;
}
export function createMemberAuthStore(environment:{DB?:D1Database;now?:()=>number}){
  const binding=environment.DB;if(!binding)throw new DomainError('账号数据库尚未连接',503);const db:D1Database=binding;
  const now=environment.now??Date.now;const seconds=()=>Math.floor(now()/1000);const timestamp=()=>new Date(now()).toISOString();
  const find=(ownerId:string,accountId:string)=>db.prepare('SELECT * FROM workbench_member_accounts WHERE owner_id=? AND account_id=?').bind(owner(ownerId),accountId).first<AccountRow>();
  async function assertAdmin(ownerId:string,actor:MemberSession):Promise<void>{
    if(actor.role!=='admin')throw new DomainError('仅管理员可以管理账号',403);const row=await find(ownerId,actor.accountId);
    if(!row||row.role!=='admin'||!row.enabled)throw new DomainError('仅管理员可以管理账号',403);
  }
  async function bootstrap(ownerId:string):Promise<void>{
    owner(ownerId);const count=await db.prepare('SELECT COUNT(*) AS count FROM workbench_member_accounts WHERE owner_id=?').bind(ownerId).first<{count:number}>();if(count&&Number(count.count)>0)return;
    const definitions=[...['zs','yl','ch','yy','wl'].map(username=>({username,displayName:username.toUpperCase(),role:'sales',salesId:username==='zs'?'sales-1':`sales-${username}`})),{username:'manager',displayName:'销售管理者',role:'manager',salesId:null},{username:'admin',displayName:'管理员',role:'admin',salesId:null}];
    const credentials=await Promise.all(definitions.map(async item=>{const salt=random(24);return {...item,id:`member-${crypto.randomUUID()}`,salt,hash:await passwordHash('admin',salt,PASSWORD_ITERATIONS)};}));
    // One atomic statement prevents partially seeded owners; existing credentials are never reset.
    const placeholders=credentials.map(()=>'(?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
    const values=credentials.flatMap(item=>[item.id,ownerId,item.username,item.displayName,item.role,item.salesId,1,item.salt,item.hash,PASSWORD_ITERATIONS,timestamp(),timestamp()]);
    await db.prepare(`INSERT OR IGNORE INTO workbench_member_accounts (account_id,owner_id,username,display_name,role,sales_id,enabled,password_salt,password_hash,password_iterations,created_at,updated_at) VALUES ${placeholders}`).bind(...values).run();
  }
  async function authenticate(ownerId:string,cookies:string|null|undefined):Promise<MemberSession|null>{
    owner(ownerId);const token=tokenFromCookie(cookies);if(!token)return null;
    const tokenHash=await sha256(token);const row=await db.prepare("SELECT a.* FROM workbench_member_sessions s JOIN workbench_member_accounts a ON a.account_id=s.account_id AND a.owner_id=s.owner_id WHERE s.token_hash=? AND s.owner_id=? AND s.expires_at>? AND a.enabled=1 AND (a.role<>'sales' OR (a.sales_id IS NOT NULL AND (SELECT COUNT(*) FROM workbench_member_accounts b WHERE b.owner_id=a.owner_id AND b.sales_id=a.sales_id AND b.role='sales' AND b.enabled=1)=1))").bind(tokenHash,ownerId,seconds()).first<AccountRow>();
    return row&&role(row.role)?publicMember(row):null;
  }
  async function logout(ownerId:string,cookies:string|null|undefined):Promise<void>{owner(ownerId);const token=tokenFromCookie(cookies);if(token)await db.prepare('DELETE FROM workbench_member_sessions WHERE owner_id=? AND token_hash=?').bind(ownerId,await sha256(token)).run();}
  async function login(ownerId:string,username:unknown,password:unknown,oldCookies?:string|null):Promise<{member:MemberSession;token:string}>{
    owner(ownerId);const limit=await db.prepare('INSERT INTO workbench_member_login_limits (owner_id,attempts,window_start) VALUES (?,1,?) ON CONFLICT(owner_id) DO UPDATE SET attempts=CASE WHEN window_start<=? THEN 1 ELSE attempts+1 END,window_start=CASE WHEN window_start<=? THEN excluded.window_start ELSE window_start END RETURNING attempts').bind(ownerId,seconds(),seconds()-WINDOW_SECONDS,seconds()-WINDOW_SECONDS).first<{attempts:number}>();
    if(!limit||Number(limit.attempts)>MAX_ATTEMPTS)throw new DomainError('尝试次数过多，请15分钟后再试',429);
    await bootstrap(ownerId);const validInput=typeof username==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(username)&&typeof password==='string'&&password.length>0&&password.length<=256;
    const row=validInput?await db.prepare('SELECT * FROM workbench_member_accounts WHERE owner_id=? AND username=?').bind(ownerId,(username as string).toLowerCase()).first<AccountRow>():null;
    const candidate=await passwordHash(validInput?password as string:'invalid-password',row?.password_salt??'unknown-account-dummy-salt',PASSWORD_ITERATIONS);
    if(!row||!row.enabled||!role(row.role)||!sameHash(candidate,row.password_hash))throw new DomainError('账号或密码不正确',401);
    await db.prepare('DELETE FROM workbench_member_login_limits WHERE owner_id=?').bind(ownerId).run();
    await logout(ownerId,oldCookies);await db.prepare('DELETE FROM workbench_member_sessions WHERE owner_id=? AND expires_at<=?').bind(ownerId,seconds()).run();
    const token=random(32);await db.prepare('INSERT INTO workbench_member_sessions (token_hash,owner_id,account_id,expires_at,created_at) VALUES (?,?,?,?,?)').bind(await sha256(token),ownerId,row.account_id,seconds()+SESSION_SECONDS,timestamp()).run();
    return {member:publicMember(row),token};
  }
  async function list(ownerId:string,actor:MemberSession):Promise<WorkspaceMember[]>{
    await assertAdmin(ownerId,actor);const result=await db.prepare('SELECT * FROM workbench_member_accounts WHERE owner_id=? ORDER BY CASE role WHEN \'sales\' THEN 0 WHEN \'manager\' THEN 1 ELSE 2 END').bind(ownerId).all<AccountRow>();return result.results.map(row=>({...publicMember(row),enabled:!!row.enabled}));
  }
  async function update(ownerId:string,actor:MemberSession,input:Record<string,unknown>):Promise<WorkspaceMember[]>{
    await assertAdmin(ownerId,actor);
    if(Object.keys(input).some(key=>!['accountId','displayName','enabled'].includes(key))||typeof input.accountId!=='string'||input.accountId.length>128||(!('displayName' in input)&&!('enabled' in input)))throw new DomainError('账号修改参数不正确');
    const row=await find(ownerId,input.accountId);if(!row)throw new DomainError('账号不存在',404);
    let displayName=row.display_name;if('displayName' in input){if(typeof input.displayName!=='string'||!input.displayName.trim()||input.displayName.trim().length>40||/[\u0000-\u001f\u007f]/.test(input.displayName))throw new DomainError('显示名称请填写1至40个字符');displayName=input.displayName.trim();}
    if('enabled' in input&&typeof input.enabled!=='boolean')throw new DomainError('启用状态不正确');const enabled='enabled' in input?input.enabled as boolean:!!row.enabled;
    if(!enabled&&row.account_id===actor.accountId)throw new DomainError('不能停用当前登录账号',409);
    const result=await db.prepare("UPDATE workbench_member_accounts SET display_name=?,enabled=?,updated_at=? WHERE owner_id=? AND account_id=? AND (role<>'admin' OR ?=1 OR (SELECT COUNT(*) FROM workbench_member_accounts WHERE owner_id=? AND role='admin' AND enabled=1)>1)").bind(displayName,enabled?1:0,timestamp(),ownerId,row.account_id,enabled?1:0,ownerId).run();
    if(!result.meta.changes)throw new DomainError('必须保留至少一位启用的管理员',409);
    if(!enabled)await db.prepare('DELETE FROM workbench_member_sessions WHERE owner_id=? AND account_id=?').bind(ownerId,row.account_id).run();return list(ownerId,actor);
  }
  return {bootstrap,authenticate,login,logout,list,update};
}
