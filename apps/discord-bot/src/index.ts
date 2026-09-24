import "dotenv/config";
import { Client, Events, GatewayIntentBits, Partials, type ChatInputCommandInteraction } from "discord.js";
import * as startSession from "./commands/startSession.js";
import * as captAdmin from "./commands/captAdmin.js";
import { CANCEL_BUTTON_PREFIX, handleCancelButton, initCaptTracker } from "./captTracker/index.js";

interface Command {
  data: { name: string };
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

const commands = new Map<string, Command>([
  [startSession.data.name, startSession],
  [captAdmin.data.name, captAdmin],
]);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // required to read plain-text log dumps, not just slash commands
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once(Events.ClientReady, (c) => {
  console.log(`[discord-bot] Logged in as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    const command = commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (err) {
      console.error(`[discord-bot] Command "${interaction.commandName}" failed:`, err);
      const payload = { content: "Произошла ошибка при выполнении команды.", ephemeral: true } as const;
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith(CANCEL_BUTTON_PREFIX)) {
    const recordId = interaction.customId.slice(CANCEL_BUTTON_PREFIX.length);
    try {
      await handleCancelButton(interaction, recordId);
    } catch (err) {
      console.error("[discord-bot] Не удалось обработать отмену капта:", err);
      const payload = { content: "Произошла ошибка при отмене капта.", ephemeral: true } as const;
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
  }
});

// Registers the seizure-report listener and periodic housekeeping.
initCaptTracker(client);

const token = process.env.DISCORD_TOKEN;
if (!token) {
  throw new Error("DISCORD_TOKEN environment variable is required but was not provided.");
}

client.login(token);
