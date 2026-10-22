# 语音带练部署与验收

本次采用原生 WebSocket（WSS）持续传输 PCM，由独立 `voice-gateway/` 服务运行 sherpa-onnx 流式识别，再调用 OpenAI 兼容 TTS。浏览器在客户播报期间继续采集语音，支持用户开口打断。培训对话仍由既有 `training_reply` 生成和保存，网关不再调用第二个对话模型。

**私有 Site 网页部署成功，只说明业务网站上线；不代表 ASR 模型、TTS 推理服务或 GPU 网关已经上线。** 未完成真实服务连接和人工语音验收前，不宣称全双工可用或音色好听。

## 1. 运行结构

```text
浏览器 AudioWorklet ── 16 kHz / PCM16LE / 单声道 ──→ WSS 网关
    ↑ 持续采集；AEC                                      │ sherpa-onnx 流式 ASR
    │                                                   ↓ interim / final
    │                                            浏览器自动提交 training_reply
    │                                                   │
    └──── 24 kHz / PCM16LE / 单声道 ←── 流式 TTS ←── 已保存的客户回复

Worker：登录校验、训练会话归属校验、短期令牌签发
D1：训练文字与业务记录
独立网关：识别模型、音频连接、取消合成、上游 TTS 凭据
```

网关需要独立 Python 运行环境及模型文件；现有 Worker/D1 负责业务和鉴权。TTS 可以与网关同机，也可以是内部网络里的独立推理服务。对公网只开放有 TLS 的 WSS 网关，避免直接暴露无鉴权的 TTS 端口。

浏览器语音兼容模式使用 Web Speech API 时，应显示为兼容模式；轮流识别和播报不能作为全双工验收结果。

## 2. Worker 配置与连接状态

本地服务端配置放在忽略提交的 `.dev.vars`；线上通过托管平台服务端环境配置。两端使用相同的随机共享密钥，至少 32 字节。可在自己的终端用 `openssl rand -hex 32` 生成 64 位 ASCII 十六进制字符串，分别存入 Worker 与网关的密钥配置，不提交生成值。

```dotenv
VOICE_GATEWAY_URL=wss://voice.example.com/ws
VOICE_GATEWAY_SECRET=<与网关一致的随机共享密钥>
```

`VOICE_GATEWAY_SECRET` 用于 HS256 签名。浏览器只取得绑定训练会话的短期令牌，不取得共享密钥或上游 TTS API key。不要把密钥写进前端环境变量、URL 查询参数、录屏或日志。

| 接口 | 返回与含义 |
| --- | --- |
| `GET /api/training-voice` | `{configured:boolean,message:string}`。只检查 Worker 配置，不探活网关；`configured:true` 表示“已配置、待连接”。 |
| `POST /api/training-voice`，请求 `{sessionId}` | 校验当前用户及会话后，返回 `{url,token,outputSampleRate:24000,voices:[],defaultVoice:""}`。 |
| 网关 `session.ready` | 连接鉴权成功后的权威音色目录与默认音色。只有完成此握手才显示已连接及实际音色。 |

Worker 不维护第二份 `VOICE_GATEWAY_VOICES` 目录。Worker 返回的空音色列表不是故障，也不能替换成写死的预置目录来冒充已连接服务。浏览器的音色列表以网关 `session.ready` 为准。

## 3. 网关准备与配置

部署包、模型下载、Docker/Compose 启动和健康检查命令，以 [voice-gateway/README.md](../voice-gateway/README.md) 为准。先准备流式 ASR 模型和可访问的 TTS，再启动网关；本文不将示例域名或占位密钥当成可用服务。

