#!/usr/bin/env node
import {constants} from 'node:fs';
import {mkdir,open,rename,unlink,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {strToU8,zipSync} from 'fflate';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const source=join(root,'tools','douyin-bridge');
const destination=join(root,'public','downloads','douyin-bridge.zip');
// Explicit source files only: never recurse into credentials, profiles, logs or dependencies.
const sourceFiles=['bridge.mjs','bridge-core.mjs','browser-adapter.mjs','retry-transcript.mjs','conversation-transcript.mjs','package.json','package-lock.json','README.md'];
const installation=`# 下载版抖音助手安装说明

本下载包可以独立使用，无需下载营销工作台源码。请先解压 ZIP，再在解压后的 douyin-bridge 文件夹中打开终端。以下命令都在这个文件夹中运行。

## 1. 安装运行环境和浏览器

需要 Node.js 22.13 或更高版本，以及能打开桌面窗口的电脑。先确认 Node.js 和 npm 已安装：

\`\`\`sh
node --version
npm --version
npm ci
node node_modules/playwright/cli.js install chromium
\`\`\`

安装会下载依赖和专用 Chromium 浏览器；下载包本身不包含这些文件。保留 package-lock.json，使用 npm ci 安装包中锁定的依赖版本。

## 2. 载入工作台下载的配对配置

在工作台“评论获客”中创建本机配对，下载 douyin-bridge.json。将下方示例路径替换为这份文件的实际完整路径，路径两侧保留双引号：

\`\`\`sh
node bridge.mjs setup --input "/完整路径/douyin-bridge.json"
\`\`\`

macOS 下载目录的常见示例：

\`\`\`sh
node bridge.mjs setup --input "$HOME/Downloads/douyin-bridge.json"
\`\`\`

配对配置含设备凭证，只保存在自己的电脑。setup 完成后配置会保存到 ~/.config/marketing-workbench/douyin-bridge.json；可以删除最初下载的配置副本。私有工作台如需额外访问凭证，在配对配置中填写 sitesToken，详见 README.md。

## 3. 登录并启动

\`\`\`sh
node bridge.mjs login
node bridge.mjs doctor
node bridge.mjs run
\`\`\`

login 会打开专用浏览器。亲自扫码登录，确认当前账号后回到终端按 Enter。若无法核实账号，先在浏览器打开右上角个人主页菜单，再检查登录状态。

run 启动后保持终端和浏览器打开，回到工作台即可发现账号和采集评论。一次只运行一个助手，按 Ctrl+C 停止。再次启动时，在本文件夹运行 node bridge.mjs run 即可；需要切换账号时先停止助手，再重新执行 login。

## 使用中的状态

- 网页显示离线：确认 run 仍在运行，并查看终端提示。
- 私信失败时，在原评论点“重试发送”。显示“待核对”时，点“核对并重试”，助手会先核对原会话，再决定是否需要发送。
- 更新助手：先停止旧进程，再解压新版本并重新执行 npm ci；保留原配置和状态目录。

README.md 保留了源码版的完整能力、协议和限制说明。其中 tools/douyin-bridge 前缀和测试命令适用于完整源码仓库；独立下载版按本文件安装，使用 doctor 检查连接，无需运行仓库测试。
`;

const files=await Promise.all(sourceFiles.map(async name=>{
 const handle=await open(join(source,name),constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  if(!(await handle.stat()).isFile())throw new Error(`Refusing non-file source: ${name}`);
  return[`douyin-bridge/${name}`,new Uint8Array(await handle.readFile())];
 }finally{await handle.close();}
}));
const entries=Object.fromEntries([...files,['douyin-bridge/INSTALL.md',strToU8(installation)]]);
// Stable timestamps make repeated builds of unchanged sources byte-for-byte identical.
const archive=zipSync(entries,{level:9,mtime:new Date(2020,0,1)});
await mkdir(dirname(destination),{recursive:true});
const temporary=`${destination}.${randomUUID()}.tmp`;
try{await writeFile(temporary,archive,{flag:'wx',mode:0o644});await rename(temporary,destination);}
finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
console.log(`Packaged ${Object.keys(entries).length} files (${archive.length} bytes): ${destination}`);
