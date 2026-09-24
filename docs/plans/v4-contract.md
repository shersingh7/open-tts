# Open TTS v4 — Implementation Contract (binding for all parallel workers)

This file is the single source of truth for file ownership, module APIs, message shapes and gates while v4 is
built in parallel git worktrees. The plan (`2026-09-23-extension-review-and-overhaul.md`) explains *why*; this file
fixes *what*. If something here is impossible, do NOT improvise a different shape — implement the closest thing,
and write the deviation in your worktree at `NOTES-<stream>.md` (repo root, will be deleted at integration).

## Global rules for every worker

- Work only inside your assigned worktree and only in the files you own (table below). Read anything.
- TDD: failing test → implement → green. Tests live in `extension/tests/` (vitest, ESM) or `backend/tests/` (pytest).
- Gate before every commit: `npm test` must exit 0 (after stream P0 lands this = lint + typecheck + vitest + pytest).
  Never mask failures (`|| true`, skipped tests, `it.skip`, loosened assertions).
- Commit per logical task on your worktree branch with message `v4(<stream>): <task>`. Never push. Never merge.
- Lifecycle guard: do NOT start/stop the real server on port 8000, do NOT run `start-server.sh`, native host
  installers, launch agents, `test:model-matrix`, real models, or David's Chrome profile. E2E uses the fake backend on
  port 18765 and Chrome for Testing with a throwaway `--user-data-dir` under `~/.hermes/cache/scratch/`.
- Never print or commit `backend/.open_tts_token` contents.
- No new runtime dependencies in the extension. Dev dependencies only where your stream says so.
- Keep code readable: ≤120 columns, descriptive names, no chained side-effect ternaries.

## Target layout (extension/)

```
manifest.json
icon*.png                      (unchanged)
sw/main.js sw/router.js sw/session-store.js sw/server-manager.js sw/host-manager.js
sw/history.js sw/menus.js sw/auth.js sw/settings.js
host/engine.js host/host-port.js host/offscreen.html host/offscreen.js
host/reader.html host/reader.js host/reader.css
ui/ui-port.js ui/popup.html ui/popup.js ui/popup.css
content/content.js             (classic script, self-contained, CSS inlined in shadow root)
shared/constants.js shared/protocol.js shared/messages.js shared/stream-decoder.js
shared/playback.js shared/playback-session.js shared/storage.js      (ESM, // @ts-check)
tests/…                        (vitest; tests/helpers/fake-chrome.js shared fake)
```
Old files (`background.js`, `offscreen.*`, `reader.*`, `popup.*`, `content.*`, `shared/*-umd.js`) are deleted at
integration (Hermes does that), not by workers — except where your stream says so.

## File ownership

| Stream | Owns (create/modify) | Must not touch |
|---|---|---|
| **P0** (wave 1) | root tooling (`package.json`, `package-lock.json`, `eslint.config.js`, `tsconfig.json`, `.gitignore`, `vitest.config.js`), `extension/shared/*.js` ESM (new), `extension/tests/helpers/*`, dead-code removal in existing v3 files, version-sync test | `e2e/`, `backend/` |
| **BE** (wave 1) | `backend/open_tts/api.py`, `backend/open_tts/security.py`, `backend/tests/test_security.py` | extension |
| **E2E** (wave 1) | `e2e/**` (new, repo root), may add `e2e`-only devDeps in its own `e2e/package.json` | extension, backend |
| **SPIKE** (wave 1) | `docs/reports/sidepanel-spike.md`; throwaway code only under `~/.hermes/cache/scratch/sidepanel-spike/` | everything else |
| **A — service worker** (wave 2) | `extension/sw/**`, `extension/manifest.json`, `extension/tests/sw-*.test.js` | `shared/*` (read-only), host/, ui/, content/ |
| **B — hosts** (wave 2) | `extension/host/**`, `extension/tests/host-*.test.js` | shared/ (read-only), sw/, ui/, content/ |
| **C — UIs** (wave 2) | `extension/ui/**`, `extension/content/**`, `extension/shared/storage.js` (add `flushPending` only), `extension/tests/ui-*.test.js`, `extension/tests/content-*.test.js` | sw/, host/, other shared/ |

