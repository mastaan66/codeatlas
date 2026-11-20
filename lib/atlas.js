// Atlas: turn a raw knowledge graph into a bounded, navigable map.
//
// A 25k-symbol repo cannot be drawn as one hairball. We partition symbols into
// directory-derived modules (adaptive cut, each <= ~220 symbols), aggregate the
// edges between modules, and precompute deterministic layouts. Every payload the
// browser receives is small (< ~2 MB) and every view is stable across reloads.

const path = require('path');
const { loadGraph, readMeta } = require('./indexer');

const MAX_MODULE_SIZE = Number(process.env.ATLAS_MODULE_SIZE || 220);
const MAX_MODULES = Number(process.env.ATLAS_MAX_MODULES || 64);
const MAX_MODULE_NODES = Number(process.env.ATLAS_MODULE_NODES || 520);
const MAX_MODULE_LINKS = Number(process.env.ATLAS_MODULE_LINKS || 1800);
const PREVIEW_SYMBOLS = 22;
const SUPPORT_DIR_RE = /^(tests?|__tests__|spec|specs|benchmarks?|benches|examples?|samples?|docs?|documentation|scripts?|docker|\.github|\.buildkite|\.agents|\.claude)$/i;

const LANGUAGE_BY_EXT = {
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JavaScript',
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.vue': 'Vue', '.svelte': 'Svelte',
  '.py': 'Python', '.pyi': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java',
  '.kt': 'Kotlin', '.kts': 'Kotlin', '.scala': 'Scala', '.c': 'C', '.h': 'C',
  '.cc': 'C++', '.cpp': 'C++', '.cxx': 'C++', '.hpp': 'C++', '.hh': 'C++',
  '.cuh': 'CUDA', '.cu': 'CUDA', '.m': 'Objective-C', '.mm': 'Objective-C',
  '.swift': 'Swift', '.cs': 'C#', '.fs': 'F#', '.rb': 'Ruby', '.php': 'PHP',
  '.lua': 'Lua', '.r': 'R', '.jl': 'Julia', '.ex': 'Elixir', '.exs': 'Elixir',
  '.erl': 'Erlang', '.hs': 'Haskell', '.ml': 'OCaml', '.clj': 'Clojure',
  '.dart': 'Dart', '.zig': 'Zig', '.nim': 'Nim', '.sh': 'Shell', '.sql': 'SQL',
  '.proto': 'Protobuf', '.graphql': 'GraphQL', '.gql': 'GraphQL',
};

function langOf(file) {
  return LANGUAGE_BY_EXT[path.extname(file || '').toLowerCase()] || null;
}

/* --------------------------------------------------------------- directory tree */

function dirOf(file) {
  if (!file) return null;
  const d = path.posix.dirname(file);
  return d === '.' ? '' : d;
}

function segsOf(dir) {
  return dir === '' ? [] : dir.split('/');
}

// Adaptive cut of the directory tree. Start with the whole repo as one module
// and repeatedly split the *largest* splittable directory until every module is
// small enough or we hit the module budget. Large areas keep their structure;
// small ones stay whole.
function partition(nodes) {
  const root = { dir: '', count: 0, leaves: 0, children: new Map() };
  for (const n of nodes) {
    const dir = dirOf(n.file);
    if (dir === null) continue;
    let node = root;
    node.count += 1;
    for (const seg of segsOf(dir)) {
      if (!node.children.has(seg)) {
        node.children.set(seg, { dir: node.dir ? `${node.dir}/${seg}` : seg, count: 0, leaves: 0, children: new Map() });
      }
      node = node.children.get(seg);
      node.count += 1;
    }
    node.leaves += 1;
  }

  let mods = [{ dir: '', count: root.count, tree: root }];
  for (;;) {
    let best = -1;
    for (let i = 0; i < mods.length; i++) {
      const m = mods[i];
      if (!m.tree || m.tree.children.size === 0 || m.count <= MAX_MODULE_SIZE) continue;
      if (best < 0 || m.count > mods[best].count) best = i;
    }
    if (best < 0) break;
    const m = mods[best];
    const parts = [];
    if (m.tree.leaves) parts.push({ dir: m.dir, count: m.tree.leaves, tree: null });
    for (const child of m.tree.children.values()) {
      parts.push({ dir: child.dir, count: child.count, tree: child });
    }
    if (mods.length - 1 + parts.length > MAX_MODULES) break;
    mods.splice(best, 1, ...parts);
    mods.sort((a, b) => b.count - a.count);
  }

  const present = new Set(mods.map((m) => m.dir));
  const bestDirFor = (dir) => {
    if (dir === '' || present.has(dir)) return dir;
    const segs = segsOf(dir);
    for (let k = segs.length; k >= 1; k--) {
      const cand = segs.slice(0, k).join('/');
      if (present.has(cand)) return cand;
    }
    return '';
  };

  const byModule = new Map();
  for (const n of nodes) {
    const dir = dirOf(n.file);
    const key = dir === null ? '__external__' : bestDirFor(dir);
    if (!byModule.has(key)) byModule.set(key, []);
    byModule.get(key).push(n);
  }
  return byModule;
}

