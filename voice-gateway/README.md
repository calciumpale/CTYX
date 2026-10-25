# 自部署全双工语音网关

这是独立 Python 服务，可在 Mac 原生运行或部署到可运行 Docker 的服务器。Cloudflare Worker 负责身份、业务记录和客户回应；此服务负责中文流式 ASR、打断、指定文字的 TTS，以及后台录音转写。它不创建第二份客户对话。录音任务使用私有临时文件和 SQLite，处理后清除临时音频，结果保留7天供工作台同步。

浏览器持续上传麦克风 PCM，同时接收客户 PCM。ASR 产生首个非空 partial 时立即取消正在合成的客户语音，随后发送 `input.speech.started`。最终文本由应用自动提交 `training_reply`，已保存的客户回应再原文交给网关播报。麦克风不因播报或 HTTP 保存请求而停止。

当前交付包含实现和无权重测试；服务器部署与真人中文音质/回声/延迟验收需分别完成。本机验证结果以实际运行日志与 smoke 报告为准。

## 最小 CPU 部署：sherpa-onnx + Kokoro

需要 Linux amd64/arm64、Docker Compose、可从公网访问的 HTTPS/WSS 域名。ASR 在 CPU 上运行，Kokoro 使用官方 CPU 镜像；实际并发和延迟需在目标硬件验收。本服务不能放在 Cloudflare Worker 内运行。

在此目录执行：

```sh
cp .env.example .env
openssl rand -hex 32
mkdir -p models/asr
curl --fail --location https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30.tar.bz2 --output /tmp/training-asr-model.tar.bz2
tar -xjf /tmp/training-asr-model.tar.bz2 --strip-components=1 -C models/asr
```

将刚生成的随机值填入 `.env` 的 `VOICE_GATEWAY_SECRET`，并在 Worker 的同名服务端 secret 中配置相同值。将 `ALLOWED_ORIGINS` 改为私有站点的**完整 origin**，例如 `https://your-site.example`；多个 origin 用逗号分隔，不能带路径、末尾斜杠、通配符或 `null`。

模型目录必须包含 `tokens.txt`、`encoder.int8.onnx`、`decoder.onnx`、`joiner.int8.onnx`。这些文件来自官方中文流式 Zipformer 模型，约 160 MB；下载产物不应提交到仓库。其他在线 transducer 模型可通过 `ASR_TOKENS_FILE`、`ASR_ENCODER_FILE`、`ASR_DECODER_FILE`、`ASR_JOINER_FILE` 改文件名，必须与 16kHz 特征和 transducer API 匹配。

```sh
docker compose up --build -d
curl --fail http://127.0.0.1:8000/healthz
curl --fail http://127.0.0.1:8880/v1/audio/voices
```

在 TTS 服务实际返回的音色中选择中文音色，更新 `.env` 的 `TTS_VOICES` 和 `TTS_DEFAULT_VOICE`，再执行 `docker compose up -d --force-recreate gateway`。示例的 `zf_xiaobei`、`zm_yunxi` 属于 Kokoro 中文音色；列表完全由部署配置决定，网关不会补造不存在的音色。

`compose.yaml` 使用维护者文档中的 CPU 镜像 `ghcr.io/remsky/kokoro-fastapi-cpu:latest`。部署验收后将它固定到实际验证的 release tag 或 digest。首次拉取镜像/模型可能需要网络。

## HTTPS 与 Worker 配置

给网关绑定单独域名，通过反向代理把 `/ws` 的 WebSocket 升级请求转到 `127.0.0.1:8000`。例如 Caddy：

```caddy
voice.example.com {
    reverse_proxy 127.0.0.1:8000
}
```

在 Worker 的服务端配置中设置：

```text
VOICE_GATEWAY_URL=wss://voice.example.com/ws
VOICE_GATEWAY_SECRET=<与网关相同的随机值>
```

私有 Sites 的登录身份仍由 Worker 验证。Worker 只给当前用户可见且进行中的训练签发 5 分钟票据；浏览器首次 WebSocket 消息携带票据，URL 中不带票据。共享 secret、TTS key 和 provider 地址不交给浏览器。`ALLOWED_ORIGINS` 必须包含页面所在站点，而非只包含网关域名。

Compose 端口仅绑定本机。Kokoro 的端口供本机探测与网关使用，公网只暴露反向代理后的网关。网关验证 Origin 和 HS256 票据，默认最多 4 个已认证会话，每个会话最长 30 分钟。票据的 5 分钟有效期仅用于握手。