| 环境变量 | 要求 |
| --- | --- |
| `VOICE_GATEWAY_SECRET` | 与 Worker 完全一致，至少 32 字节。 |
| `ALLOWED_ORIGINS` | 明确列出实际 Site 的 HTTPS origin；多个用逗号分隔，例如 `https://your-private-site.example.com`。只填协议、主机和可选端口，不含页面路径，不使用 `*`。 |
| `ASR_MODEL_DIR` | 网关容器内模型目录；包含同一套在线 transducer 模型的 `tokens.txt`、`encoder.int8.onnx`、`decoder.onnx`、`joiner.int8.onnx`。文件来源和重命名方式见网关 README。 |
| `ASR_NUM_THREADS` | 默认 `2`；结合服务器负载调节并实测。 |
| `TTS_BASE_URL` | 包含 `/v1` 的基础地址，例如内部服务 `http://tts:8880/v1`；网关追加 `/audio/speech`。 |
| `TTS_MODEL` | 上游实际加载的模型标识。 |
| `TTS_API_KEY` | 可选；上游要求认证时配置，始终留在网关服务端。 |
| `TTS_STYLE` | `openai` 或 `qwen`；Qwen 使用其流式扩展参数，其他兼容 TTS 使用普通 OpenAI Speech 请求。 |
| `TTS_VOICES` | JSON 数组，只登记该上游实际能合成的音色。每项包含 `id`、`name`、`lang`、可选说明 `description`。 |
| `TTS_DEFAULT_VOICE` | 可选；应属于 `TTS_VOICES`，未指定时使用目录首项。 |

音色 JSON 形状如下；该片段仅展示格式，不能证明服务可用：

```json
[
  {"id":"serena","name":"Serena · 温和女声","lang":"zh-CN","description":"Qwen 预置中文音色，待人工试听"},
  {"id":"uncle_fu","name":"Uncle Fu · 成熟男声","lang":"zh-CN","description":"Qwen 预置中文音色，待人工试听"}
]
```

Qwen 音色 ID 的大小写应匹配所部署服务的 `/v1/audio/voices`；例如 vLLM-Omni 使用小写 ID，原始 Python 库示例使用 `Serena`、`Uncle_Fu`。不要直接混用两者。

