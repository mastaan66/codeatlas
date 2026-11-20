// Gemma 4 access layer: Gemini API when GEMINI_API_KEY is set,
// otherwise local open-weight Gemma via Ollama. Both are Gemma 4.
//
// A single model can be temporarily unavailable (503) or not enabled on a key
// (404), so we walk a chain of models before giving up. When nothing answers we
// throw a typed MODEL_UNAVAILABLE error: callers degrade to graph-derived
// answers instead of leaking "ECONNREFUSED" to the UI.
const PRIMARY_MODEL = process.env.GEMMA_MODEL || 'gemma-4-26b-a4b-it';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma4:latest';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

const MODEL_CHAIN = String(
  process.env.GEMMA_MODELS || [PRIMARY_MODEL, 'gemini-3-flash-preview', 'gemma-4-31b-it', 'gemini-3.1-flash-lite'].join(','),
)
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean)
  .filter((m, i, all) => all.indexOf(m) === i);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function modelError(message, status) {
  const err = new Error(message);
  if (status) err.status = status;
  return err;
}

async function askGeminiApi(prompt, model, timeoutMs) {
  const isGemini3 = /^gemini-3/.test(model);
  // Gemma models get the plain request they were validated against; Gemini 3
  // gets a bounded, non-thinking response so the UI never waits a minute.
  const generationConfig = isGemini3
    ? { maxOutputTokens: 1400, thinkingConfig: { thinkingBudget: 0 } }
    : undefined;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        ...(generationConfig ? { generationConfig } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs || Number(process.env.GEMINI_TIMEOUT_MS || 25000)),
    },
  );
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    const err = modelError(`Gemini API ${res.status}: ${body}`, res.status);
    const retryAfter = Number(res.headers.get('retry-after'));
    if (retryAfter) err.retryAfterMs = retryAfter * 1000;
    throw err;
  }
  const data = await res.json();
  // Gemma 4 interleaves thinking parts flagged `thought: true`; keep only the answer.
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .filter((p) => !p.thought && p.text)
    .map((p) => p.text)
    .join('');
  if (!text) throw modelError('Gemini API returned empty response');
  return { text, provider: `Gemma 4 · Gemini API (${model})` };
}

// Plain node:http, not fetch: undici enforces a 300s headers timeout that a
// queued/CPU-bound local model easily exceeds, independent of any AbortSignal.
function askOllama(prompt) {
  const http = require('http');
  const url = new URL(`${OLLAMA_URL}/api/generate`);
  const body = JSON.stringify({
    model: OLLAMA_MODEL,
    prompt,
    stream: true,
    keep_alive: '15m',
    options: { num_predict: 700 }, // bound response length: CPU inference stays demo-friendly
  });
  const timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS || 900000);

  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Ollama ${res.statusCode}`));
      }
      let text = '';
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const data = JSON.parse(line);
            if (data.response) text += data.response;
            if (data.error) return reject(new Error(data.error));
          } catch { /* partial line; ignore */ }
        }
      });
      res.on('end', () => {
        if (!text) return reject(new Error('Ollama returned empty response'));
        resolve({ text, provider: `Gemma 4 · local open weights (${OLLAMA_MODEL})` });
      });
      res.on('error', reject);
    });
    const timer = setTimeout(() => req.destroy(new Error(`Ollama timed out after ${timeoutMs}ms`)), timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end(body);
  });
}

async function askGemma(prompt) {
  if (process.env.GEMINI_API_KEY) {
    // Hedge the chain: start Gemma 4, then start the next model if the first has
    // not answered after a few seconds. Whichever answers first wins, so an
    // overloaded model (503) never costs the user a minute of waiting.
    const hedgeMs = Number(process.env.GEMMA_HEDGE_MS || 8000);
    const perModelMs = Number(process.env.GEMINI_TIMEOUT_MS || 25000);
    const attempts = MODEL_CHAIN.map((model, i) => {
      const start = () => askGeminiApi(prompt, model, perModelMs)
        .catch((err) => {
          console.warn(`Gemini ${model} failed: ${err.message}`);
          throw err;
        });
      return i === 0 ? start() : sleep(hedgeMs * i).then(start);
    });
    // Hard budget: Promise.any alone would wait for the slowest rejection.
    const budgetMs = Number(process.env.GEMMA_BUDGET_MS || 20000);
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no model answered within ${budgetMs}ms`)), budgetMs);
    });
    try {
      const out = await Promise.race([Promise.any(attempts), deadline]);
      clearTimeout(timer);
      return out;
    } catch (err) {
      clearTimeout(timer);
      console.warn(`All Gemini models failed within budget (${MODEL_CHAIN.join(', ')}): ${err.message}`);
    }
  }
  try {
    return await askOllama(prompt);
  } catch (ollamaErr) {
    console.warn(`Ollama unavailable: ${ollamaErr.message}`);
    const err = new Error(
      'The guide model is busy right now. The map, symbol inspector and file reader still work — try again in a minute.',
    );
    err.code = 'MODEL_UNAVAILABLE';
    err.cause = ollamaErr;
    throw err;
  }
}

module.exports = { askGemma, MODEL_CHAIN };
