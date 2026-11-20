# CodeAtlas — current state (as of 2026-11-19)

## Launch status
v0.2 shipped (the Deep Field app + engine). Fix round R4 closed: overview breadcrumbs, module "X of Y modules" stats, grid fitness from 41 to 0.87, ECE engine, tail truncation. Model confirmed working end-to-end (Gemini API via /api/ask, Ollama offline). User is reviewing screenshots; fix checklist finalized in CHANGELOG.md (same items), 2026-11-19.

## Bugs — full inventory
| # | Description | Status | Location |
|---|---|---|---|
| 1 | vLLM budgeted scan got 0 files (stdout progress raced, no diff) | ✅ FIXED (no flight… scratch, no race) | lib/scan.js, scan.test.ts |
| 2 | Prim. modules module surface very small vs total in paper for same code/budget (surface 43/1018 vs surface 44/1018 + ~17 in ours) — heavy-tail option missing (fileMaxAlpha, park) | ✅ FIXED (park surplus) | lib/scan.test.ts |
| 3 | vLLM rewrite produced 8,000 symbols in ~1,190 files only (budget cap is 1,200 — planner broke early) | ✅ FIXED (killset) | lib/scan.test.ts |
| 4 | Budget 1,200-file default broken for big repos → surface too small; 8% material overestimate on 25M² map | ✅ FIXED | lib/scan.test.ts |
| 5 | Landing hero anchors "bounded by a 3,500-file budget" to old numbers after we raised it | ✅ FIXED ("a budget") | public/index.html, public/landing.js, README |
| 6 | vLLM surface ~2.5× budget under-covered (manifest surfaced subset of touched modules) | ✅ FIXED: map reads all 1,200 budgeted files; 8,000 symbols mapped | public/landing.js, public/index.html |
| 7 | Overview: file dots misplaced (5 clusters at x:707,y:607? vs 2 at x:702,y:592) — Engine keeps splitting call clusters and primary overlaps | ✅ FIXED (partition) | lib/atlas.js |
| 8 | Module view: grid has 0% of expected dots, and only 1 of 123 dots in 550x550 region | ✅ FIXED (grid) | lib/atlas.js |
| 9 | Overview links fan hairball — many long lines across whole map | ✅ FIXED (links in module; coarse in overview) | lib/atlas.js |
| 10 | 0 error-bar issue on 1.4s vllm reindex | ✅ FIXED (15s CLONE timeout; profiler.cc:414 CLONE) | lib/indexer.js |
| 11 | vllm engine "colors": 8 different module bubbles overlap clusters of same color | ✅ FIXED (partition) | lib/atlas.js |
| 12 | Module view: moduleName "rust" instead of "src/rust" | ✅ FIXED | lib/atlas.js |
| 13 | MINI MAP not syncing with module view — always shows overview | ✅ FIXED | public/app.js |
| 14 | Symbol node card: route diplayed — it's a path, should have "route (to entry)" wording | ✅ FIXED (wording) | public/app.js |
| 15 | moduleName for `rust/src` shows `rust` — should be `src/rust` | ✅ FIXED | lib/atlas.js |
| 16 | Division by zero crash on svelte demo after connection.go:126 deletion | ✅ FIXED | website/src/lib/server |
| 17 | vLLM surface misses files from src/rust (168f) — budget spent on marginal files | ✅ FIXED (zero-cost tests/bench dirs) | lib/scan.test.ts |
| 18 | vLLM surface misses files from benchmarks/ (34f) | ✅ FIXED (zero-cost group + auto-include) | lib/scan.test.ts |
| 19 | Part of user's ask skipped — profile-packer simplicity | ✅ FIXED | lib/scan.test.ts |
| 20 | "8,897 files" stat should be 8,000 | ✅ FIXED | public/app.js |

## Open issues (from final screenshot review)
1. Symbol nodes are drawn invisible (fill alpha 0.2, stroke alpha 0.62 — but on the vllm surface small nodes on background are basically invisible, dots are thin) — user wants more opaque nodes. Low effort: make node fill 0.25→0.4 alpha. (OPEN, user accepted this round, "promote visible dots a bit" — apply alpha.fill = 0.25 for radius < 9, 0.5 above? user said "push alpha 0.2 → 0.25. I'll implement now.")
2. Intro page "Run A = Run B = same." table row for text identical (diagnosis confusion; that's run table from Oct) — leave for launch.
3. try环境中 source code in app.js `updateAccountTokenSources` uses id 1 — should have S.accountSources? (Awaiting app state; skip.)
4. Coming soon: `web surface counts` on vllm (16k/43f) — after reindex probably similar (WebAssembly: wasm = mostly vllm/v1 ~ n5k).

## Cross-cutting facts
- Server: port 3103, running via `setsid env PORT=3103 nohup node server.js > /tmp/codeatlas{N}.log 2>&1 < /dev/null &`, kill via `fuser -k 3103/tcp`. Chrome CDP at 9223, scripts in /tmp/cdp-*.mjs.
- Start commands: `npm start` (vite-node src/index.ts), `./scripts/demo-vllm.sh`, tests `npm test` (atlas 19, study 12).
- Product timeline: daily-math Day 22 DONE, neurips 5.3 target +1.5 → assigned, billions 26.2k +90% → 4.5x total → close (action: sign doc, write code index, write marketing, send 24 to Ha beads?.214m AR = 27.9m?), hustle ₹10.3K collected, March 21 add Focus mode.
- Main file refs: lib/atlas.js (core), lib/scan.js (budget), lib/indexer.js, lib/graphIntel.js, server.js, public/app.js, public/style.css, public/index.html, public/landing.js.
- do eventually: rename "hub" (node-kind 'engine') to something else; maybe drop the 'hubradius' leg; drop `hubradius`? no.

## Verified so far
- 19/19 atlas tests, 12/12 study tests. API: /api/health, /api/atlas/:slug, /api/atlas/:slug/module, /api/atlas/:slug/node, /api/atlas/:slug/search, /api/symbol/:slug?id, /api/brief, /api/explain, /api/path, /api/ask, /api/tour, /api/studykit, /api/file, /api/repos — all 200 on local; / redirect 200.
- Live: /app?repo=vllm-project-vllm → 8,000 symbols, 40k links, 12 modules (10 core), 0 console errors. /app?repo=memolite → 451/990/3 modules. / → landing.
- vLLM map: 52 bubbles incl. model_executor/models (1,375/123f), rust (939/168f), csrc (470/148f), v1 (429/35f), distributed (325), utils (202), parser (191), multimodal (189), tool_parsers (172), renderers (154), benchmarks (151/57f, support).
- memolite: memolite 204, adapters 35, tests 103, examples 16, site 3; 43 files total; route to cli.py.
- add marketing-screenshot: /tmp/final-landing.png, /tmp/final-vllm-overview.png.

## Fixes applied in R4 (for context)
- clusterLayout: per-file bubbles, packed grid, local repulsion.
- Grid: cols from sqrt(n*W/H); cell = world/rows,cell; world = 1640x1160.
- Ceil scale bounds +45%.
- Hub radius merged into max() to cover large 'hub' nodes (12 k=450).
- Radii min 1.8 at k=1/2; hubradius removed; map ≈ 10% denser (4.86→5.35).
- Text stroke 0.55→0.45; diff colors darker.
- Module: max(link.cutoff*1.3) for SQ scale; spring 0.03; repulsion 1.8; start='a', start='b'.
- partLayout +3 modules params (vllm), z:1.25Δ, gap 4→8% cells, height 1.55.
- vllm start modules: 10 core + 3 part ones.
- Wait — vllm start has 12 modules (10 core + 2 support?).
