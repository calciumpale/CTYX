# 抖音收信与身份校验修复计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复普通抖音账号反复误报换号、来信数分钟未同步，并给每次人工接管提供简短原因与下一步。

**Architecture:** 保留已配对的本机浏览器和发送日志。读取会话使用同一核验标签页刷新会话身份；发送沿用原有严格本人校验，暂缺证据与明确换号分别处理。收信任务先于模型分析调度，失败短延时重试，成功同步时间与网页读取数据库时间分开。

**Tech Stack:** TypeScript / React、D1、Node、Playwright。

**Spec:** 本文中的用户要求与现场证据；沿用现有回复 Agent 与连接恢复的权限、快照及防重复发送约束。

## Global Constraints

- 普通账号暂沿用本机通道；不假设拥有企业号或官方 IM 权限。
- 不读取系统 Cookie、平台私有接口或绕过验证；不发送合成的真实客户消息。
- 发送必须保留本人、收件人、快照、租约与持久日志校验；未知发送不重发。
- 保留客户拒绝联系、人工接管、账号/租户隔离、草稿、中文输入与 36/44px 控件尺寸。
- 官网与本机 App 都完成更新，保留原配对、登录目录及发送记录。

## Evidence

- 基线全套 959 项通过。
- 本机诊断在本人信息暂缺与恢复成功之间约每分钟循环；现场浏览器仍登录原账号。
- 隔离浏览器复现：连接和读前检查成功，仅读后页面暂缺“私密作品”就抛出截图相同的 ACCOUNT_CHANGED。
- 本机日志最近 69 次读取中 39 次失败，其中 36 次属于读前或读后的身份校验；不是近期长采集任务阻塞。
- 失败也推进 last_read_at，之后完整等待 60 秒；前端 4 秒刷新仅查询数据库。

## Review Focus

- 真正换号、登录失效或验证码仍停止自动操作。
- 缓存身份不能单独授权发送，/self 别名不能认错账号。
- 多个会话公平轮询，失败会话不抢占全部机会。
- 读取异常不能覆盖客户找人工或合同/价格等原始接管原因。
- 接管解释不暴露模型提示、原始敏感信息或不可靠承诺。

### Task 1: 身份读取

Files: `tools/douyin-bridge/browser-adapter.mjs`, `tests/prospecting-sender-identity.test.mjs`.

- [ ] 增加临时读后证据缺失、同本人 /self 别名及真实换号回归，先观察失败。
- [ ] 实现读前/读后实时 DOM 核验，在原核验页刷新本人证据，不因暂缺信息跳转到 SELF / 搜索重新发现；保留严格发送校验。
- [ ] 暂缺证据返回 ACCOUNT_VERIFICATION_PENDING 与原因，明确冲突才返回 ACCOUNT_CHANGED；验证浏览器定向测试。

### Task 2: 执行器状态

Files: `tools/douyin-bridge/bridge-core.mjs`, `tests/prospecting-conversation-bridge.test.mjs`.

- [ ] 增加读取暂时待核验、明确换号与退出登录的行为测试，先观察失败。
- [ ] 上报并保存本次读取失败后，将待核验状态传到恢复控制器；明确换号不继续任务。
- [ ] 验证日志上报、暂停、恢复与未知发送防重发。

### Task 3: 调度与同步时间

Files: `app/lib/prospecting-chat-store.ts`, `app/lib/prospecting-service.ts`, relevant store/poll tests.

- [ ] 先写慢模型、短失败重试、公平轮询与人工模式仍收信的失败回归。
- [ ] 先将收信入队，保留每轮一个已有来信决策机会与拒绝联系优先；常规 30 秒，失败/不可靠结果 15 秒后重试，沿用 8 秒手动防抖。
- [ ] 失败不改变成功同步时间，公开 lastSyncedAt；保留原人工接管原因及停止联系约束。
- [ ] 验证现有串行执行、租户/账号/暂停与出站频控测试。

### Task 4: 接管原因与界面

Files: `app/lib/prospecting-chat-agent.ts`, `app/lib/prospecting-chat-types.ts`, `app/components/ProspectingConversations.tsx`, associated tests/CSS.

- [ ] 增加不同业务原因、模型/检索故障的失败测试。
- [ ] 统一简短“为什么；下一步”，只读与旧记录也能查看原因；显示实际平台同步时间。
- [ ] 验证原因、草稿、键盘、手机布局与已有界面风格。

### Task 5: 验证与发布

- [ ] 完整带浏览器测试、类型检查、构建及生产 Excel 检查。
- [ ] 独立审查整分支并修复具体问题。
- [ ] 发布现有 Site（保持访问范围），同步私有 GitHub，安全更新本机助手并现场观察。
