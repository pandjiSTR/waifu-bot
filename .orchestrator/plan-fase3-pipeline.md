# Fase 3 — Message Pipeline Inti + Sliding-Window Context
## Implementation Handoff Specification (DESIGN ONLY — backend sub-agent executes)

**Author:** Architecture sub-agent
**Status:** Ready for backend implementation
**Scope:** Modules `src/llm.js`, `src/context.js`, `src/baileys.js`, `src/pipeline.js`
**Out of scope (future phases):** `chunks.js`, `naturalize.js`, `badwords.js`, `circuit.js`, `search.js`, `media.js`, `sticker.js`, `autochat.js`, `stats.js` — referenced only as future hooks.

---

## 0. Source confirmation

This spec is grounded in the actual repo. Relevant PRD sections read from `PRD_Revamped.md`:
- **§5.1 Chat & Persona** — context window sizes (30 private / 50 group), minimized `{sender,text,timestamp}` fields, summarization via the same model after threshold.
- **§6.2 Message Pipeline** — `shouldProcessMessage()` decision chain (dedup -> whitelist -> sticker/command -> group filter -> badword -> debounce -> `processLLM()`); group prompt-trimming note; context saved AFTER all chunks sent.
- **§6.3 LLM Request Handling** — single model `gemma4:31b-cloud`, circuit flag (cooldown fallback), retry backoff `1s->2s->4s max 3x`, daily counter.
- **§6.4 Context Summarization** — fire-and-forget after reply; take oldest half (15/25), summarize to 2-3 sentences with same model, merge with prior summary, drop raw; skip when circuit cooldown.
- **§6.5 Owner Alert** — alert on cooldown entry (future, circuit.js).
- **§7 Data Model** — exact Redis key patterns & TTLs.
- **§9 Environment Variables** — `OLLAMA_*`, `MAX_CONTEXT_MESSAGES`, `MAX_GROUP_CONTEXT_MESSAGES`, `GROUP_CTX_TTL_DAYS`, `OWNER_NUMBER`, `BLACKLIST`, `WHITELIST`.
- **§13 Implementation Plan #3** — "Message pipeline inti — `shouldProcessMessage()`, `processLLM()`, sliding-window context (tanpa summarization)". NOTE: the plan says "tanpa summarization" but §6.4 re-introduces summarization. **Decision for this handoff: implement summarization too** because §5.1 + §6.4 explicitly require it for 30/50-message windows and it is low-risk fire-and-forget. Flagged in Open Questions.
- **§14 Backlog** — rate limiting, config versioning, feature flags, multi-model fallback: all deferred.

`AGENTS.md` architecture section confirms the intended module list and conventions (ESM, async/await, Pino `warn` default, no emoji, `personality.txt` single-source-of-truth).

Real API facts verified from `node_modules`:
- `ollama@0.5.12`: `new Ollama({ host, headers })`, `client.chat({ model, messages, stream:false, options, signal })` -> `ChatResponse.message.content: string`. The lib does **NOT** auto-read `OLLAMA_HOST`/`OLLAMA_API_KEY` — host + auth header must be passed explicitly. `Options` includes `num_ctx`, `temperature`, `num_predict`, `top_p`, `seed`.
- `@whiskeysockets/baileys@6.7.x`: `makeWASocket`, `useMultiFileAuthState(folder) -> { state, saveCreds }`, `isJidGroup(jid)`, `ConnectionState`, `WAMessage`. `messages.upsert` event payload = `{ messages: WAMessage[], type: 'notify'|'append'|'replace' }`.
- `src/redis.js`: helpers (`get/set/exists/lrange/lpush/ltrim/llen/del/sadd/smembers`) operate on a module singleton and are null-safe. **Missing: `expire`.** `createRedisClient()` returns the raw ioredis client (or `null`).

---

## 1. Config vars consumed (from `.env`)

