# Changelog

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