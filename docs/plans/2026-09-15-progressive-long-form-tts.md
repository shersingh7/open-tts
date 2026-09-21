# Progressive long-form TTS — review and implementation plan

**Status:** Implementation authorized by David after this review; source/package candidate built. See `../reports/progressive-long-form-verification.md` for observed verification and remaining real-audio release gates. This document preserves the original proposal; its original plan-only approval language below is historical.

**Execution constraint:** Hermes implements and verifies this directly. **No delegates, Grok, AGY, or other coding agents.** No commits, pushes, extension reloads, server restarts, model changes, or real-model synthesis without the relevant approval.

**Goal:** A long essay should begin speaking after a small opening passage, continue generating ahead of playback with bounded memory, and remain controllable throughout. It must not wait for the document to finish, silently omit text, replay the beginning after an error, or falsely report completion.

**Architecture:** Retain local FastAPI/MLX, HTTP streaming, and the extension’s background routing. Repair the existing streaming pipeline rather than replace it. Use model-specific sentence-sized generation units, small PCM packets, bounded look-ahead, and a normal extension Reader tab for long/slow sessions that cannot safely depend on an audio-only offscreen document’s lifetime.

**Stack:** Existing Python, MLX/mlx-audio, NumPy, soundfile, FastAPI, vanilla JavaScript, Web Audio, pytest, and Vitest. No cloud TTS, WebSocket service, new framework, or new always-running daemon.

---

## 1. Bottom line

**Streaming already exists in this repository. The main problem is that parts of the pipeline still behave like batch generation, and the buffering/lifecycle contracts have gaps.** Merely adding a streaming flag or increasing timeouts would not fix this.

The strongest findings are:

1. **Qwen/Fish at non-1× speeds buffer a complete generation unit before emitting audio.** Both first and subsequent units default to 4,000 characters. This can make the existing stream feel non-streaming.
2. **A permitted 20-second audio packet can force playback to run dry before the next packet is scheduled.** A production-script fixture reproduced a 250 ms artificial gap even when both packets were immediately available.
3. **The playback owner has a browser lifecycle limit.** It is created with `AUDIO_PLAYBACK`; Chrome documents closure after 30 seconds without audio playing. Long startup, starvation, and long pauses need a real lifecycle solution, not HTTP keepalives.
4. **Cancellation checks happen after advancing the model iterator.** A stopped request can start an additional expensive generation step before noticing it was cancelled.
5. There are additional admission, cancellation-result, privacy, lifecycle, and test-isolation issues detailed below.

### Recommended product behavior

- **Short Kokoro selections:** keep the current lightweight speak widget/offscreen experience.
- **Essays and Qwen/Fish sessions:** open/reuse an extension **Reader tab**, with the same selection/popup entry points. The Reader owns playback, so closing the popup does not kill it and a long pause is not subject to the offscreen audio timeout.
- Begin with a small, sentence-aware opening unit; generate the rest while that audio plays.
- Keep the model and voice explicitly selected by the user. Kokoro remains the fast default, but **never silently switch a Qwen/Fish request to Kokoro**.
- Show loading, inference, buffering, playing, paused, completed, stopped, and failed as distinct states.
- If generation is genuinely slower than listening, show buffering honestly. No buffering algorithm can turn a slower-than-realtime model into a realtime one indefinitely.

The Reader tab is the main UX decision for review. It avoids relying on unsupported offscreen keepalive tricks. It is not a proposal to rewrite the backend or replace MLX.

## 2. What was actually inspected and verified

### Repository and live snapshot

- Repository: `/Users/shersingh/github/open-tts`
- Reviewed HEAD: `65db46f` — `fix: make long-text TTS generation and playback reliable`
- Source version: **3.4.3** in package, extension manifest, and backend config.
- Working tree was clean before this review.
- One read-only `GET http://127.0.0.1:8000/health` returned version **3.4.3**, model **qwen3-tts**, `state: ready`, `model_warm: true`, `gpu_busy: false`.
- This establishes the server snapshot, **not** the exact loaded extension version, speed setting, failing input, or cause of a specific past failure. No Chrome profile was opened or altered.
- Installed adapter source was read from `backend/venv/lib/python3.12/site-packages/mlx_audio/`; its distribution metadata identifies **0.4.5**. No dependency, model, or installed library was modified.

### Safe checks performed now

| Check | Observed result | Scope |
|---|---|---|
| Python AST parsing | 27 tracked Python files parsed | Syntax only; no model execution |
| `node --check` | 26 tracked JS/MJS files checked; no failures | Syntax only |
| Selected offline pytest files | **21 passed in 0.21s** | `test_adapters.py`, `test_audio.py`, `test_protocol.py`, `test_security.py`; bytecode/cache writes disabled |
| Production offscreen script with fake audio/fetch | Reproduced 20-second-frame scheduling gap | Real production JS, simulated clock and PCM; not a listening test |
| Production coordinator with a manually injected fake model | Reproduced speed-dependent buffering and late cancellation check | No real model load or GPU inference |
| Request schema/validation probe | 10,000 synthetic words / 69,999 characters rejected by single-text limit; accepted in two transport partitions; OpenAI request schema dropped `stream: true` | In-process schema validation; no HTTP generation |
| `git diff --check` | Passed before plan creation | No implementation edits |

The **full `npm test` suite was deliberately not run**: some native-host tests call the real Darwin signing helper before returning from their mocked startup paths. Fixing that isolation is part of this plan. The prior report’s 85 JS / 95 Python test results are historical, not newly verified totals.

### Reproduction observations

