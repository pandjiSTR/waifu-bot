import { createServer } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { createRedisClient, closeRedis } from './src/redis.js';
import { validateAuthConfig, handleLogin, handleLogout, requireAuth } from './src/auth.js';
import { loadPersonality } from './src/personality.js';
import { loadBlacklist } from './src/gatekeeper.js';
import { setCircuitBreakerEnabled } from './src/pipeline.js';
import { initWhatsApp } from './src/baileys.js';
import { startAutoChat } from './src/autochat.js';
import {
  handleHealth,
  handleOverview,
  handleGetFriends,
  handleGetPersonality,
  handleUpdatePersonality,
  handleGetSettings,
  handleUpdateSettings,
  registerApiRoutes,
} from './src/api-skeleton.js';

// ──────────────────────────────────────────────
// Setup
// ──────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });
const PORT = parseInt(process.env.PORT || '10000', 10);
const DASHBOARD_DIR = join(__dirname, 'dashboard');

// ──────────────────────────────────────────────
// MIME types for static file serving
// ──────────────────────────────────────────────

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

// ──────────────────────────────────────────────
// Simple router
// ──────────────────────────────────────────────

class Router {
  constructor() {
    this.routes = [];
  }

  get(path, ...handlers) {
    this.routes.push({ method: 'GET', path, handlers: handlers.filter(Boolean) });
  }

  post(path, ...handlers) {
    this.routes.push({ method: 'POST', path, handlers: handlers.filter(Boolean) });
  }

  put(path, ...handlers) {
    this.routes.push({ method: 'PUT', path, handlers: handlers.filter(Boolean) });
  }

  delete(path, ...handlers) {
    this.routes.push({ method: 'DELETE', path, handlers: handlers.filter(Boolean) });
  }

  /**
   * Match a request to a route.
   * Returns { params, handlers } or null.
   */
  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;

      // Exact match
      if (route.path === pathname) {
        return { params: {}, handlers: route.handlers };
      }

      // Parametric route — split both into segments
      const routeParts = route.path.split('/');
      const pathParts = pathname.split('/');
      if (routeParts.length !== pathParts.length) continue;

      const params = {};
      let matched = true;
      for (let i = 0; i < routeParts.length; i++) {
        if (routeParts[i].startsWith(':')) {
          params[routeParts[i].slice(1)] = pathParts[i];
        } else if (routeParts[i] !== pathParts[i]) {
          matched = false;
          break;
        }
      }

      if (matched) {
        return { params, handlers: route.handlers };
      }
    }
    return null;
  }
}

// ──────────────────────────────────────────────
// Static file serving
// ──────────────────────────────────────────────

const CACHE_MAX_AGE = 60 * 60; // 1 hour

async function serveStatic(res, filePath) {
  try {
    const ext = extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // Check file exists and is within the dashboard directory (security)
    const normalizedPath = join(filePath);
    if (!normalizedPath.startsWith(DASHBOARD_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const content = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': `public, max-age=${CACHE_MAX_AGE}`,
    });
    res.end(content);
  } catch (err) {
    logger.error({ err, filePath }, 'Static file serve error');
    res.writeHead(500);
    res.end('Internal server error');
  }
}

// ──────────────────────────────────────────────
// SPA fallback: serve index.html for non-API routes
// ──────────────────────────────────────────────