| Var | Default | Consumed by | Notes |
|---|---|---|---|
| `OLLAMA_API_KEY` | — (required) | llm.js | Bearer token for Ollama Cloud |
| `OLLAMA_MODEL` | `gemma4:31b-cloud` | llm.js | Single conversation + summarizer model |
| `OLLAMA_TIMEOUT_MS` | `60000` | llm.js | Per-request AbortController timeout |
| `MAX_CONTEXT_MESSAGES` | `30` | context.js | Private window size before summarize |
| `MAX_GROUP_CONTEXT_MESSAGES` | `50` | context.js | Group window size before summarize |
| `GROUP_CTX_TTL_DAYS` | `7` | context.js | Group list TTL (refreshed each msg) |
| `OWNER_NUMBER` | — | pipeline.js, baileys.js | Comma-list; owner detection + future alert target |
| `BLACKLIST` | `` | pipeline.js | Comma-list; blocked senders |
| `WHITELIST` | `` | pipeline.js | Comma-list; if set, non-owner must be listed |
| `LOG_LEVEL` | `warn` | all | Pino level |
| `OLLAMA_HOST` | `https://gemma4.cloud.ollama.com` | llm.js | **NEW, optional** — base URL; do not hardcode cloud URL, read from env with this default |

> Do **not** add vars beyond these without updating `PRD §9`. `OLLAMA_HOST` is the only new var proposed (to avoid hardcoding the Ollama Cloud URL).

---

## 2. Redis key patterns & TTL (per PRD §7, authoritative over the `ctx:{jid}` shorthand in the task brief)

| Key | Type | TTL | Written by | Notes |
|---|---|---|---|---|
| `waifu:ctx:{userId}` | List (JSON strings) | `86400` (24h) | context.js | Private chat window. `userId` = sender JID for private, group JID for group. |
| `waifu:ctx_summary:{userId}` | String (text) | `86400` (24h) | context.js | Merged summary of old private messages |
| `waifu:grup:{groupJid}` | List (JSON strings) | `GROUP_CTX_TTL_DAYS`*86400 | context.js | Group window; TTL refreshed on every new message |
| `waifu:grup_summary:{groupJid}` | String (text) | `GROUP_CTX_TTL_DAYS`*86400 | context.js | Merged group summary |
| `waifu:circuit` | String JSON | 300s | circuit.js (Fase 5) | Not read in Fase 3; llm.js FUTURE hook only |
| `waifu:qr` | String (PNG data URL) | 300s | baileys.js | Optional: store QR for dashboard login view |
| `waifu:errors` | List | 7d | stats.js (Fase 4) | Fase 3 may push LLM failures here as a FUTURE hook |

**List encoding:** each element is `JSON.stringify({ sender, text, timestamp })`. Newest is pushed to head via `lpush`, so the list is **newest-first**. Keep length <= N with `ltrim(key, 0, N-1)`.

**TTL refresh:** `waifu:grup:*` TTL must be re-applied on every `addMessage` (PRD §7 "refresh tiap ada pesan baru"). This requires an `expire` call — see gap in §6.

**Graceful degradation:** every context function must work when `redis === null` (i.e. `REDIS_URL` unset). Use an in-memory `Map<userId, Array>` + `Map<userId, string>` fallback inside `context.js` so the bot still runs locally without Redis. Null-safe redis helpers already return `[]/null/0`, so calls are safe; the fallback Map is the persistence substitute.

## 3. Module specs

### 3.1 `src/llm.js` — Ollama Cloud request handler

**Responsibility:** Own the single Ollama Cloud client, translate a message array into an Ollama `chat` call, enforce timeout + retry/backoff, and expose a summarizer. Must NOT contain any persona strings (system prompt comes from `personality.js`).

**Imports:**
```js
import { Ollama } from 'ollama';
import pino from 'pino';
// (future) import circuit flag reader from './circuit.js'
```

**Module-level:**
```js
const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'https://gemma4.cloud.ollama.com';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma4:31b-cloud';
const OLLAMA_TIMEOUT_MS = parseInt(process.env.OLLAMA_TIMEOUT_MS || '60000', 10);

let client = null;
function getClient() {
  if (!client) {
    client = new Ollama({
      host: OLLAMA_HOST,
      headers: { Authorization: `Bearer ${process.env.OLLAMA_API_KEY}` },
    });
  }
  return client;
}
```

**Public signatures:**

