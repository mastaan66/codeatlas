// CodeAtlas — explore any codebase as a navigable map.
// Express server: bounded GitHub indexing with live progress, atlas payloads
// (bounded per zoom level), and Gemma-grounded ask/tour/study.
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');

const { indexRepo, listRepos, loadGraph, repoSlug, readMeta, parseRepo } = require('./lib/indexer');
const { buildQuestionContext, buildTourContext } = require('./lib/graphContext');
const { askGemma } = require('./lib/gemma');
const atlas = require('./lib/atlas');
const intel = require('./lib/graphIntel');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR, { index: false }));

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(path.join(DATA_DIR, 'repos'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'tours'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'studykits'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'briefs'), { recursive: true });


/* ------------------------------------------------------------------- pages */

app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get(['/app', '/atlas'], (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'app.html')));

/* -------------------------------------------------------------------- jobs */

const JOB_TTL_MS = 60 * 60 * 1000;
const MAX_CONCURRENT = Number(process.env.INDEX_CONCURRENCY || 2);
const jobs = new Map();
const byRepo = new Map();
const queue = [];
let running = 0;

const indexHits = new Map(); // ip -> timestamps
const INDEX_LIMIT = Number(process.env.INDEX_RATE_LIMIT || 8); // per 10 min per IP

function publicJob(job) {
  return {
    id: job.id,
    slug: job.slug,
    repoUrl: job.repoUrl,
    state: job.state,
    stage: job.stage,
    progress: job.progress,
    message: job.message,
    stats: job.stats || null,
    meta: job.meta || null,
    error: job.error || null,
    cached: !!job.cached,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    queuePosition: job.state === 'queued' ? Math.max(1, queue.indexOf(job) + 1) : 0,
    elapsedMs: Date.now() - job.startedAt,
  };
}

function broadcast(job) {
  const data = `data: ${JSON.stringify(publicJob(job))}\n\n`;
  for (const res of job.listeners) {
    try { res.write(data); } catch { job.listeners.delete(res); }
  }
}

function setState(job, patch) {
  Object.assign(job, patch);
  broadcast(job);
}

function schedule(job) {
  queue.push(job);
  setState(job, { state: 'queued', message: 'Waiting for an indexing slot…' });
  pump();
}

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    running += 1;
    runJob(job).finally(() => {
      running -= 1;
      pump();
    });
  }
  // Refresh queue positions.
  queue.forEach((j) => broadcast(j));
}

async function runJob(job) {
  setState(job, { state: 'running', stage: 'clone', progress: 1, message: 'Starting…', startedAt: Date.now() });
  try {
    const result = await indexRepo(DATA_DIR, job.repoUrl, {
      force: job.force,
      onProgress: (p) => {
        setState(job, {
          stage: p.stage,
          progress: Math.max(1, Math.min(100, p.progress || 1)),
          message: p.message || '',
          ...(p.stats ? { stats: p.stats } : {}),
          ...(p.meta ? { meta: p.meta } : {}),
        });
      },
    });
    atlas.invalidate(result.slug);
    setState(job, {
      state: 'ready',
      stage: 'ready',
      progress: 100,
      message: `Map ready — ${result.stats.nodes} symbols, ${result.stats.links} links`,
      stats: result.stats,
      meta: result.meta || null,
      cached: !!result.cached,
      finishedAt: Date.now(),
    });
  } catch (err) {
    setState(job, {
      state: 'failed',
      stage: 'failed',
      message: 'Indexing failed',
      error: err.message,
      finishedAt: Date.now(),
    });
  } finally {
    busyRepos.delete(job.repoUrl);
    setTimeout(() => closeJob(job), JOB_TTL_MS).unref?.();
  }
}

const busyRepos = new Map(); // repoUrl -> job

function closeJob(job) {
  for (const res of job.listeners) {
    try { res.end(); } catch {}
  }
  job.listeners.clear();
  jobs.delete(job.id);
  if (byRepo.get(job.repoUrl) === job) byRepo.delete(job.repoUrl);
}

/* --------------------------------------------------------------------- API */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    provider: process.env.GEMINI_API_KEY ? 'gemini-api' : 'ollama-local',
    version: require('./package.json').version,
    limits: {
      maxFiles: Number(process.env.MAX_INDEX_FILES || 1200),
      maxNodes: Number(process.env.MAX_NODES_SERVED || 8000),
      concurrency: MAX_CONCURRENT,
    },
  });
});

