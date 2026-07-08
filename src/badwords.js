// Static badword list (DATA ONLY — no persona strings, per AGENTS.md #1 / PRD §5.7).
// Detection is deterministic: lowercase + word-boundary (single tokens) or
// substring (multi-word phrases). It only flags; the pipeline decides tone.
//
// PRD §5.7: a detected badword must NOT block the message — it only shifts the
// reply tone to sarcastic (driven by personality.txt), handled in pipeline.js.

// Common Indonesian + English badwords. Kept deliberately small and static;
// expand as needed. Multi-word entries are matched as whole phrases.
export const BADWORDS = [
  // Indonesian
  'anjing',
  'babi',
  'bangsat',
  'bajingan',
  'brengsek',
  'kampret',
  'kontol',
  'memek',
  'pentil',
  'perek',
  'asu',
  'goblok',
  'goblog',
  'tolol',
  'bodoh',
  'idiot',
  'sinting',
  'keparat',
  'setan',
  'laknat',
  'sialan',
  'tai',
  'pipis',
  'jembut',
  'ngentot',
  'entot',
  'coli',
  'pelacur',
  'lonte',
  'cabul',
  // English
  'fuck',
  'fucking',
  'shit',
  'bitch',
  'asshole',
  'bastard',
  'dick',
  'pussy',
  'whore',
  'slut',
  'cunt',
  'retard',
  'motherfucker',
  'dumbass',
];

// Cache compiled regexes (word-boundary, case-insensitive) per single token.
const WORD_RE_CACHE = new Map();

function wordRegex(token) {
  let re = WORD_RE_CACHE.get(token);
  if (!re) {
    // Negative lookbehind/lookahead on [a-z0-9] keeps whole-word matches only
    // (so "anjing" matches "anjing!" but not "menganjing").
    re = new RegExp(`(?<![a-z0-9])${token}(?![a-z0-9])`, 'i');
    WORD_RE_CACHE.set(token, re);
  }
  return re;
}

/**
 * Detect whether text contains a badword.
 * @param {string|null|undefined} text
 * @returns {boolean}
 */
export function detectBadword(text) {
  if (!text) return false;
  const lower = String(text).toLowerCase();

  for (const entry of BADWORDS) {
    if (entry.includes(' ')) {
      // Multi-word phrase: plain substring match.
      if (lower.includes(entry)) return true;
      continue;
    }
    if (wordRegex(entry).test(lower)) return true;
  }
  return false;
}

export default { BADWORDS, detectBadword };
