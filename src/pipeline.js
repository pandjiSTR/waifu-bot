import pino from 'pino';
import { normalizeNumber, getOwnerNumbers } from './util.js';
import { buildSystemPrompt } from './personality.js';
import { chat } from './llm.js';
import { addMessage, getWindow, summarizeContext, replaceLastMessage } from './context.js';
import { sendChunks } from './chunks.js';
import { naturalizeReply, guardLaughs, hasLaugh, stripTrailingLaugh } from './naturalize.js';
import { isOpen, remainingMs, onTrip, onClose } from './circuit.js';
import { detectBadword } from './badwords.js';
import { describeImage, extractPdfText, getMediaBuffer } from './media.js';
import { makeSticker } from './sticker.js';
import { webSearch, webFetch, extractSearchQuery, stripSearchTokens } from './search.js';
import { getFriendMemory, addFact, setMood } from './memory.js';
import { extractText, shouldProcess, trackBotMessage, loadBlacklist, setBlacklist, stopSweeper, isStickerRequest } from './gatekeeper.js';

// PRD §5.7: a detected badword must NOT block the message — it shifts the reply
// tone to sarcastic. This is a TASK instruction (behavior), not persona voice
// (persona strings live only in personality.txt per AGENTS.md #1).
const BADWORD_TONE_INSTRUCTION = 'Tanggapi dengan nada sarkastik.';

const MULTI_MESSAGE_INSTRUCTION = `\n\nFORMAT BALASAN: Baris kosong (dua enter) = pesan/bubble baru yang kepisah. Pakai baris kosong CUMA kalau emang mau misahin poin/topik beda (misal list panjang, penjelasan bertahap). Balasan pendek/santai/ngobrol biasa: tetap 1 bubble, JANGAN kasih baris kosong. Jangan pernah ada baris kosong yang gak disengaja.`;

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

// Neutral, system-level notice used while the circuit breaker is open. It is
// intentionally NOT Ara's persona voice (per AGENTS.md #1 / PRD design
// principle #1) — it only informs the user the bot is briefly unavailable.
const CIRCUIT_FALLBACK =
  process.env.CIRCUIT_BREAKER_FALLBACK || 'lagi sibuk sebentar, coba lagi nanti';

// Runtime toggle: the circuit breaker can be disabled remotely via dashboard
// settings (PRD §6.3). When false, isOpen() is bypassed so LLM calls proceed
// even during a cooldown window. Defaults to enabled.
let circuitBreakerEnabled = true;

export function setCircuitBreakerEnabled(v) {
  circuitBreakerEnabled = !!v;
}

let registered = false;
if (!registered) {
  registered = true;
  onTrip((d) => logger.info({ ...d }, 'Circuit breaker tripped'));
  onClose((d) => logger.info({ ...d }, 'Circuit breaker closed'));
}

/**
 * Send a single neutral owner alert when the circuit breaker trips, deduped
 * via the `waifu:last_alert` Redis key (15-min window, PRD §6.3 / §6.5).
 *
 * This is intentionally NOT Ara's persona voice — it is a system maintenance
 * notice to the owner only. It is fully guarded so a failed alert can never
 * break the main message flow.
 *
 * @param {{jid:string, isGroup:boolean, sender:string, message:object, sock:object, redis:object|null}} ctx
 */
export async function maybeAlertOwner(ctx) {
  const ownerDigits = getOwnerNumbers()[0];
  if (!ownerDigits) return; // no owner configured -> no-op

  const ownerJid = ownerDigits + '@s.whatsapp.net';
  const ALERT_KEY = 'waifu:last_alert';
  const ALERT_TTL = 900; // 15 minutes

  try {
    // Dedup: skip if an alert was already sent within the 15-min window.
    const alreadyAlerted = await ctx.redis?.get(ALERT_KEY);
    if (alreadyAlerted) return;

    const seconds = Math.ceil(remainingMs() / 1000);
    const text =
      `Circuit breaker terbuka — LLM sedang disuspensi ${seconds} detik.`;

    await ctx.sock?.sendMessage(ownerJid, { text });

    // Mark the window only after a successful send so a failed send does not
    // silently suppress the next (needed) alert.
    await ctx.redis?.set(ALERT_KEY, '1', 'EX', ALERT_TTL);
  } catch (err) {
    logger.warn({ err }, 'owner alert failed (ignored)');
  }
}

/**
 * Extract [REMEMBER: ...] and [MOOD: ...] tokens from a reply text.
 * @param {string} text
 * @returns {{ facts: string[], mood: string|null }}
 */
