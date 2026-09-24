# Open TTS Extension — Review + Phased Overhaul Plan (→ v4.0.0)

> **Status:** Plan only; nothing has been implemented. Updated 2026-09-23 with every open decision resolved to the
> recommended option (see "Decisions").
> **Implementer:** Hermes, directly. **No delegation**: no agy, Grok Build, Claude Code, Codex or subagents for any
> task. This overrides the repo `AGENTS.md` "Grok Build may implement" note for this project.
> **Baseline:** `main` @ `cf84ef3` (v3.5.0), clean tree. `npx vitest run` → 11 files / **101 passed** (2026-09-23).
> **Scope reviewed:** `extension/**` (all JS/HTML/CSS/manifest/tests) plus the backend code the extension depends on
> (`backend/open_tts/security.py`, the stream path in `api.py`, and the token path in `native_host.py`).

**Goal:** Keep what v3.5 does well (strict v2 stream contract, run-scoped playback, bounded memory), fix the real
bugs, and replace broadcast-and-filter messaging with a port-based session bus that has exactly one source of truth.

**Architecture (target):** The service worker (SW) is the single owner of the session and the router between parts.
It also manages the server. For each run, exactly one *playback host* page owns the audio: the offscreen document
for short reads, and the Reader (a tab, or the side panel if the spike passes) for long or slow reads. UIs and hosts
talk to the SW over long-lived named ports. If a host's port disconnects, that counts as the owner being lost.
Extension pages and the SW use native ES modules. The content script stays a single self-contained classic file,
with **no build step**.

**Tech stack:** Chrome MV3 (minimum version 116), Web Audio, vitest, ESLint (flat config), TypeScript `checkJs`
(type-check only, no emitted files), and Puppeteer with Chrome for Testing for end-to-end (E2E) tests against a fake
backend.

---

## Decisions (resolved to the recommended option)

| # | Decision | Resolution | Why |
|---|---|---|---|
| D1 | History default and size | History is **off by default**. When it's on, each entry stores the first **2,000 chars**, with at most 20 entries and **256 KB** in total. | Fits the privacy stance, avoids the storage quota, and replay still covers typical selections. |
| D2 | Messaging overhaul | **Do it** (Phase 2). | Finding #2 is the root cause of most historical bugs. |
| D3 | Build step | **None.** The content script stays one classic file with its few constants inlined. A test asserts they match `shared/constants.js`. | Avoids a bundler pipeline for a single ~300-line file. |
| D4 | Side panel vs Reader tab | **Spike first (Task 2.0).** The written decision rule in that task decides; it doesn't need another check-in. | Only real Chrome behaviour can settle this. |
| D5 | Widget scope | **Keep the always-on `<all_urls>` widget.** Add a per-site "hide widget here" toggle, a context menu and keyboard shortcuts. | Keeps select-to-speak and adds control, keyboard access and PDF support. |
| D6 | Repo hygiene | **Untrack** `.hermes/plans/`, `graphify-out/` and `run-graphify.py`. The files stay on disk and go into `.gitignore`. Keep `artifacts/*.json` only if the docs reference them. | Tool scratch doesn't belong in product history. |
| D7 | Implementer | **Hermes itself**, with no delegates. | David's instruction. |
| D8 | Version | **4.0.0**. | The messaging between extension parts is rewritten. The backend HTTP contract is unchanged apart from a hostname check. |
| D9 | Git | Work on a local branch `extension-v4` off `main`, with **one commit per task**. **No push or merge** without David's OK. | Keeps the work reviewable and reversible. |

## Guardrails (apply to every task)

- **TDD:** write the failing test, confirm it fails, implement, then confirm it passes.
- **Gate after every task:** `npm test`, which after Phase 0 runs lint, type-check, vitest and backend pytest. It must
  exit 0 with nothing masked.
- **Lifecycle guard** (from the repo `AGENTS.md`):
  - never start or stop the live server or launch agent;
  - never switch real models;
  - never synthesize real audio;
  - never touch David's Chrome profile.
  E2E runs use a throwaway Chrome for Testing profile and a fake backend on a **port other than 8000**.
