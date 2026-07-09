# ARA — NATURALNESS + BUG FIX PLAN

Status: T15 (remaining)

## T15 — Strip `|||` Delimiter from Short Replies

**File:** src/naturalize.js

**Bug:** LLM emits `|||` as multi-message separator, but T7 only splits when `reply.length >= 100`. For short replies (<100 chars) the `|||` delimiter leaks into the user-facing message.

**Fix:** Add a `|||` stripping step in `naturalizeReply()` to clean the delimiter before any other processing:

```js
// Remove multi-message delimiter (only survives for short replies; long ones are split in pipeline)
reply = reply.replace(/\s*\|\|\|\s*/g, ' ').replace(/\s+/g, ' ').trim();
```

**Tradeoff:**
- + Defensive: if pipeline logic ever changes or edge cases slip through, `naturalizeReply` catches them.
- + Zero risk: `|||` never appears in legitimate conversational text.
- + Consistent with existing guard pattern (strip emojis, fix formatting, etc).
- - Slightly redundant with pipeline split for long replies — but the cost is one regex, not worth optimizing.
- - Alternative (strip only in pipeline before split) would miss edge cases where `|||` survives after threshold check; this is safer.
