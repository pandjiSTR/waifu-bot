import { test } from 'node:test';
import assert from 'node:assert';
import { createDispatcher, createTypingPulse } from '../src/dispatch.js';

test('createTypingPulse sends composing immediately, paused on stop', () => {
  const calls = [];
  const pulse = createTypingPulse((type) => calls.push(type), 10000);
  assert.strictEqual(calls[0], 'composing');
  pulse.stop();
  assert.strictEqual(calls[1], 'paused');
});

test('createTypingPulse heartbeat fires composing on interval', async () => {
  const calls = [];
  const pulse = createTypingPulse((type) => calls.push(type), 50);
  await new Promise((r) => setTimeout(r, 70));
  assert.ok(calls.length >= 2, 'composing should fire at least twice (initial + 1 tick)');
  pulse.stop();
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(calls[calls.length - 1], 'paused');
});

test('dispatches serially for the same JID', async () => {
  const order = [];
  const p = createDispatcher({
    processLLM: async (body) => { order.push(body); },
    sendPresenceUpdate: () => {},
  });
  p.dispatch('msg1', { jid: 'jid-x' });
  p.dispatch('msg2', { jid: 'jid-x' });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepStrictEqual(order, ['msg1', 'msg2']);
});

test('sends composing then paused for the queue', async () => {
  const presence = [];
  const p = createDispatcher({
    processLLM: async () => {},
    sendPresenceUpdate: (t) => presence.push(t),
  });
  p.dispatch('msg', { jid: 'jid-y' });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(presence.includes('composing'), 'presence should include composing at start');
  assert.strictEqual(presence.at(-1), 'paused', 'last presence should be paused');
  const pausedCount = presence.filter((t) => t === 'paused').length;
  assert.strictEqual(pausedCount, 1, 'should have exactly one paused');
});

test('different JIDs are not serialized', async () => {
  const order = [];
  let resolveA;
  const processLLM = async (body) => {
    if (body === 'a') await new Promise((r) => { resolveA = r; });
    order.push(body);
  };
  const p = createDispatcher({ processLLM, sendPresenceUpdate: () => {} });
  p.dispatch('a', { jid: 'jid-1' });
  p.dispatch('b', { jid: 'jid-2' });
  await new Promise((r) => setTimeout(r, 0));
  resolveA();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(order.includes('a'), 'order should include a');
  assert.ok(order.includes('b'), 'order should include b');
});
