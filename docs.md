# Ara - Personal WhatsApp AI Chatbot

> **Version:** 1.0.0 | **License:** MIT | **Runtime:** Node.js >=20 (ESM)

---

## Table of Contents

- [Project Description](#project-description)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [How It Works (Data Flow)](#how-it-works-data-flow)
- [Features](#features)
- [Configuration (Environment Variables)](#configuration-environment-variables)
- [API Endpoints](#api-endpoints)
- [Redis Key Patterns](#redis-key-patterns)
- [Dashboard SPA](#dashboard-spa)
- [Setup & Installation](#setup--installation)
- [Commands](#commands)
- [Testing](#testing)
- [Deployment (Render)](#deployment-render)

---

## Project Description

**Ara** is a personal WhatsApp AI chatbot that simulates a realistic Indonesian girlfriend character - a 20-year-old female Computer Science student named Ara who is introverted, caring, and protective. The bot uses **Ollama Cloud** with a single LLM model (gemma4:31b-cloud) to generate natural, short-form WhatsApp-style conversations in Indonesian.

**User personas:** Owner (intimate "girlfriend" relationship, full admin access), Registered friends (helpful but reserved), and Unregistered users (minimal/ignored if whitelist active).

Key design principles:

1. **personality.txt as single source of truth** - all persona, speaking style, interaction rules, and topic boundaries are defined exclusively in personality.txt. Code never contains hardcoded persona strings.
2. **Structural simplicity** - every mechanism is built as minimally as possible while still meeting needs. No enterprise features unless explicitly required.

## Tech Stack

| Layer | Technology |
|---|---|
| **Runtime** | Node.js >=20 (ESM) |
| **WhatsApp** | @whiskeysockets/baileys v6.7 |
| **LLM Provider** | Ollama Cloud - single model gemma4:31b-cloud |
| **Database** | Upstash Redis (via ioredis) |
| **Auth** | jsonwebtoken + bcrypt |
| **Logging** | pino |
| **Image Processing** | sharp (512x512 WebP stickers) |
| **PDF Extraction** | pdfjs-dist |
| **Testing** | Node.js native node:test (zero dependencies) |
| **Linting** | eslint v9 |
| **Hosting** | Render.com (free tier, Singapore region) |
| **Monitoring** | UptimeRobot (5-minute ping to /api/health) |
| **Dashboard** | Static HTML SPA + vanilla JS + Chart.js |
## Architecture

### Folder Structure

```
D:\Projects\Waifu-bot-Revamped\
├── index.js                          # Entry point: HTTP server + WhatsApp init
├── package.json                      # Project metadata, scripts, dependencies
├── .env                              # Environment variables (gitignored)
├── .env.example                      # Sample env vars with documentation
├── .gitignore                        # Git ignore rules
├── AGENTS.md                         # AI agent instructions for the codebase
├── personality.txt                   # Single source of truth for Ara persona
├── render.yaml                       # Render.com blueprint deploy config
├── eslint.config.js                  # ESLint flat config (ECMA 2024, ESM)
│
├── src/                              # Application source code
│   ├── redis.js                      # Redis client factory + helpers
│   ├── personality.js                # Personality loader -> Redis -> buildSystemPrompt
│   ├── auth.js                       # JWT + bcrypt auth: login, logout, requireAuth
│   ├── baileys.js                    # WhatsApp socket init, event handlers
│   ├── baileys-auth.js               # Redis-backed Baileys AuthenticationState
│   ├── pipeline.js                   # Message pipeline: shouldProcess + processLLM
│   ├── llm.js                        # Ollama Cloud chat + circuit breaker integration
│   ├── context.js                    # Sliding-window context + summarization
│   ├── circuit.js                    # Circuit breaker (cooldown flag)
│   ├── chunks.js                     # Text chunking + reliable delivery
│   ├── naturalize.js                 # Reply normalization (persona-agnostic)
│   ├── badwords.js                   # Badword detection (static list)
│   ├── media.js                      # Vision description + PDF extraction
│   ├── memory.js                     # Friend memory storage (facts + mood per user)
│   ├── sticker.js                    # Sticker maker (Sharp 512x512 WebP)
│   ├── search.js                     # Web search (Ollama Cloud web_search)
│   ├── autochat.js                   # Proactive messaging scheduler
│   └── api-skeleton.js               # API route handlers
│
├── dashboard/                        # Static SPA dashboard (source)
│   ├── index.html                    # Main SPA shell
│   ├── app.js                        # SPA engine: router, API, Chart.js
│   ├── login.html                    # Login page fragment
│   ├── overview.html                 # Overview page fragment
│   ├── settings.html                 # Settings page fragment
│   ├── chat.html                     # Chat page fragment
│   ├── logs.html                     # System logs page fragment
│   ├── analytics.html                # Analytics page fragment
│   ├── debug.html                    # Debug page fragment
│   ├── ara-logo.svg                  # Manga-style SVG logo
│   └── out/                          # Built output dir
│
├── test/                             # Test files (node:test, 20 files, 219 tests)
│   ├── auth.test.js
│   ├── autochat.test.js
│   ├── badwords.test.js
│   ├── chunks.test.js
│   ├── circuit.test.js
│   ├── circuit-alert.test.js
│   ├── context.test.js
│   ├── llm.test.js
│   ├── media.test.js
│   ├── memory.test.js
│   ├── memory-endpoints.test.js
│   ├── naturalize.test.js
│   ├── personality.test.js
│   ├── pipeline.test.js
│   ├── redis.test.js
│   ├── search.test.js
│   ├── sticker.test.js
│   └── api-skeleton.test.js
│
└── scripts/
    └── build-dashboard.js            # Static dashboard builder
```

### Module Dependency Graph

```
index.js
  ├── src/redis.js           -- Redis client (used by all modules)
  ├── src/auth.js            -- Auth middleware, login/logout handlers
  ├── src/personality.js     -- Loads personality.txt -> Redis -> system prompt
  ├── src/baileys.js
  │     ├── src/baileys-auth.js   -- Redis-backed auth state
  │     └── src/pipeline.js       -- shouldProcess + processLLM
  │             ├── src/personality.js
  │             ├── src/llm.js
  │             │     └── src/circuit.js
  │             ├── src/context.js
  │             │     └── src/llm.js (summarize)
  │             ├── src/chunks.js
  │             ├── src/naturalize.js
  │             ├── src/badwords.js
  │             ├── src/media.js
  │             │     └── src/llm.js (chatWithImage)
  │             ├── src/memory.js     -- getFriendMemory, addFact, setMood
  │             ├── src/sticker.js
  │             │     └── src/media.js (getMediaBuffer)
  │             └── src/search.js
  ├── src/autochat.js
  │     ├── src/personality.js
  │     ├── src/llm.js
  │     ├── src/chunks.js
  │     └── src/context.js
  └── src/api-skeleton.js
        ├── src/personality.js
        ├── src/baileys.js
        ├── src/autochat.js
        └── src/memory.js     -- getFriendMemory, setMood, addFact, clearMemory
```

**Key design rule:** circuit.js imports NOTHING from llm/context/pipeline/personality to avoid circular dependencies.
## How It Works (Data Flow)

### Incoming Message to Response Flow

```
1. Baileys messages.upsert event fires
   |-- Only processes type === notify (live messages)
   |-- Skips fromMe (own messages)
   |-- Extracts text via extractText() (conversation, extendedText, caption)

2. shouldProcess() gating chain
   |-- Dedup (in-memory Map, 60-second TTL for messageId)
   |-- Blacklist check (comma-separated numbers from env)
   |-- Whitelist check (if WHITELIST set, only owner + whitelisted may interact)
   |-- Group rules (respond only on mention / reply-to-bot / command prefix)
   |-- Owner commands (ara fresh, ara status -- blocked from LLM)
   |-- Sticker messages ignored (no media handling)
   |-- Badword detection -> marks ctx.badword=true (does NOT block)

3. processLLM() orchestration
   |-- Sticker interception: if image + caption stiker/sticker or reply-to-bot
   |     |-- makeSticker() -> Sharp 512x512 WebP -> send sticker, skip LLM
   |-- Persist user message to context window (addMessage)
   |-- Load context window (getWindow -> chronological + summary)
   |-- Build system prompt via buildSystemPrompt()
   |     |-- Personality content + recent context + badword tone instruction
   |-- Build messages array [system, user turns..., assistant turns...]
   |-- Media context extraction (if applicable)
   |     |-- Image -> describeImage(): download -> base64 -> Ollama multimodal
   |     |-- PDF -> extractPdfText(): pdfjs-dist text extraction
   |     |-- Prepended to last user message
   |-- Circuit breaker check (isOpen?)
   |     |-- If open: send fallback + maybeAlertOwner (deduped 15min) -> stop
   |-- LLM call (chatFn)
    |     |-- Retry up to 2x with exponential backoff (1s -> 2s)
    |     |-- On success: recordSuccess() resets breaker
    |     |-- On failure after retries: recordFailure() may trip breaker

4. Search loop (max 2 iterations)
   |-- Extract [SEARCH: query] from reply via extractSearchQuery()
   |-- Call webSearch() via Ollama Cloud /api/web_search
   |-- Inject results as new user message
   |-- Re-query LLM with augmented context
   |-- Strip all [SEARCH: ...] tokens via stripSearchTokens()

5. Memory token extraction
   |-- Extract [REMEMBER: ...] and [MOOD: ...] tokens via extractMemoryTokens()
   |-- Persist facts via addFact() and mood via setMood() fire-and-forget
   |-- Strip all [REMEMBER: ...] and [MOOD: ...] tokens via stripMemoryTokens()

6. Normalize reply via naturalizeReply()
   |-- Strip wrapping markdown code fence
   |-- Collapse 3+ newlines to 2
   |-- Collapse 2+ spaces to 1
   |-- Remove trailing ellipsis-only line

7. Reliable chunked delivery via sendChunks()
   |-- Split text at 1800 chars (newline > space > hard)
   |-- Sequential send with 250ms delay between chunks
   |-- Per-chunk retry up to 3x with exponential backoff (500ms -> 1s -> 2s)
   |-- Stop on first permanently-failed chunk (no silent tail-loss)

8. Persist Ara reply to context AFTER delivery
   |-- Mark incomplete: true if delivery partially failed

9. Fire-and-forget summarization
   |-- Only if ENABLE_CONTEXT_SUMMARY=true
   |-- If window >= max, summarize oldest half -> merge -> trim
   |-- Skipped while circuit breaker is open
```

### Circuit Breaker Flow

```
Normal state
  |-- LLM call succeeds -> recordSuccess() -> failCount=0
  |-- LLM call fails after retries -> recordFailure() -> failCount++
  |-- failCount >= THRESHOLD (default 5) -> cooldownUntil = now + COOLDOWN_MS

Cooldown state (breaker open)
  |-- isOpen() returns true while Date.now() < cooldownUntil
  |-- LLM calls throw instantly (no network)
  |-- Pipeline sends neutral fallback
  |-- maybeAlertOwner() sends WhatsApp alert to owner (deduped 15 min)
  |-- Summarization skipped (history accumulates)

Recovery
  |-- Cooldown expires -> next LLM call succeeds -> recordSuccess() resets
```

## Features

### Personality Loader (src/personality.js)
- Loads personality.txt on startup, cached in Redis key waifu:personality
- Falls back to local file if Redis is unavailable
- Auto-seeds Redis from file on first load
- buildSystemPrompt() assembles system prompt from personality + memory facts + mood + context

### Auth Dashboard (src/auth.js)
- Single-owner login with bcrypt password verification
- JWT-based sessions via httpOnly cookies (7-day expiry)
- requireAuth middleware supporting Bearer header and cookie auth
- Configuration validated at startup

### Message Pipeline (src/pipeline.js)
- Full gating chain: dedup, blacklist, whitelist, group rules, badword
- Sticker-maker interception before LLM
- Media context extraction (vision + PDF)
- Friend memory loading (facts + mood injected into system prompt)
- Memory token extraction ([REMEMBER: ...] / [MOOD: ...]) fire-and-forget
- Search loop with LLM-driven [SEARCH: query] protocol
- Circuit breaker integration with owner alert
- Chunked delivery with per-chunk retry

### Sliding-Window Context (src/context.js)
- Redis-backed (in-memory fallback when Redis unavailable)
- Private: 30 messages max, 24h TTL
- Group: 50 messages max, 7d TTL (refreshed on each message)
- Fire-and-forget LLM summarization (opt-in via ENABLE_CONTEXT_SUMMARY)
- Summary merged as __summary__ entry at window top

### LLM Integration (src/llm.js)
- Ollama Cloud client, single model (gemma4:31b-cloud, configurable)
- Retry: 1s -> 2s, max 2 attempts
- Timeout: 60s default
- Multimodal: chatWithImage() attaches base64 images
- summarize() wrapper for context summarization
- Circuit breaker: short-circuits when breaker is open

### Chunked Delivery (src/chunks.js)
- Splits long replies at 1800 chars
- Break priority: newline > space > hard-truncate
- Sequential send with 250ms delay
- Per-chunk retry 500ms -> 1s -> 2s, 3 attempts
- Stops on first permanently-failed chunk

### Reply Normalization (src/naturalize.js)
- Strips single wrapping markdown code fence
- Collapses 3+ newlines to 2
- Collapses 2+ spaces to single space
- Removes trailing ellipsis-only line
- Persona-agnostic: no filler or voice modification

### Circuit Breaker (src/circuit.js)
- In-process cooldown flag, no Redis key, no per-user counters
- Threshold: 5 consecutive failures
- Cooldown: 5 minutes
- state() snapshot for dashboard
- Test seams: __forceOpen(), __reset()

### Badword Detection (src/badwords.js)
- Static list of ID + EN badwords (data only, no persona strings)
- Word-boundary regex for single tokens
- Substring matching for multi-word phrases
- Sets ctx.badword=true -> pipeline appends sarcastic tone instruction
- Does NOT block messages, only shifts tone

### Media Processing (src/media.js)
- Vision: download -> base64 -> Ollama multimodal for description
- PDF: text extraction via pdfjs-dist, truncated to 8000 chars
- Both have neutral fallbacks on failure

### Sticker Maker (src/sticker.js)
- Static images to 512x512 WebP stickers via Sharp
- Triggered on caption stiker/sticker or reply to bot
- Static images to 512x512 WebP stickers via Sharp, animated via FFmpeg (falls back to Sharp if FFmpeg unavailable)

### Web Search (src/search.js)
- Ollama Cloud web_search API
- Ollama Cloud web_fetch API for full page content
- LLM-driven: [SEARCH: query] tokens in reply trigger search
- Up to 2 iterations per turn

### Auto-Chat Scheduler (src/autochat.js)
- Proactive messaging to owner
- Time window: 08:00-22:00 WIB
- Min gap: 3 hours
- 40% probability per tick
- Toggle via dashboard (waifu:autochat:enabled)
- Circuit-breaker-aware
- Default: disabled (OFF). Seeds from AUTO_CHAT_ENABLED env on first start

### Owner Alert (pipeline.js - maybeAlertOwner())
- WhatsApp alert when circuit breaker trips
- Deduped via waifu:last_alert (15-min window)
- Neutral system notice, not Ara voice

### Friend Memory (src/memory.js)
- Per-user facts array + mood + timestamp stored at `waifu:friend:{userId}`
- LLM-driven protocol: `[REMEMBER: ...]` and `[MOOD: ...]` tokens extracted from replies
- Fire-and-forget persistence (never blocks delivery)
- Cap 50 facts per user (FIFO — oldest removed first)
- Dashboard: per-fact delete, full reset via /api/friends/:userId/memory endpoints

### Settings API
- GET/PUT /api/settings - auto-chat, blacklist
- GET/PUT /api/personality - read/edit personality.txt
- Persisted to waifu:settings:misc JSON blob

### Health Endpoint
- GET /api/health - WA connection, uptime
- Used by UptimeRobot

## API Endpoints

| Endpoint | Method | Auth | Description | Data |
|---|---|---|---|---|
| /api/health | GET | No | Bot health | Real |
| /api/auth/login | POST | No | Login | Real |
| /api/auth/logout | POST | No | Logout | Real |
| /api/overview | GET | Yes | Today stats | Real |
| /api/overview/today | GET | Yes | Detailed today | Real |
| /api/friends | GET | Yes | Friends list | Real |
| /api/friends/:userId/memory | GET | Yes | Get friend memory | Real |
| /api/friends/:userId/memory | PUT | Yes | Update friend memory | Real |
| /api/friends/:userId/memory | DELETE | Yes | Clear friend memory | Real |
| /api/personality | GET | Yes | Get personality | Real |
| /api/personality | PUT | Yes | Save personality | Real |
| /api/settings | GET | Yes | Get settings | Real |
| /api/settings | PUT | Yes | Update settings | Real |
| /api/config | GET | Yes | Alias settings | Real |
| /api/config | PUT | Yes | Alias settings | Real |
| /api/logs | GET | Yes | Log entries | Real |
| /api/logs/clear | POST | Yes | Clear logs | Real |
| /api/chat/contacts | GET | Yes | Contacts | Real |
| /api/chat/context | GET | Yes | Chat context | Real |
| /api/debug | GET | Yes | Diagnostics | Real |
| /api/debug/reset-cb | POST | Yes | Reset circuit breaker | Real |
| /api/analytics/trend | GET | Yes | Trend data | Real |
| /api/analytics/top-friends | GET | Yes | Top friends | Real |
| /api/analytics/hourly | GET | Yes | Hourly activity | Real |
| /api/messages | GET | Yes | 7-day data | Real |

All endpoints use real Redis data.

## Security

| Measure | Implementation |
|---|---|
| **Dashboard auth** | JWT + bcrypt, required for all `/api/*` routes except `/api/health` and `/api/auth/login` |
| **Session** | HTTP-only JWT cookie (7-day expiry) + `Authorization: Bearer` header fallback |
| **Whitelist** | Optional phone number filtering via `WHITELIST` env var |
| **Owner-only** | Fresh/reset commands, dashboard access, personality edits restricted to `OWNER_NUMBER` |
| **Secrets** | `.env` gitignored; `render.yaml` uses `sync: false` for sensitive vars |
| **Input** | Messages processed through `processLLM`; no raw eval |
| **Logging** | Pino at `warn` level (production) — no secrets logged |

## Redis Key Patterns

| Key | Type | TTL | Description |
|---|---|---|---|
| waifu:personality | String | None | Active personality content |
| waifu:auth:creds | String | Permanent | Baileys credentials |
| waifu:auth:keys | Hash | Permanent | Baileys Signal keys |
| waifu:ctx:{userId} | List | 24h | Private chat messages |
| waifu:ctx_summary:{userId} | String | 24h | Private chat summary |
| waifu:grup:{groupId} | List | 7d | Group chat messages |
| waifu:grup_summary:{groupId} | String | 7d | Group chat summary |
| waifu:qr | String | 5 min | WhatsApp QR code |
| waifu:last_alert | String | 15 min | Owner alert dedup |
| waifu:autochat:enabled | String | None | Auto-chat toggle |
| waifu:autochat:last | String | None | Last auto-chat time |
| waifu:settings:misc | String | None | Settings JSON blob |
| waifu:friend:{userId} | String | None | Friend memory (facts + mood JSON) |
| waifu:stats:messages | Hash | None | Total message counter |
| waifu:stats:friends | Hash | None | Per-friend message counters (HINCRBY) |
| waifu:stats:hourly:* | Sorted Set | 48h | Hourly message activity |
| waifu:stats:llm_times | List | None | Last 100 LLM call durations |
| waifu:logs | List | None | Recent log entries (capped at 500) |
| waifu:sum_lock:* | String | 30s | Distributed lock for summarization |
| waifu:login_fail:* | String | 15m | Failed login counter per IP |

## Dashboard SPA

Static SPA with hash-based routing, vanilla JS + Chart.js.
Neo-brutalist / manga aesthetic: B&W, high contrast, thick borders.

### Pages

| Route | File | Description |
|---|---|---|
| #login | login.html | Password login |
| #ringkasan | overview.html | Overview: stats, friends, chart |
| #percakapan | chat.html | Contact list + context viewer |
| #statistik | analytics.html | Trend, top friends, hourly |
| #log-sistem | logs.html | System logs |
| #pengaturan | settings.html | Personality, auto-chat, blacklist |
| #debug | debug.html | CB, Redis, Ollama status |

### Features
- JWT in httpOnly cookie (set via Set-Cookie on login, sent automatically on same-origin fetch)
- Memory panel in chat page: shows facts + mood per contact with per-fact delete and full reset
- Auto-refresh: 30s overview, 10s logs, 15s debug
- Chart.js for charts
- Responsive with hamburger sidebar
- Source in dashboard/, build output in dashboard/out/

## Testing

- Node.js native node:test
- 219 test cases across 18 test files

| File | Tests | Coverage |
|------|-------|----------|
| auth.test.js | 15 | Login, logout, auth middleware, rate limiting |
| autochat.test.js | 10 | Scheduler, toggle, proactive, circuit integration |
| badwords.test.js | 6 | Detection, case-insensitivity |
| chunks.test.js | 12 | Text splitting, send/reliability, retry env |
| circuit.test.js | 10 | Open/close, thresholds, callbacks |
| circuit-alert.test.js | 4 | Owner alert, Redis dedup |
| context.test.js | 12 | Window management, in-memory fallback, summary lock |
| llm.test.js | 12 | Chat, retry, multimodal, circuit integration |
| media.test.js | 8 | Vision, PDF extraction, fallbacks |
| memory.test.js | 13 | CRUD operations, cap 50, Redis null safety |
| memory-endpoints.test.js | 12 | GET/PUT/DELETE handlers, auth, validation |
| naturalize.test.js | 5 | Code fence, whitespace, trailing ellipsis |
| personality.test.js | 13 | Load, cache, buildSystemPrompt with facts+mood |
| pipeline.test.js | 34 | shouldProcess, processLLM, search loop, blacklist, memory tokens |
| redis.test.js | 5 | Client init, helpers |
| search.test.js | 10 | webSearch, webFetch, search query helpers |
| sticker.test.js | 5 | Static, animated, FFmpeg fallback |
| **Total** | **219** |

## Deployment (Render)

render.yaml blueprint for one-click deploy.
Single web service, Singapore region, free tier.
WhatsApp session persists via Redis (waifu:auth:*) across deploys.
UptimeRobot pings /api/health every 5 min.