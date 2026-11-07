#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, saveConfig, Journal, runOnce, deviceStatusHeartbeat, safeError, BridgeError } from './bridge-core.mjs';
import { openBrowser } from './browser-adapter.mjs';
import { createConnectionRecovery } from './connection-recovery.mjs';

const DEFAULT_CONFIG = join(homedir(), '.config', 'marketing-workbench', 'douyin-bridge.json');
export function parseArgs(args) {
  const command = args[0] || 'help';
  if (!['setup', 'login', 'doctor', 'run', 'help', '--help'].includes(command)) throw new BridgeError('命令无效，请运行 bridge.mjs help。');
  const flags = {};
  for (let i = 1; i < args.length; i++) {
    const key = args[i];
    if (!['--config', '--input', '--once'].includes(key) || flags[key] !== undefined) throw new BridgeError('参数无效；凭证只能从文件或标准输入读取。');
    flags[key] = key === '--once' ? true : args[++i];
    if (!flags[key] || (typeof flags[key] === 'string' && flags[key].startsWith('--'))) throw new BridgeError('参数缺少值。');
  }
  if (flags['--input'] && command !== 'setup') throw new BridgeError('--input 仅用于 setup。');
  if (flags['--once'] && command !== 'run') throw new BridgeError('--once 仅用于 run。');
  return { command, configPath: resolve(flags['--config'] || DEFAULT_CONFIG), inputPath: flags['--input'], once: flags['--once'] === true };
}
async function stdinText() {
  let text = '';
  for await (const chunk of process.stdin) { text += chunk; if (Buffer.byteLength(text) > 65536) throw new BridgeError('配置超过 64 KB。'); }
  return text;
}

/** The CLI pauses on account boundaries just like the desktop. Browser lifetime
 * stays with main(), so a paused challenge remains visible until explicit exit. */
