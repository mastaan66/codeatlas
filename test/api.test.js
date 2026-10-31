// Integration tests: boot the real server as a child process on a test port.
// GEMINI_API_KEY is blanked and OLLAMA_URL points at a dead port so no LLM
// call can reach the network (dotenv never overrides vars already in env).
delete process.env.GEMINI_API_KEY;

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 3100;
const BASE = `http://127.0.0.1:${PORT}`;

let server;

// Raw http request so paths like /api/graph/../../etc are sent un-normalized.
function request(method, reqPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        method,
        path: reqPath,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch { /* non-JSON body is fine */ }
          resolve({ status: res.statusCode, json, body: data });
        });
      },
    );
    req.setTimeout(10000, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForServer(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await request('GET', '/api/health');
      if (res.status === 200) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not start on :${PORT}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

test.before(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      GEMINI_API_KEY: '', // falsy: no Gemini calls; dotenv won't overwrite it
      OLLAMA_URL: 'http://127.0.0.1:1', // dead port: Ollama fails fast, never hangs
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.on('error', (err) => { throw err; });
  await waitForServer();
});

test.after(() => {
  if (server && !server.killed) server.kill('SIGTERM');
});

test('GET /api/health reports ok', async () => {
  const res = await request('GET', '/api/health');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.ok, true);
  assert.strictEqual(res.json.provider, 'ollama-local'); // key really blanked
});

test('GET /api/repos includes the memolite seed', async () => {
  const res = await request('GET', '/api/repos');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.json.repos));
  assert.ok(res.json.repos.includes('memolite'), `repos: ${res.json.repos}`);
});

test('GET /api/graph/memolite returns the graph with stats', async () => {
  const res = await request('GET', '/api/graph/memolite');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.slug, 'memolite');
  assert.ok(res.json.stats.nodes > 0);
  assert.ok(res.json.stats.links > 0);
  assert.ok(res.json.nodes.length > 0 && res.json.links.length > 0);
});

test('GET /api/graph with a path-traversal slug is a clean 4xx, not a crash', async () => {
  const res = await request('GET', '/api/graph/../../etc');
  assert.ok(
    res.status === 400 || res.status === 404,
    `expected 400/404, got ${res.status}`,
  );
  // Server must still be alive and serving afterwards.
  const health = await request('GET', '/api/health');
  assert.strictEqual(health.status, 200);
});

test('POST /api/ask without a question is a 400', async () => {
  const res = await request('POST', '/api/ask', { slug: 'memolite' });
  assert.strictEqual(res.status, 400);
  assert.match(res.json.error, /question required/);
});

test('POST /api/index with a bad URL is a 400', async () => {
  const res = await request('POST', '/api/index', { repoUrl: 'https://evil.com/x;rm -rf /' });
  assert.strictEqual(res.status, 400);
  assert.match(res.json.error, /GitHub URL/);
});
