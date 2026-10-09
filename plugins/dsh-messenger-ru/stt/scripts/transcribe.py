#!/usr/bin/env python3
"""Unified local STT runner for dsh-messenger (patch 2026-10-03).

Usage: transcribe.py <vosk|tone|gigaam> <audio-file>
Audio may be ogg/opus/wav/m4a — ffmpeg converts it to 16 kHz mono wav.
Prints the recognized text to stdout.

Engines:
  vosk   — /opt/stt/vosk (vosk-model-small-ru-0.22, ~88 MB, lazy)
  tone   — /opt/stt/tone, sherpa-onnx streaming T-one (T-Bank), on demand (~138 MB)
  gigaam — /opt/stt/gigaam, sherpa-onnx offline GigaAM v2 CTC int8 (Sber), on demand (~226 MB)
"""
import json
import os
import subprocess
import sys
import tempfile
import wave
from array import array

VOSK_MODEL = "/opt/stt/vosk"
TONE_DIR = "/opt/stt/tone"
GIGA_DIR = "/opt/stt/gigaam"


def to_wav16k(src: str) -> str:
    """Convert any input audio to 16 kHz mono s16 wav in a temp file."""
    out = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", src,
         "-ac", "1", "-ar", "16000", "-sample_fmt", "s16", out],
        check=True,
    )
    return out


def samples_from_wav(path: str):
    """Return (sample_rate, samples as list of floats)."""
    wf = wave.open(path, "rb")
    sr = wf.getframerate()
    raw = array("h")
    raw.frombytes(wf.readframes(wf.getnframes()))
    wf.close()
    return sr, [s / 32768.0 for s in raw]


def run_vosk(wav_path: str) -> str:
    from vosk import Model, KaldiRecognizer
    wf = wave.open(wav_path, "rb")
    try:
        model = Model(VOSK_MODEL)
        rec = KaldiRecognizer(model, wf.getframerate())
        rec.SetWords(False)
        while True:
            data = wf.readframes(4000)
            if not data:
                break
            rec.AcceptWaveform(data)
        return json.loads(rec.FinalResult()).get("text", "").strip()
    finally:
        wf.close()


def run_tone(wav_path: str) -> str:
    import sherpa_onnx
    recognizer = sherpa_onnx.OnlineRecognizer.from_t_one_ctc(
        model=f"{TONE_DIR}/model.onnx",
        tokens=f"{TONE_DIR}/tokens.txt",
    )
    sr, samples = samples_from_wav(wav_path)
    stream = recognizer.create_stream()
    stream.accept_waveform(sr, samples)
    while recognizer.is_ready(stream):
        recognizer.decode_stream(stream)
    stream.input_finished()
    while recognizer.is_ready(stream):
        recognizer.decode_stream(stream)
    return recognizer.get_result(stream).strip()


def run_gigaam(wav_path: str) -> str:
    import sherpa_onnx
    recognizer = sherpa_onnx.OfflineRecognizer.from_nemo_ctc(
        model=f"{GIGA_DIR}/model.int8.onnx",
        tokens=f"{GIGA_DIR}/tokens.txt",
        num_threads=1,
    )
    sr, samples = samples_from_wav(wav_path)
    stream = recognizer.create_stream()
    stream.accept_waveform(sr, samples)
    recognizer.decode_stream(stream)
    return stream.result.text.strip()


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: transcribe.py <vosk|tone|gigaam> <audio>", file=sys.stderr)
        return 2
    engine, src = sys.argv[1], sys.argv[2]
    if engine == "local":
        engine = "vosk"  # bridge mode name alias
    runners = {"vosk": run_vosk, "tone": run_tone, "gigaam": run_gigaam}
    if engine not in runners:
        print(f"unknown engine: {engine}", file=sys.stderr)
        return 2
    wav = to_wav16k(src)
    try:
        print(runners[engine](wav))
    finally:
        try:
            os.unlink(wav)
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