- Check `git status --short` before each commit. Never commit stray artifacts, `dist/` or logs.
- If a phase checkpoint fails, fix it within scope and keep going. Only stop to ask if the scope would expand.

---

## Part A — Review findings

Severity:
- **CRITICAL:** broken in normal use.
- **HIGH:** likely user-visible failure, or a security issue.
- **MEDIUM:** an edge-case bug or real technical debt.
- **LOW:** hygiene.

"Fact" means traced in the code. "Risk" means plausible but needs a check in real Chrome.

### What's good (keep)

- `stream-decoder-umd.js`: a bounded frame parser that copies each byte only once. `StreamCursor` enforces sequence,
  source coverage, final/done ordering and speed ownership.
- `playback-session-umd.js`: each run gets its own AbortController and AudioContext, with byte and seconds budgets.
  `teardown()` clears the token.
- Offscreen and Reader share one playback engine instead of having two pipelines.
- History is written only when a run actually reaches the `completed` outcome.
- The native host manifest pins `allowed_origins` to one extension ID.

### Findings

| # | Sev | Area | File / symbol | Issue | Impact | Fixed in |
|---|-----|------|---------------|-------|--------|---|
| 1 | **HIGH** | Routing | `offscreen.js:200-209`, `background.js:17-36` | Reader hosts are addressed by **broadcast** `chrome.runtime.sendMessage`, filtered only by `hostKind`. Two `reader.html` tabs (from session restore, a duplicated tab or reopening from history) **both** run `runSpeak` for the same `runId`. | Audio is generated twice. The backend's `ModelRuntime(max_pending=1)` queues the second stream. Whichever tab finishes or errors first clears `activeSession`, and the other tab keeps playing with no working controls. (Fact in code; the tab-restore trigger is confirmed in E2E.) | 1.1 (stopgap), 2.3 (structural) |
| 2 | **HIGH** | Architecture | `background.js` (`activeSession`, `recoverSession`, `hostSnapshot`, `deliveredTerminals`), `offscreen.js` (`session`), `popup.js`/`content.js` (`activeRun`/`currentRunId`) | Session state lives in at least 3 places. They're reconciled with snapshots, revision counters, routing flags and dedupe sets, and every event is broadcast to every extension part and then filtered. | The 3.4.x changelog bugs are races in this design, and each fix adds another guard. (Fact) | Phase 2 |
| 3 | **HIGH** | Security | `storage-umd.js:47-55` (`installToken` in `chrome.storage.local`) | Content scripts can read `chrome.storage.local`, and they run inside every web page's renderer process. | A compromised renderer (any site) can read the API token. (Fact; the exploit needs a renderer compromise.) | 1.2 |
| 4 | MEDIUM | Lifecycle | `background.js:179-193`, `345-360` (`LOAD_MODEL` is one fetch of up to 300 s), `368-405` | Long waits run in the SW, triggered by `sendMessage` from a popup that closes as soon as it loses focus. | The work usually finishes, but closing the popup drops the only response channel. Reopening it shows no progress. (Risk) | 2.5 |
| 5 | **HIGH** | UX / resources | `popup.js:334-346` (`loadModels`) | Opening the popup **automatically loads** the saved model if it isn't loaded. This can take up to 5 minutes, and Fish is 6.3 GB. | Glancing at the popup can tie up gigabytes of memory. (Fact) | 1.3 |
| 6 | MEDIUM | Storage | `background.js:48-58`, `MAX_HISTORY=20`, `MAX_CHARS=200000` | History stores the **full text** with no byte limit and is **on** by default. | It can hit the 10 MB storage quota and keeps up to 4 MB of reading text on disk. (Fact) | 1.4 |
| 7 | MEDIUM | Popup | `popup.js:551-569`, `storage-umd.js:30-46` | Settings writes are delayed 300 ms, and the delay timers die when the popup closes. | A quick speed change followed by closing the popup is lost. (Fact) | 1.5 |
| 8 | MEDIUM | Reader | `background.js:25` | Chrome is allowed to discard the Reader tab, and it isn't playing audio yet during the first-packet wait. | Memory Saver can discard it, causing a false "owner lost" error. (Risk) | 1.6 |
| 9 | MEDIUM | Reader UX | `background.js:246` | Every Qwen or Fish request opens a tab, even a 5-word popup preview, which closes the popup. | Previews are jarring. (Fact) | 1.7 |
| 10 | MEDIUM | Content perf | `content.js:14-18` | On every page, an observer watches the whole document just to remove a leftover element from v2. | Constant cost on heavy single-page apps like Gmail. (Fact) | 1.8 |
| 11 | MEDIUM | Content UX | `content.js:133-154`, `258-261` | While speaking, clicking the widget after selecting new text pauses instead of reading the new text. Any click on the page hides the on-page Stop button. | Confusing controls. (Fact) | 1.8 |
| 12 | MEDIUM | Content robustness | `content.js:18,49` | The widget assumes `document.body` exists and sits in the page's DOM with no Shadow DOM isolation. | It throws on pages without a body, and page CSS or scripts can interfere with it. (Fact) | 1.8 |
| 13 | MEDIUM | Coverage | `manifest.json` | No keyboard commands or context menu, and the content script can't run in Chrome's PDF viewer. | Mouse-only, and PDFs aren't supported. (Fact) | 4.1, 4.2 |
| 14 | MEDIUM | Backend | `security.py:156-160`, `api.py` | Requests from the local machine with no `Origin` header skip the token, and the server doesn't check the Host header. A website can use DNS rebinding to read `/health`, `/v1/models` and `/v1/voices`. | Read-only information leak; it can't make the server speak. (Fact/Risk) | 1.9 |
| 15 | MEDIUM | Errors | `content.js:107-117`, `popup.js:52-62` | After an extension update, the raw "Extension context invalidated" error is shown. | The message is cryptic. (Fact) | 1.8 |
| 16 | MEDIUM | Maintainability | `background.js`, `offscreen.js`, `reader.js` | Code is written like minified output (crammed one-liners) and there's no lint config. | Hard to review. (Fact) | 0.3, 2.7 |
| 17 | LOW | Dead code | `shared/protocol.js`, `shared/constants.js`, `shared/storage.js` (ES module versions) | These files aren't used by anything and have already drifted from the real ones. | Easy to edit the wrong file. (Fact) | 0.1 |
| 18 | LOW | Dead code | The `ENSURE_SERVER`, `ENSURE_OFFSCREEN` and `GET_VOICES` routes; content `STOP_TTS`; popup `addHistory`/`pendingHistory`; `consumePlaybackStream`, `speakStatus`; `CHUNK_TARGET`, `FIRST_CHUNK_TARGET`, `FALLBACK_WINDOW` | Nothing in production calls these. | Noise. (Fact) | 0.2 |
| 19 | LOW | Duplication | `START_SERVER`, `ensureBackendAvailable` and `ENSURE_SERVER` | Three server-start implementations, each with its own rule for "ready". | Readiness is inconsistent. (Fact) | 2.5 |
| 20 | LOW | Versioning | `content.css:1` says v3.0; `popup.html:128` hardcodes v3.5.0 | Version strings have drifted. | Cosmetic. | 0.4 |
| 21 | LOW | Popup | `GEN:`/`ACK:` footer | "ACK" is when the request was acknowledged, not when audio started. | Misleading. | 4.5 |
| 22 | LOW | Repo | `.hermes/plans`, `graphify-out` and `run-graphify.py` are tracked in git | Tool scratch in the product repo. | Noise. | 0.5 |
| 23 | LOW | Tests | `extension/tests/*` | Tests only run the code with a fake `chrome` object. There are no real-Chrome end-to-end tests and no lint. | Lifecycle bugs can't be caught. | 0.3, Phase 5 |

