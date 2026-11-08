# 可配置知识切块与批量资料导入

2026-11-08。用户明确要求：参照 RAGFlow 提供切块大小、overlap、按行等策略，调整后可重新切块；同模块单行输入框与下拉框等高；资料支持多选批量与拖拽导入。用户已确认切块大小使用字符数。其余边界为基于现有系统的实现选择，不声称完整复刻 RAGFlow。

## 方案与范围

扩展现有 React/Vinext、D1、浏览器本地文档解析和 Embedding 流程。沿用普通/父子两种检索拓扑，在其下增加自动递归、段落、行、固定长度、自定义字面分隔符。直接接入 RAGFlow 服务会引入另一套服务与权限，超出本次参数化需求；只在界面放参数但不保存原文、重建索引也不能满足真实重切，因此采用原生参数化切块、原文保存与暂存后原子替换。

资料库保存新导入默认参数；每份资料保存实际生效的参数快照，允许单独修改。保存库默认值不会静默修改已有资料。单份资料先预览再执行重新切块。重切和可选向量重建全部成功后才激活新块；失败、取消及尚未提交的中断保留旧资料及检索结果。已被服务端接受的最后一次继续请求仍可能原子完成，页面回来后读取真实任务状态，不承诺撤销已接受请求。无需更改现有 Agent/search hit 的对外格式。

现有文档只有切块，没有精确原文。迁移不拼接旧块冒充原文；旧资料显示需要补充一次原文件或正文后重切，新导入自动保存精确解析正文。Excel 延续工作表/行号/单元格定位文本，不执行公式或宏，不丢弃表尾。

## 参数合同

新模块 `app/lib/knowledge-chunking-config.ts` 导出：

```ts
type KnowledgeChunkConfig = {
  version: 1;
  strategy: 'flat' | 'parent-child';
  method: 'recursive' | 'paragraph' | 'lines' | 'fixed' | 'delimiter';
  chunkSize: number;
  overlapPercent: number;
  linesPerChunk: number;
  delimiters: string[];
  parentChunkSize: number;
  childChunkSize: number;
  childOverlapPercent: number;
};
```

导出 `DEFAULT_KNOWLEDGE_CHUNK_CONFIG`、`normalizeKnowledgeChunkConfig(raw)`、`describeKnowledgeChunkConfig(config)`。默认普通/自动递归，750 字符，overlap10%，每组10行；父块1350、子块350、子块overlap10%；默认字面分隔符为空行。长度128–6000整数，overlap0–30整数，每组1–200行；父子模式子块不得大于父块。最多8个非空分隔符，每个不超过40字符，支持明确显示的换行/制表符转义，禁止执行用户正则。

新增 `splitConfiguredKnowledgeText(text,config)`。保留 `splitKnowledgeText(text,strategy)` 的旧算法兼容旧测试与调用。新算法按 Unicode 码点计块大小、不切坏代理对；正文总上限仍沿用100万字符入口限制。自动策略优先段落/句/行自然边界；段落与分隔符策略先切再按大小合并；固定长度直接滑窗；按行按组分块，overlap按行比例取整，超长单行仍按字符上限切开。大小为硬上限，父子块关系一起生成。重叠只在同一标题区段内发生；每个块是连续原文片段，保留顺序与来源。父块同样不超过6000字符，适配现有 Agent 上下文。

所有策略继续受6000总块/300万切块正文字符等既有容量限制；过小块/重叠导致超限要明确拒绝，不截断尾部。预览与应用调用同一个规范化器和算法。

## API 与公开类型

保留 `/api/knowledge-library` 现有操作，继续逐请求 owner/member 鉴权、同源与体积限制。销售只读/检索，管理者和管理员维护。

公开 `KnowledgeLibrary` 增加 `defaultConfig` 与 `version`；`KnowledgeDocument` 增加 `contentVersion`、`sourceAvailable`、`appliedConfig` 和可选 `rechunkJob`。为旧前端/测试兼容，新字段可在 TS 合同中可选，但新服务正常返回。`strategy` 与现有状态/计数保留。Job 公开 id、documentId、config、baseVersion、status（indexing/ready/error/completed/cancelled）、chunkCount/indexedCount、error、时间；不返回源正文/私有内部键/向量。

