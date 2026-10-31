#!/usr/bin/env bash
# offline_summarize.sh — generate a tour section with a local open-weight model.
#
# Reads analyze_graph.py JSON on stdin, writes markdown to stdout.
# Zero cloud calls: everything runs in Ollama on this machine.
#
# Usage:
#   python3 -I scripts/analyze_graph.py graphify-out/graph.json \
#     | scripts/offline_summarize.sh onboarding        > docs/tour/ONBOARDING.md
#   ... | scripts/offline_summarize.sh architecture    > docs/tour/ARCHITECTURE.md
#   ... | scripts/offline_summarize.sh good-first-spots > docs/tour/GOOD-FIRST-SPOTS.md
#
# Env: OLLAMA_MODEL (default gemma4:latest). Local inference may take minutes.
set -euo pipefail

SECTION="${1:-onboarding}"
MODEL="${OLLAMA_MODEL:-gemma4:latest}"

command -v ollama >/dev/null 2>&1 || {
  echo "error: ollama not found; install it or use a cloud agent instead" >&2
  exit 1
}

case "$SECTION" in
  onboarding)
    TASK="Write ONBOARDING.md: a guided reading path for an engineer's first day in this repo. Order: entry_points first (how the program starts), then god_nodes (the load-bearing symbols — say why their degree makes them central), then each community in descending size as a tour stop with 2-3 files to read. Use real file paths and locations from the JSON." ;;
  architecture)
    TASK="Write ARCHITECTURE.md: one short section per community of size >= 5 (name, size, top files, key symbols, role), then a mermaid 'graph LR' diagram with one node per community and one arrow per inter_community_edges entry, labelled with the count. Draw ONLY edges present in inter_community_edges." ;;
  good-first-spots)
    TASK="Write GOOD-FIRST-SPOTS.md: a markdown table of good_first_spots (symbol, file:location, degree) grouped by area, with a one-line reason each is safe (low degree = few dependents) and a concrete starter task per group." ;;
  *)
    echo "usage: offline_summarize.sh [onboarding|architecture|good-first-spots] < analysis.json" >&2
    exit 2 ;;
esac

ANALYSIS="$(cat)"

ollama run "$MODEL" <<EOF
You are a senior engineer writing onboarding documentation. Below is a JSON
analysis of this repository's Graphify knowledge graph. It is your ONLY source
of truth: never mention a function, class, or file that does not appear in it.

$TASK

Output pure markdown only — no preamble, no code fences around the whole document.

JSON analysis:
$ANALYSIS
EOF
