# 抖音图片消息导致回复停止：离线修复验证

日期：2026-11-08。源代码已修复；本报告不表示已经发布或恢复了正在运行的助手。

## 生产只读证据

- 原生 D1 显示目标会话仍为 active / agent，最后可靠读取为 `2026-11-08T09:13:08.329Z`，处于恢复 AI 后等待核实新消息的状态。实际接待任务为 active；另一个任务的暂停状态与此次故障无关。
- 本机日志保留的最近 200 次读取均已成功上报，但 `reliable=false`，每次都返回 21 条可解析消息，并使用同一个快照标识。日志压缩会移除消息数组，因此不能将压缩后的数组缺失解读为零条消息。
- 用户界面只读检查确认，最后一条消息为没有可读取文字标签的独立图片，出现时间与停止可靠读取的时间一致。没有把图片 URL、文件名或会话预览推断成图片内容。
- 已安装助手的 browser-adapter、conversation-transcript、bridge-core、desktop-controller 与修复前仓库内容一致，不是安装版本落后。
- 本机连接诊断显示 09:53 UTC 已恢复账号核验，此后仍在正常轮询；当前故障位于会话读取可靠性判断。

## 根因与修复

旧读取器将任何图片都视为不支持的消息，令整个稳定聊天窗口长期保持不可靠，并直接丢弃该图片行。图片之后出现普通文字也不能解除这个条件。

现在只对作者方向已经核实、内容为单独一张图片的消息保留 `contentType=image` 和固定占位文字。图片内容仍然未知，图片地址不会进入业务事实。最新消息是图片时，Agent 仅在现有接待、记忆、人工接管、停止联系、配额与外发结果保护全部通过后，确定性回复：

> 收到图片了，请用文字说一下您想了解的问题。

这条接收确认不调用回复模型或知识检索，不索取联系方式，不确认预约，不增加邀请次数，也不将更早的问题标记为已经回答。后续文字继续使用现有任务记忆与授权知识库。

同时修复恢复 AI 时的一个边界：平台没有消息时间、原始招呼又不在当前窗口时，可以用同一活动任务内已核实的新消息作为时间顺序锚点，只恢复其后的新入站消息。锚点必须是 eligible=1 的入站消息，或者接待开始后的本地已核实外发记录。未归属当前任务的记录、eligible=0 的历史基线、已处理旧末条和没有锚点的消息都不能打开该门禁。

未知作者、混合文字与媒体、多媒体、发送中或发送失败、缺失最新虚拟列表索引等情况继续暂停。

## 数据与兼容

- `0019_prospect_message_content_type.sql` 仅新增消息表的 `content_type TEXT NOT NULL DEFAULT 'text'`，已有消息保持文字类型。
- 新字段贯穿桥接校验、D1、公开会话记录和任务记忆输入。图片占位不能产生客户事实、问题、联系方式或邀请事件。
- 发布顺序应为服务器和 0019 迁移完成后，再更新本机助手。网页发布不会替换已安装助手的源码；长时间运行的进程也不会自动重新加载模块。
- 本次没有修改真实消息、账号、任务状态、发送日志或安全门禁，没有提交代码、发布、重启助手或发送真实客户消息。

## 验证

- 先观察到 6 项预期失败，覆盖图片导致全窗口不可靠、类型传递丢失、错误的通用提问和图片被当成记忆事实；随后修复转绿。
- 无时间和原始招呼的恢复场景先失败、后通过。独立复查发现历史基线锚点可能重放旧消息，新增失败用例后收紧了锚点条件。
- 最终完整测试：`PROSPECT_BROWSER_TEST=1 npm test`，**1249 通过，0 失败，0 跳过**，102.7 秒。日志：`/private/tmp/reply-recovery-1108-full-browser.log`。
- 最终类型检查、全部改动文件 ESLint、`git diff --check` 通过。
- 浏览器用例只运行隔离 fixture，图片网络请求被阻止。真实助手恢复仍需发布、更新本机程序后由普通轮询的只读证据确认。

