import { getPersonalityContent, savePersonality } from './personality.js';
import { setBlacklist, setCircuitBreakerEnabled } from './pipeline.js';
import { getConnectionState } from './baileys.js';
import { isAutoChatEnabled, setAutoChat } from './autochat.js';
import { state as cbState, __reset } from './circuit.js';
import { getFriendMemory, setMood, addFact, clearMemory } from './memory.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

/**
 * Helper to send a JSON response.
 */
function json(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * Generate a zero-filled trend array for a given number of days.
 * @param {number} days
 * @returns {Array<{date:string, sent:number, received:number, tokens:number}>}
 */
function emptyTrend(days) {
  const now = new Date();
  const trend = [];
  for (let d = days - 1; d >= 0; d--) {
    const date = new Date(now);
    date.setDate(date.getDate() - d);
    trend.push({ date: date.toISOString().slice(0, 10), sent: 0, received: 0, tokens: 0 });
  }
  return trend;
}

/**
 * Helper to read the full JSON body from a request.
 */
async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
  }
  return JSON.parse(body);
}

// ──────────────────────────────────────────────
// Mock data (static for skeleton phase)
// ──────────────────────────────────────────────

const MOCK_SETTINGS = {
  autoChat: true,
  blacklist: '',
  circuitBreakerEnabled: true,
};

const START_TIME = Date.now();

// ──────────────────────────────────────────────
// Route handlers
// ──────────────────────────────────────────────

/**
 * GET /api/health
 * Public — no auth needed.
 * Returns bot health status (used by UptimeRobot).
 */
export async function handleHealth(req, res) {
  try {
    const state = getConnectionState();
    json(res, 200, {
      status: 'ok',
      uptime: Math.floor((Date.now() - START_TIME) / 1000),
      waSocket: state,
      sessionReady: state === 'connected',
    });
  } catch (err) {
    logger.error({ err }, 'Health handler error');
    json(res, 500, { error: 'Internal server error' });
  }
}

/**
 * GET /api/overview
 * Requires auth.
 * Returns daily stats, error count, model status, last active, circuit breaker state, and friends.
 */
export async function handleOverview(req, res) {
  try {
    if (!req.redis) {
      json(res, 200, { messagesToday:0, errorsToday:0, modelStatus:'unknown', lastActive:'-', circuitBreaker:'unknown', friends:[] });
      return;
    }

    let messagesToday = 0;
    let errorsToday = 0;
    let cbStateData = { open: false, failCount: 0, threshold: 5, cooldownMs: 300000, remainingMs: 0 };
    let friends = [];

    try { cbStateData = cbState(); } catch { /* use defaults */ }
    try {
      if (req.redis) {
        const stats = await req.redis.hgetall('waifu:stats:messages');
        messagesToday = parseInt(stats?.total || '0');
        const friendCounts = await req.redis.hgetall('waifu:stats:friends') || {};
        const entries = Object.entries(friendCounts);
        const sorted = entries.sort((a, b) => b[1] - a[1]);
        friends = sorted.slice(0, 20).map(([number, msgCount]) => ({
          number, msgCount: parseInt(msgCount), name: number
        }));
      }
    } catch (e) { logger.warn({ err: e }, 'overview redis read failed'); }

    json(res, 200, {
      messagesToday,
      errorsToday,
      modelStatus: cbStateData.open ? 'cooldown' : 'normal',
      lastActive: new Date().toISOString(),
      circuitBreaker: cbStateData.open ? 'cooldown' : 'normal',
      friends,
    });
  } catch (err) {
    logger.error({ err }, 'Overview handler error');
    json(res, 500, { error: 'Internal server error' });
  }
}

/**
 * GET /api/friends
 * Requires auth.
 * Returns list of registered friends with their mood, facts, and closeness.
 */
export async function handleGetFriends(req, res) {
  try {
    if (!req.redis) {
      json(res, 200, { friends: [] });
      return;
    }

    let friends = [];
    if (req.redis) {
      const data = await req.redis.hgetall('waifu:stats:friends') || {};
      const sorted = Object.entries(data).sort((a, b) => b[1] - a[1]);
      friends = sorted.map(([number, msgCount]) => ({ number, msgCount: parseInt(msgCount), name: number }));
    }
    json(res, 200, { friends });
  } catch (err) {
    logger.error({ err }, 'Get friends handler error');
    json(res, 500, { error: 'Internal server error' });
  }
}