```json
{"probe":"max_frame_prefetch","atSeconds":19,"scheduled":1,"queuedSeconds":20}
{"probe":"max_frame_gap","firstEnd":20.25,"secondStart":20.5,"gapSeconds":0.25}
{"probe":"qwen_first_frame","speed":1.0,"model_parts_consumed_before_first_frame":1,"total_model_parts":3}
{"probe":"qwen_first_frame","speed":1.5,"model_parts_consumed_before_first_frame":3,"total_model_parts":3}
{"probe":"cancel_before_next_model_step","model_steps_executed":2,"error":{"code":"stream_cancelled","message":"Generation cancelled"}}
```

These are deterministic fixture observations. They do **not** measure real speech quality, Qwen speed, first-audio wall time, or current process memory.

## 3. Current production path

```text
popup.js / content.js
  → background.js: ensure server, attach token, route run identity
  → offscreen.js: normalize and partition into ~40,000-character HTTP texts
  → POST /v1/synthesize-stream-batch
  → api.py: per-request worker + queue of up to 32 framed items
  → coordinator.py: operation lock across the stream
  → split_stream_text(): ~4,000-character generation units
  → model.generate()
  → PhraseStreamPacker: native/1× incremental; non-native speed waits for unit drain
  → PCM16 WAV packets, up to 20 seconds each
  → Fetch reader → FrameDecoder → StreamCursor → decodeAudioData
  → createPlaybackRun: 20-second queue / 16 MiB decoded cap
  → AudioBufferSourceNode scheduling and onended cleanup
```

Keep the useful pieces already present: run ownership, strict per-index final/done validation, direct offscreen fetch rather than audio through Chrome messages, sample-preserving native PCM, and no automatic whole-document retry.

### Installed adapters matter

- **Kokoro:** installed `kokoro.py:293–314` accepts extra keyword arguments, but yields pipeline segments rather than using the supplied `streaming_interval`. Lowering that parameter is **not** a universal latency fix.
- **Qwen CustomVoice:** installed `qwen3_tts.py:2579–2584,2681–2723` incrementally decodes model output. The application can then defeat that benefit by buffering the entire semantic unit for speed processing.
- **Fish:** installed `fish_qwen3_omni/fish_speech.py:947–1044` rejects `stream=True`, but its ordinary generator yields internally segmented results (`chunk_length=300`). Do not describe it as token streaming; use progressive bounded passage generation.

Installed-library line references are review evidence, **not proposed edit targets**. Adapter fixes belong in this repository; do not patch the venv as the product implementation.

## 4. Severity-ranked findings

**Evidence labels:** `reproduced` = exercised with production code and controlled substitutes; `source` = directly traced behavior; `risk` = credible consequence not reproduced against the live browser/model.