```js
/**
 * Core chat call.
 * @param {Array<{role:string, content:string}>} messages  // [system, ...history, user]
 * @param {object} [opts]
 * @param {string} [opts.model]          // default OLLAMA_MODEL
 * @param {number} [opts.timeoutMs]      // default OLLAMA_TIMEOUT_MS
 * @param {Partial<Options>} [opts.options] // e.g. { num_ctx, temperature }
 * @param {AbortSignal} [opts.signal]    // for external cancellation
 * @returns {Promise<string>} assistant reply text
 * @throws {Error} after retries exhausted
 */
export async function chat(messages, opts = {}) { /* ... */ }

/**
 * Summarize text to ~maxSentences sentences using the same model.
 * Used by context.js fire-and-forget summarization.
 * @param {string} text
 * @param {object} [opts] { maxSentences=3, timeoutMs }
 * @returns {Promise<string>}
 */
export async function summarize(text, opts = {}) { /* ... */ }
```

**`chat()` behavior:**
1. Build request: `{ model: opts.model||OLLAMA_MODEL, messages, stream: false, options: opts.options||{} }`.
2. Timeout: create `const ac = new AbortController(); const t = setTimeout(()=>ac.abort(), opts.timeoutMs||OLLAMA_TIMEOUT_MS);` pass `signal: ac.signal`. Clear timeout in `finally`. (Also acceptable: `Promise.race` wrapper — but `signal` is the cleaner path; the ollama client forwards `signal` to fetch.)
3. Retry loop: `for attempt 0..2` (max 3 attempts). On fetch/abort/non-OK error: `if (attempt < 2) await sleep(1000 * 2**attempt)` (1s->2s->4s per §6.3) then retry. On final failure, throw with a clear message (caller/pipeline logs to `waifu:errors` later via FUTURE hook).
4. Return `response.message.content` (strip trailing whitespace only — do NOT alter persona style; `naturalize` is a later phase).
5. **FUTURE HOOK (Fase 5 circuit.js):** before calling, check `waifu:circuit` for `cooldown`; if cooldown, throw/short-circuit so pipeline can send fallback. Leave a clearly marked `// TODO(circuit): consult circuit.js` comment; implement the check in Fase 5, not here.

**`summarize()` behavior:** call `chat([{ role:'system', content: SUMMARY_INSTRUCTION }, { role:'user', content: text }], opts)` where `SUMMARY_INSTRUCTION` is a module-level constant clearly labeled as a *task instruction, not persona* (e.g. "Ringkas percakapan berikut menjadi N kalimat singkat, bahasa Indonesia, jaga fakta penting."). The instruction directs model behavior, not Ara's voice — acceptable under Design Principle #1.

---

### 3.2 `src/context.js` — Context window management + summarization

**Responsibility:** Store sliding windows per chat in Redis (list of minimized message objects), expose the window for prompt-building, and perform fire-and-forget summarization when the window hits its threshold. Full null-redis in-memory fallback.

**Imports:** `import * as redis from './redis.js'; import { chat, summarize } from './llm.js'; import pino from 'pino';`

**Module-level fallback Maps (used only when `redis === null`):**
```js
const memWindows = new Map();   // userId -> Array<{sender,text,timestamp}>
const memSummaries = new Map(); // userId -> string
```

**Helpers:**
```js
const PRIVATE_MAX = parseInt(process.env.MAX_CONTEXT_MESSAGES || '30', 10);
const GROUP_MAX   = parseInt(process.env.MAX_GROUP_CONTEXT_MESSAGES || '50', 10);
const GROUP_TTL_S = parseInt(process.env.GROUP_CTX_TTL_DAYS || '7', 10) * 86400;
const PRIVATE_TTL_S = 86400;

function keyFor(userId, isGroup) {
  return isGroup ? `waifu:grup:${userId}` : `waifu:ctx:${userId}`;
}
function summaryKeyFor(userId, isGroup) {
  return isGroup ? `waifu:grup_summary:${userId}` : `waifu:ctx_summary:${userId}`;
}
function maxFor(isGroup) { return isGroup ? GROUP_MAX : PRIVATE_MAX; }
function ttlFor(isGroup) { return isGroup ? GROUP_TTL_S : PRIVATE_TTL_S; }
```

**Public signatures (context.js):**