- `saveLibraryChunking {libraryId,version,config}` → `{library}`，版本冲突409。
- `previewChunking {config,documentId?,version?,text?}` → `{preview:{config,totalChunks,searchableChunks,parentChunks,samples,sourceAvailable,contentVersion?}}`。文档预览先鉴权；已有原文由服务端读取；旧文档可附补充正文。新上传直接提供正文。最多6个样例，不加载向量，不写库。
- `upload` 扩展 `config`、稳定 `requestId`；保留旧 strategy 字段兼容。服务端解析有效参数并存原文、实际配置与 chunks/FTS。每次客户端重试同一项保留 requestId；同键不同正文/标题/库/配置409，网络结果未知不会重复建文档。
- `beginRechunk {documentId,version,config,requestId,text?,fileName?,rebuildIndex}` → `{job,document}`。从已保存原文或明确补充原文重新计算，暂存新块。rebuildIndex=true 时要求已配置向量并固定模型标识；false 明确表示激活后旧向量失效、BM25可用。
- `continueRechunk {jobId}` → `{job,document}`。每次最多16个非父块向量，租约/CAS防并发；完成后激活。无向量模式可直接完成激活。相同完成任务重复调用稳定返回。
- `cancelRechunk {jobId}` → `{job,document}`。撤销任务写权限，清理暂存、保留当前有效资料。
- `removeDocument` 可增加可选 version，清理原文页、暂存任务、chunks/FTS。并发删除后旧任务不得复活文档。

GET snapshot 返回可恢复的最近未完成重切任务；源内容与生效参数分开。更改库默认值与重切的参数快照互不串改。

## D1 原文、暂存与切换

只做追加 schema migration（0023）。现有记录不重切、不改向量、不改资料所属库。文档有独立 content_version、source_version/hash、applied_config、upload_request_id/hash、current_rechunk_job_id；库有默认配置与版本。

原文按 UTF-8 有界分页存储，不能把100万中文字符约3MB放在一个D1绑定/行里。复用既有有界 JSON 分页思路，保留精确顺序并校验长度/hash。新增 owner/document/version 作用域原文页、重切任务、暂存块表。暂存块包括拓扑、文本、tokens及可选向量；不进入现有 active chunks/search。

开始任务先保存不可变参数/原文引用及新 chunks，旧 active chunks、FTS、配置、向量、状态保持可用。同一请求键幂等；显式新任务可以替代旧未完成任务，旧 token 失效。向量用16块一批，固定模型/维度，120秒租约与 job token 防止旧响应覆盖。失败仅标记 job，不破坏 active document；恢复使用同一任务。

最终一次 D1 batch 在每条变更中共享 job/owner/document/base contentVersion/currentJob 条件：删除旧 FTS/chunks，从暂存表 INSERT SELECT 新 chunks 与 FTS，更新文档实际参数/原文引用/计数/模型，contentVersion及向量 generation递增、清空旧index token。最终断言失败回滚整批，不能只在最后检查 CAS。既有正在执行的 index 请求在切换后因token/generation失效不能污染新块。删除/取消/新任务/模型变化同样不能绕过守卫。

原文和文本/chunk JSON 按现有有界页批量写入，不生成数千条逐块SQL；所有绑定低于2MB，参数数不超过100，继续执行容量检查。取消与成功后的垃圾清理不得删除仍被active document引用的源页，也不得跨 owner。若当前模型变化，暂停/拒绝对应旧模型任务并保留旧有效内容。

## 批量与拖拽导入

文件选择器支持 multiple，与拖放 Files 共用队列。每批最多20个、单份仍10MB、解析正文100万字符；类型沿用XLSX/XLS/PDF/DOCX/TXT/Markdown/CSV。不支持文件夹递归，明确指出不支持项。粘贴正文入口保留。

先显示队列、目标库与切块参数，再由“开始导入”执行；每份有独立稳定请求ID、文件名/标题、状态、提取字数、错误与重试。最多2份并行处理；失败不阻断其他文件；同一选择重复加入要提示。保留解析警告。已入库但索引失败的项只继续索引，不重新上传。

可选择导入后建立索引，默认沿用当前已配置时自动索引行为但明确显示。停止后续导入不谎称取消已提交请求；等待当前请求结束后暂停队列，剩余项可继续。不能在用户切库/改参数时悄悄改变执行中的队列快照。完成/失败/暂停用真实状态，不模拟百分比。页面离开/关闭、知识库内部切页、全站导航/退出都有忙碌及未提交队列保护。

## UI 与验收

保持黑白灰工作面与现有Overlay。参数控件复用一套组件，导入/库默认/单文档重切一致。单行 input/select 外边框高度桌面36px、850px及以下44px；多行正文/分隔符可高于单行。无装饰性左色条。库默认设置与每文档“切块设置/重新切块”可找到；重切面板显示当前生效参数、拟用参数、预览样例与真实任务进度，失败明确旧内容仍可用。

