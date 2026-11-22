#!/usr/bin/env sh
# Install the Graphify CLI into ./.tools so it survives a PaaS build → runtime
# handoff (Render keeps only the project directory). lib/indexer.js picks up
# ./.tools/bin/graphify automatically. Best effort: if this fails, the seeded
# demo maps still work and live indexing reports a clear error.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS="$ROOT/.tools"

if [ -x "$TOOLS/bin/graphify" ]; then
  echo "graphify already installed: $("$TOOLS/bin/graphify" --version 2>/dev/null)"
  exit 0
fi

mkdir -p "$TOOLS"
if ! command -v uv >/dev/null 2>&1 && [ ! -x "$TOOLS/uv/uv" ]; then
  curl -LsSf https://astral.sh/uv/install.sh \
    | env UV_INSTALL_DIR="$TOOLS/uv" UV_NO_MODIFY_PATH=1 sh || { echo "warn: uv install failed; live indexing disabled"; exit 0; }
fi
UV="$(command -v uv 2>/dev/null || echo "$TOOLS/uv/uv")"

env UV_TOOL_DIR="$TOOLS/uv-tools" UV_TOOL_BIN_DIR="$TOOLS/bin" \
    UV_PYTHON_INSTALL_DIR="$TOOLS/python" \
    "$UV" tool install --force graphifyy \
  || { echo "warn: graphify install failed; live indexing disabled"; exit 0; }

"$TOOLS/bin/graphify" --version || true
