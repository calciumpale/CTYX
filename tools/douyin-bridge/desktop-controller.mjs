import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeError, Journal, loadConfig, runOnce, validateConfig, verifiedAccountUpgrade } from './bridge-core.mjs';
import { openBrowser } from './browser-adapter.mjs';

const HOME = 'https://www.douyin.com/';
const RECOVERABLE_SESSION_ERRORS = new Set(['HUMAN_ACTION_REQUIRED', 'UNAUTHENTICATED', 'ACCOUNT_CHANGED']);
const PUBLIC_ERRORS = {
  INVALID_CONFIG: '配对配置不完整，请重新导入工作台下载的配置。',
  PRIVATE_FILE: '本机配置权限不正确，请通过助手重新导入配置。',
  ENOENT: '尚未导入配对配置，请先下载并导入配置。',
  JOURNAL_LOCKED: '另一个同步助手正在运行，请先停止另一个助手。',
  JOURNAL_FORMAT: '本地发送记录无法读取，请保留记录并修复，不要删除记录重发。',
  PAIRING_CHANGED: '本地记录属于其他设备配对，请重新导入正确的配置。',
  BROWSER_MISSING: '专用浏览器未能打开，请检查浏览器组件安装后重试。',
  HUMAN_ACTION_REQUIRED: '同步已暂停，当前浏览器页面已保留。请在抖音页面手动完成安全验证，再点击“连接抖音”。失败的搜索需在工作台重新发起。',
  ACCOUNT_CHANGED: '浏览器账号与已配对账号不一致，请切回原账号或重新配对。',
  UNAUTHENTICATED: '请在打开的抖音页面完成登录，再点击“连接抖音”。',
  NETWORK: '暂时无法连接工作台，已保存的结果不会重发，稍后会重试连接。',
  API_REJECTED: '工作台拒绝了连接，请检查设备配对及私站访问凭证。',
  API_FORMAT: '工作台响应暂时无法识别，请稍后重新启动。',
  LEASE_LOST: '任务已暂停或执行凭证失效，请在工作台核对任务状态。',
  RESOURCE_RELEASE: '任务已停止，但浏览器或本地记录未能正常关闭，请退出助手后重试。',
};

/**
 * Button-driven facade for the local desktop panel. Constructing or calling
 * status() has no filesystem, browser or network side effects. Login operations
 * never poll. An explicit connect() or start() enters the serial runOnce loop.
 *
 * Public methods return a safe snapshot; raw exceptions, config, tokens, request
 * bodies and journal results never enter it. `dependencies` is a trusted test
 * seam, not an option that should be accepted from an HTTP request.
 */
