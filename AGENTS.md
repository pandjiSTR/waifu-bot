# Waifu Bot

Personal WhatsApp AI Chatbot with Ollama Cloud, dashboard monitoring, and Redis persistence.

## Tech Stack
- **Runtime:** Node.js >=20 (ESM)
- **WhatsApp:** @whiskeysockets/baileys
- **LLM:** Ollama Cloud
- **Database:** Upstash Redis (ioredis)
- **Dashboard:** Static SPA + vanilla JS + Chart.js
- **Auth:** jsonwebtoken + bcrypt
- **Logging:** Pino
- **Image:** Sharp
- **PDF:** pdfjs-dist

## Commands
- `npm start` — Start production bot + HTTP server
- `npm run dev` — Start with file watching (--watch)
- `npm test` — Run test suite (256 tests)
- `npm run build` — Build dashboard static files
- `npm run lint` — Lint source code

## Design Principles
1. `personality.txt` adalah **single source of truth** untuk semua aspek persona — kode tidak pernah mengandung string persona hardcoded
2. Kesederhanaan struktural — setiap mekanisme dibangun seminimal mungkin

## Conventions
- **ESM only** (`import`/`export`, no CommonJS)
- **No emoji** in bot responses (per personality.txt)
- **Async/await** throughout
- **Pino** for logging (warn level in production)
- Error-first middleware pattern for HTTP routes

## Test Setup
- **Framework:** Node.js native `node:test`
- **Location:** `test/*.test.js`
- **Run:** `npm test`
- **Coverage:** auth, autochat, badwords, chunks, circuit, circuit-alert, context, dispatch, gatekeeper, llm, media, memory, naturalize, personality, pipeline, redis, search, sticker (256 tests)
