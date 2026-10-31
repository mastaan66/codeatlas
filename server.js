// SnapStudy server — Express + multer, no build step.
require('dotenv').config();
const path = require('path');
const express = require('express');
const multer = require('multer');
const { generateStudy, healthProvider } = require('./lib/gemma');

const app = express();
const PORT = process.env.PORT || 3002;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB — phone photos are big
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', async (_req, res) => {
  const p = await healthProvider();
  res.json({ ok: p.provider !== 'none', provider: p.provider, providerLabel: p.label });
});

app.post('/api/study', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded. Send multipart field "image".' });
    }
    if (!/^image\//.test(req.file.mimetype)) {
      return res.status(400).json({ error: 'Uploaded file is not an image.' });
    }
    const language = req.body.language === 'te' ? 'te' : 'en';

    const result = await generateStudy({
      imageBase64: req.file.buffer.toString('base64'),
      mimeType: req.file.mimetype,
      language,
      filename: req.file.originalname || 'notes',
    });

    res.json(result);
  } catch (err) {
    console.error('[/api/study]', err.message);
    res.status(502).json({
      error: 'Generation failed on all providers.',
      detail: err.providerErrors || err.message,
    });
  }
});

// Keep the JSON error contract even for errors thrown before route handlers
// (e.g. multer file-size/field rejections, which otherwise render HTML 500s).
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.name === 'MulterError' ? 400 : err.status || 500;
  console.error('[error]', err.message);
  res.status(status).json({ error: err.message || 'Internal error' });
});

const server = app.listen(PORT, () => {
  console.log(`SnapStudy listening on http://localhost:${PORT}`);
  console.log(
    process.env.GEMINI_API_KEY
      ? 'Primary provider: Gemini API (hosted Gemma 4), fallback: local Ollama'
      : 'No GEMINI_API_KEY — using local Ollama (Gemma 4 open weights)'
  );
});

// Local open-weights inference can take many minutes on CPU — don't let
// Node's default 5-minute requestTimeout kill in-flight generations.
server.requestTimeout = 0;
server.headersTimeout = 120000;
server.setTimeout(0);
