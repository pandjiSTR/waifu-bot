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
let stopSocket = null;

export function getConnectionState() {
  return connectionState;
}

export function getSock() {
  return sock;
}

async function clearRedisAuth() {
  try {
    await redis?.del('waifu:auth:creds');
    await redis?.del('waifu:auth:keys');
    logger.info('Redis auth cleared');
  } catch (e) {
    logger.warn({ e }, 'Failed to clear auth keys');
  }
}

export async function connectToWhatsApp() {
  if (isShuttingDown) return;

  const { state, saveCreds } = await useRedisAuthState(redis);
  const { version } = await fetchLatestBaileysVersion();

  const newSock = makeWASocket({
    auth: state,
    version,
    logger,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock = newSock;
  connectionState = 'connecting';

  newSock.ev.on('creds.update', saveCreds);

  newSock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !state?.creds?.registered) {
      try {
        await redis?.set('waifu:qr', qr, 300);
      } catch {}
      console.log('\nScan QR ini dengan WhatsApp:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      connectionState = 'connected';
      logger.info('WhatsApp connected');
    } else if (connection === 'close') {
      connectionState = 'disconnected';
      const statusCode = lastDisconnect?.error
        ? new Boom(lastDisconnect?.error)?.output?.statusCode
        : undefined;

      const needsReinit =
        statusCode === 440 ||
        statusCode === 500 ||
        statusCode === 515 ||
        statusCode === DisconnectReason.loggedOut;

      if (needsReinit) {
        logger.error({ statusCode }, 'Auth invalid — clearing session and reconnecting');
        await clearRedisAuth();
        setTimeout(() => connectToWhatsApp(), 1000);
      } else {
        logger.warn({ statusCode }, 'WhatsApp connection closed — reconnecting');
        setTimeout(() => connectToWhatsApp(), 2000);
      }
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

  stopSocket = async () => {
    try {
      newSock.ev.removeAllListeners();
      typeof newSock.end === 'function' ? await newSock.end() : newSock.ws?.close?.();
    } catch (err) {
      logger.warn({ err }, 'WhatsApp stop error');
    }
    if (sock === newSock) sock = null;
  };

  return newSock;
}

// Legacy wrapper for backward compatibility
export async function initWhatsApp(redisClient) {
  redis = redisClient;
  const waSock = await connectToWhatsApp();
  return {
    sock: waSock,
    stop: async () => {
      isShuttingDown = true;
      await stopSocket?.();
      connectionState = 'disconnected';
    },
  };
}