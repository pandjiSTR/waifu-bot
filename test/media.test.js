// Tests for src/media.js — fully offline.
//  - describeImage: fake sock.downloadMediaMessage + fake Ollama client (via
//    llm.__setClientForTest seam). No network / Redis.
//  - extractPdfText: a real tiny PDF fixture generated in-process.
import { test, after, before } from 'node:test';
import assert from 'node:assert';

let media;
let llm;
let circuit;

before(async () => {
  process.env.OLLAMA_API_KEY = 'test-key';
  media = await import('../src/media.js');
  llm = await import('../src/llm.js');
  circuit = await import('../src/circuit.js');
});

after(() => {
  llm.__setClientForTest(null);
  circuit.__reset();
});

// Minimal valid PDF with a single line of text (hand-built, with xref).
function makeTinyPdf(text) {
  const objs = [];
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objs.push(
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'
  );
  const stream = `BT /F1 14 Tf 40 250 Td (${text}) Tj ET`;
  objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((off) => {
    pdf += String(off).padStart(10, '0') + ' 00000 n \n';
  });
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

test('describeImage returns a description using a fake client', async () => {
  circuit.__reset();
  llm.__setClientForTest({
    async chat({ messages }) {
      // images must be attached to the user message.
      const user = messages.find((m) => m.role === 'user');
      assert.ok(Array.isArray(user.images) && user.images.length === 1);
      assert.ok(typeof user.images[0] === 'string' && user.images[0].length > 0);
      return { message: { content: 'seekor kucing oranye' } };
    },
  });

  const sock = {
    downloadMediaMessage: async () => Buffer.from('fake-image-bytes'),
  };
  const msg = { message: { imageMessage: { caption: 'apa ini?' } } };

  const out = await media.describeImage(sock, msg, 'apa ini?');
  assert.strictEqual(out, 'seekor kucing oranye');
});

test('describeImage returns neutral fallback when download fails', async () => {
  circuit.__reset();
  llm.__setClientForTest({
    async chat() {
      return { message: { content: 'should-not-be-used' } };
    },
  });
  const sock = {
    downloadMediaMessage: async () => {
      throw new Error('download failed');
    },
  };
  const msg = { message: { imageMessage: {} } };

  const out = await media.describeImage(sock, msg, '');
  assert.match(out, /belum bisa lihat gambar/);
});

test('extractPdfText extracts text from a real tiny PDF', async () => {
  const buf = makeTinyPdf('Halo Dunia PDF test 123');
  const text = await media.extractPdfText(buf);
  assert.match(text, /Halo Dunia PDF test 123/);
});

test('extractPdfText returns empty string on invalid input', async () => {
  assert.strictEqual(await media.extractPdfText(null), '');
  const out = await media.extractPdfText(Buffer.from('not a pdf at all'));
  assert.strictEqual(out, '');
});

test('getMediaBuffer returns null on download failure', async () => {
  const sock = {
    downloadMediaMessage: async () => {
      throw new Error('boom');
    },
  };
  const out = await media.getMediaBuffer(sock, { message: {} });
  assert.strictEqual(out, null);
});

test('getMediaBuffer passes reuploadRequest option to download', async () => {
  const sock = {
    updateMediaMessage: () => {},
    downloadMediaMessage: (...args) => {
      sock.__callArgs = args;
      return Buffer.from('img');
    },
  };
  const out = await media.getMediaBuffer(sock, {});
  assert.ok(Buffer.isBuffer(out));
  assert.strictEqual(out.toString(), 'img');
  const opts = sock.__callArgs[3];
  assert.ok(opts && typeof opts === 'object');
  assert.strictEqual(opts.reuploadRequest, sock.updateMediaMessage);
});
