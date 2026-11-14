#!/usr/bin/env python3
"""Step 0 throwaway engine server: the proposed engine API over a Unix socket. NOT part of the app.

    python -I engine_server.py --engine paddle|tesseract|none --socket PATH [--block-network]

GET /health -> 200 {"ok":true, "t_import_ms", "t_load_ms"} once models are loaded.
POST /read  {"image": base64 JPEG} -> {"lines":[...], "ms"}. One request at a time, 4 MB body limit.
Logs nothing except timings.
"""
import argparse
import os
import sys
import time

T0 = time.perf_counter()
ap = argparse.ArgumentParser()
ap.add_argument("--engine", required=True)
ap.add_argument("--socket", required=True)
ap.add_argument("--block-network", action="store_true")
ap.add_argument("--alloc-mb", type=int, default=0, help="test only: allocate this much after load")
args = ap.parse_args()

if args.block_network:
    import socket as _s

    def hook(event, a):
        # Allow only AF_UNIX sockets. socket.__new__ args: (sock, family, type, proto)
        if event == "socket.__new__":
            fam = a[1]
            if fam not in (_s.AF_UNIX, -1):
                raise RuntimeError(f"network blocked: family {fam}")
        elif event in ("socket.connect", "socket.bind", "socket.sendto", "socket.getaddrinfo"):
            addr = a[1] if len(a) > 1 else None
            if not isinstance(addr, (str, bytes)):
                raise RuntimeError(f"network blocked: {event}")
    sys.addaudithook(hook)

import base64, io, json, socketserver  # noqa: E401
from http.server import BaseHTTPRequestHandler

TESS = os.path.expanduser("~/.cache/nadhra-bench/tessdata_best")


def load():
    if args.engine == "none":
        return lambda img: []
    if args.engine == "tesseract":
        import tesserocr
        from PIL import Image
        api = tesserocr.PyTessBaseAPI(path=TESS, lang="ara+fra+eng", psm=tesserocr.PSM.AUTO)

        def read(b):
            api.SetImage(Image.open(io.BytesIO(b)))
            return [l.strip() for l in api.GetUTF8Text().splitlines() if l.strip()]
        return read
    if args.engine == "paddle":
        import numpy as np
        import cv2
        from rapidocr import RapidOCR
        from rapidocr.utils.typings import LangRec, OCRVersion, ModelType

        def eng(lang):
            return RapidOCR(params={"Rec.lang_type": lang, "Rec.ocr_version": OCRVersion.PPOCRV5,
                                    "Rec.model_type": ModelType.MOBILE, "Global.use_cls": False,
                                    "Global.log_level": "error"})
        ar, la = eng(LangRec.ARABIC), eng(LangRec.LATIN)

        def read(b):
            img = cv2.imdecode(np.frombuffer(b, np.uint8), cv2.IMREAD_COLOR)
            img, rec = ar.preprocess_img(img)
            crops, det = ar.detect_and_crop(img, rec)  # errors propagate -> HTTP 500, never "no text"
            if det.boxes is None or not len(crops):
                return []
            ra, rl = ar.recognize_txt(crops), la.recognize_txt(crops)
            out = []
            for ta, sa, tl, sl in zip(ra.txts, ra.scores, rl.txts, rl.scores):
                t, s = (ta, sa) if sa >= sl else (tl, sl)
                if s >= 0.5 and t.strip():
                    out.append(t)
            return out
        return read
    sys.exit("unknown engine")


T_IMPORT = (time.perf_counter() - T0) * 1000
T1 = time.perf_counter()
READ = load()
T_LOAD = (time.perf_counter() - T1) * 1000
if args.alloc_mb:
    _hog = bytearray(args.alloc_mb * 1024 * 1024)
    for i in range(0, len(_hog), 4096):
        _hog[i] = 1


class H(BaseHTTPRequestHandler):
    def address_string(self):
        return "unix"

    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, "t_import_ms": round(T_IMPORT), "t_load_ms": round(T_LOAD)})
        elif self.path == "/probe-net":
            # test only: can the engine create an IP socket / reach loopback? (never leaves the machine)
            import socket
            res = {}
            for name, fn in (("create_inet_socket", lambda: socket.socket(socket.AF_INET, socket.SOCK_STREAM)),
                             ("connect_127.0.0.1:9", lambda: socket.create_connection(("127.0.0.1", 9), 1)),
                             ("list_interfaces", lambda: [i[1] for i in socket.if_nameindex()])):
                try:
                    r = fn()
                    res[name] = r if isinstance(r, list) else "allowed"
                except Exception as e:  # noqa: BLE001
                    res[name] = type(e).__name__ + ": " + str(e)[:60]
            self._send(200, res)
        elif self.path == "/probe-fs":
            home = os.path.expanduser("~")
            here = os.path.dirname(os.path.abspath(__file__))
            paths = [home, os.path.join(home, ".ssh"), os.path.join(here, "..", "..", ".env.local"), "/etc/passwd",
                     TESS, sys.prefix, here]
            self._send(200, {p: {"exists": os.path.exists(p), "readable": os.access(p, os.R_OK),
                                 "writable": os.access(p, os.W_OK)} for p in paths})
        else:
            self._send(404, {"error": "not-found"})

    def do_POST(self):
        if self.path != "/read":
            return self._send(404, {"error": "not-found"})
        n = int(self.headers.get("Content-Length") or 0)
        if n > 4 * 1024 * 1024:
            return self._send(413, {"error": "too-large"})
        try:
            b = base64.b64decode(json.loads(self.rfile.read(n))["image"])
            if b[:2] != b"\xff\xd8":
                return self._send(415, {"error": "jpeg-only"})
            t = time.perf_counter()
            lines = READ(b)
            self._send(200, {"lines": lines, "ms": round((time.perf_counter() - t) * 1000, 1)})
        except Exception as e:  # noqa: BLE001
            self._send(500, {"error": type(e).__name__})


class S(socketserver.UnixStreamServer):
    pass


if os.path.exists(args.socket):
    os.unlink(args.socket)
srv = S(args.socket, H)
os.chmod(args.socket, 0o600)

import signal  # noqa: E402


def stop(*_):
    try:
        os.unlink(args.socket)
    finally:
        os._exit(0)


signal.signal(signal.SIGTERM, stop)
srv.serve_forever()
