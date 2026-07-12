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
