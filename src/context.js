import pino from 'pino';
import { summarize } from './llm.js';
import { isOpen } from './circuit.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

const PRIVATE_MAX = parseInt(process.env.MAX_CONTEXT_MESSAGES || '30', 10);
const GROUP_MAX = parseInt(process.env.MAX_GROUP_CONTEXT_MESSAGES || '60', 10);
const GROUP_TTL_S = parseInt(process.env.GROUP_CTX_TTL_DAYS || '7', 10) * 86400;
const PRIVATE_TTL_S = 86400;

// In-memory fallback used when Redis is unavailable (REDIS_URL unset).
// Stores JSON strings, newest-first, mirroring the Redis list layout.
const memWindows = new Map(); // userId -> Array<json string>
const memSummaries = new Map(); // userId -> string

function keyFor(userId, isGroup) {
  return isGroup ? `waifu:grup:${userId}` : `waifu:ctx:${userId}`;
}

function summaryKeyFor(userId, isGroup) {
  return isGroup ? `waifu:grup_summary:${userId}` : `waifu:ctx_summary:${userId}`;
}

function maxFor(isGroup) {
  return isGroup ? GROUP_MAX : PRIVATE_MAX;
}

function ttlFor(isGroup) {
  return isGroup ? GROUP_TTL_S : PRIVATE_TTL_S;
}

/**
 * Internal: return the raw window (newest-first, no synthetic summary entry)
 * from Redis or the in-memory Map. Never throws — degrades to [].
 */
async function getRaw(redis, userId, isGroup) {
  const key = keyFor(userId, isGroup);
  if (redis) {
    try {
      const raw = await redis.lrange(key, 0, -1);
      return raw.map((s) => JSON.parse(s));
    } catch (err) {
      logger.warn({ err, userId }, 'getRaw redis failed');
      return [];
    }
  }
  return (memWindows.get(userId) || []).map((s) => JSON.parse(s));
}

/**
 * Append a message to the sliding window for a chat.
 * @param {object|null} redis  // raw ioredis client or null (from createRedisClient)
 * @param {string} userId      // JID (private sender or group)
 * @param {{sender:string, text:string, timestamp?:string}} msg
 * @param {boolean} [isGroup=false]
 * @returns {Promise<void>}
 */
export async function addMessage(redis, userId, msg, isGroup = false) {
  const item = JSON.stringify({
    sender: msg.sender,
    text: msg.text,
    timestamp: msg.timestamp || new Date().toISOString(),
  });
  const key = keyFor(userId, isGroup);
  const max = maxFor(isGroup);

  if (redis) {
    try {
      await redis.lpush(key, item); // newest at head
      await redis.ltrim(key, 0, max - 1); // keep <= max elements
      if (isGroup) {
        // PRD §7: refresh group TTL on every new message.
        await redis.expire(key, ttlFor(true));
      }
    } catch (err) {
      logger.warn({ err, userId }, 'addMessage redis failed');
    }
    return;
  }

  // In-memory fallback (no Redis).
  const arr = memWindows.get(userId) || [];
  arr.unshift(item); // newest at front
  if (arr.length > max) arr.length = max; // drop oldest
  memWindows.set(userId, arr);
}

/**
 * Replace the most recent message matching `sender` in the sliding window.
 * Used to enrich a user's caption with media context ([GAMBAR]/[PDF]) after the
 * description is extracted, so follow-up turns see it.
 * @param {object|null} redis
 * @param {string} userId
 * @param {string} sender   // e.g. the user's sender id (ctx.sender)
 * @param {string} newText
 * @param {boolean} [isGroup=false]
 * @returns {Promise<void>}
 */
export async function replaceLastMessage(redis, userId, sender, newText, isGroup = false) {
  const key = keyFor(userId, isGroup);
  const max = maxFor(isGroup);

  if (redis) {
    try {
      const raw = await redis.lrange(key, 0, -1); // newest-first
      const idx = raw.findIndex((s) => {
        try {
          return JSON.parse(s).sender === sender;
        } catch {
          return false;
        }
      });
      if (idx === -1) return;
      const old = JSON.parse(raw[idx]);
      raw[idx] = JSON.stringify({ ...old, text: newText });
      await redis.del(key);
      if (raw.length) await redis.rpush(key, raw); // restore oldest-first
      await redis.ltrim(key, 0, max - 1);
      if (isGroup) await redis.expire(key, ttlFor(true));
    } catch (err) {
      logger.warn({ err, userId }, 'replaceLastMessage redis failed');
    }
    return;
  }

  // In-memory fallback
  const arr = memWindows.get(userId) || [];
  for (let i = arr.length - 1; i >= 0; i--) {
    let m;
    try {
      m = JSON.parse(arr[i]);
    } catch {
      continue;
    }
    if (m.sender === sender) {
      arr[i] = JSON.stringify({ ...m, text: newText });
      break;
    }
  }
  memWindows.set(userId, arr);
}

