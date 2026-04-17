# Plan: Open TTS Performance Overhaul — Full Implementation

## Baseline Measurements (M2 Pro, Qwen3-TTS 1.7B 8-bit)

| Metric | Value |
|--------|-------|
| Model load | 2.6s |
| Warmup generation | ~2s |
| Generation for 3-4 lines (12.5s audio) | **5.08s** (RTF 2.46x) |
| Audio assembly (np concatenate) | 0.1ms |
| WAV encode (soundfile) | 4ms, 585KB |
| MP3 encode (mlx_audio audio_write) | 81ms, 196KB |
| Opus encode (mlx_audio audio_write) | 71ms, 182KB |
| WAV base64 encode | 0.8ms, 780KB |
| MP3 base64 encode | 0.3ms, 261KB |
| Python process spawn | 26ms |
| ffmpeg available | Yes (8.1, Homebrew) |
| mlx_audio version | 0.4.2 |

**Calculated ideal pipeline:** ~5.5s (5s generation + 0.5s overhead)  
**Actual user experience:** ~30s  
**Wasted overhead:** ~24.5s

---

## Root Causes (by severity)

### 1. CRITICAL — `synthesize` blocks the async event loop
`async def synthesize()` calls `list(model.generate(...))` synchronously. This is CPU-bound MLX inference. For 5 seconds, the uvicorn event loop is frozen — no `/health` responses, no concurrent requests, nothing.

**Impact:** When the extension sends a `/health` preflight while a previous generation is in-flight, the health check hangs until the event loop unblocks. If it exceeds the 5s `AbortSignal.timeout`, it fails, triggering an auto-start attempt via native messaging (spawning a whole new server process), which either fails (port already bound) or causes a cascade of retries.

