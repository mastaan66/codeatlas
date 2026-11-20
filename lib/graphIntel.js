// Graph intelligence: the part that helps a human read a codebase.
//
// Everything here is deterministic and grounded in the Graphify knowledge graph
// plus the real source files. The LLM only narrates these facts; it never gets
// to invent structure. Deterministic results are always available, so the
// product is useful even with the model switched off.
const path = require('path');
const fs = require('fs');
const { getAtlas } = require('./atlas');

const MAX_CONTEXT_CHARS = Number(process.env.ASK_CONTEXT_CHARS || 24000);
const MAX_SNIPPET_LINES = 70;

const cache = new Map(); // slug -> { key, intel }

function indexGraph(atlas) {
  const byId = new Map();
  const byFile = new Map();
  const adj = new Map(); // id -> [{ id, rel, dir }]
  for (const n of atlas.graph.nodes) {
    byId.set(n.id, n);
    if (n.file) {
      if (!byFile.has(n.file)) byFile.set(n.file, []);
      byFile.get(n.file).push(n);
    }
    adj.set(n.id, []);
  }
  for (const l of atlas.graph.links) {
    if (!byId.has(l.source) || !byId.has(l.target)) continue;
    adj.get(l.source).push({ id: l.target, rel: l.rel, dir: 'out' });
    adj.get(l.target).push({ id: l.source, rel: l.rel, dir: 'in' });
  }
  return { byId, byFile, adj };
}

function getIntel(dataDir, slug) {
  const atlas = getAtlas(dataDir, slug);
  if (!atlas.dataDir) { atlas.dataDir = dataDir; atlas.slug = slug; }
  const key = atlas.graphMtimeMs;
  const hit = cache.get(slug);
  if (hit && hit.key === key) return { atlas, ...hit.intel };
  const intel = indexGraph(atlas);
  cache.set(slug, { key, intel });
  if (cache.size > 4) cache.delete(cache.keys().next().value);
  return { atlas, ...intel };
}

/* ------------------------------------------------------------ source access */

function repoDirFor(dataDir, slug) {
  return path.join(dataDir, 'repos', slug);
}

function readRepoFile(dataDir, slug, rel, maxBytes = 300 * 1024) {
  if (!rel) return null;
  const repoDir = repoDirFor(dataDir, slug);
  const abs = path.resolve(repoDir, rel);
  if (!abs.startsWith(repoDir + path.sep)) return null;
  try {
    if (!fs.statSync(abs).isFile()) return null;
    const buf = fs.readFileSync(abs).subarray(0, maxBytes);
    if (buf.includes(0)) return null;
    return { abs, text: buf.toString('utf8'), size: fs.statSync(abs).size };
  } catch {
    return null;
  }
}

