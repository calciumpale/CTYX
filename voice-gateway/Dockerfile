FROM python:3.12-slim
WORKDIR /gateway
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py gateway_core.py offline_asr.py recording_jobs.py ./
RUN useradd --system --uid 10001 voice
RUN mkdir /gateway/data && chown voice /gateway/data
USER voice
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--ws-max-size", "16384", "--limit-concurrency", "64"]
