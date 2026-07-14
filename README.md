<p align="center">
  <img src="logo.svg" alt="Waifu Bot" width="140" height="140">
</p>

<h1 align="center">Waifu Bot</h1>

<p align="center">
  <a href="#"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen?logo=node.js" alt="Node"></a>
  <a href="#"><img src="https://img.shields.io/badge/tests-256%20passing-green" alt="Tests"></a>
  <a href="#"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License"></a>
  <a href="#"><img src="https://img.shields.io/badge/ollama-cloud-white?logo=ollama" alt="Ollama"></a>
</p>

<p align="center">
  <b>Personal WhatsApp AI Chatbot</b> built with Ollama Cloud, Baileys, and Redis.
  <br>
  Orang sungguhan di WhatsApp — bukan asisten kaku.
</p>

---

## Highlights

| | | |
|---|---|---|
| 🧠 **LLM-Powered** | Ollama Cloud — smart, fast, konteks 30-50 pesan |
| 📸 **Vision + PDF** | Baca gambar (describe) & dokumen PDF langsung |
| 🔍 **Web Search** | Cari info real-time kalo ditanya |
| 🖼️ **Sticker Maker** | Gambar &rarr; WebP sticker otomatis |
| 💭 **Friend Memory** | Inget fakta & mood tiap orang |
| 🛡️ **Circuit Breaker** | Auto-cooldown kalo LLM error |
| 📊 **Dashboard** | 9 halaman: chat, analytics, logs, debug |
| ⚡ **Parallel Processing** | Context + media + memory loading bersamaan |

---

## Quick Start

```bash
git clone <repo-url> waifu-bot
cd waifu-bot
cp .env.example .env
# edit .env — isi API key, Redis, dll
npm install
npm run build
npm start
```

> Butuh **Node.js &gt;=20** dan akun [Ollama Cloud](https://ollama.com) + [Upstash Redis](https://upstash.com).

---

## Architecture

```
index.js                       Entry point
+-- src/                       20 modules
|   +-- baileys.js             WhatsApp connection
|   +-- gatekeeper.js          Filter: who gets a reply?
|   +-- pipeline.js            Brain: orchestrate LLM + search + memory
|   +-- llm.js                 Ollama Cloud client
|   +-- context.js             Sliding window + summarization
|   +-- memory.js              Facts & mood per user
|   +-- media.js               Vision & PDF
|   +-- search.js              Web search integration
|   +-- chunks.js              Reliable message delivery
|   +-- ...                    11 more focused modules
+-- dashboard/                 SPA: 9 pages
+-- test/                      256 tests (node:test)
+-- personality.txt            Bot identity (gitignored)
+-- logo.svg
```

### Message Flow

```
WhatsApp &rarr; Baileys &rarr; gatekeeper.shouldProcess()
  (dedup, blacklist, whitelist, group rules)
  |
  v
pipeline.processLLM()
  +- Parallel: context + media + memory
  +- System prompt &rarr; LLM call
  +- Search loop (&le;2x, auto-timeout 30s)
  +- Memory extraction (fire-and-forget)
  +- Naturalize &rarr; split &rarr; send chunks
```

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `OLLAMA_API_KEY` | &check; | — | Ollama Cloud API key |
| `BOT_NUMBER` | &check; | — | Bot WhatsApp number |
| `OWNER_NUMBER` | &check; | — | Owner JID (comma-separated) |
| `DASHBOARD_PASSWORD_HASH` | &check; | — | bcrypt hash of password |
| `JWT_SECRET` | &check; | — | JWT signing secret |
| `REDIS_URL` | &check; | — | Upstash Redis (rediss://) |
| `OLLAMA_MODEL` | — | `gemma4:31b-cloud` | LLM model |
| `SEARCH_LOOP_TIMEOUT_MS` | — | `30000` | Search timeout |

> Full list di `.env.example` — include semua optional vars.

---

## Deploy ke Render + Upstash

### 1. Database (Upstash Redis)

Buat akun [upstash.com](https://upstash.com) &rarr; Create Redis &rarr; copas `REDIS_URL`.
Free tier 256MB cukup buat weeks of chat history.

### 2. App (Render)

| Step | Detail |
|---|---|
| Push ke GitHub | `git push origin main` |
| New Web Service | Pilih repo, branch `main` |
| Build Command | `npm install && npm run build` |
| Start Command | `npm start` |
| Env Variables | Isi semua required vars dari `.env.example` |
| Deploy | Tombol hijau &rarr; tunggu ~2 menit |

### 3. Biar Gak Tidur (UptimeRobot)

```
Monitor &rarr; HTTP(s) &rarr; https://app-kamu.onrender.com/health
Interval &rarr; 5 menit
```

Render free tier spin down after idle 15 menit. UptimeRobot jagain tetap hangat.

---

## Testing

```bash
npm test       # 256 tests, node:test native
npm run lint   # ESLint
```

Covers: auth, badwords, chunks, circuit, context, dispatch, gatekeeper, llm, media, memory, naturalize, personality, pipeline, redis, search, sticker, scenario.

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
- **Pino** for logging
- **personality.txt** = single source of truth for bot persona