ASR 使用 [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 的在线识别能力，模型须从维护者的 [在线 transducer 模型列表](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/index.html) 选择与加载器匹配的中文模型。模型下载需要磁盘与时间；Python 包安装完成不代表模型已经准备好。

## 4. TTS 与中文音色选择

### 首选：Qwen3-TTS + vLLM-Omni

[Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) 的 CustomVoice 提供 9 个预置音色。先试听以下 5 个中文候选，按同一组营销带练句子比较清晰度、自然停顿、情绪和长句稳定性；下表为维护者描述，不是本项目听感评分。

| 上游音色 | 维护者描述 | 带练试听用途 |
| --- | --- | --- |
| `vivian` | 明亮、略带棱角的年轻女声 | 直接、明确的客户表达 |
| `serena` | 温暖、温和的年轻女声 | 平和沟通 |
| `uncle_fu` | 低沉、圆润的成熟男声 | 资深决策者 |
| `dylan` | 清晰自然的年轻北京男声 | 北京口音场景 |
| `eric` | 略带沙哑明亮感的成都男声 | 四川口音场景 |

1.7B CustomVoice 支持语气指令；0.6B CustomVoice 同样有预置音色，但能力表未标注指令控制。权重、推理运行时及实际负载需要独立算力，本文不预估未经实测的最低显存。

当前 [vLLM-Omni 官方在线 TTS 文档](https://docs.vllm.ai/projects/vllm-omni/en/latest/user_guide/examples/online_serving/text_to_speech/#qwen3-tts) 已支持 Qwen3-TTS 的 OpenAI 兼容 `/v1/audio/speech`。本项目的 `TTS_STYLE=qwen` 路径要求 PCM 分块输出：`stream:true`、`stream_format:"audio"`、`response_format:"pcm"`，部署配置保留 `async_chunk:true`。流式时不支持 `speed`。部署须锁定版本并验证真实响应格式。

Qwen 自己 README 的 vLLM 部分仍写“仅离线”，与较新的 vLLM-Omni 部署文档不同；以实际部署版本及该版本官方说明为准。其 WebSocket TTS 默认先缓存文本到 `input.done`，要提前逐句合成需配置 sentence split；这是上游 TTS 协议，与本项目浏览器到网关的 WSS 协议不同。

### 本次 Mac 验证：Kokoro v1.1-zh + sherpa-onnx

本机原生适配器是 `voice-gateway/local_tts.py`，使用官方 [Kokoro v1.1-zh int8 包和说话人映射](https://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese-English/kokoro-multi-lang-v1_1.html)，无需 Docker、PyTorch 或 Misaki。模型有 103 个说话人：100 个中文、3 个英文。中文女声对应 `speaker-3` 至 `speaker-57`，男声对应 `speaker-58` 至 `speaker-102`；不能沿用旧模型的编号与昵称。

网关当前本地配置登记实际存在的 100 个中文音色。数量表示可选说话人，不表示 100 个音色都已逐一通过人工听感验收。适配器在句子回调输出 PCM，属于逐句合成，不是逐 token 合成。

本地入口是 `http://127.0.0.1:5173`，网关 `ws://127.0.0.1:8001/ws`，TTS `http://127.0.0.1:8002/v1`。仅 HTTP 回环页面允许回环 WS；生产页面仍强制 WSS，不能把本机地址写到线上。已准备好模型及 `.venv` 后，可在项目根目录运行：

```sh
sh voice-gateway/start-local.sh
```

此命令启动三个本机服务，Ctrl+C 停止。已有服务运行时无需重复执行。麦克风须由使用者在网页点击连接并允许权限；合成 WAV 的链路验证不替代真人插话或外放回声测试。

### 其他 CPU 部署：Kokoro-FastAPI

[Kokoro](https://github.com/hexgrad/kokoro) 为 82M 模型；[Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) 提供 CPU 镜像、OpenAI 兼容 Speech 接口及流式 PCM，可用 `TTS_STYLE=openai` 验证整条链路，无需为本地 TTS 创建外部服务账户。

旧 Kokoro 1.0 的维护者 [普通话音色表](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md#mandarin-chinese) 列出 8 个候选：女声 `zf_xiaobei`、`zf_xiaoni`、`zf_xiaoxiao`、`zf_xiaoyi`；男声 `zm_yunjian`、`zm_yunxi`、`zm_yunxia`、`zm_yunyang`。旧表的中文评级为 D；它不适用于上述 v1.1-zh 的 100 中文说话人，也不能据此给新版本听感打分。

Kokoro-FastAPI README 的示例首包约为 GPU 300ms、旧 i7 CPU 3500ms、M3 Pro CPU 小于 1 秒；分块更小可能增加语调瑕疵。这些是项目在特定环境的指标，不是本站 SLA。

### 可扩展：CosyVoice

[CosyVoice](https://github.com/QwenAudio/CosyVoice) 支持中文方言/口音、零样本克隆和双流合成，但原生 `/inference_*` API 不等于 OpenAI Speech API。接入本项目需要额外 adapter，将接口、音色目录、采样率和取消行为转换到网关契约。

官方 FastAPI 示例虽返回 `StreamingResponse`，推理调用未显式设置 `stream=True`，模型方法默认 `stream=False`；adapter 必须明确启用实际流式推理。不能只换响应类就声称完成低延迟双流。

Qwen 宣称的最低 97ms、CosyVoice 的最低 150ms 都属于项目合成指标；本项目端到端延迟还包括端点检测、识别、业务回复生成、网络传输和播放缓冲，必须单独测量。

## 5. 上线顺序

1. 在有相应资源的主机部署并锁定 ASR/TTS 权重及服务版本。先在受控网络验证中文识别、列出的每个音色及 24 kHz PCM 输出。
2. 按网关 README 配置模型挂载、密钥、origin 白名单及 TTS 地址，启动 `voice-gateway/`，为 `/ws` 配置有效 TLS 和 WebSocket 反向代理。
3. 在 Worker 配置网关 WSS URL 和同一共享密钥，部署私有 Site。`GET` 已配置只代表配置齐全，继续完成 `session.ready` 握手。
4. 用真实浏览器、麦克风和扬声器完成以下验收，并记录实际版本、设备、并发量、延迟、失败项与人工听感。通过后才将该部署标为语音可用。

## 6. 真双工实测清单

以下均需实机验证；自动协议测试通过不能替代麦克风、网络和听感测试。建议每项记录浏览器、系统、输入/输出设备、时间及结果。

| # | 操作 | 通过条件 |
| --- | --- | --- |
| 1 | 播放较长客户回复，同时持续讲话 | 输入 PCM、ASR interim/final 在播放期间持续到达，采集没有因 TTS 暂停。 |
| 2 | 客户播报中说“等等，我想先确认价格” | 及时停播并取消上游合成及旧播放队列；采集保持运行，完整识别打断内容，后续不突然续播旧音频。记录打断耗时。 |
| 3 | 开扬声器，连续交谈至少 10 分钟 | 客户播报不被当成用户再次提交，无自问自答循环；另用耳机复测，检查 AEC 的设备差异。 |
| 4 | 连续快速说两句，制造重复 final 与业务请求延迟 | 真实新句排队处理，不丢失；重复 final 不重复提交，同一业务回复不重复保存或播报。 |
| 5 | 朗读含金额、日期、数字、品牌名和中英混排的长句 | 识别可用，TTS 无明显漏读、截断或长时间停顿；分别试听目录所有音色并记录人评，不以名称代替试听。 |
| 6 | 网络限速、增加延迟、断开后恢复 | 不无限堆积输入或播放缓冲；连接问题有明确状态，断开时停止旧播放；重连不重放旧 final。 |
| 7 | 使用错误/过期令牌、错误共享密钥或非白名单 origin | 403/鉴权关闭被清楚呈现，不显示已连接，不泄漏密钥，不静默退成“全双工”成功状态。 |
| 8 | 切浏览器标签、隐藏页面、切场景、看历史、结束练习或离开页面 | 麦克风轨道、AudioContext、WSS 和回调清理；旧会话结果不能写入新会话。返回后按界面操作重新连接。 |
| 9 | TTS 不可达、返回非 PCM、音色不存在或响应中途失败 | 显示真实错误并结束错误播放；文字训练记录仍可查看，不标记成已成功播报。 |
| 10 | 查看浏览器请求、源码构建产物和日志，并测端到端延迟 | 客户端只有短期令牌，没有共享密钥/TTS key；记录用户说完到首次可听回复的中位数、P95及打断耗时，避免用模型97ms代替整链路结果。 |

原始音频经过网关识别；如 TTS 部署在第三方服务，客户回复文字也会发往该服务。部署前应据实际主机与日志配置确认保留方式；不要把用户录音上传到未经核实的公共 demo 来完成验收。

## 7. 许可证原文

库、模型权重和外部服务的条款应分别核对。以下只列原文，不作法律结论：

- [sherpa-onnx LICENSE](https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE)；另核对所选 ASR 模型页的条款。
- [Qwen3-TTS LICENSE](https://github.com/QwenLM/Qwen3-TTS/blob/main/LICENSE)、[vLLM-Omni LICENSE](https://github.com/vllm-project/vllm-omni/blob/main/LICENSE)。
- [Kokoro LICENSE](https://github.com/hexgrad/kokoro/blob/main/LICENSE)、[Kokoro-FastAPI LICENSE](https://github.com/remsky/Kokoro-FastAPI/blob/master/LICENSE)。
- [CosyVoice LICENSE](https://github.com/QwenAudio/CosyVoice/blob/main/LICENSE)。

资料核对日期：2026-10-23。此次完成代码与部署说明不等于已经安装模型、创建 GPU 服务或完成语音实机验收。
