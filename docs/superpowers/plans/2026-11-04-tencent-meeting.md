# Tencent Meeting Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax for tracking.

**Goal:** 在375px腾讯会议侧边栏导入真实会议内容，并形成有原文证据的项目客户画像。

**Architecture:** 私有Sites页面创建成员绑定任务，本机CLI助手出站领取并读取选定录制，正文和音频经设备鉴权回传。独立存储原文，幂等关联现有项目，再触发画像与销售洞察。

**Tech Stack:** React, TypeScript, Cloudflare Workers/D1/R2, Node.js, official tmeet CLI.

**Spec:** docs/superpowers/specs/2026-11-04-tencent-meeting-design.md

## Global Constraints

- 375px窄侧边栏，保持Open Claude UI与全局无左侧装饰色条偏好。
- 不改变站点访问范围、既有API密钥或定时任务。
- 不上传腾讯会议OAuth凭证，不自动修改会议和录制分享权限。
- 会议纪要与真实转写分开，画像事实必须引用连续原文。

## Review Focus

- 跨成员/项目访问及伪造任务身份必须失败。
- 同一会议重复导入与并发编辑不得重复记录或覆盖新资料。
- 分页/媒体下载/模型部分失败必须保留真实覆盖状态。
- 未确认人物和多公司提及不自动写成已确认客户主数据。
- 私有站点嵌入和本机离线应能解释、恢复而非伪造成功。

### Task 1: 原文、任务与成员权限

- [ ] 先补任务状态、设备认证、去重和权限测试并确认失败。
- [ ] 实现独立D1存储、租约、受限服务端点、私有媒体与成员API。
- [ ] 运行相关测试，验证失效设备和重放不能写入。

### Task 2: 本机同步助手

- [ ] 测试固定argv、回包归一化、分页与音频边界。
- [ ] 实现出站领取、心跳、选定内容读取、受控媒体上传和Mac启动配置。
- [ ] 验证CLI授权状态和设备在线状态，凭证不进入源码。

### Task 3: 画像与项目关联

- [ ] 测试原文证据、纪要来源、同源幂等和不覆盖人工资料。
- [ ] 实现模型画像、原文引用校验和确定性项目关联。
- [ ] 验证模型失败原文仍保留，并触发现有客户洞察。

### Task 4: 窄屏入口与部署

- [ ] 实现会议选择、项目关联、导入进度、原文/录音和画像展示。
- [ ] 375px与桌面浏览器检查，运行完整测试、类型检查、构建。
- [ ] 发布原私有Site，连接本机助手，授权后配置并回读腾讯会议sidebar设置。
