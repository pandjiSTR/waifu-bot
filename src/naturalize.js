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
export function naturalizeReply(text) {
  let t = String(text ?? '').trim();

  // Strip a wrapping code fence before other normalization so the inner
  // content is treated like normal prose.
  t = stripWrappingFence(t);

  // Collapse runs of 3+ newlines to at most 2.
  t = t.replace(/\n{3,}/g, '\n\n');

  // Collapse runs of 2+ spaces into one (keeps single spaces/newlines).
  t = t.replace(/ {2,}/g, ' ');

  // Remove a trailing standalone line of only dots (ellipsis artifact).
  // Lines that mix real text with "..." are preserved.
  t = t.replace(/(?:^|\n)[ \t]*\.{3,}[ \t]*$/g, '').trimEnd();

  return t;
}

export default { naturalizeReply };
