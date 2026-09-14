# Long-text audio implementation and verification report

## Verdict

**Source/package candidate 3.4.3 is implemented and passes the offline correctness gates. It is not yet a listening-qualified or installed release.**

The original Grok process exited with code -15 (`termination_source: agent_close`), leaving a substantial implementation but no handoff report. Hermes inspected the surviving changes, exercised the suites, reproduced additional failures, and completed the remaining fixes natively at David's request. No new coding delegate was spawned.

Existing uncommitted edits were retained and included in the reviewed change set. David subsequently authorized a local commit after a further review; this report accompanies that commit. Nothing was pushed, installed or reloaded. No production server, native-host installation, LaunchAgent, live Chrome profile or real MLX model was started/stopped/changed by this verification phase.

## Architecture delivered

- Content/popup remain UI and control layers; background owns routing and on-demand lifecycle.
- Offscreen owns one run-scoped controller, AudioContext, source set, counters, timers and strict stream cursor.
- Scheduling is adjacent while buffered and rebases after starvation, never schedules a new burst into the past.
- Application buffering is bounded by listening time and decoded bytes. One decode in flight, memory reservation before decode, cleanup when nodes finish/stop.
- Text normalization retains paragraphs/list structure and avoids silent selection truncation. Transport partitions are large; backend chooses bounded semantic generation units.
- Native-speed PCM is concatenated without destructive transport-boundary crossfades. Non-native speed is processed once per semantic unit rather than per model packet. All browser audio plays at 1x.
- Errors terminate explicitly. No silent missing passages and no automatic whole-text fallback/replay.
- Response cancellation reaches worker queue offers and model-yield checks. Generation remains cooperatively cancellable, not forcibly preemptible inside native MLX calls.

## Requirement → production path → evidence

| Requirement | Production path | Regression evidence / outcome |
|---|---|---|
| No overlap after underflow | `createPlaybackClock` → `createPlaybackRun.scheduleBuffer` → offscreen `runSpeak` | Playback clock and production offscreen starvation/burst tests pass. Late buffers start at or after current time; following buffers abut. |
| Preserve structured text | `playback-umd.js.normalizeText/splitText`; Python `text.py` through protocol/adapters | Paragraph/list/abbreviation/Unicode and long-token tests pass; oversized content is rejected rather than silently truncated. |
| No stale-run audio | `offscreen.js.current`, run-owned context/controller; background SPEAK guards | Deferred decode, response, resume, duplicate delivery and replacement tests pass. |
| Bounded long playback | `playback-session-umd.js.waitForBudget/decode/scheduleBuffer` wired into real offscreen script | 2,000-frame fake-audio soak passes, including pause, budget enforcement, stop and cleanup. |
| Honest stream completion | `StreamCursor`, `FrameDecoder`, offscreen `streamBatch/finish` | Missing final/done, duplicate/out-of-order control frames, malformed/truncated stream and late error tests pass; success only after source drain. |
| No whole-text replay | Offscreen has no automatic full-batch fallback; coordinator checks whether audio was already yielded before Kokoro retry | Post-audio failures issue terminal error without a new request; broadcast-shapes failure after first yield does not retry/repeat content. |
| Native PCM sample conservation | `audio.py.PhraseStreamPacker` through coordinator streaming | Arbitrary fragmentation preserves exact sample arrays/count before PCM16 encoding. |
| Consistent non-native processing | Semantic-unit packer + `time_stretch`; full and streaming coordinator paths | Packetization-independent output at 0.5/1/1.5/2/3; exact identity at 1, output length and synthetic tone pitch/amplitude checks pass. Not a natural-speech listening verdict. |
| Explicit invalid PCM | `as_mono_pcm`, packer rate checks, coordinator typed error frames | Nonfinite samples, unsupported multichannel shapes and sample-rate change tests pass. |
| Disconnect releases worker | API response `finally`, cancellation event, bounded queue offers, owner-thread generator close | API cancellation/queue cleanup tests pass; cancelled lock waiter never enters inference. |
| No missing semantic unit | Coordinator `unit_had_audio` and terminal failure | Fake Kokoro/Qwen/Fish empty-unit regression stops before the later passage, without success final. |
| Worker restart ownership | Background `recoverSession` and status/control routing | Production background script recovery/startup/stop tests pass. |
| Device failure cannot leave stuck playback | Offscreen pause/resume rejection calls `finish(run,error)` only for current owner | Hermes added PAUSE and RESUME rejection regressions, observed both fail before fix, both pass after. |
| Slow generation ≠ dead network | API bounded keepalive frames, client cursor accepts liveness only | Hermes slow semantic-unit test failed before fix; passes with keepalive. Separate test proves keepalive does not extend the inference deadline. |
| Popup restoration cannot revive old state | Popup `playbackRevision` around startup, stop and async restoration | Hermes added new-run and stopped-startup regressions; observed both fail before fix and pass after. |

