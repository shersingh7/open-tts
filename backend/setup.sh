#!/bin/bash
# Setup script for Open TTS Server
set -euo pipefail

echo "================================================"
echo "  Open TTS Server Setup"
echo "================================================"

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

DOWNLOAD_QWEN=0
DOWNLOAD_FISH=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-qwen) DOWNLOAD_QWEN=1; shift ;;
    --with-fish) DOWNLOAD_FISH=1; shift ;;
    --all-models) DOWNLOAD_QWEN=1; DOWNLOAD_FISH=1; shift ;;
    *) echo "Unknown option: $1"; echo "Usage: ./setup.sh [--with-qwen] [--with-fish] [--all-models]"; exit 1 ;;
  esac
done

echo ""
echo "[1/5] Checking Python version..."
if command -v python3.12 &> /dev/null; then
  PYTHON_CMD="python3.12"
else
  PYTHON_CMD="python3"
fi
$PYTHON_CMD --version

echo ""
echo "[2/5] Creating virtual environment..."
if [ ! -d "venv" ]; then
  $PYTHON_CMD -m venv venv
  echo "✓ Virtual environment created"
else
  echo "✓ Virtual environment already exists"
fi

echo ""
echo "[3/5] Installing dependencies..."
source venv/bin/activate
pip install -U pip
pip install -r requirements.txt
pip check
echo "✓ Dependencies installed"

echo ""
echo "[3b/5] Signing native libraries (macOS Gatekeeper)..."
chmod +x sign_native_dylibs.sh
./sign_native_dylibs.sh

echo ""
echo "[4/5] Downloading Kokoro model (~170 MB, default)..."
hf download mlx-community/Kokoro-82M-bf16 --local-dir ./models/kokoro-82M
echo "✓ Kokoro downloaded"

if [ "$DOWNLOAD_QWEN" = "1" ]; then
  echo ""
  echo "[5a/5] Downloading Qwen3-TTS model (2.9 GB, optional)..."
  hf download mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit --local-dir ./models/qwen3-tts-8bit
  echo "✓ Qwen3-TTS downloaded"
else
  echo ""
  echo "[5a/5] Skipping Qwen3-TTS (on-demand). Re-run with --with-qwen to download."
fi

if [ "$DOWNLOAD_FISH" = "1" ]; then
  echo ""
  echo "[5b/5] Downloading Fish Audio S2 Pro model (6.3 GB, optional)..."
  hf download mlx-community/fish-audio-s2-pro-8bit --local-dir ./models/fish-audio-s2-pro-8bit
  echo "✓ Fish Audio S2 Pro downloaded"
else
  echo ""
  echo "[5b/5] Skipping Fish S2 Pro (on-demand). Re-run with --with-fish to download."
fi

echo ""
echo "================================================"
echo "  ✓ Setup Complete!"
echo "================================================"
echo ""
echo "Start server: source venv/bin/activate && python server.py"
echo "Optional models: ./setup.sh --with-qwen --with-fish"
echo "Native host: ./install_native_host.sh --extension-id <chrome_extension_id>"