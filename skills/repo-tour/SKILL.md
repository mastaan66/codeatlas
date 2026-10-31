---
name: repo-tour
description: Turn any codebase into an onboarding experience using its Graphify knowledge graph. Use when the user says "give me a tour of this repo", "onboarding docs", "where do I start in this codebase", "help a new engineer ramp up here", "what's a good first issue area", or asks for architecture/onboarding documentation generated from the code itself.
---

# repo-tour — graph-grounded onboarding docs

You will generate three onboarding documents for the current repository, using
its Graphify knowledge graph as the **only** source of truth about structure.
The graph tells you what exists and how it is connected; you add the prose.

**Ground rule: never invent symbols.** Every function, class, or file name you
write in the tour documents must appear in the analyzer's JSON output (or be a
file you personally opened and read). If the graph doesn't show it, don't claim it.

## Step 1 — Ensure a graph exists

Check for `graphify-out/graph.json` in the repo root. If it is missing, build it:

```bash
graphify extract . --code-only
```

(`graphify` must be on PATH or at `~/.local/bin/graphify`. If extraction fails,
tell the user to install Graphify and stop.)

Optionally also run `graphify god-nodes --top 10` for a second opinion on the
most-connected symbols.

## Step 2 — Run the bundled analyzer

Run the analyzer that ships with this skill (stdlib-only, hermetic):

```bash
python3 -I <this skill's directory>/scripts/analyze_graph.py graphify-out/graph.json
```

It prints one JSON document with:

- `summary` — node/edge/community counts
- `entry_points` — callables in main/cli/app/index/server files (where execution starts)
- `god_nodes` — the 10 most-connected symbols (the load-bearing walls)
- `communities` — each cluster: a directory-based `name`, `size`, `top_members`
  (with file + source location + degree), `top_files`
- `inter_community_edges` — cross-cluster edge counts (feeds the mermaid diagram)
- `good_first_spots` — low-degree callable leaf nodes (safe first changes)

Keep this JSON in hand; it is your ground truth for Step 3. You may open a few
of the files it names to enrich descriptions, but structure claims come from it.

## Step 3 — Write the three documents into `docs/tour/`

Create `docs/tour/` in the repo and write:

### `docs/tour/ONBOARDING.md` — the guided reading path
An ordered "day one" path for a new engineer:
1. Start at the top `entry_points` (how the program starts).
2. Then the god nodes — explain *why* each is central (its degree says so).
3. Then walk the communities in descending size, as "stops" on the tour:
   for each, the directory, what its top members suggest it does, and 2–3
   files worth reading, in order. Use real file paths and source locations
   (e.g. `src/x.py:L42`) from the analyzer output.
4. End with "where to go next" pointing at the other two documents.

### `docs/tour/ARCHITECTURE.md` — the community map
- One section per significant community (size ≥ ~5): its name, member count,
  top files, key symbols, and a one-paragraph role description.
- A **mermaid diagram** built strictly from `inter_community_edges`:
  one node per community (labelled with its name), one arrow per inter-community
  pair, optionally weighted (`A -->|18| B`). Merge the two directions of a pair
  if that reads better. Only draw edges the analyzer reported.

### `docs/tour/GOOD-FIRST-SPOTS.md` — safe places for a first change
From `good_first_spots`: a table of symbol, file:location, degree, and why it
is low-risk (a leaf — degree ≤ 2 means almost nothing depends on it). Group by
area, suggest a concrete starter task per group (add a test, a docstring, an
edge-case guard). Note that readers should still run the test suite.

## Step 4 — Offline mode (optional, zero cloud calls)

If the user asked for offline/local generation, or you have no cloud model,
pipe the analyzer output through local Gemma via Ollama instead of writing the
prose yourself:

```bash
python3 -I <skill dir>/scripts/analyze_graph.py graphify-out/graph.json \
  | <skill dir>/scripts/offline_summarize.sh onboarding > docs/tour/ONBOARDING.md
```

(sections: `onboarding`, `architecture`, `good-first-spots`). Local inference
can take minutes per document; warn the user. Review the output before saving —
the no-invented-symbols rule applies to the model's draft too.

## Step 5 — Report

Tell the user the three files were written, give one highlight from each
(e.g. "start in `src/memolite/cli.py:main()`"), and remind them the docs were
derived from the Graphify graph at commit `summary.built_at_commit`.