### 2. HIGH — Health check preflight on every TTS request
`handleTTSRequest` (background.js:194-224) runs `fetch("/health")` with a **5-second timeout** before every single synthesis. If the server is busy (see #1), this health check blocks for up to 5s, then tries `autoStartServer()` which spawns `native_host.py` as a subprocess, waits 2s, then polls `/health` every 500ms for 30s. A single failed health check can blow 37 seconds.

### 3. HIGH — WAV output is 3x larger than needed
585KB WAV vs 196KB MP3 vs 182KB Opus for 12.5s of audio. The extension converts the response blob to a base64 data URL (780KB for WAV). This inflates transfer time and memory usage in Chrome's message passing pipeline.

### 4. MEDIUM — Sequential chunk generation in content.js
The content script splits text at 500 chars, generates `MIN_BUFFER_BEFORE_PLAY=2` chunks before playback starts, and prefetches `PREFETCH_COUNT=2` ahead. For 3-4 lines (~200 chars), there's only 1 chunk — no real chunking overhead. But the 500-char threshold is too aggressive for longer texts, creating many small HTTP round trips.

### 5. MEDIUM — Voice list recalculated on every synthesize
`get_model_voices(model, model_id)` is called on lines 281, 299, 335, 360, 391 — every health check, every model list, every voice list, and every synthesis. It calls `model_obj.get_supported_speakers()` (which just returns a cached list, so this is cheap), but the `normalize_voice()` helper on line 117 creates a new list comprehension `[v.lower() for v in supported_voices]` on every single voice validation.

### 6. MEDIUM — Warmup uses max_tokens=512
The model warmup generates `max_tokens=512` worth of audio (~4s of speech) just to compile Metal kernels. `max_tokens=128` (~1s of audio) is sufficient to trigger all kernel compilation paths.

### 7. LOW — No server state caching in extension
The extension has no memory of whether the server is running. Every popup open, every content script Speak click, every model switch — all start with a `/health` check. If the server is known to be running (user clicked Start, or previous request succeeded), skip the check.

### 8. LOW — `mx.clear_cache()` every 50 tokens in generation loop
Inside `qwen3_tts.py:1136-1137`, `mx.clear_cache()` forces GPU memory reallocation mid-generation. This is in the mlx_audio library, not our code. For short texts (<50 tokens), this never triggers. For longer texts, it adds ~10-20ms micro-stalls per clear.

---

## Step-by-Step Implementation

### Step 1: Unblock the async event loop
**File:** `backend/server.py`

The generation loop is synchronous CPU-bound work. It must NOT run on the async event loop.

```python
import asyncio

def _synthesize_sync(model, gen_kwargs, model_id, request_voice, lang_code):
    """Blocking synthesize — runs in thread pool."""
    chunks = list(model.generate(**gen_kwargs))
    if not chunks:
        raise ValueError("No audio generated")
    
    sample_rate = chunks[0].sample_rate
    audio_parts = [np.asarray(chunk.audio, dtype=np.float32) for chunk in chunks]
    audio = np.concatenate(audio_parts, axis=0) if len(audio_parts) > 1 else audio_parts[0]
    
    # Encode as Opus (fast, small) with WAV fallback
    buffer = io.BytesIO()
    audio_write(buffer, audio, sample_rate, format="opus")
    buffer.seek(0)
    audio_bytes = buffer.read()
    
    first = chunks[0]
    headers = {
        "X-TTS-Engine": "open-tts",
        "X-TTS-Model": model_id,
        "X-TTS-Voice": request_voice,
        "X-TTS-Lang": lang_code or "auto",
        "X-TTS-RTF": f"{getattr(first, 'real_time_factor', 0):.3f}",
    }
    return audio_bytes, headers


@app.post("/v1/synthesize")
async def synthesize(request: SynthesizeRequest):
    model_id = request.model or DEFAULT_MODEL_ID
    
    if model_id not in MODEL_REGISTRY:
        raise HTTPException(status_code=404, detail=f"Unknown model: {model_id}")
    
    try:
        model = manager.get_or_load(model_id)
    except HTTPException:
        raise
    
    text = request.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text cannot be empty")
    
    reg = MODEL_REGISTRY.get(model_id, {})
    voices = manager.get_voices_cached(model_id)
    
    # Build generation kwargs (same as before)
    gen_kwargs = dict(
        text=text,
        speed=float(request.speed),
        verbose=False,
        max_tokens=4096,
    )
    if reg.get("has_preset_voices"):
        speaker = normalize_voice(request.voice, voices) if voices else request.voice
        gen_kwargs["voice"] = speaker
        if reg.get("supports_lang_code"):
            gen_kwargs["lang_code"] = normalize_language(request.language)
        if request.instruct and reg.get("supports_instruct"):
            gen_kwargs["instruct"] = request.instruct
    else:
        if request.voice and voices:
            if request.voice in FISH_VOICE_TAGS:
                text = f"[{request.voice}] {text}"
                gen_kwargs["text"] = text
        if request.instruct:
            gen_kwargs["instruct"] = request.instruct
    
    try:
        audio_bytes, headers = await asyncio.to_thread(
            _synthesize_sync, model, gen_kwargs, model_id, request.voice,
            gen_kwargs.get("lang_code", "auto")
        )
        return Response(
            content=audio_bytes,
            media_type="audio/ogg; codecs=opus",
            headers=headers,
        )
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
```

**Why `asyncio.to_thread` works here:** MLX releases the GIL during `mx.eval()` and Metal kernel execution. The thread pool executor lets Python schedule other coroutines while inference is running. Uvicorn with `loop="uvloop"` handles this efficiently.

**Also update the import and add audio_write:**
```python
from mlx_audio.audio_io import write as audio_write
import asyncio
```

---

### Step 2: Switch audio format to Opus
**Files:** `backend/server.py`, `extension/background.js`, `extension/content.js`, `extension/popup.js`

**Backend (server.py):**
- Use `audio_write(buffer, audio, sample_rate, format="opus")` (Step 1 already does this)
- Set `media_type="audio/ogg; codecs=opus"`
- Add `SynthesizeRequest.format` field: `str = "opus"` with acceptable values `["opus", "mp3", "wav"]`
- When `format="opus"` → `audio_write(..., format="opus")`, `media_type="audio/ogg; codecs=opus"`
- When `format="mp3"` → `audio_write(..., format="mp3")`, `media_type="audio/mpeg"`
- When `format="wav"` → `audio_write(..., format="wav")`, `media_type="audio/wav"`
- Fallback: if audio_write fails for opus/mp3 (no ffmpeg), try wav

**Extension (background.js):**
- The `handleTTSRequest` function reads the response as a blob, then converts to a data URL.
- `new Audio(dataURL)` supports `audio/ogg` data URLs in Chrome. No changes needed in the blob→dataURL conversion.
- However, need to handle the new `media_type`. The current code:
  ```js
  const blob = await response.blob();
  const reader = new FileReader();
  reader.readAsDataURL(blob);
  ```
  This works for any MIME type. The `blob` picks up the response `Content-Type` automatically. **No extension changes needed for playback.**

**Extension (popup.js):**
- Same — `new Audio(response.audioData)` works with any data URL scheme. **No changes needed.**

**Savings:** 585KB → 182KB per 12.5s audio. 780KB → 243KB in base64. Reduces Chrome message passing overhead by ~3x.

---

### Step 3: Cache voice lists in ModelManager
**File:** `backend/server.py`

```python
class ModelManager:
    def __init__(self):
        self.loaded_model = None
        self.loaded_model_id: Optional[str] = None
        self.load_error: Optional[str] = None
        self._loading = False
        self._lock_time = 0
        # NEW: cached voices
        self._cached_voices: Dict[str, List[str]] = {}
        self._voice_lower_map: Dict[str, Dict[str, str]] = {}
    
    def get_voices_cached(self, model_id: str) -> List[str]:
        """Return voices from cache, populated at load time."""
        return self._cached_voices.get(model_id, [])
    
    def get_voice_lower_map(self, model_id: str) -> Dict[str, str]:
        """Return {lowercase_name: original_name} map from cache."""
        return self._voice_lower_map.get(model_id, {})
    
    def get_or_load(self, model_id: str):
        # ... existing logic ...
        self.loaded_model = load_model(model_path)
        self.loaded_model_id = model_id
        
        # NEW: populate voice caches immediately
        voices = get_model_voices(self.loaded_model, model_id)
        self._cached_voices[model_id] = voices
        self._voice_lower_map[model_id] = {v.lower(): v for v in voices}
        
        # ... warmup ...
        
        # Clear previous model's caches
        for old_id in list(self._cached_voices.keys()):
            if old_id != model_id:
                del self._cached_voices[old_id]
                del self._voice_lower_map[old_id]
```

**Also update `normalize_voice` to use the cached map:**
```python
def normalize_voice(voice: str, supported_voices: List[str], voice_lower_map: Dict[str, str] = None) -> str:
    raw = (voice or "").strip().lower()
    normalized = VOICE_ALIASES.get(raw, raw.replace(" ", "_"))
    
    if normalized in supported_voices:
        return normalized
    
    # Use pre-built lowercase map instead of list comprehension
    if voice_lower_map and raw in voice_lower_map:
        return voice_lower_map[raw]
    
    # Fallback: linear scan (shouldn't happen with proper cache)
    for v in supported_voices:
        if v.lower() == raw:
            return v
    
    raise HTTPException(
        status_code=400,
        detail=f"Unsupported voice '{voice}'. Try one of: {', '.join(supported_voices)}",
    )
```

**Impact:** Eliminates repeated `get_model_voices()` calls and list comprehensions. Minor but clean.

---

### Step 4: Reduce warmup tokens
**File:** `backend/server.py`, line 203

Change:
```python
max_tokens=512,
```
To:
```python
max_tokens=128,
```

**Impact:** Saves ~2-3s on server startup. 128 tokens is enough to compile all Metal kernels (the compilation happens on the first matrix multiply, not on later tokens).

---

### Step 5: Cache server state in the extension
**File:** `extension/background.js`

```javascript
let serverKnownRunning = false;

// Update handleTTSRequest:
async function handleTTSRequest(request, sendResponse) {
  try {
    // Skip health preflight if we know server is running
    if (!serverKnownRunning) {
      // Quick health check with SHORT timeout (500ms, not 5s)
      const healthCheck = await fetch(`${SERVER_URL}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(500),  // 500ms, not 5000ms
      }).catch(() => null);

      if (!healthCheck || !healthCheck.ok) {
        // Server not running — try auto-start
        const startResult = await autoStartServer();
        if (!startResult.success) {
          sendResponse({
            success: false,
            error: `Failed to start server: ${startResult.error}`,
            serverDown: true,
          });
          return;
        }
        // Wait for server to be ready
        const ready = await waitForServerReady(15000);  // 15s, not 30s
        if (!ready) {
          sendResponse({
            success: false,
            error: "Server start timed out. Try starting manually.",
            serverDown: true,
          });
          return;
        }
      }
      serverKnownRunning = true;
    }

    // NOW do the actual synthesis
    const body = { ... };
    const response = await fetch(`${SERVER_URL}/v1/synthesize`, { ... });
    
    if (!response.ok) {
      // If we get connection refused, server died — reset state
      serverKnownRunning = false;
      throw new Error(...);
    }
    
    // ... rest of existing logic ...
  } catch (error) {
    serverKnownRunning = false;  // Reset on any error
    sendResponse({ success: false, error: error.message });
  }
}

