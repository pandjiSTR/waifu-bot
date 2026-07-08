gak# Naturalness Hardening — 6 Tickets

## Ticket 1 — Fix Group Mention
**File:** `src/pipeline.js`
**Line:** 187
**Before:**
```js
if (!mentionedBot && !quotedBot && !bodyLower.includes(COMMAND_PREFIX)) {
```
**After:**
```js
if (!mentionedBot && !quotedBot && !/\bara+/i.test(bodyLower)) {
```
**Effect:** `ara`/`araaaa` kepanggil; `cara`/`amarah`/`bara`/`gara-gara` gak.

---

## Ticket 2 — Multi-Message Reply (split + follow-up, 1 LLM call)
**File:** `src/pipeline.js`

### 2a. Multi-message instruction
Tambah konstanta baru (di dekat `BADWORD_TONE_INSTRUCTION`, sekitar line 349):
```js
const MULTI_MESSAGE_INSTRUCTION = `\n\nKadang, kalau ada hal lanjutan yang natural (oh ya, btw, info tambahan), pisahkan respons jadi 2 chat terpisah pakai delimiter "|||". Jangan dipaksa kalau 1 chat cukup. Tiap bagian harus berdiri sendiri dan nyambung.`;
```
Lalu append ke `systemPrompt` setelah `BADWORD_TONE_INSTRUCTION` (sekitar line 351):
```js
systemPrompt += MULTI_MESSAGE_INSTRUCTION;
```

### 2b. Split & send loop
**Lines:** 524–530 (ganti seluruh block)
**Before:**
```js
reply = naturalizeReply(reply);

const delivery = await sendChunks(ctx.sock, userId, reply, {
  sendMessage: ctx.sock?.sendMessage?.bind(ctx.sock),
});

if (delivery.failed) {
  logger.warn({ delivery }, 'sendChunks failed to deliver all chunks');
}
```
**After:**
```js
reply = naturalizeReply(reply);

const segments = reply
  .split(/\n\n|\s*\|\|\|\s*/)
  .map(s => s.trim())
  .filter(Boolean);

let deliveryFailed = false;
for (let i = 0; i < segments.length; i++) {
  if (i > 0) {
    await new Promise(r => setTimeout(r, 1500));
    await ctx.sock?.sendPresenceUpdate('composing', userId).catch(() => {});
  }
  const delivery = await sendChunks(ctx.sock, userId, segments[i], {
    sendMessage: ctx.sock?.sendMessage?.bind(ctx.sock),
  });
  if (delivery.failed) {
    deliveryFailed = true;
    logger.warn({ delivery }, 'sendChunks failed for segment');
  }
}
```
**Notes:**
- `sendChunks` otomatis handle chunking per-segment berdasarkan panjang.
- Delay 1.5s + typing indicator sebelum tiap segmen kecuali yang pertama.
- `addMessage` tetap simpan full `reply` (line 539–549) — gak berubah.

---

## Ticket 3 — Typing indicator antar-segmen
Sudah ada di `baileys.js` (1 `sendPresenceUpdate('composing')` sebelum `processLLM`).
Ticket 2b menambahkan typing di *antar* segmen (sebelum segmen ke-2 dst).

---

## Ticket 4 — personality.txt edits (dari reference.md)
**File:** `personality.txt`

### 4b. Dictionary gaul (line 82)
**Before:**
```
JANGAN pake kata gaul yang dipaksa: santuy, curcol, gercep, gaje, slebew, sokin, sabi.
```
**After:**
```
JANGAN pake kata gaul yang dipaksa: santuy, curcol, gercep, gaje, slebew, sokin, sabi, bucin, baper.
```

### 4c. Aturan ketawa (line 94)
**Before:**
```
Variasiin ketawa, jangan cuma "wkwkwk" doang: "awikwok", "akwowkaok", "wkakwkw", "akwokwkw" — gak tiap kalimat, muncul natural sesuai konteks
```
**After:**
```
KETAWA JANGAN BANYAK. Maksimal 1 dari 10 chat, dan cuma kalau beneran lucu/ngakak — jangan di tiap balasan, jangan di akhir tiap respon. Variasiin kalau dipake: "awikwok", "akwowkaok", "wkakwkw", "akwokwkw" (bukan cuma "wkwkwk").
```

---

