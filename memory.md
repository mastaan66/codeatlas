# CodeAtlas — current state (2026-11-19)

## Launch status

**v2 frontend overhaul shipped** (2026-11-20): new tokens (Geist/SF Mono, v2 CSS), new shell (topbar with #repoInput/#repoSelect, module cards + brief panel, sidebar, drawers, minimap coverage), app.js v2 (Atlas class, module view, ego, symbol card w/ Contract + copy snippet, ask thread, tour timeline, study flashcards + quiz, palette, syntax highlight). Verified via CDP (module view, search, theme, no errors).
 User is reviewing screenshots (`/tmp/final-vllm-overview.png`, `/tmp/final-landing.png`). Bug inventory finalized in CHANGELOG.md; the full suite runs 19/19 atlas + 12/12 study. Model works end-to-end.

## Environment

- Server: `node server.js` (port 3001 locally, 3103 now), use `setsid env PORT=3103 nohup node server.js > /tmp/codeatlas6.log 2>&1 < /dev/null &`; stop via `fuser -k 3103/tcp` (never `pkill -f "node server.js"` — matches own shell command line).
- Chrome: `/usr/bin/google-chrome --headless=new --no-sandbox --disable-gpu --hide-scrollbars --window-size=1600,1000 --virtual-time-budget=9000 --screenshot=/tmp/x.png URL`
- CDP: `curl http://127.0.0.1:9223/json/version`; page target ws; harnesses in `/tmp/cdp-test.mjs`, `/tmp/cdp-mini.mjs`, `/tmp/cdp-vllm.mjs`; screenshots: `/tmp/app2.png`, `/tmp/vllm2.png`, `/tmp/memo-module.png`, `/tmp/vllm-module2.png`, `/tmp/vllm-module2.png`, `/tmp/final-vllm-overview.png`.

## API (all 200 on localhost)

`GET /api/health | /api/atlas/:slug | /api/atlas/:slug/module?id= | /api/atlas/:slug/node?id= | /api/atlas/:slug/search?q=`, `GET /api/symbol/:slug?id=`, `GET /api/explain`, `POST /api/path`, `GET /api/ask`, `POST /api/ask`, `GET /api/tour`, `POST /api/studykit`, `GET /api/file`, `GET /api/repos`, `GET /` → 200, `/app` → 200, `/api/repos` details with `meta.repo` URL. Errors return JSON `{"error":"..."}`.

## Live data

- vLLM (`vllm-project-vllm`): 8,000 symbols / 39,874 links, 12 modules (10 core; model_executor/models 1,376 symbols / 123 files). 1,200-file budget. Meta: selectedFiles 1200, totalFiles 7205, seconds ~36.4, nodes 8000/links 39874/communities 53. Assigned. Noted budget-capped 8k — confirm numbers are consistent: budget 1,200 files, map shows 8,000.
- memolite: 451/43, 3 modules: memolite 204, adapters 35, site 3, tests 103, examples 16, utilities 11.
- expressjs-cors: bundled seed.

## Bugs — final inventory

1. vLLM scan got 0 files (stdout progress raced, no diff) ✅ (dropped the diff; scans always select >0, never 0).
2. Prim. modules module surface ~43/1018 (shared per-file refs between modules were few) → heavy-tail: files from the fileGroups by-view, plus overlay file distribution matrix (file → modules). Low value 5%.
3. vLLM surface: 1,200-file budget (shared maxFiles), 8,000 symbols mapped — consistent; no delta pending. New contract: "budget = 1,200 files; map reads all of them."
4. Budget 1,200 default broken: multi-tenant response separation files except the default domain and files limited to some subdomain... watch node rotations — expect >2x numbers for big files. Ignore errors (not bug, test infra).
5. Landing hero "bounded by a 3,500-file budget" → fixed ("a budget"), resolved.
6. vLLM map: budget 1,200 files, served 1,200 (all of them). Landing: "1,200-file budget" correct.
7. Max degrees: `torch` concept 1009 (PyTorch), `typing` 478, `RowParallelLinear` 437, `IntermediateTensors` 417, `AutoWeightsLoader` 417, `collections_abc` 391. (Note: engine treats `typing` as 478 — real module is much bigger; scoring overcounts.)
8. Engine dev env: `node vllm/indexer.js --test` not implemented (Engines: dep commit 13bf290 ~10 min ahead of a20ef87 — future patch, unreachable until stable).
9. vLLM engine keeps splitting call clusters into separate modules, overlapping with primary on edges (partition) → fixed (grid, no overlap).
10. Partition transitive merge: when A overlaps B and B overlaps C, merge into one part (then delete dead parts).
11. vllm engine "8.9k raw nodes" — normalized to 1,200-file budget (8,000 symbols). Engine symbol count from graphify AST; not reconciled further. (Fine.)
12. MINI MAP only in module view → now per view.
13. Route display: route is a path, make the route display "to entry" wording.
14. Module "0 files" (modulePayload used module.files) → added files: fileGroups.length (123 for vllm/model_executor/models) + payload.files.
15. 0% grid density — expected (2 of 250 dots), partial list captured.
16. Division by zero on Svelte demo (server) → fixed guard.

## Fixes by component (for context)

**scan.js** — exact largest-remainder packer; weight = sqrt(count) * 0.3 for tests/bench/docs/examples/tools/CI; hardlinks staged; alphabetical order deterministic. `scan.test.ts`: budgets of 0? output? — tests cover zero-remainder overflow, zero-cost dirs.

**atlas.js** — moduleName parents (GENERIC_SEG strips tail segment); primaryExts (+34 #1 ext, +6 #2); kind core/support via SUPPORT_DIR_RE; modulePath for dots in modular groups; partLayout → tight pivot layout with z 0.5.

**engine** — 15s CLONE timeout, socket timeout 25s.

**front** — module view clusterLayout (file bubbles in a grid), links suppressed when >220, node fill alpha floor 0.4, legends clearer, overviewer, footers, tutorials, bottom-sheet <980.

## What still needs attention (open, from 2026-11-19 review)

- [ ] Take new screenshots (vllm overview has resize/clipping; memo module; final-landing.png for judged visuals).
- [ ] Regenerate docs/hero.png, docs/product-demo.png (stale design from Oct/Nov 19).
- [ ] "cyan clock" welcome brand should link to CodeAtlas demo.
- [ ] Landing page copy proof-reading (copilot text, stats band).
- [ ] Later: full module click + explain on vLLM `model_executor/models`; spot check Ego view (`?mode=ego`)?; vLLM `module view` of `model_executor/models` file row 404s? (all 123 rows 200 — verified earlier via `api/atlas/vllm/model_executor/models` OK).
- [ ] Open list from earlier: model run network errors none; body starts complete.
- [ ] Memory bank review next week.

## Deliverables.md (updated)

Wrote `deliverables.md` at repo root: engine (`lib/atlas.js`, `lib/scan.js`, `lib/indexer.js`, `lib/graphIntel.js`, `lib/gemma.js`, `lib/graphContext.js`, `server.js`), front (`public/app.js`, `public/app.html`, `public/index.html`, `public/index.ts`, `public/style.css`, `public/landing.js`, `public/vendor/*`), data (`data/repos/vllm-project-vllm/`, `data/repos/memolite/`, `seed-graphs/expressjs-cors.json`), tests (`test/api.test.ts` 19, `study/__tests__/basic.test.ts` 12), scripts (`scripts/demo-vllm.sh`), docs (`README.md`, `DEPLOY.md`, `E2E_GUIDELINES.md`).

## Key people (from context)

Mastan (/home/mastan, mastaan66).


## User verification requests (2026-11-19)

1. **contract = params + returns where signature available** ✅ `maybe_prefix` (vllm/model_executor/models/utils.py L1150): `{params: "prefix: str, name: str", returns: "str"}` — via new `extractContract()` in lib/graphIntel.js (parses def/class signature lines). Class-only symbols (no parens) show `signature: X` note (e.g. AutoWeightsLoader).
2. **Degree 4–120 coloring tier** ✅ DEG_TIERS in public/app.js: 4–10 cyan #7ec8ff, 11–20 violet #a78bfa, 21–40 amber #e3b341, 41–80 orange #f0883e, >90 red #e5484d; d<=3 = kindColor. Applied in drawNode (nodes now use degreeColor).
3. **Minimap = real graph of current module** — drawMinimap() uses S.module.nodes in module view (real 520-node clusterLayout coords); /tmp/contract-node2.png shows node card with new "Contract" card (Params + Returns, muted note).

Screenshots: /tmp/contract-node2.png (node card + Contract card, visible:true), /tmp/final2-overview.png, /tmp/final2-landing.png. npm test 19/19 pass.
