// Tests for src/circuit.js — minimal circuit breaker (Fase 5, PRD §6.3).
// Fully offline; no network or Redis. Defaults (when CIRCUIT_BREAKER_* env are
// unset) are THRESHOLD=5, COOLDOWN_MS=300000 — matching PRD §9 / .env.example.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert';

const circuit = await import('../src/circuit.js');
const {
  isOpen,
  recordSuccess,
  recordFailure,
  remainingMs,
  state,
  __forceOpen,
  __reset,
} = circuit;

beforeEach(() => __reset());

test('defaults: threshold=5, cooldownMs=300000', () => {
  const s = state();
  assert.strictEqual(s.threshold, 5);
  assert.strictEqual(s.cooldownMs, 300000);
});

test('starts closed', () => {
  assert.strictEqual(isOpen(), false);
  assert.strictEqual(remainingMs(), 0);
});

test('does not open below threshold (4 failures)', () => {
  for (let i = 0; i < 4; i++) recordFailure();
  assert.strictEqual(isOpen(), false);
  assert.strictEqual(state().failCount, 4);
});

test('opens after THRESHOLD consecutive failures', () => {
  for (let i = 0; i < state().threshold; i++) recordFailure();
  assert.strictEqual(isOpen(), true);
  assert.ok(remainingMs() > 0);
});

test('recordSuccess resets the breaker and counter', () => {
  for (let i = 0; i < state().threshold; i++) recordFailure();
  assert.strictEqual(isOpen(), true);
  recordSuccess();
  assert.strictEqual(isOpen(), false);
  assert.strictEqual(state().failCount, 0);
  assert.strictEqual(remainingMs(), 0);
});

test('a success before threshold keeps the breaker closed', () => {
  recordFailure();
  recordFailure();
  recordSuccess(); // resets counter
  recordFailure(); // failCount back to 1, not >= threshold
  assert.strictEqual(isOpen(), false);
});

test('remainingMs counts down toward 0', async () => {
  __forceOpen(1000);
  assert.ok(remainingMs() <= 1000);
  assert.ok(remainingMs() > 800); // allow a little startup slack
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(remainingMs() < 1000);
});

test('breaker closes automatically after cooldown elapses', async () => {
  __forceOpen(30);
  assert.strictEqual(isOpen(), true);
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(isOpen(), false);
  assert.strictEqual(remainingMs(), 0);
});

test('__forceOpen opens immediately for the given duration', () => {
  __forceOpen(1234);
  assert.strictEqual(isOpen(), true);
  assert.ok(remainingMs() <= 1234);
});

test('state() snapshot reflects open + failCount + remaining', () => {
  __forceOpen(5000);
  const s = state();
  assert.strictEqual(s.open, true);
  assert.strictEqual(s.failCount, 0); // force-open does not alter the counter
  assert.ok(s.remainingMs > 0 && s.remainingMs <= 5000);
  assert.strictEqual(s.threshold, 5);
  assert.strictEqual(s.cooldownMs, 300000);
});