/**
 * GET /api/personality
 * Requires auth.
 * Returns the current personality text content.
 */
export async function handleGetPersonality(req, res) {
  try {
    const content = await getPersonalityContent(req.redis);
    json(res, 200, { content });
  } catch (err) {
    logger.error({ err }, 'Get personality handler error');
    json(res, 500, { error: 'Internal server error' });
  }
}

/**
 * PUT /api/personality
 * Requires auth.
 * Saves the personality content sent in the request body.
 * Expects: { content: string }
 */
export async function handleUpdatePersonality(req, res) {
  try {
    const body = await readBody(req);
    const { content } = body;

    if (content === undefined || content === null) {
      json(res, 400, { error: 'Field "content" is required' });
      return;
    }

    await savePersonality(req.redis, String(content));
    json(res, 200, { message: 'Personality updated' });
  } catch (err) {
    logger.error({ err }, 'Update personality handler error');
    json(res, 500, { error: 'Internal server error' });
  }
}

/**
 * GET /api/settings
 * Requires auth.
 * Returns current settings (autoChat, blacklist, circuitBreakerEnabled).
 * Reads from waifu:settings:misc JSON blob in Redis, falling back to defaults.
 */
export async function handleGetSettings(req, res) {
  try {
    let settings = { ...MOCK_SETTINGS };

    if (req.redis) {
      try {
        const raw = await req.redis.get('waifu:settings:misc');
        if (raw) {
          settings = { ...settings, ...JSON.parse(raw) };
        }
      } catch (err) {
        logger.warn({ err }, 'Failed to read waifu:settings:misc from Redis');
      }

      // Override autoChat from the dedicated toggle key.
      try {
        settings.autoChat = await isAutoChatEnabled(req.redis);
      } catch (err) {
        logger.warn({ err }, 'Failed to read autochat status');
      }
    }

    json(res, 200, settings);
  } catch (err) {
    logger.error({ err }, 'Get settings handler error');
    json(res, 500, { error: 'Internal server error' });
  }
}

/**
 * PUT /api/settings
 * Requires auth.
 * Updates settings. Expects partial or full settings object.
 * Persists to waifu:settings:misc JSON blob in Redis.
 */
export async function handleUpdateSettings(req, res) {
  try {
    const body = await readBody(req);

    // Read current settings from Redis or start with defaults.
    let current = {};
    if (req.redis) {
      try {
        const raw = await req.redis.get('waifu:settings:misc');
        if (raw) current = JSON.parse(raw);
      } catch (err) {
        logger.warn({ err }, 'Failed to read waifu:settings:misc from Redis');
      }
    }

    // Merge fields from request body.
    if (typeof body.autoChat === 'boolean') {
      current.autoChat = body.autoChat;
      // Keep the dedicated autochat key in sync.
      await setAutoChat(req.redis, body.autoChat);
    }
    if (typeof body.circuitBreakerEnabled === 'boolean') {
      current.circuitBreakerEnabled = body.circuitBreakerEnabled;
      setCircuitBreakerEnabled(body.circuitBreakerEnabled);
    }
    if (body.blacklist !== undefined) {
      current.blacklist = Array.isArray(body.blacklist)
        ? body.blacklist.join(', ')
        : String(body.blacklist);
    }

    // Write back to Redis.
    if (req.redis) {
      await req.redis.set('waifu:settings:misc', JSON.stringify(current));
    }

    // Sync blacklist changes to in-memory list.
    if (typeof body.blacklist !== 'undefined') {
      setBlacklist(body.blacklist);
    }

    json(res, 200, { message: 'Settings updated', settings: current });
  } catch (err) {
    logger.error({ err }, 'Update settings handler error');
    json(res, 500, { error: 'Internal server error' });
  }
}

// ──────────────────────────────────────────────
// Log endpoints
// ──────────────────────────────────────────────

