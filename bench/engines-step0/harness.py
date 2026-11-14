#!/usr/bin/env python3
"""Step 0 measurement harness. Usage: python3 -I harness.py OUT.json [experiments...]"""
import base64
import http.client
import json
import os
import resource
import signal
import socket
import statistics
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PY = os.path.expanduser("~/.cache/nadhra-bench/venv/bin/python")
SERVER = os.path.join(HERE, "engine_server.py")
PLAN = os.path.join(os.path.dirname(HERE), "..", "e2e/read/out/plan")
SOCKDIR = f"/run/user/{os.getuid()}/nadhra-step0"  # short path: AF_UNIX limit is 108 bytes
os.makedirs(SOCKDIR, mode=0o700, exist_ok=True)
IMAGES = [f"M0{i}_{f}.jpg" for i in range(1, 6) for f in "ab"]
ENV = {"PATH": "/usr/bin:/bin", "HOME": os.path.expanduser("~"), "LANG": "C.UTF-8"}


def meminfo():
    d = {}
    for line in open("/proc/meminfo"):
        k, v = line.split(":")
        d[k] = int(v.split()[0]) // 1024
    return d


def status(pid):
    d = {}
    try:
        for line in open(f"/proc/{pid}/status"):
            k, _, v = line.partition(":")
            if k in ("VmRSS", "VmHWM", "VmPeak", "VmSize", "Threads"):
                d[k] = int(v.split()[0]) // (1 if k == "Threads" else 1024)
    except FileNotFoundError:
        pass
    return d


class UConn(http.client.HTTPConnection):
    def __init__(self, path, timeout=60):
        super().__init__("localhost", timeout=timeout)
        self.path_ = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path_)


def req(sock, method, path, body=None, timeout=60):
    c = UConn(sock, timeout)
    c.request(method, path, body=json.dumps(body) if body is not None else None,
              headers={"Content-Type": "application/json"})
    r = c.getresponse()
    data = json.loads(r.read())
    c.close()
    return r.status, data


class Sampler(threading.Thread):
    """Samples MemAvailable and the RSS of given pids every 50 ms."""

    def __init__(self):
        super().__init__(daemon=True)
        self.pids, self.stop_, self.min_avail, self.max_sum_rss = set(), False, 10**9, 0

    def run(self):
        while not self.stop_:
            self.min_avail = min(self.min_avail, meminfo()["MemAvailable"])
            s = sum(status(p).get("VmRSS", 0) for p in list(self.pids))
            self.max_sum_rss = max(self.max_sum_rss, s)
            time.sleep(0.05)


class Engine:
    def __init__(self, engine, flags=(), as_mb=None, tag=None):
        self.engine, self.sock = engine, os.path.join(SOCKDIR, f"{tag or engine}.sock")
        pre = None
        if as_mb:
            def pre():
                resource.setrlimit(resource.RLIMIT_AS, (as_mb * 2**20, as_mb * 2**20))
        self.t0 = time.perf_counter()
        self.p = subprocess.Popen([PY, "-I", SERVER, "--engine", engine, "--socket", self.sock, *flags],
                                  env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                  preexec_fn=pre, start_new_session=True)

    def wait_healthy(self, timeout=60):
        while time.perf_counter() - self.t0 < timeout:
            if self.p.poll() is not None:
                return {"ok": False, "exit": self.p.returncode, "stderr_tail": self.p.stderr.read().decode()[-400:]}
            try:
                code, d = req(self.sock, "GET", "/health", timeout=2)
                if code == 200:
                    d["startup_ms"] = round((time.perf_counter() - self.t0) * 1000)
                    return d
            except (FileNotFoundError, ConnectionRefusedError, socket.timeout, OSError):
                pass
            time.sleep(0.02)
        return {"ok": False, "error": "timeout"}

    def stop(self):
        before = meminfo()["MemAvailable"]
        t = time.perf_counter()
        self.p.send_signal(signal.SIGTERM)
        try:
            self.p.wait(10)
        except subprocess.TimeoutExpired:
            self.p.kill()
            self.p.wait()
        ms = round((time.perf_counter() - t) * 1000)
        time.sleep(0.3)
        leftover = [pid for pid in os.listdir("/proc") if pid.isdigit() and _pgid(int(pid)) == self.p.pid]
        return {"stop_ms": ms, "exit": self.p.returncode, "socket_removed": not os.path.exists(self.sock),
                "leftover_processes": len(leftover),
                "mem_available_recovered_mb": meminfo()["MemAvailable"] - before}


