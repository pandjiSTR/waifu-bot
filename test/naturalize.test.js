// Tests for src/naturalize.js — generic, persona-agnostic normalization.
import { test } from 'node:test';
import assert from 'node:assert';
import { naturalizeReply, guardLaughs, hasLaugh } from '../src/naturalize.js';

test('naturalizeReply trims surrounding whitespace', () => {
  assert.strictEqual(naturalizeReply('   hai   '), 'hai');
});

test('naturalizeReply collapses 3+ newlines down to 2', () => {
  assert.strictEqual(naturalizeReply('a\n\n\n\n\nb'), 'a\n\nb');
});

test('naturalizeReply collapses runs of spaces to a single space', () => {
  assert.strictEqual(naturalizeReply('a    b'), 'a b');
});

test('naturalizeReply leaves normal text unchanged', () => {
  const t = 'Halo! Apa kabar hari ini?';
  assert.strictEqual(naturalizeReply(t), t);
});

test('naturalizeReply does not alter persona voice', () => {
  const t = 'hmm, yaudah sih. tapi jangan lupa makan ya';
  assert.strictEqual(naturalizeReply(t), t);
});

test('naturalizeReply strips a wrapping code fence', () => {
  assert.strictEqual(naturalizeReply('```\nhalo\n```'), 'halo');
  assert.strictEqual(naturalizeReply('```js\nhalo\n```'), 'halo');
});

test('naturalizeReply leaves inline-fenced code intact', () => {
  const t = 'pakai `npm test` ya';
  assert.strictEqual(naturalizeReply(t), t);
});

test('naturalizeReply removes a lone trailing ellipsis line', () => {
  assert.strictEqual(naturalizeReply('halo\n...'), 'halo');
});

test('naturalizeReply keeps a same-line trailing ellipsis (not an artifact)', () => {
  assert.strictEqual(naturalizeReply('tunggu...'), 'tunggu...');
});

test('naturalizeReply returns empty string for empty input', () => {
  assert.strictEqual(naturalizeReply(''), '');
});

test('hasLaugh detects common laugh tokens', () => {
  assert.strictEqual(hasLaugh('wkwk lucu banget'), true);
  assert.strictEqual(hasLaugh('akwokwkw masa sih'), true);
  assert.strictEqual(hasLaugh('wk wk'), true);
  assert.strictEqual(hasLaugh('halo apa kabar'), false);
});

test('hasLaugh does not suffer global-regex lastIndex state bug', () => {
  assert.strictEqual(hasLaugh('wkwk'), true);
  assert.strictEqual(hasLaugh('wkwk'), true);
  assert.strictEqual(hasLaugh('serius'), false);
  assert.strictEqual(hasLaugh('wkwk'), true);
});

test('guardLaughs keeps at most one laugh by default', () => {
  assert.strictEqual(guardLaughs('wkwk lucu wkwk banget wkwk'), 'wkwk lucu banget');
});

test('guardLaughs strips all laughs when max is 0', () => {
  assert.strictEqual(guardLaughs('wkwk lucu wkwk banget', { max: 0 }), 'lucu banget');
  assert.strictEqual(guardLaughs('wkwk aja', { max: 0 }), 'aja');
});

test('guardLaughs keeps text unchanged when no/within limit', () => {
  assert.strictEqual(guardLaughs('halo apa kabar'), 'halo apa kabar');
  assert.strictEqual(guardLaughs('wkwk lucu', { max: 0 }), 'lucu');
});
