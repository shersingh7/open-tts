from __future__ import annotations

import native_host


def test_refuses_foreign_port_owner(monkeypatch):
    monkeypatch.setattr(native_host, "get_pid_on_port", lambda port=8000: 99999)
    monkeypatch.setattr(native_host, "_is_open_tts_process", lambda pid: False)
    monkeypatch.setattr(native_host, "is_port_in_use", lambda port=8000: True)

    ok, msg = native_host.kill_owned_server()
    assert ok is False
    assert "foreign" in msg.lower() or "refusing" in msg.lower()


def test_native_message_size_limit():
    assert native_host.MAX_MESSAGE_BYTES == 1_048_576


def test_bounded_get_message_rejects_large_length():
    import struct
    import io

    payload = struct.pack("@I", native_host.MAX_MESSAGE_BYTES + 1)
    native_host.sys.stdin = io.BytesIO(payload)
    native_host.sys.stdin.buffer = native_host.sys.stdin
    try:
        native_host.get_message()
        assert False, "expected ValueError"
    except ValueError as exc:
        assert "exceeds" in str(exc)


def test_native_message_reads_fragmented_pipe(monkeypatch):
    import io
    import json
    import struct

    body = json.dumps({"action": "status"}).encode()
    raw = struct.pack("@I", len(body)) + body

    class Fragmented(io.BytesIO):
        def read(self, size=None):
            requested = -1 if size is None else size
            return super().read(min(requested, 2) if requested >= 0 else 2)

    stream = Fragmented(raw)
    monkeypatch.setattr(native_host.sys.stdin, "buffer", stream)
    assert native_host.get_message() == {"action": "status"}


def test_health_spoof_does_not_override_process_identity(monkeypatch):
    monkeypatch.setattr(native_host, "_fetch_health", lambda: {"status": "ok", "engine": "open-tts"})
    monkeypatch.setattr(native_host, "_is_open_tts_process", lambda pid: False)
    assert native_host._verify_open_tts_server(12345) is False


def test_non_listening_pid_only_counts_during_startup_grace(monkeypatch, tmp_path):
    pid_file = tmp_path / ".server.pid"
    pid_file.write_text("12345")
    monkeypatch.setattr(native_host, "PID_FILE", pid_file)
    monkeypatch.setattr(native_host, "is_port_in_use", lambda port=8000: False)
    monkeypatch.setattr(native_host, "_is_open_tts_process", lambda pid: True)
    monkeypatch.setattr(native_host.os, "kill", lambda pid, sig: None)
    assert native_host.is_server_running() is True
    old = native_host.time.time() - native_host.STARTUP_GRACE_SECONDS - 1
    native_host.os.utime(pid_file, (old, old))
    assert native_host.is_server_running() is False


def test_relative_server_command_is_resolved_against_process_cwd(monkeypatch):
    repo_root = native_host.BACKEND_DIR.parent
    monkeypatch.setattr(native_host, "_process_command", lambda pid: "python backend/server.py")
    monkeypatch.setattr(native_host, "_process_cwd", lambda pid: repo_root)
    assert native_host._is_open_tts_process(12345) is True


def test_start_server_recognizes_own_process_before_health(monkeypatch, tmp_path):
    pid_file = tmp_path / ".server.pid"
    monkeypatch.setattr(native_host, "PID_FILE", pid_file)
    monkeypatch.setattr(native_host, "is_port_in_use", lambda port=8000: True)
    monkeypatch.setattr(native_host, "get_pid_on_port", lambda port=8000: 4242)
    monkeypatch.setattr(native_host, "_is_open_tts_process", lambda pid: pid == 4242)
    monkeypatch.setattr(native_host, "_verify_open_tts_server", lambda pid=None: False)
    monkeypatch.setattr(native_host, "_read_install_token", lambda: "tok")

    ok, msg, token = native_host.start_server()
    assert ok is True
    assert "starting" in msg.lower()
    assert token == "tok"
    assert pid_file.read_text().strip() == "4242"


def test_start_server_still_refuses_foreign_port_owner(monkeypatch):
    monkeypatch.setattr(native_host, "is_port_in_use", lambda port=8000: True)
    monkeypatch.setattr(native_host, "get_pid_on_port", lambda port=8000: 99)
    monkeypatch.setattr(native_host, "_is_open_tts_process", lambda pid: False)

    ok, msg, token = native_host.start_server()
    assert ok is False
    assert "non-Open-TTS" in msg
    assert token is None


def test_start_server_preserves_own_non_listening_process_during_startup_grace(monkeypatch, tmp_path):
    pid_file = tmp_path / ".server.pid"
    pid_file.write_text("4242")
    monkeypatch.setattr(native_host, "PID_FILE", pid_file)
    monkeypatch.setattr(native_host, "is_port_in_use", lambda port=8000: False)
    monkeypatch.setattr(native_host, "_is_open_tts_process", lambda pid: pid == 4242)
    monkeypatch.setattr(native_host.os, "kill", lambda pid, sig: None)
    monkeypatch.setattr(native_host, "_read_install_token", lambda: "tok")
    killed = []
    monkeypatch.setattr(native_host, "_kill_process_group", lambda pid, sig: killed.append((pid, sig)))

    ok, msg, token = native_host.start_server()

    assert ok is True
    assert "starting" in msg.lower()
    assert token == "tok"
    assert killed == []