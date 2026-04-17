# Open TTS Deep Performance Plan — 1000-Word Paragraphs in <60s

## Goal

Make Open TTS handle a 1000-word (~6000 char) paragraph in under 60 seconds end-to-end,
with audio starting to play within 5 seconds of clicking "Speak".

Current baseline: ~5.4s for 3 sentences (~150 chars). Extrapolated linear: 6000 chars = ~215s.
Our target: <60s total, first audio in <5s.

## Current State — Where the Time Goes

For a 6000-char text at current RTF 2.4x:

1. **Model generation**: Pure inference is ~2.4s per second of audio. 6000 chars ≈ 1000s of speech → 400s of inference. This is the bottleneck — we can't change the model speed.
2. **Chunking overhead**: content.js splits into 1200-char chunks → 5 chunks. Each chunk is a separate HTTP round-trip through background.js → server.py. Currently sequential-ish (1 prefetch ahead).
3. **Server serialization**: model.generate() is single-threaded on GPU. Only one request can use the model at a time. Chunks are processed one after another, so 5 chunks × 80s ≈ 400s.
4. **Audio encoding**: ffmpeg subprocess for opus encoding adds ~70-80ms per chunk. Negligible.
5. **Base64 transfer**: response.blob() → FileReader.readAsDataURL → chrome.runtime.sendMessage. Opus is small (230KB for 12s), so this is fast.

**The hard truth**: With RTF 2.4x, generating 1000s of audio takes ~400s. No amount of
infrastructure optimization changes model physics. BUT we can make it *feel* instant by
streaming audio to the user while the rest generates in the background.

## Strategy: Stream-First Architecture

The key insight: **Don't make the user wait for all chunks to finish. Start playing
chunk 1 while chunks 2-5 generate in the background.** If we can overlap playback with
generation, the perceived latency drops to the first chunk's generation time (~5s).

Additionally, the model's built-in `stream=True` mode can start decoding audio sub-chunks
while the LLM is still generating tokens — we can send partial audio to the browser
before the full chunk is done.

## Proposed Approach

Three layers of parallelism:

1. **Intra-chunk streaming** (server → extension): Use the model's `stream=True` mode
   to send audio segments as they're generated, before the full chunk completes.
2. **Inter-chunk pipelining** (extension-side): Generate chunk N+1 while chunk N plays.
   The content.js AudioBufferQueue already does this with PREFETCH_COUNT=2, but the
   server blocks the event loop per chunk — we need true background generation.
3. **WAV fast-path for streaming**: Skip ffmpeg subprocess entirely for streaming chunks.
   Send raw PCM/WAV data URLs for sub-second latency. The HTMLAudioElement plays WAV
   just fine. Only encode to Opus for the final non-streaming response.

## Step-by-Step Plan

### Step 1: True streaming endpoint — server sends audio as it generates

**File**: `backend/server.py`

The current `/v1/synthesize/stream` implementation collects 2s of audio, encodes to opus,
then yields. This is still batch-within-a-stream. Instead:

- Switch to the model's native `stream=True` + `streaming_interval=1.0`
- For each `GenerationResult` yielded by the model, immediately encode to WAV
  (4ms, no ffmpeg needed) and yield as a separate HTTP chunk
- Set `Transfer-Encoding: chunked` via `StreamingResponse`
- Add `Content-Type: audio/x-wav-multi` or use a simple framing protocol:
  each chunk prefixed with 4-byte length + 4-byte sample rate

**Why WAV for streaming**: ffmpeg subprocess takes 70ms to encode opus. WAV via
`soundfile.write()` to BytesIO takes 4ms. For streaming sub-1s audio segments,
that 66ms difference compounds. The browser can play WAV data URLs natively.

Actually, simpler approach: **send each GenerationResult's audio as a separate
complete WAV file in the stream**. Content.js concatenates them for playback.
Each WAV is independently playable.

