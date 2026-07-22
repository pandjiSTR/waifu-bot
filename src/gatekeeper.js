import pino from 'pino';
import { detectBadword } from './badwords.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

let blacklist = [];
const WHITELIST = (process.env.WHITELIST || '').split(',').map(s => s.trim()).filter(Boolean);
const ALLOWED_CHANNEL_IDS = (process.env.ALLOWED_CHANNEL_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

const seen = new Map();
const SEEN_TTL_MS = 60 * 1000;
let sweepTimer = process.env.NODE_ENV !== 'test' ? setInterval(pruneSeen, 5 * 60 * 1000) : null;

function pruneSeen() {
  const now = Date.now();
  for (const [k, exp] of seen) if (exp < now) seen.delete(k);
}

export function stopSweeper() {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}

export async function loadBlacklist(redis) {
  if (redis) {
    try {
      const raw = await redis.get('waifu:settings:misc');
      if (raw) {
        const parsed = JSON.parse(raw);
        blacklist = String(parsed.blacklist || '').split(',').map(s => s.trim()).filter(Boolean);
        return;
      }
    } catch (err) { logger.warn({ err }, 'loadBlacklist failed'); }
  }
  blacklist = (process.env.BLACKLIST || '').split(',').map(s => s.trim()).filter(Boolean);
}

export function setBlacklist(list) {
  blacklist = Array.isArray(list) ? list.map(s => String(s).trim()).filter(Boolean) : [];
}

export function extractText(msg) {
  return msg?.content?.replace(/\0/g, '').trim().slice(0, 2000) || null;
}

export async function shouldProcess(body, ctx) {
  pruneSeen();
  const mid = ctx.messageId;
  if (mid && seen.has(mid)) return false;
  if (mid && ctx.redis) {
    try {
      const r = await ctx.redis.set(`waifu:seen:${mid}`, '1', 'EX', 300, 'NX');
      if (r === null) return false;
    } catch {}
  }
  if (mid) seen.set(mid, Date.now() + SEEN_TTL_MS);

  const senderNorm = ctx.senderId;
  if (blacklist.includes(senderNorm)) return false;
  if (WHITELIST.length && !WHITELIST.includes(senderNorm)) return false;

  // DM: always respond
  if (!ctx.isGroup) {
    if (detectBadword(body)) ctx.badword = true;
    return true;
  }

  // Allowed channel: respond freely to all messages
  if (ALLOWED_CHANNEL_IDS.includes(ctx.channelId)) {
    if (detectBadword(body)) ctx.badword = true;
    return true;
  }

  // Non-allowed channel: only if bot is mentioned, reply to bot, or name called (ara/araa/araaa...)
  const clientId = ctx.message?.client?.user?.id;
  const isMentioned = clientId && ctx.message?.mentions?.has(clientId);
  const isReplyToBot = clientId && ctx.message?.mentions?.repliedUser?.id === clientId;
  const isNameCalled = /\bara+\b/i.test(body);

  if (!isMentioned && !isReplyToBot && !isNameCalled) return false;

  if (detectBadword(body)) ctx.badword = true;

  if (ctx.redis) {
    ctx.redis.hincrby('waifu:stats:messages', 'total', 1).catch(() => {});
    ctx.redis.hincrby('waifu:stats:friends', ctx.senderId, 1).catch(() => {});
    const hourKey = 'waifu:stats:hourly:' + new Date().toISOString().slice(0, 13) + ':00';
    ctx.redis.zincrby(hourKey, 1, 'msg').catch(() => {});
    ctx.redis.expire(hourKey, 48 * 3600).catch(() => {});
  }

  return true;
}