## 连续历史快照问题与第二轮修复

第一轮最终独立复查指出一个尚未覆盖的 P2：恢复 AI 等待期间，通用 `has_baseline` 分支仍可能把没有时间证明的新增历史行写成 eligible=1。第一次读取不会解除暂停，但下一次读取可能把这条历史行当作新的可靠锚点，进而重放更多旧记录。当时 1249 项通过结果没有覆盖这个连续三次快照的场景。

第二轮将回归扩展到第三次可靠快照。修改前实际持久化的三行 eligibility 为 `[0,1,1]`，与预期 `[0,0,0]` 不符，测试按预期失败。红灯日志：`/private/tmp/reply-recovery-1108-round2-red.log`。

修复后，`RESUME_PENDING` 下的消息插入、可靠读取后的升级以及最后一条消息的恢复授权，共用同一份严格的新消息判定。普通 `has_baseline` 不再给这个阶段的未知历史行授予 eligibility。没有时间、当前招呼或更早的已证明当前任务消息作为依据时，该行以 eligible=0 持久化，后续快照不能再把它变成有效锚点。任务切换时按新的绑定时间边界判定，其他任务的已归属记录不能成为当前任务的来源证明。

第二轮只改动 `app/lib/prospecting-chat-store.ts`、`tests/prospecting-memory-integration.test.ts` 和本报告。验证命令及结果：

```sh
node --experimental-strip-types --test tests/prospecting-chat-store.test.ts tests/prospecting-memory-store.test.ts tests/prospecting-memory-integration.test.ts
npm run typecheck
npx eslint app/lib/prospecting-chat-store.ts tests/prospecting-memory-integration.test.ts
git diff --check
```

定向测试 **154 通过，0 失败，0 跳过**，包括连续三次历史快照的 eligibility、保持暂停、没有排队回复，以及原有当前消息图片恢复和任务隔离正反例。绿灯日志：`/private/tmp/reply-recovery-1108-round2-green.log`。定向 ESLint 和 diff 检查通过。

第二轮 `npm run typecheck` 已执行，但合并工作区出现本次负责范围外的三处错误：`app/api/training-voice/route.ts:16,37` 调用参数数量不匹配；`app/lib/sales-intelligence.ts:45` 的 research 来源未被目标联合类型接受。本次改动文件没有报告类型错误；这不等于整体类型检查通过。这些错误交由主代理处理，未擅自修改其他任务的文件。

上一节 1249 项完整测试属于第一轮；第二轮之后的合并完整测试和独立复查由主代理继续完成。未执行真实数据修改、发布、重启或客户发送。

## 本次负责的文件与命令

负责文件：`tools/douyin-bridge/{conversation-transcript,bridge-core}.mjs`；`app/lib/prospecting-{chat-agent,chat-store,chat-types,memory-store,memory}.ts`；`db/schema.ts`；`drizzle/0019_prospect_message_content_type.sql`、`drizzle/meta/0019_snapshot.json`、`drizzle/meta/_journal.json`；对应的 `tests/prospecting-{chat-agent,conversation-bridge,conversation-transcript,memory-integration,memory}.test.*`；本报告。其他任务的设计和计划文件未修改。

最终验证命令：

```sh
PROSPECT_BROWSER_TEST=1 npm test
npm run typecheck
npx eslint app/lib/prospecting-chat-agent.ts app/lib/prospecting-chat-store.ts app/lib/prospecting-chat-types.ts app/lib/prospecting-memory-store.ts app/lib/prospecting-memory.ts tools/douyin-bridge/conversation-transcript.mjs tools/douyin-bridge/bridge-core.mjs tests/prospecting-chat-agent.test.ts tests/prospecting-conversation-transcript.test.mjs tests/prospecting-conversation-bridge.test.mjs tests/prospecting-memory-integration.test.ts tests/prospecting-memory.test.ts db/schema.ts
git diff --check
```