| ID | Severity | Evidence / file and symbol | Issue and impact |
|---|---|---|---|
| F01 | HIGH | Reproduced; `backend/open_tts/audio.py:171–177,211–239`; `coordinator.py:498–529`; `config.py:24–25` | Non-native speed accumulates the whole 4,000-character generation unit before draining. At 1.5× the fake Qwen consumed all three model parts before first audio; at 1× only one. A long opening unit becomes a large startup barrier. |
| F02 | HIGH | Reproduced; `extension/shared/playback-session-umd.js:36–49,66–95`; `backend/open_tts/config.py:28`; `extension/offscreen.js:101–116` | The 20-second frame ceiling equals the entire playback budget, and `queuedSeconds` falls only when a whole source ends. Two available 20-second packets cannot be scheduled adjacently; the second waits for source end, then incurs recovery lead. |
| F03 | HIGH | Source + documented browser risk; `extension/background.js:16–26`; `offscreen.js:91–128`; Chrome offscreen documentation | An `AUDIO_PLAYBACK` offscreen document may close after 30 seconds without audio. Slow first audio, stalls, and long pauses are not protected by server keepalive frames. The fake browser harness has no offscreen lifetime model. |
| F04 | HIGH | Reproduced + source; `coordinator.py:233–257`; `api.py:345–354,367–382` | Cancellation/deadline checks occur after `next(model_iterator)`, allowing another native step after stop. Full/batch routes do not propagate HTTP disconnect into per-request generation cancellation. A caller timeout is not worker termination. |
| F05 | HIGH | Source/risk; `api.py:86–123,193–248`; `coordinator.py:381–433`; `protocol.py:34–50` | Admission is rate-limited but not bounded by concurrent job/byte leases before worker creation. Every stream can create a waiting thread/queue; request limits are applied after JSON parsing. Batch results accumulate base64 output without an aggregate output-byte budget. |
| F06 | HIGH | Source/risk; `backend/native_host.py:271–280,301–335` | Verifying the server PID does not establish ownership of its entire process group. `killpg(getpgid(pid), ...)` can affect unrelated processes when a manually launched server shares a shell process group. |
| F07 | HIGH | Source; `backend/tests/test_native_host.py:78–121`; `native_host.py:343–363`; `darwin_espeak_fix.py:28–83` | Nominal unit tests reach the real signing/venv-patching helper because it runs before mocked port checks and is not stubbed. This violates non-disruptive test expectations and makes broad verification unsafe on the working install. |
| F08 | MEDIUM | Reproduced + source; `offscreen.js:13–18,92,150`; `background.js:191–193`; `popup.js:609–617` | STOP and supersession use `TTS_DONE`, the same event as successful completion. A replacement can therefore record an interrupted passage as completed history. Terminal reason needs to be explicit. |
| F09 | MEDIUM | Source; `background.js:76–99,133–145,331–334`; `native_host.py:424–437` | Backend readiness accepts generic `status: ok` without verifying engine/protocol. Native stop responses are wrapped as success even if the host reports `success:false`. Startup uses `os.kill(pid,0)` rather than `Popen.poll()`, so an exited unreaped child can be misreported as starting. |
| F10 | MEDIUM | Source; `background.js:17,23,33`; `manifest.json`; `protocol.py:66–67`; `stream-decoder-umd.js:2–3`; `offscreen.js:43–46`; `config.py:21–29` | Compatibility limits are not negotiated: Python parser allows 64 MiB audio vs browser 8 MiB; backend duration is configurable vs hardcoded browser 20 s; `hasDocument()` is used unconditionally without a browser-version floor/fallback. Invalid environment values can also disable intended queue bounds. |
| F11 | MEDIUM | Source; `popup.js:532,559–561`; `content.js:167`; `PRIVACY.md:3–12` | Free-form `instruct` text is stored in `chrome.storage.sync`, even though the privacy statement says no text goes to cloud services. It belongs in local storage with a tested migration/removal of the old sync key. |
| F12 | MEDIUM | Source; `storage-umd.js:4–23`; `popup.js:455–473,545–564,609–615` | Speak reads saved settings while changes are still debounced; a just-adjusted speed/style can be stale. Storage callbacks ignore `runtime.lastError`. Completion history depends on the popup still being open. |
| F13 | MEDIUM | Source/risk; `adapters.py:74`; `coordinator.py:239–255,533–535`; installed Qwen `qwen3_tts.py:2595–2776` | The application treats any nonempty completed iterator as a successful unit. Qwen can end because the token budget was exhausted, not only because speech completed; token counts/finish information are discarded. A transport final does not prove all words were synthesized. |
| F14 | MEDIUM | Source; `backend/install_launch_agent.sh:46–60`; `README.md:120–130,250`; `AGENTS.md` lifecycle policy | The installer writes `RunAtLoad=true` and immediately kickstarts the service despite the on-demand operating policy. This is a script/default mismatch, not a claim about the currently installed LaunchAgent. |
| F15 | MEDIUM | Source; `popup.js:479`; `api.py:75–79`; `coordinator.py:372`; `scripts/model-matrix.py:77–127`; installed model RTF calculations | UI measures ACK, HTTP logging measures response setup rather than full stream lifetime, and the matrix reads the whole stream before parsing it. Adapter `real_time_factor` semantics differ: Kokoro reports generation/audio; Qwen/Fish report audio/generation. Current diagnostics cannot reliably distinguish startup, true streaming, speed, or buffering problems. |
| F16 | MEDIUM | Reproduced contract gap; `api.py:86–123,323–365,404–416`; `protocol.py:14–21` | `/v1/audio/speech` and `/v1/speech` are complete-file paths, not the extension stream, and an unknown `stream:true` field is silently discarded. A 69,999-character/10,000-word fixture fails the single-text cap but fits batch partitions. Users need explicit streaming contracts and useful oversized-input guidance, not misleading acceptance of a flag. |
| F17 | MEDIUM | Source/risk; `background.js:30–42,233–245`; `offscreen.js:141–144`; `content.js:220–245`; `popup.js:628–645` | State recovery lacks an owner-loss terminal path: no offscreen document can still be reported as active from a stale `activeSession`. A paused/lost owner or resumed popup may display Reading despite no audio owner. Controls are also offered before offscreen SPEAK is delivered, when there may be no run to pause. |
| F18 | LOW | Source; `README.md:59–62,118,169–179,244`; current setup/config | Documentation still mixes old defaults: all-model downloads vs optional downloads, playbackRate vs backend stretch, and `.ogg` examples while requests default to WAV. Historical plan/report must be distinguished from the new proposal. |

No critical security compromise is claimed. Source risks must receive deterministic regressions and, where applicable, authorized browser/model reproduction during implementation.

## 5. Target architecture and exact contracts

### 5.1 Preserve HTTP streaming; do not add WebSockets

```text
SPEAK + immutable settings + run identity
  → background: choose playback host and acknowledge accepted request
  → Reader tab for essays/slow models OR offscreen for short Kokoro
  → shared playback engine
      Fetch stream → incremental parser → one decode → short scheduled buffers
             ↑                                    ↓
         backpressure                  remaining-audio/byte budget
  → bounded backend admission → one model owner
      canonical text → model-specific units → generator → speed processing
      → bounded PCM packetizer → byte-bounded HTTP queue
```

Generation and playback overlap, but **two MLX model generations do not run concurrently**. The browser’s audio device can play while the GPU generates the next passage.

### 5.2 Separate three different chunk sizes

1. **Transport partitions:** satisfy request character/count limits; currently about 40,000 characters. They must not determine startup latency.
2. **Generation units:** small, semantic, model-safe text spans; chosen only by the backend.
3. **Playback packets:** short PCM audio pieces; chosen by duration/byte limits, not punctuation.

Do not split the complete essay into tiny HTTP calls merely to obtain streaming. A single admitted stream can contain many small generation units and playback packets.

### 5.3 Text planning

Retain normalization and add a `GenerationUnit` representation in `backend/open_tts/text.py`:

```python
@dataclass(frozen=True)
class GenerationUnit:
    unit_id: int
    transport_index: int
    start: int             # Unicode code-point offset in normalized transport text
    end: int
    text: str              # exact normalized[start:end]
    boundary: str          # sentence, paragraph, list, or hard_limit
```

- Preserve punctuation, order, paragraphs, lists, abbreviations, decimals, URLs, and Unicode.
- Backend offsets are code points; the Reader performs an explicit code-point-to-JS-offset conversion. Never silently mix Python indices and JS UTF-16 offsets.
- Only the first unit of the **whole request**, not every transport partition, gets startup sizing.
- Prefer a complete sentence/paragraph boundary near the target; use a hard bound when a sentence is exceptionally long. Do not append words or repeat context.
- Shared fixtures must prove exact concatenation of normalized unit substrings.
- Add non-Latin punctuation coverage; character caps are safety limits, not a universal language/token-duration predictor.

