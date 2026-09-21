"""Bounded, on-demand single owner for model lifecycle and inference.

Cancellation is cooperative: a cancelled native call retains its lease until
it returns. Never unload from a caller thread to pretend that it was killed.
"""
from __future__ import annotations

import asyncio
import queue
import threading
import time
from concurrent.futures import Future
from dataclasses import dataclass, field
from typing import Callable

from .config import GEN_TIMEOUT, MAX_BODY_BYTES, STREAM_QUEUE_BYTES
from .errors import ErrorCode, http_exception

_local = threading.local()


def check_job():
    job = getattr(_local, "job", None)
    if job and job.cancel.is_set():
        raise http_exception(499, ErrorCode.STREAM_CANCELLED, "Generation cancelled")


class Cancellation(threading.Event):
    def __init__(self):
        super().__init__()
        self.requested_at = None
    def set(self):
        if self.requested_at is None:
            self.requested_at = time.monotonic()
        super().set()


def set_job_phase(phase):
    job = getattr(_local, "job", None)
    if job:
        job.phase = phase


@dataclass(eq=False)
class Job:
    fn: Callable
    size: int
    cancel: Cancellation = field(default_factory=Cancellation)
    started: float = 0.0
    future: Future = field(default_factory=Future)
    phase: str = "queued"
    accepted: float = field(default_factory=time.monotonic)


class ModelRuntime:
    def __init__(self, cleanup=lambda: None, max_pending=1):
        self._cleanup = cleanup
        self._max_jobs = 1 + max_pending
        self._lock = threading.Lock()
        self._jobs = set()
        self._queue = queue.Queue()
        self._thread = None
        self._closed = False
        self._last_cancel_release_seconds = None

    def submit(self, fn, *, size=0, require_idle=False):
        with self._lock:
            if self._closed or len(self._jobs) >= self._max_jobs or (require_idle and self._jobs):
                raise http_exception(503, ErrorCode.GPU_BUSY, "Model busy; stop the active reading before changing models")
            if size < 0 or size + sum(j.size for j in self._jobs) > MAX_BODY_BYTES * 2:
                raise http_exception(413, ErrorCode.VALIDATION, "Admitted text byte budget exceeded")
            job = Job(fn, size)
            self._jobs.add(job)
            self._queue.put(job)
            if self._thread is None:
                self._thread = threading.Thread(target=self._work, name="open-tts-model-owner", daemon=True)
                self._thread.start()
            return job

    def _work(self):
        try:
            while True:
                job = self._queue.get()
                if job is None:
                    return
                _local.job = job
                try:
                    if time.monotonic() - job.accepted > GEN_TIMEOUT:
                        raise http_exception(504, ErrorCode.GENERATION_TIMEOUT, "Queue wait exceeded deadline")
                    check_job()
                    job.phase = "active"
                    job.started = time.monotonic()
                    result = job.fn(job.cancel)
                    check_job()
                except BaseException as exc:
                    result, error = None, exc
                else:
                    error = None
                finally:
                    _local.job = None
                    with self._lock:
                        self._jobs.discard(job)
                        if job.cancel.requested_at is not None:
                            self._last_cancel_release_seconds = time.monotonic() - job.cancel.requested_at
                    job.phase = "finished"
                # Publish only after the lease is released; a ready caller may submit again.
                if error is not None:
                    job.future.set_exception(error)
                else:
                    job.future.set_result(result)
        finally:
            self._cleanup()

    def snapshot(self):
        with self._lock:
            return {"accepting": not self._closed, "jobs": len(self._jobs),
                    "last_cancel_release_seconds": self._last_cancel_release_seconds,
                    "phases": ["cancelling" if j.cancel.is_set() else j.phase for j in self._jobs],
                    "owner_alive": bool(self._thread and self._thread.is_alive())}

    def shutdown(self, timeout: float=1):
        with self._lock:
            if not self._closed:
                self._closed = True
                for job in self._jobs:
                    job.cancel.set()
                if self._thread:
                    self._queue.put(None)
            thread = self._thread
        if thread and thread is not threading.current_thread():
            thread.join(timeout)
        return not (thread and thread.is_alive())


async def await_job(job, request=None, timeout=None):
    started = time.monotonic()
    try:
        while not job.future.done():
            if request is not None and await request.is_disconnected():
                job.cancel.set()
                raise http_exception(499, ErrorCode.STREAM_CANCELLED, "Client disconnected")
            if timeout is not None and time.monotonic() - started > timeout:
                job.cancel.set()
                raise http_exception(504, ErrorCode.GENERATION_TIMEOUT, "Request deadline exceeded; cancellation pending")
            await asyncio.sleep(0.02)
        return job.future.result()
    finally:
        if not job.future.done():
            job.cancel.set()


class FrameQueue(queue.Queue):
    """Both byte and item bounded, compatible with Queue's timed get/put."""
    def __init__(self, maxsize, max_bytes=STREAM_QUEUE_BYTES):
        super().__init__(maxsize=maxsize)
        self.max_bytes = max_bytes
        self.bytes = 0
        self.peak_bytes = 0

    @staticmethod
    def size(item):
        return len(item) if isinstance(item, bytes) else 0

    def put(self, item, block=True, timeout=None):
        size = self.size(item)
        if size > self.max_bytes:
            raise ValueError("Frame exceeds transport byte budget")
        with self.not_full:
            deadline = None if timeout is None else time.monotonic() + timeout
            while self._qsize() >= self.maxsize or self.bytes + size > self.max_bytes:
                if not block:
                    raise queue.Full
                remaining = None if deadline is None else deadline - time.monotonic()
                if remaining is not None and remaining <= 0:
                    raise queue.Full
                self.not_full.wait(remaining)
            self._put(item)
            self.bytes += size
            self.peak_bytes = max(self.peak_bytes, self.bytes)
            self.unfinished_tasks += 1
            self.not_empty.notify()

    def _get(self):
        item = super()._get()
        self.bytes -= self.size(item)
        return item