export class DesktopController {
  #configPath;
  #deps;
  #pollIntervalMs;
  #config;
  #journal;
  #browser;
  #actionPromise;
  #actionAbort;
  #loopPromise;
  #runAbort;
  #stopPromise;
  #stopping = false;
  #snapshot = {
    phase: 'idle', busy: false, running: false, authenticated: false,
    configured: false, pendingResults: 0,
    message: '先导入配对配置，再点击“连接抖音”。首次使用需要扫码并确认账号。',
    updatedAt: new Date().toISOString(),
  };

  constructor({ configPath, pollIntervalMs = 5000, dependencies = {} } = {}) {
    if (typeof configPath !== 'string' || !configPath.trim()) throw new BridgeError('需要提供本机配置文件路径。', 'INVALID_CONFIG');
    this.#configPath = resolve(configPath);
    this.#pollIntervalMs = Number.isFinite(pollIntervalMs) ? Math.max(250, pollIntervalMs) : 5000;
    this.#deps = {
      loadConfig, openJournal: path => Journal.open(path), openBrowser, runOnce,
      sleep: (ms, { signal }) => delay(ms, undefined, { signal }),
      ...dependencies,
    };
  }

  status() {
    return { ...this.#snapshot, browserOpen: Boolean(this.#browser), pendingResults: this.#pendingResults() };
  }

  #pendingResults() {
    return this.#journal ? this.#journal.data.entries.filter(entry => !entry.reported && !entry.reportRejected && (entry.result || entry.error)).length : this.#snapshot.pendingResults;
  }

  #set(values) {
    this.#snapshot = { ...this.#snapshot, ...values, updatedAt: new Date().toISOString() };
  }

  #check(signal) {
    if (signal.aborted || this.#stopping) throw new BridgeError('操作已停止。', 'ABORTED');
  }

  #publicFailure(error) {
    const code = Object.hasOwn(PUBLIC_ERRORS, error?.code) ? error.code : 'DESKTOP_ERROR';
    return { errorCode: code, message: PUBLIC_ERRORS[code] || '操作未完成，请检查专用浏览器和本机连接后重试。' };
  }

  #account(value) {
    if (value?.authenticated !== true || typeof value.accountId !== 'string' || !/^[a-zA-Z0-9_.-]{5,140}$/.test(value.accountId)) return { authenticated: false };
    const bound = this.#journal?.data.accountId;
    if (value.verificationPending === true || bound && !bound.startsWith('dy-readonly-') && value.accountId.startsWith('dy-readonly-')) return { authenticated: false };
    let name = typeof value.accountName === 'string' ? value.accountName.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 100) : '';
    for (const secret of [this.#config?.deviceToken, this.#config?.sitesToken].filter(Boolean)) name = name.replaceAll(secret, '[已隐藏]');
    return { authenticated: true, accountId: value.accountId, accountName: name || '已登录账号' };
  }

  async #closeBrowser() {
    const browser = this.#browser; this.#browser = undefined;
    if (!browser) return true;
    try { await browser.close(); return true; } catch { return false; }
  }

  async #release() {
    this.#snapshot.pendingResults = this.#pendingResults();
    const closedBrowser = await this.#closeBrowser();
    const journal = this.#journal; this.#journal = undefined;
    let closedJournal = true;
    if (journal) { try { await journal.close(); } catch { closedJournal = false; } }
    return closedBrowser && closedJournal;
  }

  async #ensureSession(signal) {
    const config = validateConfig(await this.#deps.loadConfig(this.#configPath));
    this.#check(signal);
    if (this.#journal && (this.#config?.origin !== config.origin || this.#config?.deviceId !== config.deviceId)) {
      if (!await this.#release()) throw new BridgeError('资源未释放。', 'RESOURCE_RELEASE');
      this.#set({ authenticated: false, accountId: undefined, accountName: undefined });
    }
    this.#config = config;
    const scope = createHash('sha256').update(`${config.origin}\n${config.deviceId}`).digest('hex').slice(0, 16);
    const stateDir = join(dirname(this.#configPath), 'douyin-bridge-state', scope);
    if (!this.#journal) this.#journal = await this.#deps.openJournal(join(stateDir, 'journal.json'));
    this.#check(signal);
    await this.#journal.bindConfig(config);
    this.#check(signal);
    if (!this.#browser) this.#browser = await this.#deps.openBrowser(config, join(stateDir, 'browser-profile'));
    this.#check(signal);
    this.#set({ configured: true });
  }

  async #perform(phase, work) {
    if (this.#stopping || this.#actionPromise) return this.status();
    if (this.#loopPromise) {
      this.#set({ message: '同步正在运行。需要重新登录时，请先点击停止。' });
      return this.status();
    }
    const controller = new AbortController(); this.#actionAbort = controller;
    this.#set({ phase, busy: true, errorCode: undefined });
    const action = (async () => {
      try { await work(controller.signal); }
      catch (error) {
        if (!controller.signal.aborted && !this.#stopping) {
          if (!RECOVERABLE_SESSION_ERRORS.has(error?.code)) await this.#release();
          this.#set({ phase: 'error', authenticated: false, running: false, ...this.#publicFailure(error) });
        }
      } finally {
        this.#actionPromise = undefined; this.#actionAbort = undefined;
        if (!this.#stopping) this.#set({ busy: false });
      }
    })();
    this.#actionPromise = action;
    await action; return this.status();
  }

  async startLogin() {
    return this.#perform('opening_browser', async signal => {
      await this.#ensureSession(signal);
      await this.#browser.adapter.navigate(HOME, signal);
      this.#check(signal);
      this.#set({ phase: 'logging_in', authenticated: false, running: false, message: '请在抖音页面完成登录，再点击“连接抖音”核实账号。此时不会领取任务。' });
    });
  }

  async confirmLogin() {
    return this.#perform('checking_login', async signal => {
      await this.#ensureSession(signal);
      const observed = await this.#browser.adapter.accountStatus({ signal, expectedAccountId: this.#journal.data.accountId });
      const account = this.#account(observed);
      this.#check(signal);
      if (!account.authenticated) {
        this.#set({ phase: 'logging_in', authenticated: false, message: '尚未核实登录。请完成登录后，再点击“连接抖音”。' });
        return;
      }
      if (this.#journal.data.accountId && this.#journal.data.accountId !== account.accountId && !verifiedAccountUpgrade(this.#journal.data.accountId, observed)) {
        this.#setAccountMismatch(account); return;
      }
      if (!verifiedAccountUpgrade(this.#journal.data.accountId, observed)) await this.#journal.bindAccount(account.accountId);
      this.#check(signal);
      this.#set({ ...account, phase: 'ready', running: false, message: '账号已确认。点击“连接抖音”即可开始同步工作台任务。' });
    });
  }

  async start() {
    if (this.#loopPromise && !this.#stopping) return this.status();
    return this.#perform('starting', async signal => {
      await this.#ensureSession(signal);
      const observed = await this.#browser.adapter.accountStatus({ signal, expectedAccountId: this.#journal.data.accountId });
      const account = this.#account(observed);
      this.#check(signal);
      if (!account.authenticated || !this.#journal.data.accountId || (this.#journal.data.accountId !== account.accountId && !verifiedAccountUpgrade(this.#journal.data.accountId, observed))) {
        this.#set({ ...account, authenticated: false, phase: 'logging_in', running: false, message: '请先点击“连接抖音”，完成账号核实后再开始同步。' });
        return;
      }
      this.#startLoop(account);
    });
  }

  #setAccountMismatch(account) {
    this.#set({ ...account, phase: 'account_mismatch', authenticated: false, running: false, errorCode: 'ACCOUNT_CHANGED', message: '当前抖音账号与工作台已配对账号不一致。请切回原账号后重新连接；需要换号时，请先在工作台重新配对。' });
  }

  #startLoop(account) {
    this.#runAbort = new AbortController();
    this.#set({ ...account, phase: 'running', running: true, message: '抖音已连接，正在同步工作台任务。' });
    this.#loopPromise = this.#runLoop(this.#runAbort.signal);
  }

  async connect() {
    if (this.#loopPromise && !this.#stopping) return this.status();
    return this.#connect();
  }

  async confirmConnection() {
    if (this.#snapshot.phase !== 'confirmation_required') return this.status();
    return this.#connect(this.#snapshot.accountId);
  }

  async #connect(confirmAccountId) {
    return this.#perform('connecting', async signal => {
      this.#set({ message: '正在恢复已保存的抖音登录，请稍候。' });
      await this.#ensureSession(signal);
      const deadline = Date.now() + 60000;
      let firstCheck = true, loginVerificationRetried = false;
      do {
        const passive = !firstCheck; firstCheck = false;
        let observed = await this.#browser.adapter.accountStatus({ signal, expectedAccountId: this.#journal.data.accountId, passive });
        this.#check(signal);
        if (passive && observed?.needsAccountVerification === true && !loginVerificationRetried) {
          // The existing login page just exposed owner controls. Verify it once;
          // waiting for login must not navigate or reopen the profile every second.
          loginVerificationRetried = true;
          observed = await this.#browser.adapter.accountStatus({ signal, expectedAccountId: this.#journal.data.accountId, passive: false });
        }
        const account = this.#account(observed); this.#check(signal);
        if (account.authenticated) {
          const bound = this.#journal.data.accountId;
          if (bound && bound !== account.accountId && !verifiedAccountUpgrade(bound, observed)) { this.#setAccountMismatch(account); return; }
          if (!bound && confirmAccountId !== account.accountId) {
            this.#set({ ...account, phase: 'confirmation_required', authenticated: false, running: false, message: '首次连接，请确认这是要用于工作台的抖音账号。确认后会开始同步任务。' }); return;
          }
          if (!bound) await this.#journal.bindAccount(account.accountId);
          this.#check(signal); this.#startLoop(account); return;
        }
        this.#set({ phase: 'logging_in', authenticated: false, running: false, message: '正在等待抖音确认登录。若页面要求登录，请扫码；登录后会自动继续，也可点击“取消连接”。' });
        if (Date.now() >= deadline) break;
        await this.#deps.sleep(Math.min(1000, deadline - Date.now()), { signal }); this.#check(signal);
      } while (Date.now() < deadline);
      this.#set({ phase: 'logging_in', authenticated: false, running: false, message: '暂未能核实登录，抖音页面已保留。完成登录或切回原账号后，再点击“连接抖音”。' });
    });
  }

  async #runLoop(signal) {
    let exitState;
    try {
      while (!signal.aborted) {
        try {
          const result = await this.#deps.runOnce(this.#config, {
            adapter: this.#browser.adapter, journal: this.#journal, signal,
            // Never forward raw strings into the desktop panel. The result below
            // provides enough public progress without exposing task bodies.
            logger: () => {},
          });
          if (signal.aborted) break;
          if (result?.humanActionRequired) {
            exitState = { phase: 'error', authenticated: false, ...this.#publicFailure({ code: 'HUMAN_ACTION_REQUIRED' }) };
            break;
          }
          if (result?.authenticated === false) {
            if (result.verificationPending === true) {
              this.#set({ authenticated: false, errorCode: undefined, message: '暂未核实当前账号，正在重试，专用浏览器保持打开。本轮未领取任务。' });
            } else {
              exitState = { phase: 'login_required', authenticated: false, errorCode: 'UNAUTHENTICATED', message: '登录或账号确认已失效，同步已暂停，专用浏览器已保留。请完成登录或切回已配对账号，再点击“连接抖音”。' };
              break;
            }
          } else {
            if (result?.authenticated === true) this.#set({ authenticated: true });
            this.#set({ errorCode: undefined, message: result?.pendingReport ? '结果已保存在本机，正在等待补交；不会重新执行发送。' : result?.worked ? '任务结果已处理，可在工作台查看详情。' : '同步运行中，等待工作台任务。' });
          }
        } catch (error) {
          if (signal.aborted) break;
          const retryable = error?.code === 'NETWORK' || (error?.code === 'API_REJECTED' && (error.status === 408 || error.status === 429 || error.status >= 500));
          if (!retryable) { exitState = { phase: 'error', authenticated: false, ...this.#publicFailure(error) }; break; }
          this.#set(this.#publicFailure(error));
        }
        await this.#deps.sleep(this.#pollIntervalMs, { signal });
      }
    } catch (error) {
      if (!signal.aborted) exitState = { phase: 'error', authenticated: false, ...this.#publicFailure(error) };
    } finally {
      // Login and account recovery reuse this dedicated browser and its journal.
      // Explicit stop and permanent errors still release both resources.
      const preserveSession = RECOVERABLE_SESSION_ERRORS.has(exitState?.errorCode) && !signal.aborted && !this.#stopping;
      const released = preserveSession || await this.#release();
      this.#loopPromise = undefined; this.#runAbort = undefined;
      if (!this.#stopping) this.#set({ running: false, busy: false, ...(released ? exitState || { phase: 'stopped', authenticated: false, message: '同步已停止。' } : { phase: 'error', authenticated: false, ...this.#publicFailure({ code: 'RESOURCE_RELEASE' }) }) });
    }
  }

  async stop() {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopping = true;
    this.#actionAbort?.abort(); this.#runAbort?.abort();
    this.#set({ phase: 'stopping', busy: true, running: false, message: '正在停止并保存执行结果，请稍候。' });
    const stopping = (async () => {
      // Closing the browser interrupts a pending visible action. Keep the journal
      // locked until runOnce records submitted/unknown and finishes its cleanup.
      let released = await this.#closeBrowser();
      if (this.#actionPromise) await this.#actionPromise;
      released = await this.#closeBrowser() && released;
      if (this.#loopPromise) await this.#loopPromise;
      released = await this.#release() && released;
      this.#stopping = false; this.#stopPromise = undefined;
      this.#set({ phase: released ? 'stopped' : 'error', busy: false, running: false, authenticated: false,
        ...(released ? { errorCode: undefined, message: '同步已停止。已开始发送但无法确认的任务会保留为待核对，不会重发。' } : this.#publicFailure({ code: 'RESOURCE_RELEASE' })) });
      return this.status();
    })();
    this.#stopPromise = stopping;
    return stopping;
  }
}

export function createDesktopController(options) { return new DesktopController(options); }
