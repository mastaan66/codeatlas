// API integration tests: boot server.js as a child on PORT=3102 with every
// AI provider unreachable (GEMINI_API_KEY cleared so no real Google calls,
// OLLAMA_URL pointed at a dead port) and exercise the HTTP contract.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 3102;
const BASE = `http://127.0.0.1:${PORT}`;

// 1x1 transparent PNG.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

let child;

function multipart(fields, file) {
  const boundary = '----snapstudy-test-' + Math.random().toString(16).slice(2);
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      )
    );
  }
  if (file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\n` +
          `Content-Type: ${file.type}\r\n\r\n`
      )
    );
    chunks.push(file.data, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function postStudy(fields, file, timeoutMs = 15000) {
  const { body, contentType } = multipart(fields, file);
  const res = await fetch(`${BASE}/api/study`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, json: await res.json() };
}

before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      // Empty string is still "set" for dotenv, so .env cannot re-inject the
      // real key — tests must never reach Google.
      GEMINI_API_KEY: '',
      // Dead endpoint: connection refused immediately, providers fail fast.
      OLLAMA_URL: 'http://127.0.0.1:1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch (_) {}
    if (Date.now() > deadline) throw new Error('server did not start within 10s');
    await new Promise((r) => setTimeout(r, 150));
  }
});

after(() => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 2000).unref();
  }
});

test('GET /api/health responds 200 JSON with ok + provider fields', async () => {
  const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(15000) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.ok, 'boolean');
  assert.equal(typeof body.provider, 'string');
  // With no key and Ollama unreachable there is genuinely no provider.
  assert.equal(body.provider, 'none');
  assert.equal(body.ok, false);
});

test('POST /api/study with no file returns 400 JSON error', async () => {
  const { status, json } = await postStudy({ language: 'en', mode: 'all' });
  assert.equal(status, 400);
  assert.match(json.error, /no image/i);
});

test('POST /api/study with a non-image upload returns 400 JSON error', async () => {
  const { status, json } = await postStudy(
    { language: 'en', mode: 'all' },
    { field: 'image', name: 'notes.txt', type: 'text/plain', data: Buffer.from('just text') }
  );
  assert.equal(status, 400);
  assert.match(json.error, /not an image/i);
});

test('POST /api/study with a real PNG and all providers down fails gracefully (5xx JSON, no crash)', async () => {
  const { status, json } = await postStudy(
    { language: 'en', mode: 'all' },
    { field: 'image', name: 'tiny.png', type: 'image/png', data: TINY_PNG }
  );
  assert.ok(status >= 500 && status < 600, `expected 5xx, got ${status}`);
  assert.equal(typeof json.error, 'string');

  // Server must still be alive afterwards.
  const health = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5000) });
  assert.equal(health.status, 200);
  assert.equal(child.exitCode, null, 'server child process must not have exited');
});