**Totals:** 0 CRITICAL · 4 HIGH · 12 MEDIUM · 7 LOW. Every finding has a task that fixes it.

---

## Part B — Target architecture

```
extension/
  manifest.json          # SW type:module; + contextMenus, commands (+ sidePanel if spike passes)
  sw/
    main.js              # composition root; all listeners registered synchronously at top level
    router.js            # port registry, ownership rules, command routing, event fan-out
    session-store.js     # authoritative run record in chrome.storage.session (+ revision)
    server-manager.js    # ONE ensureServer()/health/token/model-load; emits SERVER_STATE / MODEL_STATE
    host-manager.js      # ensureOffscreen(); ensureReader() singleton (autoDiscardable:false) or side panel
    history.js           # bounded history writes (D1)
    menus.js             # context menu + keyboard commands
  host/
    engine.js            # today's offscreen engine as a module: createEngine({emit}) → {speak,pause,resume,stop}
    host-port.js         # connect "host:<kind>", heartbeat, reconnect, relay commands/events
    offscreen.html/.js   # thin: engine + host-port("offscreen")
    reader.html/.js/.css # thin: engine + host-port("reader") + Reader UI (or sidepanel.* per spike)
  ui/
    ui-port.js           # connect "ui:<kind>", deliver SESSION/SERVER_STATE snapshots to a render callback
    popup.html/.js/.css
  content/
    content.js           # classic, self-contained; closed shadow-root widget with inline <style>; port "ui:content"
  shared/                # ESM, // @ts-check
    constants.js protocol.js stream-decoder.js playback.js playback-session.js storage.js
  tests/                 # unit tests importing ESM directly
e2e/                     # repo-root: puppeteer runner, fake backend, test-build script (never packaged)
```

