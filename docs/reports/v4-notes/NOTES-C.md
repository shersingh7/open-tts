# NOTES — stream C (UIs: ui-port, popup, content script)

Branch `v4-c`, base includes P0 (`extension/shared/*.js` ESM + `tests/helpers/fake-chrome.js`) and BE.
`npm test` (lint → typecheck → vitest → pytest) exits 0 at every commit.
Final counts: **vitest 23 files / 247 tests** (was 21/220 after P0), **pytest 134 passed** (unchanged, BE's
scope). New tests added by this stream: 9 (`ui-port`) + 16 (`ui-popup`) + 1 (`content-messages`) +
10 (`content-behaviour`) = **36**.

## Commits

| Commit | Task |
|---|---|
| `19ae274` | v4(C): ui-port.js — port client with request/reply and reconnect |
| `155e3a8` | v4(C): popup — port-driven rewrite (no auto LOAD_MODEL, bounded history, hide-per-site, first-audio metric) |
| `74622fb` | v4(C): content script — closed-shadow widget on ui:content port |
| (this) | v4(C): NOTES-C |

## What was done

1. **`extension/ui/ui-port.js`** — `connectUi({name, onSnapshot, connect})` per contract: opens
   `chrome.runtime.connect({name})`, delivers every non-`REPLY` message to `onSnapshot`, and resolves/rejects
   `request(cmd)` against `{type:"REPLY", requestId, ok, data|error, code}`. Default request timeout 15 s,
   330 s for `LOAD_MODEL` (checked via `cmd.type`). Reconnects immediately on `onDisconnect` (SW restart) and
   keeps calling `open()` until `close()` is called; in-flight requests are rejected on disconnect (they were
   never answered) rather than silently hung. `close()` disconnects and stops any further reconnects.

