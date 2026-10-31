// Clone + index repos with Graphify. All child processes use execFile with
// argument arrays (no shell interpolation); cloned code is parsed, never executed.
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const GITHUB_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const MAX_NODES_SERVED = 4000; // keep the browser payload sane for huge repos

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
    execFile(cmd, args, { timeout: opts.timeout || 180000, ...opts }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${cmd} failed: ${stderr || error.message}`.slice(0, 500);
        return reject(error);
      }
      resolve({ stdout, stderr });
    });
  });
}

async function indexRepo(dataDir, repoUrl) {
  const m = GITHUB_URL_RE.exec(String(repoUrl || '').trim());
  if (!m) {
    const err = new Error('expected a public GitHub URL like https://github.com/owner/repo');
    err.statusCode = 400;
    throw err;
  }
  const [, owner, name] = m;
  const slug = repoSlug(`${owner}-${name}`);
  const repoDir = path.join(dataDir, 'repos', slug);

  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    fs.rmSync(repoDir, { recursive: true, force: true });
    await run('git', ['clone', '--depth', '1', '--single-branch',
      `https://github.com/${owner}/${name}.git`, repoDir]);
  }

  const graphFile = path.join(repoDir, 'graphify-out', 'graph.json');
  if (!fs.existsSync(graphFile)) {
    // Local AST extraction (tree-sitter) — no model calls, no code execution.
    await run('graphify', ['extract', repoDir, '--code-only'], { timeout: 300000 });
  }
  const graph = loadGraph(dataDir, slug);
  return { slug, stats: graph.stats };
}

const SEED_DIR = path.join(__dirname, '..', 'seed-graphs');

function listRepos(dataDir) {
  const reposDir = path.join(dataDir, 'repos');
  const live = fs.readdirSync(reposDir).filter((d) =>
    fs.existsSync(path.join(reposDir, d, 'graphify-out', 'graph.json')));
  const seeds = fs.existsSync(SEED_DIR)
    ? fs.readdirSync(SEED_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
    : [];
  return [...new Set([...live, ...seeds])];
}

function loadGraph(dataDir, rawSlug) {
  const slug = repoSlug(rawSlug);
  let graphFile = path.join(dataDir, 'repos', slug, 'graphify-out', 'graph.json');
  if (!fs.existsSync(graphFile)) {
    // Bundled demo graphs keep the hosted deployment working even when
    // the Graphify CLI isn't installed on the server.
    graphFile = path.join(SEED_DIR, `${slug}.json`);
  }
  const raw = JSON.parse(fs.readFileSync(graphFile, 'utf8'));

  // Degree map for sizing + trimming.
  const degree = new Map();
  for (const l of raw.links || []) {
    degree.set(l.source, (degree.get(l.source) || 0) + 1);
    degree.set(l.target, (degree.get(l.target) || 0) + 1);
  }

  let nodes = (raw.nodes || []).map((n) => ({
    id: n.id,
    label: n.label || n.id,
    community: n.community ?? -1,
    file: n.source_file || null,
    loc: n.source_location || null,
    callable: !!n._callable,
    degree: degree.get(n.id) || 0,
  }));

  if (nodes.length > MAX_NODES_SERVED) {
    nodes = nodes.sort((a, b) => b.degree - a.degree).slice(0, MAX_NODES_SERVED);
  }
  const keep = new Set(nodes.map((n) => n.id));
  const links = (raw.links || [])
    .filter((l) => keep.has(l.source) && keep.has(l.target))
    .map((l) => ({ source: l.source, target: l.target, rel: l.relation || l.rel || l.type || '' }));

  const communities = new Set(nodes.map((n) => n.community));
  return {
    slug,
    nodes,
    links,
    stats: { nodes: nodes.length, links: links.length, communities: communities.size },
  };
}

module.exports = { indexRepo, listRepos, loadGraph, repoSlug };
