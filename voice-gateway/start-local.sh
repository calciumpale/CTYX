#!/bin/sh
# Start the already prepared, loopback-only native voice services and workbench.
set -eu
voice_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
app_dir=$(dirname "$voice_dir")
if [ ! -x "$voice_dir/.venv/bin/python" ] || [ ! -f "$voice_dir/.env" ]; then
  echo "请先按 README 完成本地虚拟环境、模型与 .env 配置。" >&2
  exit 1
fi
cd "$voice_dir"
"$voice_dir/.venv/bin/python" - <<'PY'
import socket
for port in (5173, 8001, 8002):
    with socket.socket() as connection:
        if connection.connect_ex(('127.0.0.1', port)) == 0:
            raise SystemExit(f'端口 {port} 已有服务运行；请直接打开已有工作台，或先停止旧服务再启动。')
PY
"$voice_dir/.venv/bin/python" local_tts.py --port 8002 &
tts_pid=$!
"$voice_dir/.venv/bin/python" -m uvicorn app:app --env-file .env --host 127.0.0.1 --port 8001 --workers 1 --ws-max-size 16384 &
gateway_pid=$!
cleanup() {
  kill "$tts_pid" "$gateway_pid" "${web_pid:-}" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM
ready=0
while [ "$ready" -lt 60 ]; do
  if ! kill -0 "$tts_pid" 2>/dev/null || ! kill -0 "$gateway_pid" 2>/dev/null; then
    echo "语音服务启动失败，请检查上方日志。" >&2
    exit 1
  fi
  if curl --fail --silent http://127.0.0.1:8001/healthz >/dev/null 2>&1 && curl --fail --silent http://127.0.0.1:8002/healthz >/dev/null 2>&1; then
    break
  fi
  ready=$((ready + 1))
  sleep 1
done
if [ "$ready" -ge 60 ]; then
  echo "语音服务启动超时，请检查模型和配置。" >&2
  exit 1
fi
cd "$app_dir"
npm run dev &
web_pid=$!
echo "语音服务已就绪；网页将使用 http://127.0.0.1:5173。Ctrl+C 停止。"
wait "$web_pid"
