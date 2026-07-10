import pino from 'pino';
import { buildSystemPrompt } from './personality.js';
import { chat } from './llm.js';
import { addMessage, getWindow, summarizeContext, replaceLastMessage } from './context.js';
import { sendChunks } from './chunks.js';
import { naturalizeReply, guardLaughs, hasLaugh } from './naturalize.js';
import { isOpen, remainingMs, onTrip, onClose } from './circuit.js';
import { detectBadword } from './badwords.js';
import { describeImage, extractPdfText, getMediaBuffer } from './media.js';
import { makeSticker } from './sticker.js';
import { webSearch, webFetch, extractSearchQuery, stripSearchTokens } from './search.js';
import { getFriendMemory, addFact, setMood } from './memory.js';

// PRD §5.7: a detected badword must NOT block the message — it shifts the reply
// tone to sarcastic. This is a TASK instruction (behavior), not persona voice
// (persona strings live only in personality.txt per AGENTS.md #1).
const BADWORD_TONE_INSTRUCTION = 'Tanggapi dengan nada sarkastik.';



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

const OWNER_NUMBERS = (process.env.OWNER_NUMBER || '')
  .split(',')
  .map(normalizeNumber)
  .filter(Boolean);
let blacklist = [];
const WHITELIST = (process.env.WHITELIST || '')
  .split(',')
  .map(normalizeNumber)
  .filter(Boolean);

// In-memory dedup: messageId -> expiry timestamp (1 min TTL, per PRD §6.2).
// TODO: persist dedup in Redis for multi-instance (§14 rate-limiting area).
const seen = new Map();
const SEEN_TTL_MS = 60 * 1000;
let sweepTimer = process.env.NODE_ENV !== 'test' ? setInterval(pruneSeen, 5 * 60 * 1000) : null;

// Tracks the message ids the bot itself has sent, so a later reply quoting one
// of them (contextInfo.stanzaId) can be recognized as "reply to Ara" without
// fragile JID/participant comparison. Mirrors the proven main-branch approach.
const botSentIds = new Set();
const MAX_BOT_SENT = 10000;

export function trackBotMessage(id) {
  if (!id) return;
  if (botSentIds.size >= MAX_BOT_SENT) botSentIds.clear();
  botSentIds.add(id);
}

function normalizeNumber(n) {
  if (!n) return '';
  return String(n)
    .replace(/@s\.whatsapp\.net$/, '')
    .replace(/:\d+$/, '') // strip device suffix, e.g. :0 in 628...:0@s.whatsapp.net
    .replace(/[^0-9]/g, '');
}

function pruneSeen() {
  const now = Date.now();
  for (const [k, exp] of seen) {
    if (exp < now) seen.delete(k);
  }
}