const GENERIC_SEG = new Set(['src', 'lib', 'libs', 'app', 'apps', 'pkg', 'internal', 'core', 'main', 'source', 'sources', 'code']);

function moduleName(id, ids) {
  if (id === '__external__') return 'external';
  const segs = segsOf(id);
  if (!segs.length) return 'repository root';
  // "src" or "lib" alone says nothing; include its parent for a readable name.
  const minTake = GENERIC_SEG.has(segs[segs.length - 1]) ? 2 : 1;
  for (const take of [minTake, Math.max(2, minTake), 3]) {
    const cand = segs.slice(-take).join('/');
    const collisions = ids.filter((other) => other !== id && segsOf(other).slice(-take).join('/') === cand).length;
    if (!collisions) return cand;
  }
  return id;
}

/* ------------------------------------------------------------------- layouts */

const TAU = Math.PI * 2;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function phyllotaxis(i, n, radius) {
  const r = radius * Math.sqrt((i + 0.5) / Math.max(1, n));
  const a = i * GOLDEN;
  return { x: r * Math.cos(a), y: r * Math.sin(a) };
}

// Small deterministic force layout. O(n^2) is fine at module scale (< 600);
// repulsion is skipped between distant nodes via a radius cutoff.

// Deterministic file-cluster layout: each source file becomes a small
// neighbourhood, and files are packed into a grid ordered by weight. This
// reads far better than a global force blob when a module holds hundreds of
// symbols, and it mirrors the file list in the inspector.
function clusterLayout(nodes, opts = {}) {
  const width = opts.width || 1600;
  const height = opts.height || 1200;
  const groups = new Map();
  for (const n of nodes) {
    const f = n.file || '—';
    if (!groups.has(f)) groups.set(f, []);
    groups.get(f).push(n);
  }
  const list = [...groups.entries()]
    .map(([file, syms]) => ({
      file,
      syms: [...syms].sort((a, b) => b.degree - a.degree),
      weight: syms.reduce((a, n) => a + n.degree, 0),
    }))
    .sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file));

  const n = list.length;
  const cols = Math.max(1, Math.round(Math.sqrt((n * width) / height)));
  const rows = Math.max(1, Math.ceil(n / cols));
  const cw = width / cols;
  const ch = height / rows;
  const pad = Math.min(cw, ch) * 0.1;

  list.forEach((g, gi) => {
    const col = gi % cols;
    const row = Math.floor(gi / cols);
    const cx = (col + 0.5) * cw - width / 2;
    const cy = (row + 0.5) * ch - height / 2;
    const k = g.syms.length;
    const maxR = Math.max(16, Math.min(cw, ch) * 0.34);
    const spread = clamp(14 + 9 * Math.sqrt(k), 22, maxR);
    const shrink = k > 28 ? 0.56 : k > 14 ? 0.72 : k > 8 ? 0.86 : 1;
    g.syms.forEach((nd, i) => {
      const p = phyllotaxis(i, k, spread);
      nd.x = cx + p.x;
      nd.y = cy + p.y;
      nd.r = Math.round((5 + 2.6 * Math.sqrt(nd.degree)) * shrink * 10) / 10;
    });
    // Light local relaxation so big symbols in the same file do not fuse.
    for (let it = 0; it < 14; it++) {
      for (let a = 0; a < k; a++) {
        for (let b = a + 1; b < k; b++) {
          const A = g.syms[a];
          const B = g.syms[b];
          let dx = B.x - A.x;
          let dy = B.y - A.y;
          const min = (A.r || 6) + (B.r || 6) + 3;
          const d2 = dx * dx + dy * dy;
          if (d2 >= min * min) continue;
          const d = Math.sqrt(d2) || 0.01;
          const push = (min - d) / d * 0.5;
          dx *= push; dy *= push;
          A.x -= dx; A.y -= dy;
          B.x += dx; B.y += dy;
        }
      }
      for (const nd of g.syms) {
        const dx = nd.x - cx;
        const dy = nd.y - cy;
        const d = Math.hypot(dx, dy);
        if (d > maxR + pad) {
          nd.x = cx + (dx / d) * (maxR + pad);
          nd.y = cy + (dy / d) * (maxR + pad);
        }
      }
    }
  });
  return nodes;
}

