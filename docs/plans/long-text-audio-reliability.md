# Long-text audio reliability implementation plan

**Goal:** Make long-form extension playback preserve all text, maintain natural structural pauses, never overlap audio after a stall, and report interruption honestly rather than skipping or replaying speech.

**Execution:** David explicitly requested Grok Build implementation. Grok owns code edits; Hermes independently verifies the settled diff. Preserve existing uncommitted work. No commits, pushes, install/reload, production lifecycle changes, model downloads or real-model synthesis in this phase.

**Architecture:** Keep local FastAPI/MLX and the MV3 content → background → offscreen architecture. Repair the data and lifetime contracts rather than replacing the model stack. Separate transport partitioning, semantic generation units, PCM processing, and run-scoped bounded playback. The backend remains the only speed-processing owner; Chrome plays processed audio at 1x.

**Stack:** Python, NumPy/soundfile, MLX model adapters, FastAPI, vanilla JavaScript/Web Audio, pytest and Vitest.

## Baseline and evidence

Reviewed the actual dirty working tree, not only HEAD. Baseline `npm test`: 43 JS tests and 72 backend tests pass. `npm run package:extension` succeeds for 3.4.2. These results do NOT establish auditory quality.

| Severity | Evidence in current source | Consequence |
|---|---|---|
| HIGH | `extension/shared/playback-umd.js:98-106`, `extension/tests/playback.test.js:114-124` | Clock returns times in the past after underflow; existing test explicitly expects that. Several late buffers can start immediately and overlap rather than queue correctly. |
| HIGH | `playback-umd.js:2-4,42-48` | Normalization erases every newline before paragraph splitting, losing structural pacing. First-size option splits the entire first large piece into small pieces, not just the first startup unit. |
| HIGH | `playback-umd.js:61-66`, `offscreen.js:187-190` | An error after audio has begun is swallowed and the status callback says Reading. Missing passages can be marked successfully complete. |
| HIGH | `offscreen.js:262-300` | Any thrown stream error triggers whole-text regeneration, even after speech was heard. This can replay the beginning. |
| HIGH | `offscreen.js:172-197,148-169` | Decode/resume and health awaits use mutable global session/context/controller. Catch-only stale-run guards do not stop old successful asynchronous work from scheduling into a successor. |
| HIGH | `offscreen.js:179-193,148-169` | Every decoded buffer is immediately scheduled and retained; no listening-time or byte high-water bound, including when paused. Long input can accumulate the entire audiobook. |
| HIGH | `backend/open_tts/audio.py:136-165` | Packer overlaps independent adjacent PCM regions and removes samples, including native-speed audio. Equal-power overlap can boost correlated samples. Transport-frame boundaries are not evidence of duplicate model audio. |
| HIGH | `backend/open_tts/coordinator.py:250-259` | Kokoro broadcast-shapes retry replays the entire source even if earlier results were already yielded. |
| HIGH | `backend/open_tts/api.py:193-268` | Async response lacks unconditional disconnect/cancellation cleanup; cancellation at await/yield may leave worker filling its queue and retaining the generation lock. |
| MEDIUM | `offscreen.js:99,110,113,128-131` | Actual controller signal replaces timeout; reader has no idle timeout; EOF on a frame boundary is accepted without required per-index finals/done. |
| MEDIUM | `adapters.py:142-206` | Sentence detector treats abbreviations as boundaries and handles closing quotes weakly; extension and backend independently split. Exact effect on prosody remains to be measured with real audio. |
| MEDIUM | `audio.py:167-187`, `coordinator.py:446-483` | Sample rate changes are silently accepted, flattened PCM shape unchecked, full/stream DSP differ. Current grain-local stretch cannot justify a claim of flawless pacing. |
| MEDIUM | `background.js:162-186,209-234` | Delayed backend readiness can dispatch an obsolete SPEAK; SW memory loss makes status/control forget a still-playing offscreen session. |

## Design decisions / contracts

