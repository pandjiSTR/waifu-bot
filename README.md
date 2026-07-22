<p align="center">
  <img src="logo.svg" alt="Ara" width="140" height="140">
</p>

<h1 align="center">Ara</h1>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen?logo=node.js" alt="Node">
  <img src="https://img.shields.io/badge/tests-256%20passing-green" alt="Tests">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License">
  <img src="https://img.shields.io/badge/deploy-Render-blue?logo=render" alt="Render">
</p>

<p align="center">
  Personal Discord AI Chatbot — powered by Ollama Cloud, built with discord.js, backed by Redis.
</p>

---

## Features

| | Feature | Description |
|---|---|---|
| 🧠 | **LLM-Powered** | Ollama Cloud — smart, fast, context-aware (30-50 messages) |
| 💬 | **Natural Conversation** | Personality-driven replies — cold start, warm hugs |
| 📸 | **Vision (Image Analysis)** | Describe, identify, react to images in chat |
| 🔍 | **Web Search** | Real-time search integration when asked about facts |
| 💭 | **Friend Memory** | Remembers facts, mood, and relationship per user |
| 😂 | **Laugh Guard** | Context-aware laugh suppression — never over-laughs |
| 🗂️ | **Context Window** | Sliding window with auto-summarization for long convos |
| 🛡️ | **Circuit Breaker** | Auto-cooldown on LLM failure — prevents cascading errors |
| 📊 | **Dashboard** | 9 SPA pages: overview, chat, analytics, logs, debug, settings |
| ⚡ | **Parallel Processing** | Context loading + image analysis + friend memory in parallel |
| 🚦 | **Rate Limiting** | Per-user message dedup + rate limiting |
| 🔄 | **Auto-Retry** | Message delivery with exponential backoff (3 retries) |
| 📅 | **Proactive Chat** | Auto-send periodic messages to owner |
| 🔎 | **Search Loop** | Up to 2 search iterations, 30s timeout via AbortController |
| 💾 | **Durable Storage** | Upstash Redis — persistence across restarts |
| 🌐 | **Group Aware** | Responds to mentions, replies, and "ara" prefix in servers |
| 📋 | **Blacklist/Whitelist** | User-level access control |

---

## Tech Stack

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20-339933?logo=node.js" alt="Node.js">
  <img src="https://img.shields.io/badge/Redis-Upstash-DC382D?logo=redis" alt="Redis">
  <img src="https://img.shields.io/badge/Ollama-Cloud-000?logo=ollama" alt="Ollama">
  <img src="https://img.shields.io/badge/discord.js-Discord-5865F2?logo=discord" alt="discord.js">
</p>

---

## Prerequisites

