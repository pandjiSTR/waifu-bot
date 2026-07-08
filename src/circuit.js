import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'warn', name: 'circuit' });

let tripCallback = null;
let closeCallback = null;
export function onTrip(cb) { tripCallback = cb; }
export function onClose(cb) { closeCallback = cb; }

// Consecutive failures tolerated before the breaker opens (enters cooldown).
const THRESHOLD = parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD || '5', 10);
// How long the breaker stays open once tripped (ms).
// PRD §9 / .env.example use 300000 (5 min); that is the in-code default.
const COOLDOWN_MS = parseInt(process.env.CIRCUIT_BREAKER_COOLDOWN_MS || '300000', 10);

// In-process breaker state. Simple and minimal per PRD §6.3: a single cooldown
// flag, no per-user counters and no dashboard tuning. circuit.js deliberately
// imports NOTHING from llm/context/pipeline/personality to avoid circular deps.
let failCount = 0;
let cooldownUntil = 0; // epoch ms; 0 means closed

/**
 * @returns {boolean} true when the breaker is open (cooldown active) — LLM
 * calls must be blocked/suspended.
 */
export function isOpen() {
  return Date.now() < cooldownUntil;
}

/**
 * Record a successful LLM call. Closes the breaker and resets the failure
 * counter (PRD §6.3: "sukses -> reset counter").
 */
export function recordSuccess() {
  if (closeCallback && cooldownUntil !== 0) {
    try { closeCallback({ failCount, wasOpenMs: Date.now() - cooldownUntil }) } catch { /* intentional */ }
  }
  failCount = 0;
  cooldownUntil = 0;
}

/**
 * Record a failed LLM call (after all retries are exhausted). Increments the
 * consecutive-failure counter; when it reaches THRESHOLD the breaker opens and
 * a cooldown window is set.
 */
export function recordFailure() {
  failCount += 1;
  if (failCount >= THRESHOLD) {
    cooldownUntil = Date.now() + COOLDOWN_MS;
    if (tripCallback) {
      try { tripCallback({ failCount, threshold: THRESHOLD, cooldownMs: COOLDOWN_MS }) } catch { /* intentional */ }
    }
    logger.warn(
      { failCount, cooldownMs: COOLDOWN_MS, reopensAt: new Date(cooldownUntil).toISOString() },
      'circuit breaker opened — LLM calls suspended'
    );
  }
}

/**
 * @returns {number} milliseconds left in the cooldown window (0 when closed).
 */
export function remainingMs() {
  return Math.max(0, cooldownUntil - Date.now());
}

/**
 * @returns {{open:boolean, failCount:number, remainingMs:number, threshold:number, cooldownMs:number}}
 * A snapshot useful for tests and the dashboard overview endpoint.
 */
export function state() {
  return {
    open: isOpen(),
    failCount,
    remainingMs: remainingMs(),
    threshold: THRESHOLD,
    cooldownMs: COOLDOWN_MS,
  };
}

// ───────────────────────── TEST SEAMS ─────────────────────────
// Not part of the public API; used only by offline tests to force/reset state.

/** Force the breaker open for `ms` (default COOLDOWN_MS). */
export function __forceOpen(ms = COOLDOWN_MS) {
  cooldownUntil = Date.now() + ms;
}

/** Reset all breaker state to closed/fresh. */
export function __reset() {
  failCount = 0;
  cooldownUntil = 0;
}
