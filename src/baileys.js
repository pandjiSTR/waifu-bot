import makeWASocket, {
  DisconnectReason,
  isJidGroup,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { shouldProcess, processLLM, extractText } from './pipeline.js';
import { useRedisAuthState } from './baileys-auth.js';

const logger = pino({ name: 'baileys', level: process.env.LOG_LEVEL || 'warn' });

let connectionState = 'disconnected';
let sock = null;
let redis = null;
let isShuttingDown = false;
let isReconnecting = false;
let reconnectAttempt = 0;
let consecutive440 = 0;
let consecutive500 = 0;
let stopReconnect440 = false;
let stabilityTimer = null;

const MAX_BACKOFF_MS = 60000;
const MAX_RECONNECT_ATTEMPTS = 10;
const SESSION_STABILIZE_MS = 3000;

export function getConnectionState() {
  return connectionState;
}

async function clearRedisAuth() {
  try {
    await redis?.del('waifu:auth:creds');
    // Also clean up individual key-store keys
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis?.scan(cursor, 'MATCH', 'waifu:auth:*');
      cursor = nextCursor;
      if (keys?.length) await redis?.del(...keys);
    } while (cursor !== '0');
  } catch (e) {
    logger.warn({ e }, 'Failed to clear auth keys');
  }
}

function reconnectWithBackoff() {
  if (isReconnecting) return;
  if (stopReconnect440) return;
  isReconnecting = true;

  reconnectAttempt += 1;

  if (reconnectAttempt > MAX_RECONNECT_ATTEMPTS) {
    logger.warn('Reconnect failed 10x — waiting 5 minutes');
    setTimeout(() => {
      reconnectAttempt = 0;
      isReconnecting = false;
      reconnectWithBackoff();
    }, 5 * 60 * 1000);
    return;
  }

  const delay = Math.min(1000 * 2 ** reconnectAttempt, MAX_BACKOFF_MS);

  setTimeout(async () => {
    try {
      await connectToWhatsApp();
    } catch (err) {
      logger.error({ err }, 'Reconnect failed');
      isReconnecting = false;
      reconnectWithBackoff();
    }
  }, delay);
}

export async function connectToWhatsApp() {
  if (isShuttingDown) return;

  const { state, saveCreds } = await useRedisAuthState(redis);
  const { version } = await fetchLatestBaileysVersion();

  const newSock = makeWASocket({
    auth: state,
    version,
    logger,
    printQRInTerminal: false,
  });

  sock = newSock;
  connectionState = 'connecting';

  newSock.ev.on('creds.update', saveCreds);

  newSock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        await redis?.set('waifu:qr', qr, 300);
      } catch {}
      console.log('\nScan QR ini dengan WhatsApp:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      connectionState = 'connected';
      logger.info('WhatsApp connected');
      isReconnecting = false;
      consecutive500 = 0;
      consecutive440 = 0;
      clearTimeout(stabilityTimer);
      stabilityTimer = setTimeout(() => {
        reconnectAttempt = 0;
      }, 30000);
      return;
    }

    if (connection === 'close') {
      connectionState = 'disconnected';
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      isReconnecting = false;

      if (isShuttingDown) return;

      if (isLoggedOut) {
        logger.error('Logged out — clearing session');
        await clearRedisAuth();
        reconnectWithBackoff();
        return;
      }

      if (statusCode === 440) {
        consecutive440 += 1;
        if (consecutive440 >= 5) {
          logger.error('5x 440 consecutive — auth conflict, clearing session');
          stopReconnect440 = true;
          clearTimeout(stabilityTimer);
          await clearRedisAuth();
          setTimeout(() => {
            stopReconnect440 = false;
            consecutive440 = 0;
          }, 30 * 1000);
          return;
        }
        reconnectWithBackoff();
        return;
      }

      consecutive440 = 0;

      if (statusCode === 500) {
        consecutive500 += 1;
      } else {
        consecutive500 = 0;
      }

      if (consecutive500 >= 3) {
        logger.error('3x 500 consecutive — auth corrupted, clearing session');
        consecutive500 = 0;
        await clearRedisAuth();
        reconnectWithBackoff();
        return;
      }

      reconnectWithBackoff();
    }
  });

  newSock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const m of messages) {
      try {
        if (m.key.fromMe) continue;

        const body = extractText(m);
        if (!body) continue;

        const isGroup = isJidGroup(m.key.remoteJid);
        const ctx = {
          sock: newSock, redis,
          jid: m.key.remoteJid, isGroup,
          sender: m.key.participant || m.key.remoteJid,
          message: m, body, messageId: m.key.id,
        };

        if (!(await shouldProcess(body, ctx))) continue;

        await processLLM(body, ctx).catch((err) =>
          logger.error({ err }, 'processLLM failed'));
      } catch (err) {
        logger.error({ err }, 'messages.upsert handler error');
      }
    }
  });
}

export async function initWhatsApp(redisClient) {
  redis = redisClient;
  await connectToWhatsApp();
  return {
    sock,
    stop: async () => {
      isShuttingDown = true;
      try {
        sock?.ev?.removeAllListeners();
        typeof sock?.end === 'function' ? await sock.end() : sock?.ws?.close?.();
      } catch (err) {
        logger.warn({ err }, 'WhatsApp stop error');
      }
      connectionState = 'disconnected';
    },
  };
}