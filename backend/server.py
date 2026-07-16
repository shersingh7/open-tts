#!/usr/bin/env python3
"""Open TTS Server — thin bootstrap."""

from __future__ import annotations

import os
import sys

_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)
if sys.platform == "darwin":
    import darwin_espeak_fix  # noqa: F401,E402

import mlx.core as _mx

_orig_mx_compile = _mx.compile


def _safe_compile(fn=None, **kwargs):
    if fn is not None:
        return _orig_mx_compile(fn, **kwargs)

    def decorator(f):
        return _orig_mx_compile(f, **kwargs)

    return decorator


_mx.compile = _safe_compile

from open_tts.api import create_app
from open_tts.config import HOST, PORT

app = create_app()

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT, timeout_keep_alive=75)