function forceLayout(nodes, links, opts = {}) {
  const iterations = opts.iterations || 260;
  const spread = opts.spread || 620;
  const n = nodes.length;
  if (n === 0) return nodes;
  const idx = new Map(nodes.map((d, i) => [d.id, i]));
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const rad = new Float64Array(n);
  nodes.forEach((d, i) => {
    const p = phyllotaxis(i, n, spread);
    xs[i] = p.x; ys[i] = p.y;
    rad[i] = opts.radius ? opts.radius(d) : 8;
  });

  const edges = [];
  for (const l of links) {
    const a = idx.get(l.source);
    const b = idx.get(l.target);
    if (a === undefined || b === undefined || a === b) continue;
    edges.push([a, b, l.weight || 1]);
  }

  const k = opts.spring || 70;
  const cutoff = opts.cutoff || 240;
  const cutoff2 = cutoff * cutoff;
  const centerPull = opts.centerPull ?? 0.012;

  for (let it = 0; it < iterations; it++) {
    const alpha = 1 - it / iterations;
    // Repulsion
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = xs[j] - xs[i];
        let dy = ys[j] - ys[i];
        let d2 = dx * dx + dy * dy;
        if (d2 > cutoff2) continue;
        const minD = rad[i] + rad[j] + 10;
        if (d2 < 0.01) { dx = 0.01; dy = 0.01; d2 = 0.0002; }
        const d = Math.sqrt(d2);
        const push = Math.min(1.6, (minD * minD) / Math.max(1, d2)) * 2.2 * alpha;
        const ux = dx / d, uy = dy / d;
        xs[i] -= ux * push; ys[i] -= uy * push;
        xs[j] += ux * push; ys[j] += uy * push;
      }
    }
    // Springs
    for (const [a, b, w] of edges) {
      const dx = xs[b] - xs[a];
      const dy = ys[b] - ys[a];
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const target = k + rad[a] + rad[b];
      const f = ((d - target) / d) * 0.055 * Math.min(3, w) * alpha;
      xs[a] += dx * f; ys[a] += dy * f;
      xs[b] -= dx * f; ys[b] -= dy * f;
    }
    // Center gravity keeps disconnected islands in frame.
    for (let i = 0; i < n; i++) {
      xs[i] *= 1 - centerPull * alpha;
      ys[i] *= 1 - centerPull * alpha;
    }
  }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    if (xs[i] < minX) minX = xs[i];
    if (xs[i] > maxX) maxX = xs[i];
    if (ys[i] < minY) minY = ys[i];
    if (ys[i] > maxY) maxY = ys[i];
  }
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const scale = Math.min((opts.width || 1400) / w, (opts.height || 1000) / h);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  nodes.forEach((d, i) => {
    d.x = (xs[i] - cx) * scale;
    d.y = (ys[i] - cy) * scale;
  });
  return nodes;
}

/* -------------------------------------------------------------------- atlas */

const cache = new Map(); // slug -> { mtimeMs, atlas }

function topBy(list, n, key = 'degree') {
  return [...list].sort((a, b) => b[key] - a[key] || String(a.label).localeCompare(String(b.label))).slice(0, n);
}