export function extractMemoryTokens(text) {
  const facts = [];
  let mood = null;
  const factRegex = /\[REMEMBER:\s*([^\]]+)\]/gi;
  const moodRegex = /\[MOOD:\s*([^\]]+)\]/gi;
  let m;
  while ((m = factRegex.exec(text)) !== null) {
    facts.push(m[1].trim());
  }
  if ((m = moodRegex.exec(text)) !== null) {
    mood = m[1].trim();
  }
  return { facts, mood };
}

/**
 * Strip all [REMEMBER:...] and [MOOD:...] tokens from text.
 * @param {string} text
 * @returns {string}
 */
export function stripMemoryTokens(text) {
  return text
    .replace(/\[REMEMBER:[^\]]*\]/gi, '')
    .replace(/\[MOOD:[^\]]*\]/gi, '')
    .trim();
}

/**
 * Orchestrate one LLM reply turn and send it.
 * @param {string} body
 * @param {{jid:string, isGroup:boolean, sender:string, message:object, sock:object, redis:object|null}} ctx
 * @returns {Promise<void>}
 */
export async function processLLM(body, ctx) {
  const pStart = Date.now();
  const userId = ctx.jid; // private: user JID; group: group JID
  const isGroup = !!ctx.isGroup;

  // Fase 6 (§5.3): sticker-maker interception. Image-as-sticker requests are
  // handled here and must NOT reach the LLM or be persisted as conversation.
  // Never throws — failures are logged and skipped.
  if (isStickerRequest(ctx)) {
    try {
      const sticker = await makeSticker(ctx.sock, ctx.message);
      if (sticker) {
        await ctx.sock?.sendMessage(ctx.jid, { sticker });
      } else {
        logger.warn('makeSticker returned no buffer; skipping sticker send');
      }
    } catch (err) {
      logger.warn({ err }, 'sticker generation failed (ignored)');
    }
    logger.info({ duration: Date.now() - pStart, action: 'sticker' }, 'Message processed');
    return;
  }

  // Persist the user's message FIRST so the next turn includes it.
  // (Groups are already persisted in baileys.js before shouldProcess, so we
  // skip the duplicate write here for groups.)
  const persistPromise = isGroup
    ? Promise.resolve()
    : addMessage(ctx.redis, userId, { sender: ctx.sender, text: body, timestamp: new Date().toISOString() }, isGroup);

  // Fase 6 (§5.6): start media extraction for image/PDF in parallel with
  // context loading — both are independent and the user doesn't need to wait
  // for both sequentially. Falls back to ctx.mediaContext for test injection.
  const mediaPromise = (async () => {
    if (ctx.mediaContext) return ctx.mediaContext;
    const msgNode = ctx.message?.message;
    if (!msgNode) return null;
    try {
      if (msgNode.imageMessage) {
        const desc = await describeImage(ctx.sock, ctx.message, body);
        return desc ? `[GAMBAR] ${desc}` : null;
      }
      if (msgNode.documentMessage && msgNode.documentMessage.mimetype === 'application/pdf') {
        const buf = await getMediaBuffer(ctx.sock, ctx.message);
        const text = buf ? await extractPdfText(buf) : '';
        return text ? `[PDF] ${text}` : null;
      }
    } catch (err) {
      logger.warn({ err }, 'media context extraction failed (ignored)');
    }
    return null;
  })();

  // Run message persist, context loading, and friend memory in parallel
  const [window, mem] = await Promise.all([
    persistPromise.then(() => getWindow(ctx.redis, userId, isGroup)),
    getFriendMemory(ctx.redis, ctx.sender),
  ]);
  const mediaContext = await mediaPromise;

  // Resolve display names for context clarity (group-awareness). Falls back
  // to raw JIDs when redis is unavailable or names aren't populated.
  let nameMap = {};
  if (ctx.redis && typeof ctx.redis.hgetall === 'function') {
    try { nameMap = await ctx.redis.hgetall('waifu:friends:names') || {}; } catch { /* ignore */ }
  }
  const resolveName = (jid) => (nameMap && nameMap[jid]) || jid;

  // Cross-reply laugh control: if Ara already laughed in her recent messages,
  // suppress laughs in this reply too (max 0). Otherwise allow at most one.
  // This keeps laughs rare across a conversation instead of every reply.
  const araRecentLaughed = window
    .filter((m) => m.sender === 'ara')
    .slice(-5)
    .some((m) => hasLaugh(m.text));

  const recentContext = window
    .map((m) =>
      m.sender === '__summary__'
        ? '[RINGKASAN]\n' + m.text
        : `${resolveName(m.sender)}: ${m.text}`
    )
    .join('\n');

  const factsStr = mem.facts.length ? '• ' + mem.facts.join('\n• ') : '';
  let systemPrompt = await buildSystemPrompt(ctx.redis, recentContext, factsStr, mem.mood || '');

  // PRD §5.7: a detected badword shifts the reply tone to sarcastic. This is a
  // TASK instruction (behavior), not persona voice (AGENTS.md #1).
  if (ctx.badword) {
    systemPrompt += '\n\n' + BADWORD_TONE_INSTRUCTION;
  }
  systemPrompt += MULTI_MESSAGE_INSTRUCTION;

  // Build the LLM message list from the window returned by getWindow, which
  // ALREADY includes the current user message (persisted above via addMessage).
  // Do NOT append the current message again — that would double-send it.
  const messages = [
    { role: 'system', content: systemPrompt },
    ...window
      .filter((m) => m.sender !== '__summary__')
      .map((m) => ({
        role: m.sender === 'ara' ? 'assistant' : 'user',
        content: m.text,
      })),
  ];

  // Test seam: allow callers to inject a mock LLM via ctx.llm.chat;
  // falls back to the real Ollama client otherwise.
  const chatFn = ctx.llm?.chat || chat;

  // Prepend media context to the current (last) user turn so the model sees it
  // alongside the user's text. If no user turn exists, append a synthetic one.
  let target = -1;
  if (mediaContext) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        target = i;
        break;
      }
    }
    if (target >= 0) {
      messages[target].content = `${mediaContext}\n${messages[target].content}`;
    } else {
      messages.push({ role: 'user', content: mediaContext });
    }
  }

  // Persist enriched media context back to Redis so follow-up turns see it.
  if (mediaContext && target >= 0 && ctx.redis) {
    replaceLastMessage(ctx.redis, userId, ctx.sender, messages[target].content, isGroup)
      .catch(() => {});
  }

  // Fase 5 (§6.3): if the circuit breaker is open, skip the LLM call entirely
  // and send a short neutral fallback. We do NOT persist it as a normal Ara
  // reply — it is a maintenance notice, not conversation.
  if (circuitBreakerEnabled && isOpen()) {
    logger.warn(
      { remainingMs: remainingMs() },
      'circuit open — sending fallback reply, skipping LLM'
    );
    ctx.redis?.lpush('waifu:logs', JSON.stringify({ time: new Date().toISOString(), level: 'warn', msg: 'Circuit breaker open — sending fallback' })).catch(() => {});
    // Notify the owner once per 15-min window (idempotent via Redis dedup).
    await maybeAlertOwner(ctx);
    await sendChunks(ctx.sock, userId, CIRCUIT_FALLBACK, {
      sendMessage: ctx.sock?.sendMessage?.bind(ctx.sock),
    }).then((d) => { if (d?.ids) d.ids.forEach(trackBotMessage); });
    logger.info({ duration: Date.now() - pStart, action: 'circuit_fallback' }, 'Message processed');
    return;
  }

  let reply;
  try {
    reply = await chatFn(messages, {
      options: { num_ctx: isGroup ? 8192 : 4096 },
    });
    // Record LLM call timing (fire-and-forget)
    if (ctx.redis) {
      ctx.redis.lpush('waifu:stats:llm_times', Date.now() - pStart).catch(() => {});
      ctx.redis.ltrim('waifu:stats:llm_times', 0, 99).catch(() => {});
    }
  } catch (err) {
    logger.error({ err }, 'LLM request failed');
    // Only alert the owner if the breaker actually tripped this turn (a real
    // cooldown), not on a one-off transient failure. Deduped per 15-min window.
    if (circuitBreakerEnabled && isOpen()) {
      await maybeAlertOwner(ctx);
    }
    logger.info({ duration: Date.now() - pStart, action: 'llm_error' }, 'Message processed');
    return;
  }

  // ── SEARCH LOOP (Fase 6, §5.6 / §6.2) ──
  // Persona-driven: if the model emits [SEARCH: query], Ara needs to look up
  // information.  The decision to search comes exclusively from personality.txt
  // (see PRD line 128) — no keyword list or forced-search logic in code.
  const MAX_SEARCH_ITERATIONS = 2;
  let searchIterations = 0;
  const searchFn = ctx.search || webSearch;
  const searchTimeoutMs = parseInt(process.env.SEARCH_LOOP_TIMEOUT_MS || '30000', 10);
  const searchAc = new AbortController();
  const searchTimer = setTimeout(() => searchAc.abort(), searchTimeoutMs);

  try {
  while (searchIterations < MAX_SEARCH_ITERATIONS) {
    const q = extractSearchQuery(reply);
    if (!q) break;

    let results = await searchFn(q, { redis: ctx.redis });
    if (!results) break;

    try {
      const urlMatch = results.match(/\(https?:\/\/[^\s)]+\)/);
      if (urlMatch) {
        const url = urlMatch[0].slice(1, -1);
        const fetchFn = ctx.fetch || webFetch;
        const content = await fetchFn(url);
        if (content) {
          results += '\n\n[ISI HALAMAN]\n' + content.slice(0, 2000);
        }
      }
    } catch (e) {
      logger.warn({ err: e }, 'webFetch augment failed (ignored)');
    }

    messages.push({
      role: 'user',
      content: `[HASIL PENCARIAN]\n${results}\n\nGunakan hasil di atas untuk menjawab.`,
    });

    try {
      reply = await chatFn(messages, {
        options: { num_ctx: isGroup ? 8192 : 4096 },
        signal: searchAc.signal,
      });
    } catch (err) {
      if (searchAc.signal.aborted) {
        logger.warn('search loop timed out — stopping further search iterations');
        break;
      }
      logger.error({ err }, 'LLM search follow-up failed');
      break;
    }

    searchIterations++;
  }
  } finally {
    clearTimeout(searchTimer);
  }

  // Strip any remaining [SEARCH: ...] tokens so the user never sees them.
  reply = stripSearchTokens(reply);

  // Strip leading "tunggu/sebentar/wait" artifacts that remain when a search
  // was attempted but failed to produce an actual answer (e.g. webSearch
  // returned empty or the follow-up LLM call errored). The personality.txt
  // forbids sending "tunggu" as a message, but this is a safety net so users
  // never see a fake wait message followed by silence.
  const stripped = reply.replace(/^(tunggu\s*(ya|dulu|sebentar|bentar)?[\s,.\n]*)+/i, '').trim();
  if (stripped !== reply) {
    reply = stripped;
    logger.warn({ original: reply, stripped }, 'stripped tunggu lead-in from reply');
  }

  // ── MEMORY TOKENS (FIRE-AND-FORGET) ──
  // Extract [REMEMBER: ...] and [MOOD: ...] tokens, persist asynchronously,
  // then strip them so they never reach the user. Memory errors never block
  // the message flow (PRD §6.2 resilience principle).
  const memTokens = extractMemoryTokens(reply);
  if (memTokens.facts.length || memTokens.mood) {
    const memRedis = ctx.redis;
    (async () => {
      try {
        for (const fact of memTokens.facts) {
          await addFact(memRedis, ctx.sender, fact);
        }
        if (memTokens.mood) {
          await setMood(memRedis, ctx.sender, memTokens.mood);
        }
      } catch {
        // Memory errors must never break the message flow.
      }
    })();
  }
  reply = stripMemoryTokens(reply);

  // Fase 4: normalize (generic, persona-agnostic) before delivery.
  reply = guardLaughs(reply, { max: araRecentLaughed ? 0 : 1 });
  reply = stripTrailingLaugh(reply);
  reply = naturalizeReply(reply);

  // Split on every \n\n — each paragraph becomes its own WhatsApp bubble.
  // The LLM controls bubble structure via blank lines; short banter stays as
  // 1 bubble, multi-part replies naturally separate.
  const segments = reply.split(/\n\n/).map((s) => s.trim()).filter(Boolean);

  let deliveryFailed = false;
  for (let i = 0; i < segments.length; i++) {
    if (i > 0) {
      await new Promise((r) => setTimeout(r, 1500));
    }
    const delivery = await sendChunks(ctx.sock, userId, segments[i], {
      sendMessage: ctx.sock?.sendMessage?.bind(ctx.sock),
    });
    if (delivery.ids) delivery.ids.forEach(trackBotMessage);
    if (delivery.failed) {
      deliveryFailed = true;
      logger.warn({ delivery }, 'sendChunks failed for segment');
    }
  }

  // Context for the bot reply is saved AFTER delivery (PRD §6.2).
  // PRD §5.7: mark incomplete when not every chunk was delivered so a later
  // phase can reconcile; the naturalized reply text is always stored.
  await addMessage(
    ctx.redis,
    userId,
    {
      sender: 'ara',
      text: reply,
      timestamp: new Date().toISOString(),
      incomplete: deliveryFailed,
    },
    isGroup
  );

  // Fire-and-forget Redis log on successful delivery
  ctx.redis?.lpush('waifu:logs', JSON.stringify({ time: new Date().toISOString(), level: 'info', msg: 'Message processed successfully' })).catch(() => {});
  ctx.redis?.ltrim('waifu:logs', 0, 499).catch(() => {});

  // Fire-and-forget summarization — keeps latency low (§6.4).
  summarizeContext(ctx.redis, userId, isGroup).catch((e) =>
    logger.warn({ e }, 'summarize failed')
  );
  logger.info({ duration: Date.now() - pStart, action: 'reply' }, 'Message processed');
}
