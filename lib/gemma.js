// Gemma 4 access layer: Gemini API when GEMINI_API_KEY is set,
// otherwise local open-weight Gemma via Ollama. Both are Gemma 4.
const GEMMA_MODEL = process.env.GEMMA_MODEL || 'gemma-4-26b-a4b-it';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma4:latest';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

async function askGeminiApi(prompt) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMMA_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    },
  );
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`Gemini API ${res.status}: ${body}`);
  }
  const data = await res.json();
  // Gemma 4 interleaves thinking parts flagged `thought: true`; keep only the answer.
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .filter((p) => !p.thought && p.text)
    .map((p) => p.text)
    .join('');
  if (!text) throw new Error('Gemini API returned empty response');
  return { text, provider: `Gemma 4 · Gemini API (${GEMMA_MODEL})` };
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
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await askGeminiApi(prompt);
      } catch (err) {
        console.warn(`Gemini API attempt ${attempt} failed:`, err.message);
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1500)); // 5xx are often transient
      }
    }
    console.warn('Gemini API exhausted retries, falling back to local Ollama');
  }
  return askOllama(prompt);
}

module.exports = { askGemma };
