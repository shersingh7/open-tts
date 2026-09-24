# NOTES — stream A (service worker)

Branch `v4-a`, based on `fae24bb`. `npm test` (lint → typecheck → vitest → pytest) exits 0 at every commit.
The v3 files are untouched. `eslint --max-warnings=0` is clean on `extension/sw` and `extension/tests/sw-*`.

**Test counts:** vitest went from 19 files / 211 tests to **29 files / 356 tests**. The 145 new tests are in 10 `sw-*`
files. pytest: **134 passed**.

## Commits

| Commit | Task |
|---|---|
| `b48efaf` | v4(A): session store |
| `24a5190` | v4(A): session-only auth token + native host helper |
| `91e536c` | v4(A): speak settings resolver + bounded history |
| `289532f` | v4(A): server manager (single-flight ensureServer, model load polling, 401 refresh) |
| `5f08cc9` | v4(A): host manager (chooseHostKind, offscreen, singleton pinned Reader) |
| `57842c6` | v4(A): router (ownership rules, SPEAK flow, owner-loss grace, restart reconcile) |
| `bf778a4` | v4(A): context menu + keyboard commands with badge hint |
| `ba0d554` | v4(A): service-worker composition root |
| `7b61c75` | v4(A): manifest points at v4 SW/popup/content, adds menus + commands |
| `5feef4c` | v4(A): NOTES-A |
| (this)    | v4(A): apply stream B host notes (queued terminal after HELLO, bufferedSeconds) |

## What was built (`extension/sw/`)

