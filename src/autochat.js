import pino from 'pino';
import { normalizeNumber, getOwnerNumbers } from './util.js';
import { buildSystemPrompt } from './personality.js';
import { chat } from './llm.js';
import { getWindow, addMessage } from './context.js';
import { isOpen } from './circuit.js';
import { naturalizeReply, guardLaughs } from './naturalize.js';
import { sendChunks } from './chunks.js';
import { createTypingPulse } from './dispatch.js';

const logger = pino({ name: 'autochat', level: process.env.LOG_LEVEL || 'warn' });

const AUTO_CHAT_INTERVAL_MS = parseInt(
  process.env.AUTO_CHAT_INTERVAL_MS || '3600000',
  10,
);
const MIN_GAP_MS = parseInt(
  process.env.AUTO_CHAT_MIN_GAP_MS || String(3 * 60 * 60 * 1000),
  10,
); // 3 hours (overridable via AUTO_CHAT_MIN_GAP_MS)
const PROBABILITY = 0.4; // 40 % chance per tick to spread messages out

// ── Toggle helpers ──

/**
 * Check whether auto-chat is enabled in Redis.
 * Returns false when redis is null or on any error (never throws).
 *
 * @param {object|null} redis
 * @returns {Promise<boolean>}
 */
export async function isAutoChatEnabled(redis) {
  if (!redis) return false;
  try {
    const val = await redis.get('waifu:autochat:enabled');
    return val === '1';
  } catch (err) {
    logger.warn({ err }, 'isAutoChatEnabled failed');
    return false;
  }
}

/**
 * Enable or disable auto-chat in Redis.
 * No-op when redis is null.
 *
 * @param {object|null} redis
 * @param {boolean} enabled
 */
export async function setAutoChat(redis, enabled) {
  if (!redis) return;
  try {
    await redis.set('waifu:autochat:enabled', enabled ? '1' : '0');
  } catch (err) {
    logger.warn({ err }, 'setAutoChat failed');
  }
}

// ── Proactive message logic ──

/**
 * Optionally send one proactive message to the owner.
 *
 * Guards:
 *  - Auto-chat disabled -> return
 *  - Circuit breaker open -> return
 *  - Outside 08:00-22:00 WIB -> return
 *  - Min gap (3 hours) not elapsed -> return
 *  - Probability gate (40 %) not passed -> return
 *
 * @param {{redis:object|null, sock:object|null, chat?:Function, sendChunks?:Function}} ctx
 * @returns {Promise<void>}
 */
export async function maybeProactive(ctx) {
  const { redis, sock } = ctx;

  // Guard 1: auto-chat must be enabled
  if (!(await isAutoChatEnabled(redis))) return;

  // Guard 2: circuit breaker must not be open
  if (isOpen()) {
    logger.warn('circuit open — skipping proactive message');
    return;
  }

  // Guard 3: time window 08:00-22:00 WIB (PRD §5.5)
  {
    const testNow = ctx._testNow;
    const now = testNow || new Date();
    const hour = (now.getUTCHours() + 7) % 24;
    if (hour < 8 || hour >= 22) {
      return; // silently skip — outside waking hours
    }
  }

  // Guard 4: min gap check (3 hours since last auto-chat)
  if (redis) {
    try {
      const last = await redis.get('waifu:autochat:last');
      if (last) {
        const elapsed = Date.now() - parseInt(last, 10);
        if (elapsed < MIN_GAP_MS) return;
      }
    } catch (err) {
      logger.warn({ err }, 'failed to check autochat last timestamp');
    }
  }

  // Guard 5: probability gate (~40 %)
  if (Math.random() > PROBABILITY) return;

  const ownerDigits = getOwnerNumbers()[0];
  if (!ownerDigits || !sock) return;

  const ownerJid = ownerDigits + '@s.whatsapp.net';

  try {
    // Build recent context from the owner's private window.
    const window = await getWindow(redis, ownerJid, false);
    const recentContext = window
      .map((m) =>
        m.sender === '__summary__'
          ? '[RINGKASAN]\n' + m.text
          : `${m.sender}: ${m.text}`,
      )
      .join('\n');

    const sys = await buildSystemPrompt(redis, recentContext, '', '');

    // Task instruction (not persona voice — just the behavior prompt).
    const taskInstruction =
      'Kirim SATU pesan proaktif singkat kepada owner seolah Ara memulai obrolan. ' +
      '1-3 kata, natural ala WA Indonesia, tanpa emoji. ' +
      'Jangan mulai dengan hai/halo. Jangan tanya soal skripsi/jurnal/tugas kuliah. ' +
      '1 kalimat aja.';

    const chatFn = ctx.chat || chat;
    const text = await chatFn(
      [
        { role: 'system', content: sys + '\n\n' + taskInstruction },
        { role: 'user', content: 'mulai obrolan sekarang' },
      ],
      { options: { num_ctx: 4096 } },
    );

    if (text) {
      const chunksFn = ctx.sendChunks || sendChunks;
      const normalized = guardLaughs(naturalizeReply(text));
      const pulse = createTypingPulse((t) => sock?.sendPresenceUpdate?.(t, ownerJid).catch?.(() => {}));
      try {
        await chunksFn(sock, ownerJid, normalized);
      } finally {
        pulse.stop();
      }

      // Save to context so Ara remembers sending this and next tick
      // generates a different message (not repeated).
      await addMessage(redis, ownerJid, {
        sender: 'ara',
        text: normalized,
        timestamp: new Date().toISOString(),
      }, false);

      // Update last-sent timestamp
      if (redis) {
        await redis.set('waifu:autochat:last', String(Date.now()));
      }
    }
  } catch (err) {
    logger.warn({ err }, 'maybeProactive failed');
  }
}

// ── Scheduler ──

/**
 * Start the auto-chat scheduler interval.
 *
 * @param {{redis:object|null, sock:object|null}} opts
 * @returns {{stop:() => void}}
 */
export function startAutoChat({ redis, sock }) {
  if (!sock) {
    logger.warn('No WhatsApp socket — auto-chat scheduler not started');
    return { stop: () => {} };
  }

  // Seed Redis toggle from env on first start only (never overrides existing key).
  // After seeding, dashboard toggles control the Redis key directly.
  if (redis && process.env.AUTO_CHAT_ENABLED !== undefined) {
    redis.get('waifu:autochat:enabled')
      .then((val) => {
        if (val === null) {
          return redis.set(
            'waifu:autochat:enabled',
            process.env.AUTO_CHAT_ENABLED === 'true' ? '1' : '0',
          );
        }
      })
      .catch((err) => logger.warn({ err }, 'failed to seed AUTO_CHAT_ENABLED'));
  }

  const timer = setInterval(() => {
    maybeProactive({ redis, sock }).catch((err) =>
      logger.warn({ err }, 'auto-chat tick failed'),
    );
  }, AUTO_CHAT_INTERVAL_MS);

  logger.info({ intervalMs: AUTO_CHAT_INTERVAL_MS }, 'Auto-chat scheduler started');

  return {
    stop: () => {
      clearInterval(timer);
      logger.info('Auto-chat scheduler stopped');
    },
  };
}
