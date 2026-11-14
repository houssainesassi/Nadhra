#!/usr/bin/env python3
"""Step 0, items 4-6: sandbox checks that CANNOT run inside the VS Code Flatpak (no user namespaces,
no /sys/fs/cgroup, no bwrap/systemd-run there). Run it yourself in a normal host terminal:

    python3 -I ~/Downloads/blind/bench/engines-step0/sandbox_check.py results/sandbox.json

It installs and downloads nothing, uses no network and no API quota. It only runs the existing bench
venv and models under bubblewrap (already installed on the host) and systemd-run --user scopes.
It has NOT been run yet: written 2026-11-14 without the ability to test it.
"""
import json
import os
import signal
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import harness as H  # noqa: E402  (UConn, req, img, SOCKDIR, PY, SERVER)

HOME = os.path.expanduser("~")
VENV = os.path.expanduser("~/.cache/nadhra-bench/venv")
TESS = os.path.expanduser("~/.cache/nadhra-bench/tessdata_best")
UID = os.getuid()


def sh(cmd):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    return (r.stdout + r.stderr).strip()


def bwrap_prefix():
    return ["bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--clearenv",
            "--setenv", "PATH", "/usr/bin", "--setenv", "LANG", "C.UTF-8", "--setenv", "HOME", HOME,
            "--ro-bind", "/usr", "/usr", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
            "--symlink", "usr/bin", "/bin", "--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache",
            "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
            "--ro-bind", VENV, VENV, "--ro-bind", TESS, TESS, "--ro-bind", HERE, HERE,
            "--bind", H.SOCKDIR, H.SOCKDIR]


def scope_prefix(mem_mb, name):
    return ["systemd-run", "--user", "--scope", "--quiet", f"--unit=nadhra-step0-{name}-{os.getpid()}",
            "-p", f"MemoryMax={mem_mb}M", "-p", "MemorySwapMax=0", "--"]


def launch(engine, prefix, tag, extra=()):
    sock = os.path.join(H.SOCKDIR, f"{tag}.sock")
    t0 = time.perf_counter()
    p = subprocess.Popen([*prefix, VENV + "/bin/python", "-I", H.SERVER, "--engine", engine, "--socket", sock,
                          *extra], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True)
    while time.perf_counter() - t0 < 60:
        if p.poll() is not None:
            return p, sock, {"ok": False, "exit": p.returncode, "stderr": p.stderr.read().decode()[-500:]}
        try:
            code, d = H.req(sock, "GET", "/health", timeout=2)
            if code == 200:
                d["startup_ms"] = round((time.perf_counter() - t0) * 1000)
                return p, sock, d
        except OSError:
            pass
        time.sleep(0.02)
    return p, sock, {"ok": False, "error": "timeout"}


def cgroup_peak(pid):
    try:
        rel = open(f"/proc/{pid}/cgroup").read().strip().split("::", 1)[1]
        base = "/sys/fs/cgroup" + rel
        return {k: open(f"{base}/{k}").read().strip() for k in ("memory.max", "memory.peak", "memory.events")}
    except Exception as e:  # noqa: BLE001
        return {"error": repr(e)[:200]}


def reads(sock, n=2):
    out = []
    for name in H.IMAGES[:n]:
        try:
            code, d = H.req(sock, "POST", "/read", H.img(name), timeout=120)
            out.append({"image": name, "http": code, "lines": len(d.get("lines", [])), "error": d.get("error")})
        except Exception as e:  # noqa: BLE001
            out.append({"image": name, "transport_error": type(e).__name__})
    return out


def stop(p):
    p.send_signal(signal.SIGTERM)
    try:
        p.wait(10)
    except subprocess.TimeoutExpired:
        p.kill()
        p.wait()
    return p.returncode


def main():
    out = {"env": {
        "bwrap": sh("bwrap --version"), "systemd_run": sh("systemd-run --version | head -1"),
        "kernel": sh("uname -r"), "userns_clone": sh("cat /proc/sys/kernel/unprivileged_userns_clone"),
        "user_delegated_controllers": sh(f"cat /sys/fs/cgroup/user.slice/user-{UID}.slice/user@{UID}.service/cgroup.subtree_control"),
    }}
    bw = bwrap_prefix()

    # 4 + 5: Unix socket across the sandbox, network and file-system isolation
    for eng in ("none", "tesseract", "paddle"):
        p, sock, h = launch(eng, bw, f"bw-{eng}")
        r = {"health": h}
        if h.get("ok"):
            r["probe_net"] = H.req(sock, "GET", "/probe-net")[1]
            r["probe_fs"] = H.req(sock, "GET", "/probe-fs")[1]
            r["reads"] = reads(sock) if eng != "none" else []
        r["exit"] = stop(p)
        r["socket_removed"] = not os.path.exists(sock)
        out[f"bwrap_{eng}"] = r

    # 6: hard memory limit (cgroup v2 via systemd --user) + process isolation
    cases = [("overrun_none_600MB_in_300M", "none", 300, ["--alloc-mb", "600"]),
             ("paddle_in_875M", "paddle", 875, []),
             ("paddle_in_350M", "paddle", 350, []),
             ("tesseract_in_250M", "tesseract", 250, [])]
    for name, eng, mb, extra in cases:
        p, sock, h = launch(eng, scope_prefix(mb, name.replace("_", "-")) + bw, f"cg-{name}", extra)
        r = {"health": h}
        if p.poll() is None:
            r["reads"] = reads(sock) if eng != "none" else []
            r["cgroup"] = cgroup_peak(p.pid)
            r["alive_after_reads"] = p.poll() is None
            r["exit"] = stop(p)
        else:
            r["exit"] = p.returncode
            r["killed_by_signal"] = -p.returncode if p.returncode < 0 else None
        out[name] = r
        json.dump(out, open(sys.argv[1], "w"), indent=1, ensure_ascii=False)
    json.dump(out, open(sys.argv[1], "w"), indent=1, ensure_ascii=False)
    print(json.dumps(out, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
