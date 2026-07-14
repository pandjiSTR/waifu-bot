# Ara (waifu-bot)

Personal WhatsApp AI Chatbot — Baileys + Ollama Cloud + Upstash Redis.

## Commands

| Command | What it does | Quirk |
|---|---|---|
| `npm start` | Production — `node index.js` | Requires `.env` (not auto-loaded) |
| `npm run dev` | Watch mode — `node --watch --env-file .env index.js` | Node >=20 only; `.env` auto-loaded here |
| `npm test` | `set NODE_ENV=test&& node --test test/**/*.test.js` | **No space** after `=test` — Windows CMD syntax |
| `npm run build` | `node scripts/build-dashboard.js` | Copies `dashboard/` → `dashboard/out/`, minifies HTML |
| `npm run lint` | `eslint src/ index.js` | Uses flat config (`eslint.config.js`), ESLint 9 |

## Project structure

- **Single package** (not monorepo). Name in `package.json` is `waifu-bot`, runtime name is `Ara`.
- **ESM only** — `import`/`export`, no CommonJS.
- **Entrypoint**: `index.js` — creates HTTP server + inits WhatsApp.
- **Core**: `src/*.js` — pipeline, LLM client, context, memory, gatekeeper, circuit breaker, etc.
- **Dashboard**: `dashboard/` — static SPA (vanilla JS + Chart.js), built into `dashboard/out/` (gitignored). Run `npm run build` before serving.
- **Personality**: `personality.txt` (gitignored) — single source of truth for bot persona. Template at `personality.txt.example`. `{OWNER_NAME}` placeholder substituted at runtime.
- **Tests**: `test/*.test.js` — 20 files, ~256 tests. Node native `node:test`, no test framework.

## Test quirks

- **Framework**: Node.js `node:test` + `node:assert`. No Jest/Vitest.
- **Env must be set before module import**: Several modules read env vars at import time (e.g. `OWNER_NUMBER` in pipeline tests). Tests set `process.env` before `await import(...)`.
- **Module-level import**: Tests use `await import(...)` at top level (ESM), not `require()`.
- **`circuit.js` test seams**: `__forceOpen(ms)` and `__reset()` — not part of public API, used by tests to control breaker state.
- **Import dedup**: Tests use query strings (`?sl=1`, `?cbt=1`) to force fresh module instances when re-importing the same file.
- **No external services required**: All tests mock Redis/LLM/WhatsApp. `NODE_ENV=test` disables real Redis.
- **Run single test**: `node --test test/pipeline.test.js` (or `npx node --test --test-name-pattern="processLLM"`).
- **Lockfile**: `package-lock.json` (npm). `allowScripts` in package.json is pnpm-format config (ignore unless using pnpm).

## Conventions

- **No emoji** in bot responses (enforced by personality.txt).
- **Async/await** throughout. No `.then()`.
- **Pino** for logging (`warn` level in production).
- **Error-first middleware** pattern for HTTP routes: `(req, res, next)` — 3-param handlers are middleware, 2-param are final.
- **Circuit breaker**: auto-cooldown after `CIRCUIT_BREAKER_THRESHOLD` failures. Skipped when `setCircuitBreakerEnabled(false)`.
- **Memory tokens**: LLM can emit `[REMEMBER: fact]` and `[MOOD: mood]` — stripped from output, persisted to Redis fire-and-forget.
- **Search loop**: LLM emits `[SEARCH: query]` → web search → LLM re-invoked with results. Max 2 iterations.
- **Dashboard auth**: JWT in HttpOnly cookie OR Bearer Authorization header.
