// Budgeted repository scan: pick the files that describe architecture, not the
// ones that merely exist. Large repos (vLLM, Chromium-sized) have tens of
// thousands of source files; feeding all of them to the extractor is what makes
// "index this repo" run forever. We choose a bounded, breadth-first slice and
// hard-link it into a staging tree, preserving relative paths.
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const CODE_EXT = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte',
  '.py', '.pyi', '.go', '.rs', '.java', '.kt', '.kts', '.scala',
  '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx', '.cu', '.cuh',
  '.m', '.mm', '.swift', '.cs', '.fs', '.rb', '.php', '.pl', '.pm',
  '.lua', '.r', '.jl', '.ex', '.exs', '.erl', '.hrl', '.hs', '.ml', '.mli',
  '.clj', '.cljs', '.dart', '.zig', '.nim', '.sh', '.bash', '.zsh', '.fish',
  '.sql', '.proto', '.graphql', '.gql',
]);

const EXCLUDED_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', 'vendor',
  'vendors', 'third_party', 'third-party', 'thirdparty', 'external', 'extern',
  'deps', 'dist', 'build', 'out', 'output', 'target', 'bin', 'obj',
  '.venv', 'venv', 'env', '__pycache__', '.mypy_cache', '.pytest_cache',
  '.ruff_cache', '.tox', '.next', '.nuxt', '.svelte-kit', '.cache',
  'coverage', 'htmlcov', '.coverage', 'site-packages', 'Pods', 'DerivedData',
  '.idea', '.vscode', '.gradle', '.terraform', 'generated', 'gen', '__generated__',
]);

// Source roots get a nudge; tests/benchmarks/examples get pushed back.
const SOURCE_ROOTS = new Set([
  'src', 'lib', 'app', 'apps', 'pkg', 'packages', 'internal', 'cmd',
  'core', 'server', 'client', 'services', 'api', 'crates', 'modules',
]);

const LOW_VALUE_RE = /(^|\/)(tests?|__tests__|spec|specs|benchmarks?|benches|examples?|samples?|docs?|documentation|fixtures?|testdata|mocks?|__mocks__|e2e|integration_tests?)(\/|$)/i;
const GENERATED_RE = /(\.min\.(js|css)$|\.bundle\.js$|[-.]generated\.|\.g\.dart$|_pb2\.py$|_pb2_grpc\.py$|\.pb\.go$|\.pb\.cc$|\.pb\.h$|\.designer\.cs$|\.map$)/i;
const ENTRY_RE = /(^|\/)(main|index|app|server|cli|__main__|mod|lib|program)\.[A-Za-z0-9]+$/i;

const DEFAULT_MAX_FILES = Number(process.env.MAX_INDEX_FILES || 1200);
const DEFAULT_MAX_FILE_KB = Number(process.env.MAX_FILE_KB || 256);

function sh(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: opts.timeout || 30000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(String(stdout));
    });
  });
}

function isCode(rel) {
  if (GENERATED_RE.test(rel)) return false;
  const ext = path.extname(rel).toLowerCase();
  return CODE_EXT.has(ext);
}

function isExcluded(rel) {
  const parts = rel.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    if (EXCLUDED_DIRS.has(parts[i])) return true;
  }
  return false;
}

async function listTrackedFiles(repoDir) {
  try {
    const out = await sh('git', ['-C', repoDir, 'ls-files', '-z']);
    return out.split('\0').filter(Boolean);
  } catch {
    // Not a git checkout (or git missing): bounded recursive walk.
    const out = [];
    const walk = (dir, depth) => {
      if (out.length > 60000 || depth > 14) return;
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name.startsWith('.') && ent.name !== '.github') continue;
        if (EXCLUDED_DIRS.has(ent.name)) continue;
        const abs = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(abs, depth + 1);
        else if (ent.isFile()) out.push(path.relative(repoDir, abs).split(path.sep).join('/'));
      }
    };
    walk(repoDir, 0);
    return out;
  }
}

function scoreFile(rel, sizeBytes) {
  const depth = rel.split('/').length - 1;
  const first = rel.split('/')[0];
  const dir = path.dirname(rel);
  let score = 0;
  if (ENTRY_RE.test(rel)) score += 90;
  if (SOURCE_ROOTS.has(first)) score += 45;
  else if (first === '.github') score -= 40;
  if (LOW_VALUE_RE.test(rel)) score -= 110;
  if (/(^|\/)(README|CHANGELOG|CONTRIBUTING|LICENSE|SECURITY)/i.test(rel)) score -= 60;
  // Architecture lives near the top and in the middle of the tree.
  score -= Math.min(45, depth * 7);
  // Prefer readable units over 400-byte stubs and 2-MB monsters.
  const kb = sizeBytes / 1024;
  if (kb < 0.4) score -= 8;
  if (kb > 120) score -= 25;
  score += Math.min(12, Math.log2(Math.max(kb, 1)) * 2);
  // Test and example paths are context, not structure.
  if (/(^|\/)(tests?|spec|__tests__)(\/|$)/i.test(dir + '/')) score -= 50;
  return score;
}

function topKey(rel, depth) {
  return rel.split('/').slice(0, Math.min(depth, rel.split('/').length - 1)).join('/') || '.';
}

