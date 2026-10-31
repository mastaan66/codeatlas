// Fallback-guard tests: when a GEMINI_API_KEY is configured, a Gemini failure
// must NOT drag the ~10 GB local Ollama model into RAM — the server answers
// with a clear, retryable JSON error instead (and stays alive). Setting
// OLLAMA_FALLBACK=on restores the old fall-through behavior.
//
// No test reaches a real provider: GEMINI_BASE_URL and OLLAMA_URL both point
// at a dead port (connection refused immediately).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DEAD = 'http://127.0.0.1:1';

// 1x1 transparent PNG.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

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

function startServer(port, extraEnv) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      GEMINI_API_KEY: 'test-key-never-used',
      GEMINI_BASE_URL: DEAD,
      OLLAMA_URL: DEAD,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[server:${port}] ${d}`));
  return child;
}

async function waitHealthy(port) {
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return;
    } catch (_) {}
    if (Date.now() > deadline) throw new Error(`server on :${port} did not start within 10s`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function postStudy(port, timeoutMs = 15000) {
  const { body, contentType } = multipart(
    { language: 'en' },
    { field: 'image', name: 'tiny.png', type: 'image/png', data: TINY_PNG }
  );
  const res = await fetch(`http://127.0.0.1:${port}/api/study`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, json: await res.json() };
}

const GUARDED_PORT = 3103;
const OPTED_IN_PORT = 3104;
let guarded;
let optedIn;

before(async () => {
  guarded = startServer(GUARDED_PORT, {}); // key set, OLLAMA_FALLBACK unset → guarded
  optedIn = startServer(OPTED_IN_PORT, { OLLAMA_FALLBACK: 'on' });
  await Promise.all([waitHealthy(GUARDED_PORT), waitHealthy(OPTED_IN_PORT)]);
});

after(() => {
  for (const child of [guarded, optedIn]) {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 2000).unref();
    }
  }
});

test('key set + Gemini down: 5xx JSON asks for a retry and never touches Ollama', async () => {
  const { status, json } = await postStudy(GUARDED_PORT);
  assert.ok(status >= 500 && status < 600, `expected 5xx, got ${status}`);
  assert.equal(typeof json.error, 'string');
  assert.match(json.error, /try again/i);
  // The guard: no ollama attempt should appear in the provider errors.
  const detail = JSON.stringify(json.detail || '');
  assert.ok(!/ollama/i.test(detail), `ollama was attempted despite guard: ${detail}`);

  // Server survives the failure.
  const health = await fetch(`http://127.0.0.1:${GUARDED_PORT}/api/health`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(health.status, 200);
  assert.equal(guarded.exitCode, null, 'server must not have exited');
});

test('OLLAMA_FALLBACK=on: Gemini failure still falls through to Ollama attempts', async () => {
  const { status, json } = await postStudy(OPTED_IN_PORT);
  assert.ok(status >= 500 && status < 600, `expected 5xx, got ${status}`);
  const detail = JSON.stringify(json.detail || json.error || '');
  assert.ok(/gemini/i.test(detail), `gemini attempt missing: ${detail}`);
  assert.ok(/ollama/i.test(detail), `ollama attempt missing with fallback on: ${detail}`);
  assert.equal(optedIn.exitCode, null, 'server must not have exited');
});
