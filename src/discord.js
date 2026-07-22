import { Client, GatewayIntentBits } from 'discord.js';
import pino from 'pino';

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

  client.on('ready', () => {
    connectionState = 'connected';
    logger.info({ user: client.user.tag }, 'Discord bot ready');
  });

  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    if (!msg.content && msg.attachments.size === 0) return;

    const body = (msg.content || '').slice(0, 2000);
    const isGroup = !!msg.guildId;

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

  await client.login(process.env.DISCORD_TOKEN);
  return { client, stop: () => client.destroy() };
}