def _pgid(pid):
    try:
        return os.getpgid(pid)
    except OSError:
        return None


def img(name):
    return {"image": base64.b64encode(open(os.path.join(PLAN, name), "rb").read()).decode()}


def read_set(e, names=IMAGES):
    rt, sv, lines = [], [], 0
    for n in names:
        t = time.perf_counter()
        code, d = req(e.sock, "POST", "/read", img(n), timeout=120)
        rt.append((time.perf_counter() - t) * 1000)
        if code != 200:
            errors = locals().setdefault("errors", [])
            errors.append({"image": n, "http": code, **d}); sv.append(0); continue
        sv.append(d["ms"])
        lines += len(d["lines"])
    return {"images": len(names), "lines": lines, "errors": locals().get("errors", []), "first_roundtrip_ms": round(rt[0]),
            "median_roundtrip_ms": round(statistics.median(rt[1:] or rt)),
            "median_server_ms": round(statistics.median(sv[1:] or sv)),
            "median_transport_overhead_ms": round(statistics.median([a - b for a, b in zip(rt, sv)]), 1)}


def exp_startup(n=5):
    out = {}
    for eng in ("none", "tesseract", "paddle"):
        runs = []
        for _ in range(n):
            e = Engine(eng)
            h = e.wait_healthy()
            st = status(e.p.pid)
            h.update({"idle_rss_mb": st.get("VmRSS"), "threads": st.get("Threads")})
            h.update(e.stop())
            runs.append(h)
        out[eng] = {"runs": runs,
                    "startup_ms_median": statistics.median(r["startup_ms"] for r in runs),
                    "startup_ms_min": min(r["startup_ms"] for r in runs),
                    "startup_ms_max": max(r["startup_ms"] for r in runs)}
    return out


def exp_memory():
    out = {}
    for eng in ("none", "tesseract", "paddle"):
        e = Engine(eng)
        h = e.wait_healthy()
        idle = status(e.p.pid)
        r = read_set(e) if eng != "none" else {}
        after = status(e.p.pid)
        out[eng] = {"health": h, "idle": idle, "reads": r, "after_reads": after, "stop": e.stop()}
    return out


def exp_sequential():
    s = Sampler()
    s.start()
    base = meminfo()["MemAvailable"]
    t = time.perf_counter()
    steps = []
    for eng in ("paddle", "tesseract"):
        e = Engine(eng)
        s.pids.add(e.p.pid)
        h = e.wait_healthy()
        r = read_set(e, IMAGES[:2])
        hwm = status(e.p.pid).get("VmHWM")
        st = e.stop()
        s.pids.discard(e.p.pid)
        steps.append({"engine": eng, "startup_ms": h.get("startup_ms"), "reads": r, "VmHWM": hwm, "stop": st})
    total = round((time.perf_counter() - t) * 1000)
    s.stop_ = True
    s.join()
    return {"steps": steps, "total_ms": total, "max_engine_rss_mb": s.max_sum_rss,
            "max_mem_drop_mb": base - s.min_avail, "mem_available_start_mb": base,
            "mem_available_end_mb": meminfo()["MemAvailable"]}


