import pino from 'pino';

const DEFAULT_HEARTBEAT_MS = parseInt(process.env.TYPING_HEARTBEAT_MS || '3000', 10);

export function createTypingPulse(updatePresence, intervalMs = DEFAULT_HEARTBEAT_MS) {
  updatePresence('composing');
  const timer = setInterval(() => updatePresence('composing'), intervalMs);

  return {
    stop() {
      clearInterval(timer);
      updatePresence('paused');
    },
  };
}

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

export function createDispatcher({ processLLM, sendPresenceUpdate, getCurrentSock }) {
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
        if (getCurrentSock) {
          const fresh = getCurrentSock();
          if (fresh) ctx.sock = fresh;
        }
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
