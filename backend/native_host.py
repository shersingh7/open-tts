#!/usr/bin/env python3
"""
Native Messaging Host for Open TTS extension.
Handles start/stop server commands from the Chrome extension.
"""

import json
import os
import signal
import socket
import subprocess
import sys
import struct
import time
from pathlib import Path

# Get the directory where this script is located
SCRIPT_DIR = Path(__file__).parent.resolve()
BACKEND_DIR = SCRIPT_DIR
SERVER_SCRIPT = BACKEND_DIR / "server.py"
VENV_PYTHON = BACKEND_DIR / "venv" / "bin" / "python"
PID_FILE = BACKEND_DIR / ".server.pid"
LOG_FILE = BACKEND_DIR / "server.log"
DEFAULT_PORT = int(os.getenv("OPEN_TTS_PORT", "8000"))

# ---------------------------------------------------------------------------
# Native messaging protocol helpers
# ---------------------------------------------------------------------------

def get_message():
    """Read a message from stdin (Native Messaging protocol)."""
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length:
        return None
    message_length = struct.unpack("@I", raw_length)[0]
    message = sys.stdin.buffer.read(message_length).decode("utf-8")
    return json.loads(message)


def send_message(message):
    """Send a message to stdout (Native Messaging protocol)."""
    encoded_message = json.dumps(message).encode("utf-8")
    encoded_length = struct.pack("@I", len(encoded_message))
    sys.stdout.buffer.write(encoded_length)
    sys.stdout.buffer.write(encoded_message)
    sys.stdout.buffer.flush()


def send_response(success, message, **extra):
    """Send a response message."""
    response = {"success": success, "message": message, **extra}
    send_message(response)

# ---------------------------------------------------------------------------
# Port helpers
# ---------------------------------------------------------------------------

