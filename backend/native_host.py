#!/usr/bin/env python3
"""Native Messaging Host for Open TTS extension."""

from __future__ import annotations

import fcntl
import json
import os
import signal
import shlex
import socket
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()
BACKEND_DIR = SCRIPT_DIR
SERVER_SCRIPT = BACKEND_DIR / "server.py"
VENV_PYTHON = BACKEND_DIR / "venv" / "bin" / "python"
PID_FILE = BACKEND_DIR / ".server.pid"
LOCK_FILE = BACKEND_DIR / ".open_tts.lock"
TOKEN_FILE = BACKEND_DIR / ".open_tts_token"
LOG_FILE = BACKEND_DIR / "server.log"
DEFAULT_PORT = int(os.getenv("OPEN_TTS_PORT", "8000"))
MAX_MESSAGE_BYTES = 1_048_576
ENGINE_ID = "open-tts"
STARTUP_GRACE_SECONDS = 30

_lock_fd = None


def _acquire_interprocess_lock() -> bool:
    global _lock_fd
    try:
        _lock_fd = open(LOCK_FILE, "a+")
        fcntl.flock(_lock_fd.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except OSError:
        return False


def _release_interprocess_lock() -> None:
    global _lock_fd
    if _lock_fd:
        try:
            fcntl.flock(_lock_fd.fileno(), fcntl.LOCK_UN)
            _lock_fd.close()
        except Exception:
            pass
        _lock_fd = None


def get_message():
    raw_length = _read_exact(4, allow_eof=True)
    if not raw_length:
        return None
    message_length = struct.unpack("@I", raw_length)[0]
    if message_length > MAX_MESSAGE_BYTES:
        raise ValueError(f"Message exceeds {MAX_MESSAGE_BYTES} bytes")
    message = _read_exact(message_length).decode("utf-8")
    return json.loads(message)


def _read_exact(size: int, *, allow_eof: bool = False) -> bytes:
    chunks = []
    remaining = size
    while remaining:
        chunk = sys.stdin.buffer.read(remaining)
        if not chunk:
            if allow_eof and remaining == size:
                return b""
            raise EOFError(f"Native message ended {remaining} bytes early")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def send_message(message):
    encoded_message = json.dumps(message).encode("utf-8")
    if len(encoded_message) > MAX_MESSAGE_BYTES:
        encoded_message = json.dumps({"success": False, "message": "Response too large"}).encode("utf-8")
    encoded_length = struct.pack("@I", len(encoded_message))
    sys.stdout.buffer.write(encoded_length)
    sys.stdout.buffer.write(encoded_message)
    sys.stdout.buffer.flush()


def send_response(success, message, **extra):
    send_message({"success": success, "message": message, **extra})


def is_port_in_use(port=DEFAULT_PORT) -> bool:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(1)
            return s.connect_ex(("127.0.0.1", port)) == 0
    except OSError:
        return False


def get_pid_on_port(port=DEFAULT_PORT):
    try:
        result = subprocess.run(
            ["lsof", "-ti", f":{port}", "-sTCP:LISTEN"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        pids = [int(p) for p in result.stdout.strip().split("\n") if p.strip().isdigit()]
        return pids[0] if pids else None
    except (subprocess.TimeoutExpired, ValueError, FileNotFoundError):
        return None


def _process_command(pid: int) -> str:
    try:
        if sys.platform == "darwin":
            r = subprocess.run(
                ["ps", "-p", str(pid), "-o", "command="],
                capture_output=True,
                text=True,
                timeout=3,
            )
            return r.stdout.strip()
        proc = Path(f"/proc/{pid}/cmdline")
        if proc.exists():
            return proc.read_text(errors="ignore").replace("\x00", " ")
    except Exception:
        pass
    return ""


def _process_cwd(pid: int) -> Path | None:
    try:
        if sys.platform == "darwin":
            result = subprocess.run(
                ["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"],
                capture_output=True,
                text=True,
                timeout=3,
            )
            for line in result.stdout.splitlines():
                if line.startswith("n/"):
                    return Path(line[1:]).resolve()
        proc_cwd = Path(f"/proc/{pid}/cwd")
        if proc_cwd.exists():
            return proc_cwd.resolve()
    except Exception:
        pass
    return None


def _is_open_tts_process(pid: int) -> bool:
    cmd = _process_command(pid)
    if not cmd:
        return False
    cwd = _process_cwd(pid)
    try:
        parts = shlex.split(cmd)
    except ValueError:
        parts = cmd.split()
    for part in parts:
        candidate = Path(part)
        if candidate.name != "server.py":
            continue
        if not candidate.is_absolute():
            if cwd is None:
                continue
            candidate = cwd / candidate
        try:
            if candidate.resolve() == SERVER_SCRIPT:
                return True
        except OSError:
            continue
    return False


def _fetch_health(timeout=2.0):
    url = f"http://127.0.0.1:{DEFAULT_PORT}/health"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return None


def _verify_open_tts_server(pid: int | None = None) -> bool:
    health = _fetch_health()
    if not health:
        return False
    if health.get("engine") != ENGINE_ID:
        return False
    if pid is not None:
        return _is_open_tts_process(pid)
    if pid is None:
        port_pid = get_pid_on_port()
        if port_pid and _is_open_tts_process(port_pid):
            return True
    return False


def _read_install_token():
    try:
        token = TOKEN_FILE.read_text(encoding="utf-8").strip()
        return token or None
    except OSError:
        return None


def _read_pid_file():
    if not PID_FILE.exists():
        return None
    try:
        return int(PID_FILE.read_text().strip())
    except ValueError:
        return None


def _write_pid(pid: int) -> None:
    PID_FILE.write_text(str(pid))


def _clear_pid_file() -> None:
    if PID_FILE.exists():
        PID_FILE.unlink(missing_ok=True)


def is_server_running() -> bool:
    port_active = is_port_in_use()
    pid = _read_pid_file()
    if pid is not None:
        try:
            os.kill(pid, 0)
        except (ProcessLookupError, PermissionError):
            pid = None
            _clear_pid_file()

    if port_active:
        actual_pid = get_pid_on_port()
        if actual_pid and _verify_open_tts_server(actual_pid):
            _write_pid(actual_pid)
            return True
        if actual_pid and not _is_open_tts_process(actual_pid):
            return False
        return _verify_open_tts_server(actual_pid)

    if pid is not None and _is_open_tts_process(pid):
        try:
            age = time.time() - PID_FILE.stat().st_mtime
        except OSError:
            age = STARTUP_GRACE_SECONDS + 1
        return age <= STARTUP_GRACE_SECONDS
    return False


def get_server_pid():
    port_pid = get_pid_on_port()
    if port_pid and _is_open_tts_process(port_pid) and _verify_open_tts_server(port_pid):
        _write_pid(port_pid)
        return port_pid
    pid = _read_pid_file()
    if pid and _is_open_tts_process(pid):
        return pid
    return None


def _kill_process_group(pid: int, sig: int) -> None:
    try:
        if sys.platform != "win32":
            os.killpg(os.getpgid(pid), sig)
        else:
            os.kill(pid, sig)
    except (ProcessLookupError, PermissionError):
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            pass


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False


def _wait_for_exit(pid: int, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not _pid_alive(pid):
            return True
        time.sleep(0.1)
    return not _pid_alive(pid)


def kill_owned_server(port=DEFAULT_PORT):
    """Kill only a verified Open TTS server. Never touch foreign port owners."""
    pid = get_pid_on_port()
    if pid is None:
        recorded_pid = _read_pid_file()
        if recorded_pid and _is_open_tts_process(recorded_pid):
            _kill_process_group(recorded_pid, signal.SIGTERM)
            _wait_for_exit(recorded_pid, timeout=5)
            if _pid_alive(recorded_pid):
                _kill_process_group(recorded_pid, signal.SIGKILL)
            _clear_pid_file()
            return True, f"Stopped non-listening Open TTS process {recorded_pid}"
        _clear_pid_file()
        return True, "No Open TTS process found"

    if not _is_open_tts_process(pid):
        return False, f"Port {port} owned by foreign PID {pid}; refusing to kill"

    if not _verify_open_tts_server(pid):
        if not _is_open_tts_process(pid):
            return False, f"PID {pid} is not an Open TTS server"
        # Process looks like ours but health not ready — still only kill if command matches
        pass

    try:
        _kill_process_group(pid, signal.SIGTERM)
        for _ in range(20):
            time.sleep(0.25)
            if not is_port_in_use(port):
                _clear_pid_file()
                return True, f"Stopped Open TTS server (PID {pid})"
        _kill_process_group(pid, signal.SIGKILL)
        time.sleep(0.5)
        _clear_pid_file()
        return True, f"Force-stopped Open TTS server (PID {pid})"
    except ProcessLookupError:
        _clear_pid_file()
        return True, "Server already stopped"
    except PermissionError:
        return False, f"Permission denied stopping PID {pid}"


def _sign_native_dylibs_if_darwin():
    if sys.platform != "darwin":
        return
    script = BACKEND_DIR / "sign_native_dylibs.sh"
    if not script.is_file():
        return
    try:
        subprocess.run(
            ["/bin/bash", str(script)],
            cwd=str(BACKEND_DIR),
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except Exception:
        pass


def start_server():
    _sign_native_dylibs_if_darwin()

    if is_port_in_use():
        port_pid = get_pid_on_port()
        if port_pid and _is_open_tts_process(port_pid):
            _write_pid(port_pid)
            if _verify_open_tts_server(port_pid):
                return True, f"Server already running (PID: {port_pid})", _read_install_token()
            # Our process owns the port but /health may still be coming up.
            return True, f"Server starting (PID: {port_pid})", _read_install_token()
        if port_pid:
            return False, f"Port {DEFAULT_PORT} in use by non-Open-TTS process (PID: {port_pid})", None
        return False, f"Port {DEFAULT_PORT} in use but owner could not be identified", None

    pid = _read_pid_file()
    if pid is not None:
        try:
            if _is_open_tts_process(pid):
                os.kill(pid, 0)
                if not is_port_in_use():
                    try:
                        age = time.time() - PID_FILE.stat().st_mtime
                    except OSError:
                        age = STARTUP_GRACE_SECONDS + 1
                    if age <= STARTUP_GRACE_SECONDS:
                        return True, f"Server starting (PID: {pid})", _read_install_token()
                    _kill_process_group(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        _clear_pid_file()

    python_exe = str(VENV_PYTHON) if VENV_PYTHON.exists() else sys.executable
    if not SERVER_SCRIPT.is_file():
        return False, "server.py not found", None
    if not VENV_PYTHON.is_file():
        return False, "venv python missing; run setup.sh", None

    try:
        log_fh = open(LOG_FILE, "a")
    except OSError as exc:
        return False, f"Failed to open log file: {exc}", None

    env = dict(os.environ)
    env.pop("PYTHONPATH", None)
    env.setdefault("OPEN_TTS_EAGER_LOAD", "0")

    try:
        process = subprocess.Popen(
            [python_exe, str(SERVER_SCRIPT)],
            cwd=str(BACKEND_DIR),
            env=env,
            stdout=log_fh,
            stderr=log_fh,
            start_new_session=True,
        )
    except Exception as exc:
        log_fh.close()
        return False, f"Failed to start server: {exc}", None
    finally:
        log_fh.close()

    _write_pid(process.pid)
    start_time = time.time()
    while time.time() - start_time < 20:
        time.sleep(0.3)
        try:
            os.kill(process.pid, 0)
        except ProcessLookupError:
            _clear_pid_file()
            return False, "Server failed to start. Check server.log", None
        if is_port_in_use() and _verify_open_tts_server(process.pid):
            return True, f"Server started (PID: {process.pid})", _read_install_token()
    if is_port_in_use():
        return True, f"Server starting (PID: {process.pid})", _read_install_token()
    return True, f"Server process started (PID: {process.pid}); waiting for port", None


def stop_server():
    if not is_port_in_use() and _read_pid_file() is None:
        return True, "Server is not running"

    pid = get_server_pid()
    if pid is None:
        foreign = get_pid_on_port()
        if foreign:
            return False, f"Port {DEFAULT_PORT} used by foreign PID {foreign}; not stopping"
        _clear_pid_file()
        return True, "Server is not running"

    return kill_owned_server()[:2]


def get_status():
    running = is_server_running()
    pid = get_server_pid() if running else None
    port_active = is_port_in_use()
    health = _fetch_health() if port_active else None
    if running and port_active:
        msg = f"Server running (PID: {pid})"
    elif running:
        msg = f"Server starting (PID: {pid})"
    else:
        msg = "Server not running"
    return {
        "running": running,
        "port_active": port_active,
        "pid": pid,
        "message": msg,
        "install_token": _read_install_token() if running else None,
        "engine": (health or {}).get("engine"),
    }


def main():
    if not _acquire_interprocess_lock():
        send_response(False, "Another native host instance is active")
        return

    try:
        while True:
            try:
                message = get_message()
                if message is None:
                    break
                command = message.get("command")
                if command == "start":
                    success, msg, token = start_server()
                    send_response(success, msg, install_token=token)
                elif command == "stop":
                    success, msg = stop_server()
                    send_response(success, msg)
                elif command == "status":
                    status = get_status()
                    details = {key: value for key, value in status.items() if key != "message"}
                    send_response(True, status["message"], **details)
                else:
                    send_response(False, f"Unknown command: {command}")
            except Exception as exc:
                try:
                    send_response(False, f"Error: {exc}")
                except Exception:
                    break
    finally:
        _release_interprocess_lock()


if __name__ == "__main__":
    main()