// Fair-share the budget across top-level areas. Weight is sqrt(size) so a huge
// area gets more but never everything; test/docs/example trees are discounted.
// Allocation is exact (never over-subscribes the budget), so no area is silently
// dropped by a final slice — the bug that once gave vLLM zero of its own files.
const LOW_VALUE_GROUP_RE = /^(tests?|__tests__|spec|specs|benchmarks?|benches|examples?|samples?|docs?|documentation|scripts?|docker|\.github|\.buildkite|\.agents|\.claude)$/i;

function groupWeight(key, count) {
  const factor = LOW_VALUE_GROUP_RE.test(key) ? 0.3 : 1;
  return Math.sqrt(count) * factor;
}

function selectFiles(entries, maxFiles) {
  const groups = new Map();
  for (const e of entries) {
    const key = topKey(e.path, 1);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const arr = [...groups.entries()].map(([key, list]) => {
    list.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return { key, list, weight: groupWeight(key, list.length) };
  }).sort((a, b) => b.weight - a.weight);

  if (arr.length >= maxFiles) {
    return arr.slice(0, maxFiles).map((g) => g.list[0]);
  }

  const totalW = arr.reduce((n, g) => n + g.weight, 0) || 1;
  const alloc = new Map();
  let budget = maxFiles;
  for (const g of arr) {
    const ideal = (maxFiles * g.weight) / totalW;
    const share = Math.max(1, Math.min(g.list.length, Math.floor(ideal)));
    alloc.set(g.key, share);
    budget -= share;
  }
  // Hand out the remainder by largest fractional part, then round-robin.
  const byFraction = [...arr].sort((a, b) => {
    const fa = (maxFiles * a.weight) / totalW - Math.floor((maxFiles * a.weight) / totalW);
    const fb = (maxFiles * b.weight) / totalW - Math.floor((maxFiles * b.weight) / totalW);
    return fb - fa;
  });
  for (const g of byFraction) {
    if (budget <= 0) break;
    const cur = alloc.get(g.key);
    if (cur < g.list.length) { alloc.set(g.key, cur + 1); budget -= 1; }
  }
  let progressed = true;
  while (budget > 0 && progressed) {
    progressed = false;
    for (const g of byFraction) {
      if (budget <= 0) break;
      const cur = alloc.get(g.key);
      if (cur < g.list.length) { alloc.set(g.key, cur + 1); budget -= 1; progressed = true; }
    }
  }

  const chosen = [];
  const leftovers = [];
  for (const g of arr) {
    const take = alloc.get(g.key) || 0;
    chosen.push(...g.list.slice(0, take));
    leftovers.push(...g.list.slice(take));
  }
  if (chosen.length < maxFiles && leftovers.length) {
    leftovers.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    chosen.push(...leftovers.slice(0, maxFiles - chosen.length));
  }
  return chosen.slice(0, maxFiles);
}

// Pick the architecture slice. Returns { files, skipped, totalFiles, totalBytes }.
async function planIndex(repoDir, opts = {}) {
  const maxFiles = opts.maxFiles || DEFAULT_MAX_FILES;
  const maxFileBytes = (opts.maxFileKb || DEFAULT_MAX_FILE_KB) * 1024;
  const tracked = await listTrackedFiles(repoDir);

  // Bound the stat calls: listTrackedFiles already caps the walk.
  const entries = [];
  let skippedLarge = 0;
  for (const rel of tracked) {
    if (!isCode(rel) || isExcluded(rel)) continue;
    const abs = path.join(repoDir, rel);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (!st.isFile()) continue;
    if (st.size === 0) continue;
    if (st.size > maxFileBytes) { skippedLarge += 1; continue; }
    entries.push({ path: rel, size: st.size, score: scoreFile(rel, st.size) });
  }

  const files = selectFiles(entries, maxFiles).sort((a, b) => a.path.localeCompare(b.path));
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  return {
    files,
    totalFiles: entries.length,
    skippedLarge,
    totalBytes,
    budget: { maxFiles, maxFileKb: opts.maxFileKb || DEFAULT_MAX_FILE_KB },
  };
}

// Hard-link (same volume) or copy the slice into a staging tree. Hard links are
// effectively free and keep the original repo intact for the file viewer.
function stageFiles(repoDir, stageDir, files) {
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  let linked = 0, copied = 0, bytes = 0;
  for (const f of files) {
    const src = path.join(repoDir, f.path);
    const dst = path.join(stageDir, f.path);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    try {
      fs.linkSync(src, dst);
      linked += 1;
    } catch {
      try {
        fs.copyFileSync(src, dst);
        copied += 1;
      } catch { continue; }
    }
    bytes += f.size;
  }
  return { linked, copied, bytes, files: linked + copied };
}

async function repoHead(repoDir) {
  try {
    return (await sh('git', ['-C', repoDir, 'rev-parse', 'HEAD'])).trim();
  } catch {
    return null;
  }
}

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

module.exports = {
  planIndex,
  stageFiles,
  repoHead,
  humanBytes,
  scoreFile,
  selectFiles,
  isCode,
  isExcluded,
  CODE_EXT,
  EXCLUDED_DIRS,
  DEFAULT_MAX_FILES,
};