### Step 2: Content.js streaming playback — play audio as chunks arrive

**File**: `extension/content.js`

Current flow: request full chunk → wait → play → request next.
New flow: request streaming chunk → play partial audio as it arrives → prefetch next chunk.

Implementation:
- Add `requestStreamingAudio()` that uses `fetch()` with `response.body.getReader()`
  to read the streaming response incrementally
- As each WAV segment arrives, append to a playing queue
- Use `AudioContext` + `AudioBufferSourceNode` for gapless concatenation
  (or simpler: queue HTMLAudioElement for each WAV segment, start next on `onended`)
- Keep existing non-streaming path as fallback

### Step 3: Increase PREFETCH_COUNT to 3 and overlap generation with playback

**File**: `extension/content.js`

Current: PREFETCH_COUNT=2, but only 1 chunk ahead because server is serial.
With streaming (Step 1+2), the server can start generating the next chunk while
the current one streams. Increase to 3 and ensure true pipelining:

- When chunk N starts playing, immediately fire request for chunk N+PREFETCH_COUNT
- The server queues these requests; since generation is in `asyncio.to_thread`,
  the next thread starts as soon as the current one yields

### Step 4: Server-side request queuing — concurrent generation slots

**File**: `backend/server.py`

Problem: `asyncio.to_thread(model.generate, ...)` for chunk 1 blocks the thread pool.
Chunk 2's request waits until chunk 1's thread completes.

Fix: Use a `asyncio.Semaphore(1)` around model access (GPU is single-threaded),
but return immediately with a "generating" status + chunk index. The extension
polls or uses SSE to get results.

Better approach: **Sequential but non-blocking queue**:
- Add a `GenerationQueue` that holds pending requests
- A single background worker pulls from the queue and runs `model.generate()`
- When a request completes, its `asyncio.Future` resolves
- The HTTP handler `await`s the future — doesn't block other HTTP handlers
- Multiple extension chunks can all be queued; they execute sequentially on GPU
  but the HTTP layer is fully async

### Step 5: Optimize audio encoding — skip ffmpeg for WAV fast-path

**File**: `backend/server.py`

Current: `audio_write(buffer, audio, sr, format="opus")` spawns ffmpeg subprocess.
Even for non-streaming, we can speed this up:

- Use `soundfile.write()` directly for WAV (4ms vs ffmpeg's 70ms)
- Add `OPUS_BITRATE` env var, default to "64k" (vs current "128k") for TTS:
  speech at 64k opus is indistinguishable from 128k, and encodes faster
- For the streaming path, always use WAV — no subprocess at all
- Only use opus for the final/non-streaming response

### Step 6: Smarter chunk splitting — paragraph-aware

**File**: `extension/content.js`

Current `splitTextForTTS` splits on sentence boundaries at 1200 chars.
For 6000 chars, this creates 5 chunks. The model itself also splits on `\n`.

Problem: If a chunk ends mid-sentence, the model may produce unnatural pauses
or incomplete prosody.

Improvement:
- Prioritize paragraph boundaries (`\n\n`) over sentence boundaries
- Increase CHUNK_TARGET_CHARS to 2000 (still well within model's 4096 token limit)
- 6000 chars → 3 chunks instead of 5
- Fewer chunks = fewer round-trips = less overhead
- Each chunk is more coherent → better audio quality

### Step 7: Drop base64 — use Object URLs instead of data URLs

**File**: `extension/background.js`, `extension/content.js`

Current: `FileReader.readAsDataURL(blob)` creates a base64 string, 
then `new Audio(dataUrl)` decodes it back. This is a 33% size overhead
(780KB base64 for 585KB WAV, 325KB for 243KB opus) plus encode/decode CPU.

Fix: Use `URL.createObjectURL(blob)` instead. This creates a lightweight
reference to the blob in memory — no base64 encoding, no 33% overhead,
faster to create, faster for the Audio element to decode.

Change in background.js:
```js
// OLD:
const blob = await response.blob();
const reader = new FileReader();
reader.readAsDataURL(blob);
reader.onloadend = () => sendResponse({ success: true, audioData: reader.result });

// NEW:
const blob = await response.blob();
const objectUrl = URL.createObjectURL(blob);
sendResponse({ success: true, audioData: objectUrl });
```

Change in content.js:
```js
// After playing, revoke to free memory:
URL.revokeObjectURL(audioData);
```

### Step 8: Persistent HTTP connection — avoid TCP握手 per chunk

**File**: `extension/background.js`

Each `fetch()` to the server creates a new TCP connection (Chrome extensions
don't reuse connections reliably across message handlers). For 5 chunks,
that's 5 connection setups.

Fix: Use a single long-lived `fetch()` for all chunks via the streaming endpoint,
or at minimum set `Connection: keep-alive` explicitly. The server already has
`timeout_keep_alive=75`.

## Files to Change

| File | Changes |
|------|---------|
| `backend/server.py` | GenerationQueue, WAV fast-path streaming, opus bitrate config, generation worker |
| `extension/content.js` | Streaming playback, Object URLs, chunk size 2000, PREFETCH 3, paragraph-aware splitting |
| `extension/background.js` | Object URLs instead of base64, streaming fetch support |

## Expected Speedup

| Text Length | Before | After | Why |
|-------------|--------|-------|-----|
| 150 chars (3 sentences) | 5.4s | 3-4s | Object URLs, no base64, WAV fast-path |
| 2000 chars (1 chunk) | ~15s | ~12s | Same — generation-bound |
| 6000 chars (1000 words) | ~215s sequential | **~5s to first audio, ~200s total** | Streaming + pipelining: user hears audio in 5s |
| 6000 chars perceived | Wait 215s | Wait 5s then listen | Playback overlaps generation |

The total generation time doesn't change (model physics), but the user starts
listening in ~5s instead of waiting for the entire pipeline.

## Risks & Tradeoffs

1. **WAV streaming = larger payloads**: 300KB WAV vs 100KB opus per chunk.
   Acceptable for local/localhost — network is not the bottleneck.
   Could do opus streaming if we pre-warm the ffmpeg process (keep it alive
   as a subprocess, pipe PCM in and opus out).

2. **Object URLs and memory**: Need to `URL.revokeObjectURL()` after playback
   to avoid memory leaks. Simple to implement but must be careful with
   edge cases (user stops, pauses, navigates away).

3. **Streaming Audio concatenation**: Playing multiple short WAV segments
   back-to-back may have tiny gaps (1-5ms). Using Web Audio API's
   `AudioBufferSourceNode` with precise scheduling eliminates this, but
   is more complex than HTMLAudioElement. Worth it for seamless playback.

4. **GenerationQueue complexity**: Adds async coordination to the server.
   The simple `asyncio.to_thread()` approach works for single requests but
   fails for concurrent chunks. The queue pattern is well-tested but adds
   ~100 lines of code.

## Open Questions

1. Should we use Web Audio API (gapless, more complex) or stick with
   HTMLAudioElement (simple, tiny gaps between segments)?
2. Should we keep the opus-encoding subprocess persistent (ffmpeg -re) for
   streaming, or accept WAV bandwidth for local use?
3. Is there a smaller/faster Qwen3-TTS variant (0.6B) that would cut RTF
   from 2.4x to ~1.2x? That would halve ALL generation times.

## Verification

After implementation:
1. `curl` test: `time curl -X POST http://localhost:8000/v1/synthesize -d '{"text":"Hello","voice":"ryan","stream":true}' --no-buffer | head -c 1000` — should receive first bytes in <2s
2. Extension test: Select 1000 words → click Speak → audio should start within 5s
3. Memory test: Play 5 chunks → verify Object URLs are revoked after playback
4. Gap test: Listen for audible gaps between streaming segments