**Initial tunable defaults, not measured optimal values:**

| Model | Opening target / hard cap | Later target / hard cap | Model-output strategy |
|---|---|---|---|
| Kokoro | 300 / 600 characters | 900 / 1,200 characters | Native segment generator; native speed |
| Qwen3-TTS | 160 / 320 characters | 480 / 720 characters | Incremental model output; see speed policy |
| Fish S2 Pro | 160 / 300 characters | 300 / 500 characters | Progressive ordinary-generator segments; never `stream=True` |

The hard caps are starting design choices to qualify, not a claim of model context limits. Model-safe token/output checks remain independent.

### 5.4 Speed policy: simple first, no new DSP experiment by default

- Kokoro: keep native synthesis speed.
- Qwen/Fish at exactly 1×: preserve samples and emit incrementally wherever the model can yield.
- Qwen/Fish at other speeds: initially keep the existing pitch-preserving transform **per much-smaller semantic unit**, then packetize its output. This trades waiting for a short sentence group against the current wait for thousands of characters.
- All browser source nodes remain at **1×**. Do not apply requested speed twice.
- Retain sample identity at unity speed; do not insert arbitrary crossfades or silence to conceal scheduler gaps.
- Keep the full-file path’s semantic/speed treatment aligned with streaming.
- Do not claim truly incremental non-native DSP until a stateful time-stretch implementation is built and qualified. A persistent local processor/stateful WSOLA is a later alternative **only if** the small-unit solution misses the agreed latency or naturalness gates. No packet-local DSP resets marketed as a solution.

This is the recommended bounded first implementation, not a requirement to re-engineer a speech model.

### 5.5 Playback packets, buffers, and backpressure

Initial application limits:

| Resource | Proposed rule |
|---|---|
| Emitted audio packet | Target up to 2 seconds of processed audio; hard ceiling 4 seconds |
| Browser scheduled look-ahead | High-water 20 seconds; low-water 10 seconds, measured from AudioContext time |
| Browser decoded PCM | 16 MiB, including decode reservations and retained nodes |
| Browser decode concurrency | One |
| Browser parser-owned encoded backlog | 8 MiB; process frames incrementally rather than returning an unbounded array from one network read |
| Backend encoded transport queue | Bounded by both 8 MiB and item count; cancellation-aware offers |
| Semantic PCM accumulation | Explicit byte limit, initially retain 32 MiB ceiling; shorter units should keep ordinary use far below it |
| Raw JSON request body | 4 MiB before parsing, including requests without Content-Length |
| Aggregate request text | Retain documented 200,000-character batch ceiling; enforce raw and normalized totals |
| Free-form instruction | Explicit bounded length, initially 2,000 characters |
| Complete-file/batch output | Explicit aggregate PCM and encoded/base64 byte budgets, not a separate budget per result only |

The byte limits are application-owned budgets, **not** a bound on browser internals, OS socket buffers, model weights, MLX caches, or total RSS.

Scheduler changes:

- Track `scheduledUntil` and calculate `remainingSeconds = max(0, scheduledUntil - context.currentTime)`.
- Track decoded byte ownership separately; a partially played AudioBuffer still occupies its full allocation until released.
- Wake budget waiters on source end, pause/resume, cancellation, and a bounded audio-clock-based check while playing. Do not require the last long node to finish to free a time budget.
- Decode/schedule the next packet **before** the current tail drains.
- Add startup lead once; add recovery lead only after true underflow; otherwise schedules must abut.
- Support or explicitly reject a legacy large frame based on negotiated limits; never accept it and fall into a guaranteed gap.
- Do not translate a generation error into natural completion. Retain already-correct cleanup and stale-run guards.

### 5.6 Durable-enough playback ownership

Add `extension/reader.html`, `reader.css`, and `reader.js`.

- Default host selection: Reader for normalized text over 4,000 characters **or Qwen/Fish**; offscreen for short Kokoro. This is a UX threshold, not a model/context limit.
- Open/reuse one Reader tab only in response to Speak; do not create tabs on health/status queries.
- Reader UI: selected model/voice/speed, progress through source passages, elapsed listening time, buffered-ahead seconds, clear phase, pause/resume/stop, and a useful retained error.
- Closing the popup or source tab does not end Reader playback. Closing the Reader is cancellation; do not imply browser-close persistence.
- A shared playback-engine module may be introduced only after harness parity is established. Preserve existing run guards and message handler ownership rather than replacing them wholesale.
- Background routes by `hostId`, `runId`, and `clientId`; only one host can own sound. A replacement stops its predecessor before the new host starts.
- Reader messages must be validated as originating from the extension Reader, not arbitrary sender-supplied role fields.
- Recover state after service-worker restart by querying the actual host. If the host disappeared, report an interrupted run and clear stale state.
- Handle short offscreen-run destruction honestly as well: opening a new empty offscreen document must not count as resuming the old audio.
- No fake silent oscillator, unrelated offscreen reason, or always-open hidden page to bypass Chrome lifetime rules.
- Avoid broader extension permissions unless an exact required API proves they are needed. Feature-detect `hasDocument`; use the documented `runtime.getContexts` compatibility path and declare the supported Chrome baseline.

The official lifecycle reference is https://developer.chrome.com/docs/extensions/reference/api/offscreen — the Reasons section documents the 30-second no-audio behavior. This risk still needs a real Chrome test; it was not reproduced in the live profile during planning.

### 5.7 Backend admission and cancellation

Introduce a bounded owner/lease layer in `backend/open_tts/runtime.py`; keep model/speed logic in the existing coordinator.

