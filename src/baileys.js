import makeWASocket, {
  DisconnectReason,
  isJidGroup,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { shouldProcess, processLLM, extractText } from './pipeline.js';
import { useRedisAuthState } from './baileys-auth.js';

const logger = pino({ name: 'baileys', level: process.env.LOG_LEVEL || 'warn' });

let connectionState = 'disconnected';

export function getConnectionState() {
  return connectionState;
}

export async function initWhatsApp(redis) {
  try {
    if (!redis) {
      logger.error('Redis unavailable — WhatsApp disabled');
      return { sock: null, stop: async () => {} };
    }

    const { state, saveCreds } = await useRedisAuthState(redis);

    const sock = makeWASocket({
      auth: state,
      logger,
    });

    connectionState = 'connecting';

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, qr, lastDisconnect } = update;

      if (qr) {
        try {
          await redis?.set('waifu:qr', qr, 300);
          console.log('QR_CODE:', qr);
        } catch {
          // non-fatal
        }
        logger.info('QR code received — scan with WhatsApp to pair');
      }

      if (connection === 'open') {
        connectionState = 'connected';
        logger.info('WhatsApp connected');
      } else if (connection === 'close') {
        connectionState = 'disconnected';
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          logger.error(
            'WhatsApp logged out — clearing Redis auth keys; re-pair on next start'
          );
          try {
            await redis?.del('waifu:auth:creds');
            await redis?.del('waifu:auth:keys');
          } catch (e) {
            logger.warn({ e }, 'Failed to clear Redis auth keys on logout');
          }
        } else {
          logger.warn('WhatsApp connection closed — baileys will auto-reconnect');
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
            sock,
            redis,
            jid: m.key.remoteJid,
            isGroup,
            sender: m.key.participant || m.key.remoteJid,
            message: m,
            body,
            messageId: m.key.id,
          };

          if (!(await shouldProcess(body, ctx))) continue;

          await processLLM(body, ctx).catch((err) =>
            logger.error({ err }, 'processLLM failed')
          );
        } catch (err) {
          logger.error({ err }, 'messages.upsert handler error');
        }
      }
    });

    const stop = async () => {
      try {
        sock.ev.removeAllListeners();
        if (typeof sock.end === 'function') {
          await sock.end();
        } else {
          sock.ws?.close?.();
        }
      } catch (err) {
        logger.warn({ err }, 'WhatsApp stop error');
      } finally {
        connectionState = 'disconnected';
      }
    };

    return { sock, stop };
  } catch (err) {
    logger.error({ err }, 'initWhatsApp failed — continuing without WhatsApp');
    return { sock: null, stop: async () => {} };
  }
}