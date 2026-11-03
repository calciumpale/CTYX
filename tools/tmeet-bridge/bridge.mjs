#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, resolveExecutable, runOnce } from './bridge-core.mjs';

export async function main(args = process.argv.slice(2)) {
  const allowed = new Set(['--config', '--tmeet', '--once', '--help']);
  const parsed = {};
  for (let i = 0; i < args.length; i += 1) {
    const name = args[i];
    if (!allowed.has(name) || parsed[name]) throw new Error('参数无效；使用 --help 查看用法。');
    parsed[name] = ['--once', '--help'].includes(name) ? true : args[++i];
    if (!parsed[name] || (typeof parsed[name] === 'string' && parsed[name].startsWith('--'))) throw new Error('缺少参数值。');
  }
  if (parsed['--help']) {
    console.log('用法：node bridge.mjs [--config PATH] [--tmeet ABSOLUTE_PATH] [--once]\n默认持续轮询；--once 只检查授权并领取一次任务。不会发起登录或监听本机端口。');
    return;
  }
  const config = await loadConfig(parsed['--config'] || join(homedir(), '.config/marketing-workbench/tmeet-bridge.json'));
  const tmeetPath = await resolveExecutable(parsed['--tmeet'] || 'tmeet');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    do {
      try {
        await runOnce(config, { tmeetPath, signal: controller.signal, logger: (message) => console.log(`${new Date().toISOString()} ${message}`) });
      } catch {
        if (controller.signal.aborted) break;
        console.error(`${new Date().toISOString()} 同步未完成，请检查网络、设备配对或工作台状态。`);
        if (parsed['--once']) { process.exitCode = 1; break; }
      }
      if (parsed['--once']) break;
      await delay(5000, undefined, { signal: controller.signal }).catch(() => {});
    } while (!controller.signal.aborted);
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('同步助手无法启动，请检查本机配置权限、Node.js 和 tmeet 安装路径。'); process.exitCode = 1; });
}
