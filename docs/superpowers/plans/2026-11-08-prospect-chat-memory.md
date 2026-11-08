# 任务内对话记忆 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按任务隔离客户记忆，让机器人记住、修正并引用需求和接待进度，保留既有发送保护，同时修复获客页面的整页滚动。

**Architecture:** 保留平台 conversation ID 与 journal；新增 task session、消息归属和带来源的记忆状态。平台会话只有一个活动任务，人工／停联／未知发送保持平台级控制；模型先理解新需求，再检索并回复。

**Tech Stack:** React/TypeScript、D1/Drizzle、现有模型连接、Node test、隔离 Playwright。

**Spec:** docs/superpowers/specs/2026-11-08-prospect-chat-memory-design.md。用户已确认实施；另要求灰色任务导航和主工作区固定一屏，仅内部滚动。

## Global Constraints

- 每个获客任务单独记忆；平台 thread 按 owner+sender+recipient 唯一，session 按 thread+campaign 唯一；不重建旧 ID、job 或 journal。
- 同一平台会话最多一个活动自动接待任务。人工接管、停止联系、running/unknown 外发保护不因切任务解除。
- sourceWatermark 与回复 processed 独立；只有可靠已归属消息可进入记忆。读取／回填不回放旧回复。
- 已提交不等于送达／已读；保留旧拒绝和保守邀请预算，不能因迁移或降级再次主动索取。
- 近期最多20条且6000字符、旧消息最多5段、摘要1000字符、记忆与消息合计9000字符；超出关键预算明确降级。
- 客户事实、业务证据、外发提交／人工确认／系统回执分开；原始联系方式不进入模型边界。
- 一般需求30天未确认标 stale，不删除；相对日期按原始消息时间和Asia/Shanghai解析。
- 保持中性灰和36/44px控件，不使用装饰性左侧色条。已授权持续完成、验证、同步GitHub并发布现有Site，无需再次确认执行方式。

## Review Focus

1. 任务A的未处理旧消息或留资池记录不会在切到B后被重放、被当成B的记忆。
2. 新消息／人工纠正／任务切换发生在模型返回前，旧结果不能覆盖或排队。
3. queued→failed→retry→submitted 与重读同文，不能多计邀请或虚构已送达。
4. 人工接管期间记忆继续吸收，切任务保留人工锁，恢复AI前使用最新可靠水位。
5. 长记录、短视口、展开设置时，外层两栏固定，列表与聊天内容滚动且输入框可达。

---

### Task 1: 记忆领域模型与回复调用

**Files:** Create `app/lib/prospecting-memory-types.ts`, `app/lib/prospecting-memory.ts`, `tests/prospecting-memory.test.ts`; Modify `prospecting-chat-types.ts`, `prospecting-chat-policy.ts`, `prospecting-chat-agent.ts`, `tests/prospecting-chat-agent.test.ts`.

**Interfaces:**
- `TaskMemoryMessage`: ProspectChatMessage plus optional `rowOrder:number`。
- `TaskMemoryFact`: id/key/value/status/sourceMessageId/sourceText/actor/sourceAt/updatedAt/supersedes?；status confirmed/tentative/retracted/superseded/stale/ignored。
- `TaskMemoryState`: schemaVersion:2, facts, events, ignoredSourceIds, sourceWatermark, summary, updatedAt, contact:{captured,declined,submittedInvites,legacyInvites,pendingInvites,uncertainInvites}。
- `TaskMemoryView`: sessionId/campaignId/activeCampaignId/activeCampaignName?/isActive/sessionVersion/bindingVersion/ready/state。
- Pure exports `emptyTaskMemory(legacy?)`, `advanceTaskMemory(state,messages,{now,timeZone?})`, `projectTaskMemory(state,now?)`, `taskMemoryContext(state,messages,query,now)`, `editTaskMemory(state,{factId,operation,value?,actorId,now})`。
- Async export `understandTaskMemory(state,messages,{now,timeZone?},generate?)` validates source-grounded semantic candidates before apply; does not write D1。
- Optional input `conversation.taskMemory:TaskMemoryView`, `now:string`； decision `taskMemoryState?:TaskMemoryState`。兼容没有新记忆的旧测试／输入。

