#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
OUTPUT="${BRIDGE_OUTPUT:-$HOME/Assets/orca-t3-bridge/files/macos}"
npm run build
swift build --package-path macos -c release --jobs 4 --arch arm64 --arch x86_64 --product OrcaT3
BINARY_DIR="$(swift build --package-path macos -c release --arch arm64 --arch x86_64 --show-bin-path)"
python3 scripts/package-macos.py "$BINARY_DIR/OrcaT3" "$OUTPUT"
