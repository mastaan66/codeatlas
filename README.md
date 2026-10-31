# ⬢ CodeAtlas

**Paste a GitHub repo. Get a living map of the codebase — and a Gemma 4 guide who's actually read it. Humans get the atlas; your coding agent gets the same graph as a skill.**

Built at Hacktoberfest Hack Day Hyderabad × AI Community Hyderabad, 31 Oct 2026.

## The problem

Joining a codebase is the slowest part of contributing to open source. READMEs go stale; grepping gives you trees, never the forest. And it's not just humans anymore — coding agents burn their context windows rediscovering the same structure on every task.

CodeAtlas builds one ground truth — a [Graphify](https://github.com/Graphify-Labs/graphify) knowledge graph — and serves it to every consumer:

| Surface | Consumer | What they get |
|---|---|---|
| **The atlas** (web app) | humans exploring | interactive force-graph map, search, file viewer |
| **Ask & Tour** (Gemma 4) | humans learning | graph-grounded Q&A + a generated onboarding tour |
| **repo-tour** (`agent-skill/`) | coding agents | an installable skill that writes ONBOARDING / ARCHITECTURE / GOOD-FIRST-SPOTS docs from the graph — fully offline-capable on open-weight Gemma |

Same `graph.json`. One use case — *understand this codebase* — three doors in.

## What it does

1. **Map** — paste a GitHub URL. CodeAtlas shallow-clones it and runs [Graphify](https://github.com/Graphify-Labs/graphify) extraction: local tree-sitter AST parsing (no model calls, cloned code is parsed, never executed). Out comes a graph of symbols, relationships, and auto-detected modules (communities).
2. **Explore** — a force-directed map in the browser. Color = module, size = connectivity. Search, drag, zoom, click any symbol for its file and location.
3. **Ask** — questions like *"how does authentication reach the database?"* are answered by **Gemma 4**, grounded in a context pack built from the graph (matched symbols + their edges + the repo's hub nodes). The prompt forbids inventing symbols not present in the graph.
4. **Tour** — one click generates a numbered onboarding tour: entry points → core modules → where to make your first change.

## Screenshots

**Explore** — memolite mapped: 451 symbols, 990 links, 18 auto-detected modules.

![Knowledge graph of memolite](docs/screenshots/graph.png)

**Ask** — Gemma 4 answers from the graph, with file:line citations.

![Ask tab answering a question about the CLI and storage layer](docs/screenshots/ask.png)

**Tour** — one-click numbered onboarding tour generated from the graph.

![Generated onboarding tour for memolite](docs/screenshots/tour.png)

## Tracks

| Track | How CodeAtlas qualifies |
|---|---|
| Best Use of Graphify | Graphify's knowledge graph is the core data structure: the viz, the Q&A grounding, the tour, and the agent skill are all built from `graph.json` |
| Best Use of Gemma 4 | All reasoning runs on Gemma 4 — `gemma-4-26b-a4b-it` via the Gemini API |
| Best Open-Source AI Project | MIT-licensed, **ships an installable agent skill** (`agent-skill/`), and runs fully offline on **open-weight Gemma 4 via Ollama** |
| Best Use of Cloudways | Deployed live on Cloudways — see [DEPLOY.md](DEPLOY.md) |

## The agent skill (`agent-skill/`)

The same graph that powers the atlas installs into Claude Code or opencode as the **repo-tour** skill: say *"give me a tour of this repo"* and the agent generates `ONBOARDING.md`, `ARCHITECTURE.md` (with a mermaid module diagram), and `GOOD-FIRST-SPOTS.md` — grounded in the graph, never invented, and generatable fully offline via local open-weight Gemma. See [agent-skill/README.md](agent-skill/README.md); real example output for a 451-symbol repo is committed under [agent-skill/examples/memolite/](agent-skill/examples/memolite/).

```bash
cd agent-skill && ./install.sh   # installs the skill into Claude Code (and opencode if present)
```

## Architecture

```
browser (d3 force graph, vanilla JS)
   │ REST
Express (Node 22)
   ├── lib/indexer.js      git shallow-clone → graphify extract --code-only → graph.json
   ├── lib/graphContext.js graph → compact grounded context (question match / tour digest)
   └── lib/gemma.js        Gemma 4 via Gemini API ⇄ automatic fallback to local Ollama gemma4
```

## Run it

```bash
npm install
cp .env.example .env   # add GEMINI_API_KEY (optional — falls back to local Ollama gemma4)
npm start              # http://localhost:3001
```

Requires: Node ≥ 20, `git`, and the Graphify CLI (`uv tool install graphifyy`). For offline mode: Ollama with `ollama pull gemma4`.

## Tests

[![CI](https://github.com/mastaan66/codeatlas/actions/workflows/ci.yml/badge.svg)](https://github.com/mastaan66/codeatlas/actions/workflows/ci.yml)

```bash
npm test
```

15 fast tests on `node:test` (zero extra dependencies): slug sanitizing and GitHub-URL validation in `lib/indexer.js`, seed-graph loading (link integrity, degrees, stats), Gemma prompt context builders, and an integration pass that boots the real server on a test port (`:3100`) and exercises the API — health, repos, graph, path-traversal slugs, and bad-input 400s. Tests never call Gemini or Ollama: the API key is blanked and the Ollama URL points at a dead port. CI runs on every push/PR via GitHub Actions.

## Scalability

- **Stateless server** — graphs and tours are cached on disk keyed by repo slug; the data dir can move to shared/object storage, so instances scale horizontally behind a load balancer.
- **Bounded payloads** — graphs are trimmed to the top 4,000 symbols by connectivity before serving, so a monorepo can't blow up the browser.
- **Extraction is local and cheap** — tree-sitter AST parsing, zero model calls to index; LLM calls happen only on user questions and are cache-friendly (tours cached).
- **Model-agnostic edge** — provider and model are env-switchable (`GEMINI_API_KEY`, `GEMMA_MODEL`, `OLLAMA_URL`).

## Security notes

- Repo URLs validated against a strict GitHub pattern; slugs sanitized.
- All child processes use `execFile` with argument arrays — no shell interpolation.
- Cloned repositories are **parsed, never executed**.

## Honest tooling disclosure

Built during the event with AI pair-programming (Claude Code); commits carry co-author trailers. Gemma 4 powers the product itself.

## License

MIT © 2026 Mastan
