# Open TTS Extension — Fix Everything That's Left

**Date:** 2026-04-17
**Author:** Hermes (from last session's review + current codebase audit)
**Status:** Ready for execution

---

## Goal

Fix all remaining bugs, reliability issues, and polish items in the Open TTS Chrome extension + FastAPI backend. The April 16 session fixed the 4 critical issues but was cut off before completing medium/low items and verifying all changes.

---

## What Was Fixed (April 16 Session) ✅

1.  **Port binding race** — `native_host.py` rewritten: port check, stale PID kill, FD leak fix, proper process lifecycle
2.  **Streaming GPU race** — `server.py`: `threading.Lock` replacing `_loading` boolean, streaming routed through `gpu_lock`
3.  **Stream hang** — `background.js`: 30s idle timeout via `readWithTimeout()` on stream reads
4.  **Health check** — `background.js`: timeout increased 500ms→3000ms
5.  **Speed setting** — `content.js`: now passes `settings.speed` instead of hardcoded `1.0`
6.  **playbackRate in streaming** — `content.js`: `scheduleAudioBuffer()` reads `currentPlaybackRate`
7.  **Native host status check** — `background.js`: `autoStartServer()` checks native host availability before start
8.  **Server graceful shutdown** — `server.py`: SIGTERM/SIGINT handlers, `SO_REUSEADDR` implicit via lifespan
9.  **LaunchAgent** — `install_launch_agent.sh`: renamed from `com.qwen-tts.server` → `com.open-tts.server`, `KeepAlive: false`
10. **Streaming interval** — `server.py`: 0.5s (down from 1.0s)

---

## What Remains ❌

### HIGH — Functional Bugs

#### 1. Fish S2 Pro streaming crashes the server
**File:** `server.py` line 384 → `model.generate(**stream_kwargs)` with `stream=True`
**Problem:** `mlx_audio`'s Fish S2 Pro model raises `NotImplementedError("Fish Speech streaming is not implemented yet.")` when called with `stream=True`. The server log shows this crash:
```
NotImplementedError: Fish Speech streaming is not implemented yet.
```
**Fix:** In `_build_gen_kwargs` or the streaming endpoint, check if `model_id == "fish-s2-pro"` and either:
- (a) Force `stream=False` and return the full audio (no streaming for Fish), or
- (b) Return an HTTP 400 error explaining streaming isn't supported for this model, or
- (c) Both: auto-fallback to non-streaming with a warning header.

Recommended: option (c) — detect Fish model, fallback to non-streaming synthesize with a `X-TTS-Fallback: non-streaming` header. This way the extension still works, just without progressive audio.

#### 2. `uninstall_launch_agent.sh` still references old name
**File:** `backend/uninstall_launch_agent.sh` line 4-5
**Problem:** `PLIST_NAME="com.qwen-tts.server"` — doesn't clean up the new `com.open-tts.server` launch agent.
**Fix:** Update to `PLIST_NAME="com.open-tts.server"` and add migration cleanup for the old name (like install script does).

#### 3. `asyncio.get_event_loop()` deprecation in server.py
**File:** `server.py` line 446
**Problem:** Uses `asyncio.get_event_loop()` which is deprecated. Should use `asyncio.get_running_loop()` inside async context.
**Fix:** Replace with `asyncio.get_running_loop()` (we're inside `lifespan()` which is async).

#### 4. `fetchJson()` has no timeout
**File:** `background.js` line 188-196
**Problem:** `fetchJson()` calls `fetch()` without any timeout. If the server hangs, the extension hangs.
**Fix:** Add `signal: AbortSignal.timeout(10000)` (10s) as default option, allow override.

#### 5. `_encode_audio` silently swallows `audio_write` failures
**File:** `server.py` line 170-179
**Problem:** Falls back to WAV via soundfile when `audio_write` fails, but doesn't log the failure. Makes debugging impossible.
**Fix:** Add a `print(f"Warning: audio_write failed for format {fmt}, falling back to WAV: {exc}")` in the except block.

### MEDIUM — Reliability / UX

#### 6. No retry logic on failed TTS requests
**File:** `background.js` `handleTTSRequest` (line 267-310) and `handleTTSStreamRequest` (line 342-448)
**Problem:** A single network hiccup = total failure. User has to manually retry.
**Fix:** Add 1 retry with 1s delay for transient failures (5xx, network timeout). Don't retry 4xx (bad request).

#### 7. `_serverKnownRunning` cache can go stale
**File:** `background.js` line 7-27
**Problem:** If the server crashes mid-session, the 5-minute TTL keeps the cache alive for up to 5 minutes, causing silent failures.
**Fix:** On any fetch failure (especially 5xx or network error), call `markServerUnknown()` immediately. This is partially done in some error paths but not all.

#### 8. `waitForChunk` double-resolution risk still exists
**File:** `content.js` line 264-277
**Problem:** The chaining logic at lines 267-275 wraps an existing promise's resolve/reject, but if the same chunk index gets `markChunkComplete` called twice, the second call finds no pending entry and silently drops. The current code creates a new pending entry that chains to the old one — this is actually correct, but confusing and fragile.
**Fix:** Simplify: if `waitForChunk` is called and there's already a pending entry, just return the same promise (no chaining needed — the first caller already has the pending promise).

#### 9. Missing `model_reload_on_failure` in server
**File:** `server.py`
**Problem:** The April 16 plan included "model reload on failure" but it wasn't implemented. If model inference fails (e.g., OOM, corrupt state), the model stays in a bad state until manual restart.
**Fix:** In `_synthesize_sync` catch block, if generation raises an exception, set `manager.load_error` so the `/health` endpoint reports it and the `load-model` endpoint allows reload. Add a `/v1/reload-model` endpoint or modify `load-model` to force-reload when `load_error` is set.

#### 10. Concurrent popup preview + content script audio
**File:** `popup.js` line 308-358, `content.js`
**Problem:** If the user clicks "Play preview" in popup while content script audio is playing, both play simultaneously. `stopAllTabsTTS()` in popup.js sends `STOP_TTS` messages but content.js doesn't handle `STOP_TTS`.
**Fix:** Add a `chrome.runtime.onMessage` listener in `content.js` that handles `{ type: "STOP_TTS" }` by calling `stopAllAudio()` and incrementing `speakRunId`.

### LOW — Polish / Cleanup

#### 11. Server log leaked semaphore warning
**File:** `server.py` — shown in logs
**Problem:** `resource_tracker: There appear to be 1 leaked semaphore objects to clean up at shutdown`. This is a known Python multiprocessing issue, not our bug, but we can suppress it.
**Fix:** Add `import multiprocessing.resource_tracker; multiprocessing.resource_tracker._resource_tracker._stop()` or just ignore. Not worth fixing.

#### 12. Icon files missing from extension
**File:** `extension/manifest.json` references `icon16.png`, `icon32.png`, `icon48.png`, `icon128.png`, `icon.png`
**Problem:** These icon files may not exist in the extension directory (didn't check, but worth verifying).
**Fix:** Verify icons exist. If missing, generate simple SVG→PNG icons or remove icon refs.

#### 13. `start-server.sh` blocks terminal
**File:** `start-server.sh` line 13
**Problem:** `./venv/bin/python server.py` runs in foreground, no way to background it.
**Fix:** This is intentional for dev use. No fix needed, but could add `&` + PID echo for convenience.

#### 14. No `README.md` update for v2.0 changes
**File:** `README.md`
**Problem:** README likely outdated after the big rewrite. Should document multi-model support, Fish S2 Pro limitations, streaming architecture.
**Fix:** Update README with current features, limitations, and setup instructions.

---

## Implementation Plan

### Phase 1: Fix Functional Bugs (HIGH priority)

| # | Task | File | Change |
|---|------|------|--------|
| 1a | Fish streaming fallback | `server.py` | In `synthesize()` endpoint: if `request.stream` and model is Fish, auto-fallback to non-streaming |
| 1b | Fish streaming: extension handling | `background.js` | Handle `X-TTS-Fallback` header; if server returns non-streamed audio, parse as single chunk |
| 2 | Fix uninstall script | `uninstall_launch_agent.sh` | Update `PLIST_NAME`, add old-name cleanup |
| 3 | Fix get_event_loop | `server.py:446` | `asyncio.get_running_loop()` |
| 4 | Add fetchJson timeout | `background.js:188` | Default `AbortSignal.timeout(10000)` |
| 5 | Log audio_write fallback | `server.py:175` | Add print/warning in except block |

### Phase 2: Reliability Improvements (MEDIUM priority)

| # | Task | File | Change |
|---|------|------|--------|
| 6 | Retry on transient failure | `background.js` | Wrap fetch in retry helper (1 retry, 1s delay, 5xx only) |
| 7 | Invalidate server cache on errors | `background.js` | Call `markServerUnknown()` on any non-2xx or network error |
| 8 | Simplify waitForChunk | `content.js:264-277` | Return same pending promise instead of chaining |
| 9 | Model reload on failure | `server.py` | Set `load_error` on generation failure; allow force-reload via `/v1/load-model` |
| 10 | Handle STOP_TTS in content.js | `content.js` | Add message listener for `STOP_TTS` type |

### Phase 3: Polish (LOW priority)

| # | Task | File | Change |
|---|------|------|--------|
| 11 | Semaphore warning | — | Ignore (Python stdlib issue) |
| 12 | Verify icons | `extension/` | Check icon PNGs exist |
| 13 | README update | `README.md` | Document v2.0 features |

---

## Key Technical Constraints

- **MLX GPU is single-threaded**: Only one `model.generate()` at a time. `gpu_lock` ensures this.
- **Qwen3-TTS `generate()` ignores `speed`**: Speed must be client-side via `playbackRate`.
- **Fish S2 Pro doesn't support streaming**: `mlx_audio` raises `NotImplementedError`.
- **Fish S2 Pro has no preset voices**: Requires `ref_audio` for voice cloning. The popup shows `FISH_VOICE_TAGS` as "voices" (style tags, not actual voices).
- **Chrome MV3 service workers**: No `URL.createObjectURL`, no `FileReader`. Audio must pass as base64 through messaging.
- **RTF ~2.5x on M2 Pro**: Generation is slower than real-time, so streaming is essential for long text.
- **Concurrent model loads crash MLX**: Must serialize with `threading.Lock`.

---

## Verification Steps

After implementing all fixes:

1.  **Fish streaming**: Switch to fish-s2-pro model in popup → select text → click Speak → should get audio (non-streamed) instead of crash
2.  **Fetch timeouts**: Kill server → click Speak → should get a clear timeout error within ~10s, not hang forever
3.  **Cache invalidation**: Play audio → kill server → click Speak → should detect server down immediately (not wait 5 min)
4.  **STOP_TTS**: Play audio in content.js → click preview in popup → content audio should stop
5.  **Model reload**: Induce generation error → check `/health` shows `load_error` → click "reload" → model should reload
6.  **Uninstall script**: Run `uninstall_launch_agent.sh` → verify it removes `com.open-tts.server.plist`

---

## Risks / Open Questions

- **Fish S2 Pro is slow** (3+ min generation on M2 Pro). Even with non-streaming fallback, the user will wait a long time. Worth adding a "this model is slow" warning in the popup?
- **Retry logic**: 1 retry is conservative. Some services use 3 retries with exponential backoff. But since the bottleneck is usually the server being down (not transient), 1 retry with a delay is sufficient.
- **waitForChunk simplification**: The current chaining code works — just ugly. Changing it introduces regression risk. Low priority.