/**
 * GET /api/logs
 * Requires auth.
 * Returns mock log entries.
 */
export async function handleGetLogs(req, res) {
  try {
    if (!req.redis) {
      json(res, 200, { logs: [] });
      return;
    }

    let logs = [];
    if (req.redis) {
      const raw = await req.redis.lrange('waifu:logs', 0, 99);
      logs = raw.map(s => { try { return JSON.parse(s); } catch { return { msg: s }; } });
    }
    json(res, 200, { logs });
  } catch (err) {
    logger.error({ err }, 'Get logs handler error');
    json(res, 500, { error: 'Internal server error' });
  }
}

/**
 * POST /api/logs/clear
 * Requires auth.
 * Clears all log entries (mock).
 */
export async function handleClearLogs(req, res) {
  try {
    if (!req.redis) {
      json(res, 200, { message: 'Logs cleared', cleared: 0 });
      return;
    }

    let cleared = 0;
    if (req.redis) {
      cleared = await req.redis.del('waifu:logs');
    }
    json(res, 200, { message: 'Logs cleared', cleared: Math.max(0, cleared) });
  } catch (err) {
    logger.error({ err }, 'Clear logs handler error');
    json(res, 500, { error: 'Internal server error' });
  }
}

// ──────────────────────────────────────────────
// Chat endpoints
// ──────────────────────────────────────────────

/**
 * GET /api/chat/contacts
 * Requires auth.
 * Returns list of contacts with mood and message counts.
 */
export async function handleGetContacts(req, res) {
  try {
    if (!req.redis) {
      json(res, 200, { contacts: [] });
      return;
    }

    let contacts = [];
    if (req.redis) {
      const keys = await req.redis.keys('waifu:ctx:*');
      const friendCounts = await req.redis.hgetall('waifu:stats:friends') || {};
      for (const key of keys) {
        const number = key.replace('waifu:ctx:', '');
        const msgCount = parseInt(friendCounts[number] || '0');
        contacts.push({ number, name: number, msgCount, mood: { score: 0, label: '-' } });
      }
      contacts.sort((a, b) => b.msgCount - a.msgCount);
    }
    json(res, 200, { contacts });
  } catch (err) {
    logger.error({ err }, 'Get contacts handler error');
    json(res, 500, { error: 'Internal server error' });
  }
}

/**
 * GET /api/chat/context?number=628xxx
 * Requires auth.
 * Returns chat context for a given contact number.
 */
export async function handleGetContext(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const number = url.searchParams.get('number') || '';

    if (!req.redis) {
      json(res, 200, { number, context: [] });
      return;
    }

    let context = [];
    if (req.redis && number) {
      const raw = await req.redis.lrange(`waifu:ctx:${number}`, 0, 49);
      context = raw.map(s => { try { return JSON.parse(s); } catch { return { text: s }; } });
    }
    json(res, 200, { number, context });
  } catch (err) {
    logger.error({ err }, 'Get context handler error');
    json(res, 500, { error: 'Internal server error' });
  }
}

// ──────────────────────────────────────────────
// Debug endpoints
// ──────────────────────────────────────────────

/**
 * GET /api/debug
 * Requires auth.
 * Returns debug diagnostics for circuit breaker, redis, auto-chat, uptime, and Ollama.
 */
export async function handleGetDebug(req, res) {
  try {
    const uptimeSeconds = Math.floor((Date.now() - START_TIME) / 1000);
    const autoChat = req.redis
      ? await req.redis.get('waifu:autochat:enabled').then(v => v === '1').catch(() => false)
      : false;

    json(res, 200, {
      circuitBreaker: (() => { const cb = cbState(); return { status: cb.open ? 'cooldown' : 'normal', ...cb }; })(),
      redis: 'connected',
      autoChat,
      uptime: {
        server: uptimeSeconds,
        session: uptimeSeconds,
      },
      ollama: {
        model: process.env.OLLAMA_MODEL || 'gemma4:31b-cloud',
        timeout: parseInt(process.env.OLLAMA_TIMEOUT_MS || '60000', 10),
      },
      errorsToday: 0,
    });
  } catch (err) {
    logger.error({ err }, 'Get debug handler error');
    json(res, 500, { error: 'Internal server error' });
  }
}

