"""Masa Paneli ses servisi.

Telefonun mikrofonundan gelen 16 kHz / 16 bit / mono sesi stdin'den okur,
"hey jarvis" uyandırma sözcüğünü openWakeWord ile yakalar, ardından gelen
cümleyi faster-whisper ile Türkçe yazıya çevirir ve stdout'a JSON satırı yazar.

stdin çerçevesi:  1 bayt tür + 4 bayt uzunluk (little-endian) + veri
  A  ses (int16)          P  hemen dinle (düğmeye basıldı)
  C  dinlemeyi iptal et   W  uyandırma açık/kapalı (b"1" / b"0")
stdout: {"ev": "ready" | "wake" | "listening" | "text" | "none" | "error" | "log", ...}
"""
import glob
import json
import os
import queue
import struct
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(HERE, "models")
os.makedirs(MODELS, exist_ok=True)
os.environ.setdefault("HF_HOME", MODELS)
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")


def emit(ev, **kw):
    kw["ev"] = ev
    sys.stdout.write(json.dumps(kw, ensure_ascii=False) + "\n")
    sys.stdout.flush()


# pip'le gelen CUDA kütüphanelerini (cuBLAS, cuDNN) Windows'un bulabileceği yere ekle
for d in glob.glob(os.path.join(sys.prefix, "Lib", "site-packages", "nvidia", "*", "bin")):
    try:
        os.add_dll_directory(d)
    except Exception:
        pass
    os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")

import numpy as np  # noqa: E402

RATE = 16000
CHUNK = 1280  # openWakeWord 80 ms parçalar ister
PROMPT = ("Takvime toplantı ekle. Yarın saat 11.00'da diş randevusu. Cuma akşam 7'de sinema. "
          "Yapılacaklara süt almayı ekle. Bugün neler var? Sıradaki şarkı. Pomodoro başlat.")
# Whisper'ın sessizlikte uydurduğu tipik cümleler
HALLU = ("altyazı", "abone ol", "izlediğiniz için", "teşekkürler.", "m.k.", "beğen", "kanalıma")

wake_threshold = float(os.environ.get("WAKE_THRESHOLD", "0.5"))


# ---------------------------------------------------------------- modeller
def load_whisper():
    from faster_whisper import WhisperModel
    want = os.environ.get("WHISPER_MODEL", "")
    tries = [(want or "large-v3-turbo", "cuda", "int8_float16"),
             ("small", "cuda", "int8_float16"),
             (want or "small", "cpu", "int8")]
    last = None
    for name, dev, ct in tries:
        try:
            m = WhisperModel(name, device=dev, compute_type=ct, download_root=MODELS)
            silence = np.zeros(RATE, dtype=np.float32)
            list(m.transcribe(silence, language="tr", beam_size=1)[0])  # ısınma + CUDA testi
            return m, name, dev
        except Exception as e:  # CUDA yoksa ya da bellek yetmezse bir sonrakine geç
            last = e
            emit("log", msg=f"{name}/{dev} açılamadı: {e}")
    raise last


def load_wake():
    import openwakeword
    from openwakeword.model import Model
    try:
        openwakeword.utils.download_models(["hey_jarvis"])
    except Exception as e:
        emit("log", msg=f"uyandırma modeli indirilemedi: {e}")
    return Model(wakeword_models=["hey_jarvis"], inference_framework="onnx")


