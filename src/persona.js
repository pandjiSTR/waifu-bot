import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PERSONA_KEY = 'waifu:persona';
const PERSONA_FILE = join(__dirname, '..', 'persona.md');
const RULES_KEY = 'waifu:rules';
const RULES_FILE = join(__dirname, '..', 'rules.md');

export function applyOwnerName(text) {
  return String(text ?? '').replaceAll('{OWNER_NAME}', process.env.OWNER_NAME || 'Owner');
}

export async function loadPersona(redis) {
  try {
    let fileContent = '';
    try {
      fileContent = await readFile(PERSONA_FILE, 'utf-8');
    } catch (err) {
      logger.warn({ err }, 'Failed to read persona.md, falling back to cache');
    }

    if (fileContent && fileContent.trim()) {
      const substituted = applyOwnerName(fileContent);
      if (redis) {
        await redis.set(PERSONA_KEY, substituted).catch(() => {});
      }
      return substituted;
    }

    if (redis) {
      const cached = await redis.get(PERSONA_KEY);
      if (cached) {
        logger.info('Persona loaded from Redis (file fallback)');
        return applyOwnerName(cached);
      }
    }

    logger.warn('Persona content is empty in both file and Redis');
    return '';
  } catch (err) {
    logger.error({ err }, 'Failed to load persona');
    return '';
  }
}

export async function loadRules(redis) {
  try {
    let fileContent = '';
    try {
      fileContent = await readFile(RULES_FILE, 'utf-8');
    } catch (err) {
      logger.warn({ err }, 'Failed to read rules.md, falling back to cache');
    }

    if (fileContent && fileContent.trim()) {
      const substituted = applyOwnerName(fileContent);
      if (redis) {
        await redis.set(RULES_KEY, substituted).catch(() => {});
      }
      return substituted;
    }

    if (redis) {
      const cached = await redis.get(RULES_KEY);
      if (cached) {
        logger.info('Rules loaded from Redis (file fallback)');
        return applyOwnerName(cached);
      }
    }

    logger.warn('Rules content is empty in both file and Redis');
    return '';
  } catch (err) {
    logger.error({ err }, 'Failed to load rules');
    return '';
  }
}

export async function getPersonaContent(redis) {
  if (!redis) return '';
  try {
    const content = await redis.get(PERSONA_KEY);
    return content ? applyOwnerName(content) : '';
  } catch (err) {
    logger.error({ err }, 'Failed to get persona from Redis');
    return '';
  }
}

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

export async function savePersona(redis, content) {
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

export async function buildSystemPrompt(redis, context = '', facts = '', mood = '') {
  let persona = '';
  let rules = '';
  try {
    persona = await getPersonaContent(redis);
    persona = applyOwnerName(persona);
    rules = await getRulesContent(redis);
    rules = applyOwnerName(rules);

    const sections = [];

    sections.push(
      `[SYSTEM: Persona]\n${persona || '(no persona loaded)'}`
    );

    sections.push(
      `[SYSTEM: Rules]\n${rules || '(no rules loaded)'}`
    );

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

    if (context) {
      sections.push(`[SYSTEM: Recent Context]\n${context}`);
    }

    return sections.join('\n\n');
  } catch (err) {
    logger.error({ err }, 'Failed to build system prompt');
    return persona || '';
  }
}