```js
/**
 * Append a message to the sliding window for a chat.
 * @param {object} redis  // raw ioredis client or null (from createRedisClient)
 * @param {string} userId // JID (private sender or group)
 * @param {{sender:string, text:string, timestamp:string|number}} msg
 * @param {boolean} [isGroup=false]
 * @returns {Promise<void>}
 */
export async function addMessage(redis, userId, msg, isGroup = false) { /* ... */ }

/**
 * Return the sliding window as a CHRONOLOGICAL array (oldest -> newest).
 * Merges the stored summary (if any) as a synthetic leading context note.
 * @param {object} redis
 * @param {string} userId
 * @param {boolean} [isGroup=false]
 * @returns {Promise<Array<{sender:string, text:string, timestamp:string}>>}
 */
export async function getWindow(redis, userId, isGroup = false) { /* ... */ }

/**
 * Return the stored summary string ('' if none).
 * @param {object} redis
 * @param {string} userId
 * @param {boolean} [isGroup=false]
 * @returns {Promise<string>}
 */
export async function getSummary(redis, userId, isGroup = false) { /* ... */ }

/**
 * Fire-and-forget summarization trigger. Call AFTER the reply is delivered.
 * If window length >= max, take oldest floor(max/2) messages, summarize,
 * merge with prior summary, persist, and drop the summarized raw messages.
 * No-op when circuit cooldown (FUTURE: check waifu:circuit) or window < max.
 * @param {object} redis
 * @param {string} userId
 * @param {boolean} [isGroup=false]
 * @returns {Promise<void>}
 */
export async function summarizeContext(redis, userId, isGroup = false) { /* ... */ }
```

**`addMessage()` behavior:**
- Build `item = JSON.stringify(msg)`.
- If `redis`: `await redis.lpush(key, item); await redis.ltrim(key, 0, maxFor(isGroup)-1);` then if group: `await redis.expire(key, ttlFor(true));` (refresh TTL). Also refresh summary TTL if present (optional).
- If `!redis`: push to `memWindows` Map (cap length to max manually, drop oldest).

**`getWindow()` behavior:**
- If `redis`: `const raw = await redis.lrange(key, 0, -1);` each element `JSON.parse`. List is newest-first, so `.reverse()` to chronological. Prepend a synthetic `{sender:'__summary__', text: summary, timestamp:''}` entry when a summary exists (so the LLM sees condensed history). Return the merged array.
- If `!redis`: return `memWindows.get(userId) || []` (already chronological if you push to tail) — keep the Map append order consistent with the chronological contract.
- **Group trimming refinement (PRD §6.2):** for Fase 3, return the FULL window. The "trim to messages mentioning 'ara'/reply + neighbors" optimization is a later refinement; leave a `// TODO(group-trim)` marker. Passing the full 50-message window is acceptable for Fase 3.

**`summarizeContext()` behavior (per §6.4):**
1. `const win = await getWindow(...)` (or read raw length directly).
2. If `win.length < maxFor(isGroup)` return.
3. `const take = Math.floor(maxFor(isGroup)/2)` (15 private / 25 group).
4. `const oldest = win.slice(0, take)` -> `const text = oldest.map(m => `${m.sender}: ${m.text}`).join('\n');`
5. `const prev = await getSummary(...);` `const newSummary = await summarize(`${prev ? prev + '\n' : ''}${text}`, { maxSentences: 3 });`
6. Persist: `await redis.set(summaryKey, newSummary, ttl)` (or memSummaries.set).
7. Drop the summarized raw messages: `await redis.ltrim(key, 0, maxFor-1-take)` (keep the newer half). For mem fallback, slice the array.
8. Wrap whole body in try/catch; log warn on failure — never block the user reply.

---

### 3.3 `src/baileys.js` — WhatsApp connection & event handlers

**Responsibility:** Initialize the Baileys socket with auth state, surface connection/QR state, handle `messages.upsert`, and gracefully shut down. It must NOT contain pipeline logic — it only normalizes incoming messages and forwards them to `pipeline.shouldProcess` / `pipeline.processLLM`.

