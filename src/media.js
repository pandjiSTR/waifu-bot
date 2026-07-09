// Media processing (Fase 6 / PRD §5.6): vision + PDF text extraction.
//
// - describeImage: download an image, base64 it, ask the multimodal model
//   (gemma4) to describe it. Never throws; returns a neutral fallback on error.
// - extractPdfText: pull text out of a PDF buffer (truncated) for the LLM.
//
// Neither function contains persona strings — the only prompt text is a task
// instruction (describe the image), matching AGENTS.md #1.

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { downloadMediaMessage as baileysDownload } from '@whiskeysockets/baileys';
import pino from 'pino';
import { chat } from './llm.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

// Test seam — allows tests to inject a fake downloader without touching real media.
let _download = baileysDownload;
export function __setDownloadForTest(fn) { _download = fn; }

// Neutral fallback when vision is unavailable. No persona voice (AGENTS.md #1).
const VISION_FALLBACK = 'Maaf, aku belum bisa lihat gambar itu sekarang.';

// Task instruction (NOT persona): ask the model to describe the image concisely
// in Indonesian, optionally answering the user's question about it.
const VISION_INSTRUCTION =
  'Jelaskan isi gambar ini secara singkat dalam bahasa Indonesia.';

// Max characters of extracted PDF text forwarded to the LLM (context guard).
const PDF_TEXT_LIMIT = 8000;

/**
 * Download media bytes from a WAMessage via baileys' downloadMediaMessage.
 * @param {object} sock
 * @param {object} message  // WAMessage
 * @returns {Promise<Buffer|null>}
 */
export async function getMediaBuffer(sock, message) {
  try {
    const buf = await _download(
      message, 'buffer', {},
      { reuploadRequest: sock.updateMediaMessage }
    );
    return buf || null;
  } catch (err) {
    logger.warn({ err }, 'getMediaBuffer failed');
    return null;
  }
}

/**
 * Describe an image message using the multimodal LLM.
 * @param {object} sock
 * @param {object} message        // WAMessage containing imageMessage
 * @param {string} [prompt]       // optional user question / caption
 * @returns {Promise<string>} description (or neutral fallback on failure)
 */
export async function describeImage(sock, message, prompt = '') {
  try {
    const buffer = await getMediaBuffer(sock, message);
    if (!buffer) return VISION_FALLBACK;

    const base64 = buffer.toString('base64');
    const instruction =
      VISION_INSTRUCTION +
      (prompt ? ` Pertanyaan pengguna: ${prompt}` : '');

    const text = await chat([{ role: 'user', content: instruction }], {
      images: [base64],
    });

    return text && text.trim() ? text.trim() : VISION_FALLBACK;
  } catch (err) {
    logger.warn({ err }, 'describeImage failed');
    return VISION_FALLBACK; // never throw
  }
}

/**
 * Extract text from a PDF buffer. Truncates to PDF_TEXT_LIMIT chars.
 * @param {Buffer|null} buffer
 * @returns {Promise<string>} extracted text, or '' on any failure
 */
export async function extractPdfText(buffer) {
  if (!buffer) return '';
  try {
    const doc = await getDocument({ data: new Uint8Array(buffer) }).promise;
    let text = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      text += tc.items.map((it) => it.str).join(' ') + '\n';
      if (text.length >= PDF_TEXT_LIMIT) break;
    }
    return text.slice(0, PDF_TEXT_LIMIT).trim();
  } catch (err) {
    logger.warn({ err }, 'extractPdfText failed');
    return ''; // never throw
  }
}

export default { getMediaBuffer, describeImage, extractPdfText };
