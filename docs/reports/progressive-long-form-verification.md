# Progressive long-form TTS — implementation and offline verification

**Version:** 3.5.0 source/package candidate. **Execution:** implemented directly, without AGY, Grok, or delegates. No commit, push, deployment, extension reload, real-model synthesis, live server restart, production signing, or LaunchAgent installation was performed.

## Result

The existing framed HTTP pipeline now starts from small model-aware passages rather than whole-essay generation or 4,000-character opening units. Native PCM is emitted in short packets. Non-native speed processing remains pitch-preserving and runs once per bounded passage. The visible Reader and lightweight offscreen document share the same production engine (`extension/offscreen.js`); there is no duplicated audio implementation.

This is a **verified offline build**, not a real-audio release qualification. Real Chrome lifetime/autoplay, actual first-audible latency, model throughput, and naturalness of new passage boundaries are still unmeasured.

## Observed verification

- `npm test`: **101 JavaScript tests passed**, **116 Python tests passed**.
- Production-script fixture soak: **2,000 frames / 2,000 simulated audio seconds**, peak scheduled horizon **20.25 seconds**, peak owned decoded reservation **1,920,512 bytes**, **one terminal event**. These are fake-audio/simulated-clock results, not MLX benchmarks.
- A **10,000-word numbered fixture** runs through the actual Python coordinator, v2 framing, and a fragmented incremental measurement reader. Source/unit coverage and final completion are checked.
- Non-native 1.5× regression: first Qwen fixture passage emits audio before the next passage is generated; first passage end is within 320 code points.
- Synthetic PCM tests preserve every native sample and test pitch/duration behavior across 0.5×–3×. They do not establish natural speech quality.
- Python AST, Node syntax and shell syntax checks: **33 Python files, 28 JavaScript files, 9 shell scripts** passed.
- Package: `dist/open-tts-extension-v3.5.0.zip`, **27 entries**, CRC valid, every archive entry byte-equal to its source. Reader/offscreen script references resolve inside the archive. Manifest/package/lock versions agree at 3.5.0.
- `git diff --check` passed after removal of one trailing blank line in a test.

## Requirement → production implementation → regression evidence

| Finding | Implementation | Verification / remaining boundary |
|---|---|---|
| F01: long non-native startup | `text.plan_generation_units`, `coordinator.stream_batch_frames`; short opening and model-specific later passages | `test_progressive.py`, `test_nonnative_first_passage_escapes_before_next_generation`; real latency remains pending |
| F02: artificial packet scheduling gaps | 2 s packet default, maximum configured 4 s; `createPlaybackRun` budgets remaining AudioContext horizon while retaining buffer bytes | Native sample preservation, rolling-horizon adjacency test, 2,000-frame soak; legacy oversized packets fail before decode |
| F03: offscreen inactivity lifetime | Reader for >4,000-character selections and Qwen/Fish; same audio engine for both hosts | Both hosts execute v2 fixture pipeline; Reader routing verified; real >30 s pauses/startup, background tabs and sleep/wake pending |
| F04: cancellation after native advance | Checks before and after `next`; iterators close on owner thread; request cancellation propagated through `await_job` and stream worker | No extra iterator advancement, held noncooperative call retains lease, queued cancelled job never runs |
| F05: unbounded admission/body/results | `ModelRuntime` one owner + one pending; pre-parse 4 MiB body bound/four body handlers; item/byte frame queue; full PCM/batch output caps | Concurrent lease/cancellation test, chunked body without Content-Length, frame byte cap, explicit full/batch cap failures |
| F06: shared process group termination | Group signals only when target is both group and session leader; otherwise verified PID only | Mock shared group vs isolated session tests; no live signals |
| F07: unsafe unit-test signing/runtime access | Autouse guards for signing, Popen, signals, health/ports, model loads and GPU cleanup; temporary runtime paths | Full suite now runs without real model loads, signing or native lifecycle effects |
| F08: false completion/history | Explicit completed/stopped/superseded/failed/owner_lost outcomes; deduplicated terminal delivery; worker-owned local history | Completed-only history test with duplicate/late terminal events and no popup |
| F09: readiness and native response truth | Engine/version/capability checks; failed stop stays failed; `Popen.poll`; PID retained until confirmed exit | Fake native stop failure, exited child, and pending cleanup tests |
| F10: incompatible limits | Capability endpoint; requested v2/response-header check; aligned frame limits; config validation; Chrome 116 minimum | Capability, protocol/sequence, oversized frame and version/package checks |
| F11: synced free-form text | Local instruction storage; copy/readback before removing legacy sync key | Successful migration and quota-failure preservation tests; prior provider backups cannot be retroactively guaranteed deleted |
| F12: stale settings/history lifetime | Speak snapshots current controls before awaits; storage failures reject; history written by worker | Debounced stale settings regression, storage failure tests, popup-independent history |
| F13: token exhaustion | Reject exposed `finish_reason` length/max_tokens or token counts reaching the requested cap | Exhaustion fixture fails, never completes. Opaque adapters still cannot prove every spoken word; listening qualification remains required |
| F14: LaunchAgent defaults | RunAtLoad false, no kickstart unless `--auto-start` | Installer exercised only in temporary HOME with a logging launchctl stub and plist validation |
| F15: misleading timing/RTF | Measured generation seconds / processed audio seconds; packet/schedule/clock/terminal markers; underflows; queue bytes and cancellation-release diagnostics | Incremental fragmented stream measurement and fixture timing invariants; observed clock start is not an acoustic output measurement |
| F16: complete-file vs streaming APIs | Speech compatibility endpoints reject `stream:true`; oversized text points to partitioned framed endpoint | Both speech routes reject unsupported streaming; ten-thousand-word fixture uses partitions |
| F17: lost owner/stale UI | Physical-host discovery before replacement, recovery across worker restart, lost-owner errors, preparing/buffering restoration | Restart-to-new-Speak stops existing Reader first; lost Reader cannot claim successful resume; existing popup/control race tests pass |
| F18: stale docs/defaults | README, privacy, changelog, version displays and lockfile updated | Source/package checks; setup now documented as Kokoro default with optional larger downloads |