// Mark server as running after successful START_SERVER
async function handleStartServer(sendResponse) {
  try {
    const response = await sendNativeMessage("start");
    if (response?.success) {
      serverKnownRunning = true;
      // ...
    }
  }
}

// Clear on STOP
async function handleStopServer(sendResponse) {
  try {
    const response = await sendNativeMessage("stop");
    if (response?.success) {
      serverKnownRunning = false;
      // ...
    }
  }
}
```

**Impact:** Eliminates the 5s health check timeout on every TTS request when server is already running. Reduces from 5s+ preflight to 0ms (cached) or 500ms (uncached with short timeout).

---

### Step 6: Add streaming support to the API
**File:** `backend/server.py`

The Qwen3-TTS model already supports `stream=True` in its `generate()` method. When streaming, it yields `GenerationResult` objects incrementally as audio chunks are ready (every ~2s of audio). We can stream these chunks to the client as they're generated.

```python
from fastapi.responses import StreamingResponse

@app.post("/v1/synthesize")
async def synthesize(request: SynthesizeRequest):
    # ... model loading and validation (same as before) ...
    
    # If client requests streaming
    if request.stream:
        return StreamingResponse(
            _generate_stream(model, gen_kwargs, model_id, request),
            media_type="audio/ogg; codecs=opus",
            headers={
                "X-TTS-Engine": "open-tts",
                "X-TTS-Model": model_id,
                "X-TTS-Voice": request.voice,
                "Transfer-Encoding": "chunked",
            },
        )
    
    # Non-streaming: existing logic via asyncio.to_thread
    audio_bytes, headers = await asyncio.to_thread(
        _synthesize_sync, model, gen_kwargs, model_id, request.voice,
        gen_kwargs.get("lang_code", "auto")
    )
    return Response(content=audio_bytes, media_type="audio/ogg; codecs=opus", headers=headers)


