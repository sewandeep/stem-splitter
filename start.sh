#!/bin/bash
set -e
cd "$(dirname "$0")/backend"
if [ ! -d venv ]; then
  python3 -m venv venv
  ./venv/bin/pip install --upgrade pip -q
  ./venv/bin/pip install -r requirements.txt
fi
echo "Starting Stem Splitter at http://127.0.0.1:8420"
./venv/bin/uvicorn main:app --host 127.0.0.1 --port 8420
