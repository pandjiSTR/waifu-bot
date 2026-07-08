import makeWASocket, {
  DisconnectReason,
  isJidGroup,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
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
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const streamError = lastDisconnect?.error?.message || '';
        const isStreamError = streamError.includes('515') || streamError.includes('stream');

        if (isStreamError) {
          logger.error('Stream error 515 — clearing session for fresh QR');
          try {
            await redis?.del('waifu:auth:creds');
            await redis?.del('waifu:auth:keys');
          } catch (e) {
            logger.warn({ e }, 'Failed to clear auth on stream error');
          }
        } else if (statusCode === DisconnectReason.loggedOut) {
          logger.error('WhatsApp logged out — clearing auth keys');
          try {
            await redis?.del('waifu:auth:creds');
            await redis?.del('waifu:auth:keys');
          } catch (e) {
            logger.warn({ e }, 'Failed to clear auth keys');
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