"""Public error codes for API responses."""

from __future__ import annotations

from enum import Enum
from typing import Any, Dict, Optional


class ErrorCode(str, Enum):
    UNKNOWN = "unknown"
    VALIDATION = "validation_error"
    MODEL_NOT_FOUND = "model_not_found"
    MODEL_LOAD_FAILED = "model_load_failed"
    MODEL_NOT_READY = "model_not_ready"
    MODEL_WARM_FAILED = "model_warm_failed"
    GPU_BUSY = "gpu_busy"
    GENERATION_FAILED = "generation_failed"
    GENERATION_TIMEOUT = "generation_timeout"
    FORMAT_UNSUPPORTED = "format_unsupported"
    FORMAT_ENCODE_FAILED = "format_encode_failed"
    VOICE_UNSUPPORTED = "voice_unsupported"
    BATCH_TOO_LARGE = "batch_too_large"
    UNAUTHORIZED = "unauthorized"
    RATE_LIMITED = "rate_limited"
    STREAM_CANCELLED = "stream_cancelled"
    STREAM_TIMEOUT = "stream_timeout"
    INTERNAL = "internal_error"


def error_detail(
    code: ErrorCode,
    message: str,
    *,
    status: int = 400,
    **extra: Any,
) -> Dict[str, Any]:
    payload: Dict[str, Any] = {"code": code.value, "message": message}
    payload.update(extra)
    return payload


def http_exception(status: int, code: ErrorCode, message: str, **extra: Any):
    from fastapi import HTTPException

    return HTTPException(status, detail=error_detail(code, message, status=status, **extra))