**Imports:**
```js
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  isJidGroup,
} from '@whiskeysockets/baileys';
import { Buffer } from 'node:buffer';
import pino from 'pino';
import { shouldProcess, processLLM, extractText } from './pipeline.js';
```

**Auth state recommendation:** Use `useMultiFileAuthState('./.wa-auth')` (local folder) for Fase 3 — simplest that works, zero extra infra. The folder MUST be gitignored (add `.wa-auth/` to `.gitignore`). **Risk:** on Render free tier the filesystem resets on each deploy, so QR re-pairing is needed after every deploy. See Open Questions §6 for the Redis-backed auth-state alternative (recommended near-term follow-up). Do NOT implement Redis auth state in Fase 3.

**Public signature:**
```js
/**
 * Initialize the WhatsApp socket and wire event handlers.
 * @param {object} redis // may be null
 * @returns {Promise<{ sock: WASocket, stop: () => Promise<void> }>}
 */
export async function initWhatsApp(redis) { /* ... */ }
```

**`initWhatsApp()` behavior:**
1. `const { state, saveCreds } = await useMultiFileAuthState('.wa-auth');`
2. `const sock = makeWASocket({ auth: state, printQRInTerminal: true, logger: ... });` (use a quiet pino child; the `logger` option expects a baileys-compatible logger — pass `undefined` or a minimal adapter to keep Pino `warn` default).
3. `sock.ev.on('creds.update', saveCreds);`
4. `sock.ev.on('connection.update', async (update) => { ... })`:
   - `qr`: optionally `await redis?.set('waifu:qr', qr, 300)` and log the QR string. For Render, also consider `sock.requestPairingCode(OWNER_NUMBER)` as a no-QR alternative (see §6).
   - `connection === 'open'`: log connected; set a module-level `connectionState = 'connected'`.
   - `connection === 'close'`: inspect `lastDisconnect?.error?.output?.statusCode` vs `DisconnectReason.loggedOut`. If `loggedOut`, clear `.wa-auth` and require re-pair. Otherwise auto-reconnect is handled by baileys internally; if not, call `initWhatsApp` again (guard against infinite loop with a max-attempts counter, 2^n backoff up to 60s per PRD §10).
   - expose current state via a module-level `let connectionState = 'connecting'` exported through a getter `getConnectionState()` for `/api/health`.
5. `sock.ev.on('messages.upsert', async ({ messages, type }) => { ... })`:
   - Only handle `type === 'notify'` (live messages). Skip `statuses`, echoes (`message.key.fromMe === true`), and `message.message?.protocolMessage`.
   - For each `m`: `const body = extractText(m); if (!body) return;` (ignore non-text for Fase 3; media handled later by media.js/sticker.js).
   - Build `ctx = { sock, redis, jid: m.key.remoteJid, isGroup: isJidGroup(m.key.remoteJid), sender: m.key.participant || m.key.remoteJid, message: m, body, messageId: m.key.id }`.
   - `if (!(await shouldProcess(body, ctx))) return;`
   - `await processLLM(body, ctx);` (fire-and-forget with `.catch(err => logger.error(...))` so one bad message never crashes the socket).
6. Return `{ sock, stop: async () => { sock.ev.removeAllListeners(); await sock.logout?.() ?? sock.end?.(); } }`. For Fase 3 `stop` can call `sock.ws?.close()` / `sock.end()` — choose the API that exists; baileys `sock.end()` is the documented shutdown.

**Graceful degradation:** if `useMultiFileAuthState` throws (e.g. readonly FS), log and return a `{ sock: null, stop: async()=>{} }` so the HTTP server still boots. The dashboard/health must not crash because WA is down.

### 3.4 `src/pipeline.js` — Message pipeline orchestration

**Responsibility:** Decide whether Ara should reply (`shouldProcess`) and orchestrate the LLM turn (`processLLM`). For Fase 3 it wires only `context.js` + `llm.js` + `personality.js`; `naturalize.js`/`chunks.js`/`badwords.js`/`circuit.js` are referenced as FUTURE hooks.

**Imports:**
```js
import pino from 'pino';
import { buildSystemPrompt } from './personality.js';
import { chat } from './llm.js';
import { addMessage, getWindow, summarizeContext } from './context.js';
import { isJidGroup } from '@whiskeysockets/baileys';
```

