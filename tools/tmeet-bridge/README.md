# 腾讯会议本机同步助手

Node.js 22 ESM，无第三方依赖。助手只通过出站 HTTPS 连接工作台，不监听端口。腾讯会议的 OAuth 凭证由官方 `tmeet` 留在本机；本工具不读取其凭证文件，不自动登录、申请录制权限或修改分享设置。

## 配置

由工作台的成员设备配对流程提供以下 JSON。凭证只存本机，勿放入源码、终端参数、聊天或日志。

```json
{
  "apiOrigin": "https://your-private-workbench.example",
  "serviceAccessToken": "YOUR_PRIVATE_SITES_SERVICE_TOKEN",
  "deviceId": "YOUR_PAIRED_DEVICE_ID",
  "deviceToken": "YOUR_PAIRED_DEVICE_TOKEN"
}
```

`apiOrigin` 只能是站点 origin，不带路径、查询参数或账号信息。仅本地测试的 `localhost`、`127.0.0.1`、`[::1]` 允许 HTTP。配置必须由当前用户持有，且权限为 `0600`；助手拒绝符号链接配置。

## 检查一次

```bash
node tools/tmeet-bridge/bridge.mjs --config /absolute/private/config.json --tmeet /absolute/path/to/tmeet --once
```

不带 `--once` 时持续运行，每 5 秒检查授权并领取一次任务。它在未授权时只上报 `authenticated: false`。需要授权时，用户另外运行官方 `tmeet auth login`，然后在浏览器中完成授权。

## 安装到 macOS 登录项

安装器可从标准输入读取 JSON，也可使用现有 `0600` 配置文件：

```bash
node tools/tmeet-bridge/install-macos.mjs --tmeet /absolute/path/to/tmeet < /absolute/private/config.json
# 或
node tools/tmeet-bridge/install-macos.mjs --config /absolute/private/config.json --tmeet /absolute/path/to/tmeet
```

安装器仅写文件，不启动助手：

- `~/.config/marketing-workbench/tmeet-bridge.json`，权限 `0600`。
- `~/Library/LaunchAgents/com.ctai.marketing-workbench.tmeet-bridge.plist`，权限 `0600`，固定 Node、脚本和 tmeet 的绝对路径。
- 日志输出位置为 `~/Library/Logs/marketing-workbench/tmeet-bridge.log`；仅记录通用状态，不写命令回包、内容、下载链接或凭证。

待工作台服务部署并验证后，再由操作者使用 `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ctai.marketing-workbench.tmeet-bridge.plist` 启动。以后登录时自动运行；可使用 `launchctl bootout` 加同样的目标停止。部署目录及 Node/tmeet 绝对路径需要长期保留。

## 运行边界

只允许 `tmeet --version`、`auth status`、`record search`、`record content` 的 minutes/transcript/paragraphs、`record access` 的 address。子进程始终 `shell: false`；单条 CLI 最长 60 秒，任务最长 10 分钟，每 30 秒续租。完成请求最多等待 180 秒，服务端分析期间保持心跳。失去租约立即停止；普通权限错误不自动重试或发起申请。服务请求禁止重定向，以免凭证转发至其他域名。

搜索每次返回一页，保留 `hasMore` 与真实 `pageToken`。转写优先请求未设置 pid/limit 的完整结果；若明确截断或完整性不明，则使用官方段落目录返回的真实 ID 补齐，最多 200 段。无法验证覆盖时 `complete: false` 并保留已读取内容；不会用 pid 算术、摘要或目录伪装全文。单次正文上限 900 KB。

仅当用户选择导入音频且官方地址提供所选文件的 `audio_address` 时下载；不使用视频 `download_address` 替代。下载必须使用外部 HTTPS、响应必须为实际音频 MIME，并流式限制 50 MB。音频流式落入权限 `0600` 的临时文件，计数后带准确 `Content-Length` 流式上传到私有 `/api/meeting-bridge/media`，最后清理临时文件，不整包读入内存。服务端关联该任务。链接、权限、大小或媒体上传失败只添加明确警告，已读取正文继续保存。仅音频成功时保留录音和正文不可用的警告。助手不会自动开始录制或获取实时音频。

## 验证

```bash
node --test tests/meeting-bridge.test.mjs
```

测试使用临时 CLI 和受控网络边界，不调用真实腾讯会议账号，不上传真实会议内容。
