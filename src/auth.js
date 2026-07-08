import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

const JWT_SECRET = process.env.JWT_SECRET;
const PASSWORD_HASH = process.env.DASHBOARD_PASSWORD_HASH;
const COOKIE_NAME = 'ara_session';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

/**
 * Validate that required auth env vars are set.
 * Called once on startup to fail fast.
 */
export function validateAuthConfig() {
  if (!JWT_SECRET) {
    throw new Error('JWT_SECRET environment variable is required');
  }
  if (!PASSWORD_HASH) {
    throw new Error('DASHBOARD_PASSWORD_HASH environment variable is required');
  }
}

/**
 * Parse cookies from a raw Cookie header string.
 * Returns a plain object { name: value }.
 */
function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach((pair) => {
    const [rawName, ...rest] = pair.trim().split('=');
    const name = rawName?.trim();
    const value = rest.join('=').trim();
    if (name) cookies[name] = decodeURIComponent(value);
  });
  return cookies;
}

/**
 * POST /api/auth/login
 * Expects JSON body: { password: string }
 * On success: sets httpOnly JWT cookie and returns 200.
 * On failure: returns 401.
 */
export async function handleLogin(req, res) {
  try {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const { password } = parsed;
    if (!password) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Password is required' }));
      return;
    }

    // Rate limiting (best-effort, skip if Redis unavailable — P4 fix)
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    const LIMIT_KEY = `waifu:login_fail:${ip}`;
    const LIMIT_MAX = 15;
    const LIMIT_TTL = 900; // 15 minutes in seconds
    let attempts = null;
    if (req.redis) {
      attempts = await req.redis.get(LIMIT_KEY);
      if (attempts && parseInt(attempts, 10) >= LIMIT_MAX) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Too many attempts — coba lagi nanti' }));
        return;
      }
    }

    const isValid = await bcrypt.compare(password, PASSWORD_HASH);
    if (!isValid) {
      // Increment failure counter; set TTL on first failure.
      if (req.redis) {
        await req.redis.incr(LIMIT_KEY);
        if (parseInt(attempts || '0', 10) === 0) await req.redis.expire(LIMIT_KEY, LIMIT_TTL);
      }
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid password' }));
      return;
    }

    const token = jwt.sign(
      { role: 'owner', iat: Math.floor(Date.now() / 1000) },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Successful login: clear any accumulated failure counter.
    if (req.redis) {
      await req.redis.del(LIMIT_KEY);
    }

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': [
        `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax`,
      ],
    });
    res.end(JSON.stringify({ message: 'Login successful', token }));
  } catch (err) {
    logger.error({ err }, 'Login handler error');
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

/**
 * POST /api/auth/logout
 * Clears the JWT cookie by setting Max-Age=0.
 */
export async function handleLogout(req, res) {
  try {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': [
        `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`,
      ],
    });
    res.end(JSON.stringify({ message: 'Logged out' }));
  } catch (err) {
    logger.error({ err }, 'Logout handler error');
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

/**
 * Middleware: requireAuth
 * Verifies JWT from the cookie. On success, attaches decoded payload to req.user
 * and calls next(). On failure, returns 401.
 */
export function requireAuth(req, res, next) {
  try {
    let token = null;

    // Try Authorization header first (Bearer token from SPA)
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    }

    // Fallback to cookie (for browser-based requests)
    if (!token) {
      const cookies = parseCookies(req.headers.cookie);
      token = cookies[COOKIE_NAME];
    }

    if (!token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Authentication required' }));
      return;
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session expired' }));
      return;
    }

    logger.warn({ err }, 'JWT verification failed');
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid token' }));
  }
}