**Module-level:**
```js
const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });
const OWNER_NUMBERS = (process.env.OWNER_NUMBER || '').split(',').map(s => s.trim()).filter(Boolean);
const BLACKLIST = (process.env.BLACKLIST || '').split(',').map(s => s.trim()).filter(Boolean);
const WHITELIST = (process.env.WHITELIST || '').split(',').map(s => s.trim()).filter(Boolean);
const COMMAND_PREFIX = 'ara'; // lowercase trigger word for groups / owner commands

// In-memory dedup: messageId -> expiry timestamp (1 min TTL, per PRD §6.2)
const seen = new Map();
```

**Public signatures:**

```js
/**
 * Extract plain text from a WAMessage.
 * Handles conversation / extendedText / image-video-audio caption.
 * @param {WAMessage} m
 * @returns {string|null}
 */
export function extractText(m) { /* ... */ }

/**
 * Decide whether Ara should produce a reply.
 * @param {string} body
 * @param {{jid:string, isGroup:boolean, sender:string, message:WAMessage, sock:object, redis:object, messageId:string}} ctx
 * @returns {Promise<boolean>}
 */
export async function shouldProcess(body, ctx) { /* ... */ }

/**
 * Orchestrate one LLM reply turn and send it.
 * @param {string} body
 * @param {{jid:string, isGroup:boolean, sender:string, message:WAMessage, sock:object, redis:object}} ctx
 * @returns {Promise<void>}
 */
export async function processLLM(body, ctx) { /* ... */ }
```

**`extractText()` behavior:** return `m.message?.conversation || m.message?.extendedTextMessage?.text || m.message?.imageMessage?.caption || m.message?.videoMessage?.caption || m.message?.audioMessage?.caption || null`. Normalize: strip null bytes, trim. (Max 2000-char input sanitization per §12 is a FUTURE hook — leave `// TODO(sanitize)`.)

**`shouldProcess()` decision chain (per PRD §6.2, Fase-3 scope):**
1. **Echo/self:** `if (ctx.message?.key?.fromMe) return false;`
2. **Dedup:** `if (seen.has(ctx.messageId)) return false;` else `seen.set(ctx.messageId, Date.now()+60000)` (and lazily prune expired entries). `// TODO: persist dedup in Redis for multi-instance` (§14 rate-limiting area).
3. **Blacklist:** `if (BLACKLIST.includes(normalizeNumber(ctx.sender))) return false;`
4. **Whitelist:** `if (WHITELIST.length && !OWNER_NUMBERS.includes(sender) && !WHITELIST.includes(sender)) return false;`
5. **Group rules:** if `ctx.isGroup`: respond only if (a) body mentions the bot (`@` mention of own jid — check `ctx.message.message?.extendedTextMessage?.contextInfo?.mentionedJid` includes bot jid, or reply to bot via `contextInfo?.quotedMessage`), OR (b) `body.toLowerCase().includes(COMMAND_PREFIX)`. Else `return false`. (Bot jid = `sock.user.id` split `@`[0] + `@s.whatsapp.net` — capture at init.)
6. **Owner commands:** if `OWNER_NUMBERS.includes(sender)` and `body.toLowerCase().startsWith('ara fresh')` or `'ara status'` -> `return false` (handled elsewhere / Fase 6+); do not send to LLM. For Fase 3, also `return false` for sticker-with-caption media (no media handling yet) — `if (ctx.message.message?.stickerMessage) return false;`.
7. **Badword / debounce:** Fase 3 does NOT block on badwords or debounce — leave `// TODO(badwords)` and `// TODO(debounce)` markers. Return `true` otherwise (private chat always replies; group only via rules above).

