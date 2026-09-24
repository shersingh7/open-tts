# NOTES — stream B (playback hosts)

Branch `v4-b`. `npm test` (lint → typecheck → vitest → pytest) exits 0 at every commit.
Final counts: **vitest 23 files / 308 tests** (baseline 19 / 211; +97 host tests), **pytest 134 passed**.
Host tests: `host-engine` 51, `host-port` 11, `host-reader-view` 20, `host-reader` 15.
`eslint --max-warnings=0 extension/host extension/tests/host-*` is clean, `tsc` is clean (every `host/*.js` is
`// @ts-check`), and no line in my files is over 120 columns.

## Commits

| Commit | Task |
|---|---|
| `4eb3a9f` | v4(B): host/engine.js playback engine + ported pipeline tests |
| `38c2f7c` | v4(B): host/host-port.js (HELLO, accept/reject, backoff reconnect) |
| `d86e350` | v4(B): offscreen + Reader hosts (reader-view, keep-alive, UI port) |
| (this)    | v4(B): NOTES-B |

## What was done

- **`host/engine.js`**: `createEngine({ emit, hostKind, fetchImpl, audioContextFactory, now, setTimeout,
  clearTimeout, heartbeatMs, serverUrl, onTerminal })` returns `{ speak, pause, resume, stop, activeRun }`.
  - A faithful port of the v3 `offscreen.js` pipeline: `wavInfo`, `streamBatch` with v2 protocol-header and
    `StreamCursor` checks, a run-scoped AudioContext and abort, bounded buffering through `createPlaybackRun`,
    pause/resume where the latest control wins, a device failure ending the run, and one terminal per run.
  - All v3 metric names are kept: `acceptedAt`, `firstPacketAt`, `modelReadySeconds`, `firstModelPCMSeconds`,
    `firstScheduledAt`, `firstAudioClockStartedAt`, `underflows`, `underflowSeconds`, `peakDecodedBytes`,
    `peakBufferedSeconds`, `peakEncodedBytes`, `generationSeconds`, `processedAudioSeconds`, `normalizedRTF`,
    `serverQueuePeakBytes`, `queueWaitSeconds`, `generationFinishedAt`, `terminalAt` and `terminalOutcome`.
  - Emits the contract messages `STATUS`, `PROGRESS`, `DONE`, `ERROR` and `HEARTBEAT`. `DONE` contains exactly
    `{type, runId, outcome, metrics}`.
  - New: `firstAudioDeadlineMs`. If no audio has been scheduled by the deadline, the run ends with `ERROR` code
    `slow_start` and the contract message, and the fetch is aborted.
  - New: a `HEARTBEAT{runId}` every `HEARTBEAT_MS` while a run exists, including while paused. It stops at the
    terminal.
  - New: `stop(runId, outcome)` emits `DONE` with that outcome.
  - Also exported: `wavInfo`, `partitionText` (the transport partitions that PROGRESS `index` refers to) and
    `SLOW_START_MESSAGE`.
- **`host/host-port.js`**: `connectHost({ kind, engine, onReject, onAccept, connect, setTimeout, clearTimeout })`.
  - Connects `host:<kind>` and sends `HOST_HELLO{kind, activeRun}` on every (re)connect.
  - Reconnects with backoff 100 → 200 → … → 2000 ms, reset when the SW next sends a message.
  - Dispatches `HOST_SPEAK`/`PAUSE`/`RESUME`/`STOP`. `forward(msg)` sends engine events.
  - Returns `{ forward, close, accepted, rejected, connected }`.
- **`host/offscreen.html` + `offscreen.js`**: a module script. `startOffscreenHost()` wires the engine to the
  `offscreen` host port. It runs automatically only in a real extension page.
