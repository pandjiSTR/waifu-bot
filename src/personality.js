import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PERSONA_KEY = 'waifu:persona';
const RULES_KEY = 'waifu:rules';
const PERSONA_FILE = join(__dirname, '..', 'persona.md');
const RULES_FILE = join(__dirname, '..', 'rules.md');
const PERSONA_EXAMPLE = join(__dirname, '..', 'persona.md.example');
const RULES_EXAMPLE = join(__dirname, '..', 'rules.md.example');

// Substitute the {OWNER_NAME} placeholder with the configured display name so
// the LLM sees the real owner name instead of the literal token.
export function applyOwnerName(text) {
  return String(text ?? '').replaceAll('{OWNER_NAME}', process.env.OWNER_NAME || 'Owner');
}

/**
 * Internal: load content from file → example file → Redis cache.
 * Returns the raw content string (without owner name substitution).
 * Redis is seeded from file/example if available (cache self-heals).
 */
async function _loadContent(filePath, examplePath, redisKey, label, redis) {
  // File is the source of truth. Prefer it and reseed the Redis cache from
  // it so edits take effect on the next start (cache self-heals).
  // Fall back to the cache only if the file is unreadable/empty.
  let content = '';

  // 1. Try primary file
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    logger.warn({ err }, `Failed to read ${label} file (${filePath}), trying .example fallback`);
  }

  if (content && content.trim()) {
    if (redis) {
      await redis.set(redisKey, content).catch(() => {});
    }
    return content;
  }

  // 2. Try example file (useful on fresh deploy where .md is git-committed but may be absent)
  try {
    content = await readFile(examplePath, 'utf-8');
    logger.info(`${label} loaded from ${examplePath} fallback`);
  } catch {
    // silence — example file might not exist either
  }

  if (content && content.trim()) {
    if (redis) {
      await redis.set(redisKey, content).catch(() => {});
    }
    return content;
  }

  // 3. Try Redis cache as last resort
  if (redis) {
    try {
      const cached = await redis.get(redisKey);
      if (cached) {
        logger.info(`${label} loaded from Redis (cache fallback)`);
        return cached;
      }
    } catch {
      // silence
    }
  }

  logger.warn(`${label} content is empty in both file and Redis`);
  return '';
}

/**
 * Load persona content from persona.md:
 * 1. Read persona.md from disk
 * 2. Fallback to persona.md.example
 * 3. Fallback to Redis cache (waifu:persona)
 *
 * Seeds Redis from file so edits take effect on next start.
 */
export async function loadPersonality(redis) {
  try {
    const content = await _loadContent(PERSONA_FILE, PERSONA_EXAMPLE, PERSONA_KEY, 'Persona', redis);
    return content ? applyOwnerName(content) : '';
  } catch (err) {
    logger.error({ err }, 'Failed to load persona');
    return '';
  }
}

/**
 * Load rules content from rules.md:
 * 1. Read rules.md from disk
 * 2. Fallback to rules.md.example
 * 3. Fallback to Redis cache (waifu:rules)
 *
 * Seeds Redis from file so edits take effect on next start.
 */
export async function loadRules(redis) {
  try {
    const content = await _loadContent(RULES_FILE, RULES_EXAMPLE, RULES_KEY, 'Rules', redis);
    return content ? applyOwnerName(content) : '';
  } catch (err) {
    logger.error({ err }, 'Failed to load rules');
    return '';
  }
}

/**
 * Get the current persona content from Redis key waifu:persona.
 * Returns empty string if unavailable.
 */
export async function getPersonalityContent(redis) {
  if (!redis) return '';
  try {
    const content = await redis.get(PERSONA_KEY);
    return content ? applyOwnerName(content) : '';
  } catch (err) {
    logger.error({ err }, 'Failed to get persona from Redis');
    return '';
  }
}

/**
 * Get the current rules content from Redis key waifu:rules.
 * Returns empty string if unavailable.
 */
export async function getRulesContent(redis) {
  if (!redis) return '';
  try {
    const content = await redis.get(RULES_KEY);
    return content ? applyOwnerName(content) : '';
  } catch (err) {
    logger.error({ err }, 'Failed to get rules from Redis');
    return '';
  }
}

/**
 * Save persona content to Redis key waifu:persona.
 */
export async function savePersonality(redis, content) {
  if (!redis) {
    logger.warn('Redis unavailable — persona not saved');
    return;
  }
  try {
    await redis.set(PERSONA_KEY, content);
    logger.info('Persona saved to Redis');
  } catch (err) {
    logger.error({ err }, 'Failed to save persona to Redis');
    throw err;
  }
}

/**
 * Save rules content to Redis key waifu:rules.
 */
export async function saveRules(redis, content) {
  if (!redis) {
    logger.warn('Redis unavailable — rules not saved');
    return;
  }
  try {
    await redis.set(RULES_KEY, content);
    logger.info('Rules saved to Redis');
  } catch (err) {
    logger.error({ err }, 'Failed to save rules to Redis');
    throw err;
  }
}

/**
 * Build the full system prompt by combining:
 * - Persona content (the base identity)
 * - Rules content (anti-robotik behavioral rules, optional)
 * - Memory section: known facts (string[]) about the user and current mood (string)
 * - Recent conversation context (if provided)
 *
 * Each section is separated by clear markers for the LLM to parse.
 * facts is expected as string[] (legacy string treated as empty array).
 * mood is expected as a string.
 */
export async function buildSystemPrompt(redis, context = '', facts = '', mood = '') {
  let persona = '';
  try {
    persona = await getPersonalityContent(redis);
    persona = applyOwnerName(persona);

    const rules = await getRulesContent(redis);
    const rulesStr = rules ? applyOwnerName(rules) : '';

    const sections = [];

    // Core persona — always first
    sections.push(
      `[SYSTEM: Persona]\n${persona || '(no personality loaded)'}`
    );

    // Rules — only if non-empty
    if (rulesStr) {
      sections.push(`[SYSTEM: Rules]\n${rulesStr}`);
    }

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
    return persona || '';
  }
}
