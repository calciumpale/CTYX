# 抖音评论获客本地执行器

工作台保存需求、候选账号、评论和审核结果；这个独立 Node.js 程序在本机可见浏览器中执行搜索、采集和审核后私信。它只读取页面 DOM、点击可见按钮，不读取系统浏览器 Cookie、不调用逆向私有接口，也不捆绑 MediaCrawler 或 douyin-cli。

## Mac 桌面助手

本机安装版提供“抖音获客助手.app”，内置 Node.js、Playwright 和 Chromium。用户双击桌面快捷方式即可打开，无需终端命令。

首次使用：

1. 在工作台展开“连接你的抖音账号”，创建配对并下载配置。
2. 在助手中点击“读取下载的配对配置”；也可通过“选择配置文件”导入下载的 JSON。
3. 点击“连接抖音”。浏览器提示登录时，在浏览器中完成扫码。首次绑定按提示确认当前账号。

日常使用点击“连接抖音”即可。助手复用本次已打开的专用窗口和本机保存的登录状态，核实原绑定账号后开始同步。工作台连接正常只表示助手能与工作台保持联系，当前抖音账号核验通过后才会执行任务。

短暂核验失败会保留浏览器和本地执行记录，自动恢复最多 2 轮，自动轮次之间至少间隔 60 秒；用尽后显示“需要重新核验账号”。点击“重新核验账号”会复用原身份核验标签，不进入聊天页，不要求先停止助手。后台联系、空闲检查和被动核验不打开标签、不刷新或切换页面。登录失效、安全验证和账号变化需要本人在原抖音窗口完成登录、验证或切回已配对账号，再点击连接或重新核验；助手不会自动处理这些确认。

“连接诊断”默认收起，只显示最近与工作台联系、最近账号核验时间。仅含固定状态字段的详细诊断保存在本机 `~/.config/marketing-workbench/diagnostics/connection-events.json`，不会自动上传。关闭窗口会停止本实例。配对和登录状态保存在本机。私站访问凭证由安装者单独保存于 `~/.config/marketing-workbench/douyin-service-access.json`，权限为 `0600`，不包含在应用包中。

已安装的 `.app` 不会随工作台网页发布自动更新。更新桌面助手前先退出旧版，再由维护者使用最新源码运行 `node scripts/install-douyin-mac.mjs` 重新安装；配置、专用 profile 和发送记录位于应用包外，会保留。网页下载的 ZIP 是命令行版，不能替换已安装 `.app` 的内部脚本；旧 `.command` 启动方式也不会自动更新它所引用的旧脚本。

应用启动时读取 macOS 为工作台配置的静态 HTTP/HTTPS 代理，不修改系统网络设置；本机控制面板不经过代理。PAC、SOCKS 或需要代理账号密码的配置会给出明确提示。修改系统代理后需要重新打开助手。

维护者可在已安装工具依赖和 Chromium 的 Apple Silicon Mac 上执行 `node scripts/install-douyin-mac.mjs`，生成用户应用目录中的应用及桌面快捷方式。安装器会验证 Node 支持 `--use-env-proxy`。这是本机签名安装版，尚未制作对外分发的公证 DMG。

## 命令行安装与配对

需要 Node.js 22.13+。在项目根目录运行（所有 npm 依赖安装在本工具目录，不安装全局软件）：

```sh
npm ci --prefix tools/douyin-bridge
node tools/douyin-bridge/node_modules/playwright/cli.js install chromium
```

在工作台“评论获客”中配对本机设备并下载配置。配置格式如下；真实凭证不要放进命令行、聊天、仓库或截图。

```json
{
  "origin": "https://你的工作台域名",
  "deviceId": "工作台签发的设备ID",
  "deviceToken": "工作台签发的设备凭证"
}
```

私站如需额外网关认证，可增加 `sitesToken`（原始凭证，不带 `Bearer `）。`cdpUrl` 可选；只有显式配置本机回环 CDP 地址时才连接现有浏览器。默认使用自己专用的持久 Chromium profile，完全不读取日常浏览器配置。

```sh
node tools/douyin-bridge/bridge.mjs setup --input ~/Downloads/douyin-bridge.json
node tools/douyin-bridge/bridge.mjs login
node tools/douyin-bridge/bridge.mjs doctor
node tools/douyin-bridge/bridge.mjs run
```

`setup --input -` 从标准输入读取 JSON；`--config /绝对路径/config.json` 可以指定保存位置。配置强制 0600、检查当前所有者并拒绝符号链接。默认位于 `~/.config/marketing-workbench/douyin-bridge.json`。配对下载文件也包含凭证，请妥善存储，完成配置后可自行删除下载副本。

`doctor` 只检查本机配对和待补交记录，不启动浏览器、不连接抖音、不核实实时登录，输出 `loginChecked: false`。实时账号状态在显式连接和运行期间核实；被动检查不触发页面导航。

`login` 会打开可见专用浏览器，让你亲自扫码，确认账号后按 Enter。它不会绕过验证码。登录后如果页面没有可确认的个人主页链接，请打开右上角个人主页菜单。只有能从可见主页链接确认账号才报告已登录；遇到页面改版宁可暂停，也不会猜测当前账号。

`run` 保持浏览器和终端运行，每 5 秒拉取任务；`run --once` 只拉取一次。Ctrl+C 停止。不要同时启动多个执行器。账号改变时停止发信，需要重新运行 `login` 明确确认。

