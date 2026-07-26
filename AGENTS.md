# Ara (waifu-bot)

Personal WhatsApp AI Chatbot — Baileys + Ollama Cloud + Upstash Redis.

## Tech Stack
- **Language**: JavaScript (ESM only)
- **Runtime**: Node.js >=20
- **WhatsApp**: Baileys (`@whiskeysockets/baileys`) — WebSocket-based
- **LLM**: Ollama Cloud (`ollama` npm)
- **Database/Cache**: Upstash Redis (`ioredis`) with in-memory fallback
- **Auth**: bcrypt + jsonwebtoken (custom JWT)
- **HTTP**: Node.js built-in `http` module (no Express)
- **Dashboard**: Vanilla JS SPA + Chart.js (CDN)
- **Logging**: Pino (warn level in production)
- **Image**: Sharp (sticker maker) + pdfjs-dist (PDF) + node-webpmux (WebP metadata)
- **Testing**: Node.js `node:test` + `node:assert` (no Jest/Vitest)
- **Linting**: ESLint 9 (flat config, `@eslint/js` recommended)
- **Formatting**: None (no Prettier)
- **Build**: Custom Node.js script (`scripts/build-dashboard.js`)
- **Deploy**: Render (documented in README)

## Commands

| Command | What it does | Quirk |
|---|---|---|
| `npm start` | Production — `node index.js` | Requires `.env` (not auto-loaded) |
| `npm run dev` | Watch mode — `node --watch --env-file .env index.js` | Node >=20 only; `.env` auto-loaded here |
| `npm test` | `set NODE_ENV=test&& node --test test/**/*.test.js` | **No space** after `=test` — Windows CMD syntax |
| `npm run build` | `node scripts/build-dashboard.js` | Copies `dashboard/` → `dashboard/out/`, minifies HTML |
| `npm run lint` | `eslint src/ index.js` | Uses flat config (`eslint.config.js`), ESLint 9 |

## Architecture

### Message Flow
```
WhatsApp Message (Baileys WebSocket)
  → src/baileys.js (messages.upsert handler → ctx)
  → src/gatekeeper.js (dedup, blacklist, whitelist)
  → src/dispatch.js (per-JID serial queue + typing)
  → src/pipeline.js (processLLM — brain of the bot)
      ├── src/context.js (sliding window + summarization)
      ├── src/media.js (vision + PDF extraction)
      ├── src/memory.js (per-user facts + mood)
      ├── src/llm.js (Ollama Cloud with retry + circuit)
      ├── src/search.js (web search loop, max 2 iterations)
      ├── src/naturalize.js (reply normalization)
      └── src/chunks.js (message split + delivery)
  → WhatsApp Reply
```

### Project Structure
- **Single package** (not monorepo). Name in `package.json` is `waifu-bot`, runtime name is `Ara`.
- **ESM only** — `import`/`export`, no CommonJS.
- **Entrypoint**: `index.js` — HTTP server (port 10000) + WhatsApp init.
- **Core**: `src/*.js` — 20 modules (pipeline, LLM client, context, memory, gatekeeper, circuit breaker, etc.).
- **Dashboard**: `dashboard/` — static SPA (vanilla JS + Chart.js), built into `dashboard/out/` (gitignored). Run `npm run build` before serving.
- **API**: 27 REST endpoints in `src/api-skeleton.js` — health, auth, friends, chat, analytics, settings, debug, persona, blacklist, circuit breaker, auto-chat.
- **Router**: Custom `Router` class in `index.js` (no Express) with GET/POST/PUT/DELETE + parametric routes.
- **Persona + Rules**: `persona.md` + `rules.md` (gitignored) — persona identity + behavioral rules. `{OWNER_NAME}` placeholder substituted at runtime.
- **Tests**: `test/*.test.js` — 20 files, ~256 tests.

## Conventions
- **No emoji** in bot responses (enforced by persona.md / rules.md).
- **Async/await** throughout. No `.then()`.
- **Pino** for logging (`warn` level in production).
- **Error-first middleware** pattern for HTTP routes: `(req, res, next)` — 3-param handlers are middleware, 2-param are final.
- **Circuit breaker**: auto-cooldown after `CIRCUIT_BREAKER_THRESHOLD` failures. Skipped when `setCircuitBreakerEnabled(false)`.
- **Memory tokens**: LLM can emit `[REMEMBER: fact]` and `[MOOD: mood]` — stripped from output, persisted to Redis fire-and-forget.
- **Search loop**: LLM emits `[SEARCH: query]` → web search → LLM re-invoked with results. Max 2 iterations.
- **Dashboard auth**: JWT in HttpOnly cookie OR Bearer Authorization header.
- **No TypeScript** — pure JavaScript throughout.
- **No external test framework** — Node.js native `node:test` + `node:assert`.
- **`NODE_ENV=test`** disables real Redis for offline testing.
- **Test seams** with `__` prefix (e.g., `__forceOpen`, `__reset`) — not part of public API.

## Test Setup
- **Framework**: Node.js `node:test` + `node:assert`. No Jest/Vitest.
- **Location**: `test/*.test.js` — 20 files, ~256 tests.
- **Run all**: `npm test` (Windows: `set NODE_ENV=test&& node --test test/**/*.test.js`)
- **Run single**: `node --test test/pipeline.test.js`
- **Run by name**: `node --test --test-name-pattern="processLLM"`
- **Env must be set before module import**: Several modules read env vars at import time (e.g. `OWNER_NUMBER` in pipeline tests). Tests set `process.env` before `await import(...)`.
- **Module-level import**: Tests use `await import(...)` at top level (ESM), not `require()`.
- **Import dedup**: Tests use query strings (`?sl=1`, `?cbt=1`) to force fresh module instances when re-importing the same file.
- **No external services required**: All tests mock Redis/LLM/WhatsApp. `NODE_ENV=test` disables real Redis.
- **Lockfile**: `package-lock.json` (npm). `allowScripts` in package.json is pnpm-format config (ignore unless using pnpm).

## Orchestrator Workflow
Project ini menggunakan orchestrator workflow. Sub-agents tersedia:

| Sub-Agent | Fungsi |
|---|---|
| `orchestrator-frontend` | UI components & design (dashboard SPA) |
| `orchestrator-database` | Schema, queries, migrations (Redis) |
| `orchestrator-testing` | Tests & debugging (`node:test`) |
| `orchestrator-document` | Reports (DOCX, XLSX, PPTX, PDF) |
| `orchestrator-architecture` | Codebase analysis & architecture decisions |
| `orchestrator-quality` | Final review & verification |

Cara pake: tinggal kasih task multi-domain, AI akan breakdown, dispatch sub-agents, dan integrasi hasil.

## Kanban Board
Project ini punya kanban board di `.orchestrator/kanban.json`.
Gunakan `/kanban` command: `/kanban list`, `/kanban view`, `/kanban move`.
Setiap task otomatis ter-track dari Backlog → In Progress → Review → Done.
