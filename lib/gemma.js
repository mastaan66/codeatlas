// lib/gemma.js — Gemma 4 AI layer with automatic provider fallback.
// Provider 1: Gemini API (hosted Gemma 4) when GEMINI_API_KEY is set.
// Provider 2: local Ollama (gemma4:latest, open weights) as fallback / offline mode.

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = process.env.GEMMA_MODEL || 'gemma-4-26b-a4b-it';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma4:latest';

const LANG_NAMES = { en: 'English', te: 'Telugu (తెలుగు)' };

function buildPrompt(language) {
  const lang = LANG_NAMES[language] || LANG_NAMES.en;
  return `You are SnapStudy, an expert study assistant. The attached image contains study material (handwritten notes, a whiteboard, or a textbook page).

Read ALL the text and concepts in the image, then produce study material ENTIRELY in ${lang}.

Respond with ONLY a single valid JSON object, no markdown fences, no commentary, exactly this shape:
{
  "summary": "a clean, well-organized summary of the material (3-8 sentences, may use short bullet-like sentences)",
  "flashcards": [{"front": "question or term", "back": "answer or definition"}],
  "quiz": [{"question": "...", "options": ["A", "B", "C", "D"], "answerIndex": 0, "explanation": "why this answer is correct"}]
}

Rules:
- 4 to 8 flashcards, 3 to 5 quiz questions.
- Every quiz item has exactly 4 options and answerIndex is the 0-based index of the correct option.
- All strings (summary, fronts, backs, questions, options, explanations) must be in ${lang}.
- Output raw JSON only. Do not wrap it in \`\`\` fences.`;
}

function buildTextOnlyPrompt(language, note) {
  const lang = LANG_NAMES[language] || LANG_NAMES.en;
  return `You are SnapStudy, an expert study assistant. Image understanding is unavailable right now, so instead create GENERAL study material about the topic hinted by the file name "${note}" — or, if that is not informative, about effective study techniques — ENTIRELY in ${lang}.

Respond with ONLY a single valid JSON object, no markdown fences:
{
  "summary": "...",
  "flashcards": [{"front": "...", "back": "..."}],
  "quiz": [{"question": "...", "options": ["A","B","C","D"], "answerIndex": 0, "explanation": "..."}]
}
4-8 flashcards, 3-5 quiz questions, exactly 4 options each, all text in ${lang}. Raw JSON only.`;
}

// --- JSON hardening -------------------------------------------------------

function stripFences(text) {
  let t = String(text || '').trim();
  // strip ```json ... ``` or ``` ... ```
  t = t.replace(/^```[a-zA-Z]*\s*/m, '').replace(/```\s*$/m, '').trim();
  // cut to the outermost JSON object
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start !== -1 && end > start) t = t.slice(start, end + 1);
  return t;
}

function tryParse(text) {
  try {
    return JSON.parse(stripFences(text));
  } catch (_) {
    return null;
  }
}

function validateStudy(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
  const flashcards = Array.isArray(obj.flashcards)
    ? obj.flashcards
        .filter((c) => c && typeof c.front === 'string' && typeof c.back === 'string')
        .map((c) => ({ front: c.front.trim(), back: c.back.trim() }))
    : [];
  const quiz = Array.isArray(obj.quiz)
    ? obj.quiz
        .filter(
          (q) =>
            q &&
            typeof q.question === 'string' &&
            Array.isArray(q.options) &&
            q.options.length >= 2 &&
            Number.isInteger(q.answerIndex)
        )
        .map((q) => {
          const options = q.options.slice(0, 4).map(String);
          while (options.length < 4) options.push('—');
          const answerIndex = Math.min(Math.max(q.answerIndex, 0), options.length - 1);
          return {
            question: q.question.trim(),
            options,
            answerIndex,
            explanation: typeof q.explanation === 'string' ? q.explanation.trim() : '',
          };
        })
    : [];
  if (!summary && flashcards.length === 0 && quiz.length === 0) return null;
  return { summary, flashcards, quiz };
}

// --- Providers ------------------------------------------------------------

async function callGemini(prompt, imageBase64, mimeType) {
  const model = DEFAULT_MODEL;
  const url = `${GEMINI_BASE}/${model}:generateContent`;
  const parts = [];
  if (imageBase64) parts.push({ inline_data: { mime_type: mimeType, data: imageBase64 } });
  parts.push({ text: prompt });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 4096 },
    }),
    signal: AbortSignal.timeout(120000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gemini API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  if (!text) throw new Error('Gemini API returned no text');
  return text;
}

async function callOllama(prompt, imageBase64) {
  const body = {
    model: OLLAMA_MODEL,
    prompt,
    stream: false,
    options: { temperature: 0.4 },
  };
  if (imageBase64) body.images = [imageBase64];

  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600000), // local inference can take minutes
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(`Ollama ${res.status}: ${bodyText.slice(0, 300)}`);
  }
  const data = await res.json();
  if (!data.response) throw new Error('Ollama returned no response text');
  return data.response;
}

// --- Public API -----------------------------------------------------------

/**
 * Generate study material from an image.
 * @returns {Promise<{summary, flashcards, quiz, provider, notice?}>}
 */
async function generateStudy({ imageBase64, mimeType, language = 'en', filename = 'notes' }) {
  const prompt = buildPrompt(language);
  const attempts = [];

  if (process.env.GEMINI_API_KEY) {
    attempts.push({
      provider: 'gemini',
      label: 'Gemma 4 · Gemini API',
      run: (p) => callGemini(p, imageBase64, mimeType),
    });
  }
  attempts.push({
    provider: 'ollama',
    label: 'Gemma 4 · local open weights',
    run: (p) => callOllama(p, imageBase64),
  });
  // Last-resort: local model without the image (if the local model rejects images).
  attempts.push({
    provider: 'ollama-text',
    label: 'Gemma 4 · local open weights',
    notice:
      'Image understanding was unavailable; generated from the topic instead. Connect a GEMINI_API_KEY or a vision-capable local model for full image support.',
    run: () => callOllama(buildTextOnlyPrompt(language, filename)),
  });

  const errors = [];
  for (const attempt of attempts) {
    try {
      let raw = await attempt.run(prompt);
      let parsed = validateStudy(tryParse(raw));
      if (!parsed) {
        // Retry once with an explicit fix-it instruction.
        const retryPrompt =
          prompt +
          '\n\nIMPORTANT: Your previous reply was not valid JSON. Reply again with ONLY the raw JSON object.';
        raw = await attempt.run(retryPrompt);
        parsed = validateStudy(tryParse(raw));
      }
      if (!parsed) throw new Error('Model did not return valid JSON after retry');
      const result = { ...parsed, provider: attempt.provider, providerLabel: attempt.label };
      if (attempt.notice) result.notice = attempt.notice;
      return result;
    } catch (err) {
      errors.push(`${attempt.provider}: ${err.message}`);
    }
  }
  const e = new Error(`All providers failed — ${errors.join(' | ')}`);
  e.providerErrors = errors;
  throw e;
}

async function healthProvider() {
  if (process.env.GEMINI_API_KEY) return { provider: 'gemini', label: 'Gemma 4 · Gemini API' };
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) return { provider: 'ollama', label: 'Gemma 4 · local open weights' };
  } catch (_) {}
  return { provider: 'none', label: 'no provider available' };
}

module.exports = { generateStudy, healthProvider };
