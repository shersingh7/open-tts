# Changelog

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