function buildAtlas(dataDir, slug) {
  const graph = loadGraph(dataDir, slug);
  const meta = readMeta(dataDir, slug);
  const code = graph.nodes.filter((n) => !n.meta);

  const byModule = partition(code);
  const moduleIds = [...byModule.keys()];
  const degreeByModule = new Map(moduleIds.map((id) => [id, 0]));
  const moduleOf = new Map();

  for (const [id, list] of byModule) {
    for (const n of list) {
      moduleOf.set(n.id, id);
      degreeByModule.set(id, degreeByModule.get(id) + n.degree);
    }
  }

  // Inter-module link weights.
  const pair = new Map();
  for (const l of graph.links) {
    const a = moduleOf.get(l.source);
    const b = moduleOf.get(l.target);
    if (!a || !b || a === b) continue;
    const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
    let rec = pair.get(key);
    if (!rec) { rec = { a, b, weight: 0, rels: new Map() }; pair.set(key, rec); }
    rec.weight += 1;
    if (l.rel) rec.rels.set(l.rel, (rec.rels.get(l.rel) || 0) + 1);
  }

  const moduleList = moduleIds.map((id) => {
    const list = byModule.get(id);
    const files = new Set();
    let callables = 0;
    for (const n of list) {
      if (n.file) files.add(n.file);
      if (n.callable) callables += 1;
    }
    const top = id.split('/')[0];
    return {
      id,
      name: moduleName(id, moduleIds),
      dir: id,
      kind: SUPPORT_DIR_RE.test(top) ? 'support' : 'core',
      count: list.length,
      files: files.size,
      callables,
      degree: degreeByModule.get(id) || 0,
      top: topBy(list, 5).map((n) => ({
        id: n.id, label: n.label, degree: n.degree, kind: n.kind, file: n.file,
      })),
      list,
    };
  }).sort((a, b) => b.count - a.count);

  const languages = {};
  const extCount = new Map();
  for (const n of graph.nodes) {
    const lang = langOf(n.file);
    if (lang) languages[lang] = (languages[lang] || 0) + 1;
    const ext = path.extname(n.file || '').toLowerCase();
    if (ext) extCount.set(ext, (extCount.get(ext) || 0) + 1);
  }
  const primaryExts = [...extCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([e]) => e);

  const atlas = {
    slug,
    graphMtimeMs: graphMtime(dataDir, slug),
    meta,
    graph,
    byModule,
    moduleIds,
    moduleOf,
    moduleList,
    pair,
    stats: { ...graph.stats, communities: moduleIds.length },
    languages: Object.entries(languages).sort((a, b) => b[1] - a[1]).slice(0, 8),
    primaryExts,
    _moduleCache: new Map(),
    _nodeCache: new Map(),
  };
  return atlas;
}

function graphMtime(dataDir, slug) {
  const fs = require('fs');
  const live = path.join(dataDir, 'repos', slug, 'graphify-out', 'graph.json');
  const seed = path.join(__dirname, '..', 'seed-graphs', `${slug}.json`);
  for (const p of [live, seed]) {
    try { return fs.statSync(p).mtimeMs; } catch { /* next */ }
  }
  return 0;
}

function getAtlas(dataDir, slug) {
  const mtime = graphMtime(dataDir, slug);
  const hit = cache.get(slug);
  if (hit && hit.mtimeMs === mtime) return hit.atlas;
  const atlas = buildAtlas(dataDir, slug);
  cache.set(slug, { mtimeMs: mtime, atlas });
  if (cache.size > 4) cache.delete(cache.keys().next().value);
  return atlas;
}

function invalidate(slug) {
  cache.delete(slug);
}

/* ---------------------------------------------------------------- payloads */

function layoutModules(atlas) {
  const mods = atlas.moduleList.map((m) => ({ ...m }));
  const links = [];
  for (const rec of atlas.pair.values()) links.push({ source: rec.a, target: rec.b, weight: rec.weight });
  const maxCount = Math.max(...mods.map((m) => m.count), 1);
  const radius = (m) => 20 + 44 * Math.sqrt(m.count / maxCount);
  // Small repos should not be spread to the corners of a large world.
  const spread = Math.max(330, Math.min(540, 280 + mods.length * 26));
  forceLayout(mods, links, {
    iterations: 300,
    spread,
    spring: 62,
    width: 1500,
    height: 1000,
    radius,
    centerPull: 0.02,
  });
  mods.forEach((m) => { m.r = radius(m); });
  return { mods, links };
}

