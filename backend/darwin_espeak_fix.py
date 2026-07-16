"""macOS Gatekeeper fixes for espeak-ng (Kokoro / misaki / phonemizer).

Import this module before any phonemizer or misaki import on Darwin.
Safe on other platforms (no-op).
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def _venv_root() -> Path | None:
    here = Path(__file__).resolve().parent
    venv = here / "venv"
    if (venv / "bin" / "python").exists():
        return venv
    return None


def isolate_python_path() -> None:
    """Prevent Hermes/other PYTHONPATH from shadowing open-tts site-packages."""
    os.environ.pop("PYTHONPATH", None)
    sys.path[:] = [p for p in sys.path if "hermes-agent" not in p]


def sign_espeak_dylibs() -> int:
    if sys.platform != "darwin":
        return 0
    venv = _venv_root()
    if not venv:
        return 0
    signed = 0
    for dylib in (venv / "lib").rglob("espeakng_loader/*.dylib"):
        if not dylib.is_file():
            continue
        subprocess.run(["xattr", "-d", "com.apple.quarantine", str(dylib)],
                       capture_output=True, check=False)
        r = subprocess.run(
            ["codesign", "--force", "--sign", "-", str(dylib)],
            capture_output=True,
            check=False,
        )
        if r.returncode == 0:
            signed += 1
    return signed


def patch_phonemizer_api() -> bool:
    """Patch phonemizer to ad-hoc sign temp dylib copies (Gatekeeper)."""
    if sys.platform != "darwin":
        return False
    venv = _venv_root()
    if not venv:
        return False
    api_files = list(venv.glob("lib/python*/site-packages/phonemizer/backend/espeak/api.py"))
    if not api_files:
        return False
    api_path = api_files[0]
    text = api_path.read_text(encoding="utf-8")
    marker = "# open-tts: ad-hoc sign espeak temp copy (Gatekeeper)"
    if marker in text:
        return True

    needle = "        shutil.copy(library_path, espeak_copy, follow_symlinks=False)\n"
    if needle not in text:
        return False

    insert = (
        needle
        + "\n"
        + f"        {marker}\n"
        + "        if sys.platform == 'darwin':\n"
        + "            import subprocess as _subprocess\n"
        + "            _subprocess.run(\n"
        + "                ['codesign', '--force', '--sign', '-', str(espeak_copy)],\n"
        + "                check=False,\n"
        + "                capture_output=True,\n"
        + "            )\n"
    )
    api_path.write_text(text.replace(needle, insert, 1), encoding="utf-8")
    return True


def apply_monkeypatch() -> None:
    """Load espeak from signed venv path; skip unsigned temp copy when possible."""
    if sys.platform != "darwin":
        return
    import ctypes as _ctypes
    import pathlib as _pathlib
    import weakref as _weakref

    from phonemizer.backend.espeak.api import EspeakAPI as _EspeakAPI

    def _espeak_init_no_temp_copy(self, library, data_path):
        self._library = None
        lib = str(library)
        # Ensure source dylib is signed before dlopen
        subprocess.run(
            ["codesign", "--force", "--sign", "-", lib],
            capture_output=True,
            check=False,
        )
        if data_path is not None:
            data_path = str(data_path).encode("utf-8")
        try:
            self._library = _ctypes.cdll.LoadLibrary(lib)
        except OSError as error:
            raise RuntimeError(
                f"failed to load espeak library: {error!s}"
            ) from None
        try:
            if self._library.espeak_Initialize(0x02, 0, data_path, 0) <= 0:
                raise RuntimeError("failed to initialize espeak shared library")
        except AttributeError:
            raise RuntimeError("failed to load espeak library") from None
        self._library_path = _pathlib.Path(lib).resolve()
        self._tempdir = None
        _weakref.finalize(self, lambda: None)

    _EspeakAPI.__init__ = _espeak_init_no_temp_copy


def bootstrap() -> None:
    isolate_python_path()
    sign_espeak_dylibs()
    patch_phonemizer_api()
    apply_monkeypatch()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--sign-only", action="store_true")
    args = parser.parse_args()
    isolate_python_path()
    n = sign_espeak_dylibs()
    patched = patch_phonemizer_api() if not args.sign_only else False
    if not args.sign_only:
        apply_monkeypatch()
    print(f"signed {n} dylib(s); phonemizer patched={patched}")
elif sys.platform == "darwin":
    bootstrap()