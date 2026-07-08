import pino from 'pino';
import {
  initAuthCreds,
  makeCacheableSignalKeyStore,
  BufferJSON,
  proto,
} from '@whiskeysockets/baileys';

const logger = pino({ name: 'baileys-auth', level: process.env.LOG_LEVEL || 'warn' });

// Redis keys for the WhatsApp auth state (PRD §7 waifu:auth:*).
const CREDS_KEY = 'waifu:auth:creds';
const KEYS_HASH = 'waifu:auth:keys';

/**
 * Build a baileys AuthenticationState backed by Redis.
 *
 * The WhatsApp session now persists across deploys via Redis instead of local
 * disk (which resets on every Render deploy). Requires a connected Redis client.
 *
 * @param {object} redis  // raw ioredis client (from createRedisClient)
 * @returns {Promise<{ state: {creds:object, keys:object}, saveCreds: () => Promise<void> }>}
 * @throws {Error} when redis is null/falsy (session cannot be persisted)
 */
export async function useRedisAuthState(redis) {
  if (!redis) {
    throw new Error('Redis required for WhatsApp auth state');
  }

  // Load persisted creds, or start fresh.
  let creds;
  try {
    const raw = await redis.get(CREDS_KEY);
    creds = raw ? JSON.parse(raw, BufferJSON.reviver) : initAuthCreds();
  } catch (err) {
    logger.warn({ err }, 'Failed to load creds from Redis — initializing new');
    creds = initAuthCreds();
  }

  // Redis-backed SignalKeyStore (Redis is the source of truth).
  const redisStore = {
    async get(type, ids) {
      const data = {};
      await Promise.all(
        ids.map(async (id) => {
          const field = `${type}:${id}`;
          const raw = await redis.hget(KEYS_HASH, field);
          if (!raw) return;
          let value = JSON.parse(raw, BufferJSON.reviver);
          if (type === 'app-state-sync-key') {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }
          data[id] = value;
        })
      );
      return data;
    },
    async set(data) {
      for (const type of Object.keys(data)) {
        const entries = data[type];
        for (const id of Object.keys(entries)) {
          const field = `${type}:${id}`;
          const value = entries[id];
          if (value) {
            await redis.hset(KEYS_HASH, field, JSON.stringify(value, BufferJSON.replacer));
          } else {
            await redis.hdel(KEYS_HASH, field);
          }
        }
      }
    },
  };

  // Wrap with an in-process cache for speed; Redis remains source of truth.
  const keys = makeCacheableSignalKeyStore(redisStore, logger);

  return {
    state: { creds, keys },
    saveCreds: async () => {
      try {
        await redis.set(CREDS_KEY, JSON.stringify(creds, BufferJSON.replacer));
      } catch (err) {
        logger.error({ err }, 'Failed to save creds to Redis');
        throw err;
      }
    },
  };
}
