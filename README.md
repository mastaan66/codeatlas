# CodeAtlas

[![CI](https://github.com/mastaan66/codeatlas/actions/workflows/ci.yml/badge.svg)](https://github.com/mastaan66/codeatlas/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node >= 20](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](package.json)

**Turn any repo into a living knowledge graph, then serve it to every consumer — humans get an interactive atlas, a Gemma 4 guide, and flashcards; coding agents get the same graph as an installable skill.**

<img src="docs/architecture.png" width="100%" alt="Hand-drawn architecture sketch: a GitHub repo URL flows into graphify extract (tree-sitter AST, local, no LLM), producing graph.json — the knowledge graph. Four arrows fan out to the surfaces: Map (d3 force atlas, humans explore), Ask + Tour (Gemma 4, graph-grounded, humans learn), Study (flashcards and quiz from the graph, humans drill), and the repo-tour agent skill (ONBOARDING / ARCHITECTURE docs for coding agents). A second input, a photo of your notes, flows into SnapStudy (multimodal Gemma 4 → summary, flashcards, quiz in English and Telugu), joining the Study surface. Engine strip below: Gemma 4 via the Gemini API with a fallback arrow to Ollama (open weights, offline); deployed on Cloudways. Caption: one graph, every consumer.">

```
inputs                     ground truth                 surfaces
──────                     ────────────                 ────────
GitHub repo URL ──▶ graphify extract ──▶ graph.json ──▶ Map    (d3 atlas · humans explore)
                    tree-sitter AST,        │       ├─▶ Ask+Tour (Gemma 4 · humans learn)
                    local, no LLM           │       ├─▶ Study  (flashcards+quiz · humans drill)
                                            │       └─▶ repo-tour skill (docs · coding agents)
photo of notes ──▶ study/ SnapStudy ─ multimodal Gemma 4 ─▶ summary · flashcards · quiz (EN+తెలుగు)

engine: Gemma 4 — Gemini API (hosted) ⇄ Ollama (open weights, offline) · deployed on Cloudways
```

Built at Hacktoberfest Hack Day Hyderabad × AI Community Hyderabad, 31 Oct 2026.

## For the judges

| Track | Where to look |
|---|---|
| **Best Use of Graphify** | The knowledge graph is the product's ground truth: [`lib/indexer.js`](lib/indexer.js) builds it (`graphify extract --code-only`), [`public/app.js`](public/app.js) renders it, [`lib/graphContext.js`](lib/graphContext.js) grounds every Gemma prompt in it, and [`agent-skill/scripts/analyze_graph.py`](agent-skill/scripts/analyze_graph.py) turns it into onboarding docs |
| **Best Use of Gemma 4** | All reasoning is Gemma 4 — `gemma-4-26b-a4b-it` via the **Gemini API** ([`lib/gemma.js`](lib/gemma.js)); multimodal image→study-kit in [`study/lib/gemma.js`](study/lib/gemma.js) with 140-language support demonstrated in English + Telugu |
| **Best Open-Source AI Project** | MIT-licensed; ships an **installable agent skill** ([`agent-skill/`](agent-skill/)); every surface runs **fully offline on open-weight Gemma 4 via Ollama** when no API key is set |
| **Best Use of Cloudways** | Deployed on Cloudways Velocity — steps and graceful-degradation table in [`DEPLOY.md`](DEPLOY.md) |

Proof of work: 40 automated tests across three CI jobs (all offline, no API keys), real incremental commit history from event day, demo videos below.

## 15-second quick start

```bash
# 1. the atlas
npm install
cp .env.example .env     # optional GEMINI_API_KEY — without it, local Ollama gemma4 serves
npm start                # → http://localhost:3001

# 2. the agent skill
cd agent-skill && ./install.sh       # Claude Code + opencode; then say "give me a tour of this repo"

# 3. the study hall (photo → flashcards)
cd study && npm install && npm start # → http://localhost:3002
```

Requires Node ≥ 20 and `git`; live indexing needs the Graphify CLI (`uv tool install graphifyy`); offline mode needs Ollama with `ollama pull gemma4`.

## The problem

Joining a codebase is the slowest part of contributing to open source. READMEs go stale; grepping gives you trees, never the forest. And it's not just humans anymore — coding agents burn their context windows rediscovering the same structure on every task.

CodeAtlas builds one ground truth — a [Graphify] knowledge graph — and opens four doors into it:

| Surface | Consumer | What they get |
|---|---|---|
| **Map** | humans exploring | force-directed atlas: color = module, size = connectivity; search, Meet-style fly-to-focus, click-through file viewer |
| **Ask + Tour** | humans learning | Gemma 4 Q&A grounded in the graph (file:line citations, forbidden from inventing symbols) + a generated onboarding tour |
| **Study** | humans drilling | flashcards and a pop quiz written *from the graph* — onboarding a codebase is studying it; plus [`study/`](study/) turns a photo of handwritten notes into the same study kit, in English or Telugu |
| **repo-tour** | coding agents | installable skill that writes `ONBOARDING.md`, `ARCHITECTURE.md` (mermaid module diagram) and `GOOD-FIRST-SPOTS.md` from the graph — real output committed at [`agent-skill/examples/memolite/`](agent-skill/examples/memolite/) |

Noise stays off the map: manifests, CI yaml, lockfiles and docs are flagged and folded behind a *config & deps* toggle, so modules mean architecture, not plumbing.

## Demos

- **Product walkthrough (55s):** [`docs/demo/codeatlas-demo.mp4`](docs/demo/codeatlas-demo.mp4) — map → spotlight → file viewer → graph-grounded answer → tour → theme flip.
- **Test run (47s):** [`docs/demo/tests-demo.mp4`](docs/demo/tests-demo.mp4) — all three suites green, fully offline.

## Screenshots

**Explore** — memolite mapped; Lumenar "engineer's notebook" design, light and dark.

![Knowledge graph of memolite on a graph-paper canvas with a handwritten modules legend](docs/screenshots/graph.png)

**Ask** — Gemma 4 answers from the graph, with file:line citations.

![Ask tab answering a question about the CLI and storage layer](docs/screenshots/ask.png)

**Tour** — one-click numbered onboarding tour generated from the graph.

![Generated onboarding tour for memolite](docs/screenshots/tour.png)

## Tests

40 tests, three CI jobs, zero network: **19** on `node:test` for the atlas (URL/injection validation, seed-graph integrity, grounded-context builders, live API integration on an isolated port, path-traversal rejection for the file viewer and study kit), **12** for `study/` (strict-JSON parsing, upload validation, provider-failure survival), **9** on `unittest` for `agent-skill/` (synthetic + real 451-node graph fixtures). LLM calls are stubbed out by blanking the key and pointing Ollama at a dead port.

```bash
npm test                                           # atlas (19)
cd study && npm test                               # study hall (12)
cd agent-skill && python3 -m unittest discover -s tests  # agent skill (9)
```

## Scalability

- **Stateless server** — graphs, tours and study kits cache on disk keyed by repo slug; the data dir can move to shared storage, so instances scale horizontally.
- **Bounded payloads** — graphs trim to the top 4,000 symbols by connectivity before serving; a monorepo can't blow up the browser.
- **Cheap indexing** — tree-sitter AST parsing, parallel across cores, zero model calls; shallow `--no-tags` clones; LLM calls happen only on user questions and cache afterward.
- **Model-agnostic edge** — provider and model are env-switchable (`GEMINI_API_KEY`, `GEMMA_MODEL`, `OLLAMA_URL`, `OLLAMA_FALLBACK`).

## Security notes

- Repo URLs validated against a strict GitHub pattern; slugs sanitized; file viewer resolves paths inside the repo dir only (traversal-tested), 200 KB cap, binaries refused.
- All child processes use `execFile` with argument arrays — no shell interpolation. Cloned repositories are **parsed, never executed**.
- No secrets in the repo: `.env` is gitignored everywhere; CI runs with the key blanked.

## Honest tooling disclosure

Built during the event with AI pair-programming (Claude Code); commits carry co-author trailers. Gemma 4 powers the product itself.

## License

MIT © 2026 [Mastan]

[Graphify]: https://github.com/Graphify-Labs/graphify
[Mastan]: https://github.com/mastaan66
