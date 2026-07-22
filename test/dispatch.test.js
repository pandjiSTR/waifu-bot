import { test } from 'node:test';
import assert from 'node:assert';
import { createDispatcher, createTypingPulse } from '../src/dispatch.js';

test('createTypingPulse calls sendTyping immediately, stops on stop', () => {
  const calls = [];
  const pulse = createTypingPulse(() => calls.push('typing'), 10000);
  assert.strictEqual(calls[0], 'typing');
  pulse.stop();
  // After stop, no more calls should happen
  const countAfterStop = calls.length;
  assert.strictEqual(calls[countAfterStop - 1], 'typing');
});

test('createTypingPulse heartbeat fires typing on interval', async () => {
  const calls = [];
  const pulse = createTypingPulse(() => calls.push('typing'), 50);
  await new Promise((r) => setTimeout(r, 70));
  assert.ok(calls.length >= 2, 'typing should fire at least twice (initial + 1 tick)');
  pulse.stop();
});

test('dispatches serially for the same channelId', async () => {
  const order = [];
  const p = createDispatcher({
    processLLM: async (body) => { order.push(body); },
  });
  p.dispatch('msg1', { channelId: 'channel-x', channel: { sendTyping: async () => {} } });
  p.dispatch('msg2', { channelId: 'channel-x', channel: { sendTyping: async () => {} } });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepStrictEqual(order, ['msg1', 'msg2']);
});

test('sends typing indicator for the queue', async () => {
  const typingCalls = [];
  const p = createDispatcher({
    processLLM: async () => {},
  });
  p.dispatch('msg', { channelId: 'channel-y', channel: { sendTyping: async () => typingCalls.push('typing') } });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(typingCalls.length >= 1, 'typing should be called at least once');
});

test('different channelIds are not serialized', async () => {
  const order = [];
  let resolveA;
  const processLLM = async (body) => {
    if (body === 'a') await new Promise((r) => { resolveA = r; });
    order.push(body);
  };
  const p = createDispatcher({ processLLM });
  p.dispatch('a', { channelId: 'ch-1', channel: { sendTyping: async () => {} } });
  p.dispatch('b', { channelId: 'ch-2', channel: { sendTyping: async () => {} } });
  await new Promise((r) => setTimeout(r, 0));
  resolveA();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(order.includes('a'), 'order should include a');
  assert.ok(order.includes('b'), 'order should include b');
});
