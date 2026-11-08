---
name: AI营销工作台
description: 深炭灰导航与浅灰白分栏的紧凑销售工作台
colors:
  primary: "#25272a"
  primary-hover: "#34393f"
  surface: "#fff"
  sidebar: "#242628"
  text: "#25272a"
  text-secondary: "#61666e"
  text-muted: "#61666e"
  border: "#e1e4e8"
  border-strong: "#c8cdd4"
  hover: "#eceff2"
  selected: "#e4e7eb"
  danger: "#bf3545"
  success: "#287c52"
  warning: "#9a650c"
  dark-primary: "#eef1f5"
  dark-primary-hover: "#d4dce6"
  dark-surface: "#1d2126"
  dark-sidebar: "#171a1e"
  dark-text: "#f0f3f7"
  dark-text-secondary: "#bac2ce"
  dark-text-muted: "#a3adba"
  dark-border: "#363e48"
  dark-border-strong: "#505b68"
  dark-hover: "#2d343d"
  dark-selected: "#363e48"
  dark-danger: "#f07888"
  dark-success: "#72bd94"
  dark-warning: "#d8b264"
typography:
  headline:
    fontFamily: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif
    fontSize: 24px
    fontWeight: 550
    lineHeight: 1.4
    letterSpacing: "-0.7px"
  title:
    fontFamily: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif
    fontSize: 14px
    fontWeight: 550
    lineHeight: 1.7
  body:
    fontFamily: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.7
  label:
    fontFamily: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1.3
  code:
    fontFamily: SFMono-Regular, Consolas, "Liberation Mono", monospace
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.6
rounded:
  sm: 5px
  md: 8px
  lg: 9px
  panel: 14px
  xl: 12px
  composer: 14px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  page: 32px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    typography: "{typography.label}"
    rounded: "{rounded.lg}"
    padding: 0 13px
    height: 36px
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    padding: 0 13px
    height: 36px
  button-ghost:
    backgroundColor: transparent
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.lg}"
    padding: 0 13px
    height: 36px
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: 0 13px
    height: 36px
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    padding: 0 11px
    height: 36px
  navigation:
    backgroundColor: transparent
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.lg}"
    padding: 9px 12px
    height: 36px
  navigation-selected:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.text}"
  badge:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.text-secondary}"
    rounded: 5px
    padding: 3px 7px
  project-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
    padding: 12px
  disclosure:
    textColor: "{colors.text}"
    padding: 8px 0
    height: 40px
  confirmation-dialog:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: 16px
    padding: 28px
    width: 480px
---

# Design System: AI营销工作台

## Overview

**Creative North Star: "紧凑中性工作台"**

采用用户提供的黑白灰分栏参考。深炭灰一级导航保留图标与中文名称，浅冷灰二级目录衔接白色主工作面；灰色选中态、单色图标、细分隔线与柔和圆角构成层级。沿用系统字体、短标题和紧凑列表，让客户、项目和下一步操作成为视觉中心。

界面按销售、管理者、管理员的任务组织；默认展开当前工作，历史、配置和辅助解释按需披露。浅深主题共享语义角色，状态颜色只表达业务含义。

**Key Characteristics:**
- 中性表面与细分隔线
- 紧凑工具栏、列表和按需展开的细节
- 保留中文可读性、键盘焦点与移动触摸空间

## Colors

主色为深灰，白色内容区与浅灰侧栏构成中性底色；明暗两套值见 frontmatter。实现来源是 `app/cds-theme.css`，保留的 `--cds-*` 名称是现有组件的兼容接口。

- **Primary：** `primary` 用于主操作；`primary-hover` 用于悬停。
- **Neutral：** `surface` / `sidebar` 分开内容与导航；`text`、`text-secondary`、`text-muted` 表达信息层级；`border` / `border-strong`、`hover` / `selected` 表达边界与交互。
- **Status：** `success`、`warning`、`danger` 表达结果与风险。项目截止日期、结果及用户自定义提醒保留对应业务色与文字标签。

**The Semantic Color Rule.** 颜色用于成功、警告、危险和用户设置的项目提醒；普通导航、按钮与选中状态使用中性色。

## Typography

