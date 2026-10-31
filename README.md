# ⬢ CodeAtlas

**Paste a GitHub repo. Get a living map of the codebase — and a Gemma 4 guide who's actually read it.**

Built at Hacktoberfest Hack Day Hyderabad × AI Community Hyderabad, 31 Oct 2026.

## The problem

Joining a codebase is the slowest part of contributing to open source. READMEs go stale; grepping gives you trees, never the forest. CodeAtlas turns any public repo into an interactive knowledge graph and puts an AI guide on top of it that answers from the *graph*, not from vibes.

## What it does

1. **Map** — paste a GitHub URL. CodeAtlas shallow-clones it and runs [Graphify](https://github.com/Graphify-Labs/graphify) extraction: local tree-sitter AST parsing (no model calls, cloned code is parsed, never executed). Out comes a graph of symbols, relationships, and auto-detected modules (communities).
2. **Explore** — a force-directed map in the browser. Color = module, size = connectivity. Search, drag, zoom, click any symbol for its file and location.
3. **Ask** — questions like *"how does authentication reach the database?"* are answered by **Gemma 4**, grounded in a context pack built from the graph (matched symbols + their edges + the repo's hub nodes). The prompt forbids inventing symbols not present in the graph.
4. **Tour** — one click generates a numbered onboarding tour: entry points → core modules → where to make your first change.

## Tracks

| Track | How CodeAtlas qualifies |
|---|---|
| Best Use of Graphify | Graphify's knowledge graph is the core data structure: the viz, the Q&A grounding, and the tour are all built from `graph.json` |
| Best Use of Gemma 4 | All reasoning runs on Gemma 4 — `gemma-4-26b-a4b-it` via the Gemini API |
| Best Open-Source AI Project | MIT-licensed; runs fully offline on **open-weight Gemma 4 via Ollama** when no API key is set |
| Best Use of Cloudways | Deployed live on Cloudways (see Deployment) |

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