app.get('/api/repos', (req, res) => {
  const repos = listRepos(DATA_DIR);
  const details = repos.map((slug) => {
    const meta = readMeta(DATA_DIR, slug) || null;
    let stats = null;
    try { stats = atlas.getAtlas(DATA_DIR, slug).stats; } catch {}
    return { slug, meta, stats };
  });
  res.json({ repos, details });
});

app.post('/api/index', (req, res) => {
  try {
    // Validate first so a typo doesn't burn one of the user's index slots.
    const parsed = parseRepo((req.body || {}).repoUrl);
    if (!parsed) {
      return res.status(400).json({ error: 'expected a public GitHub repo like owner/repo or https://github.com/owner/repo' });
    }

    const now = Date.now();
    const hits = (indexHits.get(req.ip) || []).filter((t) => now - t < 600000);
    if (hits.length >= INDEX_LIMIT) {
      return res.status(429).json({ error: 'too many index requests — try again in a few minutes' });
    }
    hits.push(now);
    indexHits.set(req.ip, hits);

    const repoUrl = parsed.url;
    const slug = repoSlug(`${parsed.owner}-${parsed.name}`);

    const existing = busyRepos.get(repoUrl);
    if (existing && (existing.state === 'queued' || existing.state === 'running')) {
      return res.json({ jobId: existing.id, slug, reused: true });
    }

    const job = {
      id: crypto.randomUUID(),
      slug,
      repoUrl,
      force: !!(req.body || {}).refresh,
      state: 'queued',
      stage: 'queued',
      progress: 0,
      message: 'Queued',
      listeners: new Set(),
      startedAt: Date.now(),
    };
    jobs.set(job.id, job);
    byRepo.set(repoUrl, job);
    busyRepos.set(repoUrl, job);
    schedule(job);
    res.status(202).json({ jobId: job.id, slug });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.get('/api/job/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found (it may have expired)' });
  res.json(publicJob(job));
});

app.get('/api/job/:id/events', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found (it may have expired)' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  res.write(`data: ${JSON.stringify(publicJob(job))}\n\n`);
  if (job.state === 'ready' || job.state === 'failed') return res.end();
  job.listeners.add(res);
  const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    job.listeners.delete(res);
  });
});

/* ------------------------------------------------------------------- atlas */

function graphOr404(fn, req, res) {
  try {
    res.json(fn());
  } catch (err) {
    res.status(err.statusCode || 404).json({ error: err.message });
  }
}

app.get('/api/atlas/:slug', (req, res) => {
  graphOr404(() => {
    const slug = repoSlug(req.params.slug);
    return atlas.overview(DATA_DIR, slug, { includeMeta: req.query.meta === '1' });
  }, req, res);
});

app.get('/api/atlas/:slug/module', (req, res) => {
  graphOr404(() => {
    const slug = repoSlug(req.params.slug);
    const id = String(req.query.id || '');
    if (id.length > 500) { const e = new Error('module id too long'); e.statusCode = 400; throw e; }
    return atlas.modulePayload(DATA_DIR, slug, id);
  }, req, res);
});

app.get('/api/atlas/:slug/node', (req, res) => {
  graphOr404(() => {
    const slug = repoSlug(req.params.slug);
    const id = String(req.query.id || '');
    if (!id || id.length > 500) { const e = new Error('symbol id required'); e.statusCode = 400; throw e; }
    return atlas.nodePayload(DATA_DIR, slug, id);
  }, req, res);
});

app.get('/api/atlas/:slug/search', (req, res) => {
  graphOr404(() => {
    const slug = repoSlug(req.params.slug);
    return { results: atlas.search(DATA_DIR, slug, req.query.q, 24) };
  }, req, res);
});

app.get('/api/meta/:slug', (req, res) => {
  graphOr404(() => {
    const slug = repoSlug(req.params.slug);
    const a = atlas.getAtlas(DATA_DIR, slug);
    return {
      slug, stats: a.stats, meta: a.meta, languages: a.languages,
      modules: a.moduleList.length,
    };
  }, req, res);
});


/* -------------------------------------------------- intelligence endpoints */

// LLM narration is a bonus, never a dependency: race it and keep facts on timeout.
function askWithTimeout(prompt, ms = Number(process.env.NARRATE_TIMEOUT_MS || 45000)) {
  return Promise.race([
    askGemma(prompt),
    new Promise((_, reject) => setTimeout(() => reject(new Error('narration timed out')), ms).unref?.()),
  ]);
}

