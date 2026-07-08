# Ara — Personal WhatsApp AI Chatbot

## Tech Stack
- **Runtime:** Node.js >=20 (ESM)
- **WhatsApp:** @whiskeysockets/baileys
- **LLM:** Ollama Cloud — single model (`gemma4`)
- **Database:** Upstash Redis (ioredis)
- **Hosting:** Render.com (free tier, Singapore)
- **Monitoring:** UptimeRobot (5-min ping)
- **Dashboard:** Static HTML SPA + vanilla JS + Chart.js
- **Auth:** jsonwebtoken + bcrypt
- **Logging:** Pino
- **Image:** Sharp

## Commands
- `npm start` — Start production bot + HTTP server
- `npm run dev` — Start with file watching (--watch)
- `npm test` — Run test suite (node:test)
- `npm run build` — Build dashboard static files
- `npm run lint` — Lint source code

## Architecture
```
index.js                    — Entry point: init HTTP server + WhatsApp
├── src/
│   ├── api-skeleton.js     — API route handlers
│   ├── personality.js      — Loader & editor untuk personality.txt
│   ├── auth.js             — JWT + bcrypt auth middleware & endpoints
│   ├── redis.js            — Redis client init & helpers
│   ├── baileys.js          — WhatsApp connection & event handlers
│   ├── baileys-auth.js     — Redis-backed Baileys auth state
│   ├── pipeline.js         — Message pipeline: shouldProcess + processLLM
│   ├── llm.js              — LLM request handler (Ollama Cloud)
│   ├── chunks.js           — Chunk send with retry & delivery reliability
│   ├── circuit.js          — Circuit breaker (cooldown flag)
│   ├── context.js          — Context window management + summarization
│   ├── naturalize.js       — Reply normalization
│   ├── badwords.js         — Badword detection (static list)
│   ├── media.js            — Media processing (vision, PDF)
│   ├── sticker.js          — Sticker maker (Sharp)
│   ├── search.js           — Search system (Ollama Cloud web_search)
│   └── autochat.js         — Proactive messaging scheduler
├── dashboard/              — Static SPA files (9 pages)
│   ├── index.html          — SPA shell
│   ├── app.js              — SPA engine
│   ├── login.html          — Login page
│   ├── overview.html       — Overview page
│   ├── settings.html       — Settings page
│   ├── chat.html           — Chat page
│   ├── analytics.html      — Analytics page
│   ├── logs.html           — System logs page
│   ├── debug.html          — Debug page
│   ├── ara-logo.svg        — Manga-style SVG logo
│   └── out/                — Built output dir
├── test/                   — Test files (node:test, 15 files, 147 tests)
├── personality.txt         — Single source of truth untuk persona Ara
├── render.yaml             — Render.com deploy config
└── .env                    — Environment variables (gitignored)
```

## Design Principles
1. `personality.txt` adalah **single source of truth** untuk semua aspek persona — kode tidak pernah mengandung string persona hardcoded
2. **Kesederhanaan struktural** — setiap mekanisme dibangun seminimal mungkin, tanpa fitur enterprise yang belum dibutuhkan

## Conventions
- **ESM only** (`import`/`export`, no CommonJS)
- **No emoji** in Ara responses (per personality.txt)
- **Async/await** throughout
- **Pino** for logging (warn level in production)
- Error-first middleware pattern for HTTP routes

## Test Setup
- **Framework:** Node.js native `node:test` (zero dependencies)
- **Location:** `test/*.test.js`
- **Run:** `npm test`
- **Coverage:** auth, autochat, badwords, chunks, circuit, circuit-alert, context, llm, media, naturalize, personality, pipeline, redis, search, sticker

## Orchestrator Workflow
Project ini menggunakan orchestrator workflow. Sub-agents tersedia:

| Sub-Agent | Fungsi |
|---|---|
| @orchestrator-frontend | UI components, dashboard design, frontend logic |
| @orchestrator-database | Schema design, key patterns, data model |
| @orchestrator-testing | Test writing & debugging |
| @orchestrator-document | Reports (DOCX, XLSX, PPTX, PDF) |
| @orchestrator-architecture | Codebase analysis & design review |
| @orchestrator-quality | Final review & verification |

## Kanban Board
Kanban board di `.orchestrator/kanban.json`.
Gunakan `/kanban` command: `/kanban list`, `/kanban view`, `/kanban move`.
Setiap task otomatis ter-track dari Backlog → In Progress → Review → Done.