## Ticket 5 — Harden Auto-chat (fix Gap A)
**File:** `src/autochat.js`

### 5a. Task instruction
**Lines:** 140–143
**Before:**
```js
const taskInstruction =
  'Kirim SATU pesan proaktif singkat kepada owner seolah Ara memulai obrolan. ' +
  '1-3 kata, natural ala WA Indonesia, tanpa emoji. ' +
  'Jangan setiap saat — hanya kalau relevan/ringan.';
```
**After:**
```js
const taskInstruction =
  'Kirim SATU pesan proaktif singkat kepada owner seolah Ara memulai obrolan. ' +
  '1-3 kata, natural ala WA Indonesia, tanpa emoji. ' +
  'Jangan mulai dengan hai/halo. Jangan tanya soal skripsi/jurnal/tugas kuliah. ' +
  '1 kalimat aja.';
```

### 5b. Naturalize reply
**Lines:** 154–161 (ganti block)
**Before:**
```js
if (text) {
  const chunksFn = ctx.sendChunks || sendChunks;
  await chunksFn(sock, ownerJid, text);

  // Update last-sent timestamp
  if (redis) {
    await redis.set('waifu:autochat:last', String(Date.now()));
  }
}
```
**After:**
```js
if (text) {
  const { sendChunks } = await import('./chunks.js');
  const { naturalizeReply } = await import('./naturalize.js');
  const normalized = naturalizeReply(text);
  await sock?.sendPresenceUpdate('composing', ownerJid).catch(() => {});
  await sendChunks(sock, ownerJid, normalized);

  if (redis) {
    await redis.set('waifu:autochat:last', String(Date.now()));
  }
}
```

---

## Ticket 6 — Vision reply cap (fix Gap B)
**File:** `src/pipeline.js`

### 6a. Set flag saat imageMessage
**Lines:** 374–391 (tambah `isImageReply` flag)
**Before:**
```js
let mediaContext = ctx.mediaContext;
if (!mediaContext && ctx.message?.message) {
  const msgNode = ctx.message.message;
  try {
    if (msgNode.imageMessage) {
      const desc = await describeImage(ctx.sock, ctx.message, body);
      if (desc) mediaContext = `[GAMBAR] ${desc}`;
    } else if (
```
**After:**
```js
let mediaContext = ctx.mediaContext;
let isImageReply = false;
if (!mediaContext && ctx.message?.message) {
  const msgNode = ctx.message.message;
  try {
    if (msgNode.imageMessage) {
      isImageReply = true;
      const desc = await describeImage(ctx.sock, ctx.message, body);
      if (desc) mediaContext = `[GAMBAR] ${desc}`;
    } else if (
```

### 6b. Cap panjang setelah naturalizeReply
**Lines:** setelah `reply = naturalizeReply(reply);` (sekitar line 525), sebelum split loop (T2b):
```js
reply = naturalizeReply(reply);

if (isImageReply) {
  const sentences = reply.split(/(?<=[.!?])\s+/);
  if (sentences.length > 2) {
    reply = sentences.slice(0, 2).join(' ');
  }
}
// ... T2b split loop starts here
```

---

## Files affected (summary)
| File | Chang |
|---|---|
| `src/pipeline.js` | T1 (regex), T2a (+MULTI_MESSAGE_INSTRUCTION), T2b (split loop), T6a (isImageReply flag), T6b (vision cap) |
| `src/autochat.js` | T5 (taskInstruction, naturalizeReply, typing) |
| `personality.txt` | T4b (+bucin,baper), T4c (perketat ketawa) |

---

## Verifikasi
- `npm run lint` — harus clean (0 errors)
- `npm test` — semua test (147+) harus lolos
- Manual test:
  - Grup: `cara bobo` → gak kepanggil; `ara haloo` → kepanggil; `araaaaa` → kepanggil
  - Info request → reply kepecah ≥2 chat dengan jeda + typing
  - Kirim gambar → balasan ≤2 kalimat
  - Tunggu auto-chat → gak ada "halo"/"skripsi"
  - Pantau log: `bucin`/`baper`/`wkwkwk` jarang atau gak muncul

---

## Execution order
1. `personality.txt` edits (T4b, T4c)
2. `src/autochat.js` (T5)
3. `src/pipeline.js` — T1, T2, T6 (semua file yang sama, bisa 1 commit)
4. Push → deploy di Render
5. Test manual