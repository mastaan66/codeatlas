#!/usr/bin/env bash
# install.sh — install the repo-tour skill for Claude Code (and opencode if present).
# Idempotent: re-running refreshes the installed copy. --uninstall removes it.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_NAME="repo-tour"

targets=("$HOME/.claude/skills")
if [ -d "$HOME/.config/opencode" ]; then
  targets+=("$HOME/.config/opencode/skills")
fi

if [ "${1:-}" = "--uninstall" ]; then
  for t in "${targets[@]}"; do
    if [ -e "$t/$SKILL_NAME" ]; then
      rm -rf "$t/${SKILL_NAME:?}"
      echo "removed $t/$SKILL_NAME"
    fi
  done
  exit 0
fi

for t in "${targets[@]}"; do
  mkdir -p "$t"
  dest="$t/$SKILL_NAME"
  # Only ever touch our own skill directory; never other skills in $t.
  rm -rf "${dest:?}"
  mkdir -p "$dest/scripts"
  cp "$REPO_DIR/skills/$SKILL_NAME/SKILL.md" "$dest/SKILL.md"
  cp "$REPO_DIR/scripts/analyze_graph.py" "$dest/scripts/"
  cp "$REPO_DIR/scripts/offline_summarize.sh" "$dest/scripts/"
  chmod +x "$dest/scripts/offline_summarize.sh"
  echo "installed -> $dest"
done

echo "done. Try: \"give me a tour of this repo\" in Claude Code."