def is_port_in_use(port=DEFAULT_PORT):
    """Check if a port is actually in use by attempting a TCP connection."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(1)
            result = s.connect_ex(("127.0.0.1", port))
            return result == 0
    except (OSError, socket.error):
        return False


def get_pid_on_port(port=DEFAULT_PORT):
    """Find the PID of the process listening on the given port (macOS)."""
    try:
        result = subprocess.run(
            ["lsof", "-ti", f":{port}", "-sTCP:LISTEN"],
            capture_output=True, text=True, timeout=5,
        )
        pids = result.stdout.strip().split("\n")
        pids = [int(p) for p in pids if p.strip().isdigit()]
        return pids[0] if pids else None
    except (subprocess.TimeoutExpired, ValueError, FileNotFoundError):
        return None

# ---------------------------------------------------------------------------
# Server state helpers
# ---------------------------------------------------------------------------

def is_server_running():
    """Check if the server is running — checks both PID file AND actual port."""
    port_active = is_port_in_use()

    pid = None
    if PID_FILE.exists():
        try:
            pid = int(PID_FILE.read_text().strip())
            os.kill(pid, 0)
        except (ValueError, ProcessLookupError, PermissionError):
            pid = None
            if PID_FILE.exists():
                PID_FILE.unlink()

    if port_active:
        # Port is bound — reconcile PID
        actual_pid = get_pid_on_port()
        if actual_pid:
            if pid and pid != actual_pid:
                print(f"PID file ({pid}) doesn't match port PID ({actual_pid}), updating", file=sys.stderr)
            PID_FILE.write_text(str(actual_pid))
        return True

    # Port not bound, but process exists and is recent (<10s) — might be loading
    if pid is not None:
        try:
            proc_start = os.stat(f"/proc/{pid}").st_ctime if os.path.exists(f"/proc/{pid}") else 0
            if not proc_start:
                # macOS — use ps if available
                r = subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)],
                                   capture_output=True, text=True, timeout=2)
                # Process exists but no port yet — give it 10s grace
                return True
        except Exception:
            pass

    return False


def get_server_pid():
    """Get the server PID if running. Prefer port-based discovery."""
    pid = get_pid_on_port()
    if pid:
        PID_FILE.write_text(str(pid))
        return pid

    if PID_FILE.exists():
        try:
            return int(PID_FILE.read_text().strip())
        except (ValueError, FileNotFoundError):
            pass
    return None

# ---------------------------------------------------------------------------
# Process management
# ---------------------------------------------------------------------------

def kill_stale_server(port=DEFAULT_PORT):
    """Kill any process occupying the port. Returns (killed, message)."""
    pid = get_pid_on_port()
    if pid is None:
        return True, "No stale process found"

    try:
        os.kill(pid, signal.SIGTERM)
        for _ in range(20):
            time.sleep(0.25)
            if not is_port_in_use(port):
                if PID_FILE.exists():
                    PID_FILE.unlink()
                return True, f"Killed stale server (PID {pid})"

        # Force kill
        os.kill(pid, signal.SIGKILL)
        time.sleep(0.5)
        if PID_FILE.exists():
            PID_FILE.unlink()
        return True, f"Force-killed stale server (PID {pid})"
    except ProcessLookupError:
        if PID_FILE.exists():
            PID_FILE.unlink()
        return True, "Stale process already gone"
    except PermissionError:
        return False, f"Permission denied killing PID {pid}"
    except Exception as e:
        return False, f"Failed to kill stale server: {e}"


def start_server():
    """Start the TTS server. Returns (success, message)."""
    # If already running with port bound, nothing to do
    if is_port_in_use():
        pid = get_server_pid()
        return True, f"Server already running (PID: {pid})"

    # Port not in use but PID file exists — clean up dead process
    if PID_FILE.exists():
        try:
            pid = int(PID_FILE.read_text().strip())
            try:
                os.kill(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        except ValueError:
            pass
        PID_FILE.unlink()

    # Port in use by unknown process — kill it
    if is_port_in_use():
        killed, msg = kill_stale_server()
        if not killed:
            return False, f"Port {DEFAULT_PORT} in use by unknown process: {msg}"
        for _ in range(10):
            time.sleep(0.3)
            if not is_port_in_use():
                break
        else:
            return False, f"Port {DEFAULT_PORT} still in use after killing stale process"

    # Determine Python executable
    python_exe = str(VENV_PYTHON) if VENV_PYTHON.exists() else sys.executable

    # Start the server as a background process
    try:
        stdout_fh = open(LOG_FILE, "a")
        stderr_fh = open(LOG_FILE, "a")
    except OSError as e:
        return False, f"Failed to open log file: {e}"

    try:
        process = subprocess.Popen(
            [python_exe, str(SERVER_SCRIPT)],
            cwd=str(BACKEND_DIR),
            stdout=stdout_fh,
            stderr=stderr_fh,
            start_new_session=True,
        )
        stdout_fh.close()
        stderr_fh.close()
    except Exception as e:
        stdout_fh.close()
        stderr_fh.close()
        return False, f"Failed to start server: {str(e)}"

    PID_FILE.write_text(str(process.pid))

    # Wait for port to bind — model warmup now happens in background,
    # so port binds MUCH faster (typically <2s instead of 10-15s)
    start_time = time.time()
    max_wait = 15  # seconds — reduced from 30 since warmup is async

    while time.time() - start_time < max_wait:
        time.sleep(0.3)
        try:
            os.kill(process.pid, 0)
        except ProcessLookupError:
            if PID_FILE.exists():
                PID_FILE.unlink()
            return False, "Server failed to start. Check server.log for details."

        if is_port_in_use():
            return True, f"Server started (PID: {process.pid})"

    # Port not bound yet, but process alive — check again
    try:
        os.kill(process.pid, 0)
        if is_port_in_use():
            return True, f"Server started (PID: {process.pid})"
        return True, f"Server starting (PID: {process.pid}, model loading...)"
    except ProcessLookupError:
        if PID_FILE.exists():
            PID_FILE.unlink()
        return False, "Server failed to start. Check server.log for details."


def stop_server():
    """Stop the TTS server. Returns (success, message)."""
    if not is_server_running():
        if is_port_in_use():
            killed, msg = kill_stale_server()
            return killed, msg if not killed else "Server stopped (killed orphan)"
        return True, "Server is not running"

    pid = get_server_pid()
    if pid is None:
        killed, msg = kill_stale_server()
        return killed, msg

    try:
        os.kill(pid, signal.SIGTERM)

        for _ in range(20):
            time.sleep(0.25)
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                if PID_FILE.exists():
                    PID_FILE.unlink()
                return True, "Server stopped successfully"

            if not is_port_in_use():
                if PID_FILE.exists():
                    PID_FILE.unlink()
                return True, "Server stopped successfully"

        # Force kill
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        time.sleep(0.5)

        if PID_FILE.exists():
            PID_FILE.unlink()
        return True, "Server stopped (force killed)"

    except ProcessLookupError:
        if PID_FILE.exists():
            PID_FILE.unlink()
        return True, "Server was not running"
    except PermissionError:
        return False, "Permission denied. Try stopping manually."
    except Exception as e:
        return False, f"Failed to stop server: {str(e)}"


def get_status():
    """Get the server status."""
    port_active = is_port_in_use()
    running = is_server_running()
    pid = get_server_pid() if running else None

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
    }

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def main():
    """Main native messaging host loop."""
    while True:
        try:
            message = get_message()
            if message is None:
                break

            command = message.get("command")

            if command == "start":
                success, msg = start_server()
                send_response(success, msg)
            elif command == "stop":
                success, msg = stop_server()
                send_response(success, msg)
            elif command == "status":
                status = get_status()
                send_response(True, status["message"], **status)
            else:
                send_response(False, f"Unknown command: {command}")

        except Exception as e:
            try:
                send_response(False, f"Error: {str(e)}")
            except Exception:
                break


if __name__ == "__main__":
    main()
