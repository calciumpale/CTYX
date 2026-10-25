#!/usr/bin/env python3
"""Fetch pinned official CPU ASR/diarization artifacts; never upload recordings."""
import argparse
import hashlib
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/'
ASR_NAME = 'sherpa-onnx-funasr-nano-int8-2025-12-30'
ASR_ARCHIVE = ASR_NAME + '.tar.bz2'
SEG_NAME = 'sherpa-onnx-pyannote-segmentation-3-0'
SEG_ARCHIVE = SEG_NAME + '.tar.bz2'
EMBEDDING = '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx'


def fetch(url, target, size, sha256=None):
    if target.is_file() and target.stat().st_size == size:
        if not sha256 or digest(target) == sha256:
            return
    part = target.with_suffix(target.suffix + '.part')
    if part.is_file() and part.stat().st_size > size:
        part.unlink()
    print('下载官方模型:', target.name, flush=True)
    subprocess.run(['curl', '--fail', '--silent', '--show-error', '--location', '--retry', '3', '--retry-delay', '2', '--connect-timeout', '20', '--speed-limit', '16384', '--speed-time', '60', '--max-time', '1200', '--continue-at', '-', '--output', str(part), url], check=True)
    if part.stat().st_size != size:
        raise RuntimeError(f'下载文件大小校验失败: {target.name}')
    if sha256 and digest(part) != sha256:
        part.unlink()
        raise RuntimeError(f'下载文件 SHA256 校验失败: {target.name}')
    part.replace(target)


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def extract(archive, destination, prefix):
    with tarfile.open(archive, 'r:bz2') as source:
        for member in source.getmembers():
            relative = Path(member.name)
            if relative.is_absolute() or '..' in relative.parts or not relative.parts or relative.parts[0] != prefix or member.issym() or member.islnk():
                raise RuntimeError('模型归档包含不安全路径')
            if member.isdir():
                continue
            if not member.isfile():
                raise RuntimeError('模型归档包含不支持的文件类型')
            target = destination.joinpath(*relative.parts[1:])
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.extractfile(member) as content, target.open('wb') as output:
                shutil.copyfileobj(content, output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--models-dir', type=Path, default=Path(__file__).resolve().parent / 'models')
    args = parser.parse_args()
    root = args.models_dir.resolve()
    root.mkdir(parents=True, exist_ok=True)
    # Downloads are resumable by rerunning and complete artifacts are retained.
    downloads = root / '.downloads'
    downloads.mkdir(exist_ok=True)
    asr = root / 'funasr-nano'
    wanted = ['encoder_adaptor.int8.onnx', 'llm.int8.onnx', 'embedding.int8.onnx', 'Qwen3-0.6B/tokenizer.json']
    if not all((asr / name).is_file() for name in wanted):
        archive = downloads / ASR_ARCHIVE
        fetch(BASE + 'asr-models/' + ASR_ARCHIVE, archive, 841730611, 'eb43d7ccc2e86b243f6a03b7df361033dda66db9523d1a92bf6aca2b50c9476b')
        with tempfile.TemporaryDirectory(dir=root, prefix='.asr-') as temporary:
            staging = Path(temporary) / 'model'
            staging.mkdir()
            extract(archive, staging, ASR_NAME)
            if not all((staging / name).is_file() for name in wanted):
                raise RuntimeError('ASR模型归档缺少必需文件')
            if asr.exists():
                shutil.rmtree(asr)
            staging.replace(asr)
        archive.unlink()
    diarization = root / 'diarization'
    diarization.mkdir(exist_ok=True)
    segmentation = diarization / 'segmentation.onnx'
    if not segmentation.is_file() or segmentation.stat().st_size < 5_000_000:
        archive = downloads / SEG_ARCHIVE
        fetch(BASE + 'speaker-segmentation-models/' + SEG_ARCHIVE, archive, 6958444, '24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488')
        with tempfile.TemporaryDirectory(dir=root, prefix='.seg-') as temporary:
            extract(archive, Path(temporary), SEG_NAME)
            shutil.copy2(Path(temporary) / 'model.onnx', segmentation)
            for name in ['LICENSE', 'README.md']:
                source = Path(temporary) / name
                if source.is_file():
                    shutil.copy2(source, diarization / ('segmentation-' + name))
        archive.unlink()
    fetch(BASE + 'speaker-recongition-models/' + EMBEDDING, diarization / 'embedding.onnx', 39593761, '1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b')
    print('CPU录音转写与讲话人模型已就绪:', root)


if __name__ == '__main__':
    main()
