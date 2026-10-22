#!/usr/bin/env python3
"""All Round AI ASR sidecar.

The Node runtime spawns this file with no arguments, writes one JSON request to
stdin and reads one JSON line from stdout. Progress and errors from libraries go
to stderr so the single stdout line stays machine readable.

Request:
  {"audio": "<16 kHz mono wav>", "model": "<CT2 dir or empty>",
   "language": "auto|zh|en|yue", "vad": true, "words": true, "threads": 4}

Response (success):
  {"ok": true, "engine": "...", "language": "zh", "language_probability": 0.99,
   "duration": 12.3, "elapsed": 4.1,
   "segments": [{"start": 0.0, "end": 2.4, "text": "你好", "words": [...]}]}
"""

import json
import os
import sys
import time


def respond(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    try:
        request = json.loads(sys.stdin.read() or "{}")
    except ValueError as error:
        respond({"ok": False, "error": "请求不是合法 JSON：%s" % error})
        return

    audio = request.get("audio") or ""
    if not audio or not os.path.isfile(audio):
        respond({"ok": False, "error": "找不到待识别的音频文件"})
        return

    language = request.get("language") or "auto"
    if language == "auto":
        language = None
    model_dir = request.get("model") or ""
    threads = int(request.get("threads") or 4)

    try:
        from faster_whisper import WhisperModel
    except Exception as error:  # the runtime reports the install hint
        respond({"ok": False, "error": "faster-whisper 不可用：%s" % error})
        return

    try:
        started = time.time()
        if model_dir and os.path.isdir(model_dir):
            model = WhisperModel(
                model_dir,
                device="cpu",
                compute_type="int8",
                cpu_threads=threads,
                local_files_only=True,
            )
            engine = "local:%s" % os.path.basename(os.path.normpath(model_dir))
        else:
            size = request.get("size") or "small"
            cache = os.environ.get("ALLROUND_AI_WHISPER_CACHE") or None
            model = WhisperModel(
                size,
                device="cpu",
                compute_type="int8",
                cpu_threads=threads,
                download_root=cache,
            )
            engine = "faster-whisper:%s" % size

        segments, info = model.transcribe(
            audio,
            language=language,
            vad_filter=bool(request.get("vad", True)),
            word_timestamps=bool(request.get("words", True)),
            beam_size=5,
        )

        collected = []
        for segment in segments:
            words = []
            if getattr(segment, "words", None):
                words = [
                    {
                        "start": round(float(word.start), 3),
                        "end": round(float(word.end), 3),
                        "word": word.word,
                    }
                    for word in segment.words
                ]
            text = (segment.text or "").strip()
            if not text:
                continue
            collected.append(
                {
                    "start": round(float(segment.start), 3),
                    "end": round(float(segment.end), 3),
                    "text": text,
                    "words": words,
                }
            )

        respond(
            {
                "ok": True,
                "engine": engine,
                "language": getattr(info, "language", None),
                "language_probability": round(float(getattr(info, "language_probability", 0) or 0), 4),
                "duration": round(float(getattr(info, "duration", 0) or 0), 3),
                "elapsed": round(time.time() - started, 2),
                "segments": collected,
            }
        )
    except Exception as error:
        respond({"ok": False, "error": str(error).splitlines()[0][:500]})


if __name__ == "__main__":
    main()
