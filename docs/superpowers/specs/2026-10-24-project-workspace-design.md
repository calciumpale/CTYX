# 通用项目销售工作台

用户要求：通用销售业务、新建商机、文字/录音跟进入口、以项目组织画像和 Agent 工作、企查查优先且无配置时真实联网补全企业资料。

采用兼容扩展：项目复用 Deal 的稳定 id；name 仍为企业名称，新增 projectName。一个项目关联一家主要客户企业，一家企业可有多个项目。旧记录不删除、不批量改写。沿用现有 Sites 账号隔离、角色投影、版本比较和 R2 录音存储。保留 CDS 视觉及全局禁用左侧装饰色条偏好。

项目中心替代原商机表：列表以项目为标题，企业/联系人为辅助；顶端新建项目，行内新增跟进。详情为独立页面，含概览、客户画像、跟进记录、Agent 工作；文字和录音在跟进页顶端即可录入。可编辑联系人、需求、决策链、预算和采购时间。回到项目列表保持选择与筛选。

企业补全：设置新增企查查 AppKey、SecretKey 和官方接口配置，凭证加密保存且不回显。未启用时使用服务端公开网络检索；仅发送企业名称/官网，不发送内部跟进、个人联系人或私密金额。大模型根据检索材料整理，不让模型凭记忆编造工商事实。来源链接、获取时间、部分结果和检索失败均可见；无法确认标待核实。人工资料与外部画像分开，补全不覆盖人工填写。

兼容类型契约：
- Deal 新增可选 projectName、source、website、region、createdAt、dataOrigin:'sample'|'manual'、customerProfile、companyProfile。
- customerProfile 为 {decisionChain,goals,concerns,budget,timeline}，均字符串。
- CompanyProfile 为 {companyName,summary,facts:{label,value,sourceIds:string[]}[],sources:{id,title,url,provider:'qcc'|'web',retrievedAt}[],provider:'qcc'|'web',status:'ready'|'partial',warnings:string[],updatedAt,modelUsed:boolean}。
- ActionContext.enrichCompany(deal:Deal):Promise<CompanyProfile>。deal_create 返回新项目 id 于 result.dealId；deal_update 要求 dealId/version；deal_enrich 要求 dealId/version，由可信服务生成 companyProfile 并保存运行记录。
- 新建项目必填 projectName/name(企业名)，其他字段渐进补全；新记录 ownerId 为当前销售或管理者，仅允许既有授权成员。新项目 health=0 表示未评估，不编造赢率。

替代方案：建立全新 projects/companies/contacts 数据库迁移会扩大本轮风险；保留当前行业专用 UI 仅增加按钮无法满足通用项目组织，因此采用兼容扩展。

验证重点：旧数据不丢失、同企业多项目、非法金额/名称、权限越界、版本冲突、失败不覆盖画像、凭证隔离、来源约束、无搜索结果不编造、录音保存/播放、手机详情返回。