验收包含：所有算法/overlap/Unicode/标题/Excel定位、源正文百万中文分页、库默认与单文档覆盖、legacy无原文、跨owner/销售越权、请求幂等、预览无写、embedding失败/维度变化/中断旧检索可用、原子切换/FTS清理、并发index/rechunk/delete/cancel、上传成功响应丢失不重复、混合有效无效文件/拖拽/多选/单项重试/停止与离开保护、桌面/手机等高与内部滚动。QA用合成资料和模型，不调用真实付费Embedding，也不自动重切生产资料。

最终验证、私有GitHub main与现有Site同步沿用会话授权和既有访问范围；部署只增加能力，不对生产原文缺失记录作虚构回填或批量重切。

## 实现合同补充（开工审查）

上传幂等先于库默认解析：先按 owner/requestId 查已有提交，再比较规范化的调用意图（含config/legacy strategy的存在性、正文、标题、文件名、库）。已有请求复用原生效参数，库默认变化不导致重复提交冲突；DB唯一约束让并发请求收敛。配置优先config，其次显式legacy strategy，其次库默认；旧strategy-only调用保留旧算法。

beginRechunk同样先查已有requestId，再校验contentVersion，已完成提交重试不因旧version报409。scope为owner/document/requestId；不同意图同键409。保留completed/cancelled任务元数据供稳定重放。chunkCount/indexedCount只计非parent；preview.totalChunks含parent。rebuildIndex=false也由第一次continue原子激活，begin仅暂存。

补充的旧资料原文/文件名只保存为job暂存源，成功激活前不改变active sourceAvailable/fileName/config。保留精确内外空白，trim仅用于判空；有序重组后校验长度/hash。取消、替代、删除、模型变化使lease/token失效；每个向量写入和终态写入再次验证owner/job/currentJob/baseVersion/status/token/current有效modelKey。空暂存不能解释为完成。

原子激活在batch内约束断言目标块数、可检索块数及source完整性，失败必须抛错回滚。guard依赖的delete/insert先执行，document CAS最后执行，后续清理使用新active引用。不可在batch返回后才检查CAS。父块返回Agent的UTF16上下文裁切保持完整码点。

## 后续并入的已授权需求

用户补充：每个部门销售账号的抖音回复前检索所属部门资料库；初始成单话术库各部门共用；各部门真实对话案例沉淀候选Skill，经现有审核流程发布为话术模板并回流知识检索。沿用可信成员身份判定部门及owner作用域，禁止模型或客户端传入任意部门扩大权限。资料库设置与检索、候选Skill及审核发布要保持同一部门边界，共享仅限已发布初始话术。

AI营销素材生成已配置APImart，但未返回图片/视频。先读取已有任务与官方返回合同，禁止重复提交已计费生成。线上图片任务已进入saving95%且files为空，先修复结果读取/安全下载/私有存储，允许原任务重试保存；需区分生成失败、地址不兼容、下载失败和保存失败，显示真实可恢复状态。当前无视频任务行，视频通过官方合同和合成响应验证，QA不创建付费请求。


## 对话案例提炼的交付合同

当前会话提供“提炼话术 Skill / 重试”，客户端仅提交chatLearn、campaignId、conversationId。服务端重新读取启用成员与原会话归属，销售仅可提炼本人会话，管理者沿用现有团队会话可见范围；部门与作者取原销售账号，不接受客户端指定原文、作者或部门。

只读取当前接待任务绑定的可靠文本消息，图片、未知/失败/排队的外发草稿及单纯确认不计入。至少两条实质客户消息和两条已确认发送的销售回复，最多100条、50000个脱敏字符；来源快照先持久化，再调用文字模型。来源hash使同一案例重复点击复用任务；配置缺失、失败和租约中断可恢复，无关工作空间CAS冲突使用有界重试。

沿用TalkTrack作为话术Skill，不复制一份普通Skill记录。候选带部门、原任务、消息标识、脱敏原文与精确引文，禁止构造虚假成单项目。管理者按版本审核发布；发布项立即进入所属部门的词法知识检索，未建向量时如实说明；候选、退回和归档项不参与。现有已确认成单的向量提炼流程继续使用。初始共享话术不被部门案例覆盖。

脱敏覆盖已知参与者姓名及明确标注的联系方式、手机号、格式化电话、邮箱、微信/账号、联系人中英文姓名；不承诺识别所有未标注的第三方实体。审核仍需核对可复用边界与客户特有事实。QA仅使用合成案例和模型响应，不提炼线上真实客户会话。

部署后为缺失的园林、测绘、文旅部门建立空资料库配置入口，不填造知识正文。现有招商、医药资料及共享话术保留；检查五个销售账号只能读取本部门和共享库。发布验证不自动重切或导入生产资料。