界面共用系统无衬线字体栈，包含中文回退；不加载展示字体。正文以 frontmatter 的 body 为阅读基准，长文按内容使用更宽松行距。标题常见为 headline，角色首页使用较紧凑的 22px 标题；章节与条目以 title、按钮与工具栏以 label 为基准。元数据常见 11–12px，不用其承载主要正文。手机表单输入提高到 16px。

凭据、代码与诊断内容使用 frontmatter 的 code 等宽字体栈，便于核对标识符和多行数据。

## Layout

桌面固定侧栏宽 208px，内容区随可用宽度伸缩；主要业务页最大宽 1280px，常用水平内边距 32px。页面内按列表、工具栏、分栏和详情组织，间隔使用 frontmatter 记录的实测节奏，局部表单按字段关系排列。

850px 以下侧栏改为抽屉；销售与管理者在小屏保留常用底部导航，完整入口仍在导航抽屉。各业务模块根据内容在约 600–760px 重排；常用主操作扩大到至少 44px。项目桌面为企业目录、AI 对话、画像三栏；窄屏通过企业目录、对话、画像切换，保留输入空间与固定导航避让。腾讯会议专用入口保持 375px 侧栏场景，内容按窄屏排列。

## Elevation & Depth

**The Flat Work Surface Rule.** 常规内容保持平面，用留白、分隔线和背景区分层次；遮罩与弹层才使用明显阴影。

阴影与焦点值从主题提取到 `.impeccable/design.json`；composer 用内描边表达默认、悬停与输入焦点。交互过渡常用 180ms，composer 为 200ms，使用现有 easing。所有动画尊重 `prefers-reduced-motion`。

## Shapes

使用轻微圆角与细完整边框。小控件、按钮、面板与 composer 的半径见 frontmatter；普通卡片与项目卡片按各自组件定义使用。确认弹窗保留较宽松的圆角和内容留白。图标使用 lucide-react，通常单色；状态和业务图形按其含义配色。

## Components

- **Buttons：** 主要、次要、透明与危险变体共享常规控件高度与圆角，桌面 36px、850px 及以下 44px。次要按钮使用细边框；悬停改变背景，键盘操作显示清楚的 focus-visible。图标按钮、文字链接、开关和分段切换按各自交互布局。
- **Inputs：** 单行输入框与下拉在所有业务模块共享尺寸，以中性表面和完整边框为底。焦点使用主题 focus shadow，错误配合说明文字呈现；文本域保留多行高度。
- **Navigation：** 侧栏行以背景、字重和文字颜色表达当前页。名称、角色可见性、顺序与直接地址统一由 `app/lib/workspace-navigation.ts` 管理；后端权限仍独立校验。
- **Lists and cards：** 历史与文档采用分隔线列表，项目看板采用轻边框卡片；同类内容对齐，数字使用等宽数字。辅助设置、转写、检索片段与历史按需展开。
- **Badges：** 默认中性小标签；成功、警告和风险保留文字与语义色，状态不能只靠颜色识别。
- **Composer：** 使用 composer 半径与内描边，保留中文输入法保护及手动滚动意图。
- **Confirmation：** 共用未保存更改确认模式；标题、说明、动作分区，默认焦点在继续编辑。窄屏动作纵向排列，Esc 返回编辑；具体业务可保留就地离开提示。

### Shared control geometry

`app/form-controls.css` 是全站控件尺寸的统一来源。单行输入（含日期、时间）与普通单选下拉共用 `--control-height: 36px`、`--control-font-size: 13px`、`--control-padding-inline: 11px` 和 `--control-radius: 9px`；850px 及以下高度为 44px、字号为 16px。控件使用 `border-box`、零垂直内边距，原生下拉末端留 32px。带完整边框的搜索框等组合控件，外框同为 36px / 44px，内部输入减去 2px 边框并清零水平内边距，避免重复留白。

新模块继承这一层和 `--control-*` token，不再添加页面专属的固定控件高度；模块样式继续负责宽度、颜色与状态。普通文本域共用 9px / 11px 内边距和 9px 圆角，保留行数与伸缩；composer、回复区、合同正文与凭据编辑器保留各自排版。复选框、单选框、滑块、颜色、文件、隐藏与按钮类 input、读屏专用输入及多选 / 列表式 select 不套用单行尺寸。

## Navigation and Naming

