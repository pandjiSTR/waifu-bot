import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PERSONALITY_KEY = 'waifu:personality';
const PERSONALITY_FILE = join(__dirname, '..', 'personality.txt');

/**
 * Load personality content:
 * 1. Try Redis key `waifu:personality`
 * 2. Fallback to local `personality.txt` file
 * 3. If both are empty, return an empty string
 *
 * If Redis has no content but file exists, auto-seed Redis with file content.
 */
export async function loadPersonality(redis) {
  try {
    // Try Redis first
    if (redis) {
      const cached = await redis.get(PERSONALITY_KEY);
      if (cached) {
        logger.info('Personality loaded from Redis');
        return cached;
      }
    }

    // Fallback to local file
    const fileContent = await readFile(PERSONALITY_FILE, 'utf-8');
    if (fileContent) {
      logger.info('Personality loaded from local file');

      // Auto-seed Redis if available
      if (redis) {
        await redis.set(PERSONALITY_KEY, fileContent);
        logger.info('Personality seeded to Redis from local file');
      }

      return fileContent;
    }

    logger.warn('Personality content is empty in both Redis and local file');
    return '';
  } catch (err) {
    logger.error({ err }, 'Failed to load personality');
    return '';
  }
}

/**
 * Get the current personality content from Redis.
 * Returns empty string if unavailable.
 */
export async function getPersonalityContent(redis) {
  if (!redis) return '';
  try {
    const content = await redis.get(PERSONALITY_KEY);
    return content || '';
  } catch (err) {
    logger.error({ err }, 'Failed to get personality from Redis');
    return '';
  }
}

/**
 * Save personality content to Redis key `waifu:personality`.
 */
export async function savePersonality(redis, content) {
  if (!redis) {
    logger.warn('Redis unavailable — personality not saved');
    return;
  }
  try {
    await redis.set(PERSONALITY_KEY, content);
    logger.info('Personality saved to Redis');
  } catch (err) {
    logger.error({ err }, 'Failed to save personality to Redis');
    throw err;
  }
}

/**
 * Build the full system prompt by combining:
 * - Personality content (the base persona)
 * - Memory section: known facts (string[]) about the user and current mood (string)
 * - Recent conversation context (if provided)
 *
 * Each section is separated by clear markers for the LLM to parse.
 * facts is expected as string[] (legacy string treated as empty array).
 * mood is expected as a string.
 */
export async function buildSystemPrompt(redis, context = '', facts = '', mood = '') {
  let personality = '';
  try {
    personality = await getPersonalityContent(redis);

    const sections = [];

    // Core personality — always first
    sections.push(
      `[SYSTEM: Persona]\n${personality || '(no personality loaded)'}`
    );

    // Memory section — facts and mood about the user
    let memorySection = '';
    const factsArray = Array.isArray(facts) ? facts : [];
    if (factsArray.length > 0) {
      memorySection += '\n[Yang Ara inget tentang orang ini:]\n' + factsArray.map(f => '- ' + f).join('\n') + '\n';
    }
    if (mood && typeof mood === 'string' && mood.trim()) {
      memorySection += `\n[Mood Ara saat ini ke orang ini: ${mood.trim()}]\n`;
    }
    if (memorySection) {
      sections.push(`[SYSTEM: Memory]${memorySection}`);
    }

    // Conversation context — recent exchanges
    if (context) {
      sections.push(`[SYSTEM: Recent Context]\n${context}`);
    }

    return sections.join('\n\n');
  } catch (err) {
    logger.error({ err }, 'Failed to build system prompt');
    return personality || '';
  }
}
