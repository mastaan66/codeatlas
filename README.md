# repo-tour

[![CI](https://github.com/mastaan66/repo-tour/actions/workflows/ci.yml/badge.svg)](https://github.com/mastaan66/repo-tour/actions/workflows/ci.yml)

**An agent skill that turns any codebase into an onboarding experience — powered by Graphify's knowledge graph and a local open-weight Gemma model.**

Point your agent (Claude Code, opencode) at a repo and say *"give me a tour of this repo"*. The skill builds/reads the Graphify knowledge graph and generates three documents in `docs/tour/`:

| Document | What it is | How the graph produces it |
|---|---|---|
| `ONBOARDING.md` | A guided reading path: "start here, then this module…" | Entry-point files → god nodes (highest degree) → communities in descending size |
| `ARCHITECTURE.md` | A community-by-community map with a mermaid diagram | Graph communities + inter-community edge counts |
| `GOOD-FIRST-SPOTS.md` | Safe places for a newcomer's first change | Low-degree callable leaf nodes — almost nothing depends on them |

## Why a knowledge graph beats grepping

Onboarding questions are *structural*: where does execution start, what is load-bearing, what can I touch without breaking the world. Grep sees text; the graph sees degree, communities, and edges:

- **God nodes** (highest degree) are the concepts a newcomer must learn first — no amount of grepping ranks `MemoryStore` (degree 104) above a random helper.
- **Communities** are the real modules, discovered from call/containment structure rather than guessed from directory names.
- **Leaf nodes** (degree ≤ 2) are provably low-blast-radius — the graph *guarantees* a good first spot has few dependents.

And because every claim in the generated docs is backed by a node or edge in the graph, the tour can't hallucinate symbols: the bundled analyzer's JSON is the single source of truth.

## How it works

1. `SKILL.md` instructs the agent: ensure `graphify-out/graph.json` exists (else run `graphify extract . --code-only`).
2. `scripts/analyze_graph.py` (pure stdlib, runs with `python3 -I`) distills the node-link graph into structured JSON: communities + top members, god nodes, inter-community edges, leaf callables, entry-point candidates.
3. The agent writes the three documents from that JSON — **never inventing symbols not in the graph**.

## Tracks

- **Best Open-Source AI Project** — this is an agent skill (MIT, zero runtime deps), with a fully offline mode: `scripts/offline_summarize.sh` pipes the analysis into open-weight **Gemma** via Ollama, so the entire tour can be generated with zero cloud calls.
- **Best Use of Graphify** — the graph isn't decoration; it is the ground truth. Degree ranks the reading order, communities shape the architecture map, inter-community edges draw the mermaid diagram, and leaf-ness defines "good first spot". This is deliberately different from Graphify's own skill (which *answers queries* about code): repo-tour *generates onboarding artifacts*.

## Install

```bash
./install.sh            # installs into ~/.claude/skills/ (+ opencode if present)
./install.sh --uninstall
```

Requires: `graphify` on PATH, Python 3. Optional for offline mode: Ollama with a Gemma model (`OLLAMA_MODEL`, default `gemma4:latest`).

## Use

In Claude Code or opencode, inside any repo:

> give me a tour of this repo

Or run the pieces by hand:

```bash
graphify extract . --code-only
python3 -I scripts/analyze_graph.py graphify-out/graph.json        # ground-truth JSON
python3 -I scripts/analyze_graph.py graphify-out/graph.json \
  | scripts/offline_summarize.sh onboarding > docs/tour/ONBOARDING.md   # fully local
```

## Example output

Generated for [memolite](examples/memolite/) (451 nodes, 990 edges, 18 communities). A taste of the analyzer's ground truth:

```json
{
  "summary": {"nodes": 451, "edges": 990, "communities": 18},
  "entry_points": [{"label": "main()", "file": "src/memolite/cli.py", "degree": 11}],
  "god_nodes":    [{"label": "MemoryStore", "file": "src/memolite/store.py", "degree": 104}],
  "good_first_spots": [{"label": "health()", "file": "src/memolite/mcp_server.py", "degree": 1}]
}
```

…and the tour it becomes: [ONBOARDING.md](examples/memolite/ONBOARDING.md) · [ARCHITECTURE.md](examples/memolite/ARCHITECTURE.md) · [GOOD-FIRST-SPOTS.md](examples/memolite/GOOD-FIRST-SPOTS.md)

## Tests

```bash
python3 -m unittest discover -s tests
```

The suite exercises the analyzer end-to-end (as a subprocess, `python3 -I`) on a small synthetic graph, on the real memolite graph fixture (`tests/fixtures/memolite-graph.json`, 451 nodes / 18 communities), and on malformed input. CI runs it on every push and PR (see `.github/workflows/ci.yml`).

## Layout

```
skills/repo-tour/SKILL.md     the skill definition (step-by-step agent instructions)
scripts/analyze_graph.py      graph.json -> onboarding facts (stdlib only)
scripts/offline_summarize.sh  facts -> markdown via local Gemma (ollama)
install.sh                    idempotent install/uninstall
examples/memolite/            real generated output
```

MIT © 2026 Mastan