## Resource contract

- Generation character profiles (first target/hard cap, later target/hard cap): Kokoro **300/600, 900/1200**; Qwen **160/320, 480/720**; Fish **160/300, 300/500**.
- Server frame queue: **8 MiB**, plus its item bound; one model-owner thread, one pending job.
- Browser decoded PCM reservations: **16 MiB**; remaining look-ahead **20 s + 250 ms startup/recovery lead**; one decode in flight; lazy parser rather than a list of coalesced audio frames.
- Raw request body **4 MiB**; instructions **2,000 characters**; per-text **50,000** and aggregate **200,000 characters**, at most **50** texts by default.
- Semantic input PCM **32 MiB**, full processed PCM **128 MiB**, batch base64 output **128 MiB**. Temporary transform/encoding copies and the MLX model are additional allocations; these are not a process-RSS guarantee.
- Native MLX work is cooperatively cancellable only. Stop cancels user-visible playback promptly, but the backend retains ownership until the native call returns. It never unloads a running model to simulate cancellation.

## Intentional implementation choices

1. Reuse `offscreen.js` as the shared engine loaded by both documents, instead of moving working entry points into a second copy/module. Reader UI remains in `reader.js`.
2. New extension requires v2; legacy API consumers can still use v1. No silent downgrade or whole-document batch fallback.
3. Retry is an explicit Reader action at the last fully played passage boundary. It can repeat the interrupted passage, not skip its unplayed tail. There is no automatic restart.
4. `scripts/verify-long-text.py` is HTTP-only, requires explicit opt-in, isolated URL/runtime and selected model, refuses production port 8000 and production runtime directory, and never starts/stops or switches another loaded model.
5. Model matrix now also requires explicit opt-in and a separate model-switch authorization flag. Its stream measurements parse arrivals incrementally instead of reading the entire body first.
6. Application-level parser/decode/queue budgets are tested independently. Browser networking and MLX allocator overhead are outside these budgets.

## Remaining release qualification — not performed

On separately authorized isolated runtime/profile, with no competing GPU workload:

- Real Kokoro first, then affected Qwen speed, Fish separately; warm/cold labels and exact model/voice/speed recorded.
- Short → 2,000-word → 10,000-word synthetic reading. Listen for dropped/repeated words, clipped endings, clicks, pitch artifacts and unnatural passage joins.
- Actual selection/popup → Reader/offscreen → audible audio, pause/resume/stop/replacement; popup closure/reopen, service-worker restart, >30 s inactivity, owner destruction/discard, background tab and Mac sleep/wake.
- Measure real first audible audio, gaps/underflows and memory over a sustained reading. HTTP delivery and a Reading label are not proof of sound.
- Install/restart/reload only after approval. This build did not change the currently installed runtime, browser profile, model weights or live audio workload.

No real-model speedup figure or seamless-playback guarantee is claimed. A model that generates slower than real time can still exhaust the look-ahead buffer.
