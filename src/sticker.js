// Sticker maker (Fase 6 / PRD §5.3). Static images are resized to 512x512 WebP
// via Sharp. Animated GIFs / videos use FFmpeg (best-effort; falls back to Sharp
// static if FFmpeg is unavailable or fails). Always returns a Buffer or null —
// never throws.

import sharp from 'sharp';
import pino from 'pino';
import { execFile } from 'node:child_process';
import os from 'node:os';
import { writeFileSync, unlinkSync } from 'node:fs';
import { getMediaBuffer } from './media.js';
import WebP from 'node-webpmux';

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

function makeExif(packname, author) {
  const data = Buffer.from(JSON.stringify({
    'sticker-pack-id': packname + Math.random().toString(36).slice(2, 6),
    'sticker-pack-name': packname,
    'sticker-pack-publisher': author,
    emojis: [],
  }), 'utf-8');

  const exif = Buffer.alloc(22 + data.length);
  let o = 0;
  exif.writeUInt16LE(0x4949, o); o += 2;
  exif.writeUInt16LE(0x002A, o); o += 2;
  exif.writeUInt32LE(8, o); o += 4;
  exif.writeUInt16LE(1, o); o += 2;
  exif.writeUInt16LE(0x5741, o); o += 2;
  exif.writeUInt16LE(7, o); o += 2;
  exif.writeUInt32LE(data.length, o); o += 4;
  exif.writeUInt32LE(22, o); o += 4;
  data.copy(exif, o);

  return exif;
}

const STICKER_SIZE = 512;
const STICKER_PACK = 'ara bikin stiker';
const STICKER_PUBLISHER = 'uletbulujawa';

/**
 * Build a WhatsApp sticker (512x512 WebP) from a media message.
 * @param {object} sock
 * @param {object} message  // WAMessage (imageMessage)
 * @returns {Promise<Buffer|null>} WebP buffer, or null on failure
 */
export async function makeSticker(sock, message) {
  try {
    const buffer = await getMediaBuffer(sock, message);
    if (!buffer) return null;

    // Detect animated content (GIF or video).
    const isAnimated =
      message?.message?.imageMessage?.mimetype?.startsWith('image/gif') ||
      message?.message?.videoMessage?.mimetype?.startsWith('video/') ||
      false;

    if (isAnimated) {
      // Best-effort FFmpeg path. If FFmpeg is not installed or the command
      // fails, fall back to Sharp static conversion.
      try {
        const inputPath = os.tmpdir() + '/ara-sticker-input-' + Date.now() + '.gif';
        const outputPath = os.tmpdir() + '/ara-sticker-output-' + Date.now() + '.webp';
        writeFileSync(inputPath, buffer);
        await new Promise((resolve, reject) => {
          execFile(
            'ffmpeg',
            [
              '-i', inputPath,
              '-vf', 'scale=512:512:flags=lanczos',
              '-c:v', 'libwebp',
              '-loop', '0',
              '-preset', 'default',
              '-an',
              '-vsync', '0',
              '-f', 'webp',
              '-s', '512:512',
              outputPath,
              '-y',
            ],
            { timeout: 30000 },
            (err) => (err ? reject(err) : resolve()),
          );
        });
        const result = await import('node:fs/promises').then((m) => m.readFile(outputPath));
        try { unlinkSync(inputPath); unlinkSync(outputPath); } catch { /* cleanup best-effort */ }
        const animImg = new WebP.Image();
        await animImg.load(result);
        animImg.exif = makeExif(STICKER_PACK, STICKER_PUBLISHER);
        return await animImg.save(null);
      } catch (ffErr) {
        if (ffErr.code === 'ENOENT') {
          logger.warn('FFmpeg not found — falling back to static Sharp for animated input');
        } else {
          logger.warn({ err: ffErr }, 'FFmpeg sticker conversion failed — falling back to static Sharp');
        }
        // Fall through to Sharp static path.
      }
    }

    const webp = await sharp(buffer)
      .resize(STICKER_SIZE, STICKER_SIZE, {
        fit: 'cover',
        position: 'centre',
      })
      .webp()
      .toBuffer();

    const img = new WebP.Image();
    await img.load(webp);
    img.exif = makeExif(STICKER_PACK, STICKER_PUBLISHER);
    return await img.save(null);
  } catch (err) {
    logger.warn({ err }, 'makeSticker failed');
    return null; // never throw
  }
}

// Re-exported for callers / tests that want the configured labels (PRD §5.3).
export const STICKER_META = { pack: STICKER_PACK, publisher: STICKER_PUBLISHER };

export default { makeSticker, STICKER_META };