# ---------------------------------------------------------------- durum
class Listener:
    def __init__(self, whisper, wake):
        self.whisper, self.wake = whisper, wake
        self.wake_on = True
        self.state = "idle"          # idle | wait (konuşma bekliyor) | rec (kaydediyor) | busy
        self.buf = []
        self.pre = []                # uyanmadan hemen önceki ses (cümleye karışmışsa)
        self.noise = 200.0
        self.t0 = 0.0
        self.last_voice = 0.0
        self.voiced = 0
        self.tail = False
        self.jobs = queue.Queue()
        threading.Thread(target=self.worker, daemon=True).start()

    def start(self, reason):
        self.state, self.buf, self.voiced = "wait", [], 0
        self.t0 = self.last_voice = time.time()
        self.tail = reason == "wake"
        emit("listening", reason=reason)

    def cancel(self):
        self.state, self.buf = "idle", []

    def feed(self, pcm):
        f = pcm.astype(np.float32)
        rms = float(np.sqrt(np.mean(f * f))) if len(f) else 0.0
        now = time.time()
        if self.state in ("idle",) and rms < self.noise * 2.5:
            self.noise = self.noise * 0.97 + rms * 0.03 if rms > 30 else self.noise
        speech = rms > max(self.noise * 3.0, 350.0)

        if self.state == "idle":
            self.pre = (self.pre + [pcm])[-6:]
            if self.wake_on and self.wake is not None:
                scores = self.wake.predict(pcm)
                if max(scores.values() or [0]) >= wake_threshold:
                    self.wake.reset()
                    emit("wake")
                    self.start("wake")
            return
        if self.state == "busy":
            return

        self.buf.append(pcm)
        if speech:
            self.voiced += 1
            self.last_voice = now
            if self.state == "wait":
                self.state = "rec"
        dur = len(self.buf) * CHUNK / RATE
        if self.state == "wait" and now - self.t0 > 6:
            self.state = "idle"; emit("none"); return
        if (self.state == "rec" and self.tail and now - self.last_voice > 0.9
                and self.voiced < 8 and now - self.t0 < 1.6):
            # uyanır uyanmaz duyulan kısa ses "…jarvis"in kuyruğu: atla, asıl komutu bekle
            self.state, self.buf, self.voiced, self.tail, self.t0 = "wait", [], 0, False, now
            return
        if self.state == "rec" and (now - self.last_voice > 0.9 or dur > 12):
            audio = np.concatenate(self.buf)
            self.state, self.buf = "busy", []
            self.jobs.put((audio, self.voiced))

    def worker(self):
        while True:
            audio, voiced = self.jobs.get()
            try:
                if voiced < 3:
                    emit("none"); continue
                t = time.time()
                segs, _ = self.whisper.transcribe(
                    audio.astype(np.float32) / 32768.0, language="tr", beam_size=5,
                    initial_prompt=PROMPT, condition_on_previous_text=False,
                    no_speech_threshold=0.6, temperature=0)
                text = " ".join(s.text.strip() for s in segs if s.no_speech_prob < 0.8).strip()
                low = text.lower()
                if not text or any(h in low for h in HALLU) and len(low) < 60:
                    emit("none")
                else:
                    emit("text", text=text, ms=int((time.time() - t) * 1000))
            except Exception as e:
                emit("error", msg=str(e))
            finally:
                self.state = "idle"
                if self.wake is not None:
                    self.wake.reset()


def read_exact(stream, n):
    out = b""
    while len(out) < n:
        b = stream.read(n - len(out))
        if not b:
            return None
        out += b
    return out


def main():
    emit("log", msg="modeller yükleniyor (ilk açılışta indirilir, birkaç dakika sürebilir)")
    whisper, name, dev = load_whisper()
    try:
        wake = load_wake()
    except Exception as e:
        wake = None
        emit("log", msg=f"uyandırma sözcüğü kapalı: {e}")
    L = Listener(whisper, wake)
    emit("ready", model=name, device=dev, wake=wake is not None)

    inp = sys.stdin.buffer
    rest = np.zeros(0, dtype=np.int16)
    while True:
        head = read_exact(inp, 5)
        if head is None:
            break
        kind, n = head[:1], struct.unpack("<I", head[1:])[0]
        data = read_exact(inp, n) if n else b""
        if data is None:
            break
        if kind == b"A":
            rest = np.concatenate([rest, np.frombuffer(data, dtype=np.int16)])
            while len(rest) >= CHUNK:
                L.feed(rest[:CHUNK]); rest = rest[CHUNK:]
        elif kind == b"P":
            if L.state != "busy":
                L.start("button")
        elif kind == b"C":
            L.cancel()
        elif kind == b"W":
            L.wake_on = data == b"1"


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        emit("error", msg=f"ses servisi durdu: {e}")
        sys.exit(1)
