import pino from 'pino';
import { sleep } from './util.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

export const DEFAULT_MAX_CHARS = 1900;
const _rawRetry = process.env.CHUNK_SEND_RETRY;
export const DEFAULT_MAX_ATTEMPTS = /^\d+$/.test(_rawRetry) ? parseInt(_rawRetry, 10) : 3;
export const DEFAULT_DELAY_MS = 250;
export const DEFAULT_BACKOFF_BASE_MS = 500;

export function splitChunks(text, maxChars = DEFAULT_MAX_CHARS) {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 1;
  const chunks = [];
  let remaining = String(text ?? '').replace(/^\s+/, '');

  while (remaining.length > limit) {
    let cut;
    const nl = remaining.lastIndexOf('\n', limit - 1);
    if (nl > 0) {
      cut = nl;
    } else {
      const sp = remaining.lastIndexOf(' ', limit - 1);
      if (sp > 0) {
        cut = sp;
      } else {
        cut = limit;
      }
    }
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
    if (cut < limit && remaining.length && /\s/.test(remaining[0])) {
      remaining = remaining.slice(1);
    }
    remaining = remaining.replace(/^\s+/, '');
    if (remaining.length === 0) break;
  }

  if (chunks.length === 0) return [remaining];
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export async function sendChunks(channel, text, opts = {}) {
  text = String(text ?? '').replace(/\s*\|\|\|\s*/g, ' ');

  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
  const backoffBaseMs = opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;

  const chunks = splitChunks(text, maxChars);
  const total = chunks.length;
  const sentIds = [];

  if (!channel?.send) {
    return { sent: 0, total, failed: false, ids: [] };
  }

  let sent = 0;
  let failed = false;

  for (let i = 0; i < chunks.length; i++) {
    let delivered = false;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const msg = await channel.send(chunks[i]);
        delivered = true;
        if (msg?.id) sentIds.push(msg.id);
        break;
      } catch (err) {
        if (attempt < maxAttempts - 1) {
          const backoff = backoffBaseMs * 2 ** attempt;
          logger.warn({ chunk: i + 1, attempt: attempt + 1, backoff, err: err?.message }, 'chunk send failed, retrying');
          await sleep(backoff);
        } else {
          logger.warn({ chunk: i + 1, err: err?.message }, 'chunk send failed after all retries');
        }
      }
    }
    if (!delivered) { failed = true; break; }
    sent++;
    if (i < chunks.length - 1 && delayMs > 0) await sleep(delayMs);
  }

  return { sent, total, failed, ids: sentIds };
}

export default { splitChunks, sendChunks };