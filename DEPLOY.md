# Deploying CodeAtlas to Cloudways

CodeAtlas deploys on **Cloudways Velocity** (DigitalOcean), which builds Node apps straight from a GitHub repo.

## Steps

1. Push this repo to GitHub.
2. In Cloudways, create a **Velocity** app → connect the GitHub repo → pick the **Express** preset. Velocity auto-detects `npm install` / `npm start`; the server binds `process.env.PORT` automatically.
3. Set environment variables in the Velocity dashboard:
   - `GEMINI_API_KEY` — required in production (there is no local Ollama on the server).
   - `GEMMA_MODEL` — optional, defaults to `gemma-4-26b-a4b-it`.
4. Deploy. Done.

## What works where

| Capability | Local dev | Cloudways |
|---|---|---|
| Explore seeded graphs (memolite, expressjs-cors) | ✅ | ✅ bundled in `seed-graphs/` |
| Ask / Tour via Gemma 4 | ✅ (API or local Ollama) | ✅ via Gemini API |
| Live-index a new GitHub repo | ✅ (needs `git` + Graphify CLI) | ⚠️ needs `git` and `pip install graphifyy` available in the build image; otherwise the endpoint returns a clear error and the seeded demos keep working |

The app degrades gracefully by design: nothing on the critical demo path depends on tools the hosting image may lack.

## Notes

- Never commit `.env`; set secrets through the dashboard only.
- Servers bill hourly after the trial — delete unused servers after the event.
