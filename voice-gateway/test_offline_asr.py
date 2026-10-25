import importlib.util
import os
import tempfile
import unittest
import wave
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

import numpy as np

MODULE = Path(__file__).with_name('offline_asr.py')
if MODULE.is_file():
    spec = importlib.util.spec_from_file_location('offline_asr', MODULE)
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)
else:
    api = None


class OfflineASRTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(api, 'offline ASR implementation is missing')

    def test_unknown_overlapping_speakers_are_not_falsely_attributed(self):
        turns = api.speaker_intervals([(0, 4, 0), (2, 6, 1), (8, 10, 0)], 12)
        self.assertEqual(turns, [(0, 2, 'speaker-1'), (2, 4, 'unknown'), (4, 6, 'speaker-2'), (8, 10, 'speaker-1')])

    def test_ranges_are_bounded_and_long_turns_are_split_without_losing_audio(self):
        turns = api.speaker_intervals([(0, 60, 0)], 60)
        self.assertEqual(turns, [(start, min(start + 8, 60), 'speaker-1') for start in range(0, 60, 8)])
        with self.assertRaises(ValueError):
            api.speaker_intervals([(0, 61, 0)], 60)

    def test_invalid_speaker_count_and_injection_hotwords_are_rejected(self):
        with self.assertRaises(ValueError):
            api.validate_options({'speakerCount': 11})
        with self.assertRaises(ValueError):
            api.validate_options({'hotwords': [{'term': 'ok\nbad', 'aliases': [], 'enabled': True}]})
        checked = api.validate_options({'hotwords': [{'term': '澄光咖啡', 'aliases': ['晨光咖啡'], 'enabled': True}], 'dialect': 'cantonese'})
        self.assertEqual(checked['terms'], ['澄光咖啡'])
        self.assertEqual(checked['dialect'], 'cantonese')

    def test_missing_models_are_not_reported_as_available(self):
        with tempfile.TemporaryDirectory() as directory:
            engine = api.OfflineASR(model_dir=Path(directory) / 'asr', segmentation_path=Path(directory) / 'segment', embedding_path=Path(directory) / 'embed')
            caps = engine.capabilities()
            self.assertFalse(caps['available'])
            self.assertFalse(caps['diarization'])

    def test_silent_audio_does_not_load_asr_or_invent_words(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'silence.wav'
            with wave.open(str(path), 'wb') as wav:
                wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
                wav.writeframes(np.zeros(16000, dtype='<i2').tobytes())
            engine = api.OfflineASR(model_dir=Path(directory) / 'asr')
            with patch.object(engine, '_recognizer', side_effect=AssertionError('silence must not load model')):
                result = engine.transcribe(path, {'diarization': False})
            self.assertEqual(result['text'], '')
            self.assertEqual(result['segments'], [])
            self.assertFalse(result['diarization'])

    def test_model_receives_hotwords_at_construction_and_reuses_one_model(self):
        with tempfile.TemporaryDirectory() as directory:
            engine = api.OfflineASR(model_dir=Path(directory))
            with patch.object(engine, 'prompt_budget', return_value={'promptTokens': 64}), patch.object(engine, 'capabilities', return_value={'available': True}), patch.object(api.sherpa_onnx.OfflineRecognizer, 'from_funasr_nano', return_value=object()) as create:
                first = engine._recognizer(api.validate_options({'hotwords': [{'term': '澄光咖啡'}]}))
                self.assertEqual(create.call_args.kwargs['hotwords'], '澄光咖啡')
                self.assertEqual(create.call_args.kwargs['max_new_tokens'], 192)
                self.assertIs(engine._recognizer(api.validate_options({'hotwords': [{'term': '澄光咖啡'}]})), first)
                self.assertEqual(create.call_count, 1)
                engine._recognizer(api.validate_options({'hotwords': [{'term': '云栖园区'}]}))
                self.assertEqual(create.call_count, 2)
                self.assertEqual(create.call_args.kwargs['hotwords'], '云栖园区')

    def test_transcript_boundaries_are_audio_turns_not_synthetic_token_times(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'tone.wav'
            samples = (np.sin(np.arange(16000 * 3) * 2 * np.pi * 300 / 16000) * 1000).astype('<i2')
            with wave.open(str(path), 'wb') as wav:
                wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
                wav.writeframes(samples.tobytes())
            stream = SimpleNamespace(accept_waveform=lambda *args: None, result=SimpleNamespace(text='测试文字', timestamps=[99999]))
            recognizer = SimpleNamespace(create_stream=lambda: stream, decode_stream=lambda stream: None)
            turns = [SimpleNamespace(start=0.25, end=1.25, speaker=0), SimpleNamespace(start=1.5, end=2.5, speaker=1)]
            diarizer = SimpleNamespace(process=lambda *args, **kwargs: SimpleNamespace(sort_by_start_time=lambda: turns))
            engine = api.OfflineASR(model_dir=Path(directory))
            with patch.object(engine, 'capabilities', return_value={'diarization': True}), patch.object(engine, '_diarizer', return_value=diarizer), patch.object(engine, '_recognizer', return_value=recognizer):
                result = engine.transcribe(path, {'diarization': True})
            self.assertEqual([(part['start'], part['end'], part['speaker']) for part in result['segments']], [(0.25, 1.25, 'speaker-1'), (1.5, 2.5, 'speaker-2')])
            self.assertEqual(result['speakers'], [{'id': 'speaker-1', 'label': '讲话人1'}, {'id': 'speaker-2', 'label': '讲话人2'}])
            self.assertEqual(result['rawText'], '测试文字\n测试文字')

    def test_fixed_dialect_hint_reaches_model_with_hotwords(self):
        with tempfile.TemporaryDirectory() as directory:
            engine = api.OfflineASR(model_dir=Path(directory))
            with patch.object(engine, 'prompt_budget', return_value={'promptTokens': 64}), patch.object(engine, 'capabilities', return_value={'available': True}), patch.object(api.sherpa_onnx.OfflineRecognizer, 'from_funasr_nano', return_value=object()) as create:
                engine._recognizer(api.validate_options({'dialect': 'cantonese', 'hotwords': [{'term': '澄光咖啡'}]}))
                self.assertIn('粤语', create.call_args.kwargs['system_prompt'])
                self.assertEqual(create.call_args.kwargs['hotwords'], '澄光咖啡')
                self.assertEqual(create.call_args.kwargs['max_new_tokens'], 192)
                engine._recognizer(api.validate_options({'dialect': 'mandarin', 'hotwords': [{'term': '澄光咖啡'}]}))
                self.assertEqual(create.call_count, 2)

    def test_result_limit_includes_paragraph_breaks(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'tone.wav'
            samples = (np.sin(np.arange(16000 * 3) * 2 * np.pi * 300 / 16000) * 1000).astype('<i2')
            with wave.open(str(path), 'wb') as wav:
                wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
                wav.writeframes(samples.tobytes())
            stream = SimpleNamespace(accept_waveform=lambda *args: None, result=SimpleNamespace(text='字' * 50000))
            recognizer = SimpleNamespace(create_stream=lambda: stream, decode_stream=lambda stream: None)
            engine = api.OfflineASR(model_dir=Path(directory))
            with patch.object(api, 'energy_intervals', return_value=[(0, 1, 'unknown'), (1, 2, 'unknown')]), patch.object(engine, '_recognizer', return_value=recognizer):
                with self.assertRaises(ValueError):
                    engine.transcribe(path, {})

    def test_no_speakers_found_preserves_speech_as_unknown(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'tone.wav'
            samples = (np.sin(np.arange(16000 * 3) * 2 * np.pi * 300 / 16000) * 1000).astype('<i2')
            with wave.open(str(path), 'wb') as wav:
                wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
                wav.writeframes(samples.tobytes())
            stream = SimpleNamespace(accept_waveform=lambda *args: None, result=SimpleNamespace(text='没有丢弃的语音'))
            recognizer = SimpleNamespace(create_stream=lambda: stream, decode_stream=lambda stream: None)
            diarizer = SimpleNamespace(process=lambda *args, **kwargs: SimpleNamespace(sort_by_start_time=lambda: []))
            engine = api.OfflineASR(model_dir=Path(directory))
            with patch.object(engine, 'capabilities', return_value={'diarization': True}), patch.object(engine, '_diarizer', return_value=diarizer), patch.object(engine, '_recognizer', return_value=recognizer):
                result = engine.transcribe(path, {'diarization': True})
            self.assertEqual(result['text'], '没有丢弃的语音')
            self.assertEqual(result['segments'][0]['speaker'], 'unknown')
            self.assertFalse(result['diarization'])

    def test_budget_rejects_large_prompt_before_loading_the_llm(self):
        with tempfile.TemporaryDirectory() as directory:
            engine = api.OfflineASR(model_dir=Path(directory))
            engine._tokenizer = SimpleNamespace(encode=lambda text, **kwargs: SimpleNamespace(ids=list(range(300))))
            with self.assertRaisesRegex(ValueError, '启用热词过多'):
                engine.prompt_budget({'dialect': 'cantonese', 'hotwords': [{'term': '客户名称'}]})

    def test_actual_prompt_counts_system_dialect_hotwords_and_roles(self):
        with tempfile.TemporaryDirectory() as directory:
            engine = api.OfflineASR(model_dir=Path(directory))
            seen = []
            def encode(text, **kwargs):
                seen.append(text)
                return SimpleNamespace(ids=[1, 2, 3])
            engine._tokenizer = SimpleNamespace(encode=encode)
            budget = engine.prompt_budget({'dialect': 'cantonese', 'hotwords': [{'term': '澄光咖啡'}]})
            prompt = ''.join(seen)
            self.assertIn('粤语', prompt)
            self.assertIn('热词列表：[澄光咖啡]', prompt)
            self.assertIn('<|im_start|>system', prompt)
            self.assertIn('<|im_start|>assistant', prompt)
            self.assertEqual(budget['promptTokens'], 6)

    def test_token_ceiling_is_not_saved_as_a_complete_transcript(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'tone.wav'
            samples = (np.sin(np.arange(16000) * 2 * np.pi * 300 / 16000) * 1000).astype('<i2')
            with wave.open(str(path), 'wb') as wav:
                wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
                wav.writeframes(samples.tobytes())
            stream = SimpleNamespace(accept_waveform=lambda *args: None, result=SimpleNamespace(text='可能被截断的文字', tokens=['字'] * 192))
            recognizer = SimpleNamespace(create_stream=lambda: stream, decode_stream=lambda stream: None)
            engine = api.OfflineASR(model_dir=Path(directory))
            with patch.object(engine, '_recognizer', return_value=recognizer):
                with self.assertRaisesRegex(ValueError, '输出上限'):
                    engine.transcribe(path, {})


if __name__ == '__main__':
    unittest.main()