def _generate_stream(model, gen_kwargs, model_id, request):
    """Generator that yields Ogg/Opus audio chunks as they're generated."""
    import subprocess
    
    # Enable streaming in the model
    stream_kwargs = {**gen_kwargs, "stream": True, "streaming_interval": 2.0}
    
    # Initialize ffmpeg for streaming Opus encoding
    # We pipe raw PCM chunks to ffmpeg, it outputs Ogg/Opus frames
    sr = model.sample_rate
    ffmpeg_proc = subprocess.Popen(
        [
            'ffmpeg', '-y', '-loglevel', 'quiet',
            '-f', 's16le', '-ar', str(sr), '-ac', '1', '-i', 'pipe:0',
            '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', 'pipe:1',
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    
    try:
        for result in model.generate(**stream_kwargs):
            # Convert audio chunk to int16 PCM and pipe to ffmpeg
            audio_data = np.asarray(result.audio, dtype=np.float32)
            pcm_int16 = (np.clip(audio_data, -1.0, 1.0) * 32767).astype(np.int16)
            ffmpeg_proc.stdin.write(pcm_int16.tobytes())
            
            # Read any available Opus frames from ffmpeg
            # (ffmpeg buffers internally, so we read what's available)
            import select
            if select.select([ffmpeg_proc.stdout], [], [], 0)[0]:
                chunk = ffmpeg_proc.stdout.read1(8192)  # Read available bytes
                if chunk:
                    yield chunk
        
        # Flush: close stdin, read remaining output
        ffmpeg_proc.stdin.close()
        while True:
            chunk = ffmpeg_proc.stdout.read1(8192)
            if not chunk:
                break
            yield chunk
    finally:
        ffmpeg_proc.terminate()
        ffmpeg_proc.wait(timeout=5)
```

**Add `stream` field to `SynthesizeRequest`:**
```python
class SynthesizeRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=100000)
    voice: str = "ryan"
    speed: float = Field(1.0, ge=0.5, le=3.0)
    language: str = "Auto"
    instruct: Optional[str] = None
    model: Optional[str] = None
    stream: bool = False        # NEW
    format: str = "opus"        # NEW: "opus" | "mp3" | "wav"
```

**BUT WAIT** — there's a problem. FastAPI's `StreamingResponse` with async generators does NOT block the event loop if the generator yields synchronously. However, `model.generate()` is a synchronous CPU-bound generator. We need to run it in a background thread and yield from the main thread.

**Better approach — use a queue-based bridge:**

```python
import queue
import threading

def _generate_stream(model, gen_kwargs, model_id):
    """Async generator that yields Opus chunks without blocking the event loop."""
    result_queue = queue.Queue()
    
    def _worker():
        try:
            stream_kwargs = {**gen_kwargs, "stream": True, "streaming_interval": 2.0}
            for result in model.generate(**stream_kwargs):
                audio_data = np.asarray(result.audio, dtype=np.float32)
                result_queue.put(("audio", audio_data))
            result_queue.put(("done", None))
        except Exception as e:
            result_queue.put(("error", e))
    
    thread = threading.Thread(target=_worker, daemon=True)
    thread.start()
    
    # Collect chunks and encode when enough audio is buffered
    audio_buffer = []
    sr = model.sample_rate
    
    while True:
        try:
            msg_type, data = result_queue.get(timeout=30)
        except queue.Empty:
            break
        
        if msg_type == "done":
            # Encode remaining buffer
            if audio_buffer:
                full_audio = np.concatenate(audio_buffer)
                buf = io.BytesIO()
                audio_write(buf, full_audio, sr, format="opus")
                buf.seek(0)
                yield buf.read()
            break
        elif msg_type == "error":
            raise data
        elif msg_type == "audio":
            audio_buffer.append(data)
            # Encode and yield when we have >= 2s of audio buffered
            total_samples = sum(a.shape[0] for a in audio_buffer)
            if total_samples >= sr * 2:
                full_audio = np.concatenate(audio_buffer)
                audio_buffer = []
                buf = io.BytesIO()
                audio_write(buf, full_audio, sr, format="opus")
                buf.seek(0)
                yield buf.read()
```

**HOWEVER** — this streaming approach has a fundamental UX problem: Chrome's `fetch()` + `response.blob()` waits for the ENTIRE response before resolving. You can't incrementally play chunks from a `fetch()` call. You'd need to use `ReadableStream` via `response.body.getReader()`, which requires significant content.js changes.

**For the extension, streaming is better done at the chunk level** — the content.js `splitTextForTTS` + `AudioBufferQueue` pattern is already a form of application-level streaming. The server's job is to be responsive (Step 1) and fast (Steps 2-5).

**Revised Step 6 — Server streaming for API consumers, not the extension:**

Add the streaming endpoint for external API consumers (curl, other apps), but DON'T change the extension to use it yet. The extension's chunk-based approach is actually fine once the server is unblocked (Step 1).

```python
@app.post("/v1/synthesize/stream")
async def synthesize_stream(request: SynthesizeRequest):
    """Streaming synthesis — yields Ogg/Opus chunks as generated. For API consumers."""
    model_id = request.model or DEFAULT_MODEL_ID
    
    if model_id not in MODEL_REGISTRY:
        raise HTTPException(status_code=404, detail=f"Unknown model: {model_id}")
    
    model = manager.get_or_load(model_id)
    # ... validation ...
    
    return StreamingResponse(
        _streaming_opus_generator(model, gen_kwargs, model_id),
        media_type="audio/ogg; codecs=opus",
        headers={
            "X-TTS-Engine": "open-tts",
            "X-TTS-Model": model_id,
            "Cache-Control": "no-cache",
        },
    )
```

---

### Step 7: Optimize content.js chunk settings
**File:** `extension/content.js`

```javascript
// OLD
const CHUNK_TARGET_CHARS = 500;
const PREFETCH_COUNT = 2;
const MIN_BUFFER_BEFORE_PLAY = 2;

// NEW
const CHUNK_TARGET_CHARS = 1200;     // ~2-3 sentences, ~20s audio
const PREFETCH_COUNT = 1;            // Fewer chunks needed with larger size
const MIN_BUFFER_BEFORE_PLAY = 1;    // Start playing immediately
```

**Impact:** For texts under 1200 chars (~85% of use cases), no chunking at all — single HTTP request, single audio playback. For longer texts, 2-3x fewer round trips.

---

### Step 8: Add request-level timing headers
**File:** `backend/server.py`

Add timing headers so we can debug performance from the client side:

```python
import time as _time

@app.post("/v1/synthesize")
async def synthesize(request: SynthesizeRequest):
    request_start = _time.perf_counter()
    
    # ... existing logic ...
    
    headers = {
        "X-TTS-Engine": "open-tts",
        "X-TTS-Model": model_id,
        "X-TTS-Voice": request.voice,
        "X-TTS-Lang": gen_kwargs.get("lang_code", "auto"),
        "X-TTS-RTF": f"{getattr(first, 'real_time_factor', 0):.3f}",
        "X-TTS-Gen-Time": f"{gen_elapsed:.3f}",          # NEW
        "X-TTS-Encode-Time": f"{encode_elapsed:.3f}",    # NEW
        "X-TTS-Total-Time": f"{_time.perf_counter() - request_start:.3f}",  # NEW
    }
```

**Impact:** Makes performance debugging trivial. Check DevTools Network tab to see exactly where time is spent.

---

### Step 9: Add connection-keep-alive and uvicorn tuning
**File:** `backend/server.py`

```python
if __name__ == "__main__":
    uvicorn.run(
        app,
        host=HOST,
        port=PORT,
        timeout_keep_alive=75,       # Keep connections alive (default 5s is too short)
        limit_concurrent_requests=4, # Prevent overload from parallel requests
        backlog=8,                   # Connection backlog
    )
```

**Impact:** Reduces TCP connection overhead for sequential requests from the extension. Without keep-alive, every request opens a new TCP connection (3-way handshake = ~1-2ms on localhost, but adds up).

---

### Step 10: Fix the stale native_host_id in uninstall script
**File:** `backend/uninstall_native_host.sh`, line 4

```bash
# OLD
NATIVE_HOST_NAME="com.qwen_tts_mlx.native_host"

# NEW
NATIVE_HOST_NAME="com.open_tts.native_host"
```

**Impact:** Uninstall will actually remove the correct manifest.

---

## Summary of All Changes

| Step | File | Change | Impact |
|------|------|--------|--------|
| 1 | `backend/server.py` | `asyncio.to_thread()` for synthesis | Unblocks event loop, enables concurrent health checks during generation |
| 2 | `backend/server.py` | Opus output via `audio_write` | 585KB → 182KB response, 780KB → 243KB base64 |
| 3 | `backend/server.py` | Voice list cache on ModelManager | Eliminates redundant voice queries |
| 4 | `backend/server.py` | Warmup `max_tokens` 512 → 128 | ~2-3s faster server startup |
| 5 | `extension/background.js` | `serverKnownRunning` flag, 500ms health timeout | Eliminates 5s preflight on every request |
| 6 | `backend/server.py` | `/v1/synthesize/stream` endpoint | Streaming for API consumers |
| 7 | `extension/content.js` | `CHUNK_TARGET_CHARS` 500 → 1200, `MIN_BUFFER` 2 → 1 | Fewer HTTP round trips, faster playback start |
| 8 | `backend/server.py` | `X-TTS-*-Time` headers | Debug visibility |
| 9 | `backend/server.py` | Uvicorn keep-alive + concurrency tuning | Reduces connection overhead |
| 10 | `backend/uninstall_native_host.sh` | Fix stale native host name | Correctness fix |

---

## Expected Result

| Scenario | Before | After |
|----------|--------|-------|
| First TTS request (server running, idle) | ~5.5s gen + 5s health preflight = **10.5s** | ~5.5s gen + 0s preflight = **5.5s** |
| Second TTS request (while first is generating) | Health check hangs 5s → auto-start cascade = **37s+** | Health check responds immediately (event loop free) → queue = **5.5s + queue wait** |
| Response size (12.5s audio) | 585KB WAV (780KB base64) | 182KB Opus (243KB base64) |
| Server startup | ~7s (warmup 512 tokens) | ~5s (warmup 128 tokens) |
| Content script chunking (3-4 lines) | 1 chunk, works fine | 1 chunk, works fine |
| Content script chunking (long text) | Many small 500-char chunks | Fewer 1200-char chunks, 2x fewer round trips |

---

## Verification Checklist

1. `curl -w "%{time_total}" http://127.0.0.1:8000/health` — should respond in <10ms even during generation
2. `curl -o test.opus -w "%{time_total}" -X POST http://127.0.0.1:8000/v1/synthesize -H 'Content-Type: application/json' -d '{"text":"Hello world","voice":"ryan","language":"en","format":"opus"}'` — should complete in ~6s, output valid .opus file
3. `ffplay test.opus` — should play correctly
4. Concurrent: Run two `curl` synthesize requests simultaneously — both should complete without hanging
5. Extension: Click Speak on selected text — audio should play within 6s
6. Extension: Click Speak while previous generation is in-flight — should not timeout or trigger auto-start
7. `curl -v http://127.0.0.1:8000/v1/synthesize/stream -X POST -H 'Content-Type: application/json' -d '{"text":"Hello world","voice":"ryan","stream":true}'` — should stream Ogg/Opus chunks incrementally
8. Check DevTools Network tab: `X-TTS-Gen-Time`, `X-TTS-Encode-Time`, `X-TTS-Total-Time` headers present

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| `asyncio.to_thread` GIL contention with MLX | MLX releases GIL during Metal ops; Python threads are fine for I/O-bound work during inference |
| Opus not supported in some browsers | Chrome supports Ogg/Opus natively. Firefox too. Safari is the outlier — add WAV fallback via `format` param |
| ffmpeg not found on PATH | mlx_audio already warns and falls back. Add explicit check at server startup |
| Streaming endpoint blocks event loop | Use thread-based queue bridge (Step 6). Or defer and use `asyncio.to_thread` for the whole stream |
| Voice cache stale after model swap | Clear all caches when `get_or_load` unloads previous model (Step 3) |

---

## Open Questions

1. Should the extension use `response.body.getReader()` for true incremental playback? This would require rewriting content.js from `<Audio(dataURL)>` to `MediaSource Extensions`. High effort, moderate gain since chunk-based prefetch already works.
2. Should we add a `/v1/synthesize/async` endpoint that returns a job ID and the client polls for completion? Useful for web UIs but overkill for the extension.
3. The tokenizer regex warning in server.log — should we set `fix_mistral_regex=True` in the model config? This is a mlx_audio-level issue that may affect tokenization speed.