export async function runCliLoop(config, { adapter, journal, signal, once=false, now=Date.now, run=runOnce,
  heartbeat=deviceStatusHeartbeat, sleep=(ms, options)=>delay(ms, undefined, options), schedule=setInterval, cancel=clearInterval,
  logger=message=>console.log(`${new Date().toISOString()} ${message}`), errorLogger=message=>console.error(message),
}={}) {
  const local=new AbortController(), active=signal?AbortSignal.any([signal,local.signal]):local.signal;
  const recovery=createConnectionRecovery({now});
  let timer,inFlight,revoked=false,networkFailures=0,reportedRecoveryLimit=false;
  const tick=async()=>{
    if(inFlight||active.aborted)return;
    inFlight=heartbeat(config,{signal:active}).catch(error=>{
      if(active.aborted)return;
      if(error.code==='API_REJECTED'&&[404,405].includes(error.status))cancel(timer);
      else if(error.code==='API_REJECTED'&&[401,403].includes(error.status)){revoked=true;local.abort();}
    });
    try{await inFlight;}finally{inFlight=undefined;}
  };
  if(!once){timer=schedule(tick,15000);timer?.unref?.();}
  const paused=reason=>({manualRequired:true,reason,exitCode:1});
  try{
    while(!active.aborted){
      let waitMs=5000;
      try{
        const result=await run(config,{adapter,journal,signal:active,recoverAccount:recovery.takeRecovery(),logger});
        if(active.aborted)break;
        if(result?.humanActionRequired)return paused('HUMAN_ACTION_REQUIRED');
        if(result?.authenticated===false&&result.verificationPending!==true)return paused('UNAUTHENTICATED');
        networkFailures=0;recovery.observe(result);
        if(recovery.status().manualRequired&&!reportedRecoveryLimit){logger('自动核验暂未完成。请检查专用浏览器；需要重新核验时，先停止 run 再启动，保留原配对和本机记录。');reportedRecoveryLimit=true;}
        if(result?.authenticated===true)reportedRecoveryLimit=false;
        if(result?.worked)logger(`本次任务已记录。${result.pendingReport?'等待补交结果。':'结果已处理。'}`);
        else if(once)logger(result?.authenticated?'设备已连接，当前没有待执行任务。':'尚未取得任务，请检查浏览器登录和工作台设备状态。');
      }catch(error){
        if(active.aborted)break;
        errorLogger(safeError(error));
        if(['HUMAN_ACTION_REQUIRED','UNAUTHENTICATED','ACCOUNT_CHANGED'].includes(error.code))return paused(error.code);
        const retryable=error.code==='NETWORK'||error.code==='API_REJECTED'&&(error.status===408||error.status===429||error.status>=500);
        if(once||!retryable)return{manualRequired:false,reason:error.code,exitCode:1};
        waitMs=Math.min(30000,5000*2**Math.min(networkFailures++,4));
      }
      if(once)return{manualRequired:false,reason:'once',exitCode:0};
      await sleep(waitMs,{signal:active}).catch(()=>{});
    }
    return{manualRequired:false,reason:revoked?'access_revoked':'stopped',exitCode:revoked?1:0};
  }finally{cancel(timer);local.abort();await inFlight;}
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (['help', '--help'].includes(options.command)) {
    console.log('抖音评论获客本地执行器\n\n  node bridge.mjs setup --input 配置文件.json [--config 保存路径]\n  node bridge.mjs setup --input - [--config 保存路径]  # 从 stdin 读取 JSON\n  node bridge.mjs login [--config 保存路径]\n  node bridge.mjs doctor [--config 保存路径]\n  node bridge.mjs run [--config 保存路径] [--once]\n\n登录使用独立可见浏览器。不会读取系统 Cookie，不会自动处理验证码。');
    return;
  }
  if (options.command === 'setup') {
    if (!options.inputPath) throw new BridgeError('setup 需要 --input 配置文件.json 或 --input -；不要把凭证放在命令参数中。');
    const raw = options.inputPath === '-' ? await stdinText() : await readFile(resolve(options.inputPath), 'utf8');
    if (Buffer.byteLength(raw) > 65536) throw new BridgeError('配置超过 64 KB。');
    let config; try { config = JSON.parse(raw); } catch { throw new BridgeError('配置不是有效 JSON。'); }
    await saveConfig(options.configPath, config);
    console.log(`已保存权限为 0600 的配置：${options.configPath}\n下一步运行 login，在专用浏览器扫码登录。`); return;
  }
  const config = await loadConfig(options.configPath);
  const pairingScope = createHash('sha256').update(`${config.origin}\n${config.deviceId}`).digest('hex').slice(0, 16);
  const stateDir = join(dirname(options.configPath), 'douyin-bridge-state', pairingScope);
  const journal = await Journal.open(join(stateDir, 'journal.json'));
  await journal.bindConfig(config);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let browser;
  try {
    if (options.command === 'doctor') {
      console.log(JSON.stringify({ configured: true, browser: 'not-opened', authenticated: false, loginChecked: false,
        savedAccountId: journal.data.accountId, pendingResults: journal.data.entries.filter(entry => !entry.reported && !entry.reportRejected).length,
        message: '仅检查本机配对和待补交记录，未打开浏览器或检查实时登录。需要核实账号时，请显式连接抖音。' }, null, 2));
      return;
    }
    browser = await openBrowser(config, join(stateDir, 'browser-profile'));
    if (options.command === 'login') {
      await browser.adapter.navigate('https://www.douyin.com/', controller.signal);
      console.log('请在已打开的专用浏览器扫码登录。登录后打开右上角个人主页菜单，保留真实账号主页链接可见。');
      if (!process.stdin.isTTY) throw new BridgeError('login 需要交互终端；请在终端运行后亲自扫码。');
      const reader = createInterface({ input: process.stdin, output: process.stdout });
      try { await reader.question('确认浏览器中是你要使用的账号后，按 Enter：', { signal: controller.signal }); } finally { reader.close(); }
      const account = await browser.adapter.accountStatus({ signal: controller.signal });
      if (!account.authenticated) throw new BridgeError(account.message || '当前账号尚未核实。');
      await journal.bindAccount(account.accountId);
      console.log(`已确认账号：${account.accountName}（${account.accountId}）。登录态仅保存在本机。下一步运行 run。`); return;
    }
    // `run` is an explicit user action. Initialize its owned pages once before
    // the passive task loop; later health checks never create or navigate tabs.
    await browser.adapter.accountStatus({ signal: controller.signal, expectedAccountId: journal.data.accountId });
    const outcome = await runCliLoop(config, { adapter: browser.adapter, journal, signal: controller.signal, once: options.once });
    if (outcome.exitCode) process.exitCode = outcome.exitCode;
    if (outcome.manualRequired && !options.once && !controller.signal.aborted) {
      console.error('同步已暂停，专用浏览器保留供您处理。完成登录、安全验证或切回原账号后，请按 Ctrl+C 停止，再重新启动 run 明确核验；不会自动恢复发送。');
      await new Promise(done => controller.signal.addEventListener('abort', done, { once: true }));
    }
  } finally {
    controller.abort();
    await browser?.close().catch(() => {}); await journal.close();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
}
