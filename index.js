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
import { initDiscord, getConnectionState } from './src/discord.js';
import { createDispatcher } from './src/dispatch.js';
import { processLLM } from './src/pipeline.js';
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });
const PORT = parseInt(process.env.PORT || '10000', 10);
const DASHBOARD_DIR = join(__dirname, 'dashboard');

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

  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.path === pathname) {
        return { params: {}, handlers: route.handlers };
      }
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

const CACHE_MAX_AGE = 60 * 60;

async function serveStatic(res, filePath) {
  try {
    const ext = extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
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

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

export async function main() {
  try {
    validateAuthConfig();
  } catch (err) {
    logger.error({ err }, 'Auth config validation failed');
    process.exit(1);
  }

  let redis = createRedisClient();
  if (redis) {
    try {
      await redis.connect();
    } catch (err) {
      logger.error({ err }, 'Failed to connect to Redis — running without cache');
      redis = null;
    }
  }

  await loadBlacklist(redis);
  await loadPersonality(redis);

  const dispatcher = createDispatcher({ processLLM });
  const { client, stop: stopDiscord } = await initDiscord(redis, dispatcher, {
    shouldProcess: (await import('./src/gatekeeper.js')).shouldProcess,
  });

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

  let autoChat = { stop: () => {} };
  if (client) {
    autoChat = startAutoChat({ redis, client });
  } else {
    logger.warn('Discord client not available — auto-chat scheduler not started');
  }

  const router = new Router();

  router.get('/api/health', handleHealth);
  router.post('/api/auth/login', handleLogin);
  router.post('/api/auth/logout', handleLogout);

  router.get('/api/overview', requireAuth, handleOverview);
  router.get('/api/friends', requireAuth, handleGetFriends);
  router.get('/api/personality', requireAuth, handleGetPersonality);
  router.put('/api/personality', requireAuth, handleUpdatePersonality);
  router.get('/api/settings', requireAuth, handleGetSettings);
  router.put('/api/settings', requireAuth, handleUpdateSettings);

  registerApiRoutes(router, requireAuth);

  const server = createServer(async (req, res) => {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    try {
      if (pathname.startsWith('/api/')) {
        req.redis = redis;

        const routeMethod = req.method === 'HEAD' ? 'GET' : req.method;
        const route = router.match(routeMethod, pathname);

        if (!route) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }

        req.params = route.params;

        const runHandlers = async (index) => {
          if (index >= route.handlers.length) return;
          const handler = route.handlers[index];
          if (handler.length === 3) {
            handler(req, res, () => runHandlers(index + 1));
          } else {
            await handler(req, res);
          }
        };

        await runHandlers(0);

        if (req.method === 'HEAD' && !res.writableEnded) {
          res.end();
        }
        return;
      }

      let filePath;
      if (pathname === '/') {
        filePath = join(DASHBOARD_DIR, 'index.html');
      } else {
        filePath = join(DASHBOARD_DIR, pathname);
      }

      if (existsSync(filePath) && statSync(filePath).isFile()) {
        await serveStatic(res, filePath);
      } else {
        await serveSPAFallback(res);
      }
    } catch (err) {
      logger.error({ err, method: req.method, pathname }, 'Request handler error');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });

  const shutdown = async (signal) => {
    logger.info({ signal }, 'Shutdown signal received');

    await new Promise((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    logger.info('HTTP server closed');

    autoChat?.stop();
    await stopDiscord?.();
    await closeRedis();

    logger.info('Graceful shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  server.listen(PORT, () => {
    logger.info({ port: PORT }, 'Ara Discord server started');
    console.log(`Ara dashboard: http://localhost:${PORT}`);
  });

  return server;
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});