If you need a change in a file you don't own, write it in `NOTES-<stream>.md`; Hermes applies it at integration.

## shared/ modules (produced by P0; everyone else imports them)

ESM conversions of the UMD files with **identical behaviour** (existing tests ported to import them):
- `shared/constants.js` — all current `OpenTTSConstants` exports **minus** dead `CHUNK_TARGET`, `FIRST_CHUNK_TARGET`,
  `FALLBACK_WINDOW`, **plus**:
  ```js
  export const READER_TEXT_THRESHOLD = 4000;
  export const SLOW_MODELS = ["qwen3-tts", "fish-s2-pro"];
  export const SLOW_MODEL_READER_THRESHOLD = 600;
  export const SLOW_START_TIMEOUT_MS = 25000;
  export const HISTORY_TEXT_CAP = 2000;
  export const HISTORY_MAX_BYTES = 256000;
  export const HEARTBEAT_MS = 20000;
  export const HIDDEN_SITES_KEY = "hiddenSites";
  ```
- `shared/protocol.js` — `makeRunId, parseApiErrorBody, describeFetchError, interpretHealth` (others only if used).
  `makeRunId()` returns `crypto.randomUUID()`.
- `shared/stream-decoder.js` — `FrameDecoder, StreamCursor, MAX_HEADER_BYTES, MAX_AUDIO_BYTES`.
- `shared/playback.js` — `splitText, normalizeText, packGenerationUnits, sentenceUnits, hardSplit, nonWhitespaceKey,
  createPlaybackClock, createPlaybackGate` (dead `consumePlaybackStream`, `speakStatus` removed).
- `shared/playback-session.js` — `createPlaybackRun, readWithIdleTimeout, bufferDecodedBytes` (imports playback.js
  and constants.js instead of globals).
- `shared/storage.js` — promise wrappers `syncGet, syncSet, localGet, localSet, sessionGet, sessionSet,
  sessionRemove, localRemove`, `debouncedSyncSet, debouncedLocalSet`, `setStorageErrorHandler(fn)`. All reject on
  `chrome.runtime.lastError`. **No token helpers here** (token lives in `sw/auth.js`).
- `shared/messages.js` — written by Hermes, already present; import the constants, never retype strings (except in
  `content/content.js`, which is classic and must mirror them; a test enforces equality).

## Port protocol

Every extension context talks to the SW over `chrome.runtime.connect({name})`. **No `chrome.runtime.sendMessage`
anywhere** except two one-shot `chrome.tabs.sendMessage` calls from SW/popup to content (`CONTENT_GET_SELECTION`,
`CONTENT_GET_HOST`).

Port names: `ui:popup`, `ui:content`, `ui:reader`, `host:offscreen`, `host:reader`.

### UI → SW (commands)
All commands may carry `requestId` (string). If present, SW answers with exactly one
`{type:"REPLY", requestId, ok:true, data}` or `{type:"REPLY", requestId, ok:false, error, code}`.

| type | fields | notes |
|---|---|---|
| `SPEAK` | `runId, text, settings?` | `settings = {model, voice, speed, language, instruct}`; if omitted SW resolves from storage (`sw/settings.js`). `source` is derived from the port name, never trusted from payload. |
| `PAUSE` / `RESUME` / `STOP` | `runId` | ownership rules apply |
| `START_SERVER` / `STOP_SERVER` | — | |
| `LOAD_MODEL` | `modelId` | |
| `GET_MODELS` | — | reply data = backend `/v1/models` JSON |

### SW → UI (snapshots, idempotent; UIs render the latest)
| type | fields |
|---|---|
| `SESSION` | `session` (below), `controllable: boolean` (per-port, rule 2/3) |
| `SERVER_STATE` | `state: "unknown"|"offline"|"starting"|"ready"|"warming"|"failed"`, `message`, `model?` |
| `MODEL_STATE` | `modelId, state: "idle"|"loading"|"loaded"|"failed", message` |
| `HISTORY_ERROR` | `runId, message` |
| `REPLY` | see above |

