// Unit tests for lib/graphContext.js over the bundled memolite seed graph.
delete process.env.GEMINI_API_KEY;

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadGraph } = require('../lib/indexer');
const { buildQuestionContext, buildTourContext } = require('../lib/graphContext');

// Empty dataDir forces the seed-graphs/ fallback.
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeatlas-test-'));
test.after(() => fs.rmSync(scratchDir, { recursive: true, force: true }));

const graph = loadGraph(scratchDir, 'memolite');

test('buildQuestionContext surfaces matching symbols and the stats line', () => {
  const ctx = buildQuestionContext(graph, 'how does the memory store work');

  assert.strictEqual(typeof ctx, 'string');
  assert.match(ctx, /MemoryStore/, 'mentions the MemoryStore symbol');
  assert.match(ctx, /^Repo stats: \d+ symbols, \d+ relationships, \d+ modules/, 'starts with stats');
  assert.match(ctx, /### Symbols matching the question/);
  assert.match(ctx, /### Their relationships/);
});

test('buildTourContext digests communities and entry points', () => {
  const ctx = buildTourContext(graph);

  assert.strictEqual(typeof ctx, 'string');
  assert.match(ctx, /### Communities \(largest first\)/, 'has Communities section');
  assert.match(ctx, /### Likely entry points/, 'has entry points section');
  assert.match(ctx, /^Repo stats: \d+ symbols/, 'starts with stats');
});
