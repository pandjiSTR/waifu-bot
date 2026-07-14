import pino from 'pino';
import { sleep } from './util.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

// Defaults chosen for WhatsApp delivery reliability (PRD §5.7 / §6.2).
// A single WhatsApp text message is safest well under the protocol's hard
// limit; 1800 chars keeps rich UTF-8 content (emoji, combined glyphs) safe.
// Overridable per call via opts.maxChars. Retry count is opts.maxAttempts
// (defaults to process.env.CHUNK_SEND_RETRY or 3).
export const DEFAULT_MAX_CHARS = 1800;
const _rawRetry = process.env.CHUNK_SEND_RETRY;
export const DEFAULT_MAX_ATTEMPTS = /^\d+$/.test(_rawRetry) ? parseInt(_rawRetry, 10) : 3;
export const DEFAULT_DELAY_MS = 250;
export const DEFAULT_BACKOFF_BASE_MS = 500; // 500ms -> 1s -> 2s

/**
 * Split a reply into chunks of at most `maxChars` characters.
 *
 * Pure, no network. Always returns at least one chunk. Break points are chosen
 * by preference: (1) last newline within the limit, (2) last space within the
 * limit — never mid-word. If a single word exceeds `maxChars`, the final chunk
 * is hard-truncated at the limit (the only permitted mid-word break).
 *
 * @param {string} text
 * @param {number} [maxChars=1800]
 * @returns {string[]} non-empty array of chunks
 */
export function splitChunks(text, maxChars = DEFAULT_MAX_CHARS) {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 1;
  const chunks = [];
  // No leading whitespace on the very first chunk.
  let remaining = String(text ?? '').replace(/^\s+/, '');

  while (remaining.length > limit) {
    let cut;

    // Prefer breaking at a newline (clean paragraph boundary).
    const nl = remaining.lastIndexOf('\n', limit - 1);
    if (nl > 0) {
      cut = nl;
    } else {
      // Otherwise break at the last space so we never split a word.
      const sp = remaining.lastIndexOf(' ', limit - 1);
      if (sp > 0) {
        cut = sp;
      } else {
        // Single word longer than the limit: hard-truncate (allowed exception).
        cut = limit;
      }
    }

    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
    // Drop the single boundary whitespace char we broke on (newline/space),
    // but NOT for a hard truncation (there is no boundary char to skip).
    if (cut < limit && remaining.length && /\s/.test(remaining[0])) {
      remaining = remaining.slice(1);
    }
    // Strip any residual leading whitespace before the next chunk.
    remaining = remaining.replace(/^\s+/, '');

    if (remaining.length === 0) break; // avoid an empty trailing chunk
  }

  // Always return at least one chunk (empty input yields ['']).
  if (chunks.length === 0) return [remaining];
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * Reliably deliver a (possibly long) reply as sequential chunks.
 *
 * Each chunk is sent via the Baileys socket with a short inter-chunk delay and
 * per-chunk retries with exponential backoff. If a chunk still fails after all
 * attempts, the failure is logged and further chunks are NOT sent (per PRD §5.7:
 * stop on partial failure so we never silently lose the tail of a message).
 *
 * @param {object|null} sock            // Baileys socket, or null when offline
 * @param {string} jid                  // recipient JID
 * @param {string} text                 // full reply to send
 * @param {object} [opts]
 * @param {number} [opts.maxChars=1800] // chunk size
 * @param {number} [opts.maxAttempts=3] // retries per chunk
 * @param {number} [opts.delayMs=250]   // pause between chunks
 * @param {number} [opts.backoffBaseMs=500] // backoff base (×2^attempt)
 * @param {Function} [opts.sendMessage] // injectable: (jid, {text}) => Promise
 * @returns {Promise<{sent:number, total:number, failed:boolean, ids:string[]}>}
 */
export async function sendChunks(sock, jid, text, opts = {}) {
  // Wire-level guard: the internal "|||" multi-message delimiter must never
  // reach WhatsApp. This is the final boundary — any code path that delivers
  // text (LLM reply, auto-chat, future features) is covered here.
  text = String(text ?? '').replace(/\s*\|\|\|\s*/g, ' ');

  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
  const backoffBaseMs = opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;

  const sendMessage =
    opts.sendMessage || (sock && typeof sock.sendMessage === 'function'
      ? sock.sendMessage.bind(sock)
      : null);

  const chunks = splitChunks(text, maxChars);
  const total = chunks.length;
  // Collect the message ids Baileys assigned to each successfully delivered
  // chunk. Callers use these to recognize later replies quoting the bot.
  const sentIds = [];

  // No transport available (e.g. headless test / socket not yet connected).
  // Skip gracefully; nothing was delivered but this is not an error condition.
  if (!sendMessage) {
    if (sock) {
      logger.debug({ jid, total }, 'sendChunks: no sendMessage available, skipping');
    }
    return { sent: 0, total, failed: false, ids: [] };
  }

  let sent = 0;
  let failed = false;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    let delivered = false;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const result = await sendMessage(jid, { text: chunk });
        delivered = true;
        if (result?.key?.id) sentIds.push(result.key.id);
        break;
      } catch (err) {
        if (attempt < maxAttempts - 1) {
          const backoff = backoffBaseMs * 2 ** attempt;
          logger.warn(
            { jid, chunk: i + 1, attempt: attempt + 1, backoff, err: err?.message },
            'chunk send failed, retrying'
          );
          await sleep(backoff);
        } else {
          logger.warn(
            { jid, chunk: i + 1, err: err?.message },
            'chunk send failed after all retries'
          );
        }
      }
    }

    if (!delivered) {
      failed = true;
      break; // PRD §5.7: stop sending further chunks on failure.
    }

    sent += 1;
    // Small delay between chunks to avoid rate-limit / ordering issues.
    if (i < chunks.length - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return { sent, total, failed, ids: sentIds };
}

export default { splitChunks, sendChunks };
