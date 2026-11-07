#!/usr/bin/env node
import {constants} from 'node:fs';
import {access,chmod,copyFile,cp,lstat,mkdir,readFile,readdir,readlink,realpath,rename,rm,symlink,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {basename,dirname,extname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const run=promisify(execFile);
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const source=join(root,'tools','douyin-bridge');
const appName='抖音获客助手';
const bundleID='com.ctai.marketing-workbench.douyin-assistant';
const managedBy='marketing-workbench-douyin-mac-installer';
const defaultOrigin='https://ctai-marketing-workbench-20261023.bright-newt-8569.chatgpt.site';
const sourceFiles=['bridge.mjs','bridge-core.mjs','browser-adapter.mjs','retry-transcript.mjs','conversation-transcript.mjs','desktop-controller.mjs','desktop-server.mjs'];
const copyBundledDependencies={recursive:true,verbatimSymlinks:true,mode:constants.COPYFILE_FICLONE};
const staticExtensions=new Set(['.html','.css','.js','.mjs','.svg','.png','.jpg','.jpeg','.webp','.ico','.woff','.woff2','.ttf']);
const forbiddenNames=new Set(['douyin-bridge.json','douyin-service-access.json','journal.json','browser-profile','douyin-bridge-state']);

function options(args){
 const result={destination:join(homedir(),'Applications',`${appName}.app`),siteOrigin:defaultOrigin,desktopLink:true};
 for(let i=0;i<args.length;i++){
  const flag=args[i],value=args[++i];
  if(!['--destination','--site-origin'].includes(flag)||!value||value.startsWith('--'))throw new Error('用法：node scripts/install-douyin-mac.mjs [--destination 暂存目录或应用.app] [--site-origin HTTPS工作台地址]');
  if(flag==='--destination'){const target=resolve(value);result.destination=target.endsWith('.app')?target:join(target,`${appName}.app`);result.desktopLink=false;}
  else result.siteOrigin=value;
 }
 const url=new URL(result.siteOrigin);
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('工作台地址必须是无凭证、无路径的 HTTPS origin。');
 result.siteOrigin=url.origin;
 return result;
}
async function exists(path){try{return await lstat(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function regularFile(path){const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())throw new Error(`需要普通文件：${path}`);return info;}
function inside(parent,child){const path=relative(parent,child);return path===''||(!path.startsWith(`..${sep}`)&&path!=='..'&&!isAbsolute(path));}
async function safeTree(directory,{staticOnly=false}={}){
 const base=await realpath(directory);
 if(!(await lstat(directory)).isDirectory())throw new Error(`需要普通目录：${directory}`);
 async function visit(path){
  for(const entry of await readdir(path,{withFileTypes:true})){
   const current=join(path,entry.name);
   if(forbiddenNames.has(entry.name)||entry.name.startsWith('.env'))throw new Error(`拒绝将本机配置或运行状态放进应用：${entry.name}`);
   if(entry.isSymbolicLink()){
    if(staticOnly||isAbsolute(await readlink(current))||!inside(base,await realpath(current)))throw new Error(`拒绝依赖包外部路径的符号链接：${current}`);
   }else if(entry.isDirectory())await visit(current);
   else if(!entry.isFile()||(staticOnly&&!staticExtensions.has(extname(entry.name).toLowerCase())))throw new Error(`不支持的安装资源：${current}`);
  }
 }
 await visit(directory);
}
async function isManagedApp(path){
 const info=await exists(path);if(!info?.isDirectory()||info.isSymbolicLink())return false;
 try{
  const markerPath=join(path,'Contents','Resources','install-manifest.json');await regularFile(markerPath);
  const marker=JSON.parse(await readFile(markerPath,'utf8'));
  const plist=await run('/usr/bin/plutil',['-extract','CFBundleIdentifier','raw','-o','-',join(path,'Contents','Info.plist')]);
  return marker.managedBy===managedBy&&marker.bundleID===bundleID&&plist.stdout.trim()===bundleID;
 }catch{return false;}
}
async function assertNotRunning(destination){
 const {stdout}=await run('/bin/ps',['-axww','-o','pid=,comm=']);
 const executable=join(destination,'Contents','MacOS','DouyinLauncher');
 if(stdout.split('\n').some(line=>line.trim().replace(/^\d+\s+/,'')===executable))throw new Error('请先退出已安装的抖音获客助手，再运行安装脚本。');
}
async function desktopShortcut(destination){
 const desktop=join(homedir(),'Desktop');await mkdir(desktop,{recursive:true});
 const link=join(desktop,`${appName}.app`),existing=await exists(link);
 if(existing){
  if(existing.isSymbolicLink()&&resolve(dirname(link),await readlink(link))===destination)return '桌面快捷方式已存在。';
  return '桌面已有同名文件，已保留；请从 Applications 文件夹打开新安装的应用。';
 }
 try{await symlink(destination,link);return `桌面快捷方式：${link}`;}
 catch(error){if(error.code==='EEXIST')return '桌面同名文件已存在，已保留。';throw error;}
}

async function main(){
 if(process.platform!=='darwin')throw new Error('此安装脚本仅用于 macOS。');
 const [major,minor]=process.versions.node.split('.').map(Number);if(major<22||(major===22&&minor<13))throw new Error('安装需要 Node.js 22.13 或更高版本。');
 const config=options(process.argv.slice(2));
 await run('/usr/bin/clang',['--version']);await access('/usr/bin/codesign',constants.X_OK);
 await Promise.all(sourceFiles.map(name=>regularFile(join(source,name))));
 await regularFile(join(source,'macos','Launcher.m'));
 await safeTree(join(source,'desktop-ui'),{staticOnly:true});
 await safeTree(join(source,'node_modules'));
 const require=createRequire(join(source,'package.json'));
 const chromiumExecutable=await realpath(require('playwright').chromium.executablePath());
 await access(chromiumExecutable,constants.X_OK);
 let chromiumDirectory=dirname(chromiumExecutable);
 while(!/^chromium-\d+$/.test(basename(chromiumDirectory))){
  const parent=dirname(chromiumDirectory);if(parent===chromiumDirectory)throw new Error('无法确认 Playwright Chromium 的完整安装目录。');chromiumDirectory=parent;
 }
 await safeTree(chromiumDirectory);
 const nodeBinary=await realpath(process.execPath);await regularFile(nodeBinary);
 try{await run(nodeBinary,['--use-env-proxy','-e','process.exit(0)'],{env:{PATH:'/usr/bin:/bin'}});}
 catch{throw new Error('当前 Node 不支持 --use-env-proxy，无法正确使用本机系统代理；请使用支持该选项的 Node 后重新安装。');}
 const dependencies=await run('/usr/bin/otool',['-L',nodeBinary]);
 if(dependencies.stdout.split('\n').slice(1).some(line=>line.trim()&&!/^\s*\/(?:usr\/lib\/|System\/Library\/)/.test(line)))throw new Error('当前 Node 依赖包外动态库，不能作为独立运行时安装；请使用官方独立 Node。');
 const existing=await exists(config.destination);
 if(existing&&!await isManagedApp(config.destination))throw new Error(`目标已有非本安装器管理的文件，未覆盖：${config.destination}`);
 if(existing)await assertNotRunning(config.destination);
 const parent=dirname(config.destination);await mkdir(parent,{recursive:true});
 const staging=join(parent,`.douyin-assistant-building-${randomUUID()}.app`);
 const contents=join(staging,'Contents'),resources=join(contents,'Resources');
 let backup;
 try{
  await Promise.all(['MacOS','Resources/runtime','Resources/bridge','Resources/browsers'].map(path=>mkdir(join(contents,path),{recursive:true})));
  await copyFile(nodeBinary,join(resources,'runtime','node'),constants.COPYFILE_FICLONE);await chmod(join(resources,'runtime','node'),0o755);
  await Promise.all(sourceFiles.map(name=>copyFile(join(source,name),join(resources,'bridge',name))));
  await cp(join(source,'desktop-ui'),join(resources,'bridge','desktop-ui'),{recursive:true,verbatimSymlinks:true});
  await cp(join(source,'node_modules'),join(resources,'bridge','node_modules'),copyBundledDependencies);
  await cp(chromiumDirectory,join(resources,'browsers',basename(chromiumDirectory)),copyBundledDependencies);
  const bundledBrowser=join(resources,'browsers',basename(chromiumDirectory),relative(chromiumDirectory,chromiumExecutable));
  await access(bundledBrowser,constants.X_OK);
  await writeFile(join(resources,'site.json'),JSON.stringify({origin:config.siteOrigin},null,2)+'\n');
  await writeFile(join(resources,'install-manifest.json'),JSON.stringify({managedBy,bundleID,version:1,nodeVersion:process.versions.node,chromiumDirectory:basename(chromiumDirectory),sourceFiles},null,2)+'\n');
  const plist=`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleID}</string>
<key>CFBundleExecutable</key><string>DouyinLauncher</string>
<key>CFBundleName</key><string>${appName}</string>
<key>CFBundleDisplayName</key><string>${appName}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>\n`;
  await writeFile(join(contents,'Info.plist'),plist);
  await run('/usr/bin/plutil',['-lint',join(contents,'Info.plist')]);
  await run('/usr/bin/clang',['-fobjc-arc','-O2','-Wall','-Wextra','-mmacosx-version-min=12.0','-framework','Cocoa','-framework','WebKit','-framework','UniformTypeIdentifiers','-framework','CFNetwork',join(source,'macos','Launcher.m'),'-o',join(contents,'MacOS','DouyinLauncher')]);
  await run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',staging]);
  await run('/usr/bin/codesign',['--verify','--deep','--strict',staging]);
  const browserCheck=await run(join(resources,'runtime','node'),['--use-env-proxy','--input-type=module','-e',"import {chromium} from 'playwright'; import {accessSync,constants} from 'node:fs'; accessSync(chromium.executablePath(),constants.X_OK);"],{cwd:join(resources,'bridge'),env:{PATH:'/usr/bin:/bin',HOME:homedir(),PLAYWRIGHT_BROWSERS_PATH:join(resources,'browsers')}});
  void browserCheck;
  // Re-check just before replacing; an unrelated file appearing during the build is never removed.
  const atCommit=await exists(config.destination);
  if(atCommit){
   if(!await isManagedApp(config.destination))throw new Error('安装期间目标路径已改变，原文件未覆盖。');
   await assertNotRunning(config.destination);
   backup=`${config.destination.slice(0,-4)}.backup-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}.app`;
   await rename(config.destination,backup);
  }
  try{await rename(staging,config.destination);}catch(error){if(backup&&!await exists(config.destination))await rename(backup,config.destination);throw error;}
  console.log(`已安装：${config.destination}`);
  console.log(`内置 Node ${process.versions.node} 与 ${basename(chromiumDirectory)}，无需终端启动。`);
  if(backup)console.log(`旧版本已保留：${backup}`);
  if(config.desktopLink)console.log(await desktopShortcut(config.destination));
  else console.log('暂存安装未修改桌面快捷方式。');
 }finally{await rm(staging,{recursive:true,force:true});}
}

main().catch(error=>{console.error(error.message);process.exitCode=1;});