function overview(dataDir, slug, { includeMeta = false } = {}) {
  const atlas = getAtlas(dataDir, slug);
  const { mods, links } = layoutModules(atlas);
  const byId = new Map(mods.map((m) => [m.id, m]));

  // The canvas shows the modules that carry the architecture; tiny leaf
  // modules stay reachable from the rail and search but would only add clutter.
  const countable = mods;
  const totalCount = countable.reduce((n, m) => n + m.count, 0) || 1;
  const byCount = [...countable].sort((a, b) => b.count - a.count);
  const primaryIds = new Set();
  let covered = 0;
  for (const m of byCount) {
    if (primaryIds.size >= 14) break;
    primaryIds.add(m.id);
    covered += m.count;
    if (primaryIds.size >= 8 && covered / totalCount >= 0.8) break;
  }

  const modules = mods.map((m, rank) => {
    const preview = topBy(m.list, PREVIEW_SYMBOLS).map((n, i) => {
      const p = phyllotaxis(i, PREVIEW_SYMBOLS, 1);
      return {
        id: n.id,
        label: n.label,
        kind: n.kind,
        x: Number(p.x.toFixed(3)),
        y: Number(p.y.toFixed(3)),
        degree: n.degree,
      };
    });
    return {
      id: m.id,
      name: m.name,
      dir: m.dir,
      kind: m.kind,
      count: m.count,
      files: m.files,
      callables: m.callables,
      degree: m.degree,
      rank,
      primary: primaryIds.has(m.id),
      x: Math.round(m.x), y: Math.round(m.y), r: Math.round(m.r),
      top: m.top,
      preview,
    };
  });

  // Keep the strongest edges; the canvas fades the rest anyway.
  const seen = new Map();
  for (const rec of atlas.pair.values()) {
    const a = byId.get(rec.a), b = byId.get(rec.b);
    if (!a || !b) continue;
    const key = rec.a < rec.b ? `${rec.a}\u0000${rec.b}` : `${rec.b}\u0000${rec.a}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      source: rec.a,
      target: rec.b,
      weight: rec.weight,
      rels: [...rec.rels.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([r]) => r),
    });
  }
  const moduleLinks = [...seen.values()].sort((a, b) => b.weight - a.weight).slice(0, 500);

  const metaNodes = atlas.graph.nodes.filter((n) => n.meta);
  const metaModules = metaNodes.length
    ? [{ id: '__config__', name: 'config & docs', count: metaNodes.length, x: 0, y: 0 }]
    : [];

  return {
    slug,
    stats: atlas.stats,
    meta: atlas.meta,
    languages: atlas.languages,
    modules: includeMeta ? modules.concat(metaModules.map((m) => ({ ...m, hidden: true }))) : modules,
    links: moduleLinks,
    hiddenMeta: metaNodes.length,
    generatedAt: new Date().toISOString(),
  };
}

function modulePayload(dataDir, slug, moduleId) {
  const atlas = getAtlas(dataDir, slug);
  const key = `${slug}:${moduleId}`;
  const cached = atlas._moduleCache.get(key);
  if (cached) return cached;

  const list = atlas.byModule.get(moduleId);
  if (!list) {
    const err = new Error('module not found');
    err.statusCode = 404;
    throw err;
  }

  const all = [...list].sort((a, b) => b.degree - a.degree);
  const visible = all.length > MAX_MODULE_NODES
    ? new Set(all.slice(0, MAX_MODULE_NODES).map((n) => n.id))
    : null;
  const nodes = all.filter((n) => !visible || visible.has(n.id)).map((n) => ({
    id: n.id, label: n.label, kind: n.kind, file: n.file, loc: n.loc,
    degree: n.degree, callable: n.callable,
  }));
  const ids = new Set(nodes.map((n) => n.id));
  const links = [];
  for (const l of atlas.graph.links) {
    if (!ids.has(l.source) || !ids.has(l.target)) continue;
    links.push({ source: l.source, target: l.target, rel: l.rel });
    if (links.length >= MAX_MODULE_LINKS) break;
  }

  clusterLayout(nodes, { width: 1640, height: 1160 });

  // Neighbour modules, for the breadcrumb + satellites.
  const external = new Map();
  for (const l of atlas.graph.links) {
    const a = atlas.moduleOf.get(l.source);
    const b = atlas.moduleOf.get(l.target);
    let other = null;
    let mine = null;
    if (a === moduleId && b && b !== moduleId) { other = b; mine = l.source; }
    else if (b === moduleId && a && a !== moduleId) { other = a; mine = l.target; }
    if (!other) continue;
    let rec = external.get(other);
    if (!rec) { rec = { id: other, weight: 0, anchors: new Set() }; external.set(other, rec); }
    rec.weight += 1;
    if (rec.anchors.size < 6) rec.anchors.add(mine);
  }
  const satellites = [...external.values()]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 18)
    .map((r) => ({
      id: r.id,
      name: moduleName(r.id, atlas.moduleIds),
      weight: r.weight,
      anchors: [...r.anchors].filter((id) => ids.has(id)),
    }));

  const mod = atlas.moduleList.find((m) => m.id === moduleId);
  // Every file stays reachable even when the symbol canvas is capped.
  const fileMap = new Map();
  for (const n of list) {
    if (!n.file) continue;
    if (!fileMap.has(n.file)) fileMap.set(n.file, []);
    fileMap.get(n.file).push(n);
  }
  const fileGroups = [...fileMap.entries()].map(([file, syms]) => ({
    file,
    count: syms.length,
    weight: syms.reduce((a, n) => a + n.degree, 0),
    top: [...syms].sort((a, b) => b.degree - a.degree).slice(0, 4)
      .map((n) => ({ id: n.id, label: n.label, kind: n.kind, loc: n.loc, degree: n.degree })),
  })).sort((a, b) => b.weight - a.weight);

  const payload = {
    slug,
    id: moduleId,
    name: mod ? mod.name : moduleName(moduleId, atlas.moduleIds),
    dir: moduleId,
    count: list.length,
    shown: nodes.length,
    hidden: Math.max(0, list.length - nodes.length),
    files: fileGroups.length,
    nodes,
    links,
    satellites,
    top: mod ? mod.top : [],
    kind: mod ? mod.kind : 'core',
    fileGroups,
  };
  atlas._moduleCache.set(key, payload);
  if (atlas._moduleCache.size > 24) atlas._moduleCache.delete(atlas._moduleCache.keys().next().value);
  return payload;
}

function nodePayload(dataDir, slug, nodeId) {
  const atlas = getAtlas(dataDir, slug);
  const n = atlas.graph.nodes.find((x) => x.id === nodeId);
  if (!n) {
    const err = new Error('symbol not found');
    err.statusCode = 404;
    throw err;
  }
  const id = n.id;
  const neighbors = [];
  const seen = new Set([id]);
  for (const l of atlas.graph.links) {
    if (l.source !== id && l.target !== id) continue;
    const other = l.source === id ? l.target : l.source;
    if (seen.has(other)) continue;
    seen.add(other);
    const m = atlas.graph.nodes.find((x) => x.id === other);
    if (m) neighbors.push({ node: m, rel: l.rel });
  }
  neighbors.sort((a, b) => b.node.degree - a.node.degree);
  const trimmed = neighbors.slice(0, 60);

  const moduleId = atlas.moduleOf.get(id) || null;
  const moduleNameFor = (mid) => (mid ? moduleName(mid, atlas.moduleIds) : null);

  return {
    slug,
    node: {
      id: n.id, label: n.label, kind: n.kind, file: n.file, loc: n.loc,
      degree: n.degree, callable: n.callable, module: moduleId, moduleName: moduleNameFor(moduleId),
    },
    neighbors: trimmed.map((x) => ({
      id: x.node.id, label: x.node.label, kind: x.node.kind, file: x.node.file,
      loc: x.node.loc, degree: x.node.degree, rel: x.rel,
      module: atlas.moduleOf.get(x.node.id) || null,
      moduleName: moduleNameFor(atlas.moduleOf.get(x.node.id) || null),
    })),
    totalNeighbors: neighbors.length,
    truncated: neighbors.length > trimmed.length,
  };
}

function search(dataDir, slug, q, limit = 24) {
  const atlas = getAtlas(dataDir, slug);
  const needle = String(q || '').toLowerCase().trim();
  if (!needle) return [];
  const terms = needle.split(/\s+/).filter(Boolean);
  const scored = [];
  for (const n of atlas.graph.nodes) {
    if (n.meta) continue;
    const hay = `${n.label} ${n.file || ''}`.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (!hay.includes(t)) { score = -1; break; }
      score += n.label.toLowerCase().includes(t) ? 3 : 1;
      if (n.label.toLowerCase() === t) score += 8;
      if (n.label.toLowerCase().startsWith(t)) score += 3;
    }
    if (score < 0) continue;
    scored.push({ n, score: score * 1000 + Math.min(999, n.degree) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ n }) => ({
    id: n.id, label: n.label, kind: n.kind, file: n.file, loc: n.loc,
    degree: n.degree,
    module: atlas.moduleOf.get(n.id) || null,
    moduleName: atlas.moduleOf.get(n.id)
      ? moduleName(atlas.moduleOf.get(n.id), atlas.moduleIds)
      : 'external',
  }));
}

module.exports = {
  getAtlas,
  invalidate,
  overview,
  modulePayload,
  nodePayload,
  search,
  forceLayout,
  partition,
  MAX_MODULE_SIZE,
};
