"""Verify an existing audio clip via the real local workbench and ASR queue.

Creates a clearly named test project in the loopback development account. No
identity headers, direct database writes, microphone or external audio upload.
"""
import argparse
import json
from pathlib import Path
import time
from urllib.parse import urlsplit

import httpx


def run(args):
    url = urlsplit(args.root)
    if url.scheme != 'http' or url.hostname not in {'127.0.0.1', 'localhost', '::1'}:
        raise ValueError('This validation script accepts only the local workbench')
    started = time.monotonic()
    with httpx.Client(base_url=args.root, follow_redirects=True, timeout=100, trust_env=False) as client:
        client.get('/signin-with-chatgpt?returnTo=%2F').raise_for_status()
        for attempt in range(15):
            settings = client.get('/api/speech-settings')
            settings.raise_for_status()
            if settings.json()['capabilities']['available']:
                break
            if attempt == 14:
                raise RuntimeError('Local recording models are not ready')
            time.sleep(1)
        response = client.get('/api/workbench')
        response.raise_for_status()
        state = response.json()
        title = '录音转写功能验证（本地测试）'
        project = next((item for item in state['deals'] if item.get('projectName') == title), None)
        if project is None:
            created = client.post('/api/workbench', json={'revision': state['revision'], 'action': 'deal_create', 'payload': {'projectName': title, 'name': '语音功能验证资料', 'contact': '测试录音', 'industry': '功能验证'}})
            created.raise_for_status()
            state = created.json()['state']
            project = next(item for item in state['deals'] if item.get('projectName') == title)
        existing = next((note['recording'] for note in reversed(project['notes']) if note.get('recording', {}).get('name') == args.audio.name), None)
        if existing:
            retry = client.post('/api/recording-transcriptions', json={'dealId': project['id'], 'recordingId': existing['id'], 'action': 'retry'})
            retry.raise_for_status()
            job = retry.json().get('job')
        else:
            with args.audio.open('rb') as source:
                upload = client.post('/api/deal-recordings', data={'dealId': project['id'], 'text': '语音识别功能验证素材，不作为真实客户或销售业绩。', 'revision': str(state['revision'])}, files={'audio': (args.audio.name, source, 'audio/wav')})
            upload.raise_for_status()
            job = upload.json().get('transcription')
        if not job:
            raise RuntimeError('Recording saved but automatic transcription was not submitted')
        previous = None
        while time.monotonic() - started < args.timeout:
            response = client.get('/api/recording-transcriptions', params={'dealId': project['id'], 'id': job['recordingId']})
            response.raise_for_status()
            job = response.json()['job']
            status = (job['status'], job['progress'])
            if status != previous:
                print(json.dumps({'status': status[0], 'progress': status[1]}, ensure_ascii=False), flush=True)
                previous = status
            if job['status'] == 'failed':
                raise RuntimeError(job['message'])
            if job['status'] == 'completed' and job.get('linked'):
                state = client.get('/api/workbench').json()
                source = next((item for item in state.get('transcripts', []) if item['id'] == 'transcript-asr-' + job['recordingId']), None)
                if not source:
                    raise RuntimeError('Completed job was not persisted to project transcripts')
                summary = {'audio': str(args.audio.resolve()), 'projectId': project['id'], 'recordingId': job['recordingId'], 'jobId': job['id'], 'status': job['status'], 'linked': True, 'durationSeconds': job['result']['durationSeconds'], 'elapsedSeconds': round(time.monotonic()-started, 2), 'characters': len(job['result']['text']), 'segments': len(job['result']['segments']), 'speakers': len(job['result']['speakers']), 'model': job['result']['model'], 'dialectHint': job['result']['dialectHint'], 'hotwordVersion': job['result']['hotwordVersion'], 'result': job['result']}
                args.output.parent.mkdir(parents=True, exist_ok=True)
                args.output.write_text(json.dumps(summary, ensure_ascii=False, indent=2)+'\n')
                print(json.dumps({key: value for key, value in summary.items() if key != 'result'}, ensure_ascii=False), flush=True)
                return
            time.sleep(2)
        raise TimeoutError('Local transcription smoke check timed out; original audio remains saved')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default='http://127.0.0.1:5173')
    parser.add_argument('--audio', type=Path, required=True)
    parser.add_argument('--timeout', type=int, default=300)
    parser.add_argument('--output', type=Path, required=True)
    run(parser.parse_args())
