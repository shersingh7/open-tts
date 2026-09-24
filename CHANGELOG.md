# Changelog

## 4.0.0 — 2026-09-24 (source/package candidate)

### Architecture
- The service worker is now the single owner of playback state. Popup, on-page widget, Reader and playback hosts talk to it over long-lived named ports instead of broadcast messages; UIs render idempotent `SESSION` snapshots. The v3 snapshot/revision/dedupe guard code is gone.
- Standard ES modules throughout (`sw/`, `host/`, `ui/`, `shared/`), type-checked with `tsc --checkJs` per file and linted with ESLint; UMD duplicates removed.

### Fixed
- A restored or duplicated Reader tab can no longer synthesize the same reading a second time (only one Reader host is accepted).
- The API token moved from `chrome.storage.local` (readable by content scripts) to extension-page-only `chrome.storage.session`; the old copy is deleted on upgrade.
- Opening the popup no longer loads the saved model (Fish is 6.3 GB); models load on first Speak or an explicit model change.
- Server start and model load progress survive closing and reopening the popup.
- Speed/settings changes are saved even if the popup closes immediately.
- The Reader tab is protected from Memory Saver discards while reading.
- Short Qwen3/Fish previews play offscreen instead of opening a Reader tab; they fail clearly if no audio arrives within 25 s.
- The on-page widget lives in a closed shadow root (page CSS/scripts can't interfere), no longer watches the whole page, stays available as a collapsed control during a reading, offers "Read selection" for a new selection, and shows "Open TTS was updated — reload this page" instead of raw extension-context errors.
- Backend rejects foreign `Host` headers (DNS-rebinding defence); native host resolves `OPEN_TTS_RUNTIME_DIR` like the server so the token path always matches.
- Packaged zip now has `manifest.json` at its root.

### Added
- Right-click "Read with Open TTS" (works in Chrome's PDF viewer), keyboard shortcuts Alt+Shift+R (read selection) and Alt+Shift+P (pause/resume), per-site widget hiding, Reader progress bar and passage counter, "First audio" timing in the popup.

### Changed
- Reading history is **off by default**; when enabled it keeps only the first 2,000 characters of each of the last 20 readings (256 KB cap).
- Tool scratch (`.hermes/plans`, `graphify-out`, `run-graphify.py`, `artifacts/`) is no longer tracked.
- Real-browser behaviour, real-model listening and sleep/wake are separate release gates (manual testing).

## 3.5.0 — 2026-09-21 (source/package candidate)

- Model-aware short opening/later generation units; two-second default packets, capped at four seconds.
- Rolling remaining-audio look-ahead, lazy frame parsing, and byte-bounded transport/decode.
- Single model-owner thread with bounded admission, disconnect cancellation, retained leases for noncooperative native work, and output/body limits.
- Negotiated stream v2 with sequences, source coverage, unit progress, sample counts and explicit terminal outcomes; v1 API compatibility retained.
- Shared Reader/offscreen engine; visible Reader for long selections and slower models, worker recovery, owner-loss errors and explicit passage retry.
- Snapshot current popup controls for Speak; keep instructions local with verified migration, surface storage failures, and save only completed history without requiring an open popup.
- Detect reported token exhaustion rather than treating it as completion.
- Verify isolated process groups before group signals, check child exit with poll(), and retain PID records until confirmed stop. LaunchAgent defaults to on-demand.
- Isolated offline tests, measured generation/processed-audio RTF, incremental opt-in qualification runners and updated privacy/API documentation.
- Real models, audible Chrome behavior, long pauses/sleep-wake and natural speech boundaries remain separately authorized release gates. No runtime installation is performed by this build.

## 3.4.3 — Unreleased

### Fixed
- Rebase playback after a stall without overlapping late buffers; preserve adjacency when buffered.
- Run-scoped offscreen state and contexts prevent stale decode/startup/resume from affecting a replacement run.
- Strict final/done validation, idle deadlines and terminal errors replace silent skipped passages and whole-text replay.
- Native PCM packetization preserves every sample; remove destructive crossfades at arbitrary transport boundaries.
- Preserve paragraph/list structure, abbreviations and Unicode; reject oversized selections instead of truncating.
- Cancel response workers on disconnect and prevent cancelled waiters from entering inference.
- Recover playback ownership after service-worker restart and make duplicate SPEAK delivery idempotent.
- Prevent delayed popup state restoration from overwriting a new or stopped run.
- Prevent background recovery from resurrecting a completed session, and use the actual pause state reported by offscreen playback.
- Reject non-ASCII authentication tokens instead of raising a server error.
- Release the session and report an error when an audio-device pause/resume operation fails.
- Send bounded inference keepalives so slow semantic generation does not falsely hit the shorter network-idle deadline; keepalives never extend the inference deadline.

### Changed
- Bound scheduled audio (20 seconds plus startup lead), decoded PCM (16 MiB) and individual wire frames (8 MiB).
- Process non-native speed once per bounded semantic unit, independently of model frame size.
- Full responses use semantic units too, with explicit PCM accumulation limits.
- Added production-script offline extension/race/soak tests and backend DSP/cancellation regressions. Real-model listening and Chrome lifecycle verification remain separate release gates.

## 3.4.2 — 2026-08-24

### Fixed
- Popup stuck on "Warming up model..." when reopened while TTS is generating
- `POST /v1/load-model` returns immediately for the same model during generation without waiting on the lock
- Popup re-open restores active playback session state (`clientId`/`runId`) so Pause and Stop controls work on in-flight audio
- Health snapshots report `model_warm: true` during active generation

### Changed
- Version 3.4.2

## 3.4.1 — 2026-08-22

### Fixed
- 3x (and other high speeds) paused between phrases: pack size now scales so each frame is ~1.2s of playback
- Time-stretch output length is `N/speed` (2.5x/3x track the slider)
- Phrase joins carry 1x overlap and mix at the end of the held tail

### Changed
- Version 3.4.1

## 3.4.0 — 2026-08-20

### Added
- Signal Chassis popup (warm bone, near-black LCD, signal orange) matching Volume Booster Pro
- Sentence-safe generate units and ~1.2s phrase packing so pace/timbre stay stable

### Fixed
- Pause immediately resumed itself: the next stream buffer called `AudioContext.resume()`
- Crossfade leftover tail mixed against the start of the held phrase (join click)
- Mid-sentence 1x crumbs and join holes on long utterances

### Changed
- Version source of truth: 3.4.0 across manifest, server, UI

## 3.3.0 — 2026-08-18

### Added
- Incremental streaming on `/v1/synthesize` (`stream: true`) and smaller first-slice generation
- Pitch-preserving time-stretch for Qwen/Fish speed (no more cartoonish 1.5x/2x)
- Per-model voice resolution so a leftover Kokoro voice cannot break Qwen

### Fixed
- First playable frame is emitted before the rest of the utterance finishes
- Stream no longer waits 60s after the last frame before sending `done`
- Offscreen Speak race (`Receiving end does not exist`) retried
- Model switch aborted after 30s; load now waits up to 5 minutes
- Short mid-stream grains no longer play at 1x when speed is 2x
- Speak widget no longer shows chunk counters (`10/15`)

### Changed
- Version source of truth: 3.3.0 across manifest, server, UI

## 3.2.0 — 2026-07-14

### Added
- Backend package split: coordinator state machine, protocol validation, security middleware
- Per-install API token + rate limiting + tight CORS
- Shared extension protocol modules with regression tests (Vitest)
- Pytest suite with fake MLX adapters
- Popup UI refresh: connection card, playback controls, error banner, model-specific Fish/Qwen controls
- Optional on-demand model downloads in `setup.sh`
- LICENSE, PRIVACY.md, CI workflow, reproducible extension packaging

### Fixed
- Popup response envelope parsing (`success` boolean vs nested `.success.data`)
- Warmup and generation serialized through coordinator (no background warmup outside lock)
- Offscreen stream fallback now runs after real failures
- Playback `runId` / `clientId` stale event suppression
- All synthesis moved out of service worker into offscreen document
- Native host refuses to kill foreign port-8000 owners; verifies Open TTS health identity
- Streaming worker bounded queue, absolute timeout, disconnect cancellation
- No silent WAV fallback when another audio format was requested
- Removed semantic text mutation retries (`Continue.` etc.); Kokoro uses chunk splitting
- Consolidated native host installer with required `--extension-id`
- `launchctl bootstrap/bootout` launch agent install
- Pinned `setuptools<82` for torch compatibility

### Changed
- Version source of truth: 3.2.0 across manifest, server, UI
- Default setup downloads Kokoro only; Qwen/Fish are optional flags