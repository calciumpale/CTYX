#!/usr/bin/env node
import { mkdir, writeFile, chmod, lstat, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { validateConfig, loadConfig, resolveExecutable } from './bridge-core.mjs';

export const AGENT_LABEL = 'com.ctai.marketing-workbench.tmeet-bridge';
const xml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

async function privateWrite(path, contents) {
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error('拒绝覆盖符号链接。'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

/** Writes files only. launchctl must be invoked separately after deployment verification. */
export async function installMacAgent(rawConfig, { home = homedir(), nodePath = process.execPath, tmeetPath, bridgePath = fileURLToPath(new URL('./bridge.mjs', import.meta.url)) } = {}) {
  const config = validateConfig(rawConfig);
  for (const path of [home, nodePath, tmeetPath, bridgePath]) if (typeof path !== 'string' || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw new Error('安装路径必须为绝对路径。');
  const configPath = join(home, '.config/marketing-workbench/tmeet-bridge.json');
  const plistPath = join(home, 'Library/LaunchAgents', `${AGENT_LABEL}.plist`);
  const logPath = join(home, 'Library/Logs/marketing-workbench/tmeet-bridge.log');
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await mkdir(dirname(plistPath), { recursive: true, mode: 0o700 });
  await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
  await privateWrite(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const argv = [nodePath, bridgePath, '--config', configPath, '--tmeet', tmeetPath];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${AGENT_LABEL}</string>\n<key>ProgramArguments</key><array>${argv.map((arg) => `<string>${xml(arg)}</string>`).join('')}</array>\n<key>WorkingDirectory</key><string>${xml(home)}</string>\n<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(`${dirname(nodePath)}:${dirname(tmeetPath)}:/usr/bin:/bin`)}</string></dict>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n<key>ThrottleInterval</key><integer>15</integer>\n<key>StandardOutPath</key><string>${xml(logPath)}</string>\n<key>StandardErrorPath</key><string>${xml(logPath)}</string>\n</dict></plist>\n`;
  await privateWrite(plistPath, plist);
  return { configPath, plistPath, logPath, started: false };
}

async function main(args = process.argv.slice(2)) {
  let tmeetPath;
  let configPath;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--tmeet') tmeetPath = args[++i];
    else if (args[i] === '--config') configPath = args[++i];
    else if (args[i] === '--help') { console.log('用法：node install-macos.mjs [--tmeet ABSOLUTE_PATH] [--config EXISTING_PRIVATE_CONFIG]\n默认从标准输入读取 JSON 配置；只写配置与 LaunchAgent，不启动。'); return; }
    else throw new Error('未知参数。');
  }
  if (process.platform !== 'darwin') throw new Error('本安装器仅用于 macOS。');
  let config;
  if (configPath) config = await loadConfig(configPath);
  else {
    if (process.stdin.isTTY) throw new Error('请通过标准输入提供配置 JSON，不要把凭证写入命令参数。');
    let input = '';
    for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 65536) throw new Error('配置过大。'); }
    config = JSON.parse(input);
  }
  const result = await installMacAgent(config, { tmeetPath: await resolveExecutable(tmeetPath || 'tmeet') });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('安装未完成，请检查配置、文件权限与绝对路径。凭证不会输出。'); process.exitCode = 1; });
}
