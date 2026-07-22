import { Client, GatewayIntentBits } from 'discord.js';
import pino from 'pino';
import { addMessage } from './context.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'warn', name: 'discord' });
let connectionState = 'disconnected';

export function getConnectionState() { return connectionState; }

export async function initDiscord(redis, dispatcher, gatekeeper) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
  });

  client.on('clientReady', () => {
    connectionState = 'connected';
    logger.info({ user: client.user.tag, guilds: client.guilds.cache.size }, 'Discord bot ready');
  });

  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    if (!msg.content && msg.attachments.size === 0) return;

    // Save display name to Redis (fire-and-forget)
    if (redis) {
      const name = msg.author.globalName || msg.author.username;
      redis.hset('waifu:friends:names', msg.author.id, name).catch(() => {});
    }

    // Save ALL messages to context before gatekeeper, so Ara can see
    // full chat history even when not directly addressed.
    const body = (msg.content || '').slice(0, 2000);
    const isGroup = !!msg.guildId;
    if (redis) {
      addMessage(redis, msg.channelId, { sender: msg.author.id, text: body, timestamp: new Date().toISOString() }, isGroup)
        .catch(() => {});
    }

    const ctx = {
      _discordClient: client,
      channelId: msg.channelId,
      senderId: msg.author.id,
      senderTag: msg.author.tag,
      guildId: msg.guildId,
      isGroup,
      channel: {
        send: (content) => msg.channel.send(content),
        sendTyping: () => msg.channel.sendTyping(),
      },
      message: msg,
      redis,
      messageId: msg.id,
    };

    const ok = await gatekeeper.shouldProcess(body, ctx);
    if (!ok) return;

    dispatcher.dispatch(body, ctx);
  });

  // DM messages: messageCreate doesn't fire for DMs in discord.js v14.27,
  // so we reconstruct from the raw gateway event.
  client.on('raw', (packet) => {
    if (packet.t !== 'MESSAGE_CREATE') return;
    if (packet.d.guild_id) return;
    if (packet.d.author?.bot) return;

    process.nextTick(async () => {
      try {
        const d = packet.d;
        const channel = client.channels.cache.get(d.channel_id)
          || await client.channels.fetch(d.channel_id);
        if (!channel) return;

        const body = (d.content || '').slice(0, 2000);

        // Save DM to context before gatekeeper
        addMessage(redis, d.channel_id, { sender: d.author.id, text: body, timestamp: new Date().toISOString() }, false)
          .catch(() => {});

        const ctx = {
          _discordClient: client,
          channelId: d.channel_id,
          senderId: d.author.id,
          senderTag: d.author.username + '#' + (d.author.discriminator || '0'),
          guildId: null,
          isGroup: false,
          channel: {
            send: (content) => channel.send(content),
            sendTyping: () => channel.sendTyping(),
          },
          message: {
            id: d.id,
            channelId: d.channel_id,
            guildId: null,
            author: {
              id: d.author.id,
              bot: d.author.bot || false,
              tag: d.author.username + '#' + (d.author.discriminator || '0'),
            },
            attachments: { size: (d.attachments || []).length, first: () => undefined },
            channel,
          },
          redis,
          messageId: d.id,
        };

        const ok = await gatekeeper.shouldProcess(body, ctx);
        if (!ok) return;

        dispatcher.dispatch(body, ctx);
      } catch (err) {
        logger.warn({ err }, 'DM handler failed');
      }
    });
  });

  await client.login(process.env.DISCORD_TOKEN);
  return { client, stop: () => client.destroy() };
}