export function stopSweeper() {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

export async function loadBlacklist(redis) {
  if (redis) {
    try {
      const raw = await redis.get('waifu:settings:misc');
      if (raw) {
        const parsed = JSON.parse(raw);
        const list = parsed.blacklist || '';
        blacklist = String(list).split(',').map(normalizeNumber).filter(Boolean);
        return;
      }
    } catch (err) {
      logger.warn({ err }, 'loadBlacklist failed');
    }
  }
  blacklist = (process.env.BLACKLIST || '').split(',').map(normalizeNumber).filter(Boolean);
}

export function setBlacklist(list) {
  blacklist = Array.isArray(list) ? list.map(normalizeNumber).filter(Boolean) : [];
}

/**
 * Extract plain text from a WAMessage.
 * Handles conversation / extendedText / image-video-audio caption.
 * @param {object} m  // WAMessage
 * @returns {string|null}
 */
export function extractText(m) {
  const msg = m?.message;
  if (!msg) return null;

  const text =
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.audioMessage?.caption ||
    null;

  if (text == null) return null;

  const cleaned = String(text).replace(/\0/g, '').trim().slice(0, 2000);
  return cleaned || null;
}

/**
 * Detect a sticker-maker request: an image message that is either captioned
 * with "stiker"/"sticker" or is a reply to a bot message. (PRD §5.3)
 * @param {{message?:object, sock?:object}} ctx
 * @returns {boolean}
 */
function isStickerRequest(ctx) {
  const msg = ctx?.message?.message;
  if (!msg?.imageMessage) return false;

  const caption = msg.imageMessage.caption || '';
  if (/stiker|sticker/i.test(caption)) return true;

  // Reply to a bot message (image sent as a reply). The quoted participant
  // equals the bot's own JID when replying to Ara. Use the connection-captured
  // JID (ctx.botJid) so it is reliable even if sock.user.id is unset.
  const ctxInfo = msg.imageMessage.contextInfo;
  if (ctxInfo?.quotedMessage) {
    const botNumber = normalizeNumber(ctx?.botJid || ctx?.sock?.user?.id);
    if (botNumber && normalizeNumber(ctxInfo.participant) === botNumber) return true;
  }
  return false;
}

/**
 * Decide whether Ara should produce a reply.
 * @param {string} body
 * @param {{jid:string, isGroup:boolean, sender:string, message:object, sock:object, redis:object|null, messageId:string}} ctx
 * @returns {Promise<boolean>}
 */
export async function shouldProcess(body, ctx) {
  // 1. Echo / self
  if (ctx.message?.key?.fromMe) return false;

  // 2. Dedup (memory + Redis NX: survives restart / multi-instance)
  pruneSeen();
  const mid = ctx.messageId;
  if (mid && seen.has(mid)) return false;
  if (mid && ctx.redis) {
    try {
      const r = await ctx.redis.set(`waifu:seen:${mid}`, '1', 'EX', 300, 'NX');
      if (r === null) return false; // already processed -> skip
    } catch { /* fall back to memory-only */ }
  }
  if (mid) seen.set(mid, Date.now() + SEEN_TTL_MS);

  // 3. Blacklist
  const senderNorm = normalizeNumber(ctx.sender);
  if (blacklist.includes(senderNorm)) {
    ctx.redis?.lpush('waifu:logs', JSON.stringify({ time: new Date().toISOString(), level: 'info', msg: `Blocked blacklisted: ${ctx.sender}` })).catch(() => {});
    return false;
  }

  // 4. Whitelist (if set, only owner + listed numbers may interact)
  if (
    WHITELIST.length &&
    !OWNER_NUMBERS.includes(senderNorm) &&
    !WHITELIST.includes(senderNorm)
  ) {
    return false;
  }

  // 5. Group rules: respond only on mention / reply-to-bot / command prefix.
  if (ctx.isGroup) {
    // Prefer the JID captured at connection time (ctx.botJid); fall back to the
    // socket's user id. Compare on normalized digits so LID / device-suffix
    // / @mention-prefix formats all match reliably.
    const botNumber = normalizeNumber(ctx.botJid || ctx.sock?.user?.id);
    const contextInfo = ctx.message?.message?.extendedTextMessage?.contextInfo;
    const mentioned = contextInfo?.mentionedJid || [];
    const mentionedBot =
      Array.isArray(mentioned) && mentioned.some((j) => normalizeNumber(j) === botNumber);
    const quotedParticipant = contextInfo?.participant;
    const quotedBot = quotedParticipant
      ? normalizeNumber(quotedParticipant) === botNumber
      : false;
    // Robust reply-to-bot detection (mirrors main branch): if the quoted
    // message id is one the bot actually sent, this is a reply to Ara —
    // independent of participant/JID format quirks.
    const stanzaId = contextInfo?.stanzaId;
    const isReplyToBot = Boolean(stanzaId) && botSentIds.has(stanzaId);
    const bodyLower = String(body).toLowerCase();
    if (!mentionedBot && !quotedBot && !isReplyToBot && !/\bara+/i.test(bodyLower)) {
      return false;
    }
  }

  // 6. Owner commands / unsupported media.
  // Owner-only commands ('ara fresh', 'ara status') are handled elsewhere (Fase 6+);
  // do not send them to the LLM.
  const ownerCmd = String(body).toLowerCase();
  if (
    OWNER_NUMBERS.includes(senderNorm) &&
    (ownerCmd.startsWith('ara fresh') || ownerCmd.startsWith('ara status'))
  ) {
    return false;
  }
  // Incoming user-sent stickers are still ignored (no media handling for them).
  if (ctx.message?.message?.stickerMessage) return false;

  // 7. Badword (Fase 6 / PRD §5.7): detected -> mark ctx.badword but DO NOT
  // block. The pipeline shifts the reply tone to sarcastic instead. Debounce
  // (rate-limit per sender) remains deferred to §14 backlog.
  if (detectBadword(body)) {
    ctx.badword = true;
  }

  // Fire-and-forget Redis instrumentation (never blocks the pipeline).
if (ctx.redis) {
    ctx.redis.hincrby('waifu:stats:messages', 'total', 1).catch(() => {});
    ctx.redis.hincrby('waifu:stats:friends', ctx.sender, 1).catch(() => {});
    const hourKey = 'waifu:stats:hourly:' + new Date().toISOString().slice(0, 13) + ':00';
    ctx.redis.zincrby(hourKey, 1, 'msg').catch(() => {});
    ctx.redis.expire(hourKey, 48 * 3600).catch(() => {});
  }

  return true;
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
  const ownerDigits = OWNER_NUMBERS[0];
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
  if (!isGroup) {
    await addMessage(
      ctx.redis,
      userId,
      { sender: ctx.sender, text: body, timestamp: new Date().toISOString() },
      isGroup
    );
  }

  const window = await getWindow(ctx.redis, userId, isGroup);

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

  // Load friend memory so the model knows existing facts and mood (if any).
  const mem = await getFriendMemory(ctx.redis, ctx.sender);
  const factsStr = mem.facts.length ? '• ' + mem.facts.join('\n• ') : '';
  // personality.js uses positional args: (redis, context, facts, mood).
  let systemPrompt = await buildSystemPrompt(ctx.redis, recentContext, factsStr, mem.mood || '');

  // PRD §5.7: a detected badword shifts the reply tone to sarcastic. This is a
  // TASK instruction (behavior), not persona voice (AGENTS.md #1).
  if (ctx.badword) {
    systemPrompt += '\n\n' + BADWORD_TONE_INSTRUCTION;
  }


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

  // Fase 6 (§5.6): attach media context for image / PDF messages. Prefer an
  // injected ctx.mediaContext (so processLLM is testable without a real socket);
  // otherwise detect from the message and call media.js. On any failure we log
  // and skip — media is supplementary, never a blocker.
  let mediaContext = ctx.mediaContext;
  if (!mediaContext && ctx.message?.message) {
    const msgNode = ctx.message.message;
    try {
      if (msgNode.imageMessage) {
        const desc = await describeImage(ctx.sock, ctx.message, body);
        if (desc) mediaContext = `[GAMBAR] ${desc}`;
      } else if (
        msgNode.documentMessage &&
        msgNode.documentMessage.mimetype === 'application/pdf'
      ) {
        const buf = await getMediaBuffer(ctx.sock, ctx.message);
        const text = buf ? await extractPdfText(buf) : '';
        if (text) mediaContext = `[PDF] ${text}`;
      }
    } catch (err) {
      logger.warn({ err }, 'media context extraction failed (ignored)');
    }
  }

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

  while (searchIterations < MAX_SEARCH_ITERATIONS) {
    const q = extractSearchQuery(reply);
    if (!q) break;

    let results = await searchFn(q, { redis: ctx.redis });
    if (!results) break;

    // Web fetch: try to get full content from the top result URL for deeper
    // context. Fire-and-forget — failure is ignored. Accepts ctx.fetch for
    // test injection; falls back to the real webFetch from search.js.
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

    // Append the search results as a new user message so the model can use them.
    messages.push({
      role: 'user',
      content: `[HASIL PENCARIAN]\n${results}\n\nGunakan hasil di atas untuk menjawab.`,
    });

    try {
      reply = await chatFn(messages, {
        options: { num_ctx: isGroup ? 8192 : 4096 },
      });
    } catch (err) {
      logger.error({ err }, 'LLM search follow-up failed');
      break;
    }

    searchIterations++;
  }

  // Strip any remaining [SEARCH: ...] tokens so the user never sees them.
  reply = stripSearchTokens(reply);

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
  reply = naturalizeReply(reply);
  reply = guardLaughs(reply, { max: araRecentLaughed ? 0 : 1 });

  // Send entire reply as a single bubble. Short replies (typical Ara output)
  // stay compact; long replies are only split by the chunking layer if they
  // exceed WhatsApp's message size limit (1800 chars default).
  let deliveryFailed = false;
  const delivery = await sendChunks(ctx.sock, userId, reply, {
    sendMessage: ctx.sock?.sendMessage?.bind(ctx.sock),
  });
  if (delivery.ids) delivery.ids.forEach(trackBotMessage);
  if (delivery.failed) {
    deliveryFailed = true;
    logger.warn({ delivery }, 'sendChunks failed');
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
