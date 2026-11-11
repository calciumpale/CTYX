const element=id=>document.getElementById(id);
let csrf='',busy=false,lastState,activeActions=0,stoppingAction=false;
const phaseLabels={idle:'待连接',opening_browser:'正在打开',checking_login:'正在确认',connecting:'正在连接',logging_in:'等待登录确认',confirmation_required:'确认账号',account_mismatch:'账号不一致',login_required:'请重新连接',ready:'可以连接',starting:'正在连接',running:'正在运行',verifying:'正在核验',recovering:'正在恢复',verification_required:'需要核验',stopped:'已停止',error:'需要处理',stopping:'正在停止'};
const heartbeatLabels={idle:'尚未连接',online:'连接正常',retrying:'正在重试'};
const timeFormat=new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
function formatTime(value){const date=new Date(value);return typeof value==='string'&&Number.isFinite(date.getTime())?timeFormat.format(date):'暂无记录';}
function showError(message){element('error').textContent=message||'';element('error').hidden=!message;}
async function request(path,body){const response=await fetch(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:body===undefined?{}:{'Content-Type':'application/json','X-Desktop-CSRF':csrf},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();if(!response.ok)throw new Error(value.error||'操作未完成，请稍后重试。');return value;}
function render(state){
 lastState=state;const disabled=busy||state.busy,needsConfirmation=state.phase==='confirmation_required',verificationPending=state.running&&!state.authenticated;
 element('workbench').href=`${state.siteOrigin}/?view=prospecting`;
 element('status-badge').textContent=state.paired?(phaseLabels[state.phase]||'已就绪'):'待配对';
 element('status-title').textContent=needsConfirmation?'确认用于工作台的抖音账号':state.phase==='account_mismatch'?'请切回已配对的抖音账号':state.phase==='verification_required'?'需要重新核验账号':verificationPending?'正在核验抖音账号':state.running?'抖音已连接':state.busy?'正在连接抖音':state.authenticated?'抖音账号已确认':state.paired?'点击连接抖音':'安装完成，等待连接工作台';
 element('status-message').textContent=state.message||'按下面的步骤完成首次连接。';
 element('account').textContent=state.accountName?`${needsConfirmation?'待确认账号':state.phase==='account_mismatch'?'浏览器账号':state.authenticated?'当前账号':'上次账号'}：${state.accountName}`:'';
 element('pair-step').classList.toggle('is-complete',state.paired);
 element('pair-description').textContent=state.paired?'配对配置已保存到这台电脑。通常不需要重新导入；更换配对前请先停止助手。':'在工作台展开“连接你的抖音账号”，创建配对配置并下载。然后点下面的按钮，助手会从下载文件夹自动找到它。';
 element('service-status').textContent=state.serviceReady?'私站访问已配置':'尚未配置私站访问，请联系安装者';
 element('import-download').disabled=disabled||state.running||state.browserOpen;
 element('config-file').disabled=disabled||state.running||state.browserOpen;
 element('connect').hidden=needsConfirmation;
 element('connect').disabled=disabled||state.phase==='recovering'||!state.paired||(state.running&&state.authenticated)||!state.serviceReady;
 element('connect').textContent=state.running?(state.authenticated?'已连接':'重新核验账号'):state.busy?'正在连接…':'连接抖音';
 element('confirm-connect').hidden=!needsConfirmation;
 element('confirm-connect').disabled=disabled||!needsConfirmation||!state.serviceReady;
 element('login').hidden=state.running||needsConfirmation;
 element('login').disabled=disabled||state.running||!state.paired||!state.serviceReady;
 element('stop').disabled=stoppingAction||(!state.running&&!state.browserOpen&&!state.busy);
 element('stop').textContent=state.busy&&!state.running?'取消连接':'停止助手';
 element('heartbeat-status').textContent=`${heartbeatLabels[state.heartbeatState]||heartbeatLabels.idle} · ${formatTime(state.lastHeartbeatAt)}`;
 element('verified-at').textContent=formatTime(state.lastVerifiedAt);
}
async function action(path,body={}){const stopping=path==='/api/stop';if(stopping?stoppingAction:busy)return;activeActions++;busy=true;if(stopping)stoppingAction=true;showError('');if(lastState)render(lastState);try{render(await request(path,body));}catch(error){showError(error.message);}finally{activeActions--;busy=activeActions>0;if(stopping)stoppingAction=false;try{render(await request('/api/state'));}catch{/* Preserve the displayed error. */}}}
for(const id of ['import-download','connect','confirm-connect','login','stop'])element(id).addEventListener('click',()=>action(`/api/${id}`));
element('config-file').addEventListener('change',async event=>{const file=event.target.files?.[0];if(!file)return;if(file.size>65536){showError('请选择工作台下载的配对 JSON 文件。');return;}try{const config=JSON.parse(await file.text());await action('/api/config',{config});}catch{showError('配置文件无法读取，请重新下载。');}finally{event.target.value='';}});
async function initialize(){
 try{const launchToken=location.hash.slice(1);history.replaceState(null,'',location.pathname);const session=await request('/api/session',{token:launchToken});csrf=session.csrf;render(await request('/api/state'));setInterval(async()=>{try{render(await request('/api/state'));}catch(error){showError(error.message);}},1000);}
 catch(error){showError(error.message);element('status-title').textContent='请重新打开助手';element('status-message').textContent='关闭窗口后，从桌面再次打开“抖音获客助手”。';}
}
void initialize();