- One active model job. At most one pending job by default; additional requests receive a typed busy response with Retry-After rather than spawning waiting threads indefinitely.
- Admission occurs before worker creation and before model loads. Bound request bytes independently of request count/rate.
- Load, warm, generate, generator close, model-specific cleanup, and unload execute on the same owner thread. The server remains on-demand; this is not a separate always-running daemon.
- Every job has its own cancel event and explicit phase. Shutdown additionally closes admission and cannot be undone by a later job clearing a shared flag.
- Check cancellation/deadline **before and after** each `next(generator)`. Close the iterator on its owner thread in `finally`, and use adapter-supported cleanup for streaming decoder state where necessary.
- Full, batch, and framed routes use the same cancellation/admission rules. Client disconnect cancels the job, not just the coroutine waiting for it.
- Distinguish queue wait, load/warm, active generation, backpressure, and stream idle deadlines. Pausing consumption is not hung inference; heartbeat delivery is not proof of generation progress.
- A native call already in progress remains cooperative-only. Mark a timeout/cancellation as pending until the owner returns; do not unload under it or label the worker free.
- **Deliberate v1 concurrency policy:** a paused generation session may retain the single model lease while bounded buffers fill. Other model-changing jobs are refused as busy, not silently queued for minutes. Fair multi-client time-slicing is not part of this fix. Stop releases the lease once current native work returns.
- A permanently nonreturning MLX call may still require an explicitly authorized backend restart. Process-isolated, forcibly killable inference is a separate architectural expansion, not an unproven promise of this plan.

### 5.8 Protocol and completion

Preserve existing endpoints and little-endian framing. Add version negotiation for richer metadata rather than changing old clients silently.

- New authenticated `GET /v1/capabilities`: protocol versions, input/frame limits, model generation mode, supported speed policy, and server version.
- Existing framed routes accept explicit `protocol_version`; v1 remains the compatibility path. A v2 response identifies itself in headers. The new client rejects mismatches clearly instead of parsing an old body with new assumptions.
- v2 frames have sequence numbers, unit IDs, source offsets, sample counts, and explicit unit-final/request-terminal records. Sequence resets per request; text index and sample rate remain validated.
- Heartbeats remain transport liveness, never progress or completion.
- A unit is generated only when its generator completed without error/budget exhaustion. A unit is **played** only when its final audio source ended.
- UI terminal outcomes: `completed`, `stopped`, `superseded`, `failed`, `owner_lost`. Success/history completion only for `completed`.
- Detect output-token-cap exhaustion where installed adapters expose cumulative/per-part counts; track per segment, not across unrelated segments. If finish reason cannot be known, use conservative cap-hit detection and mark the unit suspect/incomplete rather than confidently complete.
- Do not require an upstream `is_final_chunk` flag blindly: the inspected Qwen stream only marks a remainder frame final, so exact packet-boundary completion can lack that flag.
- Transport validation cannot prove speech contains every word. Add numbered passage fixtures and human listening; optional local transcription is supporting evidence, not a replacement for listening.

### 5.9 API compatibility and recovery

- `/v1/synthesize-stream-batch` and `/v1/synthesize` with `stream:true` remain the documented framed streaming APIs.
- `/v1/audio/speech` and `/v1/speech` retain complete-file behavior in this phase. Do **not** serve the custom framed body as `audio/wav` or pretend it is an OpenAI-compatible media stream.
- Explicitly handle unsupported streaming options instead of silently ignoring them; return actionable guidance to the framed endpoint. Keep existing successful complete-file requests compatible.
- Improve oversized-input errors to explain which limit was exceeded and how to partition or use the Reader. Do not silently slice text or merely raise limits to accommodate a document.
- No automatic whole-document retry after audible output.
- In a surviving Reader, retain the interrupted unit and offer an explicit **Retry from interrupted passage** action. Warn that the beginning of that passage may repeat. Do not claim exact-word resume, and do not skip unplayed queued audio.
- Do not persist a new complete essay/checkpoint by default just to support recovery. Browser-close recovery and disk audio caching are out of scope; existing draft/history preferences remain local.

### 5.10 Privacy, settings, and lifecycle hygiene

- Build the immutable request settings snapshot directly from current UI values. Storage persistence may be debounced; actual Speak parameters must not be.
- Storage promises must reject on `chrome.runtime.lastError`, with visible recoverable errors.
- Move `instruct` to local storage: copy legacy sync value only if local is absent, verify local write, then remove the legacy sync key. Document that removing the key does not erase any historical provider backups.
- Own history completion in the background/local persistence layer so it does not require an open popup. Honor `historyEnabled` and distinguish completion from stop/replacement.
- Health checks validate engine and protocol; a foreign service on port 8000 is not “ready.” Refresh a stale install token once **before** audio starts; never silently replay audible output for an auth retry.
- Native process-group kill only when ownership of an isolated group/session is established. Otherwise signal the verified server PID only; never kill the caller’s shell group.
- Native startup uses `process.poll()`, listener identity, and bounded verified readiness. Native refusal/failure propagates to the UI as failure.
- Make LaunchAgent installation on-demand by default (`RunAtLoad=false`, no kickstart). Any auto-start behavior requires an explicit opt-in flag and accurate documentation. Do not modify the currently installed LaunchAgent during source repair.

## 6. File-level implementation sequence

Each step follows **failing regression → confirm intended failure → smallest cohesive change → focused pass**. Do not accept tests that merely search source strings, or a simulated implementation that bypasses the production path. No auto-commits.

### Task 1 — Make verification safe

**Modify:** `backend/tests/conftest.py`, `backend/tests/test_native_host.py`, `.github/workflows/ci.yml` as needed.