/**
 * POST /api/debug/reset-cb
 * Requires auth.
 * Resets the circuit breaker state.
 */
export async function handleResetCircuitBreaker(req, res) {
  try {
    __reset();
    json(res, 200, {
      message: 'Circuit breaker reset',
      status: 'normal',
      failCount: 0,
    });
  } catch (err) {
    logger.error({ err }, 'Reset circuit breaker handler error');
    json(res, 500, { error: 'Internal server error' });
  }
}

// ──────────────────────────────────────────────
// Analytics endpoints
// ──────────────────────────────────────────────

/**
 * GET /api/analytics/trend?range=7d
 * Requires auth.
 * Returns message trend data for the given range (7d, 30d, or 90d).
 */
export async function handleGetTrend(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const range = url.searchParams.get('range') || '7d';
    const days = range === '30d' ? 30 : range === '90d' ? 90 : 7;

    if (!req.redis) {
      json(res, 200, { range, trend: emptyTrend(days) });
      return;
    }

    // Build skeleton trend array for the requested range
    const trend = [];
    const now = new Date();
    for (let d = days - 1; d >= 0; d--) {
      const date = new Date(now);
      date.setDate(date.getDate() - d);
      const dateStr = date.toISOString().slice(0, 10);
      trend.push({ date: dateStr, sent: 0, received: 0, tokens: 0 });
    }

    // Fill from hourly Redis sorted sets
    if (req.redis) {
      const keys = await req.redis.keys('waifu:stats:hourly:*') || [];
      for (const key of keys) {
        const count = await req.redis.zscore(key, 'msg');
        if (count) {
          const datePart = key.slice('waifu:stats:hourly:'.length).slice(0, 10);
          const entry = trend.find(e => e.date === datePart);
          if (entry) entry.sent += parseInt(count);
        }
      }
    }

    json(res, 200, { range, trend });
  } catch (err) {
    logger.error({ err }, 'Get trend handler error');
    json(res, 500, { error: 'Internal server error' });
  }
}

/**
 * GET /api/analytics/top-friends
 * Requires auth.
 * Returns top friends ranked by message count.
 */
export async function handleGetTopFriends(req, res) {
  try {
    if (!req.redis) {
      json(res, 200, { topFriends: [] });
      return;
    }

    let topFriends = [];
    if (req.redis) {
      const data = await req.redis.hgetall('waifu:stats:friends') || {};
      const sorted = Object.entries(data).sort((a, b) => b[1] - a[1]).slice(0, 20);
      const total = sorted.reduce((s, [, c]) => s + parseInt(c), 0) || 1;
      topFriends = sorted.map(([name, count]) => ({
        name, msgCount: parseInt(count), percentage: Math.round(parseInt(count) / total * 100)
      }));
    }
    json(res, 200, { topFriends });
  } catch (err) {
    logger.error({ err }, 'Get top friends handler error');
    json(res, 500, { error: 'Internal server error' });
  }
}

/**
 * GET /api/analytics/hourly
 * Requires auth.
 * Returns 24-hour message activity distribution.
 */
export async function handleGetHourly(req, res) {
  try {
    if (!req.redis) {
      json(res, 200, { hours: Array.from({length:24}, (_,i)=>({hour:i, count:0})) });
      return;
    }

    const hours = Array.from({ length: 24 }, (_, i) => ({ hour: i, count: 0 }));
    if (req.redis) {
      const keys = await req.redis.keys('waifu:stats:hourly:*') || [];
      for (const key of keys) {
        const hourPart = parseInt(key.replace('waifu:stats:hourly:', '').slice(11, 13)) || 0;
        const count = await req.redis.zscore(key, 'msg');
        if (count && hours[hourPart]) hours[hourPart].count += parseInt(count);
      }
    }
    json(res, 200, { hours });
  } catch (err) {
    logger.error({ err }, 'Get hourly handler error');
    json(res, 500, { error: 'Internal server error' });
  }
}

// ──────────────────────────────────────────────
// Overview-specific endpoints
// ──────────────────────────────────────────────