## Final commands and observed output

### `npm test`

- Vitest: **10 files passed, 85 tests passed**.
- Pytest: **95 passed**.
- No remaining failing assertions in the final full run.
- Python invoked through `env -u PYTHONPATH backend/venv/bin/python`, preventing Hermes environment shadowing.

### Fixture soak (not real audio performance)

Output emitted by the test harness:

```json
{"frames":2000,"simulatedAudioSeconds":2000,"peakScheduledSeconds":20.25,"peakDecodedBytes":1920512,"terminalEvents":1}
```

The assertions additionally check all 2,000 frames finish, intervals never overlap, source buffers become null, sources disconnect, and paused buffering does not grow indefinitely. The numbers describe a fake-clock/fake-PCM production-script test, NOT real-model RTF, wall time, total process RSS or perceived pacing.

### Package and diff checks

- `npm run package:extension`: succeeded.
- `git diff --check`: passed.
- ZIP CRC validation: passed.
- All **24 archive entries** byte-match current source files.
- Manifest and package versions match **3.4.3**.
- `offscreen.html` includes the new `shared/playback-session-umd.js` module.
- Package: `dist/open-tts-extension-v3.4.3.zip`.
- SHA-256: `40d6f4919944f1489929cda64f2b5551031a64a8924ad2e150bc9747bf3847ba`.

The first archive-inspection command assumed the manifest lived at the ZIP root and failed. The archive actually contains an `extension/` directory. The corrected check used that observed structure and verified all entries; no packaging defect was found.

## Additional pre-commit review

The full pending diff and new files were reviewed again, including preserved pre-existing changes, protocol/lifecycle integration, authentication behavior, and packaging. Three additional issues were reproduced with failing tests before repair:

- Background `recoverSession()` could apply a stale active snapshot after `TTS_DONE`. A session revision now invalidates recovery snapshots on start, stop and terminal events. Regression: `late recovery cannot resurrect a run after its terminal event`.
- Popup pause/resume UI used the requested state even when the offscreen response reported the opposite actual state. It now applies the authoritative response. Regression: `popup applies authoritative pause state rather than the requested state`.
- `validate_token()` passed non-ASCII strings to `secrets.compare_digest`, raising `TypeError` rather than rejecting malformed authentication. Explicit ASCII validation now rejects these values. Regression: `test_validate_token_rejects_non_ascii_without_exception`.

All three regressions failed before their respective fixes, then passed in the final full suite. No remaining blocking issue was identified in the reviewed changes under offline verification. The real-audio/browser limitations below remain explicitly unqualified.

## Remaining limits and release gate

1. **Real Chrome and real speech have not been exercised in this phase.** The original plan intentionally separated those disruptive checks from source repair. The installed extension/server have not been promoted to this version. A source/package pass is not proof the installed runtime is using these changes.
2. **Naturalness remains unqualified.** Test real paragraph transitions, dialogue, abbreviations and 2k/10k-word fixtures with boundary excerpts before describing the result as flawless. Synthetic tone/PCM assertions cannot establish intelligibility, natural pauses or freedom from model-generated word omissions.
3. Non-native processing waits for a semantic unit. This deliberately avoids packet-local DSP resets but may increase first-audio latency, particularly for Qwen/Fish. No invented speedup or latency guarantee is claimed.
4. Network liveness uses empty keepalive frames every 15 seconds. They cannot mark text complete or reset inference inactivity. Effective server generated-frame inactivity budget is `max(OPEN_TTS_GEN_TIMEOUT, OPEN_TTS_STREAM_FRAME_TIMEOUT)`; paused consumer backpressure is excluded. A nonreturning MLX call cannot be safely killed by the HTTP timeout.
5. Buffer limits are application-owned PCM/scheduling bounds, not limits on all MLX allocations, socket buffering or process RSS.
6. The unsafe automatic whole-document fallback was removed entirely instead of retaining a compatibility retry. Explicit user retry starts a fresh run. Backend and extension should be upgraded together when idle.
7. No new dependency, cloud TTS service, extension permission or always-running process was introduced for these repairs.

See `docs/plans/long-text-audio-reliability.md`, Task 10, for the authorization-gated real-audio/browser acceptance checklist.
