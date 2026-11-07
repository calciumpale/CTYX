import {createServer} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {constants} from 'node:fs';
import {open,readFile,readdir,stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {BridgeError,loadConfig,saveConfig,validateConfig,safeError} from './bridge-core.mjs';
import {createConnectionDiagnostics} from './connection-diagnostics.mjs';

const here=dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SITE_ORIGIN='https://ctai-marketing-workbench-20261023.bright-newt-8569.chatgpt.site';
const token=()=>randomBytes(32).toString('hex');
const same=(left,right)=>typeof left==='string'&&Buffer.byteLength(left)===Buffer.byteLength(right)&&timingSafeEqual(Buffer.from(left),Buffer.from(right));
const fail=(message,status=400)=>{const error=new BridgeError(message);error.status=status;throw error;};
const cookieValue=(header,name)=>{const values=String(header||'').split(';').map(value=>value.trim()).filter(value=>value.startsWith(`${name}=`));return values.length===1?values[0].slice(name.length+1):'';};
const defaults={
 'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY',
 'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
async function privateJson(path){
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const info=await file.stat();if(!info.isFile()||(info.mode&0o777)!==0o600||info.uid!==process.getuid()||info.size>65536)fail('本机访问配置权限不正确，请重新配置。');return JSON.parse(await file.readFile('utf8'));}finally{await file.close();}
}
async function readBody(request){
 let count=0;const chunks=[];
 for await(const chunk of request){count+=chunk.length;if(count>65536)fail('配置文件太大，请使用工作台下载的配对 JSON。',413);chunks.push(chunk);}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('无法读取配对配置，请重新选择工作台下载的 JSON 文件。');}
}
export async function readDesktopConfig(configPath,siteOrigin,serviceAccess){
 const config=await loadConfig(configPath);
 if(config.origin!==new URL(siteOrigin).origin)fail('这份配对配置不属于当前工作台，请重新导入。');
 if(serviceAccess?.origin===config.origin&&serviceAccess.sitesToken)config.sitesToken=serviceAccess.sitesToken;
 return validateConfig(config);
}
export async function startDesktopServer({controller,configPath,siteOrigin=DEFAULT_SITE_ORIGIN,serviceAccess,downloadsPath=join(homedir(),'Downloads'),port=0,diagnostics}={}){
 const trustedOrigin=new URL(siteOrigin).origin;
 if(new URL(trustedOrigin).protocol!=='https:')throw new Error('The installed workbench requires an HTTPS origin');
 const launchToken=token(),sessionToken=token(),csrf=token();let origin;
 let closing=false,configBusy=false;
 async function configuration(){try{return await readDesktopConfig(configPath,trustedOrigin,serviceAccess);}catch{return null;}}
 async function state(){const config=await configuration();const current=controller.status();return {...current,...(config&&current.phase==='idle'?{message:'工作台已配对。点击“连接抖音”，自动恢复已保存的登录状态。'}:{}),paired:!!config,serviceReady:!!(config?.sitesToken||!config&&serviceAccess?.origin===trustedOrigin&&serviceAccess.sitesToken),siteOrigin:trustedOrigin};}
 async function importConfig(value){
  const status=controller.status();if(status.busy||status.running||status.browserOpen||configBusy)fail('请先停止助手，再更换配对配置。',409);
  configBusy=true;
  try{
   const config=validateConfig(value);if(config.origin!==trustedOrigin)fail('这份配置不属于当前工作台，请从此工作台重新下载。');
   if(serviceAccess?.origin===trustedOrigin&&serviceAccess.sitesToken)config.sitesToken=serviceAccess.sitesToken;
   await saveConfig(configPath,config);
   return {...await state(),message:'工作台已配对。下一步打开抖音并扫码登录。'};
  }finally{configBusy=false;}
 }
 async function importDownload(){
  const names=(await readdir(downloadsPath)).filter(name=>/^douyin-bridge(?:[ _-]?\(\d+\)|[ _-]\d+)?\.json$/.test(name));
  const files=await Promise.all(names.map(async name=>{const path=join(downloadsPath,name);const info=await stat(path);return {path,mtime:info.mtimeMs};}));
  for(const {path} of files.sort((a,b)=>b.mtime-a.mtime)){
   let file;try{file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);const info=await file.stat();if(!info.isFile()||info.size>65536||info.uid!==process.getuid())continue;const candidate=JSON.parse(await file.readFile('utf8'));if(candidate.origin===trustedOrigin)return await importConfig(candidate);}catch(error){if(error instanceof BridgeError)throw error;}finally{await file?.close();}
  }
  fail('下载文件夹里还没有本工作台的配对配置。请先在工作台创建配对并下载，或点“选择配置文件”。');
 }
 function json(response,value,status=200,headers={}){response.writeHead(status,{...defaults,'Content-Type':'application/json; charset=utf-8',...headers});response.end(JSON.stringify(value));}
 const actions=new Map([['/api/connect',()=>controller.connect()],['/api/confirm-connect',()=>controller.confirmConnection()],['/api/login',()=>controller.startLogin()],['/api/confirm-login',()=>controller.confirmLogin()],['/api/start',()=>controller.start()],['/api/stop',()=>controller.stop()]]);
 const server=createServer(async(request,response)=>{
  try{
   if(request.headers.host!==new URL(origin).host)return json(response,{error:'不接受此访问地址。'},403);
   const path=new URL(request.url,origin).pathname;
   if(request.method==='OPTIONS')return json(response,{error:'不接受跨站请求。'},403);
   if(request.method==='GET'&&['/','/app.js','/style.css'].includes(path)){
    const name=path==='/'?'index.html':path.slice(1);const content=await readFile(join(here,'desktop-ui',name));
    response.writeHead(200,{...defaults,'Content-Type':name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8'});response.end(content);return;
   }
   if(path==='/api/session'){
    if(request.method!=='POST')return json(response,{error:'请重新打开助手。'},405);
    if(request.headers.origin!==origin)return json(response,{error:'不接受跨站请求。'},403);
    if(!request.headers['content-type']?.startsWith('application/json'))return json(response,{error:'仅接受 JSON。'},415);
    const body=await readBody(request);
    if(!same(body.token,launchToken)&&!same(cookieValue(request.headers.cookie,'desktop_session'),sessionToken))return json(response,{error:'会话已失效，请关闭窗口后重新双击助手。'},401);
    return json(response,{csrf},200,{'Set-Cookie':`desktop_session=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`});
   }
   if(!path.startsWith('/api/'))return json(response,{error:'页面不存在。'},404);
   if(!same(cookieValue(request.headers.cookie,'desktop_session'),sessionToken))return json(response,{error:'请从桌面应用打开控制面板。'},401);
   if(request.method==='GET'&&path==='/api/state')return json(response,await state());
   if(request.method==='GET'&&path==='/api/diagnostics'){
    let events=[];try{events=await diagnostics?.read()||[];}catch{/* An unavailable local log does not affect the panel. */}
    return json(response,{events});
   }
   if(request.method!=='POST')return json(response,{error:'操作方式不正确。'},405);
   if(request.headers.origin!==origin)return json(response,{error:'不接受跨站请求。'},403);
   if(!same(request.headers['x-desktop-csrf'],csrf))return json(response,{error:'操作凭证失效，请重新打开助手。'},403);
   if(!request.headers['content-type']?.startsWith('application/json'))return json(response,{error:'仅接受 JSON。'},415);
   const body=await readBody(request);
   if(closing)fail('助手正在关闭。',409);
   if(path==='/api/config')return json(response,await importConfig(body.config));
   if(path==='/api/import-download')return json(response,await importDownload());
   if(configBusy)fail('正在保存配对，请稍后。',409);
   const action=actions.get(path);if(!action)return json(response,{error:'未知操作。'},404);
   await action();return json(response,await state());
  }catch(error){json(response,{error:safeError(error)},error.status||400);}
 });
 server.requestTimeout=15000;server.headersTimeout=10000;
 await new Promise((done,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',done);});
 origin=`http://127.0.0.1:${server.address().port}`;
 return {origin,launchToken,url:`${origin}/#${launchToken}`,server,async close(){if(closing)return;closing=true;await controller.stop();server.closeIdleConnections();await new Promise(done=>server.close(done));}};
}

async function main(){
 const directory=join(homedir(),'.config','marketing-workbench');
 const configPath=join(directory,'douyin-bridge.json');
 const siteOrigin=process.env.DESKTOP_SITE_ORIGIN||DEFAULT_SITE_ORIGIN;
 let serviceAccess;try{serviceAccess=await privateJson(join(directory,'douyin-service-access.json'));}catch{/* Missing credentials are shown as a setup state, never logged. */}
 const {createDesktopController}=await import('./desktop-controller.mjs');
 const diagnostics=createConnectionDiagnostics(join(directory,'diagnostics','connection-events.json'));
 const controller=createDesktopController({configPath,dependencies:{loadConfig:path=>readDesktopConfig(path,siteOrigin,serviceAccess),onDiagnostic:event=>diagnostics.record(event)}});
 const app=await startDesktopServer({controller,configPath,siteOrigin,serviceAccess,diagnostics});
 // Native launcher consumes this line privately. Never copy it to the user log.
 process.stdout.write(`${JSON.stringify({event:'ready',url:app.url})}\n`);
 let shuttingDown=false;const stop=()=>{if(shuttingDown)return;shuttingDown=true;const timer=setTimeout(()=>process.exit(0),5000);timer.unref();app.close().finally(async()=>{await diagnostics.flush();process.exit(0);});};
 process.once('SIGTERM',stop);process.once('SIGINT',stop);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{process.stderr.write('助手无法启动，请重新打开应用。\n');process.exitCode=1;});
