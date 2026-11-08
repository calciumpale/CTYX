# 每日竞品与线索发现 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 提供北京时间每日可配置的发现与采集，在保留用户选择和历史状态的前提下展示真实新增账号、评论和客户。

**Architecture:** 复用 Cloudflare D1、bridge poll 和 discover/collect 队列。campaign JSON 保存计划；新轮次表提供日期唯一键与统计。浏览器按关键词/少量视频分片，消息任务优先；前端仅设置计划和读取进度。

**Tech Stack:** 既有 React/TypeScript、D1/Drizzle、Node/Playwright。

**Spec:** docs/superpowers/specs/2026-11-08-daily-prospect-discovery-design.md。用户已选择新发现账号自动采集。

## Global Constraints

- 默认每日 09:00、Asia/Shanghai，时间可改；存量未配置任务默认关闭，启用后才执行。
- 新发现账号与已选账号都纳入自动采集；主动取消的历史账号不因再次发现重新勾选。
- 离线只补最近一轮；修改计划只影响未来；同日期轮次数据库唯一，禁止重复上报重复扩容。
- 保留账号、租户/成员、配额、租约、消息快照、人工接管、停止联系和未知发送约束。
- 界面沿用紧凑中性灰、36/44px 控件规范，不使用装饰性左侧强调色条。

## Review Focus

1. 连续私信读取时每日任务仍有有界执行机会，采集不会长时间占住回复。
2. 相对时间变化、旧 dom ID 与新 ID 共存时评论不重复，已发送/审核状态不重置。
3. 并发轮询、重复完成和重启只形成一个每日轮次及一组子任务。
4. 已有超过 300 条的任务仍能保存新增，分页与本轮筛选能看到它们。
5. 修改/暂停/禁用成员与设备后旧排队轮次不可继续扩大采集。

### Task 1: 只读诊断与本次未回复根因

**Files:** prospecting-service.ts、prospecting-store.ts、prospecting-chat-store.ts 及对应 tests。

- [ ] 为 status diagnostics=true 添加设备鉴权、零写入和有界数据回归，先红后绿。
- [ ] 上线只读诊断，读取现场 mode/eligibility/policy/job 状态，形成具体根因。
- [ ] 针对实证根因补失败回归、修复并复测；不以测试通过代替现场发送状态验证。

### Task 2: 每日轮次与增量后端

**Files:** app/lib/prospecting-discovery.ts（新）、prospecting-types.ts、prospecting-domain.ts、prospecting-store.ts、prospecting-service.ts、db/schema.ts、drizzle/0014_* 及 prospecting tests。

**Interfaces:**

- campaign.dailyDiscovery: `{enabled,time,timeZone:'Asia/Shanghai',includeNewCandidates:true,nextRunAt?}`。
- snapshot.discoveryRuns: `ProspectDiscoveryRun[]`；snapshot.leadPagination: `{page,pageSize,total}`；lead.firstSeenAt/firstRunId，candidate.firstSeenAt/firstRunId。
- Run 字段：id、trigger daily/manual、scheduledFor、status queued/discovering/collecting/completed/partial/failed/cancelled、startedAt/finishedAt、discoveredAccounts/newAccounts/readComments/newComments/newLeads、pendingJobs/completedJobs/totalJobs、error。
- POST actions `discoverySchedule`（dailyDiscovery）、`selectCandidates`（candidateIds）、`discoveryRun`（立即完整执行一轮）。保留原 discover/collect 操作。
- GET query `leadPage`（从1开始，每页30）、`runId`（可选本轮筛选）；POST response 兼容原 snapshot，并携带新增字段。

- [ ] 写计划时间、跨日补跑、并发幂等、候选合并保留取消选择、容量>300/分页/统计、任务撤销及队列公平性失败回归。
- [ ] 新增轮次持久化，记录每条线索 first_seen_at/first_run_id；按实际 INSERT 与唯一客户统计新增。
- [ ] 持久化选择；完成发现按已选+真正新账号创建小采集片段（1–3视频），新视频在前，旧视频轮转。
- [ ] bridge 验证身份后、chat 早退前只安排到期项；明确消息优先与后台有界公平规则，状态显示延后。
- [ ] 所有专项先绿；DDL 使用新迁移，更新真实 SQLite 夹具与 Drizzle 元数据。

### Task 3: 稳定浏览器评论身份

**Files:** tools/douyin-bridge/browser-adapter.mjs、tests/prospecting-bridge.test.mjs。

- [ ] 写跨天相对时间变化的真实 DOM 采集回归，证明旧实现重复 ID。
- [ ] 原生 ID 优先；DOM 后备哈希剔除相对时间，可信绝对时间可保留；后端按稳定 video+author+text 兼容旧 dom 数据，保守去重且不影响原生不同 ID。
- [ ] 验证源代码、CLI包和已安装助手一致。

### Task 4: 设置、进度与新增展示

**Files:** ProspectingWorkspace.tsx、prospecting-workspace.css、ProspectingDailyDiscovery.tsx（可新建）及组件测试。

- [ ] 覆盖输入时间有效性、忙碌禁用、4秒轮询不覆盖编辑、开关保存、选项持久化和新增筛选分页行为。
- [ ] 在线索筛选顶部显示每日开关、时间、下次时间、立即运行和最近轮次统计；可查看失败/延后原因。
- [ ] 新账号/评论有本轮标记，线索页能切本轮新增并分页；不把相同客户的多条评论都称作新增客户。
- [ ] 运行专项、全套带浏览器测试、typecheck/token/diff、生产构建；独立审查后更新本机助手、GitHub和保持当前访问范围的 Site。