### Message model

- **Ports:** `ui:popup`, `ui:content`, `ui:reader`, `host:offscreen`, `host:reader`.
- **UI → SW commands:** `SPEAK{text,settings,runId}`, `PAUSE{runId}`, `RESUME{runId}`, `STOP{runId}`,
  `START_SERVER`, `STOP_SERVER`, `LOAD_MODEL{modelId}`, `GET_MODELS`.
- **SW → host:** `HOST_SPEAK{run,settings,authToken}`, `HOST_PAUSE`, `HOST_RESUME`, `HOST_STOP{runId}`,
  `HOST_REJECT`.
- **Host → SW:** `HOST_HELLO{kind,activeRun?}`, `STATUS`, `PROGRESS`, `DONE`, `ERROR`, `HEARTBEAT{runId}`.
- **SW → UIs:** each message is a complete, idempotent snapshot:
  - `SESSION{state,runId,label,paused,source,progress}`;
  - `SERVER_STATE` and `MODEL_STATE`;
  - `HISTORY_ERROR`.

  UIs render the latest snapshot, so they don't need to filter out stale events.

### Ownership rules (`router.js`)

1. There is exactly one active run. A new `SPEAK` stops the old host first, publishes the old run as `superseded`,
   and only then starts the new one.
2. Extension UIs (popup, Reader UI, side panel) may control the active run.
3. A `ui:content` port may control the run only if `run.sourceTabId === sender.tab.id` and
   `run.sourceFrameId === sender.frameId`.
4. Only one `host:reader` port is accepted. A second one receives `HOST_REJECT` and shows "Reader already open". This
   is the structural fix for #1.
5. If the host that owns the active run disconnects, the SW sends `ERROR{outcome:"owner_lost"}` exactly once.
6. Terminal events for anything other than the stored active run are dropped. This check happens in one place only.

### Service-worker lifetime

- All listeners are registered synchronously at the top level of `sw/main.js`.
- `session-store` persists `{runId, hostKind, state, sourceTabId, sourceFrameId, revision}` in `storage.session`.
- While a run exists (including when paused), the host sends `HEARTBEAT` every 20 s. This keeps the SW and the ports
  alive.
- If the SW restarts anyway, hosts notice the disconnect, reconnect and send `HOST_HELLO{activeRun}`. The router
  reconciles that against the store. If the store says the run already ended, it isn't brought back.

---

## Part C — Implementation plan

Setup (once): `git switch -c extension-v4`.

### Phase 0 — Safety net and dead code (no behaviour change) · ~0.5 day

