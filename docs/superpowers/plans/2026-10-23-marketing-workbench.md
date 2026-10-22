# CTAI Marketing Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 实现可运行、持久化、可私有部署的营销多智能体试点。

**Architecture:** React 客户端通过统一业务 API 操作 D1 workspace；纯领域函数处理权限和工作流，服务端认证、版本写入、可选模型调用。客户端壳、业务视图和领域后端按文件边界并行实施。

**Tech Stack:** React / TypeScript / Vinext，D1 / Drizzle，Lucide，open-claude-ui CSS tokens。

**Spec:** docs/superpowers/specs/2026-10-23-marketing-workbench-design.md

## Global Constraints
- 领域专家严格为客户洞察、策略方案、商机预测、商务风控、培训带练。
- 管理者本人确认后 Skill 才能发布；服务端拒绝销售审核，候选不参与检索。
- 原面试与交接文件保持原位，不上传；新站仅包含合成样例业务数据。
- 模型密钥不进入浏览器。未配置模型时明确演示模式，规则分数不冒充成交概率。
- CDS tokens，CJK 输入保护，浅深主题，响应式与 reduced-motion。

## Review Focus
- 销售绕过按钮直接审核 → 服务端拒绝。
- 两个标签页修改同一版本 → 陈旧写入返回409。
- 退回或未审核 Skill → 检索永不引用。
- 无出口/循环工作流 → 保存可草稿，发布/运行必须拒绝。
- 手机打开抽屉、表格、输入框 → 关键动作可触达且无横向溢出。

### Task 1: 持久化业务与 Agent 运行 API
**Files:** app/lib/server.ts, app/lib/domain.ts, app/lib/seed.ts, app/api/workbench/route.ts, db/schema.ts, tests/domain.test.ts
**Interfaces:** app/lib/types.ts 与 API_CONTRACT.md 为唯一接口约定。
- [x] 先写并运行权限/版本/知识过滤/工作流验证失败测试。
- [x] 实现纯领域逻辑、认证身份隔离、D1 存储与可选模型 API。
- [x] 运行领域测试并生成 schema-only migration；禁止运行时建表。

### Task 2: 视觉壳、首页、商机与聊天
**Files:** app/components/Workbench.tsx, app/components/CoreViews.tsx, app/globals.css, app/lib/use-chat-scroll.ts
- [x] 按合同消费状态，构建双角色、导航、搜索、主题和主工作台。
- [x] 实现商机详情、备注与阶段确认，以及有轨迹和引用的聊天。
- [x] 确认中文 Enter 不误发，刷新后记录由后端恢复。

### Task 3: 培训、知识/Skill、工作流与运行详情
**Files:** app/components/StudioViews.tsx, app/components/studio.css
- [x] 实现持久化带练、知识导入、经理审核、工作流编辑保存测试发布和运行详情。
- [x] 所有按钮有真实动作与错误/加载/空状态。

### Task 4: 集成、验证、部署
**Files:** app/page.tsx, app/layout.tsx, app/lib/api.ts, README.md, scripts/check-tokens.mjs
- [x] 类型检查、token 检查、领域测试、数据库迁移、构建。
- [x] 桌面移动浅深主题和主要闭环浏览器 QA；修复已观察问题。
- [x] 私有部署成功，已请求在应用中打开验证后的地址，交付运行方式与真实接入边界。
