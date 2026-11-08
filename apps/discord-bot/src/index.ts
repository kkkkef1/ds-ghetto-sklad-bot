import "dotenv/config";
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import * as startSession from "./commands/startSession.js";
import * as stopSession from "./commands/stopSession.js";
import * as captAdmin from "./commands/captAdmin.js";
import * as announce from "./commands/announce.js";
import * as mp from "./commands/mp.js";
import * as meeting from "./commands/meeting.js";
import { CONFIRM_PREFIX, MARK_PREFIX } from "./activity/render.js";
import { handleConfirmButton, handleMarkButton, initActivity } from "./activity/service.js";
import { CANCEL_BUTTON_PREFIX, handleCancelButton, initCaptTracker } from "./captTracker/index.js";

interface Command {
  data: { name: string };
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

const commands = new Map<string, Command>([
  [startSession.data.name, startSession],
  [stopSession.data.name, stopSession],
  [captAdmin.data.name, captAdmin],
  [announce.data.name, announce],
  [mp.data.name, mp],
  [meeting.data.name, meeting],
]);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // required to read plain-text log dumps, not just slash commands
    GatewayIntentBits.GuildMembers, // привилегированный: список админов по ролям для подбивки МП (включить в Developer Portal)
  ],
  partials: [Partials.Channel, Partials.Message],
});

// Last-resort safety net: an uncaught rejection/exception anywhere (e.g. a
// DiscordAPIError from an interaction ack that missed its 3s window) used
// to crash the whole process — taking down every feature, not just the one
// button that failed — until systemd restarted it. Log it instead; the
// individual command/button handlers below already catch their own errors,
// this only guards against something slipping through.
process.on("unhandledRejection", (reason) => {
  console.error("[discord-bot] Необработанный rejection (процесс не остановлен):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[discord-bot] Необработанное исключение (процесс не остановлен):", err);
});

client.once(Events.ClientReady, (c) => {
  console.log(`[discord-bot] Logged in as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    const autocompleters: Record<string, (i: AutocompleteInteraction) => Promise<void>> = {
      [captAdmin.data.name]: captAdmin.autocomplete,
      [mp.data.name]: mp.autocomplete,
      [meeting.data.name]: meeting.autocomplete,
    };
    const handler = autocompleters[interaction.commandName];
    if (handler) {
      try {
        await handler(interaction);
      } catch (err) {
        console.error("[discord-bot] Autocomplete failed:", err);
      }
    }
    return;
  }

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

  if (interaction.isButton() && (interaction.customId.startsWith(MARK_PREFIX) || interaction.customId.startsWith(CONFIRM_PREFIX))) {
    try {
      if (interaction.customId.startsWith(MARK_PREFIX)) await handleMarkButton(interaction);
      else await handleConfirmButton(interaction);
    } catch (err) {
      console.error("[discord-bot] Не удалось обработать кнопку активити:", err);
      const payload = { content: "Произошла ошибка. Попробуйте ещё раз.", ephemeral: true } as const;
      // deferReply (отметка) -> editReply; deferUpdate (подбивка) -> followUp, чтобы не затереть само сообщение.
      if (interaction.customId.startsWith(MARK_PREFIX) && (interaction.deferred || interaction.replied)) {
        await interaction.editReply({ content: payload.content }).catch(() => {});
      } else if (interaction.deferred || interaction.replied) {
        await interaction.followUp(payload).catch(() => {});
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
      // After deferUpdate() an editReply would overwrite the capt message itself
      // with the error text — a followUp is a separate ephemeral note instead.
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
  }
});

// Registers the seizure-report listener and periodic housekeeping.
initCaptTracker(client);
// Планировщик МП и собраний: анонсы, напоминания, подбивки.
initActivity(client);

const token = process.env.DISCORD_TOKEN;
if (!token) {
  throw new Error("DISCORD_TOKEN environment variable is required but was not provided.");
}

client.login(token);