**`processLLM()` behavior (per PRD §6.2):**
1. `const userId = ctx.sender;` (private) or `ctx.jid` (group) — use `ctx.jid` consistently as the window key; for private chats `ctx.jid` IS the user JID. Recommended: `const userId = ctx.jid;`.
2. `await addMessage(ctx.redis, userId, { sender: ctx.sender, text: body, timestamp: new Date().toISOString() }, ctx.isGroup);` — persist the user's message FIRST so the next turn includes it.
3. `const window = await getWindow(ctx.redis, userId, ctx.isGroup);`
4. Build context string for system prompt: `const recentContext = window.map(m => m.sender === '__summary__' ? '[RINGKASAN]\n'+m.text : `${m.sender}: ${m.text}`).join('\n');`
5. `const systemPrompt = await buildSystemPrompt({ redis: ctx.redis, recentContext, knownFacts: '', currentMood: '' });` (facts/mood empty in Fase 3 — FUTURE hooks for `waifu:facts:{userId}` / `waifu:mood:{userId}`).
6. Build ollama messages: `const messages = [{ role:'system', content: systemPrompt }, ...window.filter(m=>m.sender!=='__summary__').map(m=>({ role: m.sender===ctx.sender||m.sender==='user' ? 'user':'assistant', content: m.text })), { role:'user', content: body }];`
   - NOTE: sender values stored are raw JIDs/'ara'. Normalize to `user`/`assistant` roles: map the owner/other human senders -> `'user'`, Ara's own messages (`sender==='ara'`) -> `'assistant'`. The summary entry is excluded from the message array (it is already in system prompt).
7. `let reply; try { reply = await chat(messages, { options: { num_ctx: ctx.isGroup ? 8192 : 4096 } }); } catch (err) { logger.error({err}, 'LLM failed'); return; }`
8. **Send:** Fase 3 sends directly: `await ctx.sock.sendMessage(ctx.jid, { text: reply });` — `// TODO(chunks): replace with sendChunks() in Fase 4`; `// TODO(naturalize): pass reply through naturalizeReply() first in Fase 4`.
9. `await addMessage(ctx.redis, userId, { sender:'ara', text: reply, timestamp: new Date().toISOString() }, ctx.isGroup);` — per PRD §6.2, context for the bot reply is saved AFTER delivery. For Fase 3 (single sendMessage) this is fine; when chunks land, save after all chunks succeed.
10. **Fire-and-forget summarization:** `summarizeContext(ctx.redis, userId, ctx.isGroup).catch(e => logger.warn({e}, 'summarize failed'));` (do NOT await — keeps latency low, per §6.4).

---

## 4. Integration points with existing files

### 4.1 `index.js` must start WhatsApp (currently does NOT)
In `main()`, after `await loadPersonality(redis);` and before route setup, add:
```js
import { initWhatsApp, getConnectionState } from './src/baileys.js';
// ...
let wa = { sock: null, stop: async () => {} };
try {
  wa = await initWhatsApp(redis);
} catch (err) {
  logger.error({ err }, 'WhatsApp init failed — continuing without WA');
}
```
Capture `wa.stop` in the `shutdown` handler: add `await wa.stop?.();` before `await closeRedis();`. Store `wa` in module scope so shutdown can reach it.

### 4.2 `/api/health` should reflect real socket state
`src/api-skeleton.js` `handleHealth` currently hardcodes `waSocket: 'connected'`. After Fase 3, change it to read `getConnectionState()` (imported from `baileys.js`) and report `'connected' | 'connecting' | 'disconnected'`. Also set `sessionReady` from `getConnectionState() === 'connected'`. This keeps UptimeRobot (§10) honest.

### 4.3 `personality.js` integration
`pipeline.processLLM` calls `buildSystemPrompt({ redis, recentContext, knownFacts, currentMood })` — the existing signature already matches. No change to `personality.js` needed.

### 4.4 `redis.js` gap — add `expire` helper
`context.js` needs TTL refresh on group keys; `redis.js` has no `expire`. Add a null-safe helper and export it:
```js
// in src/redis.js
export async function expire(key, seconds) {
  if (!client) return;
  try { await client.expire(key, seconds); } catch (err) { logger.error({err, key}, 'Redis EXPIRE failed'); }
}
```
Also export it from the default object map at the bottom of the file.

### 4.5 `.gitignore`
Add `.wa-auth/` so the local Baileys auth folder is never committed.

---

## 5. Recommended implementation ORDER (backend sub-agent)