- [ ] 写失败回归：预算改8000/换萧山、撤销业态、附加条件跨12条、客户事实复述、第三方信息不入本人事实、相对日期不漂移、源ID幂等、提交状态计数、ignore后不被摘要／历史复活。
- [ ] 运行专项记录红；实现带来源事实与事件、确定性投影/摘要/上下文、可选一次结构化语义理解及严格来源校验。
- [ ] 回复查询使用更新后的需求；客户事实可以引用，业务事实仍受原有知识证据限制；保留停联/人工/敏感/留资文案保护。自然接待优先回答本轮问题。
- [ ] 同一任务记忆更正和旧值替代有版本；金额单位不明保留tentative；人工确认与系统回执不混淆。
- [ ] 专项与typecheck通过，写task-1-report，交根代理集成／审查；不提交共享文件、不部署。

### Task 2: 任务接待与记忆持久化

**Files:** Create `app/lib/prospecting-memory-store.ts`, `tests/prospecting-memory-store.test.ts`; Modify `db/schema.ts`, new additive Drizzle migration/meta. Own no existing chat-store/service files.

**Interfaces:** `createProspectMemoryStore(db,now=Date.now)`:
- `getView(ownerId,memberId,threadId,campaignId?) => Promise<TaskMemoryView>`：合法任务和成员守卫，惰性建立旧任务session与旧历史归属。
- `messages(ownerId,memberId,sessionId,limit=40) => Promise<TaskMemoryMessage[]>`：仅当前任务；含rowOrder，过滤或脱敏被ignore的来源。
- `absorb(ownerId,memberId,threadId,remember?) => Promise<boolean>`：有界处理新消息和外发状态；remember签名 `(state,messages,{now,timeZone}) => Promise<TaskMemoryState>`。每次40条新历史，可补最近外发状态；独立水位和CAS，失败保留待处理。
- `attributeMessage(messageId,view,guard,values) => D1PreparedStatement`：供root加入可靠读完成的原事务，来源、活动绑定和guard全部满足才归属，不能后补猜测。
- `saveState(ownerId,memberId,view,nextState) => Promise<boolean>`：校验session/binding版本，更新事实/事件/快照，幂等。
- `mutate(ownerId,memberId,threadId,campaignId,sessionVersion,bindingVersion,change) => Promise<TaskMemoryView>`：correct/retract/ignore，有审计，取消旧queued/waiting并使正在生成结果失效。
- `switchTask(ownerId,memberId,threadId,targetCampaignId,threadVersion,bindingVersion) => Promise<TaskMemoryView>`：原子切绑定与现有conversation的活动campaign指针；阻止running/unknown，取消旧队列，清旧snapshot，保留mode/handoff/stop。
- `sessions(ownerId,memberId,threadId) => Promise<...>`：当前合法成员可选任务列表／关联状态，跨成员不泄露任务内容。

- [ ] 写真实SQLite失败回归：旧会话id兼容、同客户A/B独立、消息归属、切换与unknown/人工锁、source版本CAS、并发回填、保留旧拒绝/邀请预算、ignore幂等不复活。
- [ ] 添加sessions/bindings/message attribution/事实事件持久化；快照可存在session JSON，历史事件有界读取，DDL只增不删。
- [ ] 旧campaign建立初始session，旧池留资只关联原session；其他任务不继承。回填不改eligible/processed/额度，拒绝和旧预算单列保守保留。
- [ ] 运行专项红绿、Drizzle生成／SQLite DDL、typecheck，写task-2-report并发送最终API契约；不提交共享文件、不部署。

### Task 3: 平台会话与服务接入

**Files:** Modify `prospecting-chat-store.ts`, `prospecting-service.ts`, `prospecting-runtime.ts`, existing chat-store/service/store tests；新增 `tests/prospecting-memory-integration.test.ts`。