1. Keep existing public endpoints and little-endian framing. Add validation and backward-compatible metadata, not a protocol replacement. Default generation still Kokoro/af_bella; retain Qwen/Fish and settings.
2. Text is not rewritten to repair inference. Normalize CRLF to LF, remove BOM/zero-width artifacts conservatively, trim outer whitespace, preserve paragraph boundaries. Soft line wraps inside prose may join with spaces, but do not strip blank-line paragraphs, list boundaries, or punctuation. Test prose, quotations, abbreviations, decimals, URLs, Unicode, lists, and a very long unbroken token. Explicitly reject input beyond published limits rather than silently slicing.
3. Extension partitions only for API size/count limits. Backend owns bounded sentence/paragraph-aware generation units. Do not split a sentence solely to achieve tiny first-audio latency unless it exceeds a hard model-safe cap. No added words and no repeated context spoken twice. Use model-specific limits only if grounded in installed adapter behavior, not guesses.
4. Native-speed PCM path is sample-preserving concatenation/packetization: no default overlap, amplitude normalization, trimming, inserted silence, or fades at arbitrary transport boundaries. Genuine sentence pauses from model output must survive. Metadata may distinguish semantic boundaries, but no blind pause padding until listening evidence warrants it.
5. For non-native speed, eliminate arbitrary per-frame stretch resets. Prefer a bounded semantic-unit pitch-preserving transform with one clearly documented algorithm over the existing ad-hoc carry/crossfade. Keep current dependency footprint if tests justify algorithm; otherwise choose an already-available proven local processor and document dependency/failure semantics. Never fall back silently to pitch-shifting interpolation for normal speech. Speed=1 must be exact identity; duration tolerance and pitch tests required.
6. Run object owns identity, AbortController, counters, playback clock, queue, completion validator, state, token and timers. All continuations capture that run and check current ownership before/after async boundaries. Background remains lifecycle/routing; offscreen owns actual playback truth. No audio blobs through Chrome messaging.
7. Bounded playback uses listening-time budget (initial default high-water 20 s / low-water 10 s) plus decoded-byte cap (16 MiB), at most one in-flight decode and bounded scheduled horizon. One oversized decoded frame must either be sliced without copying excessively or rejected before unbounded allocation. Configure a small startup/rebuffer reserve (~250 ms default); do not add lead on every healthy frame. On stall schedule `max(nextStart, now + recoveryLead)` only when underflow actually occurs. Preserve exact adjacency while buffered.
8. Partial stream failures terminate explicitly, never skip a passage or report success. Before any scheduling, a single eligible compatibility fallback may occur. After scheduling begins, no automatic whole-text replay. Stop queued sources on failure and expose an honest retry-required error; do not invent a resumable checkpoint.
9. Final success requires all expected indices finalized in order and a terminal done frame, with no errors, pending decode, or retained sources; terminal success occurs once after playback drains. Missing finals, duplicate/out-of-order indices, truncated EOF, malformed fields, and post-done payload are errors. Preserve documented legacy cases only with explicit tests, not leniency that hides missing content.
10. Cancellation is cooperative at model yield boundaries; cannot preempt a stuck native MLX call. Response cancellation must always set a per-request event, unblock queue offers, close generators safely on their owner thread, and prevent canceled waiters from entering inference after lock acquisition. Never unload a busy model from another thread.
11. Preserve on-demand server policy, existing auth/CORS, per-model preferences, popup history/UI and tab/frame ownership. No new cloud services, broad permissions, frameworks, or always-running processes.

## Implementation sequence (TDD)

For each task: add the failing regression, run the focused test and confirm failure for the intended reason, implement the smallest cohesive fix, then rerun. Do not preserve tests that assert known bad behavior. No commits unless David asks.

### Task 1 — Capture regression fixtures and isolate tests
- Modify `extension/tests/playback.test.js`; create `extension/tests/offscreen.test.js` and `extension/tests/background.test.js`.
- Extend `backend/tests/test_audio.py`, `test_adapters.py`, `test_coordinator.py`, `test_api.py`.
- Build VM-style production-script harness with fake Chrome runtime, controllable promises, fake fetch reader and AudioContext. Load the real offscreen/background scripts, not a rewritten simulation.
- Use production Python coordinator with fake adapters. No model downloads/inference or native-host subprocesses outside existing isolated tests.
- Save current git status/diff context in implementation report; preserve all prior edits.