1. Add autouse isolation for signer, process launch/signals, live sockets, production PID/token/log paths, and real model downloads in ordinary tests.
2. Inject controlled fakes through fixtures; opt-in integration tests must use isolated paths/ports.
3. Fix the test that assigns `native_host.sys.stdin` without restoring it; use monkeypatch consistently.
4. Add a regression that raises immediately if an ordinary native-host test reaches signing, Popen, launchctl, or a real kill operation.
5. Run full baseline only after those guards are in place. Capture actual exit codes and totals.

**Gate:** `npm test` succeeds without model inference, downloads, changes to venv/native installs, or live-server calls.

### Task 2 — Lock in the newly reproduced failures

**Modify:** `extension/tests/offscreen.test.js`, `extension/tests/pipeline-harness.js`, `backend/tests/test_long_text.py`, `backend/tests/test_coordinator.py`.

- Add immediately available 20 s + 20 s packets; assert exact adjacency, not merely absence of overlap.
- Add mixed packet sizes, delayed decode, audio-clock advancement without onended, and paused clocks.
- Add Qwen-like delayed yields at 1/1.5/2/3×; record when the first playable packet escapes relative to unit completion.
- Add cancellation immediately after the first yield; assert no second model advancement.
- Add explicit STOP/supersession outcome assertions and native-group ownership fixtures.

**Gate:** the new tests fail on reviewed HEAD for the intended causes. Preserve those failures in the implementation report.

### Task 3 — Centralize limits and capabilities

**Modify:** `backend/open_tts/config.py`, `registry.py`, `api.py`, `protocol.py`; `extension/shared/constants-umd.js`, `protocol-umd.js`.

**Create:** `backend/tests/test_capabilities.py`.

- Validate positive queue sizes, finite timeouts, high/low-water relationships, legal frame duration, and byte ceilings at startup.
- Add model-specific generation profiles and capability schema with explicit versions.
- Keep v1 defaults compatible; add v2 negotiation tests and clear mismatched-version errors.
- Remove or document unused knobs such as the historical crossfade/fallback constants; do not expose controls with no effect.

**Gate:** invalid settings fail fast; client/server fixture limits agree; default settings are covered.

### Task 4 — Implement model-aware text units

**Modify:** `backend/open_tts/text.py`, `adapters.py`, `coordinator.py`.

**Create:** `backend/tests/test_text_planner.py`, `tests/fixtures/text-cases.json`.

- Add source-preserving GenerationUnit planning and first-unit-only behavior across transport partitions.
- Apply the proposed per-model targets/hard bounds.
- Cover a 10,000-word fixture, one giant paragraph, very long sentence/token, quotations, list lines, decimals, abbreviations, soft wraps, emoji, and non-Latin punctuation.
- Keep generation-unit planning on the backend; the browser still partitions only for transport and validates overall size.

**Gate:** exact normalized-text coverage/order, bounded unit sizes, stable IDs/offsets, and no empty unit reaching inference.

### Task 5 — Repair packetization and speed startup

**Modify:** `backend/open_tts/audio.py`, `coordinator.py`, `adapters.py`; related audio/coordinator tests.

- Packetize processed output into short duration/byte-bounded WAVs without sample removal or overlap.
- For native/1×, emit when the small packet threshold is met; flush short tails.
- For non-native speed, flush each new small semantic unit rather than the former large slice.
- Keep Qwen true model streaming and Fish ordinary segmented generation correctly differentiated.
- Preserve sample-rate/shape/nonfinite validation and packetization-independent DSP within each semantic unit.

**Gate:** native/unity sample identity, bounded frames, non-native duration/pitch fixtures, first short unit audible before later units finish. Real naturalness remains a later gate.

### Task 6 — Correct look-ahead and parser memory

**Modify:** `extension/shared/playback-session-umd.js`, `playback-umd.js`, `stream-decoder-umd.js`, `extension/offscreen.js`; existing playback/decoder/offscreen tests.

- Replace whole-node duration accounting with remaining audio horizon for time budgets; retain full ownership accounting for bytes.
- Add cancellable budget wakeups, pause-aware clocks, and one-decode reservation invariants.
- Make parser delivery incremental per frame; bound retained encoded bytes and malformed-frame allocations.
- Validate new negotiated packet limits and prevent guaranteed starvation from legacy large packets.

**Gate:** zero artificial gap on immediately available frames; zero overlaps after true starvation; bounded memory during prolonged pause; all sources/readers/timers released on every terminal path.

### Task 7 — Add bounded owner and cancellation propagation

**Create:** `backend/open_tts/runtime.py`, `backend/tests/test_runtime.py`.

**Modify:** `coordinator.py`, `api.py`, `errors.py`, `security.py`, `test_api.py`, `test_coordinator.py`.

- Add the active/pending admission lease and single owner-thread execution path.
- Add request body/aggregate instruction/text limits before expensive parsing/inference work where applicable.
- Wire cancel/deadline checks around every generator advancement; final cleanup stays on the owner thread.
- Propagate disconnect for all synthesis routes; cap aggregate batch/full-file output bytes including serialization cost.
- Close admission during shutdown; queued jobs must not reload a model after shutdown.
- Report load/infer/backpressure/cancelling phases honestly. Busy model changes fail promptly, including during pause.

**Gate:** concurrent flood never exceeds configured admission; cancelled waiters never infer; stop-before-next-yield regression passes; a noncooperative fake worker is never unloaded or falsely marked free.

### Task 8 — Add protocol outcomes, unit progress, and truncation detection

**Modify:** `protocol.py`, `coordinator.py`, `api.py`; `stream-decoder-umd.js`, `protocol-umd.js`; protocol/coordinator/browser tests.

- Implement v2 unit metadata, sequence validation, explicit terminal outcomes and source mapping.
- Preserve v1 frame behavior for old clients.
- Track adapter result token counts per semantic segment; fail explicitly at a suspicious output cap rather than emit successful unit final.
- Track generated vs scheduled vs fully played unit positions separately.
- Keep errors terminal and retries explicit; no hidden whole-text fallback.

