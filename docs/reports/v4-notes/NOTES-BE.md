# NOTES-BE — stream BE (wave 1)

## What was done

### Task 1.9 — DNS-rebinding defence (finding #14)
- `backend/open_tts/api.py`: `create_app(*, allowed_hosts_extra: Sequence[str] = ())` (keyword-only, default empty).
  Adds Starlette `TrustedHostMiddleware` with `allowed_hosts=["127.0.0.1", "localhost", *allowed_hosts_extra]`.
  It is added **last**, so it is the outermost middleware: a foreign Host gets `400 Invalid host header` before
  CORS, auth, rate limiting, body buffering or any model work. Everything else about the HTTP contract is unchanged.
- `backend/server.py` calls `create_app()` with no arguments (checked; a test parses server.py with `ast` and
  asserts the single `create_app` call has no args/keywords). Production allows only `127.0.0.1` / `localhost`
  (any port — Starlette strips the port before matching).
- Test call sites now opt in to TestClient's Host: `backend/tests/test_api.py` (`client` fixture) and
  `backend/tests/test_runtime_limits.py` (2 × `create_app(allowed_hosts_extra=['testserver'])`).
- New tests in `backend/tests/test_security.py` (built with the production `create_app()`):
  - `allowed_hosts_extra` is keyword-only, default `()`; server.py passes nothing extra;
  - `Host: 127.0.0.1[:8000]` and `localhost[:8000]` → `/health` 200;
  - `Host: evil.example` → 400 on `/health`, `/v1/models`, `/v1/voices`, `/v1/capabilities`;
  - rebinding-style request (`Host: attacker.example:8000`, no Origin, loopback client) → 400 on `/v1/models`
    and `/v1/voices`, while the genuine local CLI path (loopback Host, no Origin) still returns 200;
  - foreign-Host POST `/v1/load-model` → 400 (rejected before model work);
  - `testserver` is rejected by the production app and accepted only when passed explicitly.
  - Red-first verified: 9 of these failed before the middleware was added.

### Native host `status` → `install_token` (for `sw/auth.js`)
Read `backend/native_host.py`; behaviour already matches the contract. No code change; added characterization
tests in `backend/tests/test_security.py` driving `native_host.main()` over fake stdin/stdout with a dummy token in
a tmp token file (the real `backend/.open_tts_token` was never read).

**`{command: "status"}` response** (native messaging JSON, field names only):

| field | type |
|---|---|
| `success` | boolean (`true` for a handled status) |
| `message` | string (human text, e.g. running / starting / not running) |
| `running` | boolean |
| `port_active` | boolean |
| `pid` | number \| null |
| `install_token` | string \| null |
| `engine` | string \| null (from `/health`, `"open-tts"` when reachable) |

`install_token` is the stripped contents of `$OPEN_TTS_RUNTIME_DIR/.open_tts_token` (default `backend/`), and is
`null` when `running` is false **or** the token file is missing/empty/unreadable.

Other shapes `sw/auth.js` / `sw/server-manager.js` must tolerate:
- `{command: "start"}` → `{success, message, install_token}` (`install_token` may be `null` on a very first start
  because the server writes the token file during startup).
- Failures (unknown command, exception, "Another native host instance is active") → `{success: false, message}`
  with **no** `install_token` key.

## Commits (branch `v4-be`)
- `fa01161` v4(BE): DNS-rebinding defence via TrustedHostMiddleware (#14)
- `9fc50d8` v4(BE): pin native host status install_token response shape
- (this file) v4(BE): NOTES-BE summary

## Test counts
- Backend (`npm run test:backend`): 133 passed (baseline 116; +17 new).
- JS (`npm run test:js`): 101 passed (unchanged).
- `npm test` exit 0 before every commit.

## Deviations from the contract
- Ownership: besides the three owned files I edited `backend/tests/test_api.py` and
  `backend/tests/test_runtime_limits.py` (one-line fixture changes only), as explicitly authorised by the task
  ("backend/tests/** is yours for this").
- `security.py` unchanged: the review found no additional real bug (see below), so nothing was fixed there.

## security.py review (origin/token logic)
- The no-Origin + loopback-client token bypass (`security.py`, `AuthAndRateLimitMiddleware.dispatch`) is the hole
  #14 exploited; it is now only reachable with a loopback Host header, so rebinding can no longer use it. The CLI
  convenience is intentionally preserved.
- Browser POSTs always carry `Origin`, so they hit the token check (401 without a valid token). A web page's
  `no-cors` GET to `127.0.0.1:8000` does skip the token but yields an opaque response, and every `/v1/*` GET is
  read-only — no leak, no side effect.
- `"testclient"` in the loopback client set is test-only; uvicorn always reports a real IP, so it is harmless.
- FastAPI's default `/docs`, `/redoc`, `/openapi.json` are unauthenticated but are now Host-protected too.

## For Hermes to apply elsewhere
1. **sw/auth.js (stream A)**: treat `install_token: null` (or a missing key when `success === false`) as "no token
   yet" — do not store it; retry `status` after `ensureServer` reports `ready`. Only store non-empty strings.
2. **native_host.py (not owned; small real inconsistency)**: `native_host.RUNTIME_DIR` is
   `Path(os.getenv("OPEN_TTS_RUNTIME_DIR", ...))` while `open_tts/config.py` uses `.expanduser().resolve()`.
   With `OPEN_TTS_RUNTIME_DIR=~/something` or a relative path, the native host reads a different token file than
   the server writes, so `install_token` is `null`/stale and the extension gets 401s. Suggested fix: add
   `.expanduser().resolve()` in `native_host.py` (and a test next to the ones in `test_native_host.py`).
3. **E2E (stream E2E)**: if the fake backend reuses `create_app`, Host `127.0.0.1:18765` / `localhost:18765` are
   accepted (port is ignored). Any other hostname (e.g. a Docker service name) needs `allowed_hosts_extra`.
4. **IPv6 / non-loopback binds**: `Host: [::1]:8000` is rejected (Starlette splits on the first `:`). The server
   binds `127.0.0.1` by default so this is moot; if `OPEN_TTS_HOST` is ever changed, clients must still use
   `127.0.0.1`/`localhost` as the Host name. The manifest's `host_permissions` already uses `127.0.0.1`.