/**
 * GET /api/overview/today
 * Requires auth.
 * Returns today's overview stats with mock data.
 */
export async function handleGetTodayOverview(req, res) {
  try {
    if (!req.redis) {
      json(res, 200, { today: {messages:0,tokens:0,activeUsers:0,llmCalls:0,autoChat:0}, deltas:{}, status:'no-redis', uptime:Math.floor((Date.now()-START_TIME)/1000), autoChatPct:0 });
      return;
    }

    let stats = { messages: 0, tokens: 0, activeUsers: 0, llmCalls: 0, autoChat: 0 };
    if (req.redis) {
      const m = await req.redis.hgetall('waifu:stats:messages') || {};
      stats.messages = parseInt(m.total || '0');
      const friends = await req.redis.hgetall('waifu:stats:friends') || {};
      stats.activeUsers = Object.keys(friends).length;
      const llmTimes = await req.redis.lrange('waifu:stats:llm_times', 0, -1).catch(() => []);
      stats.llmCalls = llmTimes.length;
    }
    json(res, 200, {
      today: stats,
      deltas: {},
      status: 'normal',
      uptime: Math.floor((Date.now() - START_TIME) / 1000),
      autoChatPct: Math.round(stats.autoChat / Math.max(stats.messages, 1) * 100),
    });
  } catch (err) {
    logger.error({ err }, 'Overview today handler error');
    json(res, 500, { error: 'Internal server error' });
  }
}

/**
 * GET /api/messages?range=7d
 * Requires auth.
 * Returns message data for the last 7 days (mock).
 */
export async function handleGetMessages(req, res) {
  try {
    if (!req.redis) {
      json(res, 200, { days: Array.from({length:7}, (_,i)=>{const d=new Date();d.setDate(d.getDate()-6+i);return {date:d.toISOString().slice(0,10), sent:0,received:0}}) });
      return;
    }

    const days = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      days.push({ date: dateStr, sent: 0, received: 0 });
    }
    if (req.redis) {
      const keys = await req.redis.keys('waifu:stats:hourly:*') || [];
      for (const key of keys) {
        const datePart = key.replace('waifu:stats:hourly:', '').slice(0, 10);
        const day = days.find(d => d.date === datePart);
        if (day) {
          const count = await req.redis.zscore(key, 'msg');
          if (count) day.sent += parseInt(count);
        }
      }
    }
    json(res, 200, { days });
  } catch (err) {
    logger.error({ err }, 'Get messages handler error');
    json(res, 500, { error: 'Internal server error' });
  }
}

// ──────────────────────────────────────────────
// QR / Pairing endpoints
// ──────────────────────────────────────────────

/**
 * GET /api/auth/qr
 * Public (no auth) — returns the current QR code string for WhatsApp pairing,
 * or a 404 if no QR is available yet.
 */
export async function handleGetQR(req, res) {
  try {
    if (!req.redis) {
      json(res, 503, { error: 'Redis unavailable — cannot retrieve QR' });
      return;
    }
    const qr = await req.redis.get('waifu:qr');
    if (qr) {
      json(res, 200, { qr, message: 'Scan this QR code with WhatsApp' });
    } else {
      json(res, 404, { qr: null, message: 'No QR code available yet — wait for connection' });
    }
  } catch (err) {
    logger.error({ err }, 'Get QR handler error');
    json(res, 500, { error: 'Internal server error' });
  }
}

// ──────────────────────────────────────────────
// Friend Memory endpoints
// ──────────────────────────────────────────────

/**
 * GET /api/friends/:userId/memory
 * Requires auth. Returns friend memory for a given userId.
 */
export async function handleGetFriendMemory(req, res) {
  try {
    const userId = req.params?.userId || req.url?.split('/')[3];
    if (!userId) { json(res, 400, { error: 'userId required' }); return; }
    const memory = await getFriendMemory(req.redis, userId);
    json(res, 200, memory);
  } catch (err) {
    logger.error({ err }, 'Get friend memory handler error');
    json(res, 500, { error: 'Internal server error' });
  }
}

/**
 * PUT /api/friends/:userId/memory
 * Requires auth. Updates facts and/or mood for a given userId.
 * Body: { facts?: string[], mood?: string }
 */