防重放缓存是进程内的：使用默认 `--workers 1`，不能直接水平扩容/多 worker 共享同一票据域；需要扩容时先替换为共享、原子的 jti 存储。重启会清空缓存，旧票据最晚在签发后约 5 分钟失效。

## 接其他自部署 TTS

`TTS_BASE_URL` 包含 `/v1`，网关追加 `/audio/speech`。provider 必须返回 **24kHz、16 位有符号小端、单声道、无容器头 PCM**。不能直接返回 WAV、MP3、JSON、SSE 或 base64。示例：

```dotenv
TTS_BASE_URL=http://tts:8880/v1
TTS_MODEL=kokoro
TTS_STYLE=openai
TTS_API_KEY=
TTS_VOICES=[{"id":"zf_xiaobei","name":"晓贝","lang":"zh-CN"}]
TTS_DEFAULT_VOICE=zf_xiaobei
```

OpenAI-compatible 模式发送 `model`、`input`、`voice`、`response_format:"pcm"`、`speed`，`speed` 限制为 0.75–1.25。这表示兼容请求格式，不依赖 OpenAI 托管模型或 API key。

Qwen3-TTS / vLLM-Omni 可改 `TTS_STYLE=qwen`，设置实际加载的 `TTS_MODEL` 和实际可用的 voice。此模式增加 `stream:true`、`stream_format:"audio"`，不发送流式模式未实现的 `speed`。`async_chunk:true` 在 **vLLM-Omni 部署配置**中启用，不是 HTTP 请求字段。Qwen 的部署参数、显存与版本应按所选模型的官方说明确定；此目录未打包 Qwen GPU 推理镜像。若 CosyVoice 等服务的接口或输出格式不同，应先用独立适配器对齐上述 PCM 合同。

`TTS_VOICES` 只允许实际安装的音色，结构为 `[{"id":"...","name":"...","lang":"zh-CN","description":"可选说明"}]`；网关原样播报收到的客户文字，不能修改场景或补充对话。

## 健康与真人验收

`/healthz` 只确认 ASR 模型已加载、TTS 配置存在。`tts.probe:"not_performed"` 表示没有主动验证 TTS 连通性或音质；真实播报后 `lastSynthesis` 才记录 `succeeded` 或 `failed`。不得仅根据 `configured:true` 宣称 TTS 可用。

先直接探测已部署 TTS：

```sh
curl --fail http://127.0.0.1:8880/v1/audio/speech -H 'Content-Type: application/json' --data '{"model":"kokoro","input":"您好，请问您最在意的交付条件是什么？","voice":"zf_xiaobei","response_format":"pcm"}' --output /tmp/training-voice-smoke.pcm
# 已安装 ffplay 时可试听原始音频：
ffplay -f s16le -ar 24000 -ac 1 /tmp/training-voice-smoke.pcm
```

再通过工作台验证：客户播报期间直接开口，客户语音停止且麦克风持续；最终转写自动入对话且只产生一次客户回应；切换训练、角色、文字模式或离开页面后，旧会话不会继续播报/保存。音频终止事件后浏览器必须停止并清空已排队的 AudioBuffer，不能只取消服务端合成。

浏览器应启用 `echoCancellation`、`noiseSuppression`、`autoGainControl`，并把采集重新采样为 16kHz。软件回声消除效果取决于浏览器和输出设备；耳机、外放、安静/嘈杂环境都应做实际打断测试。ASR 首个非空 partial 触发打断，避免只凭能量把噪音当说话；仍需验收回声误识别。端点静音默认 0.7 秒，可用 `ASR_ENDPOINT_SILENCE` 在 0.3–2.0 秒内调整。

## 协议

所有控制消息为 JSON；输入和输出音频都是二进制 WebSocket 帧。

1. 客户端先发 `{"type":"session.start","token":"<JWT>"}`。JWT 必须为 HS256，包含 `aud:"training-voice"`、`sub`、`sessionId`、`exp`、唯一 `jti`。
2. 服务端发 `session.ready`，包含 `sampleRate:24000`、`voices`、`defaultVoice`。此后持续收 **16kHz PCM16LE mono**；每帧偶数字节且不大于 16384 字节。
3. ASR 发 `input.speech.started`、`input.partial {text}`、`input.final {id,text}`；每个 final 的 `id` 唯一。静音或空结果不生成 final。
4. 客户端发 `output.speak {id,text,voice,rate}`，其中 text 最多 4000 字、id 最多 160 字符；或发 `output.cancel`。
5. 服务端发 `output.started {id}`，随后发送 **24kHz PCM16LE mono** 二进制音频，结束发 `output.finished {id}`。取消先终止并等待旧 TTS task，发 `output.cancelled {id}`，再允许下一个 started，保证旧 PCM 不混入新播报。
6. 错误发 `session.error {code,message,id?}`；TTS 失败不会生成成功结束事件。认证、协议、会话超时错误会关闭连接，客户端需要新票据重新连接。