| File | Contents |
|---|---|
| `session-store.js` | `createSessionStore({storage})` → `load/current/begin/update/end/runInfo/whenPersisted`. Persists `{session, runInfo}` under `storage.session.v4Session`. Writes are coalesced and serialized. Revision only ever increases, including across restarts. `end()` returns true only once per run. `runInfo` is private (history text capped at 2,000 chars, chars, voice, model, speed) and is never sent to UIs. |
| `auth.js` | `createAuth({chrome})` → `init()` (`setAccessLevel TRUSTED_CONTEXTS` + `local.remove("installToken")`), `getToken()` (from session storage, native `status` on a miss), `refreshToken()` (single-flight), `storeToken`, `authHeaders({json})`. |
| `native.js` | `sendNativeCommand(chrome, command)` (30 s timeout, rejects on `lastError`). This file is extra: auth and the server manager both need it. |
| `settings.js` | `createSettingsResolver().resolve(settings?)`. Follows v3 `content.js`: sync `model/voice/speed/language/voicePrefs/fishStyle`, `resolveVoice`, `resolveSpeed`, `localInstruction()` (P0's migration helper). UI-provided settings are normalised. |
| `history.js` | `createHistory({onError}).persistCompletion(...)`. Writes only if `historyEnabled === true`. Stores the first 2,000 chars, drops entries while there are more than 20 or the list exceeds 256 KB. Writes are serialized. On failure it calls `onError(runId, message)`, which becomes `HISTORY_ERROR`. |
| `server-manager.js` | `fetchHealth` (v3 identity check; no token sent to `/health`), `checkHealth`, `ensureServer({waitForWarm})` (single-flight, native `start`, polls every 1 s for up to 60 s), `stopServer`, `apiFetch` (auth plus one refresh on 401), `getModels`, `checkCapabilities` (requires protocol v2, as in v3), `loadModel` (10 s POST; on timeout polls `/health` every 1 s for up to 300 s; a newer load supersedes). Publishes `SERVER_STATE` / `MODEL_STATE`. Timeouts use `setTimeout` + `AbortController` so they work with fake timers. |
| `host-manager.js` | `chooseHostKind` (exact contract code), `firstAudioDeadlineMs`, `createHostRegistry()` (accepted port per kind + `waitFor(kind, timeout)`), `createHostManager()` → `ensureOffscreen` (single-flight, `AUDIO_PLAYBACK`, url `host/offscreen.html`), `ensureReader` (reuses an existing Reader via `runtime.getContexts`, otherwise `tabs.create` active; then `autoDiscardable:false`), `ensureHost(kind)` (page + wait for its `HOST_HELLO`, 15 s), `releaseReader` (`autoDiscardable:true`), `pinReader`. |
| `router.js` | Port registry, all six ownership rules, the SPEAK flow, command routing, `REPLY`, and `SESSION` fan-out with per-port `controllable` on every change. See below. |
| `menus.js` | Context menu `open-tts-read` created in `onInstalled`. Menu click → run with source `menu`, bound to `tab.id` / `info.frameId`. Command `read-selection` → `tabs.sendMessage(CONTENT_GET_SELECTION)` → run with source `command`, bound to the tab and frame 0. If that fails or the text is empty, the tab gets badge `?` and the title hint, reset after 4 s. `toggle-pause` → `router.togglePause()`. |
| `main.js` | `startServiceWorker(chrome, {fetchImpl})`. Every listener is registered synchronously when the module evaluates: `runtime.onConnect`, `onInstalled`, `contextMenus.onClicked`, `commands.onCommand`, `tabs.onRemoved`. It then calls `auth.init()`. The router waits for `store.load()` before handling anything. It auto-starts only when `globalThis.chrome.runtime.onConnect` exists. |

### Router behaviour

- **Rule 1:** a new SPEAK sends `HOST_STOP{outcome:"superseded"}` to the old run's host (if connected) and publishes
  the old run as idle/`superseded` before the new run begins. Its `HOST_SPEAK` can only come later. Tested across hosts
  (Reader → offscreen) and on the same host.
- **Rules 2/3:** `ui:popup` and `ui:reader` can always control the run. `ui:content` can control it only when both the
  tab id and frame id match (`sender.frameId ?? 0`). Other callers get `REPLY{ok:false, code:"not_owner"}`.
- **Rule 4:** the first `host:reader` HELLO is accepted. Any later one gets
  `HOST_REJECT{reason:"Reader already open in another tab"}`, and everything it sends afterwards is ignored.
- **Rule 5:** when the owning host disconnects, a 2 s grace starts. A `HOST_HELLO` from the same kind with
  `activeRun.runId === runId` adopts the run again (state is taken from `activeRun.paused/state`). A HELLO with
  `activeRun:null` does **not** end the run straight away (stream B's A1): the host may flush a queued `DONE`/`ERROR`
  for that run right after the HELLO, and that terminal is applied normally (history included). If no terminal
  arrives, `owner_lost` fires once when the grace runs out, with message "Playback page closed or was discarded.
  Start a new reading." and code `owner_lost`.
- **Rule 6:** `STATUS`, `PROGRESS`, `DONE` and `ERROR` are applied only if they come from the accepted port of the run's
  host kind and match the current active runId. `store.end()` de-duplicates terminals.
- **SW restart:** the new router loads the store. If a run is active, a **5 s** restart grace starts. A HELLO with the
  same run adopts it (a Reader tab is pinned again). A HELLO with a run the store has ended gets `HOST_STOP`
  (`stopped` if nothing is active, `superseded` if another run is). History still works after a restart because
  `runInfo` is persisted.
- **Orphans:** a `HEARTBEAT` for a runId that isn't current gets `HOST_STOP{outcome:"stopped"}`.
- **SPEAK:**
  1. Validate: non-empty after trim (`empty_text`), at most `MAX_CHARS` (`text_too_long`), runId not current
     (`duplicate_run`).
  2. Resolve settings, then choose the host.
  3. Supersede the current run and `begin` (preparing), then `REPLY{ok, data:{runId, hostKind}}`.
  4. In the background: `ensureServer` → `checkCapabilities` → `getToken` → `ensureHost` → `HOST_SPEAK`. It checks
     after every await that the run is still current.
  5. Any failure before `HOST_SPEAK` is sent ends the run as `failed` with `{message, code}`.
- **Controls:** STOP sends `HOST_STOP{stopped}`, ends the run immediately, and works while the run is still preparing
  (the launch is then aborted). PAUSE/RESUME are forwarded only after `HOST_SPEAK` was sent (otherwise
  `not_ready`). State isn't changed optimistically; the host's `STATUS` drives it.
- **Port senders are validated:**
  - host ports must come from exactly `host/offscreen.html` / `host/reader.html` (query/hash ignored);
  - `ui:popup` / `ui:reader` must come from any extension page;
  - `ui:content` must have `sender.tab.id`.
  Any other port is disconnected.
- **On UI connect** the router sends `SESSION` + `SERVER_STATE` (+ `MODEL_STATE` if known). For popup/reader ports it
  also runs a non-starting `checkHealth()`, unless a start is already in flight.
- **REPLY `code` values:**
  - SPEAK validation: `empty_text`, `text_too_long`, `duplicate_run`;
  - PAUSE/RESUME/STOP: `no_active_run`, `stale_run`, `not_owner`, `not_ready`;
  - other commands: `bad_request` (LOAD_MODEL without a `modelId`), `unknown_type`, plus any backend code.

  Codes that can appear in `session.error.code`: `server_unavailable`, `protocol_unsupported`, `host_unavailable`,
  `owner_lost`, and the host's own codes (for example `slow_start`).

## Deviations from the contract (please review)

1. **`manifest.json` version stays `3.5.0`.** Everything else matches the contract exactly: `sw/main.js` module,
   `ui/popup.html`, `content/content.js` with `run_at`, the menus/commands, and `contextMenus`. With 4.0.0, P0's
   `version-sync.test.js` fails on the v3 headers (`background.js`, `content.js`, `popup.js`, `content.css` all say
   `v3.5.0`), and stream A may not edit or delete those files. `tests/sw-manifest.test.js` checks the contract shape
   apart from `version`/`description`. The existing `description` line is kept; the contract snippet leaves it out.
2. **The run begins before `ensureServer`, not after.** The UI shows "Generating..." straight away, STOP and
   supersede work while the server is starting, and old audio stops as soon as the user asks for new text (as in v3).
   Failures still end the run as `failed`.
3. **The SPEAK REPLY is sent once the run has begun** (`data:{runId, hostKind}`), not when the host accepts it. Later
   failures arrive through `SESSION` (`outcome:"failed"`, `error`).
4. **The restart grace is 5 s.** The contract only gives the 2 s disconnect grace, and hosts reconnect with backoff
   of up to 2 s.
5. **An empty token doesn't fail the run early.** `HOST_SPEAK` goes out with `authToken:""` and the backend's 401
   surfaces through the host `ERROR`. This is so the E2E fake backend works in Chrome for Testing, which has no native
   host.
6. **`persistCompletion` also accepts an optional `chars`.** The run info persisted in the store only holds the
   capped text.
7. **Two things are not implemented:** the optional close of the offscreen document after 60 s idle, and any router
   action on `tabs.onRemoved`. That listener only clears badge-hint timers. A run keeps playing when its source tab
   closes (v3 behaviour), and a Reader closing is handled by its port disconnect.

## Stream B's host notes (`HERMES-TO-A.md`, untracked in this worktree)

| Item | How it was handled |
|---|---|
| A1: queued `DONE`/`ERROR` after `HOST_HELLO{activeRun:null}` | Applied (see rule 5). Tests: queued DONE → completed + history, no `owner_lost`; queued ERROR → failed with the host message; no terminal → `owner_lost` once, when the grace ends. |
| URLs `host/offscreen.html`, `host/reader.html` | Already matched. |
| Copy `PROGRESS` fields into `session.progress` | Applied: `played`, `scheduled`, `index`, `end`, `unitId`, and now `bufferedSeconds` (numbers only). `STATUS.label` becomes `session.label`; `STATUS`/`DONE`/`ERROR` `metrics` become `session.metrics`. |
| `HOST_STOP` for an unknown run produces no DONE | Already covered: the SW ends the run itself on STOP and supersede. |
| Generating phase reported as `buffering` | Nothing to change; any of `preparing|buffering|playing|paused` is accepted. |
| `ERROR.retryText` | **Not** copied into `session.error`. It can be up to 200k chars and would travel in every `SESSION` fan-out and in `storage.session`. The Reader keeps its own copy, as B says. |

## For Hermes to apply elsewhere

- **At integration, when the v3 files are deleted:**
  - set `"version": "4.0.0"` in `extension/manifest.json`;
  - in `tests/sw-manifest.test.js`, stop deleting `version` before the comparison, add `version: "4.0.0"` to the
    expected object, and drop the "(version is bumped … see NOTES-A)" wording from the test title;
  - bump the root `package.json` version.
- **Streams B/C, port senders:**
  - hosts must connect from `host/offscreen.html` and `host/reader.html` exactly;
  - the Reader page opens both `host:reader` and `ui:reader`;
  - the popup must be an extension page (`ui/popup.html`).
  Ports from anywhere else are disconnected.
- **Stream C (content), `CONTENT_GET_SELECTION`:** the SW calls `chrome.tabs.sendMessage(tabId, {type})` with no
  `frameId`, as the contract says, so the first frame to answer wins. Subframes with an empty selection should not
  call `sendResponse`; otherwise an empty iframe answer can hide the real selection. If no frame answers, the SW shows
  the badge hint.
- **Stream B (hosts):**
  - after `HOST_REJECT`, the SW ignores the port. Its reason text is "Reader already open in another tab".
  - the SW never sends a `HOST_SPEAK` before `HOST_ACCEPT`.
  - on reconnect, `HOST_HELLO.activeRun.paused === true` is taken as state `paused`.
  - `STATUS.state` must be one of `preparing|buffering|playing|paused`, or it is ignored.
- **Stream C (UIs):**
  - `SESSION.controllable` is false whenever the session is idle.
  - an ended session keeps `runId`, `source`, `sourceTabId`, `hostKind`, `textPreview`, `outcome`, `error` and
    `metrics`, so it can show the "last run" result.
  - `label` on an ended session is "Done" / "Stopped" / "Replaced by a new reading", or the error message.
- **E2E:** `SERVER_URL` is imported from `shared/constants.js` by `sw/server-manager.js` only. The build rewrite of
  that file, `host_permissions` and the CSP covers the SW.
- **Plan checkpoint 2:** `grep -rn "chrome.runtime.sendMessage" extension/sw` finds nothing.
