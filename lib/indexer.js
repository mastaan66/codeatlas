// Clone + index repositories with Graphify.
//
// The hard rule: indexing is *bounded*. A shallow clone, a budgeted file slice,
// a deadline on every child process, and a fallback that builds a graph from
// Graphify's own AST cache. A huge repo may get a smaller map — it never gets an
// indefinite spinner.
//
// All child processes use execFile/spawn with argument arrays (no shell
// interpolation); cloned code is parsed, never executed.
const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const { planIndex, stageFiles, repoHead, humanBytes } = require('./scan');

// Accept the ways people actually paste a repo: owner/repo, github.com/owner/repo,
// http(s)://(www.)github.com/owner/repo(.git)(/tree/main/...), git@github.com:owner/repo.git.
const OWNER_REPO_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/;
function parseRepo(input) {
  const raw = String(input || '').trim().replace(/[?#].*$/, '');
  const v = raw.replace(/^git@github\.com:/i, '')
    .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '');
  const parts = v.split('/').filter(Boolean);
  // Deep links (/tree/main/src) only make sense after an explicit github.com.
  if (v === raw && parts.length !== 2) return null;
  const m = OWNER_REPO_RE.exec(parts.slice(0, 2).join('/'));
  if (!m || m[1] === '.' || m[1] === '..' || m[2] === '.' || m[2] === '..') return null;
  return { owner: m[1], name: m[2], url: `https://github.com/${m[1]}/${m[2]}` };
}

// Graphify may live outside PATH (e.g. a project-local install on a PaaS).
function graphifyBin() {
  if (process.env.GRAPHIFY_BIN) return process.env.GRAPHIFY_BIN;
  const local = path.join(__dirname, '..', '.tools', 'bin', 'graphify');
  return fs.existsSync(local) ? local : 'graphify';
}
const MAX_NODES_SERVED = Number(process.env.MAX_NODES_SERVED || 8000);
const MAX_CLONE_MB = Number(process.env.MAX_CLONE_MB || 600);
const CLONE_TIMEOUT_MS = Number(process.env.CLONE_TIMEOUT_MS || 180000);
const EXTRACT_TIMEOUT_MS = Number(process.env.EXTRACT_TIMEOUT_MS || 150000);

function dirSizeMb(dir) {
  let bytes = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) bytes += fs.statSync(p).size;
    }
  };
  walk(dir);
  return bytes / (1024 * 1024);
}