2. **`extension/ui/popup.{html,js,css}`** — full port-driven rewrite. Visual design/CSS carried over from the
   v3 popup (same chassis/LCD "Volume Booster Pro" tokens, control IDs mostly unchanged) with two additions:
   a "Hide widget on `<host>`" toggle in the ENGINE module (hidden until a content script answers), and the
   footer replaced with a single `#firstAudioMetric` span (removed `GEN:`/`ACK:`).
   - `popup.js` exports `init({doc, win, chromeApi} = {})` with all three defaulting to the real globals; the
     bottom of the file does `if (typeof document !== "undefined") init()...` so importing the module under
     Node (vitest, no DOM) never auto-runs it — tests call `init()` with fakes instead. This was necessary
     because there's no jsdom/happy-dom dependency in this repo and adding one wasn't in this stream's remit;
     the fake-DOM-element approach mirrors how the v3 tests already faked `document`.
   - Renders only from `SESSION` / `SERVER_STATE` / `MODEL_STATE` snapshots delivered via `ui-port`. Never
     sends `LOAD_MODEL` on open — only `GET_MODELS`. When a model isn't loaded, `modelMeta` reads
     "`<name>` — loads on first Speak"; `LOAD_MODEL` fires only from the model `<select>`'s `change` handler.
   - History: `historyEnabled` checkbox reflects `data.historyEnabled === true` (unset/false ⇒ unchecked ⇒
     off, matching D1). Truncated entries get a `(first 2,000 chars)` label; replay re-sends the *stored*
     (already-capped) text, not the original.
   - Speed: `input` updates the label and calls `debouncedSyncSet`; `change` calls `syncSet` directly (fires
     once, at drag-end, matching the plan's "saved immediately on change"). `flushPending()` is wired to both
     `win.addEventListener("pagehide", …)` and `doc.addEventListener("visibilitychange", …)` (checking
     `doc.visibilityState === "hidden"`), so a debounced `input` write that hasn't hit 300 ms yet still lands
     if the popup closes mid-drag.
   - Hide-per-site: queries the active tab (`tabs.query({active:true, currentWindow:true})`), does a one-shot
     `tabs.sendMessage(tab.id, {type: CONTENT_GET_HOST})`; on success shows the toggle and seeds it from
     `storage.sync.hiddenSites`; on any rejection (no content script — chrome://, PDF viewer, etc.) the row
     stays hidden (its default markup state).
   - First-audio metric: `First audio: ${((firstAudioClockStartedAt - acceptedAt)/1000).toFixed(1)}s"` when
     `session.metrics` has both fields; blank otherwise.
   - Pause/Stop are disabled unless `message.controllable && session.state !== "idle"`; Speak is disabled only
     while `session.state === "preparing"` (a new run always supersedes, per router rule 1).

3. **`extension/content/content.js`** — classic, self-contained script (no imports), per contract. Widget is
   `<open-tts-widget>` on `document.documentElement` with a **closed** shadow root and its CSS inlined as a
   `<style>` (no `content.css`, matches the "CSS inlined in shadow root" contract line — the old `content.css`
   stays as a v3 file, deleted by Hermes at integration along with the rest of v3).
   - Local `MSG` mirror covers exactly the 8 keys this file uses (`SPEAK, PAUSE, RESUME, STOP, SESSION, REPLY,
     CONTENT_GET_SELECTION, CONTENT_GET_HOST`); `tests/content-messages.test.js` parses the literal object out
     of the source and asserts each value equals `shared/messages.js`.
   - `ui:content` port opens lazily — only on the first Speak/Pause/Stop/Read-selection click, never on load or
     on a bare mouseup/selection. On disconnect it resets to a local idle view and does **not** auto-reconnect;
     the next user action calls `chrome.runtime.connect` again.
   - Widget has three display modes (`hidden` / `expanded` / `collapsed`, tracked in `host.dataset.state`):
     a new selection always shows `expanded` near the selection; an outside `mousedown` goes to `collapsed`
     (not hidden) while a run this port controls is active, or to `hidden` when idle — this is the structural
     fix for v3 finding #11 ("any click hides Stop").
   - "Read selection" appears when the widget is active-and-controllable *and* the live selection's first 200
     chars differ from `session.textPreview`; clicking it starts a new run with the new selection (superseding
     the old one, same as any other SPEAK).
   - Since content.js has no configuration UI, `SPEAK` is sent with **no `settings` field** — it relies on the
     contract's "if omitted SW resolves from storage" behaviour (`sw/settings.js`, stream A). This is simpler
     than v3 (which read `voice/speed/language/model/instruct` from storage itself before every SPEAK) and
     avoids duplicating `resolveVoice`/`resolveSpeed`/`MODEL_VOICES` in a file that can't import
     `shared/constants.js`.
   - `CONTENT_GET_SELECTION` replies `{text}` from any frame; `CONTENT_GET_HOST` replies `{host}` only when
     `window.top === window` (wrapped in try/catch for cross-origin frames, which throw on `window.top` access
     and are treated as non-top).
   - Error text matching `/context invalidated|Receiving end does not exist|Extension context/i` is shown as
     "Open TTS was updated — reload this page".
   - No `MutationObserver`: a single `removeLegacy()` call at load removes any leftover `#qwen-tts-icon-container`
     (v2) element (finding #10 fix).
   - Never touches `document.body` — the widget's host element and shadow root are attached under
     `document.documentElement`, and the script returns immediately if `document.documentElement` is absent.

## Tests

- `extension/tests/ui-port.test.js` (9): snapshot delivery ordering, `send()` shape, `request()` resolve/reject
  from a REPLY, default vs. `LOAD_MODEL` timeout (via `vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]})`
  so the fake-chrome microtask delivery keeps working), reconnect-and-re-render, in-flight requests rejected on
  disconnect, `close()` stops reconnecting.
- `extension/tests/ui-popup.test.js` (16): no `LOAD_MODEL` on open / only on explicit change, "loads on first
  Speak" label, history default-off / explicit-on, truncated label, replay plays the stored slice, controls
  disabled/enabled by `controllable`, first-audio formatting (present and absent), reconnect re-render,
  `flushPending` on `pagehide` and on `visibilitychange→hidden`, hide-site toggle hidden/shown.
- `extension/tests/content-messages.test.js` (1): MSG mirror equality.
- `extension/tests/content-behaviour.test.js` (10): lazy port (no connect until Speak), port connects on
  Speak, `CONTENT_GET_SELECTION` reply, `CONTENT_GET_HOST` top-frame-only, Read-selection path, collapse (not
  hide) during an active run, hide (not collapse) when idle, error mapping, hidden-site ⇒ no widget, no-body
  page doesn't throw.

## Deviations / things Hermes should check

- **Manifest `all_frames`**: the contract's "Manifest (owned by A)" excerpt doesn't set `all_frames` on the
  `content_scripts` entry, which defaults to `false` (top frame only) — but the contract's content-script
  section says content.js "Must work in frames," and my `CONTENT_GET_HOST` top-frame check only makes sense if
  the script *can* run in subframes. Please add `"all_frames": true` to the content_scripts entry (or confirm
  it's intentional that frames never get the widget, in which case my top-frame guard is dead code and the
  "must work in frames" line just means "must not throw if it somehow runs in a frame").
- **`storage.js` `flushPending`**: P0 already added it (per `docs/reports/v4-notes/NOTES-P0.md`); I did not
  touch `extension/shared/storage.js`, per my ownership row.
- **Popup's `SPEAK` settings**: always sent (popup has full controls, so it always knows model/voice/speed/
  language/instruct) — this matches the contract's "if omitted SW resolves from storage" as the *content
  script's* path, not the popup's.
- **No jsdom/happy-dom dependency added.** Both `popup.js` (import-based, tested via dependency-injected
  `{doc, win, chromeApi}` and hand-built fake DOM elements) and `content.js` (classic script, tested via
  `vm.runInContext` like the v3 tests) avoid needing a real DOM in vitest. `popup.js`'s exported `init()` is
  the only concession to testability beyond the contract's stated shape; production behaviour (auto-running on
  real `document`) is unchanged.
- **`content/content.js` has no `// @ts-check`** — it's a classic script excluded from `tsconfig.json`'s
  default type-checked set only implicitly (it was never added to the `exclude` list because `tsconfig.json`'s
  `include` is `extension/**/*.js` and `checkJs` is project-wide `false`; only files that opt in with
  `// @ts-check` get checked). I left it unchecked deliberately — the file has no imports to type against and
  adding full JSDoc types for a closed-shadow DOM widget seemed like low-value churn for this pass; happy to
  add it later if Hermes wants full JS-parity in Phase 3 (3.1 "Add `// @ts-check` to `sw/*`, `host/*` and
  `ui/*`" doesn't list `content/`, so this matches the plan's own scoping).
- **`ui/popup.css`** carries the exact same design tokens as v3's `extension/popup.css` (chassis/LCD/signal
  palette) plus two small additions (`.hide-site-row`, `.history-truncated`) — no visual redesign.

## For Hermes (integration)

- At v3 deletion time: remove `extension/popup.html/js/css`, `extension/content.js`, `extension/content.css`
  and their old tests (`extension/tests/popup.test.js`, `popup-lifecycle.test.js`, `content.test.js`) per the
  contract; nothing in this stream depends on those files remaining.
- `extension/manifest.json` (owned by A) needs `"default_popup": "ui/popup.html"` and the content_scripts `js`
  array should be just `["content/content.js"]` (no `css`, no `shared/*-umd.js` — content.js no longer loads
  `storage-umd.js`/`constants-umd.js`).