**Gate:** missing/out-of-order/truncated frames fail; token-exhausted fake model cannot succeed; stopping/replacing a run never writes completed history.

### Task 9 — Introduce the Reader host without destabilizing short playback

**Create:** `extension/reader.html`, `reader.css`, `reader.js`, `extension/shared/playback-engine-umd.js`, `extension/tests/reader.test.js`.

**Modify:** `background.js`, `offscreen.html`, `offscreen.js`, `manifest.json`, production harness/background tests.

1. Establish parity tests for the current offscreen path before extracting shared fetch/parse/decode/schedule logic.
2. Keep existing message listener/ownership guards structurally intact; introduce a small host abstraction rather than a global handler rewrite.
3. Add Reader readiness handshake and host selection from immutable request settings/text length.
4. Route controls/status by host identity; recover after service-worker restart; report owner loss.
5. Implement the long-form UI, retained error, and explicit retry-from-interrupted-passage in the living Reader.
6. Ensure no duplicate audio across Reader and offscreen; close Reader stops its own run only.

**Gate:** fake lifecycle tests cover popup closure, Reader closure, delayed host startup, A→B replacement, stale messages, and worker restart. No installed extension is reloaded in this step.

### Task 10 — Fix settings, history, and privacy

**Modify:** `popup.js`, `content.js`, `background.js`, `shared/storage-umd.js`, `PRIVACY.md`; storage/popup/content/background tests.

- Snapshot live UI values for Speak; persistence debounce must not change the audible request.
- Reject storage errors rather than silently resolve.
- Migrate `instruct` from sync to local only, with failure-safe ordering.
- Move completion history persistence out of popup lifetime; respect disabled history.
- Expose truthful startup/paused/stopped/failed status; do not label a run playing merely because it exists.

**Gate:** immediate speed-change-and-Speak uses the new value; no instruction text is newly written to sync; local write failure does not delete the legacy value; popup closure does not misclassify history.

### Task 11 — Harden native/server lifecycle truthfulness

**Modify:** `backend/native_host.py`, `backend/install_launch_agent.sh`, `extension/background.js`; native/background tests.

- Signal only the verified PID unless the process group/session is demonstrably owned.
- Use `Popen.poll()` and exact listener identity for startup; propagate native refusal/failure intact.
- Verify engine/protocol before accepting health; handle a stale token with one pre-audio refresh.
- Make LaunchAgent installation on-demand by default, with separately named opt-in auto-start flags.
- Do not execute install/uninstall/signing/launchctl against the user account as part of this source task.

**Gate:** mocked foreign/shared-group/dead-child cases fail safely; LaunchAgent XML is tested in a temporary HOME with fake launchctl; stop failure never becomes a green UI success.

### Task 12 — Make diagnostics useful and APIs explicit

**Modify:** `api.py`, `coordinator.py`, `popup.js`, `reader.js`, `scripts/model-matrix.py`, `README.md`, `CHANGELOG.md`.

**Create:** `scripts/verify-long-text.py`, `docs/reports/progressive-long-form-verification.md` during implementation.

- Record request accepted, model ready, first model PCM, first emitted packet, first scheduled/started audio, generation finished, playback finished, and terminal reason.
- Measure a normalized RTF as **active generation seconds / produced processed-audio seconds**; report end-to-end time separately. Do not trust adapter RTF naming.
- Record underflow count/duration, maximum look-ahead, owned encoded/decoded bytes, and cancellation-to-worker-release latency.
- No raw selected text, auth token, or free-form instructions in diagnostics. Use request IDs and fixture IDs.
- Update streaming benchmark to parse incrementally while timing arrivals rather than `response.read()` of the whole body.
- Make the new long-text runner require an explicit URL/mode and refuse production/default-port mutation by default; no automatic model switches or server launches.
- Document complete-file API limits and explicit rejection/guidance for unsupported streaming flags; fix stale setup/speed/output-format examples.

**Gate:** fixture trace proves audio escaped while later generation was blocked, timing fields are internally consistent, and benchmark scripts cannot silently start/switch a live model.

### Task 13 — Offline regression and packaging

**Modify:** package/config/manifest version fields together; packaging tests/scripts only as needed.

- Run full corrected suites after the final implementation/doc write.
- Soak through production scripts with varied frame durations and simulated long audio, including slow producer, slow decoder, pauses, cancellations, malformed input, errors and replacement runs.
- The existing soak checks non-overlap but not continuity; add both gap and overlap invariants.
- Package the extension and inspect ZIP CRC, version, entry list, Reader/shared modules, and source-byte equality.
- Confirm final git status includes only intended files; no runtime assets, logs, caches, tokens or audio fixtures accidentally staged.
- Populate the requirement → production symbol → regression → observed result report. Do not recycle old test totals.

**Gate:** all deterministic acceptance rows pass, package is valid, and no runtime is installed or restarted.

### Task 14 — Separately authorized real audio/browser qualification

This task is specified now but **not authorized by the current plan-only request**.