// Cheap signature extraction from the source line(s) at the symbol. Used to
// show the contract (params/returns) in the inspector.
function extractContract(text, loc) {
  if (!text) return null;
  const lines = text.split('\n');
  const start = Math.max(0, lineOf(loc) - 1);
  let head = '';
  for (let i = start; i < Math.min(lines.length, start + 8); i++) head += `${lines[i]}\n`;
  const code = head.replace(/^\s*(?:#|\/\/|\/\*|\*|\*\/).*$/gm, '');
  const m = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:def|class)\s+([A-Za-z_$][\w$]*)(?:\s*\(([^)]*)\))?/.exec(code)
    || /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/.exec(code)
    || /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\s*)?\(([^)]*)\)/.exec(code);
  if (!m) return null;
  const params = m[2] ? m[2].replace(/\s+/g, ' ').trim().slice(0, 90) : null;
  const after = code.slice((m.index || 0) + m[0].length, (m.index || 0) + m[0].length + 140);
  const ret = /(?:->|:)\s*([A-Za-z_$][\w$\[\]{}|'"\s.,-]*|None)/.exec(after);
  const returns = ret ? ret[1].trim().slice(0, 60) : null;
  const hasSig = Boolean(params) || Boolean(returns);
  if (!hasSig && !m[1]) return null;
  return { params: params || '(…)', returns: returns || null, note: m[1] ? `signature: ${m[1]}` : '' };
}

function lineOf(loc) {
  const m = /^L?(\d+)/.exec(String(loc || ''));
  return m ? Number(m[1]) : 0;
}

// A focused source excerpt around the symbol, not the whole file.
function snippet(dataDir, slug, file, loc, { around = 34, maxLines = MAX_SNIPPET_LINES } = {}) {
  const doc = readRepoFile(dataDir, slug, file);
  if (!doc) return null;
  const lines = doc.text.split('\n');
  const target = lineOf(loc);
  let start = 1;
  if (target > 0) start = Math.max(1, target - Math.floor(around / 2));
  else {
    // No location: skip a leading license/import block.
    start = Math.min(lines.length, 1 + lines.findIndex((l) => l.trim() && !/^(#|\/\/|\*|\/\*|"""|''')/.test(l.trim())));
    if (!Number.isFinite(start) || start < 1) start = 1;
  }
  const end = Math.min(lines.length, start + maxLines - 1);
  return {
    file,
    startLine: start,
    endLine: end,
    text: lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join('\n'),
    truncated: doc.size > 300 * 1024,
  };
}

/* --------------------------------------------------------------------- facts */

function isProseLabel(n) {
  const words = String(n.label || '').trim().split(/\s+/).length;
  return words > 7 || String(n.label || '').length > 80;
}

function lowValueFile(file) {
  return /(^|\/)(tests?|__tests__|spec|benchmarks?|benches|examples?|samples?|docs?|fixtures?|testdata)(\/|$)/i.test(file || '');
}

function entryScore(n, atlas) {
  let s = 0;
  const file = n.file || '';
  if (/(^|\/)(main|index|app|server|cli|__main__|program|run)\.[A-Za-z0-9]+$/i.test(file)) s += 60;
  if (/(^|\/)(bin|cmd|entrypoints?|commands?)\//i.test(file)) s += 25;
  // The dominant language's entry points matter more than a stray tool script.
  const ext = path.extname(file).toLowerCase();
  if (atlas && atlas.primaryExts) {
    if (atlas.primaryExts[0] === ext) s += 34;
    else if (atlas.primaryExts[1] === ext) s += 6;
  }
  if (lowValueFile(file)) s -= 90;
  if (n.callable) s += 10;
  if (isProseLabel(n)) s -= 60;
  s -= Math.min(30, (file.split('/').length - 1) * 5);
  s += Math.min(30, n.degree);
  return s;
}

function entryPoints(atlas, limit = 8) {
  const code = atlas.graph.nodes.filter((n) => !n.meta && !isProseLabel(n) && !lowValueFile(n.file));
  const pool = code.length ? code : atlas.graph.nodes.filter((n) => !n.meta);
  return [...pool].sort((a, b) => entryScore(b, atlas) - entryScore(a, atlas)).slice(0, limit);
}

function hubSymbols(atlas, limit = 10) {
  return atlas.graph.nodes
    .filter((n) => !n.meta)
    .sort((a, b) => b.degree - a.degree)
    .slice(0, limit);
}

function topModules(atlas, limit = 8, { coreOnly = false } = {}) {
  const list = coreOnly ? atlas.moduleList.filter((m) => m.kind !== 'support') : atlas.moduleList;
  return list.slice(0, limit).map((m) => ({
    id: m.id,
    name: m.name,
    count: m.count,
    files: m.files,
    top: m.top.slice(0, 4),
  }));
}

function moduleOf(atlas, node) {
  return atlas.moduleOf.get(node.id) || null;
}

function neighborsOf(intel, id) {
  return (intel.adj.get(id) || []).map((e) => ({ ...e, node: intel.byId.get(e.id) })).filter((e) => e.node);
}

function callers(intel, id) {
  return neighborsOf(intel, id)
    .filter((e) => e.dir === 'in' && /call|use|import|reference|inherit|implement|contain/i.test(e.rel || 'call'))
    .map((e) => ({ node: e.node, rel: e.rel }))
    .sort((a, b) => b.node.degree - a.node.degree);
}

function callees(intel, id) {
  return neighborsOf(intel, id)
    .filter((e) => e.dir === 'out' && /call|use|import|reference|inherit|implement|contain/i.test(e.rel || 'call'))
    .map((e) => ({ node: e.node, rel: e.rel }))
    .sort((a, b) => b.node.degree - a.node.degree);
}

/* --------------------------------------------------------------- BFS helpers */

function shortestPath(intel, fromId, toId, maxDepth = 7) {
  if (!intel.byId.has(fromId) || !intel.byId.has(toId)) return null;
  if (fromId === toId) return [fromId];
  const prev = new Map([[fromId, null]]);
  const q = [[fromId, 0]];
  for (let qi = 0; qi < q.length; qi++) {
    const [id, d] = q[qi];
    if (d >= maxDepth) continue;
    for (const e of intel.adj.get(id) || []) {
      if (prev.has(e.id)) continue;
      prev.set(e.id, { from: id, rel: e.rel });
      if (e.id === toId) {
        const out = [toId];
        let cur = toId;
        while (prev.get(cur)) { cur = prev.get(cur).from; out.push(cur); }
        return out.reverse();
      }
      q.push([e.id, d + 1]);
    }
  }
  return null;
}

/* ------------------------------------------------------------------ retrieval */

// Small, explicit domain expansion. Deterministic, debuggable, and enough to
// make "where is auth handled" reach symbols labelled `Session`/`Token`.
const SYNONYMS = {
  auth: ['auth', 'login', 'session', 'token', 'credential', 'oauth', 'jwt', 'permission', 'user'],
  database: ['db', 'database', 'storage', 'store', 'adapter', 'repository', 'query', 'sql', 'persist'],
  storage: ['storage', 'store', 'adapter', 'repository', 'persist', 'cache', 'file'],
  api: ['api', 'route', 'router', 'endpoint', 'handler', 'controller', 'request', 'response'],
  server: ['server', 'http', 'express', 'listen', 'socket'],
  cli: ['cli', 'command', 'arg', 'flag', 'terminal', 'console'],
  config: ['config', 'settings', 'option', 'env', 'yaml', 'toml'],
  test: ['test', 'spec', 'assert', 'fixture', 'mock'],
  error: ['error', 'exception', 'fail', 'retry', 'throw'],
  async: ['async', 'await', 'promise', 'task', 'queue', 'worker', 'concurrency'],
  request: ['request', 'response', 'http', 'client', 'fetch', 'route'],
  model: ['model', 'schema', 'entity', 'domain', 'type'],
};

function tokenize(q) {
  return String(q || '').toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 1);
}

function expandTerms(tokens) {
  const out = new Set(tokens);
  for (const t of tokens) {
    if (SYNONYMS[t]) SYNONYMS[t].forEach((s) => out.add(s));
    for (const [k, list] of Object.entries(SYNONYMS)) {
      if (list.includes(t)) out.add(k);
    }
  }
  return [...out];
}

function anchorNodes(atlas, question, limit = 10) {
  const tokens = tokenize(question);
  const terms = expandTerms(tokens);
  const scored = [];
  for (const n of atlas.graph.nodes) {
    if (n.meta) continue;
    const label = n.label.toLowerCase();
    const file = (n.file || '').toLowerCase();
    const module = (atlas.moduleOf.get(n.id) || '').toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (label === t) score += 40;
      else if (label.startsWith(t)) score += 18;
      else if (label.includes(t)) score += 12;
      if (file.includes(t)) score += 5;
      if (module.includes(t)) score += 4;
    }
    for (const t of terms) {
      if (!tokens.includes(t) && (label.includes(t) || file.includes(t))) score += 2;
    }
    if (score <= 0) continue;
    // Prose/docstring nodes can match words but are not what a reader needs.
    if (isProseLabel(n)) score *= 0.12;
    if (lowValueFile(n.file)) score *= 0.45;
    // Prefer code the reader can act on; degree breaks ties.
    if (n.callable) score += 6;
    score += Math.min(14, n.degree) * 0.6;
    scored.push({ n, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.n);
}

function relatedAnchors(intel, anchors, limit = 6) {
  const have = new Set(anchors.map((n) => n.id));
  const out = [];
  for (const n of anchors.slice(0, 4)) {
    for (const e of neighborsOf(intel, n.id)) {
      if (have.has(e.node.id) || e.node.meta) continue;
      have.add(e.node.id);
      out.push(e.node);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function describeNodeLine(n, atlas) {
  const where = n.file ? `${n.file}${n.loc ? ':' + n.loc : ''}` : 'no file';
  const mod = atlas.moduleOf.get(n.id);
  return `- ${n.label} [${n.kind}] — ${where}${mod ? ` · module ${mod}` : ''} · degree ${n.degree}`;
}

// Build grounded context for a question: anchors, their code, their edges,
// module digests, entry points. Returns text + the sources we can cite.
function retrieve(dataDir, slug, question, { budget = MAX_CONTEXT_CHARS } = {}) {
  const intel = getIntel(dataDir, slug);
  const { atlas } = intel;
  const anchors = anchorNodes(atlas, question, 10);
  const related = anchors.length ? relatedAnchors(intel, anchors, 8) : hubSymbols(atlas, 6);
  const effective = anchors.length ? anchors : related;
  const sources = [];
  const blocks = [];

  blocks.push(`## Repository
${slug}: ${atlas.stats.nodes} symbols across ${atlas.moduleList.length} modules, ${atlas.stats.links} links.
Languages: ${atlas.languages.slice(0, 5).map(([l, c]) => `${l} (${c})`).join(', ') || 'unknown'}.`);

  blocks.push(`## Module map (largest first)
${topModules(atlas, 10, { coreOnly: true }).map((m) => `- ${m.name} — ${m.count} symbols; key: ${m.top.map((t) => t.label).join(', ')}`).join('\n')}`);

  blocks.push(`## Entry points
${entryPoints(atlas, 6).map((n) => describeNodeLine(n, atlas)).join('\n')}`);

  if (effective.length) {
    blocks.push(`## Symbols matching the question`);
    blocks.push(effective.map((n) => describeNodeLine(n, atlas)).join('\n'));
  }

  // Source excerpts for the strongest anchors — this is what makes answers
  // specific instead of generic graph prose.
  for (const n of effective.slice(0, 5)) {
    const snip = snippet(dataDir, slug, n.file, n.loc, { maxLines: 40 });
    if (!snip) continue;
    blocks.push(`## Source: ${n.file}:${snip.startLine}-${snip.endLine} (symbol ${n.label})\n\`\`\`\n${snip.text}\n\`\`\``);
    sources.push({ label: n.label, file: n.file, loc: n.loc || `L${snip.startLine}`, module: atlas.moduleOf.get(n.id) || null });
  }

  // Direct relationships (in and out) for the anchors.
  const relLines = [];
  for (const n of effective.slice(0, 6)) {
    const ins = callers(intel, n.id).slice(0, 4);
    const outs = callees(intel, n.id).slice(0, 5);
    if (ins.length) relLines.push(`- ${n.label} ← called/used by: ${ins.map((x) => `${x.node.label} (${x.node.file || '?'})`).join(', ')}`);
    if (outs.length) relLines.push(`- ${n.label} → reaches: ${outs.map((x) => `${x.node.label} (${x.node.file || '?'})`).join(', ')}`);
  }
  if (relLines.length) blocks.push(`## Relationships\n${relLines.join('\n')}`);

  // A concrete reading order beats a list of matches.
  const readOrder = rankForReading(atlas, effective).slice(0, 6);
  if (readOrder.length) {
    blocks.push(`## Suggested reading order\n${readOrder.map((r, i) => `${i + 1}. ${r.node.file || r.node.label}${r.node.loc ? ':' + r.node.loc : ''} — ${r.why}`).join('\n')}`);
  }

  for (const n of related.slice(0, 6)) {
    if (sources.some((s) => s.file === n.file)) continue;
    sources.push({ label: n.label, file: n.file, loc: n.loc, module: atlas.moduleOf.get(n.id) || null });
  }

  let text = blocks.join('\n\n');
  if (text.length > budget) {
    // Drop the least critical tail first (reading order + relationships stay).
    text = text.slice(0, budget) + '\n\n[context truncated]';
  }
  return { context: text, sources: dedupeSources(sources).slice(0, 12), anchors: effective.map((n) => ({ id: n.id, label: n.label, file: n.file, loc: n.loc })) };
}

function dedupeSources(sources) {
  const seen = new Set();
  return sources.filter((s) => {
    if (!s.file) return false;
    const k = `${s.file}:${s.loc || ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* ------------------------------------------------------------- reading order */

function rankForReading(atlas, nodes) {
  const seen = new Set();
  const out = [];
  for (const n of nodes) {
    if (!n.file || isProseLabel(n) || lowValueFile(n.file) || seen.has(n.file)) continue;
    seen.add(n.file);
    const why = n.callable
      ? `defines ${n.label}, a ${n.kind} with ${n.degree} connections`
      : `owns ${n.label} in ${atlas.moduleOf.get(n.id) || 'the repo'}`;
    out.push({ node: n, why });
    if (out.length >= 8) break;
  }
  return out;
}

function moduleFacts(atlas, moduleId) {
  const list = atlas.byModule.get(moduleId);
  if (!list) return null;
  const mod = atlas.moduleList.find((m) => m.id === moduleId);
  const sorted = [...list].sort((a, b) => b.degree - a.degree);
  const files = [...new Set(list.map((n) => n.file).filter(Boolean))];
  const degreeByFile = new Map();
  for (const n of list) {
    if (!n.file) continue;
    degreeByFile.set(n.file, (degreeByFile.get(n.file) || 0) + n.degree);
  }
  const topFiles = [...degreeByFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([file, weight]) => ({ file, weight, symbols: (atlas.graph.nodes.filter((n) => n.file === file)).length }));

  const external = new Map();
  for (const n of list) {
    for (const l of atlas.graph.links) {
      if (l.source !== n.id && l.target !== n.id) continue;
      const other = l.source === n.id ? l.target : l.source;
      const om = atlas.moduleOf.get(other);
      if (!om || om === moduleId) continue;
      external.set(om, (external.get(om) || 0) + 1);
    }
  }
  const deps = [...external.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([id, weight]) => ({ id, weight }));

  return {
    id: moduleId,
    name: mod ? mod.name : moduleId,
    count: list.length,
    files: files.length,
    callables: list.filter((n) => n.callable).length,
    topSymbols: sorted.slice(0, 12),
    topFiles,
    dependencies: deps,
    reading: topFiles.slice(0, 5).map((f, i) => ({
      file: f.file,
      why: i === 0 ? 'largest surface in this module' : `${f.symbols} symbols, weight ${f.weight}`,
    })),
  };
}

function symbolFacts(atlas, intel, nodeId) {
  const n = intel.byId.get(nodeId);
  if (!n) return null;
  const contract = n.callable
    ? extractContract(readRepoFile((intel.atlas || intel).dataDir, (intel.atlas || intel).slug, n.file, 200 * 1024)?.text || '', n.loc)
    : null;
  const ins = callers(intel, nodeId).slice(0, 10);
  const outs = callees(intel, nodeId).slice(0, 12);
  const siblings = (intel.byFile.get(n.file) || []).filter((x) => x.id !== n.id)
    .sort((a, b) => b.degree - a.degree).slice(0, 10);
  const entries = entryPoints(atlas, 12);
  let route = null;
  for (const e of entries) {
    if (e.id === n.id) { route = { entry: e, path: [e] }; break; }
    const p = shortestPath(intel, n.id, e.id, 5);
    if (p) { route = { entry: e, path: p.map((id) => intel.byId.get(id)).filter(Boolean) }; break; }
  }
  return {
    id: n.id, label: n.label, kind: n.kind, file: n.file, loc: n.loc,
    degree: n.degree, callable: n.callable,
    module: atlas.moduleOf.get(n.id) || null,
    contract,
    callers: ins.map((x) => ({ label: x.node.label, file: x.node.file, loc: x.node.loc, rel: x.rel })),
    callees: outs.map((x) => ({ label: x.node.label, file: x.node.file, loc: x.node.loc, rel: x.rel })),
    siblings: siblings.map((x) => ({ id: x.id, label: x.label, kind: x.kind, degree: x.degree, loc: x.loc })),
    route,
  };
}

function briefFacts(atlas) {
  const entries = entryPoints(atlas, 6);
  const hubs = hubSymbols(atlas, 10);
  return {
    slug: atlas.slug,
    stats: atlas.stats,
    languages: atlas.languages,
    modules: topModules(atlas, 10, { coreOnly: true }),
    supportModules: topModules(atlas, 6).filter((m) => !topModules(atlas, 10, { coreOnly: true }).some((c) => c.id === m.id)),
    entryPoints: entries.map((n) => ({ id: n.id, label: n.label, file: n.file, loc: n.loc, degree: n.degree })),
    hubs: hubs.map((n) => ({ id: n.id, label: n.label, file: n.file, loc: n.loc, degree: n.degree, module: atlas.moduleOf.get(n.id) || null })),
    // Entries first, then hubs: dedupe-by-file keeps the reading list varied
    // even when a repo's entry points all live in one CLI file.
    startHere: rankForReading(atlas, [...entries, ...hubs]).slice(0, 5),
  };
}

module.exports = {
  getIntel,
  retrieve,
  briefFacts,
  moduleFacts,
  symbolFacts,
  entryPoints,
  hubSymbols,
  topModules,
  shortestPath,
  callers,
  callees,
  snippet,
  readRepoFile,
  anchorNodes,
  rankForReading,
};