- **`host/reader.html` / `reader.js` / `reader.css` / `reader-view.js` / `keep-alive.js`**:
  - The Reader is both the `reader` host and a `ui:reader` UI. It renders only from `SESSION` snapshots, plus what
    it knows locally about the run it hosts (full text and settings from `HOST_SPEAK`, and the retry text).
  - UI text and look are ported from v3. Added:
    - a progress bar and a "Passage i of n" counter (paragraphs, computed from PROGRESS `index`/`end` over the
      engine's own partitions);
    - Pause/Resume and Stop, enabled only when `controllable`;
    - "Retry from interrupted passage", which sends `SPEAK{runId: makeRunId(), text: retryText, settings}` on
      `ui:reader`;
    - metrics details, the `HISTORY_ERROR` text from v3, and failed `REPLY` errors.
  - `HOST_REJECT` → "Reader already open in another tab". The page becomes inert: any active engine run is
    stopped, the host port is closed with no reconnect, `ui:reader` is closed and every control is disabled.
  - CSP: no inline scripts, styles or handlers (a static test checks this). The CSS covers
    `prefers-reduced-motion` and `:focus-visible`.
  - While the Reader hosts a run (including paused or buffering), it holds a Web Lock (`open-tts-reader-playback`)
    so Chrome doesn't freeze the background tab. This is best effort and does nothing if `navigator.locks` is
    missing. The SW's `autoDiscardable:false` is still the main guard.
- **Tests**:
  - `tests/host-harness.js` is a new self-contained harness with a fake AudioContext and v1/v2 frame builders.
    The old `pipeline-harness.js` is untouched.
  - Every pipeline test in v3 `offscreen.test.js` and `progressive.test.js` is ported to `engine.js`, with
    messages renamed (`TTS_DONE`→`DONE`, `TTS_ERROR`→`ERROR`, `TTS_PROGRESS`→`PROGRESS`, `SEND STOP`→`stop()`,
    `GET_STATUS.active`→`activeRun()`).
  - New tests cover:
    - the `slow_start` deadline (fires, doesn't fire once audio is scheduled, and a null deadline never fires);
    - heartbeat cadence with fake timers;
    - reconnect backoff and HELLO with `activeRun`;
    - a rejected host keeping the engine idle, including a `HOST_SPEAK` that races the reject;
    - exactly one terminal per run under stop/replace/error races;
    - Reader rendering from SESSION snapshots through the pure `reader-view.js`, since jsdom isn't installed;
    - Reader and offscreen wiring over fake chrome;
    - static CSP and a11y checks.

## Deviations / interpretations (please review)

1. **STATUS state mapping**: "Preparing..." → `preparing`; "Generating..." (request in flight, no audio yet) and
   "Buffering..." (underflow) → `buffering`; "Reading..." → `playing`; "Paused" → `paused`. v3's playback-state
   snapshot also called the pre-audio phase `buffering`.
2. **Extra engine API surface** (a superset of the contract):
   - `pause`/`resume` return `Promise<{ok, paused?|ignored?|error?}>`;
   - `stop` returns a boolean (false if `runId` isn't the active run, and then **no DONE is emitted**);
   - optional `onTerminal(info)` is a local-only hook the Reader uses to get `retryText`;
   - optional `heartbeatMs` and `serverUrl`.
3. **`retryText`**, kept as in v3:
   - It is computed only on the Reader host.
   - It is sent to the SW only on `ERROR`, the only terminal where the contract has the field.
   - `DONE` never carries it.
   - The Reader also offers Retry after a user **Stop**, using the local `onTerminal` retry text, because v3
     offered retry for any interrupted Reader run.
   - It is not offered after `superseded`, `completed` or `owner_lost`, or for a run hosted elsewhere.
4. **`protocolVersion`**: HOST_SPEAK is always v2 in v4. If the field is missing, the engine falls back to v1, as
   v3 did with `settings.protocolVersion || 1`, so the legacy v1 tests still apply.
5. **Events while disconnected**: while the host port is reconnecting, `forward()` queues events (heartbeats
   dropped, at most 100; the oldest non-terminal is dropped first). They are flushed **after** the next
   `HOST_HELLO`. See note A1 below.
6. **Duplicate `HOST_SPEAK`** for the active runId is ignored (v3 idempotency). A `HOST_SPEAK` for a different
   runId while one is active supersedes it locally (`DONE superseded`), even though the SW is expected to send
   `HOST_STOP` first.
7. `pagehide` is not used anywhere (per the contract).

## For Hermes to apply elsewhere

- **A (sw/router.js)**:
  - **A1.** If the host port drops and reconnects while a run *finishes*, the host sends `HOST_HELLO{activeRun:
    null}` and then the queued `DONE`/`ERROR` for that runId. Please let the router accept a terminal for the
    current runId from the same host kind right after such a HELLO (for example, apply rule 5's 2 s grace, or
    process queued terminals before declaring `owner_lost`). Otherwise a completed run could be recorded as
    `owner_lost` and its history write skipped.
  - URLs: the offscreen document is `host/offscreen.html` (reason `AUDIO_PLAYBACK`) and the Reader tab is
    `host/reader.html`.
  - `HOST_REJECT.reason`: the Reader shows "Reader already open in another tab" either way. Any other reason
    string is shown as detail.
  - The Reader shows `session.progress.bufferedSeconds` if the SW copies it from PROGRESS/STATUS (optional). It
    uses `progress.index`/`progress.end` for the passage counter and percentage, so please copy those from
    `PROGRESS` into `session.progress`.
  - The SW should keep the host's `STATUS.label` as `session.label`, which the Reader and popup display.
  - A `HOST_STOP` for a runId the host no longer has produces no DONE. The SW should finish the run itself (it
    already de-duplicates through `session-store.end()`).
- **Integration cleanup**: once v3 is deleted, `tests/offscreen.test.js`, `tests/progressive.test.js` and
  `tests/pipeline-harness.js` can go, because everything is ported to `host-engine.test.js` and
  `host-harness.js`. The only exceptions are the two `storage-umd.js` instruction-migration tests in
  `progressive.test.js`, which P0 already ported to `shared-storage.test.js`. Remove the old root
  `offscreen.html`/`offscreen.js`/`reader.*` with v3.
- **Ownership note**: `extension/tests/host-harness.js` is a helper, not a `host-*.test.js` file. It was created
  because the task explicitly asked for it. Move it under `tests/helpers/` at integration if you prefer.
- **Manifest (A)**: nothing extra is needed for the hosts. CSP `style-src 'self'` and `script-src 'self'` are
  compatible because all styles and scripts are external files.
