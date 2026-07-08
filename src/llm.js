import { Ollama } from 'ollama';
import pino from 'pino';
import { isOpen, recordSuccess, recordFailure, remainingMs } from './circuit.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

// Ollama Cloud base URL. Overridable via OLLAMA_HOST (do not hardcode in callers).
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'https://ollama.com';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma4:31b-cloud';
const OLLAMA_TIMEOUT_MS = parseInt(process.env.OLLAMA_TIMEOUT_MS || '60000', 10);
// Base of the retry backoff ladder (1s -> 2s). Overridable for tests.
const RETRY_BASE_MS = parseInt(process.env.OLLAMA_RETRY_BASE_MS || '1000', 10);
const MAX_ATTEMPTS = 2;

// Instruction that directs the model to summarize — this is a TASK instruction,
// not persona content. Persona strings must never live here (see AGENTS.md #1).
const SUMMARY_INSTRUCTION =
  'Ringkas percakapan berikut menjadi {n} kalimat singkat dalam bahasa Indonesia. ' +
  'Jaga fakta penting dan konteks emosional. Jangan tambahkan komentar di luar ringkasan.';

let client = null;
// Test seam: when set, getClient() returns this instead of a real Ollama client.
// Not part of the public API; used only by offline tests.
let clientOverride = null;

export function __setClientForTest(override) {
  clientOverride = override;
}

function getClient() {
  if (clientOverride) return clientOverride;
  if (!client) {
    client = new Ollama({
      host: OLLAMA_HOST,
      headers: { Authorization: `Bearer ${process.env.OLLAMA_API_KEY}` },
    });
  }
  return client;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Core chat call to Ollama Cloud.
 * @param {Array<{role:string, content:string}>} messages  // [system, ...history, user]
 * @param {object} [opts]
 * @param {string} [opts.model]          // default OLLAMA_MODEL
 * @param {number} [opts.timeoutMs]      // default OLLAMA_TIMEOUT_MS
 * @param {object} [opts.options]        // e.g. { num_ctx, temperature }
 * @param {AbortSignal} [opts.signal]    // external cancellation
 * @param {string[]} [opts.images]       // base64 (or file path) images for
 *                                       // multimodal models (gemma4). Attached
 *                                       // to the last user message.
 * @returns {Promise<string>} assistant reply text
 * @throws {Error} after retries are exhausted
 */
export async function chat(messages, opts = {}) {
  // Fase 5 (§6.3): short-circuit while the circuit breaker is open so we do
  // not hammer the LLM during a failure/loop cooldown. The pipeline catches
  // this and sends a neutral fallback reply.
  if (isOpen()) {
    throw new Error(
      `Circuit breaker open — LLM calls suspended (${remainingMs()}ms remaining)`
    );
  }
  const c = getClient();
  const model = opts.model || OLLAMA_MODEL;
  const timeoutMs = opts.timeoutMs || OLLAMA_TIMEOUT_MS;

  // Multimodal: if images are supplied, attach them to the last user message
  // (the Ollama native API expects `images` on the message it belongs to).
  // Text-only callers are unaffected — reqMessages === messages in that case.
  let reqMessages = messages;
  if (Array.isArray(opts.images) && opts.images.length) {
    reqMessages = messages.map((m) => ({ ...m }));
    let target = -1;
    for (let i = reqMessages.length - 1; i >= 0; i--) {
      if (reqMessages[i].role === 'user') {
        target = i;
        break;
      }
    }
    if (target >= 0) {
      reqMessages[target] = { ...reqMessages[target], images: opts.images };
    } else {
      // No user message present — append a synthetic one carrying the images.
      reqMessages.push({ role: 'user', content: '', images: opts.images });
    }
  }

  let lastErr;
  const started = Date.now();
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const response = await c.chat({
        model,
        messages: reqMessages,
        stream: false,
        options: opts.options || {},
        signal: opts.signal || ac.signal,
      });
      clearTimeout(timer);

      const content = response?.message?.content;
      if (typeof content !== 'string') {
        throw new Error('Ollama response missing message.content');
      }
      // Strip only trailing whitespace — never alter persona style
      // (normalize is a later phase).
      logger.info({ duration: Date.now() - started, model, attempt: attempt + 1 }, 'LLM call succeeded');
      recordSuccess(); // Fase 5 (§6.3): a successful call resets the breaker.
      return content.trimEnd();
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      // Respect an externally-provided signal: do not retry a hard abort.
      if (opts.signal && opts.signal.aborted) throw err;
      if (attempt < MAX_ATTEMPTS - 1) {
        logger.warn(
          { attempt: attempt + 1, err: err?.message },
          'Ollama chat attempt failed, retrying'
        );
        await sleep(RETRY_BASE_MS * 2 ** attempt); // 1s -> 2s
      }
    }
  }

  // Fase 5 (§6.3): all retries exhausted — record the failure so the breaker
  // can trip into cooldown after THRESHOLD consecutive failures.
  logger.warn({ duration: Date.now() - started, attempts: Date.now() - started > timeoutMs ? 'timeout' : 'error' }, 'LLM call failed');
  recordFailure();
  throw new Error(
    `Ollama chat failed after ${MAX_ATTEMPTS} attempts: ${lastErr?.message || lastErr}`
  );
}

/**
 * Summarize text to ~maxSentences sentences using the same model.
 * @param {string} text
 * @param {object} [opts] { maxSentences=3, timeoutMs }
 * @returns {Promise<string>}
 */
export async function summarize(text, opts = {}) {
  const n = opts.maxSentences || 3;
  const instruction = SUMMARY_INSTRUCTION.replace('{n}', String(n));
  return chat(
    [
      { role: 'system', content: instruction },
      { role: 'user', content: text },
    ],
    { timeoutMs: opts.timeoutMs, options: {} }
  );
}

/**
 * Convenience wrapper for a single-turn vision/image query.
 * @param {string} text          // prompt / question about the image
 * @param {string} base64Image   // base64-encoded image
 * @param {object} [opts]        // same options as chat()
 * @returns {Promise<string>}
 */
export async function chatWithImage(text, base64Image, opts = {}) {
  return chat([{ role: 'user', content: text }], {
    ...opts,
    images: [base64Image],
  });
}
