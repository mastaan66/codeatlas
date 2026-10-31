// Unit tests for lib/indexer.js — slug sanitizing, URL validation, seed graph loading.
// Never let tests reach the real Gemini API key from .env.
delete process.env.GEMINI_API_KEY;

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { repoSlug, indexRepo, loadGraph } = require('../lib/indexer');

// An empty scratch dataDir guarantees loadGraph falls back to seed-graphs/.
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeatlas-test-'));
test.after(() => fs.rmSync(scratchDir, { recursive: true, force: true }));

function isFriendly400(err) {
  assert.strictEqual(err.statusCode, 400, `expected statusCode 400, got ${err.statusCode}`);
  assert.ok(err instanceof Error);
  return true;
}

test('repoSlug sanitizes weird input to a safe slug', () => {
  assert.strictEqual(repoSlug('Owner/Repo.Name'), 'owner-repo-name');
  assert.strictEqual(repoSlug('  ../../etc/passwd  '), 'etc-passwd');
  assert.strictEqual(repoSlug('hello$(rm -rf)world'), 'hello-rm--rf-world'); // '-' is a legal slug char
});

test('repoSlug throws statusCode 400 on empty input', () => {
  assert.throws(() => repoSlug(''), isFriendly400);
  assert.throws(() => repoSlug('!!!///'), isFriendly400); // sanitizes to nothing
});

test('repoSlug throws statusCode 400 on oversized input', () => {
  assert.throws(() => repoSlug('a'.repeat(101)), isFriendly400);
});

test('indexRepo rejects non-GitHub URLs with a friendly 400', async () => {
  for (const url of [
    'https://gitlab.com/foo/bar',
    'http://github.com/foo/bar', // http, not https
    'https://github.com.evil.com/foo/bar',
    'not a url at all',
    '',
    undefined,
  ]) {
    await assert.rejects(indexRepo(scratchDir, url), isFriendly400, `should reject: ${url}`);
  }
});

test('indexRepo rejects javascript: URLs with a friendly 400', async () => {
  await assert.rejects(indexRepo(scratchDir, 'javascript:alert(1)'), isFriendly400);
  await assert.rejects(
    indexRepo(scratchDir, 'javascript://github.com/foo/bar'),
    isFriendly400,
  );
});

test('indexRepo rejects URLs with shell metacharacters with a friendly 400', async () => {
  for (const url of [
    'https://github.com/foo/bar;rm -rf /',
    'https://github.com/foo/$(whoami)',
    'https://github.com/foo/bar`id`',
    'https://github.com/foo/bar && curl evil',
    'https://github.com/foo/bar|cat',
  ]) {
    await assert.rejects(indexRepo(scratchDir, url), isFriendly400, `should reject: ${url}`);
  }
});

test('loadGraph("memolite") falls back to the bundled seed graph', () => {
  const graph = loadGraph(scratchDir, 'memolite');

  assert.strictEqual(graph.slug, 'memolite');
  assert.ok(Array.isArray(graph.nodes) && graph.nodes.length > 0, 'has nodes');
  assert.ok(Array.isArray(graph.links) && graph.links.length > 0, 'has links');
  assert.deepStrictEqual(
    {
      nodes: graph.stats.nodes,
      links: graph.stats.links,
    },
    { nodes: graph.nodes.length, links: graph.links.length },
    'stats match node/link counts',
  );
  assert.ok(graph.stats.communities > 0, 'has communities');

  // Every link endpoint must resolve to a served node.
  const ids = new Set(graph.nodes.map((n) => n.id));
  for (const l of graph.links) {
    assert.ok(ids.has(l.source), `link source exists: ${l.source}`);
    assert.ok(ids.has(l.target), `link target exists: ${l.target}`);
  }

  // Degree is computed and consistent with the links actually served.
  assert.ok(graph.nodes.some((n) => n.degree > 0), 'some node has degree > 0');
  const degree = new Map();
  for (const l of graph.links) {
    degree.set(l.source, (degree.get(l.source) || 0) + 1);
    degree.set(l.target, (degree.get(l.target) || 0) + 1);
  }
  for (const n of graph.nodes) {
    assert.ok(n.degree >= (degree.get(n.id) || 0), `degree for ${n.id} covers served links`);
  }
});