- Read-only health/resource preflight; do not overlap another GPU workload. An idle loaded model still belongs to the user; do not replace it without authorization.
- Use an isolated server/profile with separate runtime paths. An isolated port alone does not prevent token/PID collisions; add and use an explicit test runtime directory.
- Do not run production native-host/LaunchAgent installation merely to test Reader streaming.
- Test the real extension path, not just HTTP: selection and popup → Reader/short offscreen → audible playback → pause/resume → stop → replacement; close/reopen popup and restart worker.
- Exercise long first-audio delay and pauses beyond 30 seconds, owner destruction, background-tab operation, and Mac sleep/wake with truthful interruption handling.
- Use real, varied synthetic fixtures with uniquely numbered paragraphs. Start with short, then 2,000-word, then 10,000-word input. Do not begin with an expensive all-model/all-speed matrix.
- Qualify Kokoro first, then the specifically affected Qwen configuration; Fish separately. No silent model substitution.
- Record warm/cold conditions and actual selected speed. Review boundary excerpts for clipped words, repeats, omissions, clicks, pitch warble, and unnatural sentence joins.
- Inspect browser network/console plus scheduling traces; a UI label or HTTP 200 is not proof of audible success.
- Installation/reload/promotion occurs only after David approves the qualified result; record the exact backend/extension versions and rollback artifacts.

## 7. Commands and execution gates

### Commands already run safely during this review

```bash
cd /Users/shersingh/github/open-tts

env -u PYTHONPATH PYTHONDONTWRITEBYTECODE=1 \
  HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  backend/venv/bin/python -B -c '
import sys, pytest
sys.path.insert(0, "backend")
raise SystemExit(pytest.main([
    "-p", "no:cacheprovider",
    "backend/tests/test_adapters.py",
    "backend/tests/test_audio.py",
    "backend/tests/test_protocol.py",
    "backend/tests/test_security.py", "-q"
]))'
```

Observed: `21 passed in 0.21s`.

### After Task 1 test isolation, during approved implementation

```bash
cd /Users/shersingh/github/open-tts
npm run test:js
npm run test:backend
npm test
npm run package:extension
git diff --check
git status --short
```

Expected: genuine zero exit codes, with all failures/skips/unhandled exceptions reported; no `|| true` around verification. Focused pytest/Vitest commands should target each new file during its TDD cycle.

Do not run the current `npm run test:model-matrix` casually: the inspected runner defaults to port 8000 and force-loads models. The new long-text runner must have safety guards before it is used.

## 8. Acceptance criteria

### Deterministic correctness — mandatory

- 10,000-word text survives planning exactly once, in order; limits are explicit.
- Startup generation work is bounded by the first model-specific unit, not essay length.
- Native/1× output begins before the model finishes later audio; non-native speed begins after the small first semantic unit, not a 4,000-character slice.
- Ready packets play adjacently; no artificial periodic gaps, overlaps, or source scheduling in the past.
- Time and byte budgets hold under pause, slow decode, burst delivery, and malformed frames.
- Stop silences scheduled browser audio promptly and prevents any new model step after cancellation is observed. Already-running native work is reported honestly.
- Completed, stopped, superseded, failed, and owner-lost runs are distinct; one terminal outcome per run.
- A cap-truncated or missing unit cannot be marked completed.
- New stream metadata is negotiated; old valid v1 clients remain valid or get an explicit compatibility error, never misdecoded audio.
- No ordinary test signs libraries, touches production runtime files, starts/stops services, or loads a real model.
- No new cloud text storage; no broader permissions without documented necessity.

### Performance and listening — proposed release targets, not measured results

- **Warm Kokoro:** target first audible output within 3 seconds for the agreed 10,000-word fixture. Compare with a short-prefix fixture sharing the same opening to prove startup does not scale with the entire document.
- **Qwen/Fish:** report actual first-audio latency at the selected speed and demonstrate it is bounded by the opening unit. Do not promise Kokoro latency or uninterrupted realtime for these models.
- **Continuous playback:** zero avoidable scheduling gaps when the producer is faster than consumption; genuine model starvation is measured and labelled.
- **Controls:** target browser silence within 250 ms of Stop in the authorized browser check; backend worker-release latency is a separate metric.
- **Memory:** application buffers remain under configured caps; record actual process RSS/MLX peak separately and verify no essay-length-proportional retained browser PCM.
- **Long pause:** Reader survives a pause of at least two minutes without resetting or losing its current passage; no silent offscreen lifetime workarounds.
- **Naturalness:** before/after boundary excerpts and listening review. Synthetic DSP tests alone cannot pass this criterion.

If a target fails, the report must say so. Do not loosen the target after the run and call it a pass.

## 9. Scope and approval boundaries

### Included in the proposed implementation

The findings above, bounded sentence-progressive streaming, correct playback look-ahead, long-form Reader ownership, cancellation/admission, privacy/settings fixes, safe lifecycle/test behavior, useful diagnostics, regression tests, and packaging.

### Not included by default

- Cloud TTS or moving away from MLX.
- Automatic model/voice substitution.
- New custom DSP unless the first solution fails qualification.
- Browser-close durable resume, whole-audiobook audio caching/export, word-perfect seeking, or speech-model retraining.
- Unlimited input length or multi-user GPU time-slicing.
- Forcibly terminating native inference in-process.
- Auto-starting services on login, system tuning, production reinstall, commit or push.

### Approval checkpoints

1. **Plan review:** approve or revise the Reader-tab UX and the small-unit-first strategy.
2. **Source implementation:** direct Hermes work through Tasks 1–13, with offline verification; no deployment implied.
3. **Real qualification:** separately approve the bounded browser/model run and ownership of the test runtime.
4. **Promotion:** separately approve installation/reload and any commit/push.

These are phase boundaries, not a request to stop after each test. Within an approved phase, fixes and verification should proceed continuously until its acceptance criteria are met.

## 10. Recommended order

**Safe tests → reproduce current gaps → model-aware units + short packets + scheduler → cancellation/admission → Reader lifecycle → outcomes/settings/privacy/native fixes → useful diagnostics → offline package → authorized real listening.**

Do not start with larger timeouts, a bigger batch limit, or a new transport protocol. The source already has streaming; the fix is to make the entire path genuinely progressive, bounded, and honest about its state.
