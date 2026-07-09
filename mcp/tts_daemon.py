#!/usr/bin/env python3
"""Muse Machine neural TTS daemon.

Loads Kokoro (open-weights neural TTS, Apache-2.0) once and serves
synthesis over localhost HTTP so the MCP bridge gets fast, natural
speech without paying model-load time per request.

    GET  /health          -> {"ok": true, "voices": [...]}
    POST /tts             -> WAV bytes (16-bit mono)
         {"text": "...", "voice": "af_heart", "speed": 1.0}

Run with the bundled venv:  tts-venv/bin/python3 tts_daemon.py
"""
import io
import json
import os
import struct
import sys
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8793
HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, "models", "kokoro-v1.0.onnx")
VOICES_BIN = os.path.join(HERE, "models", "voices-v1.0.bin")

sys.stderr.write("loading kokoro model…\n")
from kokoro_onnx import Kokoro  # noqa: E402  (import after banner: slow)

kokoro = Kokoro(MODEL, VOICES_BIN)
VOICE_NAMES = sorted(kokoro.get_voices())
sys.stderr.write(f"kokoro ready: {len(VOICE_NAMES)} voices\n")


def to_wav_bytes(samples, sample_rate):
    # float32 numpy -> 16-bit mono WAV
    import numpy as np
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, "model": "kokoro-v1.0", "voices": VOICE_NAMES})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/tts":
            return self._json(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n))
            text = req["text"][:1000]
            voice = req.get("voice") or "af_heart"
            if voice not in VOICE_NAMES:
                voice = "af_heart"
            speed = max(0.5, min(2.0, float(req.get("speed") or 1.0)))
            lang = "en-gb" if voice.startswith(("bf_", "bm_")) else "en-us"
            samples, sr = kokoro.create(text, voice=voice, speed=speed, lang=lang)
            wav = to_wav_bytes(samples, sr)
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(wav)))
            self.end_headers()
            self.wfile.write(wav)
        except Exception as e:  # report, don't die
            self._json(500, {"error": str(e)})


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    sys.stderr.write(f"muse tts daemon on http://127.0.0.1:{PORT}\n")
    srv.serve_forever()
