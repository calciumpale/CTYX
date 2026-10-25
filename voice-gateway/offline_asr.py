"""Local CPU recording ASR. Speaker timestamps come from audio segmentation.

FunASR Nano's token timestamps are uniformly interpolated, not forced alignment;
we deliberately never use them to assign speakers or advertise word timing.
"""
from __future__ import annotations

import gc
import math
import os
from pathlib import Path
import threading
import wave

import numpy as np
import sherpa_onnx

MODEL_NAME = 'FunASR-Nano-2512 int8 + pyannote / 3D-Speaker'
DIALECT_NAMES = {'auto': '', 'mandarin': '普通话', 'cantonese': '粤语', 'wu': '吴语', 'min': '闽语', 'hakka': '客家话', 'gan': '赣语', 'xiang': '湘语', 'jin': '晋语'}
DIALECTS = list(DIALECT_NAMES)
MAX_SEGMENTS = 6000
MAX_TEXT = 100_000
MAX_DURATION = 2 * 60 * 60
# The pinned ONNX model has max_total_len=512. Audio <=8s is bounded
# at 160 tokens; reserve 192 output tokens and 32 safety tokens.
MAX_PROMPT_TOKENS = 128


def validate_options(options):
    if not isinstance(options, dict):
        raise ValueError('录音转写选项须为对象')
    dialect = options.get('dialect', 'auto')
    if dialect not in DIALECTS:
        raise ValueError('不支持的方言提示')
    count = options.get('speakerCount')
    if count is not None and (type(count) is not int or not 1 <= count <= 10):
        raise ValueError('讲话人数须介于1至10之间')
    diarization = options.get('diarization', False)
    if type(diarization) is not bool:
        raise ValueError('讲话人区分选项无效')
    version = options.get('hotwordVersion', 0)
    if type(version) is not int or version < 0:
        raise ValueError('热词版本无效')
    entries = options.get('hotwords', [])
    if not isinstance(entries, list) or len(entries) > 50:
        raise ValueError('单次转写最多使用50个热词')
    terms = []
    for entry in entries:
        if not isinstance(entry, dict) or type(entry.get('enabled', True)) is not bool:
            raise ValueError('热词格式无效')
        term, aliases = entry.get('term'), entry.get('aliases', [])
        if not isinstance(term, str) or not 1 <= len(term.strip()) <= 40 or any(ord(c) < 32 for c in term) or ',' in term or '，' in term:
            raise ValueError('热词须为1至40字，且不能包含控制字符或逗号')
        if not isinstance(aliases, list) or len(aliases) > 5 or any(not isinstance(alias, str) or not 1 <= len(alias.strip()) <= 40 or any(ord(c) < 32 for c in alias) for alias in aliases):
            raise ValueError('每个热词最多设置5个1至40字的易错写法')
        if entry.get('enabled', True) and term.strip() not in terms:
            terms.append(term.strip())
    return {'dialect': dialect, 'speakerCount': count, 'diarization': diarization, 'hotwordVersion': version, 'terms': terms}


def model_prompts(options):
    dialect = options['dialect']
    system = ('你是忠实的语音转写助手。音频可能为' + DIALECT_NAMES[dialect] + '，请按原意转写，不要补写没有听到的内容。') if dialect != 'auto' else 'You are a helpful assistant.'
    user = ('语音转写，音频可能为' + DIALECT_NAMES[dialect] + '，请按原意转写：') if dialect != 'auto' else '语音转写：'
    # Match v1.13.8 BuildUserPrompt: nonempty hotwords override user_prompt,
    # while the fixed dialect hint is still carried by system_prompt.
    effective = user
    if options['terms']:
        effective = '请结合上下文信息，更加准确地完成语音转写任务。如果没有相关信息，我们会留空。\n\n\n**上下文信息：**\n\n\n热词列表：[' + ', '.join(options['terms']) + ']\n语音转写：'
    return system, user, effective


