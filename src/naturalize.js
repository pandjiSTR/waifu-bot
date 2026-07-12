// Generic, persona-agnostic reply normalization.
//
// This module performs ONLY structural/text cleanup that is safe for any
// persona: trimming, collapsing excess blank lines / runs of spaces, and
// removing a single wrapping markdown code fence when it is safe to do so.
//
// It does NOT touch the *voice* of the reply. Per Design Principle #1
// (AGENTS.md) and PRD §5.7, persona-specific filler expressions, typo
// "correction", and vowel-over-extension fixing must come from
// `personality.txt` — NOT from hardcoded code here.
//
// TODO(persona-filler): if PRD §5.7's "filler from personality.txt" is needed,
// read the filler list from the personality config (load via personality.js)
// and apply it HERE. Do not hardcode any persona string in this file.

/**
 * Strip a single wrapping markdown code fence, but ONLY when the entire message
 * is fenced and there is no inline/embedded fence (so an intentionally fenced
 * code block is left intact). When in doubt, return the text unchanged.
 * @param {string} text
 * @returns {string}
 */
function stripWrappingFence(text) {
  // Block fence: ```lang\n ... \n```
  const block = text.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (block) {
    if (!block[1].includes('```')) return block[1];
    return text; // inline fence inside -> leave as-is
  }
  // Single-line fence: ```code``` (no newline, no inner fence)
  const inline = text.match(/^```([\s\S]*)```$/);
  if (inline && !inline[1].includes('\n') && !inline[1].includes('```')) {
    return inline[1];
  }
  return text;
}

/**
 * Normalize a reply (pure, no I/O).
 *
 * - trims surrounding whitespace
 * - collapses 3+ consecutive newlines down to 2
 * - collapses runs of 2+ spaces into a single space (newlines preserved)
 * - removes a single wrapping markdown code fence when safe
 * - drops a trailing line that is only an ellipsis artifact ("...", "…")
 *
 * Never alters the persona voice or adds filler.
 *
 * @param {string} text
 * @returns {string}
 */
/**
 * Detect whether a text contains a laugh expression.
 *
 * @param {string} text
 * @returns {boolean}
 */
const LAUGH_PATTERN = 'wkakwkw|(?:wk)+|awikwok|akwo[a-z]+';
export function hasLaugh(text) {
  // Fresh, non-global regex each call — `test()` on a /g regex mutates
  // lastIndex and would give alternating results across calls.
  return new RegExp(LAUGH_PATTERN, 'i').test(String(text ?? ''));
}

/**
 * Limit laugh expressions in a reply. By default keeps at most ONE laugh
 * (the first); pass { max: 0 } to strip them all.
 *
 * This is a behavioral guard (per explicit instruction) — the allowed laugh
 * tokens mirror the list in personality.txt. It never invents persona voice;
 * it only thins out redundant laughs so Ara doesn't spam "wkwk" every line.
 * Callers use { max: 0 } when Ara already laughed recently in the conversation
 * (cross-reply frequency control).
 *
 * @param {string} text
 * @param {{max?:number}} [opts]
 * @returns {string}
 */
export function guardLaughs(text, { max = 1 } = {}) {
  const t0 = String(text ?? '');
  const re = new RegExp(LAUGH_PATTERN, 'gi');
  const matches = t0.match(re);
  if (!matches || matches.length <= max) return t0.trim();

  let kept = 0;
  let t = t0.replace(re, (m) => {
    if (kept < max) {
      kept += 1;
      return m;
    }
    return '';
  });

  // Clean up dangling artifacts left by removed laughs.
  t = t
    .replace(/\s+([,.!?])/g, '$1') // "halo ." -> "halo."
    .replace(/ {2,}/g, ' ') // double spaces
    .replace(/\s+/g, (s) => (s.includes('\n') ? s : ' ')) // collapse spaces only
    .trim();
  return t;
}

const TRAILING_LAUGH_RE = new RegExp('(' + LAUGH_PATTERN + ')\\s*$', 'i');
const ALL_LAUGH_RE = new RegExp(LAUGH_PATTERN, 'gi');

export function stripTrailingLaugh(text) {
  const t = String(text ?? '').trim();
  if (!t) return t;

  const match = t.match(TRAILING_LAUGH_RE);
  if (!match) return t;

  const all = t.match(ALL_LAUGH_RE);
  if (all && all.length === 1 && t === match[0]) {
    return t;
  }
  if (all && all.length === 1) {
    return t.slice(0, match.index).trimEnd();
  }

  return t;
}

export function naturalizeReply(text) {
  let t = String(text ?? '').trim();

  // Strip a wrapping code fence before other normalization so the inner
  // content is treated like normal prose.
  t = stripWrappingFence(t);

  // Remove multi-message delimiter ("|||") — it's an internal artifact the LLM
  // may emit; pipeline splits on \n\n, so this should never reach the user.
  t = t.replace(/\s*\|\|\|\s*/g, ' ');

  // Collapse runs of 3+ newlines to at most 2.
  t = t.replace(/\n{3,}/g, '\n\n');

  // Collapse runs of 2+ spaces into one (keeps single spaces/newlines).
  t = t.replace(/ {2,}/g, ' ');

  // Remove a trailing standalone line of only dots (ellipsis artifact).
  // Lines that mix real text with "..." are preserved.
  t = t.replace(/(?:^|\n)[ \t]*\.{3,}[ \t]*$/g, '').trimEnd();

  return t;
}

export default { naturalizeReply, stripTrailingLaugh };