On connect, SW immediately posts `SESSION`, `SERVER_STATE` (and `MODEL_STATE` if known) to that port.

```js
// session object
{
  runId: string|null, revision: number,
  state: "idle"|"preparing"|"buffering"|"playing"|"paused",
  label: string,                    // human text e.g. "Generating...", "Reading...", "Paused"
  source: "popup"|"content"|"reader"|"menu"|"command"|null,
  sourceTabId: number|null, sourceFrameId: number|null,
  hostKind: "offscreen"|"reader"|null,
  progress: { played: number, scheduled: number, index?: number, end?: number, unitId?: number } | null,
  outcome?: "completed"|"stopped"|"superseded"|"failed"|"owner_lost",   // only on state "idle" after a run
  error?: { message: string, code?: string },
  metrics?: object,
  textPreview?: string              // first 200 chars, for UI display only
}
```

### SW → host
| type | fields |
|---|---|
| `HOST_ACCEPT` | — (sent after `HOST_HELLO` when accepted) |
| `HOST_REJECT` | `reason` (second reader) — host must stay inert and show the reason |
| `HOST_SPEAK` | `run: {runId, source, sourceTabId, sourceFrameId}`, `text`, `settings`, `authToken`, `protocolVersion: 2`, `firstAudioDeadlineMs: number|null` |
| `HOST_PAUSE` / `HOST_RESUME` | `runId` |
| `HOST_STOP` | `runId, outcome: "stopped"|"superseded"` |

### host → SW
| type | fields |
|---|---|
| `HOST_HELLO` | `kind: "offscreen"|"reader"`, `activeRun: null | {runId, state, paused}` (sent on every (re)connect) |
| `STATUS` | `runId, state: "preparing"|"buffering"|"playing"|"paused", label, bufferedSeconds?, metrics?` |
| `PROGRESS` | `runId, played, scheduled, index?, end?, unitId?, bufferedSeconds?` |
| `DONE` | `runId, outcome: "completed"|"stopped"|"superseded", metrics` |
| `ERROR` | `runId, outcome: "failed", message, code?, retryText?, metrics?` |
| `HEARTBEAT` | `runId` (every `HEARTBEAT_MS` while a run exists, incl. paused) |

Exactly one terminal (`DONE` or `ERROR`) per run from the host; the SW additionally de-duplicates via
`session-store.end()`.

## Ownership rules (implemented in sw/router.js)
1. One active run. New `SPEAK` → `HOST_STOP{outcome:"superseded"}` to old host **before** `HOST_SPEAK` to the new
   host; old run published as idle/`superseded`.
2. Ports `ui:popup`, `ui:reader` may control the active run.
3. `ui:content` may control only if `run.sourceTabId === port.sender.tab.id && run.sourceFrameId ===
   port.sender.frameId`. Runs started by `menu`/`command` record the tab id and `frameId` 0 (menu: `info.frameId`).
4. Only one `host:reader` port accepted; others get `HOST_REJECT`.
5. Owning host port disconnect while a run is active → `ERROR` outcome `owner_lost` (once). The SW waits up to
   **2 s** for the same host kind to reconnect with `HOST_HELLO.activeRun.runId === runId` before declaring loss
   (covers transient reconnects).
6. Terminal events for a runId ≠ current run are dropped.

## Host selection (sw/host-manager.js)
```js
export function chooseHostKind({ textLength, model, source }) {
  if (source === "reader") return "reader";
  if (textLength > READER_TEXT_THRESHOLD) return "reader";
  if (SLOW_MODELS.includes(model) && textLength > SLOW_MODEL_READER_THRESHOLD) return "reader";
  return "offscreen";
}
```
`firstAudioDeadlineMs = (hostKind === "offscreen" && SLOW_MODELS.includes(model)) ? SLOW_START_TIMEOUT_MS : null`.
If the engine hits the deadline with no audio scheduled it ends the run with `ERROR` code `slow_start`, message
`"Model is slow to start — retry to open the Reader"`.

Reader: opened with `chrome.tabs.create({url: host/reader.html, active: true})`, then
`chrome.tabs.update(id, {autoDiscardable:false})`; restored to `true` on terminal. (If the side-panel spike passes,
Hermes switches this at integration.)