**Interfaces:** 消费Task1/2。service deps新增可选`rememberChat(ownerId,origin,state,messages,options)`；chat API新增`chatMemoryEdit`与`chatSwitchTask`，请求携带conversationId/campaignId/sessionVersion/bindingVersion及edit或targetCampaignId；snapshot.conversations[].taskMemory 与可选tasks；原conversationId不变。

- [ ] 在现有SQLite夹具加入新DDL；先写API/集成失败回归，保留旧1144项行为基线。
- [ ] materialize/snapshot初始化旧session；读取会话以session所属任务筛选，平台thread仍唯一。read/reply job metadata附sessionId/bindingVersion，旧job仅可映射原session，错绑不能继续。
- [ ] reliable read事务写入消息归属；不可靠读不吸收。processOne仅处理活动session的pending；history/留资判断按session，取消旧pending不能变成新任务消息。
- [ ] 轮询有界吸收记忆，人工模式也能吸收；generation前完成相关新水位。新版本/手工纠正导致CAS失败时不持久化旧回复。
- [ ] reply提交回调更新提交事件；不按draft增加正式计数；新taskMemoryState与legacy投影保存于同一有效版本，capture只关联当前session。
- [ ] 实现API鉴权、CSRF、版本冲突与明确错误；runtime记忆理解使用现有模型连接，16秒内单次提取与回复分配总预算，保持bridge45秒预算和消息任务优先。
- [ ] 回填/切任务/人工恢复/禁用成员/账号变化专项通过，形成root集成报告并独立审查。

### Task 4: 本任务记忆与纠错界面

**Files:** Create `app/components/ProspectingMemory.tsx`, `app/components/prospecting-memory.css`, `tests/prospecting-memory-ui.test.mjs`; Modify `ProspectingConversations.tsx` only required integration.

**Interfaces:** 消费TaskMemoryView与Task3 API；字段correct/retract/ignore需带session/binding版本。任务切换与恢复AI为独立操作。

- [ ] 隔离浏览器回归：事实/来源/待确认、纠正及失败保存、轮询不覆盖编辑、ignore、任务切换仍人工、邀请已提交与待核对文案。
- [ ] 扩展原客户需求为本任务记忆，显示需求/附加条件/未解决问题/下一步，来源消息跳转和变更历史。错误不清草稿，忙碌禁用，版本冲突提示刷新。
- [ ] 专项/typecheck/token/diff通过，独立审查；保持既有36/44px中性灰。

### Task 5: 固定外层两栏、内部滚动

**Files:** Shell CSS、必要最小Workbench.tsx class调整、prospecting-workspace.css/prospecting-conversations.css布局选择器；新`tests/prospecting-fixed-panes.test.mjs`。不与Task4改同一组件。

- [ ] 复现用户截图的高度/overflow链，隔离浏览器几何回归先红。
- [ ] 桌面高度跟随动态视口、flex/grid子项min-height:0，二级导航和主工作区外框不滚出一屏；超长列表／聊天／展开设置只内部滚动，输入框可达。
- [ ] 验证桌面短视口及移动端，保存必要截图/几何结果；不改变其他业务页的正常滚动。

### Task 6: 最终验证与发布

**Files:** package.json test list、操作文档／验证记录、现有Site source checkout。

- [ ] 新测试加入显式test列表；`PROSPECT_BROWSER_TEST=1 npm test`、typecheck、lint、tokens、diff、生产构建全部完成。
- [ ] 最有能力的独立审查覆盖整个分支；修复重要问题并窄范围复核。
- [ ] 检查数据库增量迁移与旧历史不重放；不向真实客户发测试私信。
- [ ] 将相同源码同步现有私有GitHub main与Site；保存现有访问范围、env与v1.2.1标签，部署后读取无PII诊断／实际助手观察记录确认健康。
- [ ] 提供线上版本、记忆入口、实际验证范围与任何具体限制。
