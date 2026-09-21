"""CORS, install token, and rate limiting."""

from __future__ import annotations

import secrets
import time
import os
from collections import defaultdict
from typing import Callable, Dict, List, Optional

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from .config import RATE_LIMIT_PER_MIN, TOKEN_FILE
from .errors import ErrorCode, error_detail


def get_or_create_token() -> str:
    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    if TOKEN_FILE.exists():
        TOKEN_FILE.chmod(0o600)
        token = TOKEN_FILE.read_text(encoding="utf-8").strip()
        if token:
            return token
    token = secrets.token_urlsafe(32)
    fd = os.open(TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(token)
    return token


def validate_token(provided: Optional[str], expected: str) -> bool:
    if not expected:
        return True
    if not provided:
        return False
    # compare_digest on str requires ASCII. Malformed header values must fail
    # authentication rather than raising TypeError and turning into HTTP 500.
    candidate = provided.strip()
    if not candidate or len(candidate) != len(expected):
        return False
    if not candidate.isascii() or not expected.isascii():
        return False
    return secrets.compare_digest(candidate, expected)


class RateLimiter:
    def __init__(self, limit_per_min: int = RATE_LIMIT_PER_MIN):
        self.limit = limit_per_min
        self._hits: Dict[str, List[float]] = defaultdict(list)
        self._request_count = 0

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        self._request_count += 1
        if self._request_count % 100 == 0:
            cutoff = now - 60
            stale = [client for client, hits in self._hits.items() if not hits or hits[-1] < cutoff]
            for client in stale:
                self._hits.pop(client, None)
        if key not in self._hits and len(self._hits) >= 2048:
            oldest = min(self._hits, key=lambda client: self._hits[client][-1] if self._hits[client] else 0)
            self._hits.pop(oldest, None)
        window = self._hits[key]
        self._hits[key] = [t for t in window if now - t < 60]
        if len(self._hits[key]) >= self.limit:
            return False
        self._hits[key].append(now)
        return True


def build_cors_origins(extension_origins: Optional[List[str]] = None) -> List[str]:
    origins = [
        "http://127.0.0.1:8000",
        "http://localhost:8000",
    ]
    if extension_origins:
        origins.extend(extension_origins)
    return origins




class BoundedBodyMiddleware:
    """Bound raw upload bytes/concurrency before JSON parsing, even without length."""
    def __init__(self, app):
        import threading
        self.app = app
        self._lock = threading.Lock()
        self._reading = 0

    async def __call__(self, scope, receive, send):
        import asyncio
        from .config import MAX_BODY_BYTES
        if scope["type"] != "http" or scope.get("method") != "POST":
            return await self.app(scope, receive, send)
        with self._lock:
            admitted = self._reading < 4
            if admitted:
                self._reading += 1
        if not admitted:
            return await JSONResponse({"code": "gpu_busy", "message": "Too many uploads"}, 503)(scope, receive, send)
        body = bytearray()
        try:
            deadline = time.monotonic() + 30
            while True:
                message = await asyncio.wait_for(receive(), max(0.01, deadline-time.monotonic()))
                if message["type"] == "http.disconnect":
                    return
                part = message.get("body", b"")
                if len(body) + len(part) > MAX_BODY_BYTES:
                    return await JSONResponse({"code": "validation", "message": "JSON body exceeds 4 MiB; partition text"}, 413)(scope, receive, send)
                body.extend(part)
                if not message.get("more_body", False):
                    break
            delivered = False
            async def replay():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {"type": "http.request", "body": bytes(body), "more_body": False}
                return await receive()
            await self.app(scope, replay, send)
        except asyncio.TimeoutError:
            await JSONResponse({"code": "validation", "message": "Upload timeout"}, 408)(scope, receive, send)
        finally:
            with self._lock:
                self._reading -= 1


class AuthAndRateLimitMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, rate_limiter: RateLimiter):
        super().__init__(app)
        self.rate_limiter = rate_limiter

    async def dispatch(self, request: Request, call_next: Callable):
        path = request.url.path
        if path.startswith("/v1/"):
            # Let CORS middleware answer browser preflight requests.
            if request.method == "OPTIONS":
                return await call_next(request)
            client = request.client.host if request.client else "unknown"
            if not self.rate_limiter.allow(client):
                return JSONResponse(
                    status_code=429,
                    content=error_detail(ErrorCode.RATE_LIMITED, "Rate limit exceeded"),
                )
            token = getattr(request.app.state, "install_token", "")
            if not token:
                return JSONResponse(
                    status_code=503,
                    content=error_detail(ErrorCode.UNAUTHORIZED, "Server authentication is not initialized"),
                )
            header_token = request.headers.get("X-Open-TTS-Token")
            origin = request.headers.get("origin", "")
            # curl and other local CLI clients do not send Origin. The server is
            # loopback-only, so preserve a useful OpenAI-compatible local API.
            if not origin and client in {"127.0.0.1", "::1", "testclient"}:
                return await call_next(request)
            if origin.startswith("chrome-extension://") and validate_token(header_token, token):
                return await call_next(request)
            if not validate_token(header_token, token):
                return JSONResponse(
                    status_code=401,
                    content=error_detail(ErrorCode.UNAUTHORIZED, "Invalid or missing X-Open-TTS-Token"),
                )
        return await call_next(request)