const BRIEF_PROMPT = (facts) => `You are CodeAtlas, a precise codebase guide. Below are FACTS extracted from a Graphify knowledge graph (real symbols, real files). Write a short onboarding brief for a developer opening this repo for the first time.

Rules:
- Use ONLY symbols, files and modules that appear in the facts. Never invent names.
- Answer three questions, in this order: (1) what this codebase appears to be and its main job, (2) its 3-5 real modules and how they relate, (3) the exact reading order to understand it (name files/symbols).
- 130-190 words. Plain markdown, no headings, no preamble, no bullet-point spam (at most one short list).
- If the evidence is thin, say so plainly instead of guessing.

FACTS:
${JSON.stringify(facts).slice(0, 18000)}`;

const MODULE_PROMPT = (facts, snippetBlocks) => `You are CodeAtlas, helping a developer actually read a module. Using ONLY the facts and source excerpts below, explain:
1. What this module is responsible for (plain language).
2. How it connects to the rest of the repo (dependencies listed).
3. A reading order through its files — name the files, say what to look for in each.
4. One gotcha or thing that is easy to misunderstand.
120-200 words, concise markdown, no preamble. Never invent a symbol or file.

MODULE FACTS:
${JSON.stringify(facts).slice(0, 14000)}

SOURCE EXCERPTS:
${snippetBlocks || '(none available)'}`;

const SYMBOL_PROMPT = (facts, snippetBlock) => `You are CodeAtlas, explaining one symbol inside a real codebase. Using ONLY the facts and source excerpt below:
1. Say what it does, concretely.
2. Explain how it is used: who calls it and what it calls (from the lists).
3. Point at the next one or two places to read.
90-150 words, concise markdown, no preamble. Never invent symbols or files.

SYMBOL FACTS:
${JSON.stringify(facts).slice(0, 12000)}

SOURCE:
${snippetBlock || '(no source available)'}`;

