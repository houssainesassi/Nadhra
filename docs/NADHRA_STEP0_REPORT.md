# OCR pair, Step 0: measured as servers

Status: **Step 0 only, done 2026-11-14.** Nothing was downloaded or installed, no engine is connected to Nadhra,
`document.ts` and the reading rules weren't touched, the app and UI weren't changed, and nothing was committed.
No API quota was used.

Everything ran on the existing bench venv (`~/.cache/nadhra-bench/venv`: rapidocr 3.10.0, onnxruntime 1.32.0,
tesserocr 2.13.0) and the existing models (SHA-256 in `bench/ocr/models.sha256`).

## 0. The key constraint found

This assistant runs **inside the VS Code Flatpak sandbox**:
- its cgroup is `app-flatpak-com.visualstudio.code-….scope`;
- `/sys/fs/cgroup` isn't mounted;
- `unshare -Ur` fails with EPERM;
- `bwrap` and `systemd-run` are absent.

The **host** has `/usr/bin/bwrap`, `/usr/bin/systemd-run`, `/usr/bin/systemctl` and `/usr/bin/tesseract`. I only checked that the files exist, through the read-only `/run/host` view.

Running anything on the host (`flatpak-spawn --host`) was **refused by the assistant's permission system**, so I didn't try another way.

As a result:
- **Items 1–3 and 7 were measured fully.**
- **Items 4–6 were measured only as far as the Flatpak allows.** The real bubblewrap and cgroup tests are prepared in `bench/engines-step0/sandbox_check.py`, but **haven't run** (§6).

## 1. What was measured, and how to repeat it

The scripts are in `bench/engines-step0/`. The bench isn't part of the app and nothing in `src/` imports it.

| File | What it is |
|---|---|
| `engine_server.py` | Throwaway engine server with the proposed API over a **Unix socket**: `GET /health`, `POST /read` (base64 JPEG, 4 MB limit, JPEG only, one request at a time). It also has test-only `/probe-net` and `/probe-fs`, which check loopback only and never leave the machine. Engines: `paddle`, `tesseract`, and `none` (no model, used for the server-overhead baseline). |
| `harness.py` | Starts each server with a 3-variable environment, times from spawn to the first successful `/health`, samples `/proc/<pid>/status` (VmRSS, VmHWM, VmPeak) and `MemAvailable` every 50 ms, and stops with SIGTERM. |
| `as_probe.py` | Finds where Paddle fails under an address-space limit. |
| `results/*.json` | The raw results quoted below. |

```
cd bench/engines-step0
python3 -I harness.py results/main.json startup memory sequential parallel rlimit   # ≈ 3 min
python3 -I harness.py results/fs.json fs network
```

Images: `e2e/read/out/plan`, M01–M05, frames a and b (10 images; 2 for the sequential, parallel and limit runs).

Conditions:
- The PC was in normal use (VS Code, load average about 1.0–1.7, about 3.2 GB of 7.6 GB available).
- The model files were already in the page cache, so a **cold start from disk was not measured**. Dropping the cache needs root.

## 2. Startup (item 1)

Five runs each, from spawning the process to the first successful `/health`:

| Engine | Median | Min–max | Python + imports | Model load | Idle RSS |
|---|---|---|---|---|---|
| `none` (server only) | **83 ms** | 83–126 | 42–63 ms | – | 19 MB |
| Tesseract (`best`, ara+fra+eng) | **409 ms** | 388–572 | 43–56 ms | 290–463 ms | 91 MB |
| Paddle (det + ar + latin rec) | **1,586 ms** | 1,480–2,794 | 47–202 ms | 1,382–2,486 ms | 74 MB |

**"Healthy" doesn't mean "warm".** The first reading is slower than the rest:

| Engine | First image | Median image after that |
|---|---|---|
| Paddle | 5,063 ms | 3,835 ms (about 1.2 s of warm-up) |
| Tesseract | 795 ms | 592 ms |

From start to the first answer:
- Paddle takes about **6.5 s**.
- Tesseract takes about **1.2 s**.

## 3. Memory, including server overhead (item 2)

Ten images:

