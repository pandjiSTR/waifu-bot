# Ara (waifu-bot)

Personal Discord AI Chatbot — discord.js + Ollama Cloud + Upstash Redis.

## Tech Stack
- **Runtime:** Node.js >=20 (ESM only, no TypeScript)
- **Framework:** discord.js ^14 for Discord Gateway, custom Router (no Express)
- **LLM:** Ollama Cloud (gemma4:31b-cloud default)
- **Database/Cache:** Upstash Redis via ioredis
- **Logging:** Pino + pino-pretty
- **Dashboard:** Vanilla JS SPA + Chart.js (static, built to `dashboard/out/`)
- **Auth:** bcrypt + jsonwebtoken (HttpOnly cookie + Bearer header)

## Commands

| Command | What it does | Quirk |
|---|---|---|
| `npm start` | Production — `node index.js` | Requires `.env` (not auto-loaded) |
| `npm run dev` | Watch mode — `node --watch --env-file .env index.js` | Node >=20 only; `.env` auto-loaded here |
| `npm test` | `set NODE_ENV=test&& node --test test/**/*.test.js` | **No space** after `=test` — Windows CMD syntax |
| `npm run build` | `node scripts/build-dashboard.js` | Copies `dashboard/` → `dashboard/out/`, minifies HTML |
| `npm run lint` | `eslint src/ index.js` | Uses flat config (`eslint.config.js`), ESLint 9 |

## Architecture

- **Single package** (not monorepo). Name in `package.json` is `waifu-bot`, runtime name is `Ara`.
- **ESM only** — `import`/`export`, no CommonJS.
- **Entrypoint**: `index.js` — HTTP server (custom Router) + Discord init.
- **Core pipeline** (`src/pipeline.js:processLLM`): message → gatekeeper → dispatcher → context + memory + LLM → search loop → memory tokens → naturalize → chunked response.
- **Circuit breaker** (`src/circuit.js`): tracks failures, opens after threshold, auto-cooldown, owner alert via DM.
- **Fire-and-forget**: memory persistence, context summarization, logging, stats — all non-blocking.
- **In-memory fallback**: every Redis function degrades to in-memory Maps when Redis unavailable.
- **Per-channel serial queue** (`src/dispatch.js`): sequential message processing + typing indicator.
- **Dashboard**: 9-page SPA (overview, chat, analytics, settings, logs, debug, etc.), JWT auth.
- **Custom HTTP Router** in `index.js`: pattern matching, middleware chaining (`next()` callback).
- **Fork origin**: converted from WhatsApp (Baileys) to Discord (discord.js) at commit `3cd3303`.

### File Structure
```
index.js             — Entrypoint (HTTP + Discord init)
src/
├── api-skeleton.js  — 27 API endpoints + route registration
├── auth.js          — JWT + bcrypt auth
├── autochat.js      — Proactive messaging scheduler
├── badwords.js      — Badword detection
├── chunks.js        — Message split + delivery with retry
├── circuit.js       — Circuit breaker pattern
├── context.js       — Sliding window + Redis summarization
├── discord.js       — Discord Gateway event handling
├── dispatch.js      — Per-user serial queue
├── gatekeeper.js    — Message filter (dedup, blacklist, etc.)
├── llm.js           — Ollama Cloud client (retry, timeout, circuit breaker)
├── memory.js        — Per-user facts + mood
├── naturalize.js    — Reply normalization
├── personality.js   — Personality loader + editor
├── pipeline.js      — processLLM orchestrator (brain of bot)
├── redis.js         — Redis client wrapper
├── search.js        — Web search via Ollama
└── util.js          — sleep(), getOwnerDiscordId()
test/                — 19 test files, ~256 tests
dashboard/           — 9-page SPA (vanilla JS, Chart.js)
scripts/
└── build-dashboard.js
```

## Conventions

- **No emoji** in bot responses (enforced by persona.md + rules.md).
- **Async/await** throughout. No `.then()`.
- **Pino** for logging (`warn` level in production).
- **Error-first middleware** pattern: `(req, res, next)` — 3-param handlers are middleware, 2-param are final.
- **Circuit breaker**: auto-cooldown after `CIRCUIT_BREAKER_THRESHOLD` failures. Skipped when `setCircuitBreakerEnabled(false)`.
- **Memory tokens**: LLM emits `[REMEMBER: fact]` and `[MOOD: mood]` — stripped from output, persisted to Redis fire-and-forget.
- **Search loop**: LLM emits `[SEARCH: query]` → web search → LLM re-invoked with results. Max 2 iterations.
- **Dashboard auth**: JWT in HttpOnly cookie OR Bearer Authorization header.
- **No Prettier**: only ESLint for formatting.

## Test Setup

- **Framework**: Node.js `node:test` + `node:assert`. No Jest/Vitest.
- **Location**: `test/*.test.js` — 19 files, ~256 tests.
- **Env must be set before module import**: Tests set `process.env` before `await import(...)`.
- **Module-level import**: Tests use `await import(...)` at top level (ESM).
- **No external services**: All tests mock Redis/LLM/Discord. `NODE_ENV=test` disables real Redis.
- **Import dedup**: Query strings (`?sl=1`, `?cbt=1`) force fresh module instances.
- **Test seams**: `circuit.js` exports `__forceOpen(ms)` and `__reset()` — test-only, not public API.
- **Run single test**: `node --test test/pipeline.test.js` or `npx node --test --test-name-pattern="processLLM"`.
- **Run all tests**: `npm test`.

## Orchestrator Workflow

Project ini menggunakan orchestrator workflow. Sub-agents tersedia:

| Sub-Agent | Fungsi |
|---|---|
| @orchestrator-frontend | UI components & design (dashboard, pages) |
| @orchestrator-database | Schema, queries, migrations (Redis data model) |
| @orchestrator-testing | Tests & debugging |
| @orchestrator-document | Reports (DOCX, XLSX, PPTX, PDF) |
| @orchestrator-architecture | Codebase analysis |
| @orchestrator-quality | Final review |

Cara pake: tinggal kasih task multi-domain, AI akan breakdown, dispatch sub-agents, dan integrasi hasil.

## Kanban Board

Project ini punya kanban board di `.orchestrator/kanban.json`.
Gunakan `/kanban` command: `/kanban list`, `/kanban view`, `/kanban move`.
Setiap task otomatis ter-track dari Backlog → In Progress → Review → Done.