1. **`redis.js`** — add + export the `expire(key, seconds)` null-safe helper (2-minute change; unblocks context.js).
2. **`llm.js`** — Ollama client singleton, `chat()` (timeout via AbortController + retry/backoff 1/2/4s), `summarize()`. Unit-testable with a mocked Ollama client.
3. **`context.js`** — `addMessage`, `getWindow`, `getSummary`, `summarizeContext` + in-memory fallback Maps. Add a `pipeline.integration.test.js` mock redis + llm.
4. **`pipeline.js`** — `extractText`, `shouldProcess`, `processLLM`. Wire `context.js` + `llm.js` + `personality.js`. Keep FUTURE-HOOK markers for naturalize/chunks/circuit/badwords.
5. **`baileys.js`** — `initWhatsApp` + `getConnectionState` + event handlers, calling into `pipeline`. Add `.wa-auth/` to `.gitignore`.
6. **`index.js`** — call `initWhatsApp` in `main()`, store `wa.stop`, invoke in `shutdown`. Update `handleHealth` to use `getConnectionState()`.
7. **Tests** — `test/llm.test.js` (mock ollama), `test/context.test.js` (window + summarize with fake redis), `test/pipeline.integration.test.js` (mock redis + llm + baileys-shaped message). Target the §11 suite entries that exist for Fase 3.

---

## 6. Open questions / risks

1. **Baileys auth state on Render (HIGH).** `useMultiFileAuthState` writes to local disk. Render free-tier filesystem resets on every deploy, so the QR session is lost and re-pairing (owner scans QR / enters pairing code) is required after each deploy. Options: (a) accept for Fase 3 + dev; (b) implement a Redis-backed `AuthState` adapter (keys `waifu:auth:*`, already reserved in PRD §7) as a near-term follow-up; (c) mount a persistent disk. **Decision needed from owner before Fase 4.** Recommendation: keep local for Fase 3, schedule Redis auth-state for the next sprint.
2. **Ollama Cloud host/key (MEDIUM).** Verified the `ollama` JS lib does NOT read `OLLAMA_HOST`/`OLLAMA_API_KEY` from env — must pass `host` + `Authorization` header explicitly (done in spec). The cloud base URL `https://gemma4.cloud.ollama.com` is assumed from Ollama Cloud docs; confirm it matches the account's assigned base URL (it can vary). Mitigation: `OLLAMA_HOST` env override (already in spec).
3. **§13 vs §6.4 contradiction (LOW).** Plan §13 says pipeline is "tanpa summarization" but §6.4 requires it. This spec implements summarization (fire-and-forget). If the owner prefers strictly-minimal Fase 3, `summarizeContext` can be a no-op stub for now. Flagged for confirmation.
4. **Group prompt trimming (LOW).** PRD §6.2 wants group prompts trimmed to relevant subset; Fase 3 sends the full 50-message window. Acceptable but costs tokens. `// TODO(group-trim)` left in `getWindow`.
5. **Facts / mood not in Fase 3 (INFO).** `buildSystemPrompt` is called with empty `knownFacts`/`currentMood`. `waifu:facts:*`, `waifu:mood:*` keys exist in PRD §7 but are populated in later phases (autochat/fact-extraction). No block.
6. **Circuit breaker absent in Fase 3 (INFO).** `llm.js` has retry/backoff but no cooldown flag. On repeated LLM failure it will retry every message. Cooldown (`circuit.js`, Fase 5) is the mitigation; acceptable for Fase 3 dev. `// TODO(circuit)` hooks left in `llm.js` and `pipeline.js`.
7. **Dedup is in-memory only (LOW).** Resets on restart; multi-instance would double-process. Acceptable for single-instance Render. Persisted dedup is a §14 item.
8. **`num_ctx` sizing (LOW).** Spec suggests 4096 (private) / 8192 (group) via `options.num_ctx`. Tune after measuring token usage; Ollama Cloud may cap context — confirm model limits.
9. **Sender normalization for roles (MEDIUM).** Stored `sender` is a raw JID; mapping to `user`/`assistant` roles in `processLLM` step 6 must correctly treat Ara's own stored replies (`sender:'ara'`) as `assistant`. Verify the role mapping with a unit test on a mixed window.

---

*End of handoff spec. Backend sub-agent may implement; do not alter architecture decisions without re-review.*

