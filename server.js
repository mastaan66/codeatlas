// CodeAtlas — explore any codebase as an interactive knowledge graph.
// Express server: indexes GitHub repos via Graphify, serves the graph,
// and answers questions / generates onboarding tours with Gemma 4.
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');

const { indexRepo, listRepos, loadGraph, repoSlug } = require('./lib/indexer');
const { buildQuestionContext, buildTourContext } = require('./lib/graphContext');
const { askGemma } = require('./lib/gemma');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(path.join(DATA_DIR, 'repos'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'tours'), { recursive: true });

app.get('/api/health', (req, res) => {
  res.json({ ok: true, provider: process.env.GEMINI_API_KEY ? 'gemini-api' : 'ollama-local' });
});

app.get('/api/repos', (req, res) => {
  res.json({ repos: listRepos(DATA_DIR) });
});

// Index a public GitHub repo: shallow clone + graphify extract (local AST parsing).
app.post('/api/index', async (req, res) => {
  try {
    const { repoUrl } = req.body || {};
    const result = await indexRepo(DATA_DIR, repoUrl);
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.get('/api/graph/:slug', (req, res) => {
  try {
    const graph = loadGraph(DATA_DIR, req.params.slug);
    res.json(graph);
  } catch (err) {
    res.status(404).json({ error: 'graph not found' });
  }
});

// Ask a question about an indexed repo; graph context keeps Gemma grounded.
app.post('/api/ask', async (req, res) => {
  try {
    const { slug, question } = req.body || {};
    if (!question || typeof question !== 'string' || question.length > 2000) {
      return res.status(400).json({ error: 'question required (max 2000 chars)' });
    }
    const graph = loadGraph(DATA_DIR, slug);
    const context = buildQuestionContext(graph, question);
    const prompt = `You are CodeAtlas, a codebase guide. Answer using ONLY the knowledge-graph context below. Cite symbols and files by name. If the context is insufficient, say what is missing — never invent symbols.

## Knowledge graph context for repo "${slug}"
${context}

## Question
${question}`;
    const { text, provider } = await askGemma(prompt);
    res.json({ answer: text, provider });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Generate (and cache) a guided onboarding tour of the repo.
app.get('/api/tour/:slug', async (req, res) => {
  try {
    const slug = repoSlug(req.params.slug);
    const cacheFile = path.join(DATA_DIR, 'tours', `${slug}.json`);
    if (fs.existsSync(cacheFile) && !req.query.refresh) {
      return res.json(JSON.parse(fs.readFileSync(cacheFile, 'utf8')));
    }
    const graph = loadGraph(DATA_DIR, slug);
    const context = buildTourContext(graph);
    const prompt = `You are CodeAtlas. Write a guided onboarding tour of the repo "${slug}" for a new contributor, based ONLY on the knowledge-graph digest below. Structure it as 4-7 numbered stops. Each stop: a markdown heading, which files/symbols to read (real names from the digest only), and one sentence on why this stop matters. Start with entry points, end with "where to make your first change". Keep it under 500 words.

## Knowledge graph digest
${context}`;
    const { text, provider } = await askGemma(prompt);
    const tour = { slug, tour: text, provider, generatedAt: new Date().toISOString() };
    fs.writeFileSync(cacheFile, JSON.stringify(tour));
    res.json(tour);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`CodeAtlas listening on :${PORT}`));
