# NOTES — stream P0 (Phase 0 + shared ESM foundation)

Branch `v4-p0`. `npm test` (lint → typecheck → vitest → pytest) exits 0 at every commit.
Final counts: **vitest 19 files / 211 tests**, **pytest 116 passed**. Baseline before P0: 11 files / 101 tests.

## Commits

| Commit | Task |
|---|---|
| `a86ed95` | v4(P0): remove dead ES module duplicates, routes and helpers (plan 0.1 + 0.2) |
| `e06b991` | v4(P0): add eslint and tsc gates (plan 0.3) |
| `a619bad` | v4(P0): version-sync test (plan 0.4) |
| `a28db36` | v4(P0): untrack tool scratch and artifacts (plan 0.5) |
| `9b1c9bc` | v4(P0): shared ESM modules |
| `3d88efc` | v4(P0): shared fake chrome test helper |
| (this)    | v4(P0): NOTES-P0 |

## What was done

1. **Dead code**: removed the old `shared/{protocol,constants,storage}.js`. Removed the `ENSURE_SERVER`,
   `ENSURE_OFFSCREEN` and `GET_VOICES` routes (tests check each one returns `Unknown message type: X`), the content
   `STOP_TTS` branch, popup `addHistory`/`pendingHistory`, `consumePlaybackStream`, `speakStatus`, and
   `CHUNK_TARGET`/`FIRST_CHUNK_TARGET`/`FALLBACK_WINDOW`. The two v3 background tests that used `ENSURE_OFFSCREEN`
   (creation errors and single-flight) now go through `SPEAK` and check the same behaviour.
   The background `STOP_TTS` → `STOP` alias stays because the v3 popup still sends `STOP_TTS`. It goes away when v3
   is deleted.
2. **Tooling**: added the dev dependencies `eslint@10`, `@eslint/js@10`, `globals@17`, `typescript@7`,
   `@types/chrome` and committed the lockfile. Also:
   - `eslint.config.js` (flat config) and `tsconfig.json` as specified.
   - `package.json` now has `"type": "module"`, so the ESM `eslint.config.js` loads without a warning.
   - New scripts `lint`, `typecheck` and `test`. The old scripts are kept.
   - `vitest.config.js` excludes `e2e/**`.
   - Legacy override block: covers the v3 files and v3 tests. It declares the `OpenTTS*` UMD globals and
     service-worker globals, and allows empty `catch` blocks, unused caught errors and unused rest siblings.
   - Real lint errors in v3 files were fixed rather than relaxed: unused `unwrap`, dead `esc()`, an unused `m`, an
     unused `catch (e)`, and unused test imports/helpers.
3. **Version sync**: `extension/tests/version-sync.test.js` checks that every `v<semver>` in
   `extension/**/*.{js,css,html}` (tests excluded) equals `manifest.version`. It also checks that no `popup.html`
   anywhere under `extension/` contains a version. Fixed `content.css` (was v3.0) and `popup.html` (the version
   span is now empty; `popup.js` already fills it from `getManifest()`).
4. **Hygiene**: ran `git rm -r --cached` on `.hermes/plans`, `graphify-out`, `run-graphify.py` and `artifacts/`,
   and added them plus `.artifacts/` to `.gitignore`. The files are still on disk. `artifacts/` was untracked
   because no README/docs reference `artifacts/*.json`; only the plan's own instructions mention the directory.
   `scripts/model-matrix.py` writes `artifacts/model-matrix.json`, which is now ignored.
5. **Shared ESM**: `extension/shared/{constants,protocol,stream-decoder,playback,playback-session,storage}.js`, all
   `// @ts-check` with JSDoc, and `tsc` is clean. Tests: `extension/tests/shared-*.test.js` port the UMD
   assertions, and parity tests compare against the UMD code (constants values, `splitText`/`sentenceUnits`
   output). The UMD files and their tests are kept.
6. **Fake chrome**: `extension/tests/helpers/fake-chrome.js`, tested by `extension/tests/fake-chrome.test.js`
   (29 tests). The JSDoc at the top of the file has a usage example and lists the semantics.

