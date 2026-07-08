// Tests for src/llm.js — fully offline via a fake Ollama client injected
// through the __setClientForTest seam. No network / Ollama Cloud access.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert';

let llm;
let circuit;

before(async () => {
  process.env.OLLAMA_API_KEY = 'test-key';
  process.env.OLLAMA_RETRY_BASE_MS = '1'; // make the backoff ladder near-instant
  llm = await import('../src/llm.js');
  circuit = await import('../src/circuit.js');
});

beforeEach(() => circuit.__reset());

function setFake(chatFn) {
  llm.__setClientForTest({ async chat(...args) { return chatFn(...args); } });
}

test('chat returns trimmed content from the model', async () => {
  setFake(async () => ({ message: { content: 'halo dari model   ' } }));
  const out = await llm.chat([{ role: 'user', content: 'hai' }]);
  assert.strictEqual(out, 'halo dari model');
});

test('chat passes an AbortController-derived signal for timeout', async () => {
  let signalSeen = null;
  setFake(async ({ signal }) => {
    signalSeen = signal;
    return { message: { content: 'x' } };
  });
  await llm.chat([{ role: 'user', content: 'y' }], { timeoutMs: 5000 });
  assert.ok(signalSeen instanceof AbortSignal);
});

test('chat retries on transient failure then succeeds', async () => {
  let attempts = 0;
  setFake(async () => {
    attempts += 1;
    if (attempts < 2) throw new Error('boom');
    return { message: { content: 'ok' } };
  });
  const out = await llm.chat([{ role: 'user', content: 'z' }]);
  assert.strictEqual(out, 'ok');
  assert.strictEqual(attempts, 2);
});

test('chat throws after all retries are exhausted', async () => {
  setFake(async () => {
    throw new Error('always fail');
  });
  await assert.rejects(llm.chat([{ role: 'user', content: 'q' }]));
});

test('chat does not retry when an external signal is already aborted', async () => {
  let attempts = 0;
  const ac = new AbortController();
  ac.abort();
  setFake(async () => {
    attempts += 1;
    throw new Error('boom');
  });
  await assert.rejects(llm.chat([{ role: 'user', content: 'q' }], { signal: ac.signal }));
  assert.strictEqual(attempts, 1);
});

test('summarize builds an instruction + user text and returns the summary', async () => {
  let captured = null;
  setFake(async ({ messages }) => {
    captured = messages;
    return { message: { content: 'ini ringkasan' } };
  });
  const out = await llm.summarize('percakapan yang panjang sekali', { maxSentences: 3 });
  assert.strictEqual(out, 'ini ringkasan');
  assert.strictEqual(captured.length, 2);
  assert.match(captured[0].content, /Ringkas percakapan/);
  assert.match(captured[0].content, /3 kalimat/);
  assert.strictEqual(captured[1].role, 'user');
  assert.strictEqual(captured[1].content, 'percakapan yang panjang sekali');
});

// ───────────────────────── circuit breaker (Fase 5) ─────────────────────────

test('chat throws without calling the model when the circuit is open', async () => {
  let modelCalled = false;
  setFake(async () => {
    modelCalled = true;
    return { message: { content: 'should never reach here' } };
  });
  circuit.__forceOpen(10000);
  await assert.rejects(
    llm.chat([{ role: 'user', content: 'hai' }]),
    /Circuit breaker open/
  );
  assert.strictEqual(modelCalled, false, 'model must not be called while open');
});

test('chat records success and resets failures below threshold', async () => {
  setFake(async () => ({ message: { content: 'ok' } }));
  // Accumulate failures but stay under the threshold (breaker still closed).
  for (let i = 0; i < circuit.state().threshold - 2; i++) circuit.recordFailure();
  assert.strictEqual(circuit.isOpen(), false);
  assert.ok(circuit.state().failCount > 0);
  // A successful LLM call resets the counter.
  await llm.chat([{ role: 'user', content: 'z' }]);
  assert.strictEqual(circuit.isOpen(), false);
  assert.strictEqual(circuit.state().failCount, 0);
});

test('chat records a failure (breaker trips) after retries are exhausted', async () => {
  circuit.__reset();
  setFake(async () => {
    throw new Error('always fail');
  });
  await assert.rejects(llm.chat([{ role: 'user', content: 'q' }]));
  assert.strictEqual(circuit.state().failCount, 1);
});
