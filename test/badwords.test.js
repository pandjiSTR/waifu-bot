// Tests for src/badwords.js — pure, deterministic, offline.
import { test } from 'node:test';
import assert from 'node:assert';
import { BADWORDS, detectBadword } from '../src/badwords.js';

test('BADWORDS is a non-empty array of strings', () => {
  assert.ok(Array.isArray(BADWORDS));
  assert.ok(BADWORDS.length > 0);
  assert.ok(BADWORDS.every((w) => typeof w === 'string' && w.length > 0));
});

test('detectBadword returns false for clean text', () => {
  assert.strictEqual(detectBadword('halo ara, apa kabar?'), false);
  assert.strictEqual(detectBadword('terima kasih banyak'), false);
  assert.strictEqual(detectBadword(''), false);
  assert.strictEqual(detectBadword(null), false);
  assert.strictEqual(detectBadword(undefined), false);
});

test('detectBadword returns true on a detected word', () => {
  assert.strictEqual(detectBadword('kau anjing!'), true);
  assert.strictEqual(detectBadword('dasar bajingan'), true);
  assert.strictEqual(detectBadword('what a bastard'), true);
});

test('detectBadword is case-insensitive', () => {
  assert.strictEqual(detectBadword('ANJING'), true);
  assert.strictEqual(detectBadword('Kau BajInGaN'), true);
  assert.strictEqual(detectBadword('FuCk'), true);
});

test('detectBadword respects word boundaries (no substring false positives)', () => {
  // "menganjing" / "anjingku" should NOT match (token glued to other letters).
  assert.strictEqual(detectBadword('menganjing'), false);
  assert.strictEqual(detectBadword('anjingku'), false);
  assert.strictEqual(detectBadword('beranjingan'), false);
  // ...but a standalone token with punctuation still matches.
  assert.strictEqual(detectBadword('anjing!'), true);
  assert.strictEqual(detectBadword('anjing.'), true);
});

test('detectBadword matches multi-word phrases via substring', () => {
  // No multi-word phrase in the current list, but the phrase path is exercised
  // by ensuring a token that is a phrase never falsely triggers on partials.
  assert.strictEqual(detectBadword('mother'), false); // partial of motherfucker
});