- **Node.js >=20** — [download](https://nodejs.org)
- **Ollama Cloud account** — [sign up](https://ollama.com)
- **Upstash Redis** — [sign up](https://upstash.com) (free 256MB tier)
- **Discord Bot Token** — create at https://discord.com/developers/applications

---

## Quick Start

```bash
git clone <repo-url> ara
cd ara
cp .env.example .env
npm install
npm run build
npm start
```

---

## Architecture

```
ara/
├── index.js                    HTTP server + Discord init
├── src/                        Core modules
│   ├── discord.js              Discord Gateway connection + event handling
│   ├── gatekeeper.js           Message filter: dedup, blacklist, whitelist
│   ├── pipeline.js             processLLM — brain of the bot
│   ├── llm.js                  Ollama Cloud client (retry, timeout, circuit)
│   ├── context.js              Sliding window + Redis-backed summarization
│   ├── memory.js               Per-user facts + mood
│   ├── search.js               Web search via Ollama Cloud
│   ├── naturalize.js           Reply normalization (laugh guard, spacing)
│   ├── chunks.js               Message split + delivery with retry
│   ├── circuit.js              Circuit breaker (threshold, cooldown, alert)
│   ├── badwords.js             Static badword detection list
│   ├── autochat.js             Proactive messaging scheduler
│   ├── dispatch.js             Per-user serial queue + typing indicator
│   ├── personality.js          Loader & editor for personality.txt
│   ├── auth.js                 JWT + bcrypt auth middleware
│   ├── api-skeleton.js         27 dashboard API endpoints
│   ├── redis.js                Redis client + scanAll helper
│   └── util.js                 Shared utilities
├── dashboard/                  SPA: 9 pages
│   ├── index.html              SPA shell
│   ├── app.js                  SPA engine
│   ├── login.html              Login page
│   ├── overview.html           Stats overview
│   ├── chat.html               Chat history
│   ├── analytics.html          Charts & trends
│   ├── settings.html           Settings
│   ├── logs.html               System logs
│   └── debug.html              Debug diagnostics
├── test/                       19 files, 256 tests
├── personality.txt             Bot persona (gitignored)
├── personality.txt.example     Template with persona structure
├── logo.svg                    Bot logo
└── dashboard/out/              Built dashboard (deploy target)
```

### Message Flow

```
┌──────────────────┐
│  Discord         │  Message arrives via discord.js Gateway
└──────┬───────────┘
       ▼
┌──────────────┐
│  dispatch.js │  Per-user serial queue + typing pulse
└──────┬───────┘
       ▼
┌──────────────┐
│ gatekeeper   │  shouldProcess():
│              │  • Bot message? → reject
│              │  • Duplicate? → reject (memory + Redis NX)
│              │  • Blacklisted? → reject
│              │  • Whitelist active? → check
│              │  • Server? → mention/reply/name check
│              │  • DM? → always process
└──────┬───────┘
       ▼ (passes)
┌──────────────────────────────────┐
│  pipeline.processLLM()           │
│                                  │
│  ┌─ Parallel ────────────────┐  │
│  │  context.getWindow()      │  │
│  │  (image analysis if any)  │  │
│  │  memory.getFriend()       │  │
│  └───────────────────────────┘  │
│            ▼                     │
│  Build system prompt + LLM call │
│            ▼                     │
│  [SEARCH LOOP] (≤2 iter, 30s)   │
│  Has [SEARCH]? → webSearch →    │
│  LLM again                     │
│            ▼                     │
│  Memory tokens → persist        │
│  (fire-and-forget)             │
│            ▼                     │
│  Naturalize → split → send      │
│  chunks → Discord               │
│            ▼                     │
│  Context summarization          │
│  (fire-and-forget)              │
└──────────────────────────────────┘
```

---

## API Endpoints

| Method | Path | Description | Auth |
|---|---|---|---|
| GET | /api/overview | Dashboard overview stats | ✅ |
| GET | /api/friends | Friend list with mood & counts | ✅ |
| GET | /api/settings | Current settings | ✅ |
| PUT | /api/settings | Update settings | ✅ |
| GET | /api/logs | System logs (last 100) | ✅ |
| POST | /api/logs/clear | Clear logs | ✅ |
| GET | /api/chat/contacts | All contacts + servers | ✅ |
| GET | /api/chat/context | Chat history for a user | ✅ |
| GET | /api/analytics/trend | Daily message trend | ✅ |
| GET | /api/analytics/top-friends | Top friends by activity | ✅ |
| GET | /api/analytics/hourly | 24h activity distribution | ✅ |
| GET | /api/analytics/today | Today's stats | ✅ |
| GET | /api/analytics/messages | 7-day message data | ✅ |
| GET | /api/friends/:id/memory | Friend memory data | ✅ |
| PUT | /api/friends/:id/memory | Update friend memory | ✅ |
| DELETE | /api/friends/:id/memory | Clear friend memory | ✅ |
| GET | /api/debug | Circuit breaker + uptime | ✅ |
| GET | /api/personality | Get personality content | ✅ |
| PUT | /api/personality | Update personality | ✅ |
| GET | /api/blacklist | Get blacklist | ✅ |
| PUT | /api/blacklist | Update blacklist | ✅ |
| GET | /api/circuit-breaker | Circuit breaker status | ✅ |
| PUT | /api/circuit-breaker | Toggle circuit breaker | ✅ |
| GET | /api/autochat/toggle | Auto-chat status | ✅ |
| PUT | /api/autochat/toggle | Toggle auto-chat | ✅ |
| POST | /api/auth/login | Login (returns JWT) | ❌ |

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `OLLAMA_API_KEY` | ✅ | — | Ollama Cloud API key |
| `DISCORD_CLIENT_ID` | ✅ | — | Bot Discord client ID |
| `OWNER_DISCORD_ID` | ✅ | — | Owner Discord ID (comma-separated) |
| `DASHBOARD_PASSWORD_HASH` | ✅ | — | bcrypt hash of password |
| `JWT_SECRET` | ✅ | — | JWT signing secret |
| `REDIS_URL` | ✅ | — | Upstash Redis (rediss://) |
| `OLLAMA_MODEL` | — | `gemma4:31b-cloud` | LLM model |
| `OLLAMA_TIMEOUT_MS` | — | `60000` | LLM request timeout |
| `SEARCH_LOOP_TIMEOUT_MS` | — | `30000` | Search loop timeout |
| `CIRCUIT_BREAKER_THRESHOLD` | — | `5` | Failures before cooldown |
| `CIRCUIT_BREAKER_COOLDOWN_MS` | — | `300000` | Cooldown duration (5 min) |
| `MAX_CONTEXT_MESSAGES` | — | `30` | Context window (private) |
| `MAX_GROUP_CONTEXT_MESSAGES` | — | `50` | Context window (server) |
| `PORT` | — | `10000` | HTTP server port |
| `LOG_LEVEL` | — | `warn` | Pino log level |

> Full list with all optional vars in `.env.example`.

---

## Deploy

### 1. Upstash Redis

Buat akun [upstash.com](https://upstash.com) → Create Redis → copas `REDIS_URL`.
Free tier 256MB cukup buat weeks of chat history.

### 2. Discord Bot Setup

| Step | Detail |
|---|---|
| Create Application | Buka https://discord.com/developers/applications → New Application |
| Add Bot | Bot tab → Add Bot → Copy token |
| Invite Bot | OAuth2 → URL Generator → `bot` + `applications.commands` scopes |
| Env Variables | Isi `DISCORD_CLIENT_ID`, `OWNER_DISCORD_ID`, dan `DISCORD_TOKEN` |

### 3. Render

| Step | Detail |
|---|---|
| Push ke GitHub | `git push origin main` |
| New Web Service | Pilih repo, branch `main` |
| Build Command | `npm install && npm run build` |
| Start Command | `npm start` |
| Env Variables | Isi semua required vars (including `DISCORD_TOKEN`) |
| Deploy | Tombol hijau → tunggu ~2 menit |

### 4. UptimeRobot (optional)

```
Monitor → HTTP(s) → https://app-kamu.onrender.com/health
Interval → 5 menit
```

Render free tier spin down setelah 15 menit idle. UptimeRobot jagain tetap hangat.

---

## Monitoring

| Tool | Detail |
|---|---|
| **Dashboard** | `http://host:PORT/` — 9 SPA pages |
| **Health Check** | `GET /health` — for UptimeRobot |
| **Circuit Breaker** | Auto-recovers after cooldown, owner alerted via Discord DM |
| **Logs** | Pino (warn level), Redis-backed (last 500 entries) |
| **LLM Timing** | Every call duration tracked, viewable in dashboard |

---

## Troubleshooting

| Problem | Solution |
|---|---|
| Bot not responding in servers | Make sure "ara" is mentioned or message is a reply to bot |
| "Circuit breaker open" error | Wait ~5 minutes — LLM had repeated failures, auto-recovers |
| Dashboard shows "no-redis" | Check `REDIS_URL` in .env — connection issue |
| Render cold start slow | Normal — free tier cold start ~30s after idle |
| Tests fail with Redis errors | `NODE_ENV=test` disables Redis — check env setup |

---

## Testing

```bash
npm test       # 256 tests, node:test native
npm run lint   # ESLint
```

Coverage: api-skeleton, auth, autochat, badwords, chunks, circuit, circuit-alert, context, dispatch, gatekeeper, llm, memory, memory-endpoints, naturalize, personality, pipeline, redis, search, scenario (19 test files).

---

## Commands

| Command | Description |
|---|---|
| `npm start` | Production bot + HTTP server |
| `npm run dev` | Watch mode (live reload) |
| `npm test` | 256 tests |
| `npm run build` | Build dashboard assets |
| `npm run lint` | ESLint |

---

## Conventions

- **ESM only** — `import`/`export`, no CommonJS
- **No emoji** in bot responses (per personality.txt)
- **Async/await** throughout
- **Pino** for logging (warn level in production)
- **personality.txt** = single source of truth for bot persona

---

## License

MIT License — use freely, fork, modify.

---

<p align="center">
  Built with ❤️ using Node.js, discord.js, and Ollama Cloud
</p>