### Task 2 — Fix text preservation and partitioning
- Modify `extension/shared/playback-umd.js`, `backend/open_tts/adapters.py`; constants only if necessary.
- Add `backend/open_tts/text.py` only if it materially centralizes generation-unit behavior; wire adapters and coordinator to it.
- Regression: `Hello.\n\nNext paragraph.` retains the paragraph; `Dr. Smith paid 3.50. “Really?” she asked.` is not split at Dr. or decimal. Ensure all non-whitespace source characters occur once, in order.
- First-target regression: only startup unit small; remainder repacked at rest target. Long token must not bypass payload cap. API max count/total limits exercised at boundary.
- Commands: `npm run test:extension`; `env -u PYTHONPATH backend/venv/bin/python -m pytest backend/tests/test_adapters.py -q`.

### Task 3 — Correct the audio clock and scheduling horizon
- Modify `extension/shared/playback-umd.js`; create `extension/shared/playback-session-umd.js` if needed and include in `offscreen.html`.
- Clock regression: schedule 0.4 s at t=1 → 1.05; next arrives at t=9 → >=9, not 1.45; following ready frame exactly abuts the recovered end. Assert no overlapping start/end intervals under burst-after-stall.
- Add deterministic queue high/low-water and byte-budget tests with hundreds of frames and pause. Abort must release waits. Completion waits for real onended rather than generation EOF.
- Test AudioContext suspended/resume rejection, pause during initial buffering, resume after EOF while queued audio remains, and stop during decode.

### Task 4 — Wire run-scoped offscreen lifecycle
- Modify `extension/offscreen.js` using tested session abstraction; keep existing message names and settings behavior.
- Check identity around health/fetch/read/decode/resume and before schedule/progress/fallback/done.
- Regressions: A blocked decode then B SPEAK then A resolves; A must never schedule, emit B progress or reset B. Repeat for ensureServer, resume, fallback response and STOP.
- Ensure contexts and source nodes disconnect/release without closing a successor's context. One terminal event per run.
- Wire queue backpressure into actual frame consumption; do not merely add an unused helper.

### Task 5 — Strict stream completion, timeouts and no replay
- Modify `extension/offscreen.js`, `extension/shared/stream-decoder-umd.js`, playback consumer and tests.
- Reader released/canceled in finally. Combine caller cancellation with idle timeout (60 s configurable), not a fixed 10-minute playback-duration limit. Pause/backpressure should not count as server-idle time while intentionally not reading.
- Validate index, final, done, sample-rate and speed metadata. Missing final/done at clean EOF fails. Error after first audio surfaces TTS_ERROR, not Reading or DONE.
- Only compatibility failure before first scheduled audio can invoke single fallback. Auth/validation/cancel errors must not retry. For fallback avoid whole-audiobook in-memory JSON; bounded request windows if retained.
- Test fragmented frames at every byte boundary, malformed/oversized lengths, missing done/final, duplicate finals, error after audio, network close, and done-with-trailing-data.

### Task 6 — Preserve PCM at native speed and qualify non-native DSP
- Modify `backend/open_tts/audio.py`, `coordinator.py`, `test_audio.py`, `test_coordinator.py`.
- Native identity test: concatenate emitted floats from arbitrarily fragmented signal and compare to input exactly before PCM16 encoding; total sample count identical. Test multiple text indices and final short tail.
- Remove blind equal-power crossfade, including at model generation-unit boundaries. Reject nonfinite samples, invalid shape/rate or mid-stream rate changes with typed error. Do not silently flatten stereo channels into alternating mono samples.
- For nonnative speeds test identity at 1, duration at 0.5/1.5/2/3 within documented tolerance, voiced sine pitch stability, impulses, silence, no clipping gain and packetization independence. Label synthetic tests as DSP correctness, not naturalness proof.
- Bound semantic-unit accumulation; backend frame byte cap must align with client decoded budget. Ensure full/batch/stream paths use same speed ownership.

