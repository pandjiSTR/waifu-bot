# ARA — NATURALNESS + BUG FIX PLAN

Status: APPROVED (gas). Execution in progress.

## Background
Dari log chat grup (Panji <-> "Bakwan Jagung"=Ara) + investigasi kode ditemukan
beberapa masalah produksi + 1 dashboard polish:

1. Bot flood (1 trigger -> banyak bubble pendek)
2. Ketawa berlebihan (wkwk di ~5/12 balasan, padahal reference.md ~2%)
3. Mirror / loop / scold user (ngulang pertanyaan, niru frasa, ngomelin user)
4. Ara buta konteks chat grup tanpa mention "ara"
5. Ara ke-panggil pas user balas chat orang lain (bukan Ara)
6. Dedup in-memory only -> bot bisa baca 1 chat berkali kali (restart/deploy)
7. Dashboard tampilkan user & grup pakai ID, bukan nama

Plus tuning: GROUP_MAX 50 -> 30.

---

## T7 — Multi-bubble HANYA untuk balasan panjang (tanpa cap)

File: src/pipeline.js (split loop ~line 535 + MULTI_MESSAGE_INSTRUCTION ~line 19/352)

Fix:
- Split cuma kalau `reply.length >= 100`. Tidak ada cap jumlah bubble — kalau
  balasan panjang, boleh pecah jadi banyak bubble (tergantung panjangnya).
- Instruksi: "Kalau panjang (banyak poin/cerita), pisah jadi beberapa chat
  natural pakai `|||` atau paragraph. Kalau pendek, kirim 1 chat utuh — jangan
  pecah tiap baris."

Tradeoff:
- + Panjang terpisah (sesuai maumu), pendek gak flood.
- - Threshold 100 tunable. Kalau kekecil, pendek ke-split; kebesar, panjang jadi 1 bubble.
- - Tanpa cap, balasan sangat panjang bisa jadi banyak bubble (itu memang diinginkan).

---

## T8 — Laugh Guard (natural)

File: src/naturalize.js

Fix: Hitung ekspresi ketawa (wkwk|awikwok|akwowkaok|wkakwkw|akwokwkw|wk).
Kalau >1 per reply -> simpan yang PERTAMA, buang sisanya bersih (gak ninggalin
sisa/pendding punctuation).

Tradeoff:
- + Ketawa dijaga keras (T4 persona gagal di log), tapi tetap natural.
- - Kalau model bikin 1 ketawa legit di awal + 1 di akhir, yang akhir ilang. Minor.
- - Butuh tes naturalize biar gak salah potong kata normal.

---

## T9 — Persona: Stop Mirror / Loop / Scold

File: personality.txt

Fix: Tambah paragraf:
"JANGAN ngulang pertanyaan user berurutan. JANGAN niru frasa user secara persis.
JANGAN ngomelin/mengkritik user (typo, berisik, dll). JANGAN mirror emosi negatif user."

Tradeoff:
- + Bot warm, gak judgmental/weird. Zero risk ke fitur lain.
- - Hampir gak ada.

---

## T10 — Group Context Persistence

File: src/baileys.js (handler messages.upsert) + src/pipeline.js:322-328

Fix:
1. baileys.js: import addMessage dari ./context.js; simpan SEMUA pesan grup ke
   window SEBELUM shouldProcess:
   ```js
   if (isGroup) {
     await addMessage(redis, ctx.jid, {
       sender: m.pushName || ctx.sender,
       text: body,
       timestamp: new Date().toISOString(),
     }, true);
   }
   if (!(await shouldProcess(body, ctx))) continue;
   ```
2. pipeline.js:322-328: guard jadi `if (!isGroup) { await addMessage(...) }`
   biar gak duplikat.
3. pipeline.js:559 (balasan Ara, sender 'ara') tetap.

Tradeoff:
- + Ara paham konteks obrolan grup tanpa mention. Pakai m.pushName -> Ara lihat nama.
- - Window grup penuh lebih cepat -> ditangani T12 (GROUP_MAX 30).
- - Pesan gambar tanpa mention: cuma caption yg kesimpan. Acceptable.

---

## T11 — Reply ke Orang Lain Salah Panggil Bot

File: src/pipeline.js:186

Fix: Ganti `const quotedBot = Boolean(contextInfo?.quotedMessage);` jadi:
```js
const quotedParticipant = contextInfo?.participant;
const quotedBot = quotedParticipant
  ? normalizeNumber(quotedParticipant) === normalizeNumber(botJid)
  : false;
```
(normalizeNumber sudah ada di pipeline.js:61.)

Tradeoff:
- + Balas ke orang lain -> bot diam; balas ke Ara -> tetap respon.
- - Edge: kalau participant gak keisi untuk reply aneh, quotedBot=false (safe skip).

---

## T12 — GROUP_MAX 50 -> 30

File: src/context.js:8
```js
const GROUP_MAX = parseInt(process.env.MAX_GROUP_CONTEXT_MESSAGES || '30', 10);
```

