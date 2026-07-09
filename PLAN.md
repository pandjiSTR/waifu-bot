# ARA — NATURALNESS + BUG FIX PLAN

Status: T15 + T16 done

## T15 — Strip `|||` Delimiter from Short Replies

**File:** src/naturalize.js + src/chunks.js (wire guard)

**Bug:** LLM emits `|||` as multi-message separator, but T7 only splits when `reply.length >= 100`. For short replies (<100 chars) the `|||` delimiter leaks into the user-facing message.

**Fix:** `naturalizeReply()` strips `|||` → space; plus a wire-level guard in `sendChunks` (final delivery boundary) strips `|||` regardless of code path.

**Tradeoff:**
- + Defensive: `|||` can never reach the user from any path.
- + Zero risk: `|||` never appears in legitimate conversational text.
- - Minor redundancy between the two strips (one extra regex scan, negligible).

## T16 — Group Reply / Mention to Bot Not Detected (regression)

**Files:** src/pipeline.js (`normalizeNumber`, `shouldProcess`, `isStickerRequest`), src/autochat.js (`normalizeNumber`), src/baileys.js (capture bot JID)

**Root cause (two compounding bugs):**
1. `normalizeNumber()` appended the device suffix as digits: `normalizeNumber('6285…:0@s.whatsapp.net')` → `'6285…0'` (extra trailing 0). Baileys 6.x sets `sock.user.id` to `…:0@s.whatsapp.net`, so the bot's normalized number never matched `contextInfo.participant` (no suffix) → reply-to-bot AND @mention detection both failed in groups. Only the literal "ara" text match survived → "ara ga respon reply".
2. `shouldProcess` re-derived `botJid` from `ctx.sock.user.id` per message, which may be unset at arrival time.

**Fix:**
- `normalizeNumber` now strips the `:N` device suffix before removing non-digits (both copies: pipeline.js + autochat.js).
- `baileys.js` captures the bot JID once at connection `open` and passes it via `ctx.botJid` (fallback to `sock.user.id`).
- `shouldProcess` / `isStickerRequest` use `normalizeNumber(ctx.botJid || ctx.sock.user.id)` and compare normalized digits for both mention and quoted-reply.

**Tradeoff:**
- + Group replies to Ara and @mentions now reliably trigger responses; replies to other users stay ignored.
- + Robust to LID / device-suffix / @mention-prefix formats.
- + Capturing bot JID at `open` removes per-message dependence on `sock.user.id`.
- - None significant. Low risk, covered by 3 new tests (reply-to-bot, reply-to-other, LID-format match).