所有下行控制与二进制共用发送锁；TTS 根据已发送 PCM 的实际时长逐包等待，最多提前约 200–300 ms 输出，避免打断信号排在几秒已缓冲音频后。30 秒音频的虚拟时钟测试覆盖此限制，等待中也可取消。ASR 原生调用在有界线程池中处理，断连也要等待已开始的 native inference 释放槽位。

## 本地开发与测试

本次 Mac 原生验证使用额外的 `local_tts.py`：Kokoro v1.1-zh int8，24kHz、103 个说话人，其中 100 个中文。下载官方模型到忽略提交的 `models/kokoro-int8-multi-lang-v1_1/` 后运行 `.venv/bin/python local_tts.py --port 8002`；`LOCAL_TTS_MODEL_DIR` 可指定其他绝对目录。音色目录来自 `/v1/audio/voices`；本机使用 `speaker-48` 等真实 sid，和旧 Kokoro 1.0 的昵称不同。句子回调产生 PCM，不宣称逐 token 合成。

实测发现原生 int8 模型对某些极短标点段会产生 NaN；例如把“（演示客户）”角色标签与正文一起合成时，可能先生成无效短段。实际浏览器播报路径会移除这个演示角色标签，再发送完整客户台词；不能把测试脚本直接合成带标签原文的结果当成相同路径。adapter 仅合并过短逗号分句（例如“您好，”接后文），保留原有文字，不补写台词；所有 native 回调样本必须通过有限值检查。首段无效时接口返回清楚的 HTTP 503，后续段无效时终止流，由网关报告合成失败，不用静音冒充成功。100 个中文音色是模型候选目录，尚未逐一完成词句稳定性和人工听感验证。

`LOCAL_TTS_MODEL_FILE` 可选，用于指定相对模型目录的文件名或绝对路径；未设置时优先加载已存在的 `model.onnx`，否则加载 `model.int8.onnx`。可用它保留 int8 并另行做 fp32 对照；本次运行和数值诊断使用 int8，**未完成 fp32 权重验证**。对照记录位于 ignored `outputs/qa/native-tts-int8-business-diagnosis.json`，试听与生成指标也位于 `outputs/qa/`；这些记录不代替用户实际开麦、外放打断与人工试听。

本机已有模型、`.venv`、网关 `.env` 和项目根 `.dev.vars` 后，在项目根执行 `sh voice-gateway/start-local.sh` 可一起启动 TTS（8002）、网关（8001）、网页（5173），Ctrl+C 停止。不要与已运行的服务重复启动。仅本机 HTTP 页面允许使用回环 WS；公开 HTTPS 站点仍须独立部署 WSS。

建议 Python 3.12。Mac 本地原生验证可使用同一 `.venv`；需先准备 `.env`、模型与 TTS。`ALLOWED_ORIGINS` 可设置 `http://127.0.0.1:5173,http://localhost:5173`，只允许 loopback 在本地使用 HTTP，其余 origin 必须为 HTTPS。`.env` 的 `ASR_MODEL_DIR` 改成本机模型的绝对路径，`TTS_BASE_URL` 改成本机 TTS 的地址。运行：

```sh
python3.12 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --env-file .env --host 127.0.0.1 --port 8001 --workers 1 --ws-max-size 16384
```

`--env-file` 与 Docker Compose 均按 dotenv 规则读取，无需 shell source。本机原生网关使用 `ws://127.0.0.1:8001/ws`，TTS adapter 使用 `http://127.0.0.1:8002/v1`；公网部署保持 WSS。不要把 localhost 地址写入生产配置。

不使用麦克风，向真实网关流式发送官方模型自带 WAV：

```sh
.venv/bin/python smoke_asr.py --wav models/asr/test_wavs/0.wav
```

脚本从 `.env` 读取本地 secret 签发一次测试票据，以实时速度发送文件，要求真实 ASR 返回非空 final，将结果写到 ignored `models/asr-smoke.json`，不会打印票据或密钥。此验证不代替浏览器采集、声学回声消除或 TTS 验收。

