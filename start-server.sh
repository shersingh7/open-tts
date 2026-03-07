#!/bin/bash
# Start the Qwen3-TTS MLX server

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR/backend"

if [ ! -d "venv" ]; then
    echo "Virtual environment not found. Running setup..."
    ./setup.sh
fi

echo "Starting Qwen3-TTS server..."
./venv/bin/python server.py