| | Paddle | Tesseract | Server only |
|---|---|---|---|
| RSS at rest, after load | 74 MB | 91 MB | 19 MB |
| **Peak RSS (VmHWM)** | **538 MB** | **124 MB** | 19 MB |
| RSS after the readings | 200 MB (it doesn't go back down to 74) | 124 MB | 19 MB |
| Peak virtual size (VmPeak) | **2,057 MB** | 172 MB | 27 MB |
| Threads | 7 at rest, 14–15 after reading | 1 | 1 |
| Median time per image, measured in the server | 3,827 ms | 580 ms | – |
| Median transport cost (Unix socket + base64 + JSON) | 8 ms | 9 ms | – |

Compared with the bench (`OFFLINE_PHASE2_REPORT.md`, no server, 62 images):
- The peaks are close: 561 → 538 MB for Paddle, 136 → 124 MB for Tesseract.
- The server adds about **19 MB of RSS** and **7–15 ms per request**.
- The proposed `ramMB` values (700 and 200) leave margins of **1.30× and 1.61×** over the measured peaks. That holds for these mock images. Larger real photographs may need more, and should be re-measured in Step 4.

## 4. Starting and stopping, one after another and together (item 3)

| | Sequential: A, then B | Parallel: A and B together |
|---|---|---|
| Time to ready | 2,199 ms + 472 ms | 1,453 ms (both) |
| Total time (start, 2 readings each, stop) | 15.5 s | **10.4 s** |
| Peak engine RSS | **529 MB** | **660 MB** (sum) |
| Largest drop in MemAvailable | 420 MB | 487 MB |
| Side effect | – | Tesseract's first image: 1,474 ms instead of about 800 ms (CPU contention). Paddle wasn't affected |

The proposal estimated about 0.7 GB in sequence and 0.85 GB in parallel. The real figures are **0.53 and 0.66 GB**.

Stopping:
- **All 24 recorded stops** exited 0 on SIGTERM within **3–49 ms**.
- The socket file was removed every time.
- **0 processes were left behind** (each engine runs in its own session or process group).

## 5. Sandbox checks possible inside the Flatpak (items 4–6, partial)

| Item | Result here | What it shows |
|---|---|---|
| 4. Unix socket | **Works.** The socket is mode `0600` in a `0700` folder (`/run/user/1000/nadhra-step0`). Transport costs about 8 ms. | **The Linux path limit is 108 bytes.** This assistant's scratchpad path is too long, so the launcher needs a short runtime folder (`$XDG_RUNTIME_DIR/nadhra/…`). **The socket across a bwrap boundary isn't tested yet.** |
| 5. Network isolation | **No network namespace possible here** (EPERM). An in-process Python guard (an audit hook allowing only AF_UNIX) blocks IP sockets, and **Paddle still loads and reads normally under it**. | **Confirmed: neither engine needs the network at run time** (no hidden model download). The guard is weak, though: native code (ONNX Runtime, Tesseract) can open sockets without Python seeing it. **Without the sandbox, the engine sees `lo`, `eno1`, `wlan0` and `docker0`.** |
| 5. Read-only files | **Not possible here.** | Without bwrap, the engine can **read and write `.env.local`, the home folder, the model folder, the venv and its own code**. This confirms the gap the sandbox must close. |
| 6. Process isolation | The environment is reduced to `PATH`, `HOME` and `LANG` (checked in `/proc/<pid>/environ`), and each engine has its own process group. | There's no PID, mount or network namespace without bwrap. |
| 6. Memory limit | **cgroups aren't reachable here.** `RLIMIT_AS`, the only limit available, was tested as a fallback. See below. | – |

### What the `RLIMIT_AS` test found (important for Step 2)

| Limit | Paddle | Tesseract |
|---|---|---|
| 875 MB (= 700 × 1.25) | `/health` answers OK, then **every reading fails**: ONNX Runtime can't even map its library | – |
| 1,500 MB | Healthy, then readings fail (`ONNXRuntimeError`). In the first run, one image failed and the next succeeded | – |
| 2,500 / 4,000 MB | 16/16 lines | – |
| 250 / 500 / 1,000 MB | – | 16/16 lines at all three limits (VmPeak 172 MB) |
| Overrun (`none` server allocating 600 MB under a 300 MB limit) | Clean `MemoryError`, exit 1 | – |

Four findings for the design:
1. **`RLIMIT_AS` can't replace the cgroup limit for Paddle.**
   - ONNX Runtime's virtual size is about **3.8×** its resident memory (2,057 vs 538 MB).
   - Any address-space limit tight enough to protect the system breaks it.
   - It's usable only for Tesseract. The cgroup `MemoryMax` (it counts resident memory) remains a requirement. **If bubblewrap or cgroups are missing on a device, the gap is real and must be stated.**
2. **ONNX Runtime fails late: at the first inference, not at load.**
   - So `/health` must run **one warm-up inference on a built-in test image** before it reports ready.
   - That also absorbs the 1.2 s first-image cost (§2).
3. **An engine error must never become "no text".**
   - My first server, copied from the bench, turned Paddle's errors into an empty list. Under the limit, it answered `200 OK` with **0 lines**, and in one run with **8 of 16 lines**.
   - For a blind user, that could be heard as "nothing written here" on a medicine box.
   - With the fix, errors became HTTP 500 (`ImportError` / `ONNXRuntimeError`).
   - Requirement for Step 2 and the adapter: engine failure → reading failed (existing failure path), never an empty document.
   - The bench's `run_ocr.py` has the same pattern. It's harmless there (no limits), but it must not be copied.
4. **Thread counts.** Paddle grows to 15 threads on 4 logical CPUs. In parallel, it slowed Tesseract. The manifest should set `intra_op_num_threads` (and `CPUQuota`) per engine.

## 6. Still to verify on the host (items 4–6, the real sandbox)

`bench/engines-step0/sandbox_check.py` is written but **hasn't been run**, so it may need small fixes. It installs and downloads nothing and uses no network. Run it in a normal terminal, **not** VS Code's built-in terminal (that one is inside the Flatpak):

```
python3 -I ~/Downloads/blind/bench/engines-step0/sandbox_check.py ~/Downloads/blind/bench/engines-step0/results/sandbox.json
```

What it checks:
- The bwrap and systemd versions, and whether the `memory` controller is delegated to your user.
- **Under `bwrap --unshare-all`:**
  - `/usr`, the venv, the models and the code read-only;
  - a private `/tmp`;
  - only the socket folder writable.
- **For each engine:**
  - that `/health` and `/read` work over the socket from outside the sandbox;
  - that only `lo` is visible and connections fail;
  - that `.env.local` isn't visible and the model and code folders aren't writable.
- **Under `systemd-run --user --scope -p MemoryMax=… -p MemorySwapMax=0`:**
  - the 600 MB overrun in 300 MB is killed;
  - Paddle passes in 875 MB, and its `memory.peak` is recorded;
  - Paddle in 350 MB is killed, and the client sees a **transport error, not an empty reading**;
  - Tesseract passes in 250 MB.

Or allow this assistant to run it once through `flatpak-spawn --host`. That runs commands outside the editor's sandbox on your machine, so it's your decision.

## 7. Actual results compared with the proposed architecture

| Proposal | Result | Verdict |
|---|---|---|
| Two separate Python engine servers | Start, read and stop independently. Server overhead about 19 MB and 7–15 ms per request | **Confirmed** |
| Startup "a few seconds" (Paddle), "under 1 s" (Tesseract) | 1.6 s and 0.4 s to healthy; about 6.5 s and 1.2 s to the first answer | **Confirmed**; add warm-up to health |
| `ramMB` 700 (Paddle) and 200 (Tesseract) | Peaks 538 and 124 MB | **Confirmed** for mock images; re-check with real photos |
| Pair about 0.7 GB in sequence and 0.85 GB in parallel | 0.53 and 0.66 GB | **Better than estimated** |
| "In parallel when the budget allows" | Parallel is 33 % faster in total (10.4 vs 15.5 s) for +131 MB | **Confirmed**; also cap threads |
| Unix socket API | Works; 108-byte path limit | **Confirmed** outside the sandbox; across bwrap **untested** |
| bubblewrap network namespace and read-only binds | Not possible from this session. Without them, the engine can write `.env.local` and sees all interfaces | **Untested**; still required (the gap is real) |
| cgroup `MemoryMax` | Untested here. The `RLIMIT_AS` fallback is unusable for Paddle | **Untested**; still required, and with no fallback for Paddle |
| No runtime downloads | Paddle runs normally with IP sockets blocked | **Confirmed** (in-process check) |
| Engine errors | They can turn into empty readings unless designed against | **New requirement** (§5, findings 2–3) |

Changes I'd suggest to the proposal, for your review. None are applied:
- health includes a warm-up inference;
- engine errors are never mapped to empty results;
- a per-engine thread cap;
- the socket in `$XDG_RUNTIME_DIR`;
- `RLIMIT_AS` only as a supplementary limit for Tesseract, never for Paddle.

Not done, because it wasn't in the authorised list:
- a "one recogniser by script" speed test for Paddle (in the proposal's Step 0 row);
- a cold-cache startup measurement (needs root).

**Waiting for your review. Step 1 and N3 haven't been started.**
