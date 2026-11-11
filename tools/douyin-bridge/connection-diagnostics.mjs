import {constants} from 'node:fs';
import {lstat,mkdir,open,rename,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname,join,parse,resolve} from 'node:path';

const MAX_EVENTS=100,MAX_BYTES=65536;
const events=new Set(['state','lifecycle','recovery','liveness','poll','bridge_error']);
const phases=new Set(['idle','opening_browser','checking_login','connecting','starting','logging_in','ready','running','confirmation_required','account_mismatch','login_required','stopping','stopped','error','verifying','recovering','verification_required']);
const errors=new Set(['INVALID_CONFIG','PRIVATE_FILE','ENOENT','JOURNAL_LOCKED','JOURNAL_FORMAT','PAIRING_CHANGED','BROWSER_MISSING','BACKGROUND_CDP_UNSUPPORTED','WINDOW_CONTROL','HUMAN_ACTION_REQUIRED','ACCOUNT_CHANGED','UNAUTHENTICATED','NETWORK','API_REJECTED','API_FORMAT','LEASE_LOST','RESOURCE_RELEASE','DESKTOP_ERROR','ABORTED']);
const reasons=new Set(['owner_proof_missing','identity_route_changed','task_header_missing','account_ambiguous','account_read_interrupted','navigation_failed','heartbeat_unavailable','network_retry','recovery_requested','recovery_exhausted','owner_route_changed','owner_controls_timeout','owner_controls_replaced','owner_handle_missing','owner_duplicate_same_handle','owner_handle_conflict','owner_read_interrupted']);

// Values have closed vocabularies. A regex alone would allow an account name or
// token disguised as a diagnostic code. Free text is never accepted here.
function sanitize(value){
 try{
  if(!value||typeof value!=='object'||Array.isArray(value)||!events.has(value.event))return null;
  const out={event:value.event};
  if(typeof value.timestamp==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.timestamp)&&Number.isFinite(Date.parse(value.timestamp))&&new Date(value.timestamp).toISOString()===value.timestamp)out.timestamp=value.timestamp;
  if(phases.has(value.phase))out.phase=value.phase;
  for(const key of ['running','authenticated'])if(typeof value[key]==='boolean')out[key]=value[key];
  if(errors.has(value.errorCode))out.errorCode=value.errorCode;
  if(reasons.has(value.reasonCode))out.reasonCode=value.reasonCode;
  if(Number.isInteger(value.recoveryAttempt)&&value.recoveryAttempt>=0&&value.recoveryAttempt<=100)out.recoveryAttempt=value.recoveryAttempt;
  return out;
 }catch{return null;}
}
function bound(rows){
 const kept=rows.slice(-MAX_EVENTS);
 while(kept.length&&Buffer.byteLength(JSON.stringify(kept),'utf8')>MAX_BYTES)kept.shift();
 return kept;
}
const privateFailure=()=>{throw new Error('PRIVATE_FILE');};
const owned=info=>!process.getuid||info.uid===process.getuid();
function checkFile(info){if(!info.isFile()||!owned(info)||(info.mode&0o777)!==0o600||info.nlink!==1||info.size>MAX_BYTES)privateFailure();}

// Check every path component before using it. In particular, neither a chosen
// file symlink nor a symlinked diagnostics directory can redirect this log.
async function privateParent(path){
 const parent=dirname(path),root=parse(parent).root;
 let current=root;
 for(const component of parent.slice(root.length).split('/').filter(Boolean)){
  current=join(current,component);let info;
  try{info=await lstat(current);}catch(error){
   if(error.code!=='ENOENT')throw error;
   try{await mkdir(current,{mode:0o700});}catch(createError){if(createError.code!=='EEXIST')throw createError;}
   info=await lstat(current);
  }
  if(info.isSymbolicLink()||!info.isDirectory())privateFailure();
  if(current===parent&&(!owned(info)||(info.mode&0o777)!==0o700))privateFailure();
 }
 if(parent===root)privateFailure();
 const directory=await open(parent,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
 try{const info=await directory.stat();if(!info.isDirectory()||!owned(info)||(info.mode&0o777)!==0o700)privateFailure();}catch(error){await directory.close();throw error;}
 return directory;
}
async function readPrivate(path){
 const directory=await privateParent(path);let file;
 try{
  file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);checkFile(await file.stat());
  const bytes=Buffer.alloc(MAX_BYTES+1);let length=0;
  while(length<bytes.length){const result=await file.read(bytes,length,bytes.length-length,null);if(!result.bytesRead)break;length+=result.bytesRead;}
  if(length>MAX_BYTES)privateFailure();
  const parsed=JSON.parse(bytes.subarray(0,length).toString('utf8'));
  return Array.isArray(parsed)?bound(parsed.map(sanitize).filter(Boolean)):[];
 }finally{await file?.close();await directory.close();}
}
async function checkTarget(path){
 let file;
 try{file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);checkFile(await file.stat());}catch(error){if(error.code!=='ENOENT')throw error;}finally{await file?.close();}
}
async function writePrivate(path,rows){
 const directory=await privateParent(path),temporary=`${path}.${randomUUID()}.tmp`;let file;
 try{
  await checkTarget(path);
  file=await open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  await file.chmod(0o600);await file.writeFile(JSON.stringify(rows));await file.sync();await file.close();file=undefined;
  await checkTarget(path);await rename(temporary,path);await directory.sync();
 }finally{await file?.close().catch(()=>{});await unlink(temporary).catch(()=>{});await directory.close();}
}

/** Local best-effort diagnostics. Construction has no filesystem side effects.
 * Pending events, stored events and bytes are bounded; one writer drains them.
 * Diagnostics failures never propagate into connection or browser operations.
 */
export function createConnectionDiagnostics(path){
 const target=resolve(path);let rows=[],pending=[],initialized=false,work;
 async function initialize(){
  if(initialized)return;
  try{rows=await readPrivate(target);}catch{rows=[];}
  initialized=true;
 }
 async function drain(){
  await initialize();
  while(pending.length){
   rows=bound([...rows,...pending]);pending=[];
   try{await writePrivate(target,rows);}catch{/* Local diagnostics cannot block the assistant. */}
  }
 }
 function schedule(){
  if(work)return;
  work=drain().catch(()=>{}).finally(()=>{work=undefined;if(pending.length)schedule();});
 }
 function record(value){const safe=sanitize(value);if(!safe)return;pending=bound([...pending,safe]);schedule();}
 async function flush(){do{schedule();await work;}while(work||pending.length);}
 async function read(){await flush();return rows.map(row=>({...row}));}
 return{record,flush,read};
}