def _split_interval(start, end, speaker, max_seconds=8):
    result = []
    while end - start > 0.001:
        stop = min(end, start + max_seconds)
        result.append((start, stop, speaker))
        start = stop
    return result


def speaker_intervals(raw_turns, duration):
    """Resolve overlapping model turns to unknown, retaining measured boundaries."""
    events = {}
    speaker_ids = {}
    for start, end, speaker in sorted(raw_turns, key=lambda turn: (turn[0], turn[1])):
        if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in (start, end)) or start < 0 or end <= start or end > duration + 0.05:
            raise ValueError('讲话人分段时间范围异常')
        start, end = float(start), min(float(end), duration)
        if type(speaker) is not int or speaker < 0:
            label = 'unknown'
        else:
            if speaker not in speaker_ids:
                speaker_ids[speaker] = f'speaker-{len(speaker_ids) + 1}'
            label = speaker_ids[speaker]
        events.setdefault(start, []).append((label, 1))
        events.setdefault(end, []).append((label, -1))
    active, intervals, previous = {}, [], None
    for point in sorted(events):
        if previous is not None and point > previous and active:
            label = next(iter(active)) if len(active) == 1 else 'unknown'
            if intervals and intervals[-1][2] == label and abs(intervals[-1][1] - previous) < 0.001:
                intervals[-1] = (intervals[-1][0], point, label)
            else:
                intervals.append((previous, point, label))
        for label, change in events[point]:
            active[label] = active.get(label, 0) + change
            if active[label] <= 0:
                del active[label]
        previous = point
    result = [part for start, end, speaker in intervals for part in _split_interval(start, end, speaker)]
    if len(result) > MAX_SEGMENTS:
        raise ValueError('录音分段超过6000段，请分批转写')
    return result


def energy_intervals(samples, sample_rate):
    """Energy gate for quiet intervals; it is not a learned speaker model."""
    frame = int(sample_rate * 0.02)
    intervals, start, last_loud = [], None, None
    for offset in range(0, len(samples), frame):
        block = samples[offset:offset + frame]
        level = float(np.sqrt(np.mean(block * block))) if len(block) else 0
        if level >= 0.004:
            if start is None:
                start = max(0, offset / sample_rate - 0.15)
            last_loud = min(len(samples) / sample_rate, (offset + len(block)) / sample_rate)
        elif start is not None and offset / sample_rate - last_loud >= 0.5:
            intervals.extend(_split_interval(start, min(len(samples) / sample_rate, last_loud + 0.15), 'unknown'))
            start = last_loud = None
    if start is not None:
        intervals.extend(_split_interval(start, min(len(samples) / sample_rate, last_loud + 0.15), 'unknown'))
    if len(intervals) > MAX_SEGMENTS:
        raise ValueError('录音分段超过6000段，请分批转写')
    return intervals


