export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getOwnerDiscordId() {
  return process.env.OWNER_DISCORD_ID || '';
}
