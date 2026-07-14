# Waifu Bot

Personal WhatsApp AI Chatbot with Ollama Cloud, dashboard monitoring, and Redis persistence.

<img src="logo.svg" alt="logo" width="120" height="120">

## Features
- WhatsApp messaging via Baileys WebSocket
- LLM-powered conversations (Ollama Cloud)
- Image/PDF vision understanding
- Web search integration
- Sticker maker (image &rarr; WebP sticker)
- Proactive auto-chat scheduling
- Friend memory (facts + mood per user)
- Circuit breaker (auto-cooldown on LLM failure)
- Web dashboard (9 pages: overview, chat, analytics, logs, debug, etc.)
- JWT + bcrypt authentication
- Per-JID message serialization
- Context window with sliding summarization

## Tech Stack
- **Runtime:** Node.js &gt;=20 (ESM)
- **WhatsApp:** @whiskeysockets/baileys
- **LLM:** Ollama Cloud
- **Database:** Upstash Redis (ioredis)
- **Dashboard:** Static SPA + vanilla JS + Chart.js
- **Auth:** jsonwebtoken + bcrypt
- **Logging:** Pino
- **Image:** Sharp
- **PDF:** pdfjs-dist

## Quick Start

```bash
git clone <repo-url> waifu-bot
cd waifu-bot
cp .env.example .env
npm install
npm run build   # build dashboard assets
npm start       # or: npm run dev (watch mode)
```

## Environment Variables

Copy `.env.example` to `.env`. Key variables:

### Required
| Variable | Description |
|---|---|
| `OLLAMA_API_KEY` | Ollama Cloud API key |
| `BOT_NUMBER` | Bot WhatsApp number (e.g. 62812xxxxxx) |
| `OWNER_NUMBER` | Owner JID, comma-separated |
| `DASHBOARD_PASSWORD_HASH` | bcrypt hash of dashboard password |
| `JWT_SECRET` | JWT signing secret (long random hex) |
| `REDIS_URL` | Upstash Redis connection URL |

### Optional (notable)
| Variable | Default | Description |
|---|---|---|
| `OLLAMA_MODEL` | `gemma4:31b-cloud` | LLM model |
| `OLLAMA_TIMEOUT_MS` | `60000` | LLM request timeout |
| `SEARCH_LOOP_TIMEOUT_MS` | `30000` | Max search loop duration |
| `CIRCUIT_BREAKER_THRESHOLD` | `5` | Failures before cooldown |
| `CIRCUIT_BREAKER_COOLDOWN_MS` | `300000` | Cooldown duration (5min) |
| `MAX_CONTEXT_MESSAGES` | `30` | Context window size (private) |
| `MAX_GROUP_CONTEXT_MESSAGES` | `50` | Context window size (group) |
| `PORT` | `10000` | HTTP server port |
| `LOG_LEVEL` | `warn` | Pino log level |

Full list in `.env.example`.

## Deploy to Render + Upstash

### 1. Upstash Redis
1. Sign up at [upstash.com](https://upstash.com)
2. Create a Redis database (free tier: 256MB)
3. Copy the `REDIS_URL` (rediss://... with TLS)

### 2. Render
1. Push repo to GitHub
2. On [render.com](https://render.com), create a **Web Service**
3. Connect repo, branch `main`
4. Settings:
   - **Runtime:** Node
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm start`
   - **Plan:** Free
5. Add Environment Variables (all from `.env.example`):
   `OLLAMA_API_KEY`, `BOT_NUMBER`, `OWNER_NUMBER`,
   `DASHBOARD_PASSWORD_HASH`, `JWT_SECRET`, `REDIS_URL`
6. Deploy

### 3. UptimeRobot (optional, keeps free tier awake)
1. Sign up at [uptimerobot.com](https://uptimerobot.com)
2. Add monitor &rarr; HTTP(s) &rarr; `https://your-app.onrender.com/health`
3. Interval: 5 minutes

> **Note:** Render free tier spins down after 15 min of inactivity. UptimeRobot pings keep it warm. First request after idle takes ~30s (cold start).

## Architecture

```
index.js                       Entry: HTTP server + WhatsApp init
+-- src/                       Core modules (20 files)
|   +-- api-skeleton.js        27 API route handlers
|   +-- auth.js                JWT + bcrypt auth
|   +-- autochat.js            Proactive messaging scheduler
|   +-- badwords.js            Badword detection
|   +-- baileys.js             WhatsApp connection + Redis auth state
|   +-- chunks.js              Chunk send with retry & delivery
|   +-- circuit.js             Circuit breaker (cooldown flag)
|   +-- context.js             Context window + summarization
|   +-- dispatch.js            Per-JID serial queue + typing pulse
|   +-- gatekeeper.js          Message gatekeeper (shouldProcess, blacklist, whitelist)
|   +-- llm.js                 Ollama Cloud client + retry
|   +-- media.js               Vision (image) + PDF extraction
|   +-- memory.js              Friend memory (facts + mood)
|   +-- naturalize.js          Reply normalization
|   +-- personality.js         Loader & editor for personality.txt
|   +-- pipeline.js            processLLM orchestrator + search loop
|   +-- redis.js               Redis client + scanAll helper
|   +-- search.js              Web search integration
|   +-- sticker.js             Sticker maker (Sharp)
|   +-- util.js                Shared utilities
+-- dashboard/                 SPA dashboard (9 pages)
+-- test/                      20 test files, 256 tests
+-- personality.txt            Single source of truth for bot persona
+-- personality.txt.example    Template with persona structure
+-- logo.svg                   Bot logo
+-- .env                       Environment variables (gitignored)
```

## Message Flow

```
WhatsApp &rarr; Baileys &rarr; baileys.js
  &rarr; dispatch.js (per-JID queue, typing indicator)
    &rarr; gatekeeper.shouldProcess() (dedup, blacklist, whitelist, group rules)
      &rarr; pipeline.processLLM()
        +-- [parallel] Context loading + media extraction + friend memory
        +-- Build system prompt + LLM call
        +-- Search loop (&le;2 iter, 30s timeout via AbortController)
        +-- Memory token extraction (fire-and-forget)
        +-- Naturalize + split + sendChunks
        +-- Context summarization (fire-and-forget)
```

## Commands
| Command | Description |
|---|---|
| `npm start` | Start production bot + HTTP server |
| `npm run dev` | Start with file watching (--watch) |
| `npm test` | Run test suite (256 tests) |
| `npm run build` | Build dashboard static files |
| `npm run lint` | Lint source code |

## Monitoring
- Dashboard at `http://host:PORT/`
- Health check at `GET /health` (for UptimeRobot)
- Circuit breaker auto-recovers after cooldown
- Owner notified via WhatsApp when breaker trips

## Conventions
- **ESM only** (`import`/`export`, no CommonJS)
- **Async/await** throughout
- **Pino** for logging (warn level in production)
- `personality.txt` = single source of truth for bot persona
