import pino from 'pino';
import { createTypingPulse } from './typing.js';
export { createTypingPulse };

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

export function createDispatcher({ processLLM, sendPresenceUpdate }) {
  const chains = new Map();

  function dispatch(body, ctx) {
    const jid = ctx.jid;
    let entry = chains.get(jid);
    if (!entry) {
      entry = { tail: Promise.resolve(), active: 0, pulse: null };
      chains.set(jid, entry);
      entry.pulse = createTypingPulse((t) => sendPresenceUpdate(t, jid));
    }
    entry.active += 1;

    const run = entry.tail.then(async () => {
      try {
        await processLLM(body, ctx);
      } catch (err) {
        logger.error({ err }, 'processLLM failed');
      }
    });

    const cleanup = run.then(() => {
      entry.active -= 1;
      if (entry.active <= 0) {
        entry.pulse.stop();
        chains.delete(jid);
      }
    });
    entry.tail = cleanup;
    cleanup.catch(() => {});
  }

  return { dispatch };
}