function repoSlug(raw) {
  const slug = String(raw).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug || slug.length > 100) {
    const err = new Error('invalid repo slug');
    err.statusCode = 400;
    throw err;
  }
  return slug;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: opts.timeout || 180000, maxBuffer: 32 * 1024 * 1024, ...opts }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${cmd} failed: ${String(stderr || error.message).slice(0, 500)}`;
        return reject(error);
      }
      resolve({ stdout, stderr });
    });
  });
}

// Spawn a child in its own process group so a timeout kills the whole tree
// (graphify shells out to tree-sitter workers).
function runStreaming(cmd, args, { timeoutMs, cwd, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
      const err = new Error(`${path.basename(cmd)} exceeded its ${Math.round(timeoutMs / 1000)}s deadline`);
      err.timeout = true;
      reject(err);
    }, timeoutMs);

    let outBuf = '';
    let errBuf = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      outBuf += chunk;
      let idx;
      while ((idx = outBuf.indexOf('\n')) >= 0) {
        const line = outBuf.slice(0, idx).trim();
        outBuf = outBuf.slice(idx + 1);
        if (line && onLine) onLine(line, 'out');
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      errBuf += chunk;
      let idx;
      while ((idx = errBuf.indexOf('\n')) >= 0) {
        const line = errBuf.slice(0, idx).trim();
        errBuf = errBuf.slice(idx + 1);
        if (line && onLine) onLine(line, 'err');
      }
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (outBuf.trim() && onLine) onLine(outBuf.trim(), 'out');
      if (code === 0) return resolve({ stdout, stderr, code });
      const err = new Error(`${path.basename(cmd)} exited ${code}: ${stderr.slice(-600)}`);
      err.code = code;
      reject(err);
    });
  });
}

/* ------------------------------------------------------------------ graphs */

const graphCache = new Map(); // file -> { mtimeMs, graph }

function rawSpec(raw) {
  return {
    nodes: raw.nodes || [],
    links: raw.links || raw.edges || [],
    directed: raw.directed !== false,
    builtAt: raw.built_at_commit || null,
  };
}

// Normalize Graphify's output into the shape the rest of CodeAtlas uses.
// Handles both schema generations (`links` vs `edges`, file/concept nodes).
function normalizeGraph(raw, slug) {
  const { nodes: rawNodes, links: rawLinks } = rawSpec(raw);
  const degree = new Map();
  for (const l of rawLinks) {
    const s = l.source?.id ?? l.source;
    const t = l.target?.id ?? l.target;
    degree.set(s, (degree.get(s) || 0) + 1);
    degree.set(t, (degree.get(t) || 0) + 1);
  }

  // Config, manifests, CI yaml, docs and "concept" nodes are real graph data but
  // not architecture — flag them so the UI can keep the map about actual code.
  const META_FILE_RE = /(^|\/)(package(-lock)?\.json|[^/]+\.(ya?ml|toml|cfg|ini|lock|json|md|txt|rst))$|(^|\/)\.github\//i;
  const nodes = rawNodes.map((n) => {
    const file = n.source_file || n.origin_file || null;
    const kind = n.file_type === 'concept' ? 'concept'
      : n.file_type === 'external' || n.kind === 'external' ? 'external'
        : n._callable_class ? 'class'
          : n._callable ? 'function'
            : file ? 'symbol' : 'concept';
    return {
      id: n.id,
      label: n.label || n.id,
      community: n.community ?? -1,
      file,
      loc: n.source_location || null,
      kind,
      callable: !!(n._callable || n._callable_class),
      degree: degree.get(n.id) || 0,
      meta: kind === 'concept' || kind === 'external' || META_FILE_RE.test(file || ''),
    };
  });

  const kept = nodes.length > MAX_NODES_SERVED
    ? [...nodes].sort((a, b) => b.degree - a.degree).slice(0, MAX_NODES_SERVED)
    : nodes;
  const keep = new Set(kept.map((n) => n.id));
  const links = rawLinks
    .map((l) => ({
      source: l.source?.id ?? l.source,
      target: l.target?.id ?? l.target,
      rel: l.relation || l.rel || l.type || '',
      origin: l._origin || '',
      confidence: l.confidence || 'EXTRACTED',
    }))
    .filter((l) => keep.has(l.source) && keep.has(l.target));

  const communities = new Set(kept.map((n) => n.community));
  return {
    slug,
    nodes: kept,
    links,
    stats: {
      nodes: kept.length,
      links: links.length,
      communities: communities.size,
      totalNodes: nodes.length,
      totalLinks: rawLinks.length,
    },
  };
}

const SEED_DIR = path.join(__dirname, '..', 'seed-graphs');

function listRepos(dataDir) {
  const reposDir = path.join(dataDir, 'repos');
  const live = fs.readdirSync(reposDir).filter((d) =>
    fs.existsSync(path.join(reposDir, d, 'graphify-out', 'graph.json')));
  const seeds = fs.existsSync(SEED_DIR)
    ? fs.readdirSync(SEED_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
    : [];
  return [...new Set([...live, ...seeds])].sort();
}

function graphPath(dataDir, slug) {
  const live = path.join(dataDir, 'repos', slug, 'graphify-out', 'graph.json');
  if (fs.existsSync(live)) return live;
  const seed = path.join(SEED_DIR, `${slug}.json`);
  if (fs.existsSync(seed)) return seed;
  const err = new Error('graph not found');
  err.statusCode = 404;
  throw err;
}

// Cached, normalized graph for API surfaces (ask/tour/atlas).
function loadGraph(dataDir, rawSlug) {
  const slug = repoSlug(rawSlug);
  const file = graphPath(dataDir, slug);
  const st = fs.statSync(file);
  const hit = graphCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.graph;
  const graph = normalizeGraph(JSON.parse(fs.readFileSync(file, 'utf8')), slug);
  graphCache.set(file, { mtimeMs: st.mtimeMs, graph });
  if (graphCache.size > 6) graphCache.delete(graphCache.keys().next().value);
  return graph;
}

/* ------------------------------------------------------- AST cache fallback */

// Graphify writes per-file AST JSON while it works. If the final graph build
// times out (very large repos), assemble a bounded map from those fragments so
// the user still sees architecture instead of an error.
function buildFromAstCache(repoDir, stageDir) {
  const cacheRoot = path.join(repoDir, 'graphify-out', 'cache', 'ast');
  if (!fs.existsSync(cacheRoot)) return null;

  const keepFiles = new Set();
  if (stageDir) {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else keepFiles.add(path.relative(stageDir, p).split(path.sep).join('/'));
      }
    };
    try { walk(stageDir); } catch { /* ignore */ }
  }

  const byId = new Map();
  const edges = [];
  const seenEdge = new Set();
  let scanned = 0;
  const versions = fs.readdirSync(cacheRoot);
  outer:
  for (const v of versions) {
    const dir = path.join(cacheRoot, v);
    let entries;
    try { entries = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { continue; }
    for (const f of entries) {
      if (scanned > 6000) break outer;
      let doc;
      try { doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      scanned += 1;
      for (const n of doc.nodes || []) {
        const file = n.source_file || n.origin_file || '';
        if (keepFiles.size && file && !keepFiles.has(file)) continue;
        if (!byId.has(n.id)) byId.set(n.id, n);
      }
      for (const e of doc.edges || doc.links || []) {
        const s = e.source?.id ?? e.source;
        const t = e.target?.id ?? e.target;
        if (!s || !t) continue;
        const key = `${s}\u0000${t}\u0000${e.relation || ''}`;
        if (seenEdge.has(key)) continue;
        seenEdge.add(key);
        edges.push({ source: s, target: t, relation: e.relation || 'related', _origin: e._origin || 'ast' });
      }
    }
  }
  if (!byId.size) return null;

  const degree = new Map();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  }
  let nodes = [...byId.values()].map((n) => ({ ...n, _degree: degree.get(n.id) || 0 }));
  if (nodes.length > MAX_NODES_SERVED) {
    nodes = nodes.sort((a, b) => b._degree - a._degree).slice(0, MAX_NODES_SERVED);
  }
  const keep = new Set(nodes.map((n) => n.id));
  const links = edges.filter((e) => keep.has(e.source) && keep.has(e.target));
  for (const n of nodes) delete n._degree;
  return {
    nodes,
    links,
    directed: false,
    multigraph: true,
    built_at_commit: null,
    _atlasFallback: true,
    _atlasCacheFiles: scanned,
  };
}

/* ------------------------------------------------------------------ driver */

function metaFile(dataDir, slug) {
  return path.join(dataDir, 'repos', slug, 'atlas-meta.json');
}

function readMeta(dataDir, slug) {
  try { return JSON.parse(fs.readFileSync(metaFile(dataDir, slug), 'utf8')); } catch { return null; }
}

function send(onProgress, stage, progress, message, extra) {
  try { onProgress && onProgress({ stage, progress, message, ...(extra || {}) }); } catch {}
}

async function indexRepo(dataDir, repoUrl, { onProgress, force = false } = {}) {
  const parsed = parseRepo(repoUrl);
  if (!parsed) {
    const err = new Error('expected a public GitHub repo like owner/repo or https://github.com/owner/repo');
    err.statusCode = 400;
    throw err;
  }
  const { owner, name } = parsed;
  const slug = repoSlug(`${owner}-${name}`);
  const repoDir = path.join(dataDir, 'repos', slug);
  const stageDir = path.join(dataDir, 'staging', slug);
  const graphFile = path.join(repoDir, 'graphify-out', 'graph.json');
  const t0 = Date.now();

  // 1. clone / refresh ------------------------------------------------------
  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    send(onProgress, 'clone', 2, `Cloning ${owner}/${name} (depth 1)…`);
    fs.rmSync(repoDir, { recursive: true, force: true });
    await run('git', ['clone', '--depth', '1', '--single-branch', '--no-tags',
      `https://github.com/${owner}/${name}.git`, repoDir], { timeout: CLONE_TIMEOUT_MS });
    const mb = dirSizeMb(repoDir);
    if (mb > MAX_CLONE_MB) {
      fs.rmSync(repoDir, { recursive: true, force: true });
      const err = new Error(`repository too large to index here (${Math.round(mb)} MB > ${MAX_CLONE_MB} MB cap)`);
      err.statusCode = 413;
      throw err;
    }
  } else if (force) {
    send(onProgress, 'clone', 2, 'Refreshing repository…');
    try {
      await run('git', ['-C', repoDir, 'fetch', '--depth', '1', 'origin'], { timeout: 60000 });
      await run('git', ['-C', repoDir, 'reset', '--hard', 'FETCH_HEAD'], { timeout: 30000 });
    } catch { /* offline / detached: keep what we have */ }
  }
  const head = await repoHead(repoDir);
  send(onProgress, 'clone', 8, 'Repository ready', { commit: head });

  // 2. reuse a fresh map ----------------------------------------------------
  const previous = readMeta(dataDir, slug);
  if (!force && fs.existsSync(graphFile) && previous && previous.commit === head && previous.completed) {
    send(onProgress, 'ready', 100, 'Using cached map', { cached: true });
    return { slug, stats: loadGraph(dataDir, slug).stats, meta: previous, cached: true };
  }

  // 3. budget the slice -----------------------------------------------------
  send(onProgress, 'scan', 12, 'Choosing the architecture slice…');
  const plan = await planIndex(repoDir);
  if (!plan.files.length) {
    const err = new Error('no supported source files found in this repository');
    err.statusCode = 422;
    throw err;
  }
  send(onProgress, 'scan', 20,
    `Selected ${plan.files.length} of ${plan.totalFiles} source files (${humanBytes(plan.totalBytes)})`,
    { selected: plan.files.length, totalFiles: plan.totalFiles, bytes: plan.totalBytes });

  send(onProgress, 'stage', 24, 'Staging the slice…');
  const staged = stageFiles(repoDir, stageDir, plan.files);
  send(onProgress, 'stage', 28,
    `Staged ${staged.files} files (${staged.linked} linked, ${staged.copied} copied)`);

  // 4. extract --------------------------------------------------------------
  let usedFallback = false;
  let extractError = null;
  let nodeCount = 0;
  send(onProgress, 'extract', 30, 'Parsing the AST (Graphify · local, no LLM)…');
  try {
    // Fresh graph per run so a partial file from a killed run can't masquerade.
    fs.rmSync(path.join(repoDir, 'graphify-out', 'graph.json'), { force: true });
    await runStreaming(graphifyBin(), ['extract', stageDir, '--code-only', '--no-cluster',
      '--allow-partial', '--timing', '--out', repoDir], {
      timeoutMs: EXTRACT_TIMEOUT_MS,
      onLine: (line) => {
        const m1 = /AST extraction: (\d+)\/(\d+)/.exec(line);
        if (m1) {
          const [, done, total] = m1;
          const pct = total > 0 ? done / total : 0;
          send(onProgress, 'extract', 30 + Math.round(pct * 50),
            `Parsing ${done}/${total} files…`, { parsed: Number(done), total: Number(total) });
          return;
        }
        const m2 = /wrote .*?(\d[\d,]*) nodes, ([\d,]+) edges/.exec(line);
        if (m2) {
          nodeCount = Number(m2[1].replace(/,/g, ''));
          send(onProgress, 'extract', 84,
            `Graph built: ${m2[1]} nodes, ${m2[2]} edges`, { nodes: nodeCount });
        }
      },
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      err.message = 'the Graphify CLI is not installed on this server (install with `uv tool install graphifyy` or set GRAPHIFY_BIN)';
    }
    extractError = err;
    send(onProgress, 'extract', 82,
      err.timeout ? 'Extractor hit its deadline — assembling a bounded map from the AST cache…'
        : 'Extractor failed — assembling a bounded map from the AST cache…');
  }

  // 5. fallback / verify ----------------------------------------------------
  if (!fs.existsSync(graphFile)) {
    const fallback = buildFromAstCache(repoDir, stageDir);
    if (!fallback) {
      const err = new Error(
        `could not build a graph for this repository (${extractError ? extractError.message : 'extractor produced no output'})`);
      err.statusCode = 500;
      throw err;
    }
    fs.mkdirSync(path.dirname(graphFile), { recursive: true });
    fs.writeFileSync(graphFile, JSON.stringify(fallback));
    usedFallback = true;
    nodeCount = fallback.nodes.length;
    send(onProgress, 'extract', 88,
      `Assembled ${fallback.nodes.length} nodes from ${fallback._atlasCacheFiles} cached AST files`);
  }

  // 6. normalize + persist meta --------------------------------------------
  send(onProgress, 'build', 92, 'Indexing modules and layouts…');
  graphCache.delete(graphFile);
  const graph = loadGraph(dataDir, slug);
  const meta = {
    slug,
    repo: `https://github.com/${owner}/${name}`,
    commit: head,
    completed: true,
    usedFallback,
    selectedFiles: plan.files.length,
    totalFiles: plan.totalFiles,
    indexedBytes: plan.totalBytes,
    budget: plan.budget,
    stats: graph.stats,
    seconds: ((Date.now() - t0) / 1000).toFixed(1),
    builtAt: new Date().toISOString(),
  };
  try { fs.writeFileSync(metaFile(dataDir, slug), JSON.stringify(meta, null, 2)); } catch {}
  send(onProgress, 'ready', 100,
    `Map ready — ${graph.stats.nodes} symbols, ${graph.stats.links} links in ${meta.seconds}s`,
    { stats: graph.stats, meta });
  return { slug, stats: graph.stats, meta, cached: false };
}

module.exports = {
  indexRepo,
  parseRepo,
  listRepos,
  loadGraph,
  normalizeGraph,
  repoSlug,
  readMeta,
  buildFromAstCache,
  MAX_NODES_SERVED,
};
