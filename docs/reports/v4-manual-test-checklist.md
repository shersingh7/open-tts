# Open TTS 4.0.0 — manual real-browser test checklist

Branch `extension-v4`. Automated gates already green: `npm test` = lint (0 warnings) + typecheck + 384 JS tests +
134 backend tests. Everything below is real-Chrome behaviour that unit tests can't prove.

## Setup
1. Pick a quiet moment (no audio job running). `cd ~/github/open-tts && git switch extension-v4`
2. **Restart the backend** so it picks up the Host-header check (only needed for test 16; everything else works with
   the running server too): Stop/Start from the popup, or `./start-server.sh`.
3. `chrome://extensions` → Open TTS → **Reload** (same unpacked folder `~/github/open-tts/extension`, so the
   extension ID and the native-host allow-list are unchanged). Reload any tabs that were open before.
4. Keep `chrome://extensions` → Open TTS → "service worker" DevTools open to catch errors.

## Core
| # | Test | Expect |
|---|---|---|
| 1 | Select a paragraph on a normal page → widget → Speak (Kokoro) | Audio starts; widget shows Pause/Resume + Stop |
| 2 | Pause, wait 10 s, Resume; then Stop | Resumes where it paused; Stop ends immediately |
| 3 | While reading, select different text → widget offers **Read selection** | New reading replaces the old one, no overlap |
| 4 | While reading, click elsewhere on the page | Widget collapses to a small control, doesn't vanish |
| 5 | Open popup mid-reading, close it, reopen | Shows live state each time; controls work |
| 6 | Open popup with a model that isn't loaded | **Does not** start loading; says "loads on first Speak" |
| 7 | Change speed and close the popup instantly; reopen | Speed kept |
| 8 | Popup preview with Qwen3 or Fish (short text) | Plays without opening a Reader tab (or "slow to start" error after 25 s) |

## Reader (long text)
| # | Test | Expect |
|---|---|---|
| 9 | Select > 4,000 chars → Speak | Reader tab opens, progress bar + "Passage i of n" advance |
| 10 | Duplicate the Reader tab (right-click tab → Duplicate) | New tab says "Reader already open in another tab"; **only one voice** |
| 11 | Close the Reader mid-reading, then Ctrl/Cmd+Shift+T to restore it | Close → "playback page closed" error in popup; restored tab does **not** start a second synthesis |
| 12 | Switch to other tabs for a few minutes during a long read | Keeps playing (not discarded) |
| 13 | Stop in Reader, then **Retry from interrupted passage** | Continues from that passage |

## New features
| # | Test | Expect |
|---|---|---|
| 14 | Right-click a selection → **Read with Open TTS** (also try in a PDF in Chrome's viewer) | Reads it |
| 15 | Alt+Shift+R on a selection; Alt+Shift+P to pause/resume. Try Alt+Shift+R in a PDF | Works on pages; in PDF the icon shows "?" hint to use right-click |
| 16 | Popup → **Hide widget on <site>**; reload page; select text | No widget there; right-click and shortcuts still work; un-hide restores it |
| 17 | Popup footer after a reading | "First audio: X.Xs" |
| 18 | History: off by default. Turn on, finish a long reading | Entry saved, marked "(first 2,000 chars)" if long; replay works |

## Robustness / security
| # | Test | Expect |
|---|---|---|
| 19 | During a reading, `chrome://serviceworker-internals` → Stop the Open TTS worker | Audio keeps playing; popup/widget controls still work after |
| 20 | Reload the extension while a page with the widget is open, then use that widget | "Open TTS was updated — reload this page" |
| 21 | Service-worker DevTools console: `chrome.storage.local.get(null, console.log)` | No `installToken` key |
| 22 | Pages with iframes (e.g. an embedded article) — select text inside the iframe | Widget works inside the frame |
| 23 | Heavy page (Gmail/X) for a few minutes | No noticeable slowdown from the widget |
| 24 | (After backend restart) `curl -s -H 'Host: evil.example' http://127.0.0.1:8000/health` | `Invalid host header` (400); plain `curl http://127.0.0.1:8000/health` still works |

## Report back
For any failure: the test number, what happened, and any red errors from the service-worker console or the
Reader/popup DevTools (right-click → Inspect). Nothing has been pushed; `main` is untouched.
