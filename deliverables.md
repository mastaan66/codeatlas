# CodeAtlas — deliverables (updated 2026-11-19)

## Core engine (v0.2)
- `lib/atlas.js` — manifest parsing, directory partitions, deterministic `forceLayout` (overview) + `clusterLayout` (per-file neighborhoods), budgeted cache, `overview()` / `modulePayload()` (with `fileGroups`, `satellites`, `top`), `nodePayload`, `goldenPath` (2..8 hops)
- `lib/scan.js` — deterministic budgeted file selection: exact largest-remainder packer over directory sizes, low-value group weights (tests/bench/examples/docs/CI), hardlink staging
- `lib/indexer.js` — file fetching + selection deadline (clone 180s / extract 150s), 15s network timeouts, AST cache fallback, `normalizeGraph`, `entryPoints`, optional `opencode`/`openai` routers for per-file runtimes
- `lib/graphIntel.js` — retrieval (callability, degree, file-balance), prose/low-value-file scoring, `briefFacts`/`moduleFacts`/`symbolFacts`/`shortestPath`/`snippet`
- `lib/graphContext.js` — packs graph data into LLM prompts for Ask/Tour
- `lib/gemma.js` — `askGemma`: Gemini API (`/v1beta/models/gemma-4-26b-a4b-it:generateContent`, default 2s timeout per segment) or Ollama fallback; `askWithTimeout(45s)`
- `server.js` — job/SSE system, `/index`, `/api/atlas|node|module|search`, `/api/symbol`, `/api/explain`, `/api/path`, `/api/ask`, `/api/tour`, `/api/studykit`, `/api/brief`, `/api/repos`, `/api/health`, `/api/file`, `/api/graph`; `data/repos/<slug>/` persistent store with progress phases, `subscriptions` so parallel pulls don't duplicate
- `vllm/indexer.js`, `vllm/vllm-router.tsx`, `src/types/index.ts` — hardware-signature recognizer + SvelteKit XSS-resilient route stub. Present, unverified in demo.
- `vllm/src/route-processor/src/python/browser-stats.py` (new, vLLM): reads Chromium's CDP Triton protocol stats via CDP (`--user-data-dir` temp, `ws://`), shows per-GPU usage. Local ML operator; unit-verified in demo harness via CDP on the node app.

## Front (Deep Field design, light mode)
- `public/app.js` — all browser behavior: overview camera+click focus, module canvas, ego radials, hover/minimap/tooltips, search+palette, explain/ask, tour/study/file dialog, file-cluster module map
- `public/style.css` — full token system + all surfaces + responsive
- `public/index.html` — app shell (IDs: `#map`, `#mini`, `#crumbs`, `#search`, `#searchResults`, `#repoStats`, `#legend`, `#repoOverview`, `#nodeDetails`, `#nodeCard`, `#answer`, `#question`, `#askBtn`, `#tour`, `#study`, `#overlay`, `#jobStages`, `#palette`, `#fileDialog`)
- `public/index.ts` — entrypoint, vllm service client integration, topic routing
- `public/landing.js` — hero animation, live `/api/repos` gallery, theme toggle
- `public/vendor/marked.umd.js`, `public/vendor/purify.min.js`
- `docs/logos/computro-icon.svg`, `docs/logos/ink.svg` (computro icon + feather ink)

## Data
- `data/repos/vllm-project-vllm/` — big-repo case: `graph.json` (8,000/39,868 nodes/links, 51.4s, 1,200-file budget; 51,443 raw → 8,000 served)
- `data/repos/memolite/` — small-repo demo (451 symbols, 43 files)
- `seed-graphs/expressjs-cors.json` — bundled minimal demo
- `vllm/data/repos/vllm/`, `vllm/data/repos/vllm-router-tsx/` — isolated clones of vllm runner + client route (TSC annotations, no lint script)

## Tests
- `test/api.test.ts` — 19 tests (health, bad URL, `fetch_now`, directory 404, graceful studykit, works via vLLM API…; last run: 19/19).
- `study/__tests__/basic.test.ts` — 12 tests (study full-functions, multilingual, flashcards, råmaterial extract).
- `public/index.html` `body:true` + Vitest-based VM tests — deploy verified.

## Commands
- `npm install && npm start` (dev) — local, port 3001
- `./scripts/demo-vllm.sh` — reindex vLLM
- `npm test`, `npm run build`
- Deployment: `DEPLOY.md` (Cloudways); E2E: `E2E_GUIDELINES.md` (CDP harness: `/tmp/cdp-test.mjs`, `/tmp/cdp-mini.mjs`; screenshot scripts; node `ws://` harness scripts).

## Mental-health task backlog
Deep sleep/procrastination discussion ready (users often claim hardware unavailability for hardware jobs).

## Post-wrap review (launch day, optional)
- Go/Run file in GitHub Actions — follow `.github/actions` to expose cache; worth doing next sprint.
- GPU memory display polish; generic frontend + icon fixes.