Tradeoff:
- + Cukup buat konteks ~10 round-trip, gak bloat prompt (num_ctx grup = 8192).
- - Ara "lupa" obrolan >30 pesan lalu. Acceptable.

---

## T13 — Redis-backed Dedup (fix "baca 1 chat berkali kali")

File: src/pipeline.js shouldProcess (lines 158-161)

Fix: Ganti in-memory-only dedup jadi memory + Redis NX:
```js
pruneSeen();
const mid = ctx.messageId;
if (mid && seen.has(mid)) return false;
if (mid && ctx.redis) {
  try {
    const r = await ctx.redis.set(`waifu:seen:${mid}`, '1', 'EX', 300, 'NX');
    if (r === null) return false; // sudah diproses -> skip
  } catch { /* fall back to memory-only */ }
}
if (mid) seen.set(mid, Date.now() + SEEN_TTL_MS);
```

Tradeoff:
- + FIX DEFINITIF buat "baca 1 chat berkali kali". SET NX atomic, 1 messageId = 1
  proses di semua instance & lintas restart. Murah (1 round-trip/pesan).
- - TTL 5 menit: pesan SAMA persis dalam 5 menit ke-2 di-skip. Rare.
- - Kalau Redis down -> fallback memory (OK single-instance).

---

## T14 — Dashboard: User & Grup pakai Nama (bukan ID)

File: src/baileys.js (capture nama) + src/api-skeleton.js (resolve nama) +
      src/memory.js (helper opsional) + dashboard (minor, auto-render name)

Masalah: Dashboard (overview friends, /api/friends, /api/chat/contacts,
top-friends) tampilkan `name: number` (nomor/JID). User & grup kelihatan pakai ID.

Fix:
1. Tambah 2 hash Redis:
   - `waifu:friends:names`  (number -> displayName dari pushName)
   - `waifu:groups:names`   (groupJid -> subject dari groupMetadata)
2. baileys.js messages.upsert handler (bareng T10):
   - Private: `if (m.pushName) redis.hset('waifu:friends:names', number, m.pushName)`
   - Group: cache subject — fetch `sock.groupMetadata(jid).subject` (try/catch,
     cuma kalau belum ada di hash), `redis.hset('waifu:groups:names', jid, subject)`.
3. Helper resolusi nama (di memory.js atau api-skeleton.js):
   `resolveName(redis, id, namesHash)` -> baca hash, fallback ke id.
4. Update endpoint:
   - overview (line 107-109), /api/friends (143), /api/chat/contacts (354),
     top-friends (514) -> pakai resolveName.
   - /api/chat/contacts: IKUT sertakan `waifu:grup:*` sebagai kontak
     `isGroup:true`, name dari `waifu:groups:names`.
   - /api/chat/context: deteksi groupJid (mengandung '@g.us') -> baca
     `waifu:grup:` bukan `waifu:ctx:`.
5. Dashboard JS sudah render `friend.name`/`contact.name` -> otomatis pakai nama.
   (Opsional: badge "GRUP" di contact item.)

Tradeoff:
- + Dashboard kelihatan rapi: user & grup pakai nama asli.
- + Grup muncul di daftar chat dengan nama.
- - Butuh 1 network call groupMetadata per grup baru (di-cache, jarang).
- - Nama dari pushName bisa kadaluarsa (user ganti nama WA) -> fallback ke number.
- - Group context viewer jadi baca waifu:grup: (perubahan kecil di endpoint).

---

## FILES AFFECTED

| File | Tickets |
|---|---|
| src/pipeline.js | T7 (split), T9 (instruction), T10 (guard addMessage), T11 (quotedBot), T13 (dedup) |
| src/baileys.js | T10 (save all group msgs), T14 (capture nama user & grup) |
| src/naturalize.js | T8 (laugh guard) |
| src/context.js | T12 (GROUP_MAX 30) |
| src/api-skeleton.js | T14 (resolve nama di 4 endpoint + grup di contacts/context) |
| src/memory.js | T14 (helper resolveName, opsional) |
| personality.txt | T9 (mirror/loop/scold) |
| dashboard/*.js | T14 (minor: badge GRUP, auto-render name sudah ada) |

---

## EXECUTION ORDER
1. personality.txt (T9)
2. src/context.js (T12)
3. src/naturalize.js (T8)
4. src/baileys.js (T10 + T14 capture)
5. src/pipeline.js (T7 + T10 guard + T11 + T13)
6. src/api-skeleton.js (T14 resolve + grup)
7. npm run lint
8. npm test
9. commit + push -> Render deploy

---

## VERIFICATION
- npm run lint -> clean
- npm test -> 219+ pass
- Manual grup: reply ke org lain -> Ara diam; mention "ara" -> respon; chat tanpa
  mention laku mention -> Ara paham; 1 trigger pendek -> 1 bubble; balasan panjang
  -> banyak bubble; ketawa jarang; pesan sama 2x -> 1 respon.
- Dashboard: user & grup tampil nama, bukan nomor/JID.
