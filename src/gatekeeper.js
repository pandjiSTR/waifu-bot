import pino from 'pino';
import { normalizeNumber, getOwnerNumbers } from './util.js';
import { detectBadword } from './badwords.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

let blacklist = [];
const WHITELIST = (process.env.WHITELIST || '')
  .split(',')
  .map(normalizeNumber)
  .filter(Boolean);

const seen = new Map();
const SEEN_TTL_MS = 60 * 1000;
let sweepTimer = process.env.NODE_ENV !== 'test' ? setInterval(pruneSeen, 5 * 60 * 1000) : null;

const botSentIds = new Set();
const MAX_BOT_SENT = 10000;

export function trackBotMessage(id) {
  if (!id) return;
  if (botSentIds.size >= MAX_BOT_SENT) botSentIds.clear();
  botSentIds.add(id);
}

function pruneSeen() {
  const now = Date.now();
  for (const [k, exp] of seen) {
    if (exp < now) seen.delete(k);
  }
}

export function stopSweeper() {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

export async function loadBlacklist(redis) {
  if (redis) {
    try {
      const raw = await redis.get('waifu:settings:misc');
      if (raw) {
        const parsed = JSON.parse(raw);
        const list = parsed.blacklist || '';
        blacklist = String(list).split(',').map(normalizeNumber).filter(Boolean);
        return;
      }
    } catch (err) {
      logger.warn({ err }, 'loadBlacklist failed');
    }
  }
  blacklist = (process.env.BLACKLIST || '').split(',').map(normalizeNumber).filter(Boolean);
}

export function setBlacklist(list) {
  blacklist = Array.isArray(list) ? list.map(normalizeNumber).filter(Boolean) : [];
}

export function extractText(m) {
  const msg = m?.message;
  if (!msg) return null;

  const text =
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.audioMessage?.caption ||
    null;

  if (text == null) return null;

  const cleaned = String(text).replace(/\0/g, '').trim().slice(0, 2000);
  return cleaned || null;
}

export function isStickerRequest(ctx) {
  const msg = ctx?.message?.message;
  if (!msg?.imageMessage) return false;

  const caption = msg.imageMessage.caption || '';
  if (/stiker|sticker/i.test(caption)) return true;

  const ctxInfo = msg.imageMessage.contextInfo;
  if (ctxInfo?.quotedMessage) {
    const botNumber = normalizeNumber(ctx?.botJid || ctx?.sock?.user?.id);
    if (botNumber && normalizeNumber(ctxInfo.participant) === botNumber) return true;
  }
  return false;
}

export async function shouldProcess(body, ctx) {
  if (ctx.message?.key?.fromMe) return false;

  pruneSeen();
  const mid = ctx.messageId;
  if (mid && seen.has(mid)) return false;
  if (mid && ctx.redis) {
    try {
      const r = await ctx.redis.set(`waifu:seen:${mid}`, '1', 'EX', 300, 'NX');
      if (r === null) return false;
    } catch { /* fall back to memory-only */ }
  }
  if (mid) seen.set(mid, Date.now() + SEEN_TTL_MS);

  const senderNorm = normalizeNumber(ctx.sender);
  if (blacklist.includes(senderNorm)) {
    ctx.redis?.lpush('waifu:logs', JSON.stringify({ time: new Date().toISOString(), level: 'info', msg: `Blocked blacklisted: ${ctx.sender}` })).catch(() => {});
    return false;
  }

  if (
    WHITELIST.length &&
    !getOwnerNumbers().includes(senderNorm) &&
    !WHITELIST.includes(senderNorm)
  ) {
    return false;
  }

  if (ctx.isGroup) {
    const botNumber = normalizeNumber(ctx.botJid || ctx.sock?.user?.id);
    const contextInfo = ctx.message?.message?.extendedTextMessage?.contextInfo;
    const mentioned = contextInfo?.mentionedJid || [];
    const mentionedBot =
      Array.isArray(mentioned) && mentioned.some((j) => normalizeNumber(j) === botNumber);
    const quotedParticipant = contextInfo?.participant;
    const quotedBot = quotedParticipant
      ? normalizeNumber(quotedParticipant) === botNumber
      : false;
    const stanzaId = contextInfo?.stanzaId;
    const isReplyToBot = Boolean(stanzaId) && botSentIds.has(stanzaId);
    const bodyLower = String(body).toLowerCase();
    if (!mentionedBot && !quotedBot && !isReplyToBot && !/\bara+\b/i.test(bodyLower)) {
      return false;
    }
  }

  const ownerCmd = String(body).toLowerCase();
  if (
    getOwnerNumbers().includes(senderNorm) &&
    (ownerCmd.startsWith('ara fresh') || ownerCmd.startsWith('ara status'))
  ) {
    return false;
  }
  if (ctx.message?.message?.stickerMessage) return false;

  if (detectBadword(body)) {
    ctx.badword = true;
  }

  if (ctx.redis) {
    ctx.redis.hincrby('waifu:stats:messages', 'total', 1).catch(() => {});
    ctx.redis.hincrby('waifu:stats:friends', ctx.sender, 1).catch(() => {});
    const hourKey = 'waifu:stats:hourly:' + new Date().toISOString().slice(0, 13) + ':00';
    ctx.redis.zincrby(hourKey, 1, 'msg').catch(() => {});
    ctx.redis.expire(hourKey, 48 * 3600).catch(() => {});
  }

  return true;
}