### Task 7 — Backend cancellation, retries and ordered failure
- Modify `backend/open_tts/api.py` and `coordinator.py`.
- Add unconditional response-finally event signaling. Worker queue offer checks cancellation. Avoid waiting indefinitely to enqueue sentinel when disconnected. Generator closure happens on worker owner thread. Check cancellation before/after lock wait and before generation.
- Stop stream at first failed semantic/text unit; no continued later paragraphs masquerading as complete reading.
- Kokoro retry allowed only before any result has escaped. After yielded audio, propagate failure without replay. Test fake adapter yields marker audio then raises broadcast_shapes; marker cannot appear twice.
- Tests: cancel with queue full, disconnect during q.get, cancel pending lock then release predecessor, healthy following request, and noncooperative fake model does not trigger unsafe unload.
- Commands: `env -u PYTHONPATH backend/venv/bin/python -m pytest backend/tests/test_api.py backend/tests/test_coordinator.py -q`.

### Task 8 — Background ownership and extension UX correctness
- Modify `extension/background.js`, relevant protocol helpers, popup/content only where required.
- Single-flight offscreen creation with actual API success validation; no treating every error containing 'offscreen' as success.
- Guard SPEAK dispatch after every readiness await. Test A slow readiness / B fast readiness then A must not replace B.
- On service-worker restart, query existing offscreen without creating it merely for status; recover current run owner for controls. Correct actual active/paused status, safe immutable captures across asynchronous GET_STATUS.
- Preserve client/tab/frame targeting. UI shows Buffering/Paused/Interrupted honestly; no progress percentage from variable frame counts. Existing clean design remains.

### Task 9 — Regression and packaging gates
- Run `npm test` and `npm run package:extension` without masking exits.
- Add script or test for accelerated long-form fake-frame soak: thousands of frames, delayed producer bursts, slow decode, repeated pause/resume/stop/replacement, errors mid-run. Assert maximum scheduled horizon, byte bounds, source cleanup, strict monotonic playback and terminal count. Record fixture-only metrics explicitly.
- Inspect ZIP contents: manifest and required new JS modules included, version consistent across package/config/manifest. Bump patch version once for source changes, update CHANGELOG and README without unmeasured performance claims.
- Produce `docs/reports/long-text-audio-implementation.md`: requirement → production symbol → regression → observed result; commands/counts, remaining limits, all changed/new files.
- Run `git diff --check` and `git status --short`. Do not install extension or restart server.

### Task 10 — Separate authorized auditory/browser release gate
This is specified now but not to be executed without explicit current-phase E2E authorization. Unit success is not 'flawless audio'.
- Read-only health/resource preflight; never interrupt active generation. Use one isolated process/profile and avoid concurrent MLX loads. Synthetic text only.
- Real Chrome extension primary flow: selection → speak → pause/resume → stop → replacement, popup close/reopen, tab/frame switch, worker restart. Inspect console/network and screenshots. Capture actual audio scheduling evidence, not merely DOM presence.
- Generate short, 2k-word and 10k-word fixtures (paragraphs, dialogue, abbreviations, lists and soft linewraps) at 1/1.5/2; add speed extremes for short input. Kokoro first; separate Qwen/Fish runs only within resource budget.
- Record cold/warm state, model/version/voice, first-audio time, generation wall time, audio duration, RTF, peak RSS, underflows, missing/duplicate text markers and boundary timestamps. Do not set impossible realtime guarantees for slower-than-realtime models; controlled rebuffering is preferable to overlaps.
- Deliver representative before/after WAV boundary excerpts and listening checklist: no clipped words, repeated/missing lines, clicks, rushed paragraph transitions, pitch warble or unnatural pause changes. Human listening remains necessary for naturalness. No fabricated listening verdict or benchmark extrapolation.

## Acceptance summary

Build acceptance requires passing deterministic tests through production paths for all HIGH findings, correct packaging, preserved user changes and lifecycle safety. Release acceptance additionally requires authorized real audio/browser evidence and an explicit naturalness review. 'Flawless' is a goal, not a claim that unit tests can establish.
