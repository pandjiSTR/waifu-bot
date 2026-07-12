// Tests for src/naturalize.js — generic, persona-agnostic normalization.
import { test } from 'node:test';
import assert from 'node:assert';
import { naturalizeReply, guardLaughs, hasLaugh, stripTrailingLaugh } from '../src/naturalize.js';

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
  assert.strictEqual(hasLaugh('akwok'), true);
  assert.strictEqual(hasLaugh('akwowk'), true);
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

test('guardLaughs dedup akwo variant laughs', () => {
  assert.strictEqual(guardLaughs('akwok tes akwowk lagi', { max: 1 }), 'akwok tes lagi');
});

test('guardLaughs strips all laughs when max is 0', () => {
  assert.strictEqual(guardLaughs('wkwk lucu wkwk banget', { max: 0 }), 'lucu banget');
  assert.strictEqual(guardLaughs('wkwk aja', { max: 0 }), 'aja');
});

test('guardLaughs keeps text unchanged when no/within limit', () => {
  assert.strictEqual(guardLaughs('halo apa kabar'), 'halo apa kabar');
  assert.strictEqual(guardLaughs('wkwk lucu', { max: 0 }), 'lucu');
});

test('stripTrailingLaugh strips trailing laugh when it is the only laugh', () => {
  assert.strictEqual(stripTrailingLaugh('oke nanti cek dulu wkwkwk'), 'oke nanti cek dulu');
  assert.strictEqual(stripTrailingLaugh('iya sih wkakwkw'), 'iya sih');
  assert.strictEqual(stripTrailingLaugh('makasih akwokwkw'), 'makasih');
  assert.strictEqual(stripTrailingLaugh('oke nanti awikwok'), 'oke nanti');
});

test('stripTrailingLaugh keeps laugh when it is at the start or middle', () => {
  assert.strictEqual(stripTrailingLaugh('wkwkwk lucu banget'), 'wkwkwk lucu banget');
  assert.strictEqual(stripTrailingLaugh('lucu akwokwkw banget'), 'lucu akwokwkw banget');
});

test('stripTrailingLaugh keeps pure laugh reply untouched', () => {
  assert.strictEqual(stripTrailingLaugh('wkwkwk'), 'wkwkwk');
  assert.strictEqual(stripTrailingLaugh('akwokwkw'), 'akwokwkw');
});

test('stripTrailingLaugh keeps text without laugh unchanged', () => {
  assert.strictEqual(stripTrailingLaugh('halo apa kabar'), 'halo apa kabar');
  assert.strictEqual(stripTrailingLaugh(''), '');
});