产品名称统一为“AI营销工作台”，用于登录、加载、侧栏、页面元数据与嵌入视图，不附加口号。侧栏业务主入口依次为“社交平台获客、AI营销素材生成、项目跟进、提醒及日程、合同及审批、培训提升、知识库”，除用户指定的“AI营销素材生成”外，主分类不加 AI 前缀。

项目跟进使用通讯录式二级侧栏；中心为当前项目的 AI 对话，右侧为画像、评分与下一步建议。社交平台获客在二级侧栏组织“新建任务、筛选线索、留资对接、全网线索”。合同及审批共用一个一级入口和内部切换。提醒并入提醒及日程，今日工作、跟进记录和会议不再提供独立导航。品牌链接打开项目跟进；系统管理员仍进入系统管理。人员权限、业务规则、服务连接、搭建中心与任务记录保留岗位权限，移动端导航使用简短文本和完整无障碍名称。

具体能力在其业务位置使用“AI 客户洞察、AI 策略方案、AI 商机预测、AI 合同初审、AI 销售陪练、AI 会议纪要”。名称改变不影响内部页面、Agent、路由、接口或存储 ID；普通项目、会议、审批与知识管理保留业务名称。

## Do's and Don'ts

### Do:
- Do 使用实际语义 token，浅深主题同时检查文字、边框和状态。
- Do 优先采用列表、工具栏和可展开详情，保持主要动作就近可见。
- Do 保留中文输入法保护、键盘焦点、真实状态和移动端触摸空间。

### Don't:
- Don't 在卡片、模块或提示左侧添加装饰性色条；完整边框、数据图形和功能分隔线可保留。
- Don't 把辅助信息堆成多层卡片，或用放大标题和大块留白挤压业务内容。
- Don't 用中性色改写业务状态，或把缺少配置、读取失败和无数据呈现为成功。

### Schedule surface

提醒及日程沿用紧凑中性 Operate 风格：日期与新建为主，类型筛选和周/月/列表切换为一组工具栏。电脑默认周视图，手机默认列表；日历网格独立横向滚动，页面不横向溢出。选中日期与事件通过背景、字重、图标和完整轮廓区分，不使用装饰性左色条。AI 日程助手按需展开，生成草稿、核对和保存保持清楚的操作边界。保留真实空态、保存失败恢复、并发冲突与草稿离开保护。


## 2026-11-08 视觉参考更新

样式调整前的功能版本已在私有GitHub仓库保存为v1.2，提交a89484d88f82ca99d679ec95296bf895cb48d6b0。

用户选择保留深色一级侧栏的图标和中文名称。一级导航持续使用炭灰#242628、浅色文字#f5f7fa和灰色选中背景#41454b；二级企业目录、社交获客子栏目与辅助侧栏使用浅冷灰#f3f4f6，主内容为白色。主工作面桌面外框留8px，圆角20px；手机取消外框留白，保留抽屉和底部导航。内容面板常用12–14px圆角，输入及按钮统一9px。阴影只保留在弹层与必要的浮动内容，普通内容靠表面和完整细边框区分。

主导航颜色以--nav-*独立token定义，在.sidebar内映射既有语义token，避免浅色业务组件和深色导航互相污染。全局表面仍使用--cds-*兼容现有模块；所有单行输入/下拉保持桌面36px、手机44px。深色主题继续提供，业务风险、成功、告警和用户自定义提醒颜色保留。

本轮仅改变视觉与布局尺寸关系，不改变路由、权限、接口、数据或业务状态。恢复标签不使用左侧彩色强调竖条；选中项用灰底、字重与完整轮廓表达。

### 企业归档、公开线索与营销素材

当前企业目录与归档历史分开切换，授权深链接保留历史项目及草稿。公开研究用中性状态与来源日期说明，不与客户原话或真实销售记录混排。销售分配选择来自当前启用成员名册，空项目成员也可选。

AI营销素材生成沿用现有操作工作面：类型切换、输入编辑、结果预览与历史任务。未配置、提交待核对、处理中、保存中及失败分别说明，离开与覆盖未保存页稿有保护。全网线索放在获客二级导航，关键词/地区/平台控制与来源列表、审核详情组成内部滚动面板；摘要始终作为普通文本显示。新页面使用既有中性 token 和控件尺寸，电脑与手机均检查，无装饰性左色条。