完整往返验证可运行 `.venv/bin/python smoke_roundtrip.py --wav ../outputs/qa/native-tts-sample-sid-58.wav`：使用与合成音频一致的咖啡店免租期画像并确认，创建并结束一条本地训练，检查打断、自动提交去重和客户原文播报。`--root` 指定本地 Worker（默认 `http://127.0.0.1:5173`）；`--gateway-url wss://<gateway>/ws --origin https://<workbench>` 可验证公网入口。票据始终由本地 Worker 签发，不读取密钥；`--origin` 只改变 WebSocket Origin。

无权重、无网络单元/ASGI/WebSocket 测试：

```sh
python -m unittest -v
```

测试只替换模型推理和 TTS 网络边界，覆盖票据过期/篡改/重放、Origin 限制、音频边界、音色范围、Qwen 请求格式、连续输入自动打断、旧合成清理和损坏/空音频，不代表真实模型音质或端到端性能验收。

官方参考：[sherpa 在线 transducer API](https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.8/sherpa-onnx/python/sherpa_onnx/online_recognizer.py)、[中文流式模型](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/zipformer-transducer-models.html#sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30-chinese)、[Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI)、[Qwen3-TTS 部署示例](https://github.com/vllm-project/vllm-omni/tree/main/examples/online_serving/text_to_speech#qwen3-tts)。

## 录音转写：方言、热词表、讲话人

设置 → 语音识别中维护热词表。标准词送入识别模型作为上下文；仅明确登记的误识别写法会做确定性替换，原始文字与纠偏记录同时保留。可保存50条词，每词40字、至多5个2至40字的误识别写法。当前本机模型上下文有限，启动转写前会计算启用热词的实际 token 预算，超过容量时提示减少启用词条，不截断音频或静默丢弃热词。

本机模型安装：

```sh
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python setup-asr-models.py
```

脚本下载官方 FunASR-Nano int8（约842 MB压缩包，安装约1GB），以及 pyannote segmentation 和 3D-Speaker embedding（约46MB）。模型和任务目录不提交仓库。原生默认路径位于本目录 models/ 和 data/transcriptions/；Compose 需按 .env.example 配置 /models 下的路径并挂载 models。任务目录使用独立持久卷。

录音上传保存到项目后自动提交任务。旧录音可点“转写录音”。在途任务于后台串行运行，可离开页面；重新打开时同步完整结果到工作台，关联项目文字并触发客户分析、成单项目话术提炼。业务写入先提交，识别或分析失败不会回滚原录音。网关任务完成后删除其音频副本；完整结果在同步后独立保存在工作台 D1 中。后台网关仅保留7天结果，未同步而过期的任务可以从原始 R2 录音重新转写。

支持单文件20MB、最长2小时、最多100,000字和6,000段；项目分析关联前50,000字（受工作空间容量约束），完整结果仍可在录音转写中查看。开始任务时使用当时保存的设置，修改热词不改变在途任务。

语言与方言是识别上下文提示，不是经过校准的方言分类器。所选开源模型支持普通话及吴、粤、闽、客、赣、湘、晋等方言，具体音频质量和方言准确率需用目标业务录音验收。实时双工陪练继续使用低延迟普通话 Zipformer；它增加中文热词解码偏置与已登记误识别写法纠正，录音的多方言模型不会取代这条实时链路。

讲话人分离先按音频进行真实分段，再逐段识别，不使用 FunASR 插值的字级时间戳去猜讲话人。编号不代表身份、销售或客户角色；重叠或无法区分的片段标为未区分。指定人数可改善自动聚类；RECORDING_SPEAKER_THRESHOLD 默认0.9，取值0.1–2，越大通常分得越少。未检测到可靠讲话人时继续文字转写，并明确未区分讲话人。

HTTP 接口为 POST /transcriptions（multipart file、options）、GET /transcriptions/{id}，均验证5分钟、账号与录音绑定的 HS256 recording-asr 票据；服务端签发票据，不向前端暴露共享密钥。GET /speech-capabilities 仅公开模型能力与文件就绪状态，不含用户数据。仅限单进程运行。

使用已准备的本地音频片段验证完整上传、排队、识别和项目关联：

```sh
.venv/bin/python smoke_recording.py --audio /绝对路径/片段.wav --output ../outputs/recording-smoke.json
```

验证脚本只接受本机 HTTP 地址，通过正常本地登录建立标明“本地测试”的项目，不伪造身份头。会保留该项目和录音，便于在界面核对。

模型官方资料：[FunASR-Nano](https://k2-fsa.github.io/sherpa/onnx/funasr-nano/pretrained.html)、[讲话人分离](https://k2-fsa.github.io/sherpa/onnx/speaker-diarization/index.html)。开源模型支持范围与本次实测结果应分开记录。
