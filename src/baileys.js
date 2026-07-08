import makeWASocket, {
  DisconnectReason,
  isJidGroup,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { shouldProcess, processLLM, extractText } from './pipeline.js';
import { useRedisAuthState } from './baileys-auth.js';

const logger = pino({ name: 'baileys', level: process.env.LOG_LEVEL || 'warn' });

// Module-level connection state surfaced to /api/health via getConnectionState().
let connectionState = 'disconnected';

export function getConnectionState() {
  return connectionState;
}

/**
 * Initialize the WhatsApp socket and wire event handlers.
 * @param {object|null} redis // may be null
 * @returns {Promise<{ sock: object|null, stop: () => Promise<void> }>}
 */
export async function initWhatsApp(redis) {
  try {
    // Redis is required to persist the WhatsApp session. If unavailable, fail
    // hard: no WhatsApp, but the HTTP server still boots (graceful degradation).
    if (!redis) {
      logger.error('Redis unavailable — WhatsApp disabled');
      return { sock: null, stop: async () => {} };
    }

    // Session now persists across deploys via Redis (waifu:auth:* keys), so no
    // local .wa-auth folder is used. Socket is only opened inside this function;
    // importing this module remains side-effect free.
    const { state, saveCreds } = await useRedisAuthState(redis);

const sock = makeWASocket({
      auth: state,
      logger,
    });

    connectionState = 'connecting';

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, qr, lastDisconnect } = update;

      // Pairing code: when socket connects and creds aren't registered yet,
      // request a pairing code for the owner number.
      if (connection === 'open' && !sock.authState?.creds?.registered) {
        const number = process.env.OWNER_NUMBER?.split(',')?.[0]?.trim();
        if (number) {
          try {
            const code = await sock.requestPairingCode(number);
            console.log('PAIRING_CODE:', code);
            logger.info({ number }, 'Pairing code generated');
          } catch (err) {
            logger.warn({ err }, 'Pairing code request failed');
          }
        }
      }

      if (qr) {
        try {
          await redis?.set('waifu:qr', qr, 300);
        } catch {
          // non-fatal: QR is also printed to terminal
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
      // Only live incoming messages; ignore history appends / status events.
      if (type !== 'notify') return;

      for (const m of messages) {
        try {
          if (m.key.fromMe) continue; // echoes already filtered by shouldProcess too

          const body = extractText(m);
          if (!body) continue; // Fase 3 ignores non-text (media handled later)

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

          // Fire-and-forget: one bad message must never crash the socket.
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
    // Graceful degradation: HTTP server still boots without WhatsApp.
    logger.error({ err }, 'initWhatsApp failed — continuing without WhatsApp');
    return { sock: null, stop: async () => {} };
  }
}
