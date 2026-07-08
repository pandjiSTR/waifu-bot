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

export function getConnectionState() {
  return connectionState;
}

async function clearRedisAuth(redis) {
  try {
    await redis?.del('waifu:auth:creds');
    await redis?.del('waifu:auth:keys');
    logger.info('Redis auth cleared');
  } catch (e) {
    logger.warn({ e }, 'Failed to clear auth keys');
  }
}

export async function initWhatsApp(redis) {
  try {
    if (!redis) {
      logger.error('Redis unavailable — WhatsApp disabled');
      return { sock: null, stop: async () => {} };
    }

    const { state, saveCreds } = await useRedisAuthState(redis);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      auth: state,
      version,
      logger,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    connectionState = 'connecting';

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
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
          logger.error({ statusCode }, 'Auth invalid — clearing session for fresh QR');
          await clearRedisAuth(redis);
          logger.info('Exiting process — Render will restart with fresh auth');
          process.exit(1);
        } else {
          logger.warn({ statusCode }, 'WhatsApp connection closed — baileys will auto-reconnect');
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const m of messages) {
        try {
          if (m.key.fromMe) continue;

          const body = extractText(m);
          if (!body) continue;

          const isGroup = isJidGroup(m.key.remoteJid);
          const ctx = {
            sock, redis,
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

    const stop = async () => {
      try {
        sock.ev.removeAllListeners();
        typeof sock.end === 'function' ? await sock.end() : sock.ws?.close?.();
      } catch (err) {
        logger.warn({ err }, 'WhatsApp stop error');
      } finally {
        connectionState = 'disconnected';
      }
    };

    return { sock, stop };
  } catch (err) {
    logger.error({ err }, 'initWhatsApp failed');
    return { sock: null, stop: async () => {} };
  }
}