/**
 * Return the sliding window as a CHRONOLOGICAL array (oldest -> newest).
 * Merges the stored summary (if any) as a synthetic leading context entry.
 * @param {object|null} redis
 * @param {string} userId
 * @param {boolean} [isGroup=false]
 * @returns {Promise<Array<{sender:string, text:string, timestamp:string}>>}
 */
export async function getWindow(redis, userId, isGroup = false) {
  const items = (await getRaw(redis, userId, isGroup)).reverse(); // chronological

  // TODO(group-trim): for groups, trim to messages mentioning 'ara'/reply + neighbors.
  // Fase 3 returns the full window (acceptable per PRD §6.2).

  const summary = await getSummary(redis, userId, isGroup);
  if (summary) {
    items.unshift({ sender: '__summary__', text: summary, timestamp: '' });
  }
  return items;
}

/**
 * Return the stored summary string ('' if none).
 * @param {object|null} redis
 * @param {string} userId
 * @param {boolean} [isGroup=false]
 * @returns {Promise<string>}
 */
export async function getSummary(redis, userId, isGroup = false) {
  const key = summaryKeyFor(userId, isGroup);
  if (redis) {
    try {
      const v = await redis.get(key);
      return v || '';
    } catch (err) {
      logger.warn({ err, userId }, 'getSummary redis failed');
      return '';
    }
  }
  return memSummaries.get(userId) || '';
}

/**
 * Fire-and-forget summarization trigger. Call AFTER the reply is delivered.
 * If window length >= max, take the oldest floor(max/2) messages, summarize,
 * merge with prior summary, persist, and drop the summarized raw messages.
 * No-op when window < max. Never throws — failures are logged only.
 * @param {object|null} redis
 * @param {string} userId
 * @param {boolean} [isGroup=false]
 * @returns {Promise<void>}
 */
export async function summarizeContext(redis, userId, isGroup = false) {
  // Summarization is OFF by default; opt in via ENABLE_CONTEXT_SUMMARY=true.
  // Keeps latency low and avoids extra LLM calls unless explicitly enabled.
  if (process.env.ENABLE_CONTEXT_SUMMARY === 'false') return;

  // Distributed lock: prevent concurrent summarization for the same user.
  // If another process already holds the lock, skip this turn.
  const lockKey = `waifu:sum_lock:${userId}`;
  if (redis) {
    const acquired = await redis.set(lockKey, '1', 'EX', 30, 'NX');
    if (!acquired) return;
  }

  try {
    // Fase 5 (§6.3): do not summarize while the circuit breaker is open —
    // history simply accumulates until the LLM is healthy again (non-fatal).
    if (isOpen()) return;
    const raw = await getRaw(redis, userId, isGroup); // newest-first
    const max = maxFor(isGroup);
    if (raw.length < max) return;

    const take = Math.floor(max / 2); // 15 private / 25 group
    const oldestRaw = raw.slice(raw.length - take); // oldest `take`
    const text = oldestRaw.map((m) => `${m.sender}: ${m.text}`).join('\n');

    const prev = await getSummary(redis, userId, isGroup);
    const newSummary = await summarize(
      `${prev ? prev + '\n' : ''}${text}`,
      { maxSentences: 3 }
    );

    const summaryKey = summaryKeyFor(userId, isGroup);
    const ttl = ttlFor(isGroup);
    if (redis) {
      await redis.set(summaryKey, newSummary, 'EX', ttl);
      // Keep the newer half (drop the oldest `take`).
      await redis.ltrim(keyFor(userId, isGroup), 0, max - 1 - take);
    } else {
      memSummaries.set(userId, newSummary);
      const arr = memWindows.get(userId) || [];
      // arr is newest-first; drop `take` oldest from the tail.
      memWindows.set(userId, arr.slice(0, Math.max(0, arr.length - take)));
    }

    // Release the distributed lock so other turns can summarise.
    if (redis) {
      await redis.del(lockKey).catch(() => {});
    }
  } catch (err) {
    logger.warn({ err, userId }, 'summarizeContext failed');
  }
}
