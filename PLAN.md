# ARA — NATURALNESS + BUG FIX PLAN

Status: T15 + T16 + T17 + T18 done

## T15 — Strip `|||` Delimiter from Short Replies

**File:** src/naturalize.js + src/chunks.js (wire guard)

**Bug:** LLM emits `|||` as multi-message separator, but T7 only splits when `reply.length >= 100`. For short replies (<100 chars) the `|||` delimiter leaks into the user-facing message.

**Fix:** `naturalizeReply()` strips `|||` → space; plus a wire-level guard in `sendChunks` (final delivery boundary) strips `|||` regardless of code path.

**Tradeoff:**
- + Defensive: `|||` can never reach the user from any path.
- + Zero risk: `|||` never appears in legitimate conversational text.
- - Minor redundancy between the two strips (one extra regex scan, negligible).

## T16 — Group Reply to Bot Not Detected (regression, FIXED via main-branch approach)

**Files:** src/pipeline.js (`botSentIds` Set, `trackBotMessage`, `shouldProcess`, `processLLM`), src/chunks.js (`sendChunks` returns `ids`), src/baileys.js (`ctx.botJid` capture), src/autochat.js (`normalizeNumber`)

**Root cause:** `revamped` tried to detect "reply to bot" by matching `contextInfo.participant` against the bot's JID (`normalizeNumber`). In production that comparison never matched (Baileys `sock.user.id` carries a `:0` device suffix and/or the participant format differs), so group replies to Ara — and @mentions — silently failed; only the literal "ara" text match survived.

**Fix (mirrors the working `main` branch):**
- `normalizeNumber` strips the `:N` device suffix before removing non-digits (both pipeline.js + autochat.js).
- `baileys.js` captures the bot JID at connection `open` and passes it via `ctx.botJid` (fallback to `sock.user.id`).
- `sendChunks` now returns the `ids` of messages Baileys actually delivered (`result.key.id`).
- `processLLM` (and the circuit fallback) track every sent id via `trackBotMessage` into an in-memory `botSentIds` Set.
- `shouldProcess` detects "reply to Ara" via `contextInfo.stanzaId && botSentIds.has(stanzaId)` — robust, format-independent — OR'd with the @mention and "ara" keyword checks. Replies to other users (unknown stanzaId) stay ignored.

**Tradeoff:**
- + Group replies to Ara now reliably trigger responses regardless of JID/participant format quirks.
- + Same mechanism as `main` (proven in production).
- + @mentions and "ara" keyword still work as before.
- - `botSentIds` is in-memory (resets on restart, 30-min-ish TTL via 10k cap) — matches `main`; a restart briefly forgets very old reply targets. Acceptable.
- - Covers processLLM + circuit fallback; autochat sends to owner in private chat (replies already work there) so not tracked.

## T17 — Ara Masih "wkwk" Terus (laugh frequency)

**File:** src/naturalize.js (`hasLaugh`, `guardLaughs` max param), src/pipeline.js (context-aware suppression)

**Root cause:** `guardLaughs` already limited laughs to ONE per reply, but the model
emits a laugh in *nearly every* reply. So the problem was frequency across the
conversation, not per-reply — every reply still contained one "wkwk".

**Fix:**
- `guardLaughs(text, { max = 1 })` — `max: 0` strips ALL laughs.
- `hasLaugh(text)` — fresh non-global regex (avoids `/g` `lastIndex` state bug).
- `processLLM` checks the recent context window: if Ara's last ≤5 messages contain
  a laugh, the current reply is guarded with `max: 0` (suppressed); otherwise
  `max: 1`. Result: Ara laughs at most ~once per 5 of her messages, not every reply.

**Tradeoff:**
- + Laughs become rare/occasional (matches reference.md ~2%), directly fixing "wkwk mulu".
- + No persona strings hardcoded — pure behavioral guard.
- + `hasLaugh` uses a fresh regex, so repeated calls are correct.
- - If Ara hasn't laughed recently, she may still laugh once per reply in a laughy
  stretch; acceptable (far rarer than before). Could tighten the window later.
- - Lookback is the in-memory/Redis context window (≤5 recent Ara messages).

## T18 — Ara Jadi "Dingin" (warmth rebalance)

**File:** personality.txt (+ reset persisted MOOD in Redis)

**Root cause:** Ara went cold in affectionate moments. Two strong causes:
1. A persisted `MOOD` (e.g. `cuek`/`ngambek`) for the owner was injected every
   prompt via `buildSystemPrompt` (personality.js:115) — overrides warmth across sessions.
2. Recent persona edits over-corrected: T4 `bucin/baper` ban + T9 "JANGAN mirror /
   JANGAN mirror emosi" read by the model as "don't show emotion at all" → flat.
   Plus the flat style examples and the "dingin/kesel/males" AI-rule tone leaking.

**Fix (per user: "selalu hangat kapanpun"; AI-question = option a: short & males, not cold):**
- personality.txt: make warmth an UNCONDITIONAL baseline (Kepribadian header).
- Scope mirror rule: don't copy phrasing verbatim, but always match user's
  warm/romantic tone; never reply flat to affection.
- Scope emosi rule: only negative emotion is banned from mirroring; positive/
  romantic MUST be reciprocated.
- Clarify gaul ban: bucin/baper forbidden only as forced slang words; being
  baper/manja/gombal toward {OWNER_NAME} is encouraged.
- Soften AI-rule tone: short & males-santai but NOT cold/nyuekin; only for "kamu AI?".
- Add warm reply examples for affectionate moments.
- Reset persisted MOOD for the owner (see user steps below).

**Tradeoff:**
- + Ara warm in all situations, still short & natural (no conflict with T7/T17).
- + MOOD reset restores consistency across sessions.
- - Tension "57% 1-3 words" vs "warm" resolved as short-but-warm via examples.
- - AI-question tone softened (a), not removed — Ara stays briefly dismissive there only.
- - Purely persona + MOOD reset; 0 pipeline changes, 0 tests broken.

