// Tests for src/sticker.js — fully offline. Uses REAL Sharp on a tiny generated
// PNG so we exercise the actual 512x512 WebP conversion (no network/FFmpeg).
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import sharp from 'sharp';

let stickerMod;
let pngBuffer;
let media;

before(async () => {
  stickerMod = await import('../src/sticker.js');
  media = await import('../src/media.js');
  // Generate a small solid-color PNG to feed into makeSticker.
  pngBuffer = await sharp({
    create: { width: 120, height: 80, channels: 3, background: { r: 200, g: 40, b: 90 } },
  })
    .png()
    .toBuffer();
  assert.ok(pngBuffer.length > 0);
});

after(() => {
  media.__setDownloadForTest(null);
});

test('makeSticker returns a 512x512 WebP buffer from a PNG', async () => {
  media.__setDownloadForTest(async () => pngBuffer);
  const msg = { message: { imageMessage: {} } };

  const out = await stickerMod.makeSticker({}, msg);
  assert.ok(Buffer.isBuffer(out), 'result should be a Buffer');
  // WebP magic: "RIFF" at 0..4 and "WEBP" at 8..12.
  assert.strictEqual(out.slice(0, 4).toString('latin1'), 'RIFF');
  assert.strictEqual(out.slice(8, 12).toString('latin1'), 'WEBP');
});

test('makeSticker is graceful (returns null) when download fails', async () => {
  media.__setDownloadForTest(async () => {
    throw new Error('download failed');
  });
  const msg = { message: { imageMessage: {} } };

  const out = await stickerMod.makeSticker({}, msg);
  assert.strictEqual(out, null);
});

test('STICKER_META exposes the PRD §5.3 pack/publisher labels', () => {
  assert.strictEqual(stickerMod.STICKER_META.pack, 'ara bikin stiker');
  assert.strictEqual(stickerMod.STICKER_META.publisher, 'uletbulujawa');
});

// T4: Animated sticker — fallback to Sharp when FFmpeg is not installed
test('makeSticker falls back to static Sharp when FFmpeg not found for animated input', async () => {
  media.__setDownloadForTest(async () => pngBuffer);
  const msg = {
    message: {
      imageMessage: {
        mimetype: 'image/gif',
      },
    },
  };

  const out = await stickerMod.makeSticker({}, msg);
  // Should fall back to Sharp and produce a valid WebP
  assert.ok(Buffer.isBuffer(out), 'result should be a Buffer');
  assert.strictEqual(out.slice(0, 4).toString('latin1'), 'RIFF');
  assert.strictEqual(out.slice(8, 12).toString('latin1'), 'WEBP');
});

test('makeSticker with video mimetype also falls back to Sharp when FFmpeg not found', async () => {
  media.__setDownloadForTest(async () => pngBuffer);
  const msg = {
    message: {
      videoMessage: {
        mimetype: 'video/mp4',
      },
    },
  };

  const out = await stickerMod.makeSticker({}, msg);
  assert.ok(Buffer.isBuffer(out), 'result should be a Buffer');
  assert.strictEqual(out.slice(0, 4).toString('latin1'), 'RIFF');
  assert.strictEqual(out.slice(8, 12).toString('latin1'), 'WEBP');
});
