export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeNumber(n) {
  if (!n) return '';
  return String(n)
    .replace(/@s\.whatsapp\.net$/, '')
    .replace(/:\d+$/, '')
    .replace(/[^0-9]/g, '');
}

export function getOwnerNumbers() {
  return (process.env.OWNER_NUMBER || '')
    .split(',')
    .map(normalizeNumber)
    .filter(Boolean);
}