def exp_parallel():
    s = Sampler()
    s.start()
    base = meminfo()["MemAvailable"]
    t = time.perf_counter()
    a, b = Engine("paddle"), Engine("tesseract")
    s.pids |= {a.p.pid, b.p.pid}
    ha, hb = a.wait_healthy(), b.wait_healthy()
    both_ready = round((time.perf_counter() - t) * 1000)
    ra, rb = {}, {}
    ta = threading.Thread(target=lambda: ra.update(read_set(a, IMAGES[:2])))
    tb = threading.Thread(target=lambda: rb.update(read_set(b, IMAGES[:2])))
    ta.start(); tb.start(); ta.join(); tb.join()
    total = round((time.perf_counter() - t) * 1000)
    sa, sb = a.stop(), b.stop()
    s.stop_ = True
    s.join()
    return {"paddle_startup_ms": ha.get("startup_ms"), "tesseract_startup_ms": hb.get("startup_ms"),
            "both_ready_ms": both_ready, "paddle_reads": ra, "tesseract_reads": rb, "total_ms": total,
            "max_sum_rss_mb": s.max_sum_rss, "max_mem_drop_mb": base - s.min_avail, "stop": [sa, sb]}


def exp_network():
    out = {}
    for flag in (False, True):
        e = Engine("paddle", ["--block-network"] if flag else [], tag=f"net{int(flag)}")
        h = e.wait_healthy()
        code, probe = req(e.sock, "GET", "/probe-net")
        r = read_set(e, IMAGES[:1])
        out["audit_hook_block" if flag else "no_block"] = {"health": h, "probe": probe, "read_ok": r["lines"] > 0,
                                                           "stop": e.stop()}
    return out


def exp_rlimit():
    out = {}
    cases = [("paddle", 875), ("paddle", 1500), ("paddle", 2500), ("paddle", 4000),
             ("tesseract", 250), ("tesseract", 500), ("tesseract", 1000)]
    for eng, mb in cases:
        e = Engine(eng, as_mb=mb, tag=f"as{mb}{eng}")
        h = e.wait_healthy(90)
        res = {"health_ok": h.get("ok", False), "detail": h if not h.get("ok") else None}
        if h.get("ok"):
            try:
                res["reads"] = read_set(e, IMAGES[:2])
            except Exception as ex:  # noqa: BLE001
                res["reads_error"] = repr(ex)[:200]
            res["status"] = status(e.p.pid)
            res["alive_after_reads"] = e.p.poll() is None
            e.stop()
        out[f"{eng}@AS={mb}MB"] = res
    # deliberate overrun: baseline server allocates 600 MB under a 300 MB address-space limit
    e = Engine("none", ["--alloc-mb", "600"], as_mb=300, tag="overrun")
    out["overrun none+600MB@AS=300MB"] = e.wait_healthy(20)
    if e.p.poll() is None:
        e.stop()
    return out


def exp_fs():
    e = Engine("none", tag="fs")
    e.wait_healthy()
    _, d = req(e.sock, "GET", "/probe-fs")
    env = open(f"/proc/{e.p.pid}/environ", "rb").read().split(b"\0")
    st = os.stat(e.sock)
    e.stop()
    return {"engine_can_access": d, "engine_env_keys": sorted(x.split(b"=")[0].decode() for x in env if x),
            "socket_mode": oct(st.st_mode & 0o777), "socket_dir_mode": oct(os.stat(SOCKDIR).st_mode & 0o777)}


def main():
    out_path, exps = sys.argv[1], sys.argv[2:]
    res = {"meminfo_start": {k: meminfo()[k] for k in ("MemTotal", "MemAvailable")},
           "loadavg": open("/proc/loadavg").read().split()[:3]}
    for x in exps:
        t = time.perf_counter()
        print(f"[{x}] ...", file=sys.stderr, flush=True)
        res[x] = globals()[f"exp_{x}"]()
        print(f"[{x}] done in {time.perf_counter() - t:.0f} s", file=sys.stderr, flush=True)
        json.dump(res, open(out_path, "w"), indent=1, ensure_ascii=False)


if __name__ == "__main__":
    main()