## Deviations / additions to the contract (please review)

- **`storage.js` adds `localInstruction()`**, a port of the v3 migration from `storage.sync.instruct` to
  `storage.local` (the local copy is verified before the sync copy is removed). The contract API doesn't list it,
  but the synced-instruction privacy migration needs a home. `sw/settings.js` (A) or the popup (C) can use it.
  Nothing else changed shape.
- **`flushPending()`** writes all pending values with one `set` per storage area. It never rejects: failures go
  to the `setStorageErrorHandler` handler, or `console.error` if none is set. This is so it's safe to call from
  `pagehide`. Stream C owns "add `flushPending` only", but P0 already added it as instructed, so **C shouldn't
  need to touch `storage.js`**.
- **`protocol.js`** exports only `makeRunId`, `parseApiErrorBody`, `describeFetchError` and `interpretHealth`.
  `makeRunId()` now returns `crypto.randomUUID()` instead of `r_<ts>_<rand>`, as the contract requires.
- **`playback.js`** doesn't export the v3 `norm` alias; use `normalizeText`.
- **`constants.js`**: `SERVER_URL` is a single line, `export const SERVER_URL = "http://127.0.0.1:8000";`, so the
  E2E build can rewrite it with a simple text replacement.
- **Fake chrome shape**: `createPortPair(name, sender)` returns `{ client, server }`. `server.sender` is the
  sender you pass in and `client.sender` is undefined, as in Chrome. Test-only controls are on `chrome.fake`:
  - `connect(name, sender)` connects with a custom sender.
  - `failNext(api, message)` makes the next call to that API fail.
  - `sendRuntimeMessage(msg, sender)` delivers a one-shot message, for content-script tests.
  - Also available: `serverPorts`, `clientPorts`, `storageData`, `tabs`, `contexts`, `menus`, `addTab()` and
    `log`.

  Every API is a spy with `.calls`. Scripting is done by replacing `.impl`. This is how "scriptable via handler
  functions" is implemented: `chrome.runtime.sendNativeMessage.impl = (host, msg) => …` and
  `chrome.tabs.sendMessage.impl = (tabId, msg, opts) => …`.

## For Hermes to apply elsewhere (files P0 doesn't own)

- **`.github/workflows/ci.yml`**: the extension job runs only `npm run test:js`. Add `npm run lint` and
  `npm run typecheck`. eslint 10 needs Node `^20.19 || ^22.13 || >=24`, and the job pins `node-version: "20"`.
  Bump it to `"22"`, or check that 20 resolves to ≥ 20.19.
- **At integration, when v3 is deleted**:
  - Remove the `LEGACY_V3_FILES` block from `eslint.config.js` and the legacy entries from `tsconfig.json`
    `exclude`.
  - Delete the v3 tests (`background`, `constants`, `content`, `offscreen`, `pipeline-harness`, `playback`,
    `popup-lifecycle`, `popup`, `progressive`, `protocol`, `storage`, `stream-decoder`).
  - `shared-stream-decoder.test.js` imports `frame`/`audioFrame` from `pipeline-harness.js`, so move those two
    helpers into `tests/helpers/`.
  - The parity tests in `shared-constants.test.js` and `shared-playback.test.js` read the `*-umd.js` files. Drop
    those two `it` blocks along with the UMD files.
- **Version sync vs manifest bump**: when A bumps `manifest.json` to 4.0.0, `version-sync.test.js` will flag the
  v3 headers (`// Open TTS v3.5.0` in `background.js`, `content.js`, `popup.js` and `content.css`) until those
  files are deleted. Delete v3 in the same integration step, or update those headers. New v4 files must either
  carry no `v<semver>` string or carry the manifest version. The root `package.json` `version` (3.5.0) is not
  checked. Consider bumping it to 4.0.0 at release.
- `backend/venv` and `backend/models` show as untracked in worktrees because they are symlinks. The
  `.gitignore` patterns `venv/` and `models/` only match directories. This is harmless and I left it alone.
