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
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  if (!text) throw new Error('Gemini API returned empty response');
  return { text, provider: `Gemma 4 · Gemini API (${GEMMA_MODEL})` };
}

async function askOllama(prompt) {
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      keep_alive: '15m',
      options: { num_predict: 700 }, // bound response length: CPU inference stays demo-friendly
    }),
    signal: AbortSignal.timeout(Number(process.env.OLLAMA_TIMEOUT_MS || 600000)),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const data = await res.json();
  if (!data.response) throw new Error('Ollama returned empty response');
  return { text: data.response, provider: `Gemma 4 · local open weights (${OLLAMA_MODEL})` };
}

async function askGemma(prompt) {
  if (process.env.GEMINI_API_KEY) {
    try {
      return await askGeminiApi(prompt);
    } catch (err) {
      console.warn('Gemini API failed, falling back to local Ollama:', err.message);
    }
  }
  return askOllama(prompt);
}

module.exports = { askGemma };