## Session store (sw/session-store.js)
Persists the session object in `chrome.storage.session` key `v4Session`. API:
`load() → session`, `begin(run) → session`, `update(runId, patch) → session|null`, `end(runId, outcome, extra) →
boolean` (true only first time for the current run), `current() → session`. Revision strictly increases and is
persisted.

## Auth (sw/auth.js)
- At SW start: `chrome.storage.session.setAccessLevel({accessLevel:"TRUSTED_CONTEXTS"})`,
  `chrome.storage.local.remove("installToken")`.
- `getToken()` reads `storage.session.installToken`; on miss calls native host `status` and stores
  `install_token`. `refreshToken()` for 401 retry. `authHeaders()` returns headers.

## Server manager (sw/server-manager.js)
- `fetchHealth(timeoutMs)` keeps the v3 identity check (`engine === "open-tts"`, string `version`).
- `ensureServer({waitForWarm})` single-flight; native `start` if unhealthy; poll `/health` every 1 s (max 60 s);
  publishes `SERVER_STATE`.
- `loadModel(modelId)` POST `/v1/load-model?model_id=` with 10 s timeout; on timeout keep polling `/health` every
  1 s up to 300 s for `model === modelId && model_warm`; publishes `MODEL_STATE`.
- `apiFetch(path, opts)` with auth + one 401 refresh retry.
- `SERVER_URL` comes from `shared/constants.js` (the E2E test build rewrites it).

## History (sw/history.js)
`persistCompletion({id, text, voice, model, speed, timestamp})`: only if `storage.local.historyEnabled === true`.
Entry `{id, text: text.slice(0, HISTORY_TEXT_CAP), chars: text.length, truncated, voice, model, speed, timestamp}`;
drop oldest while `length > MAX_HISTORY` or `JSON.stringify(list).length > HISTORY_MAX_BYTES`. Serialized writes.
On failure publish `HISTORY_ERROR`.

## Menus & commands (sw/menus.js)
- Context menu id `open-tts-read`, title "Read with Open TTS", contexts `["selection"]`, created in
  `chrome.runtime.onInstalled`. Click → SPEAK with `info.selectionText`, source `menu`, tab/frame from `tab`/`info`.
- Commands (manifest): `read-selection` (`Alt+Shift+R`), `toggle-pause` (`Alt+Shift+P`).
  `read-selection` → `chrome.tabs.sendMessage(tab.id, {type: CONTENT_GET_SELECTION})` → reply `{text}`; on failure
  or empty text: `chrome.action.setBadgeText({tabId, text:"?"})` + title "Use right-click → Read with Open TTS",
  cleared after 4 s. `toggle-pause` → pause/resume current run (always allowed; the user pressed the key).

## Manifest (owned by A)
```json
{
  "manifest_version": 3, "name": "Open TTS", "version": "4.0.0", "minimum_chrome_version": "116",
  "permissions": ["storage", "nativeMessaging", "offscreen", "contextMenus"],
  "host_permissions": ["http://127.0.0.1:8000/*"],
  "content_security_policy": {"extension_pages": "script-src 'self'; object-src 'self'; style-src 'self'; connect-src 'self' http://127.0.0.1:8000;"},
  "background": {"service_worker": "sw/main.js", "type": "module"},
  "action": {"default_popup": "ui/popup.html", "default_icon": {…existing…}},
  "icons": {…existing…},
  "content_scripts": [{"matches": ["<all_urls>"], "js": ["content/content.js"], "run_at": "document_idle"}],
  "commands": {
    "read-selection": {"suggested_key": {"default": "Alt+Shift+R"}, "description": "Read selected text"},
    "toggle-pause": {"suggested_key": {"default": "Alt+Shift+P"}, "description": "Pause or resume reading"}
  }
}
```

## Content script (content/content.js, owned by C)
- Classic script, no imports. Mirrors message strings from `shared/messages.js` in a local `MSG` object (test
  enforces equality).
