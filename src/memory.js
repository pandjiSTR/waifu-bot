// Friend memory storage layer — per-user facts + mood stored as JSON in Redis.
// Each user's memory is at key waifu:friend:{userId}.
// All functions are null-safe (redis === null → no-op), never throw, and log
// errors via pino at warn level.

import pino from 'pino';

const logger = pino({ name: 'memory', level: process.env.LOG_LEVEL || 'warn' });

const KEY_PREFIX = 'waifu:friend:';

function keyFor(userId) {
  return `${KEY_PREFIX}${userId}`;
}

function defaults() {
  return { facts: [], mood: null, moodUpdatedAt: null };
}

/**
 * Read the stored memory for a user.
 * @param {object|null} redis  — ioredis-like client, or null (returns defaults)
 * @param {string} userId
 * @returns {Promise<{ facts: string[], mood: string|null, moodUpdatedAt: number|null }>}
 */
export async function getFriendMemory(redis, userId) {
  if (!redis) return defaults();

  try {
    const raw = await redis.get(keyFor(userId));
    if (!raw) return defaults();

    const data = JSON.parse(raw);
    return {
      facts: Array.isArray(data.facts) ? data.facts : [],
      mood: typeof data.mood === 'string' ? data.mood : null,
      moodUpdatedAt: typeof data.moodUpdatedAt === 'number' ? data.moodUpdatedAt : null,
    };
  } catch (err) {
    logger.warn({ err, userId }, 'getFriendMemory failed');
    return defaults();
  }
}

/**
 * Add a fact text to the user's fact list (skipping case-insensitive duplicates).
 * Caps at 50 facts (FIFO: oldest removed first).
 * @param {object|null} redis
 * @param {string} userId
 * @param {string} factText
 * @returns {Promise<number>} updated fact count
 */
export async function addFact(redis, userId, factText) {
  if (!redis) return 0;

  try {
    const memory = await getFriendMemory(redis, userId);
    const lower = factText.toLowerCase();

    if (!memory.facts.some((f) => f.toLowerCase() === lower)) {
      memory.facts.push(factText);
      if (memory.facts.length > 50) {
        memory.facts.shift();
      }
    }

    await redis.set(keyFor(userId), JSON.stringify(memory));
    return memory.facts.length;
  } catch (err) {
    logger.warn({ err, userId }, 'addFact failed');
    return 0;
  }
}

/**
 * Set the user's mood text and update the moodUpdatedAt timestamp.
 * @param {object|null} redis
 * @param {string} userId
 * @param {string} moodText
 * @returns {Promise<void>}
 */
export async function setMood(redis, userId, moodText) {
  if (!redis) return;

  try {
    const memory = await getFriendMemory(redis, userId);
    memory.mood = moodText;
    memory.moodUpdatedAt = Date.now();
    await redis.set(keyFor(userId), JSON.stringify(memory));
  } catch (err) {
    logger.warn({ err, userId }, 'setMood failed');
  }
}

/**
 * Delete a fact by index (number) or by exact text match (string).
 * No-op if the index/text doesn't exist.
 * @param {object|null} redis
 * @param {string} userId
 * @param {number|string} indexOrText
 * @returns {Promise<void>}
 */
export async function deleteFact(redis, userId, indexOrText) {
  if (!redis) return;

  try {
    const memory = await getFriendMemory(redis, userId);

    if (typeof indexOrText === 'number') {
      if (indexOrText >= 0 && indexOrText < memory.facts.length) {
        memory.facts.splice(indexOrText, 1);
      }
    } else if (typeof indexOrText === 'string') {
      const idx = memory.facts.findIndex((f) => f === indexOrText);
      if (idx !== -1) {
        memory.facts.splice(idx, 1);
      }
    }

    await redis.set(keyFor(userId), JSON.stringify(memory));
  } catch (err) {
    logger.warn({ err, userId }, 'deleteFact failed');
  }
}

/**
 * Wipe all stored memory for a user (DEL the key).
 * @param {object|null} redis
 * @param {string} userId
 * @returns {Promise<void>}
 */
export async function clearMemory(redis, userId) {
  if (!redis) return;

  try {
    await redis.del(keyFor(userId));
  } catch (err) {
    logger.warn({ err, userId }, 'clearMemory failed');
  }
}