**0.1 Delete the unused duplicate ES module files** (#17)
- Delete `extension/shared/protocol.js`, `constants.js` and `storage.js`.
- Verify: `grep -rn "shared/\(protocol\|constants\|storage\)\.js" extension scripts` finds nothing, and vitest still
  passes 101/101.

**0.2 Remove dead routes and helpers** (#18)
- Test first: `ENSURE_SERVER`, `ENSURE_OFFSCREEN` and `GET_VOICES` each return `Unknown message type`.
- Delete those handlers, the content-script `STOP_TTS` branch, and the popup's `addHistory` and `pendingHistory`.
- Delete `consumePlaybackStream` and `speakStatus`, along with their tests.
- Delete the unused constants `CHUNK_TARGET`, `FIRST_CHUNK_TARGET` and `FALLBACK_WINDOW`.

**0.3 Lint and type-check gates** (#16, #23)
- Add dev dependencies: `eslint`, `@eslint/js`, `globals`, `typescript`.
- `eslint.config.js`:
  - `js.configs.recommended`, with browser and `webextensions` globals;
  - `no-unused-vars: error`;
  - ignore `backend/venv`, `dist`, `node_modules`, `graphify-out`.
- `tsconfig.json`: `allowJs`, `checkJs: false`, `noEmit`. Individual files opt in with `// @ts-check`.
- `package.json` scripts:
  - `"lint": "eslint extension scripts e2e"`;
  - `"typecheck": "tsc -p tsconfig.json"`;
  - `"test": "npm run lint && npm run typecheck && npm run test:js && npm run test:backend"`.
- Fix lint **errors** only. No mass reformatting in this task.

**0.4 Version-sync test** (#20)
- Test: every version header in `extension/**/*.{js,css,html}` matches `manifest.version`, and `popup.html` contains
  no hardcoded version.
- Fix `content.css` and `popup.html`.

**0.5 Repo hygiene** (#22, D6)
- Untrack the scratch files: `git rm -r --cached .hermes/plans graphify-out run-graphify.py`.
- Add them to `.gitignore`.
- Check `artifacts/` with `grep -rn "artifacts/" README.md docs`. If nothing references it, untrack it too.

**Checkpoint 0:** `npm test` exits 0, and the tree is clean after the commits.

### Phase 1 — Targeted bug fixes · ~1.5 days

These fixes don't depend on the messaging rewrite, so their code and tests carry over into Phase 2.

**1.1 One Reader at a time (stopgap)** (#1)
- On load, `reader.js` calls
  `chrome.runtime.getContexts({contextTypes:["TAB"], documentUrls:[chrome.runtime.getURL("reader.html")]})`.
- If another Reader with a lower `tabId` exists, this tab shows "Reader already open in another tab". It doesn't
  register as a host or load the engine.
- Test: with two Reader contexts in the test harness, there is exactly one `runSpeak` call and one fetch.

**1.2 Move the token to `storage.session`** (#3)
```js
// SW top level
chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
chrome.storage.local.remove("installToken"); // one-time migration, idempotent
```
- `getAuthHeaders` and `storeInstallToken` switch to `chrome.storage.session`.
- If the token is missing or a request returns 401, it's refilled through the existing native-host `status` path.
- The content script stops loading `storage-umd.js` and gets a tiny inline `syncGet` for its settings.
- Tests:
  - `local.installToken` is removed at SW start;
  - auth headers come from session storage;
  - the manifest's content-script list doesn't include `storage-umd.js`.

**1.3 No model load when the popup opens** (#5)
- `loadModels()` never sends `LOAD_MODEL`. If the model isn't loaded, the model info line says
  "<model> — loads on first Speak".
- `LOAD_MODEL` runs only when the user explicitly picks a different model. The backend already loads the model on
  first use.
- Test: opening the popup with an unloaded model sends zero `LOAD_MODEL` messages.

**1.4 Bounded, privacy-first history** (#6, D1)
- Stored entry: `{id, text: text.slice(0,2000), chars, truncated, voice, model, speed, timestamp}`.
- Drop the oldest entries while there are more than 20 or `JSON.stringify(history).length > 256_000`.
- History is saved only if `historyEnabled === true`, so it's off by default.
  - An existing `false` or unset value means off.
  - An explicit `true` stays on.
  - Existing entries are kept and trimmed to the cap on the next write.
- In the popup, a truncated entry is labelled "(first 2,000 chars)", and replay plays the stored slice.
- Update PRIVACY.md.
- Tests:
  - 20 completed runs of 200k characters store less than 256 KB;
  - when the setting is unset, nothing is written.

**1.5 Settings survive the popup closing** (#7)
- The speed label updates on `input`, and the value is saved immediately on `change`.
- `storage-umd.js` gets `flushPending()`, which cancels the delay timers and writes every pending value right away.
- The popup calls `flushPending()` on `pagehide` and on `visibilitychange` → hidden.
- Test: set the speed, fire `pagehide` before 300 ms, and `sync.set` is called with the new value.

**1.6 Reader tab can't be discarded** (#8)
- After `tabs.create`, set `chrome.tabs.update(id, {autoDiscardable:false})`.
- Set it back to `true` when the run ends.
- Test: the harness sees both updates.

**1.7 Short Qwen/Fish requests stay offscreen** (#9)
- New constants: `READER_TEXT_THRESHOLD = 4000` and `SLOW_MODEL_READER_THRESHOLD = 600`.
- A run goes to the Reader if:
  - the text is longer than 4000 characters;
  - or it uses a slow model (Qwen or Fish) and the text is longer than 600 characters;
  - or it was started from the Reader.
- Guard: Chrome can close an offscreen document after about 30 s without audio. If a slow-model offscreen run has no
  first audio after 25 s, it fails with "Model is slow to start — retry to open the Reader". No silent-audio
  keepalive tricks.
- Test: a routing table covering 5, 600, 601 and 5000 characters for each of Kokoro, Qwen and Fish.
- The real first-audio time for 600 characters with Qwen is measured in the authorized check 5.4. If it's over 20 s,
  the threshold is lowered.

**1.8 Content script hardening** (#10, #11, #12, #15)
- Remove the observer and keep a single `removeLegacy()` call.
- The widget moves into a custom element `<open-tts-widget>` attached to `document.documentElement`:
  - it uses a closed shadow root with the `content.css` rules inlined as a `<style>`;
  - `content.css` is removed from the manifest;
  - if the page has no `documentElement`, the script exits early.
- While a run is active:
  - the main button is Pause/Resume, and Stop is always shown;
  - if the current selection is different from the text being read, a "Read selection" action starts a new run that
    replaces the current one;
  - clicking elsewhere on the page shrinks the widget to a small pinned control instead of hiding it.
- Error text: "context invalidated" and "Receiving end does not exist" are shown as
  "Open TTS was updated — reload this page".
- Tests:
  - the new-selection path;
  - the widget stays visible during a run;
  - the error text mapping;
  - a page without a body.

**1.9 Backend checks the Host header** (#14)
```python
from starlette.middleware.trustedhost import TrustedHostMiddleware
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", *extra_hosts])
```
- `create_app(allowed_hosts_extra=...)` defaults to empty. Tests pass `["testserver"]` so `TestClient` works; this is
  never on in production.
- Tests in `backend/tests/test_security.py`:
  - `Host: evil.example` is rejected with 400;
  - `127.0.0.1:8000` and `localhost:8000` are accepted.

**Checkpoint 1:** `npm test` exits 0. Every Phase 1 finding has a regression test. As a spot check, I temporarily
revert two of the fixes and confirm their tests fail.

### Phase 2 — Port-based session bus, written as ES modules from the start · ~3.5 days

(The original separate "modules" phase is folded in here, so nothing is written twice.)

**2.0 Side-panel spike** (D4) — about 1 hour, on a throwaway branch, using Chrome for Testing and the fake backend
(5.1 is built first for this).
- Check:
  - (a) `chrome.sidePanel.open({tabId})` works when triggered from the context menu, a keyboard command and a
    widget click passed through the SW;
  - (b) Web Audio plays without needing an extra click;
  - (c) audio keeps playing when switching tabs and stops when the panel closes.
- **Rule:** if (a), (b) and (c) all pass, `host:reader` becomes the side panel and the Reader tab is deleted. If any
  fail, keep the Reader tab.
- Write the result to `docs/reports/sidepanel-spike.md`.

**2.1 Convert `shared/*` to ES modules** (#16)
- Convert each `*-umd.js` file to `shared/*.js` with `// @ts-check` and JSDoc types, then delete the UMD files.
- Switch the existing tests to import the modules directly. The assertions stay the same, which proves nothing
  changed.

**2.2 `sw/session-store.js`** (TDD)
- Functions: `load()`, `begin(run)`, `update(runId, patch)`, `end(runId, outcome)` (returns a boolean) and
  `current()`.
- Calling `end` twice is safe: only the first call returns true, so each run gets exactly one final event.
- Tests:
  - begin, end, end (second end returns false);
  - the revision counter only increases;
  - a newly created store restores the saved state;
  - `end` on a run that isn't current does nothing.

**2.3 `sw/router.js`** (TDD, the core)
- Tests using fake ports cover:
  - all six ownership rules;
  - SW restart followed by `HOST_HELLO` reconciliation;
  - rejecting a second Reader;
  - replacement ordering: the old host receives `HOST_STOP` before the new host receives `HOST_SPEAK`.

**2.4 `host/engine.js` + `host/host-port.js`**
- Move the engine out of `offscreen.js` with no changes except that `emit` is passed in. The existing 20 offscreen
  tests move to `engine.test.js` and must all still pass.
- `host-port.js`:
  - connects to the SW;
  - sends a heartbeat every 20 s while a run exists;
  - on disconnect, reconnects with backoff (100 ms up to 2 s);
  - sends `HOST_HELLO{activeRun}`.
- Delete: the `pagehide` handler, the `GET_PLAYBACK_STATE` snapshot path, and the `_fromBackground`/`_fromOffscreen`
  flags.

**2.5 `sw/server-manager.js`** (#4, #19)
- One `ensureServer({waitForWarm})` function, used by SPEAK, the Start button and model loads.
  - Concurrent callers share one in-flight promise.
  - It sends `SERVER_STATE` updates: `starting`, `ready`, `warming`, `failed`.
  - A popup that's reopened immediately shows the current state.
- `LOAD_MODEL`:
  - sends the load request with a 10 s timeout;
  - if the load is still running, checks `/health` every 1 s for up to 300 s, each with a short request, and sends
    `MODEL_STATE` updates.
- The existing check that the server really is Open TTS (engine and version) is kept.
- Tests:
  - two simultaneous `ensureServer` calls produce one native `start`;
  - a popup that reconnects mid-start gets the current state.

**2.6 `ui/ui-port.js` + moving popup, content and Reader over**
- The popup renders from `SESSION`, `SERVER_STATE` and `MODEL_STATE`.
- Delete from the popup: `restorePlaybackState`, the `clientId` takeover and `playbackRevision`.
- The content script only opens its port after the first user action, not on every page load.
- Delete from the SW: `deliveredTerminals`, `recoverSession`, `hostSnapshot`, `isStaleEvent`, host
  `sendWithRetry` and `_routedByBackground`.

**2.7 Readability pass** (#16)
- New and moved code uses readable names and lines of at most 120 columns, with no packed side-effect ternaries.
- `eslint --max-warnings=0` passes on `sw/`, `host/`, `ui/`, `shared/` and `content/`.

**Checkpoint 2:**
- `npm test` exits 0.
- `grep -rn "chrome.runtime.sendMessage" extension --include=*.js | grep -v tests` finds nothing.
- The test count is at least what it was before Phase 2. The old behaviour tests were moved over, not dropped.

### Phase 3 — Types and docs · ~0.5 day

- 3.1 Add `// @ts-check` to `sw/*`, `host/*` and `ui/*`, and make `tsc` pass cleanly.
- 3.2 Update the README (architecture section and diagram) and `AGENTS.md` (new layout, `npm run test:e2e`, and the
  "Hermes implements directly" note).

### Phase 4 — UX additions · ~2 days

- **4.1 Context menu:** a "Read with Open TTS" item (`contextMenus`, selection context) makes the SW start a run from
  `info.selectionText`.
  - The run is tied to that tab, so the widget in that tab can control it.
  - This works in the PDF viewer and on sites where the widget is hidden.
- **4.2 Keyboard commands:** `read-selection` (Alt+Shift+R) and `toggle-pause` (Alt+Shift+P).
  - For `read-selection`, the SW asks the active tab's content script for the selected text.
  - If the content script can't answer (PDF viewer, restricted page), the extension icon shows a hint to use the
    context menu instead.
  - No `scripting` permission is added.
- **4.3 Hide per site:** a popup toggle "Hide widget on <host>" stores `hiddenSites` in sync storage. The content
  script checks it before creating the widget. The context menu and shortcuts still work on hidden sites.
- **4.4 Reader / side-panel polish:**
  - a progress bar and passage counter;
  - the existing retry-from-interruption;
  - reduced motion and visible keyboard focus.
- **4.5 Popup metric** (#21): replace `GEN/ACK` with "First audio: X.Xs", computed from host metrics
  (`firstAudioClockStartedAt − acceptedAt`).
- Tests:
  - a menu click starts a SPEAK tied to that tab;
  - a keyboard command with no content script shows the hint;
  - on a hidden site no widget is created.

### Phase 5 — Verification and release · ~1.5 days

**5.1 Fake backend:** `e2e/fake_backend.py`, standard-library `http.server` on **port 18765**.
- Endpoints: `/health`, `/v1/capabilities`, `/v1/models`, `/v1/load-model`, and a v2 framed
  `/v1/synthesize-stream-batch` that streams sine-wave audio.
- Settings to control the delay before the first frame, the delay between frames, an error mid-stream, and a cut-off
  stream.
- No models are involved.

**5.2 Test build:** `e2e/build-test-extension.mjs` copies `extension/` into the scratch directory.
- In the copy, it points `SERVER_URL`, `host_permissions` and the CSP `connect-src` at `127.0.0.1:18765`.
- It adds a fixed manifest `key` so the extension ID is stable.
- The production source is never modified.

**5.3 Puppeteer E2E** (`npm run test:e2e`)
- Setup:
  - Puppeteer is a dev dependency, and the test Chrome for Testing is downloaded into `~/.hermes/cache/scratch`;
  - a throwaway `--user-data-dir`;
  - regular Chrome is never used, because it no longer allows `--load-extension`.
- Scenarios:
  1. Select text → widget → speak → done.
  2. Pause and resume.
  3. Stop.
  4. Start a new run that replaces the current one.
  5. Two Readers or panels → only one plays.
  6. Close the Reader mid-run → `owner_lost`.
  7. Stop the SW mid-run via CDP `ServiceWorker.stopWorker` → the run continues and the controls still work.
  8. Close and reopen the popup while the server is starting → it shows the live state.
  9. Context menu.
  10. Keyboard commands.
  11. A hidden site.
  12. Extension reload → the "reload this page" message.
  13. The token is absent from `storage.local`.
- Every scenario checks:
  - there are no console errors;
  - the network log shows only `127.0.0.1:18765`;
  - screenshots are saved to `.artifacts/e2e/` (gitignored), and I review them visually myself.
- **Finding #1 via session restore:** reopen a closed Reader tab and confirm it doesn't start a second playback.

**5.4 Real checks, authorized only.** These run only when David gives the go-ahead at that time, per the lifecycle
guard.
- Listen to Kokoro with short and long text.
- Measure the first-audio time for 600 characters with Qwen (this confirms the 1.7 threshold).
- Pause and resume across a sleep/wake.
- Confirm that Memory Saver no longer discards the Reader.

**5.5 Release**
- Set the version to 4.0.0 in `manifest.json` and `package.json`.
- Update CHANGELOG and PRIVACY.md (session-only token, history off and capped, context menu and commands).
- Run `npm run package:extension` and check that the zip contains no `tests/` or `e2e/` files.
- Final gate: `npm test && npm run test:e2e` both exit 0, plus a `git status --short` review.
- Hand the branch to David. **No push or merge without his OK.**

---

## Checkpoints

| Checkpoint | After | What David gets |
|---|---|---|
| A | Phase 0 + 1 | The bug fixes, test evidence and a diff summary |
| B | Phase 2 + 3 | The rewrite summary, the side-panel spike result, the list of deleted code and test counts |
| C | Phase 4 + 5.1–5.3 | The E2E report with screenshots, and a request for a window to run the real-model checks (5.4) |
| D | 5.4 + 5.5 | The 4.0.0 zip, the changelog, and a request for OK to push/merge |

Work continues through each checkpoint without waiting, unless verification fails in a way that needs David's input
or scope would expand. Only 5.4 (real models and audio) and push/merge need explicit approval.

**Estimated effort:** about 9.5 working days of focused work. This is an estimate; the Phase 2 router and the E2E
harness are the least predictable parts.