app.get('/api/brief/:slug', async (req, res) => {
  try {
    const slug = repoSlug(req.params.slug);
    const atlasForBrief = atlas.getAtlas(DATA_DIR, slug);
    const facts = intel.briefFacts(atlasForBrief);
    const graphMtime = atlas.getAtlas(DATA_DIR, slug).graphMtimeMs;
    const cacheFile = path.join(DATA_DIR, 'briefs', `${slug}.json`);
    let cached = null;
    try { cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
    if (cached && cached.graphMtime === graphMtime && cached.narrative) {
      return res.json({ slug, facts, narrative: cached.narrative, provider: cached.provider, generatedAt: cached.generatedAt, cached: true });
    }
    if (req.query.narrate === '0') {
      return res.json({ slug, facts, narrative: null, provider: null });
    }
    try {
      const out = await askWithTimeout(BRIEF_PROMPT(facts));
      const payload = { slug, narrative: out.text, provider: out.provider, graphMtime, generatedAt: new Date().toISOString() };
      fs.writeFileSync(cacheFile, JSON.stringify(payload));
      res.json({ ...payload, facts });
    } catch (err) {
      res.json({ slug, facts, narrative: null, provider: null, warning: err.message });
    }
  } catch (err) {
    res.status(err.statusCode || 404).json({ error: err.message });
  }
});

app.post('/api/explain', async (req, res) => {
  try {
    const { slug, kind, id } = req.body || {};
    const s = repoSlug(slug);
    const data = intel.getIntel(DATA_DIR, s);
    let facts;
    let prompt;
    let snippets = [];
    if (kind === 'module') {
      facts = intel.moduleFacts(data.atlas, String(id || ''));
      if (!facts) { const e = new Error('module not found'); e.statusCode = 404; throw e; }
      for (const f of facts.topFiles.slice(0, 3)) {
        const sn = intel.snippet(DATA_DIR, s, f.file, null, { maxLines: 32 });
        if (sn) snippets.push(`## ${f.file} (L${sn.startLine}-L${sn.endLine})\n\`\`\`\n${sn.text}\n\`\`\``);
      }
      prompt = MODULE_PROMPT(facts, snippets.join('\n\n'));
    } else if (kind === 'symbol') {
      const nodeId = String(id || '');
      facts = intel.symbolFacts(data.atlas, data, nodeId);
      if (!facts) { const e = new Error('symbol not found'); e.statusCode = 404; throw e; }
      const sn = intel.snippet(DATA_DIR, s, facts.file, facts.loc, { maxLines: 55 });
      prompt = SYMBOL_PROMPT(facts, sn ? `## ${facts.file} (L${sn.startLine}-L${sn.endLine})\n\`\`\`\n${sn.text}\n\`\`\`` : '');
      if (sn) snippets.push(sn);
    } else {
      const e = new Error('kind must be "module" or "symbol"'); e.statusCode = 400; throw e;
    }

    if (req.body && req.body.narrate === false) {
      return res.json({ slug: s, kind, facts, narrative: null, provider: null, sources: snippets.map((x) => ({ file: x.file, startLine: x.startLine })) });
    }
    try {
      const out = await askWithTimeout(prompt);
      res.json({ slug: s, kind, facts, narrative: out.text, provider: out.provider });
    } catch (err) {
      res.json({ slug: s, kind, facts, narrative: null, provider: null, warning: err.message });
    }
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Facts-only symbol endpoint (fast, no model): powers the inspector.
app.get('/api/symbol/:slug', (req, res) => {
  try {
    const s = repoSlug(req.params.slug);
    const data = intel.getIntel(DATA_DIR, s);
    const facts = intel.symbolFacts(data.atlas, data, String(req.query.id || ''));
    if (!facts) return res.status(404).json({ error: 'symbol not found' });
    const sn = intel.snippet(DATA_DIR, s, facts.file, facts.loc, { maxLines: 40 });
    res.json({ ...facts, snippet: sn });
  } catch (err) {
    res.status(err.statusCode || 404).json({ error: err.message });
  }
});

// Deterministic dependency path: "how does A reach B?"
app.post('/api/path', (req, res) => {
  try {
    const s = repoSlug((req.body || {}).slug);
    const data = intel.getIntel(DATA_DIR, s);
    const resolve = (q) => {
      const v = String(q || '').trim();
      if (!v) return null;
      if (data.byId.has(v)) return data.byId.get(v);
      const exact = [...data.byId.values()].filter((n) => n.label.toLowerCase() === v.toLowerCase());
      if (exact.length) return exact.sort((a, b) => b.degree - a.degree)[0];
      const hits = intel.anchorNodes(data.atlas, v, 1);
      return hits[0] || null;
    };
    const from = resolve((req.body || {}).from);
    const to = resolve((req.body || {}).to);
    if (!from || !to) return res.status(404).json({ error: 'could not resolve both symbols' });
    const ids = intel.shortestPath(data, from.id, to.id, 8);
    if (!ids) return res.json({ found: false, from, to, message: 'no path within 8 hops' });
    const path = ids.map((id) => {
      const n = data.byId.get(id);
      return {
        id: n.id, label: n.label, kind: n.kind, file: n.file, loc: n.loc,
        module: data.atlas.moduleOf.get(n.id) || null,
      };
    });
    res.json({ found: true, from, to, path });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Legacy full graph (kept for tests and the agent skill).
app.get('/api/graph/:slug', (req, res) => {
  try {
    const graph = loadGraph(DATA_DIR, req.params.slug);
    res.json(graph);
  } catch {
    res.status(404).json({ error: 'graph not found' });
  }
});

/* -------------------------------------------------------------- file viewer */

const MAX_FILE_BYTES = 200 * 1024;
app.get('/api/file/:slug', (req, res) => {
  try {
    const slug = repoSlug(req.params.slug);
    const rel = String(req.query.path || '');
    if (!rel || rel.includes('\0') || path.isAbsolute(rel)) {
      return res.status(400).json({ error: 'relative path required' });
    }
    const repoDir = path.join(DATA_DIR, 'repos', slug);
    const abs = path.resolve(repoDir, rel);
    if (!abs.startsWith(repoDir + path.sep)) {
      return res.status(400).json({ error: 'path escapes repository' });
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return res.status(404).json({ error: 'source not available here (repo was indexed elsewhere or file is gone)' });
    }
    const buf = fs.readFileSync(abs).subarray(0, MAX_FILE_BYTES);
    if (buf.includes(0)) return res.status(415).json({ error: 'binary file' });
    res.json({
      path: rel,
      content: buf.toString('utf8'),
      truncated: fs.statSync(abs).size > MAX_FILE_BYTES,
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/* --------------------------------------------------------------------- ask */

app.post('/api/ask', async (req, res) => {
  try {
    const { slug, question, history } = req.body || {};
    if (!question || typeof question !== 'string' || question.length > 2000) {
      return res.status(400).json({ error: 'question required (max 2000 chars)' });
    }
    const s = repoSlug(slug);
    const r = intel.retrieve(DATA_DIR, s, question);

    const turns = Array.isArray(history) ? history.slice(-6)
      .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string')
      .map((t) => `${t.role === 'user' ? 'Developer' : 'CodeAtlas'}: ${t.content.slice(0, 1200)}`).join('\n') : '';

    const prompt = `You are CodeAtlas, a codebase reading companion. Answer using ONLY the grounded context below. Rules:
- Cite the specific symbol and \`file:line\` for every structural claim.
- If the context is insufficient, say exactly what is missing. Never invent symbols, files or behaviour.
- Prefer a direct answer, then the mechanism, then where to read next. Use short markdown.
- No preamble, no restating these instructions, no hidden reasoning.

## Grounded context for repo "${s}"
${r.context}
${turns ? `\n## Recent conversation\n${turns}` : ''}

## Question
${question}`;

    // Deterministic follow-ups from the graph, not model guesses.
    const followups = [];
    const a = r.anchors[0];
    if (a) {
      followups.push(`What calls ${a.label}?`);
      followups.push(`Explain ${a.file || a.label} in detail`);
    }
    if (r.sources.length > 1) followups.push(`How does ${r.sources[0].label} reach ${r.sources[1].label}?`);

    let out;
    try {
      out = await askGemma(prompt);
    } catch (err) {
      if (err.code !== 'MODEL_UNAVAILABLE') throw err;
      // Never invent an answer: return the grounded sources and say the guide is down.
      return res.json({
        answer: null, warning: err.message, provider: null,
        sources: r.sources, followups: followups.slice(0, 3),
      });
    }
    res.json({ answer: out.text, provider: out.provider, sources: r.sources, followups: followups.slice(0, 3) });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/* ------------------------------------------- graph-derived fallbacks */
// When the guide model is unreachable, tour and study still work: both are
// built from real symbols and files in the graph, never invented text.

function graphFacts(graph) {
  const nodes = (graph.nodes || []).filter((n) => n && n.label);
  const files = new Map();
  for (const n of nodes) if (n.file) files.set(n.file, (files.get(n.file) || 0) + 1);
  const topFiles = [...files.entries()].sort((a, b) => b[1] - a[1]);
  const byDegree = [...nodes].sort((a, b) => (b.degree || 0) - (a.degree || 0));
  const kinds = new Map();
  for (const n of nodes) {
    const k = String(n.kind || 'symbol');
    kinds.set(k, (kinds.get(k) || 0) + 1);
  }
  return { nodes, topFiles, byDegree, kinds: [...kinds.entries()].sort((a, b) => b[1] - a[1]) };
}

const ENTRY_FILE_RE = /(^|\/)(index|main|server|app|cli|__init__|mod|lib)\.(js|ts|jsx|tsx|mjs|cjs|py|go|rs|java|rb|php)$/i;

function graphTour(slug, graph) {
  const { nodes, topFiles, byDegree } = graphFacts(graph);
  if (!nodes.length) return `# 1. Open the repository\nNo symbols were extracted for \`${slug}\`.`;
  const entry = nodes.find((n) => ENTRY_FILE_RE.test(n.file || '')) || byDegree[0];
  const biggest = topFiles[0] ? { file: topFiles[0][0], count: topFiles[0][1] } : null;
  const hub = byDegree[0];
  const testFile = topFiles.find(([f]) => /(^|\/)(test|tests|spec|specs|__tests__)\//i.test(f));
  const stops = [];
  stops.push({
    title: `Start at ${entry.file || entry.label}`,
    read: `${entry.file || entry.label}${entry.label && entry.label !== entry.file ? `, ${entry.label}` : ''}`,
    why: 'The most direct way into the code — entry points fan out to everything else.',
  });
  if (biggest && biggest.file !== entry.file) {
    stops.push({
      title: `Then ${biggest.file}`,
      read: `${biggest.file} (${biggest.count} symbols)`,
      why: 'The densest file in the map; most of the behaviour lives here.',
    });
  }
  if (hub) {
    stops.push({
      title: `Follow the hub: ${hub.label}`,
      read: `${hub.label} — ${hub.file || 'unknown file'} ${hub.loc || ''}`.trim(),
      why: `Highest fan-out in the graph (${hub.degree || 0} links). Understanding it explains the rest.`,
    });
  }
  if (testFile) {
    stops.push({ title: `Read the tests: ${testFile[0]}`, read: testFile[0], why: 'Tests show the contract and expected behaviour better than prose.' });
  }
  stops.push({
    title: 'Where to make your first change',
    read: biggest ? biggest.file : (entry.file || entry.label),
    why: 'Start small: one function, one test, then run the suite.',
  });
  return stops.map((s, i) => `# ${i + 1}. ${s.title}\nRead: \`${s.read}\`\n${s.why}`).join('\n\n');
}

function graphStudyKit(slug, graph) {
  const { nodes, topFiles, byDegree, kinds } = graphFacts(graph);
  if (nodes.length < 4 || topFiles.length < 4) return null;
  const hub = byDegree[0];

  // Four real options, no invented names. Returns null when there are too few files.
  const options = (correct) => {
    const others = topFiles.map(([f]) => f).filter((f) => f !== correct).slice(0, 3);
    if (others.length < 3) return null;
    const list = [correct, ...others];
    const rot = correct.length % 4;
    const rotated = [...list.slice(rot), ...list.slice(0, rot)];
    return { options: rotated, answerIndex: rotated.indexOf(correct) };
  };

  const flashcards = [
    { front: `Which file owns the most symbols in ${slug}?`, back: topFiles[0][0] },
    { front: 'What is the most connected symbol in the repository?', back: hub.label },
    { front: `Which file defines ${hub.label}?`, back: hub.file || 'unknown' },
    { front: 'How many symbols does the map hold?', back: String(nodes.length) },
    { front: 'Which symbol kind is most common?', back: kinds[0] ? `${kinds[0][0]} (${kinds[0][1]})` : 'unknown' },
    { front: `Which file is the second densest after ${topFiles[0][0]}?`, back: topFiles[1][0] },
  ];

  const quiz = [];
  const q1 = options(topFiles[0][0]);
  if (q1) quiz.push({ question: `Which file owns the most symbols in ${slug}?`, ...q1, explanation: `${topFiles[0][0]} holds ${topFiles[0][1]} symbols — the highest count in the map.` });
  if (hub.file) {
    const q2 = options(hub.file);
    if (q2) quiz.push({ question: `Which file defines ${hub.label}?`, ...q2, explanation: `${hub.label} lives in ${hub.file} at ${hub.loc || 'an unknown line'}.` });
  }
  const q3 = options(topFiles[1][0]);
  if (q3) quiz.push({ question: `Which file is the second densest in ${slug}?`, ...q3, explanation: `${topFiles[1][0]} holds ${topFiles[1][1]} symbols, behind ${topFiles[0][0]}.` });

  return { flashcards, quiz };
}

app.get('/api/tour/:slug', async (req, res) => {
  try {
    const slug = repoSlug(req.params.slug);
    const cacheFile = path.join(DATA_DIR, 'tours', `${slug}.json`);
    if (fs.existsSync(cacheFile) && !req.query.refresh) {
      return res.json(JSON.parse(fs.readFileSync(cacheFile, 'utf8')));
    }
    const graph = loadGraph(DATA_DIR, slug);
    const context = buildTourContext(graph);
    const prompt = `You are CodeAtlas. Write a guided onboarding tour of the repo "${slug}" for a new contributor, based ONLY on the knowledge-graph digest below. Structure it as 4-7 numbered stops. Each stop: a markdown heading, which files/symbols to read (real names from the digest only), and one sentence on why this stop matters. Start with entry points, end with "where to make your first change". Keep it under 500 words. Output the tour directly as markdown — no preamble and no reasoning.

## Knowledge graph digest
${context}`;
    let out;
    try {
      out = await askGemma(prompt);
    } catch (err) {
      if (err.code !== 'MODEL_UNAVAILABLE') throw err;
      // The model is down; a real graph-derived tour beats an error screen.
      // Not cached, so a written tour replaces it once the model is back.
      return res.json({
        slug, tour: graphTour(slug, graph), provider: 'graph-derived',
        warning: err.message, generatedAt: new Date().toISOString(),
      });
    }
    const tour = { slug, tour: out.text, provider: out.provider, generatedAt: new Date().toISOString() };
    fs.writeFileSync(cacheFile, JSON.stringify(tour));
    res.json(tour);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// --- Study kit: JSON hardening for model output -----------------------------

function stripFences(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```[a-zA-Z]*\s*/m, '').replace(/```\s*$/m, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start !== -1 && end > start) t = t.slice(start, end + 1);
  return t;
}

function validateStudyKit(raw) {
  let obj;
  try { obj = JSON.parse(stripFences(raw)); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const flashcards = (Array.isArray(obj.flashcards) ? obj.flashcards : [])
    .filter((c) => c && typeof c.front === 'string' && typeof c.back === 'string')
    .map((c) => ({ front: c.front.trim(), back: c.back.trim() }))
    .filter((c) => c.front && c.back)
    .slice(0, 8);
  const quiz = (Array.isArray(obj.quiz) ? obj.quiz : [])
    .filter((q) => q && typeof q.question === 'string'
      && Array.isArray(q.options) && q.options.length === 4
      && q.options.every((o) => typeof o === 'string')
      && Number.isInteger(q.answerIndex) && q.answerIndex >= 0 && q.answerIndex <= 3)
    .map((q) => ({
      question: q.question.trim(),
      options: q.options.map((o) => o.trim()),
      answerIndex: q.answerIndex,
      explanation: typeof q.explanation === 'string' ? q.explanation.trim() : '',
    }))
    .slice(0, 3);
  if (flashcards.length < 4 || quiz.length < 3) return null;
  return { flashcards, quiz };
}

app.get('/api/studykit/:slug', async (req, res) => {
  try {
    const slug = repoSlug(req.params.slug);
    const cacheFile = path.join(DATA_DIR, 'studykits', `${slug}.json`);
    if (fs.existsSync(cacheFile) && !req.query.refresh) {
      return res.json(JSON.parse(fs.readFileSync(cacheFile, 'utf8')));
    }
    let graph;
    try {
      graph = loadGraph(DATA_DIR, slug);
    } catch {
      return res.status(404).json({ error: 'graph not found' });
    }
    const context = buildTourContext(graph);
    const prompt = `You are CodeAtlas. Create a study kit that helps a new contributor memorize the structure of the repo "${slug}", based ONLY on the knowledge-graph digest below. Every card and question must be about the codebase's structure (e.g. "What is the most connected symbol?", "Which module owns X?", "Where would a new adapter live?") and must quote ONLY real symbol and file names that appear in the digest — never invent any.

Respond with ONLY a single valid JSON object, no markdown fences, no commentary, exactly this shape:
{
  "flashcards": [{"front": "question about the codebase", "back": "the answer"}],
  "quiz": [{"question": "...", "options": ["A", "B", "C", "D"], "answerIndex": 0, "explanation": "why this answer is correct"}]
}

Rules:
- 6 to 8 flashcards, exactly 3 quiz questions. Keep every string concise.
- Every quiz item has exactly 4 options and answerIndex is the 0-based index of the correct option.
- Output raw JSON only. Do not wrap it in \`\`\` fences. Reply with the final answer only, no preamble, no reasoning.

## Knowledge graph digest
${context}`;
    let kit = null;
    let provider = null;
    let warning = null;
    try {
      for (let attempt = 1; attempt <= 2 && !kit; attempt++) {
        const out = await askGemma(attempt === 1 ? prompt
          : prompt + '\n\nIMPORTANT: Your previous reply was not valid JSON of the required shape. Reply again with ONLY the raw JSON object.');
        provider = out.provider;
        kit = validateStudyKit(out.text);
      }
    } catch (err) {
      if (err.code !== 'MODEL_UNAVAILABLE') throw err;
      warning = err.message;
    }
    if (!kit) {
      // Model down or unusable output: build real cards from the graph instead.
      const fallback = graphStudyKit(slug, graph);
      if (!fallback) return res.status(503).json({ error: warning || 'Not enough structure in this graph to build a study kit' });
      return res.json({
        slug, ...fallback, provider: 'graph-derived', warning,
        generatedAt: new Date().toISOString(),
      });
    }
    const payload = {
      slug, flashcards: kit.flashcards, quiz: kit.quiz,
      provider, generatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(cacheFile, JSON.stringify(payload));
    res.json(payload);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`CodeAtlas listening on :${PORT}`));