## 实际能力和边界

- 首次连接或用户明确重新启动已关闭的浏览器时，仍需打开独立的专用 Chromium 窗口，供本人扫码或完成安全验证。当前 Mac 应用内的 WKWebView 只承载本机控制台，不能嵌入并复用 Playwright 的 Chromium 会话。不会接管日常浏览器或读取其 Cookie；发送前仍重新核验本人身份与目标会话。执行用户已提交的采集/会话任务会按任务切换专用任务页，空闲检查不切页。
- 搜索优先使用工作台给出的关键词；没有时从需求按句拆出最多 5 个搜索词。只返回搜索页面里真实存在的作者主页及同卡片的视频，最多 20 个账号、每账号 10 个已发现视频。“搜索相关”不等于已认定竞品，仍需业务筛选。
- 采集只打开任务指定的视频，最多 50 条/视频、300 条/任务，不遍历作者全部作品。每条正文最多 2000 字符，上传结果按实际 UTF-8 字节限制在 1.45 MB 内；达到上限会减少本次上传条数并附明确警告，不声称完整采集。保留来源视频、昵称和公开主页；缺少主页的评论可分析但不能发信。
- 私信必须能核对发送账号、目标主页与会话中的目标主页链接，且有唯一消息框/发送按钮。遇到不支持的 DOM、私信权限限制或验证码，返回明确失败供人工恢复。
- 发送前先持久化日志、续期租约，随后只点击一次。观察到会话里新增同文消息才报告 `submitted`（已提交），不声称送达或已读。未观察到、页面关闭、网络断开等均为 `unknown`（待核对）。
- 私信失败后可在工作台原评论手动重试。结果待核对时，助手先检查原会话中是否已有同文消息，并确认已加载上次发送时段的记录。每次重试沿用原文案，保留旧执行记录并遵守发送间隔和每日上限。
- 在获客任务的「聊天获客」开启智能体后，助手会同步已联系客户的抖音会话。保持助手和已确认的抖音账号在线。聊天记录的首轮同步用来建立基线，避免对旧消息重复回复。
- 人工接管和后续回复都使用同一个聊天框。助手提交前会复核账号、会话和最新消息，避免在新来信或人工已经回复后发送过期文案。
- 上报失败只重试结果上报，不重新执行浏览器动作。日志保存在配置目录的 `douyin-bridge-state/<配对摘要>/journal.json`（0600），包含读取结果与必要审计状态。不同工作台/设备的配对分别保存，不能混用。**不要删除日志以尝试重发未知任务**，先查看原会话。
- 页面结构会变化，当前实现的选择器不是抖音官方契约。提供了本地浏览器 fixture 测试；未用真实陌生人验证发信，也不保证账号可发私信。不能核实的步骤会明确停止。

## 接口

请求一律使用 HTTPS（仅 localhost 调试允许 HTTP），拒绝重定向。设备 token 通过 `Authorization: Bearer ...`，可选私站凭证通过 `OAI-Sites-Authorization: Bearer ...`，均不会传给抖音。

| 接口 | 请求 | 行为 |
|---|---|---|
| `POST /api/prospecting-bridge/poll` | `deviceId, authenticated, accountId, accountName, message?, conversationVersion?` | 返回 `job` 或 `null`。支持会话同步与后续回复的助手上报 `conversationVersion: 1` |
| `POST /api/prospecting-bridge/status` | `deviceId` | 后台更新设备最近联系时间；不改变账号核验状态、不领取或续期任务 |
| `POST /api/prospecting-bridge/heartbeat` | `deviceId, jobId, leaseToken` | 每 30 秒续期；点击发送前再次确认 `ok: true` |
| `POST /api/prospecting-bridge/complete` | `deviceId, jobId, leaseToken, result` 或 `error` | 失败时保留本地结果待补交 |

后台联系使用新增的 `status` 接口，需要同步更新工作台网页端。原有轮询、任务续期和结果上报接口继续保留，旧版助手仍可连接；工作台最近联系时间和抖音账号核验状态分别显示，不能互相替代。

结果字段与 `app/lib/prospecting-types.ts` 一致。收到重复任务不会重新执行，最多重新提交已保存结果。400/404/405/409/410/413/415/422 等明确永久拒绝记录 `reportRejected` 与 HTTP 状态、时间和本地结果证据，停止重复上报并放行后续任务；不会重新执行该任务。断网、429 限流、服务端暂时错误仍只重试结果上报。401/403 需检查设备或私站凭证，不能靠重新发消息解决。

## MediaCrawler 导出兼容

`bridge-core.mjs` 导出 `normalizeMediaCrawler(text)`，支持现有 JSON 数组和 JSONL，最多规范化 300 条。它不会安装或调用 MediaCrawler。**所有 MediaCrawler 导入均仅供分析、不可私信**，包括旧文件中已有 UID 或公开主页的情况；导入过程会忽略联系身份。MediaCrawler 为非商业学习许可证，商用需版权所有者书面许可。

## 验证

```sh
# 核心状态、配置、持久化和恢复测试，无浏览器
node --test tests/prospecting-bridge.test.mjs

# 含真实 Chromium + 本地拦截 fixture 的 DOM/单次发送/未知状态测试
npm test --prefix tools/douyin-bridge
```

fixture 浏览器的所有抖音页面请求都由测试内存页面响应，其他域名被阻止。测试不登录、不读取真实账号、不实际发信。