class OfflineASR:
    def __init__(self, *, model_dir=None, segmentation_path=None, embedding_path=None):
        base = Path(__file__).resolve().parent / 'models'
        self.model_dir = Path(model_dir or os.environ.get('RECORDING_ASR_MODEL_DIR', base / 'funasr-nano'))
        self.segmentation_path = Path(segmentation_path or os.environ.get('RECORDING_SEGMENTATION_MODEL', base / 'diarization/segmentation.onnx'))
        self.embedding_path = Path(embedding_path or os.environ.get('RECORDING_EMBEDDING_MODEL', base / 'diarization/embedding.onnx'))
        self.num_threads = int(os.environ.get('RECORDING_ASR_NUM_THREADS', '2'))
        if not 1 <= self.num_threads <= 4:
            raise ValueError('录音转写线程数须介于1至4之间')
        self.speaker_threshold = float(os.environ.get('RECORDING_SPEAKER_THRESHOLD', '0.9'))
        if not math.isfinite(self.speaker_threshold) or not 0.1 <= self.speaker_threshold <= 2:
            raise ValueError('讲话人聚类阈值须介于0.1至2之间')
        self.lock = threading.Lock()
        self._asr = None
        self._asr_key = None
        self._sd = None
        self._tokenizer = None

    def capabilities(self):
        required = ['encoder_adaptor.int8.onnx', 'llm.int8.onnx', 'embedding.int8.onnx', 'Qwen3-0.6B/tokenizer.json', 'Qwen3-0.6B/vocab.json', 'Qwen3-0.6B/merges.txt']
        available = all((self.model_dir / name).is_file() and (self.model_dir / name).stat().st_size > 0 for name in required)
        speakers = all(path.is_file() and path.stat().st_size > 0 for path in [self.segmentation_path, self.embedding_path])
        return {'available': available, 'model': MODEL_NAME, 'dialects': DIALECTS if available else [], 'hotwords': available, 'diarization': speakers and available, 'wordTimestamps': False, 'maxSpeakers': 10, 'maxHotwords': 50, 'contextTokens': 512, 'maxPromptTokens': MAX_PROMPT_TOKENS, 'maxSegmentSeconds': 8}

    def prompt_budget(self, options):
        checked = validate_options(options)
        if self._tokenizer is None:
            from tokenizers import Tokenizer
            path = self.model_dir / 'Qwen3-0.6B/tokenizer.json'
            if not path.is_file():
                raise ValueError('录音转写模型尚未安装')
            self._tokenizer = Tokenizer.from_file(str(path))
        system, _user, effective = model_prompts(checked)
        before = '<|im_start|>system\n' + system + '<|im_end|>\n<|im_start|>user\n' + effective
        after = '<|im_end|>\n<|im_start|>assistant\n'
        count = len(self._tokenizer.encode(before, add_special_tokens=False).ids) + len(self._tokenizer.encode(after, add_special_tokens=False).ids)
        if count > MAX_PROMPT_TOKENS:
            raise ValueError('启用热词过多，请在语音设置中减少启用的词条')
        return {'promptTokens': count, 'maxPromptTokens': MAX_PROMPT_TOKENS, 'contextTokens': 512, 'reservedAudioTokens': 160, 'reservedOutputTokens': 192, 'safetyTokens': 32, 'maxSegmentSeconds': 8}

    def _recognizer(self, options):
        # Version 1.13.8 ignores per-stream FunASR hotwords. Rebuild one shared
        # recognizer when words change, releasing the previous model first.
        self.prompt_budget({'dialect': options['dialect'], 'hotwords': [{'term': term} for term in options['terms']]})
        system, user, _effective = model_prompts(options)
        key = (options['dialect'], tuple(options['terms']))
        if self._asr is None or key != self._asr_key:
            self._asr = None
            self._asr_key = None
            gc.collect()
            if not self.capabilities()['available']:
                raise ValueError('录音转写模型尚未安装，请先运行setup-asr-models.py')
            self._asr = sherpa_onnx.OfflineRecognizer.from_funasr_nano(
                encoder_adaptor=str(self.model_dir / 'encoder_adaptor.int8.onnx'),
                llm=str(self.model_dir / 'llm.int8.onnx'),
                embedding=str(self.model_dir / 'embedding.int8.onnx'),
                tokenizer=str(self.model_dir / 'Qwen3-0.6B'),
                num_threads=self.num_threads, provider='cpu',
                system_prompt=system, user_prompt=user,
                language='', itn=True, hotwords=','.join(options['terms']),
                max_new_tokens=192, temperature=1e-6,
            )
            self._asr_key = key
        return self._asr

    def _diarizer(self, speaker_count):
        config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
            segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(self.segmentation_path)),
                num_threads=self.num_threads, provider='cpu'),
            embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(self.embedding_path), num_threads=self.num_threads, provider='cpu'),
            clustering=sherpa_onnx.FastClusteringConfig(num_clusters=speaker_count if speaker_count is not None else -1, threshold=self.speaker_threshold, compute_confidence=True),
            min_duration_on=0.3, min_duration_off=0.5,
        )
        if not config.validate():
            raise ValueError('讲话人模型配置无效或缺失')
        if self._sd is None:
            self._sd = sherpa_onnx.OfflineSpeakerDiarization(config)
        else:
            self._sd.set_config(config)
        return self._sd

    def transcribe(self, wav_path, options, progress_callback=None):
        checked = validate_options(options)
        def report(value):
            if progress_callback:
                progress_callback(value)
        with self.lock:
            report(0)
            with wave.open(str(wav_path), 'rb') as source:
                if source.getnchannels() != 1 or source.getsampwidth() != 2 or source.getframerate() != 16000 or source.getcomptype() != 'NONE':
                    raise ValueError('录音解码须为16kHz单声道PCM16 WAV')
                frames = source.getnframes()
                duration = frames / 16000
                if duration <= 0 or duration > MAX_DURATION:
                    raise ValueError('录音时长须介于0至2小时之间')
                data = source.readframes(frames)
                if len(data) != frames * 2:
                    raise ValueError('录音文件已截断')
            samples = np.frombuffer(data, dtype='<i2').astype(np.float32) / 32768
            del data
            speech = energy_intervals(samples, 16000)
            if checked['diarization'] and not self.capabilities()['diarization']:
                raise ValueError('讲话人区分模型尚未安装')
            diarization_success = False
            if checked['diarization'] and speech:
                diarizer = self._diarizer(checked['speakerCount'])
                def speaker_progress(done, total):
                    report(min(0.4, 0.4 * done / max(total, 1)))
                    return 0
                turns = diarizer.process(samples, callback=speaker_progress).sort_by_start_time()
                measured = speaker_intervals([(turn.start, turn.end, turn.speaker) for turn in turns], duration)
                if measured:
                    speech = measured
                    diarization_success = True
                # A short clip may contain clear speech but no reliable speaker
                # embedding. Preserve its energy-gated audio with unknown speaker.
            report(0.4)
            segments, total_text = [], 0
            # Skip silent files without loading the large model or generating
            # prompt-biased transcript hallucinations.
            recognizer = self._recognizer(checked) if speech else None
            for index, (start, end, speaker) in enumerate(speech):
                segment = samples[int(start * 16000):min(len(samples), int(end * 16000))]
                if len(segment) and float(np.sqrt(np.mean(segment * segment))) >= 0.004:
                    stream = recognizer.create_stream()
                    stream.accept_waveform(16000, segment)
                    recognizer.decode_stream(stream)
                    if len(getattr(stream.result, 'tokens', [])) >= 192:
                        raise ValueError('片段转写达到模型输出上限，请缩短录音后重试，避免保存不完整的文字')
                    text = stream.result.text.strip()
                    if text:
                        total_text += len(text) + (1 if segments else 0)
                        if total_text > MAX_TEXT:
                            raise ValueError('录音转写超过100000字，请分批转写')
                        segments.append({'start': round(start, 3), 'end': round(end, 3), 'speaker': speaker, 'text': text, 'rawText': text})
                report(0.4 + 0.6 * (index + 1) / max(len(speech), 1))
            text = '\n'.join(segment['text'] for segment in segments)
            ids = list(dict.fromkeys(segment['speaker'] for segment in segments if segment['speaker'] != 'unknown'))
            speakers = [{'id': speaker, 'label': '讲话人' + speaker.removeprefix('speaker-')} for speaker in ids]
            report(1)
            return {'text': text, 'rawText': text, 'segments': segments, 'speakers': speakers, 'corrections': [], 'model': MODEL_NAME if diarization_success else 'FunASR-Nano-2512 int8', 'durationSeconds': round(duration, 3), 'dialectHint': checked['dialect'], 'diarization': diarization_success, 'hotwordVersion': checked['hotwordVersion']}
