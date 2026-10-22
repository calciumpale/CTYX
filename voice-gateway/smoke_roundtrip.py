"""Real local Worker -> WSS protocol -> native ASR/TTS smoke, using synthetic WAV.

Never opens the microphone. Local sign-in is the dev plugin's synthetic account.
"""
import argparse
import asyncio
import json
import re
import time
import uuid
import wave
from pathlib import Path

import httpx
import numpy as np
import websockets


async def main(wav_path, output_dir, run_id):
    root = 'http://127.0.0.1:5173'
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    async with httpx.AsyncClient(base_url=root, headers={'Cookie':'__sites_local_auth=1; ctai_experience_role=sales','Origin':root}, timeout=40,trust_env=False) as api:
        async def action(name, payload):
            state=(await api.get('/api/workbench')).json()
            response=await api.post('/api/workbench',json={'action':name,'payload':payload,'revision':state['revision']})
            response.raise_for_status()
            return response.json()
        started=await action('training_start',{'scenario':'首访剧本 · 本地合成音频验证'})
        session=started['session']
        credential=await api.post('/api/training-voice',json={'sessionId':session['id']})
        credential.raise_for_status()
        configuration=credential.json()
        with wave.open(str(wav_path)) as source:
            if source.getsampwidth()!=2 or source.getnchannels()!=1:
                raise ValueError('Expected mono PCM16 synthetic WAV')
            rate=source.getframerate()
            samples=np.frombuffer(source.readframes(source.getnframes()),dtype='<i2').astype(np.float32)
        samples=np.interp(np.arange(int(len(samples)*16000/rate))*rate/16000,np.arange(len(samples)),samples).astype('<i2')
        pcm=samples.tobytes()+bytes(16000*2*2)
        measurements={'runId':run_id,'syntheticInput':str(wav_path),'microphoneUsed':False,'sessionId':session['id']}
        async with websockets.connect(configuration['url'],origin=root,max_size=128*1024,proxy=None) as socket:
            await socket.send(json.dumps({'type':'session.start','token':configuration['token']}))
            ready=json.loads(await socket.recv())
            if ready.get('type')!='session.ready':
                raise RuntimeError('Gateway did not complete authenticated handshake')
            measurements['availableVoices']=len(ready['voices'])
            voice=ready['defaultVoice']
            spoken=lambda text:re.sub(r'^\s*[（(]\s*演示客户\s*[）)]\s*[:：]?\s*','',text).strip()
            await socket.send(json.dumps({'type':'output.speak','id':str(uuid.uuid4()),'text':spoken(session['messages'][0]['content']),'voice':voice,'rate':1}))
            # Begin synthetic speech while customer audio is already being streamed.
            while True:
                first=await asyncio.wait_for(socket.recv(),30)
                if isinstance(first,bytes):
                    break
                event=json.loads(first)
                if event['type']=='session.error':
                    raise RuntimeError(event['message'])
            began=time.monotonic()
            async def send_input():
                for at in range(0,len(pcm),640):
                    await socket.send(pcm[at:at+640])
                    await asyncio.sleep(.02)
            sender=asyncio.create_task(send_input())
            interrupted=False
            cancelled=False
            final=None
            try:
                async with asyncio.timeout(45):
                    while final is None:
                        data=await socket.recv()
                        if isinstance(data,bytes):
                            continue
                        event=json.loads(data)
                        if event['type']=='input.speech.started':
                            interrupted=True
                            measurements['speechStartSeconds']=round(time.monotonic()-began,3)
                        elif event['type']=='output.cancelled':
                            cancelled=True
                        elif event['type']=='input.final':
                            final=event
                        elif event['type']=='session.error':
                            raise RuntimeError(event['message'])
            finally:
                await sender
            if not interrupted or not cancelled or not final['text'].strip():
                raise RuntimeError('Expected recognition and barge-in during customer playback')
            measurements['customerPlaybackCancelledOnSpeech']=True
            measurements['recognizedText']=final['text']
            measurements['finalSeconds']=round(time.monotonic()-began,3)
            payload={'sessionId':session['id'],'text':final['text'],'voiceTurnId':'duplex:'+final['id']}
            saved=await action('training_reply',payload)
            retry=await action('training_reply',payload)
            if len(retry['session']['messages'])!=3:
                raise RuntimeError('Voice turn was not idempotent')
            measurements['savedUserTurns']=1
            await socket.send(json.dumps({'type':'output.speak','id':str(uuid.uuid4()),'text':spoken(saved['session']['messages'][-1]['content']),'voice':voice,'rate':1}))
            audio=[]
            async with asyncio.timeout(90):
                while True:
                    data=await socket.recv()
                    if isinstance(data,bytes):
                        audio.append(data)
                    else:
                        event=json.loads(data)
                        if event['type']=='output.finished':
                            break
                        if event['type']=='session.error':
                            raise RuntimeError(event['message'])
            if not audio:
                raise RuntimeError('Customer response had no audio')
            audio_path=output/f'customer-roundtrip-{run_id}.wav'
            with wave.open(str(audio_path),'wb') as target:
                target.setparams((1,2,24000,0,'NONE','not compressed'))
                target.writeframes(b''.join(audio))
            measurements['customerAudioSeconds']=round(sum(map(len,audio))/48000,3)
            measurements['customerAudioFile']=str(audio_path)
            measurements['customerReply']=saved['session']['messages'][-1]['content']
        await action('training_finish',{'sessionId':session['id']})
        measurements['result']='passed'
        (output/'roundtrip.json').write_text(json.dumps(measurements,ensure_ascii=False,indent=2))
        print(json.dumps(measurements,ensure_ascii=False))


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--wav',required=True)
    parser.add_argument('--output-dir',default='../outputs/qa/local-voice')
    args=parser.parse_args()
    run_id=uuid.uuid4().hex
    report=Path(args.output_dir)/'roundtrip.json'
    report.parent.mkdir(parents=True,exist_ok=True)
    report.write_text(json.dumps({'runId':run_id,'result':'running','microphoneUsed':False}))
    try:
        asyncio.run(main(args.wav,args.output_dir,run_id))
    except BaseException as error:
        report.write_text(json.dumps({'runId':run_id,'result':'failed','errorType':type(error).__name__,'microphoneUsed':False}))
        raise
