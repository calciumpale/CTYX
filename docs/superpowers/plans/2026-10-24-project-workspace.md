# Project Workspace Implementation Plan

> **For agentic workers:** Use subagent-driven-development for bounded independent file ownership. Sites owns source preparation and publication.

**Goal:** 通用项目中心，显式创建/跟进入口，以及有来源的企业画像补全。
**Architecture:** 兼容扩展 Deal，复用版本/权限/R2存储；独立 QCC 设置和研究模块，原模型设置保持可用。
**Tech Stack:** React, TypeScript, Vinext, Cloudflare D1/R2.
**Spec:** docs/superpowers/specs/2026-10-24-project-workspace-design.md

## Global Constraints
- 不改写旧业务记录；无左侧装饰色条，保留 CDS 明暗主题。
- 凭证只在服务端加密保存；来源无内容时不编造企业事实。
- 同一 Sites project_id 私有发布；保持现有语音服务和环境变量。

## Review Focus
- 新建同企业的不同项目稳定区分，旧记录兼容展示。
- 新项目的销售归属与跨角色读取不越权。
- 外部失败/版本冲突不覆盖人工画像和旧补全结果。
- 企查查配置不泄露或影响现有模型密钥。
- 手机可从项目列表进入详情/跟进并正常返回。

### Task 1: Domain
- [x] 添加类型、deal_create/update/enrich 和必要测试，先验证新增行为失败再实现。
- [x] 客户洞察读取项目及已补全来源，通用默认话术去除行业硬绑定。

### Task 2: Project UI
- [x] 新建 ProjectWorkspace 和样式，复用上传/播放器，明确创建和跟进按钮。
- [x] 详情含客户画像、企业来源、文字/录音跟进及关联 Agent 结果。

### Task 3: Company research and settings
- [x] 核验官方 QCC 接口，真实检索 fallback、约束模型输出和来源、失败保持原记录。
- [x] 复用现有连接表的独立 kind=qcc 行、AES-GCM 和 CAS；设置独立入口。

### Task 4: Integration and delivery
- [x] 移除通用导航/首页的招商硬绑定，接入新项目中心和 QCC 配置。
- [x] 单次批量浏览器验收桌面/手机/主题/创建/跟进；修复观察到的问题并确认。
- [ ] 测试/typecheck/tokens/detector/build 后通过原 Sites helper 发布。

## Verification record

- 新建项目、文字记录、手工画像、真实公开检索10来源、录音上传/回听、手机返回与主题已验证。
- Worker不支持redirect error，改manual且拒绝3xx，Miniflare和真实页面均通过。
- 本轮创建的项目、运行、活动和录音已定向清理，原记录保留。
- 独立审查未发现阻断安全问题；同名项目的显式ID选择补充回归测试。
