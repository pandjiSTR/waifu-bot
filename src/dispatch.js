import pino from 'pino';

const DEFAULT_HEARTBEAT_MS = parseInt(process.env.TYPING_HEARTBEAT_MS || '3000', 10);

export function createTypingPulse(sendTyping, intervalMs = DEFAULT_HEARTBEAT_MS) {
  sendTyping?.();
  const timer = setInterval(() => sendTyping?.(), intervalMs);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

export function createDispatcher({ processLLM }) {
  const chains = new Map();

  function dispatch(body, ctx) {
    const key = ctx.channelId;
    let entry = chains.get(key);
    if (!entry) {
      entry = {
        tail: Promise.resolve(),
        active: 0,
        pulse: createTypingPulse(() => ctx.channel?.sendTyping?.()),
      };
      chains.set(key, entry);
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
        chains.delete(key);
      }
    });
    entry.tail = cleanup;
    cleanup.catch(() => {});
  }

  return { dispatch };
}
