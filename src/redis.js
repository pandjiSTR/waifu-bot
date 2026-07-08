import Redis from 'ioredis';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

let client = null;

/**
 * Create (or return existing) Redis client from REDIS_URL env.
 * The client is reused across the app lifecycle.
 */
export function createRedisClient() {
  if (client) return client;

  const url = process.env.REDIS_URL;
  if (!url) {
    logger.warn('REDIS_URL not set — Redis client will be null');
    return null;
  }

  client = new Redis(url, {
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      if (times > 5) {
        logger.error('Redis max retries reached — giving up');
        return null;
      }
      return Math.min(times * 200, 3000);
    },
    lazyConnect: true,
  });

  client.on('error', (err) => {
    logger.error({ err }, 'Redis connection error');
  });

  client.on('connect', () => {
    logger.info('Redis connected');
  });

  client.on('close', () => {
    logger.warn('Redis connection closed');
  });

  return client;
}

/**
 * Get a Redis key value.
 */
export async function get(key) {
  if (!client) return null;
  try {
    return await client.get(key);
  } catch (err) {
    logger.error({ err, key }, 'Redis GET failed');
    return null;
  }
}

/**
 * Set a Redis key with optional TTL (in seconds).
 */
export async function set(key, value, ttlSeconds = null) {
  if (!client) return;
  try {
    if (ttlSeconds) {
      await client.setex(key, ttlSeconds, value);
    } else {
      await client.set(key, value);
    }
  } catch (err) {
    logger.error({ err, key }, 'Redis SET failed');
  }
}

/**
 * Get all fields of a hash.
 */
export async function hgetall(key) {
  if (!client) return {};
  try {
    return await client.hgetall(key);
  } catch (err) {
    logger.error({ err, key }, 'Redis HGETALL failed');
    return {};
  }
}

/**
 * Set a hash field.
 */
export async function hset(key, field, value) {
  if (!client) return;
  try {
    await client.hset(key, field, value);
  } catch (err) {
    logger.error({ err, key, field }, 'Redis HSET failed');
  }
}

/**
 * Push value to the head of a list.
 */
export async function lpush(key, value) {
  if (!client) return;
  try {
    await client.lpush(key, value);
  } catch (err) {
    logger.error({ err, key }, 'Redis LPUSH failed');
  }
}

/**
 * Get a range of list elements.
 */
export async function lrange(key, start, stop) {
  if (!client) return [];
  try {
    return await client.lrange(key, start, stop);
  } catch (err) {
    logger.error({ err, key }, 'Redis LRANGE failed');
    return [];
  }
}

/**
 * Trim a list to the specified range.
 */
export async function ltrim(key, start, stop) {
  if (!client) return;
  try {
    await client.ltrim(key, start, stop);
  } catch (err) {
    logger.error({ err, key }, 'Redis LTRIM failed');
  }
}

/**
 * Add a member to a set.
 */
export async function sadd(key, member) {
  if (!client) return;
  try {
    await client.sadd(key, member);
  } catch (err) {
    logger.error({ err, key }, 'Redis SADD failed');
  }
}

/**
 * Get all members of a set.
 */
export async function smembers(key) {
  if (!client) return [];
  try {
    return await client.smembers(key);
  } catch (err) {
    logger.error({ err, key }, 'Redis SMEMBERS failed');
    return [];
  }
}

/**
 * Delete one or more keys.
 */
export async function del(...keys) {
  if (!client) return;
  try {
    await client.del(...keys);
  } catch (err) {
    logger.error({ err, keys }, 'Redis DEL failed');
  }
}

/**
 * Check if a key exists.
 */
export async function exists(key) {
  if (!client) return false;
  try {
    const result = await client.exists(key);
    return result === 1;
  } catch (err) {
    logger.error({ err, key }, 'Redis EXISTS failed');
    return false;
  }
}

/**
 * Get the length of a list.
 */
export async function llen(key) {
  if (!client) return 0;
  try {
    return await client.llen(key);
  } catch (err) {
    logger.error({ err, key }, 'Redis LLEN failed');
    return 0;
  }
}

/**
 * Set a TTL (in seconds) on a key.
 * Null-safe: returns false when no client is configured.
 * @param {string} key
 * @param {number} seconds
 * @returns {Promise<boolean>} true on success, false when client is null or on error
 */
export async function expire(key, seconds) {
  if (!client) return false;
  try {
    await client.expire(key, seconds);
    return true;
  } catch (err) {
    logger.error({ err, key }, 'Redis EXPIRE failed');
    return false;
  }
}

/**
 * Close the Redis connection gracefully.
 */
export async function closeRedis() {
  if (!client) return;
  try {
    await client.quit();
    client = null;
    logger.info('Redis connection closed gracefully');
  } catch (err) {
    logger.error({ err }, 'Error closing Redis');
  }
}

export default {
  createRedisClient,
  get,
  set,
  hgetall,
  hset,
  lpush,
  lrange,
  ltrim,
  sadd,
  smembers,
  del,
  exists,
  llen,
  expire,
  closeRedis,
};