export async function handleUpdateFriendMemory(req, res) {
  try {
    const userId = req.params?.userId || req.url?.split('/')[3];
    if (!userId) { json(res, 400, { error: 'userId required' }); return; }

    if (!req.redis) {
      json(res, 200, { message: 'Redis unavailable — memory not written', memory: null });
      return;
    }

    const body = await readBody(req);
    const { facts, mood } = body;

    if (mood) {
      await setMood(req.redis, userId, mood);
    }
    if (Array.isArray(facts)) {
      for (const fact of facts) {
        await addFact(req.redis, userId, fact);
      }
    }

    const updated = await getFriendMemory(req.redis, userId);
    json(res, 200, { message: 'Memory updated', memory: updated });
  } catch (err) {
    logger.error({ err }, 'Update friend memory handler error');
    json(res, 500, { error: 'Internal server error' });
  }
}

/**
 * DELETE /api/friends/:userId/memory
 * Requires auth. Clears all memory for a given userId.
 */
export async function handleClearFriendMemory(req, res) {
  try {
    const userId = req.params?.userId || req.url?.split('/')[3];
    if (!userId) { json(res, 400, { error: 'userId required' }); return; }

    if (!req.redis) {
      json(res, 200, { message: 'Redis unavailable — memory not cleared' });
      return;
    }

    await clearMemory(req.redis, userId);
    json(res, 200, { message: 'Memory cleared for ' + userId });
  } catch (err) {
    logger.error({ err }, 'Clear friend memory handler error');
    json(res, 500, { error: 'Internal server error' });
  }
}

/**
 * Register all API routes onto the provided HTTP router.
 * The router is a simple object with a `routes` array pattern.
 *
 * Each entry: { method, path, handler, authRequired }
 */
export function registerApiRoutes(router, requireAuth) {
  // Public routes (no auth)
  // QR code endpoint (public — needed for pairing before auth)
  router.get('/api/auth/qr', handleGetQR);

  router.get('/api/health', handleHealth);

  // Auth routes (handled separately in index.js but registered here for routing)
  router.post('/api/auth/login', null); // handled by auth module directly
  router.post('/api/auth/logout', null); // handled by auth module directly

  // Protected routes (require auth)
  router.get('/api/overview', requireAuth, handleOverview);
  router.get('/api/friends', requireAuth, handleGetFriends);
  router.get('/api/friends/:userId/memory', requireAuth, handleGetFriendMemory);
  router.put('/api/friends/:userId/memory', requireAuth, handleUpdateFriendMemory);
  router.delete('/api/friends/:userId/memory', requireAuth, handleClearFriendMemory);
  router.get('/api/personality', requireAuth, handleGetPersonality);
  router.put('/api/personality', requireAuth, handleUpdatePersonality);
  router.get('/api/settings', requireAuth, handleGetSettings);
  router.put('/api/settings', requireAuth, handleUpdateSettings);

  // Log routes
  router.get('/api/logs', requireAuth, handleGetLogs);
  router.post('/api/logs/clear', requireAuth, handleClearLogs);

  // Chat routes
  router.get('/api/chat/contacts', requireAuth, handleGetContacts);
  router.get('/api/chat/context', requireAuth, handleGetContext);

  // Debug routes
  router.get('/api/debug', requireAuth, handleGetDebug);
  router.post('/api/debug/reset-cb', requireAuth, handleResetCircuitBreaker);

  // Analytics routes
  router.get('/api/analytics/trend', requireAuth, handleGetTrend);
  router.get('/api/analytics/top-friends', requireAuth, handleGetTopFriends);
  router.get('/api/analytics/hourly', requireAuth, handleGetHourly);

  // Overview-specific endpoints (used by overview page)
  router.get('/api/overview/today', requireAuth, handleGetTodayOverview);

  // Messages endpoint (used by overview page chart)
  router.get('/api/messages', requireAuth, handleGetMessages);

  // Config aliases → map to settings handlers
  router.get('/api/config', requireAuth, handleGetSettings);
  router.put('/api/config', requireAuth, handleUpdateSettings);
}