- Host element `<open-tts-widget>` on `document.documentElement` with `attachShadow({mode:"closed"})` and inline
  `<style>`. Early return if no `documentElement` or if `location.hostname` is in `storage.sync.hiddenSites`
  (listen to `chrome.storage.onChanged` to hide/show live).
- Opens its `ui:content` port lazily on first user action; reconnects on disconnect when next needed.
- Idle: widget appears near selection with Speak. Active & controllable: primary Pause/Resume, Stop always visible,
  "Read selection" when current selection text ≠ run's `textPreview` prefix; outside mousedown collapses to a small
  pinned control instead of hiding.
- Errors matching `/context invalidated|Receiving end does not exist|Extension context/i` → "Open TTS was updated —
  reload this page".
- Answers `chrome.runtime.onMessage` `{type: CONTENT_GET_SELECTION}` → `{text}` and `{type: CONTENT_GET_HOST}` →
  `{host: location.hostname}` (top frame only).

## Popup (ui/popup.*, owned by C)
Port-driven rewrite of today's popup (keep the current visual design/CSS, IDs may stay). Must: render only from
`SESSION`/`SERVER_STATE`/`MODEL_STATE`; never send `LOAD_MODEL` on open (only on explicit model change); history
toggle defaults off (`historyEnabled === true` means on) and shows "(first 2,000 chars)" on truncated entries;
`flushPending()` on `pagehide` and `visibilitychange→hidden`; speed persisted on `change`; "Hide widget on <host>"
toggle using `CONTENT_GET_HOST` on the active tab (hidden if no content script answers); footer shows
"First audio: X.Xs" from `session.metrics.firstAudioClockStartedAt - session.metrics.acceptedAt` when present.

## Hosts (host/*, owned by B)
- `engine.js`: `export function createEngine({ emit, hostKind, fetchImpl = fetch, audioContextFactory })` returning
  `{ speak(cmd), pause(runId), resume(runId), stop(runId, outcome), activeRun() }`. Port of current `offscreen.js`
  pipeline (wavInfo, streamBatch, runSpeak, pause/resume with latest-control-wins) emitting the host→SW messages
  above instead of `chrome.runtime.sendMessage`. Adds `firstAudioDeadlineMs` enforcement and heartbeat timer
  (`HEARTBEAT` every `HEARTBEAT_MS` while a run exists).
- `host-port.js`: `export function connectHost({ kind, engine, onReject, onAccept, connect = chrome.runtime.connect })`
  — connects `host:<kind>`, sends `HOST_HELLO{kind, activeRun}` on every (re)connect, reconnects on disconnect with
  backoff 100 ms → 2 s (only while the page lives), dispatches `HOST_*` commands to the engine, forwards engine
  events.
- `offscreen.html/js`: module script wiring engine + host-port kind `offscreen`.
- `reader.html/js/css`: wiring kind `reader`; also opens `ui:reader` port to render `SESSION` (status, progress bar,
  passage counter, metrics details, Pause/Resume, Stop, Retry-from-interruption via `SPEAK` with `retryText` from the
  last `ERROR`), shows `HOST_REJECT` reason and stays inert, `prefers-reduced-motion`, focus-visible. Port the
  current reader UI text.
- `pagehide` is NOT used for owner loss (port disconnect covers it).

## Fake chrome for tests (tests/helpers/fake-chrome.js, produced by P0)
`createFakeChrome()` returning a `chrome`-shaped object with: `storage.{sync,local,session}` (get/set/remove with
callback **and** promise forms, `onChanged`, `setAccessLevel`), `runtime.connect/onConnect` producing linked
fake Port pairs (`postMessage`, `onMessage`, `onDisconnect`, `disconnect`, `sender`), `runtime.getURL`,
`runtime.getContexts`, `runtime.sendNativeMessage` (scriptable), `runtime.lastError`, `runtime.onInstalled`,
`tabs.{create,update,sendMessage,query,get,onRemoved}`, `offscreen.{createDocument,hasDocument,closeDocument}`,
`contextMenus.{create,removeAll,onClicked}`, `commands.onCommand`, `action.{setBadgeText,setTitle}`. Each API is a
spy (records calls) and scriptable. Plus `createPortPair(nameA, senderA)` for direct router tests.