async function serveSPAFallback(res) {
  const indexPath = join(DASHBOARD_DIR, 'index.html');
  try {
    if (!existsSync(indexPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Dashboard not built yet. Run "npm run build" first.');
      return;
    }
    const content = await readFile(indexPath, 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(content);
  } catch (err) {
    logger.error({ err }, 'SPA fallback error');
    res.writeHead(500);
    res.end('Internal server error');
  }
}

// ──────────────────────────────────────────────
// CORS headers helper
// ──────────────────────────────────────────────

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

// ──────────────────────────────────────────────
// Create the server
// ──────────────────────────────────────────────

export async function main() {
  // Validate config on startup
  try {
    validateAuthConfig();
  } catch (err) {
    logger.error({ err }, 'Auth config validation failed');
    process.exit(1);
  }

  // Init Redis
  let redis = createRedisClient();
  if (redis) {
    try {
      await redis.connect();
    } catch (err) {
      logger.error({ err }, 'Failed to connect to Redis — running without cache');
      redis = null; // P3 fix: prevent handlers from using a disconnected client
    }
  }

  // Load blacklist from Redis (falls back to env)
  await loadBlacklist(redis);

  // Load circuit breaker toggle from settings
  if (redis) {
    try {
      const raw = await redis.get('waifu:settings:misc');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (typeof parsed.circuitBreakerEnabled === 'boolean') {
          setCircuitBreakerEnabled(parsed.circuitBreakerEnabled);
        }
      }
    } catch (e) {
      logger.warn({ err: e }, 'Failed to load circuitBreakerEnabled');
    }
  }

  // Preload personality into Redis cache
  await loadPersonality(redis);

  // Start WhatsApp (best-effort; degrades gracefully if it fails).
  let wa = { sock: null, stop: async () => {} };
  try {
    wa = await initWhatsApp(redis);
  } catch (err) {
    logger.error({ err }, 'WhatsApp init failed — continuing without WA');
  }

  // ── Start auto-chat scheduler ────────────
  let autoChat = { stop: () => {} };
  if (wa.sock) {
    autoChat = startAutoChat({ redis, sock: wa.sock });
  } else {
    logger.warn('WhatsApp not available — auto-chat scheduler not started');
  }

  // ── Setup routes ──────────────────────────
  const router = new Router();

  // Public API routes
  router.get('/api/health', handleHealth);
  router.post('/api/auth/login', handleLogin);
  router.post('/api/auth/logout', handleLogout);

  // Protected API routes — requireAuth middleware applied
  router.get('/api/overview', requireAuth, handleOverview);
  router.get('/api/friends', requireAuth, handleGetFriends);
  router.get('/api/personality', requireAuth, handleGetPersonality);
  router.put('/api/personality', requireAuth, handleUpdatePersonality);
  router.get('/api/settings', requireAuth, handleGetSettings);
  router.put('/api/settings', requireAuth, handleUpdateSettings);

  // Register additional API routes (logs, chat, debug, analytics, overview/today, messages, config)
  registerApiRoutes(router, requireAuth);

  // ── Create HTTP server ────────────────────
  const server = createServer(async (req, res) => {
    setCorsHeaders(res);

    // Handle OPTIONS (preflight)
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // HEAD: handled above (204 early return); below is GET/POST only

    // Parse URL
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    try {
      // ── API routes ────────────────────────
      if (pathname.startsWith('/api/')) {
        // Inject redis into request for handlers to use
        req.redis = redis;

        // Treat HEAD as GET for route matching (UptimeRobot uses HEAD)
        const routeMethod = req.method === 'HEAD' ? 'GET' : req.method;
        const route = router.match(routeMethod, pathname);

        if (!route) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }

        // Attach route params to request
        req.params = route.params;

        // Run handler chain (supports middleware pattern)
        const runHandlers = async (index) => {
          if (index >= route.handlers.length) return;
          const handler = route.handlers[index];

          // Support middleware: if handler has 3 params, it's middleware (req, res, next)
          if (handler.length === 3) {
            handler(req, res, () => runHandlers(index + 1));
          } else {
            // Final handler (req, res)
            await handler(req, res);
          }
        };

        await runHandlers(0);

        // HEAD requests must return no body (but still route via GET)
        if (req.method === 'HEAD' && !res.writableEnded) {
          res.end();
        }
        return;
      }

      // ── Static files ──────────────────────
      // Map / to /index.html, otherwise serve the file directly
      let filePath;
      if (pathname === '/') {
        filePath = join(DASHBOARD_DIR, 'index.html');
      } else {
        filePath = join(DASHBOARD_DIR, pathname);
      }

      // Check if the resolved path is a file
      if (existsSync(filePath) && statSync(filePath).isFile()) {
        await serveStatic(res, filePath);
      } else {
        // SPA fallback — serve index.html for all non-file, non-API routes
        await serveSPAFallback(res);
      }
    } catch (err) {
      logger.error({ err, method: req.method, pathname }, 'Request handler error');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });

  // ── Graceful shutdown ─────────────────────
  const shutdown = async (signal) => {
    logger.info({ signal }, 'Shutdown signal received');

    // Stop accepting new connections, drain existing ones
    await new Promise((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    logger.info('HTTP server closed');

    // Graceful stop in order: auto-chat -> WhatsApp -> Redis
    autoChat?.stop();
    await wa.stop?.();
    await closeRedis();

    logger.info('Graceful shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // ── Start listening ───────────────────────
  server.listen(PORT, () => {
    logger.info({ port: PORT }, 'Ara HTTP server started');
    console.log(`Ara dashboard: http://localhost:${PORT}`);
  });

  return server;
}

// Auto-start when run directly
main().catch((err) => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});
