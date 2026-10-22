# CTAI · 营销多智能体工作台

采用 open-claude-ui 的暖灰、陶土色和轻量排版，实现销售与销售管理者双视角的全栈试点。数据由服务端保存，刷新后可继续工作。

## 已实现的业务

- 主 Agent 识别意图，调度客户洞察、策略方案、商机预测、商务风控、培训带练五个领域专家；展示执行过程与引用。
- 商机台账支持检索、详情、备注、阶段变更确认和 CSV 导出。
- 优秀案例可提炼为待审核 Skill；管理者确认后发布，待审核与退回内容不进入检索。
- 培训带练支持多轮对话、结束评价和历史记录。
- 知识库支持文本资料导入，搭建中心支持节点配置、连接、保存、测试与发布；运行记录保留轨迹。
- 浅色与深色主题、响应式布局、中文输入法保护和减少动态效果偏好。

## 本地运行

需要 Node.js >=22.13.0。首次执行：

```sh
npm run install:ci
npm run build
```

将 drizzle/ 下尚未执行的 SQL 迁移按文件顺序应用到本地数据库。将下方文件名替换为实际生成的迁移：

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_glossy_scream.sql
npm run dev
```

打开终端打印的本地地址（默认 http://localhost:5173）。本地登录通过 /signin-with-chatgpt?return_to=/ 模拟身份；线上由 Sites 平台认证。数据库保存在忽略提交的 .wrangler/state/，不要重复执行已应用的迁移。修改数据库结构后运行 npm run db:generate。

```sh
npm run typecheck
npm run check:tokens
npm test
npm run build
```

## 数据与权限边界

首次使用初始化合成示例数据，不包含真实企业客户。商机健康度和演示模式的带练分数来自规则，不能当成经过校准的成交概率。示例成功案例用于演示 Skill 流程，不证明话术带来的因果转化提升。

每个 Sites 登录用户的数据按用户 ID 隔离。界面的销售/管理者切换用于体验产品流程；服务端按当前体验角色校验操作。正式企业版本需要将角色改为不可由用户自行选择的组织授权，并接入企业 SSO、部门与数据范围、CRM、审计留存、备份和服务等级保障。

业务写入使用版本检查，过期更新返回 409，避免覆盖其他会话的修改。Skill 审核、工作流发布等操作在服务端检查权限。工作流发布和运行校验节点类型、连通性和循环；人工审核节点暂停执行，不能自动审批。

## 接入真实模型

未配置模型时，界面明确显示演示模式，并用规则生成演示答案和训练反馈。可在服务端配置兼容的模型接口：

- MODEL_API_KEY：服务端密钥。
- MODEL_BASE_URL：兼容接口的基础地址。
- MODEL_NAME：模型标识。

参考 .env.example，本地配置放在忽略提交的 .dev.vars，线上通过托管平台的服务端环境配置。不要把密钥放到浏览器、源码或 Git。实际模型连接状态以设置页为准。

## 技术结构与部署

React / TypeScript / Vinext + Cloudflare Worker + D1 / Drizzle。统一业务 API 位于 app/api/workbench/route.ts，共享契约位于 API_CONTRACT.md，核心领域规则位于 app/lib/domain.ts。

.openai/hosting.json 声明 Sites 项目与 DB 绑定。通过 Sites 发布流程构建、提交源代码、打包并私有部署，线上部署应用数据库迁移。npm start 只预览构建结果，不会部署。

用户故事与设计约束见 PRODUCT.md、DESIGN.md，实现计划与验证目标见 docs/superpowers/。开发缓存、凭证和构建产物保持忽略，不上传原工作空间的面试资料。
