import "dotenv/config";
import { REST, Routes } from "discord.js";
import * as startSession from "./commands/startSession.js";
import * as stopSession from "./commands/stopSession.js";
import * as captAdmin from "./commands/captAdmin.js";
import * as announce from "./commands/announce.js";
import * as mp from "./commands/mp.js";
import * as meeting from "./commands/meeting.js";

const commands = [
  startSession.data.toJSON(),
  stopSession.data.toJSON(),
  captAdmin.data.toJSON(),
  announce.data.toJSON(),
  mp.data.toJSON(),
  meeting.data.toJSON(),
];

/**
 * Registers commands GLOBALLY by default so they show up on every server the
 * bot is invited to, not just one. Global registration can take up to ~1h to
 * propagate — that's a Discord limitation, not a bug.
 *
 * A `DISCORD_GUILD_ID` left set in `.env` used to make this deploy to just
 * that one guild instead — convenient for fast iteration during development,
 * but a footgun in production: forgetting to clear it (or an old dev value
 * lingering in `.env`) silently means new/changed commands (e.g. `/capt
 * edit-count` when it was first added) never reach any other server the bot
 * is on, and look "broken" there when really they just never got deployed.
 *
 * To deploy to a single guild for fast local testing, pass it on the command
 * line instead of via `.env` — it's a one-off, not something that can be
 * forgotten in a committed/long-lived file:
 *   pnpm --filter @workspace/discord-bot run deploy-commands -- --guild 123456789012345678
 */
async function main() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;

  if (!token) throw new Error("DISCORD_TOKEN is required");
  if (!clientId) throw new Error("DISCORD_CLIENT_ID is required");

  const cliFlagIdx = process.argv.indexOf("--guild");
  const cliGuildId = cliFlagIdx !== -1 ? process.argv[cliFlagIdx + 1] : undefined;

  if (process.env.DISCORD_GUILD_ID) {
    console.warn(
      "⚠️  DISCORD_GUILD_ID обнаружен в .env — он ИГНОРИРУЕТСЯ этим скриптом (регистрация всегда глобальная). " +
      "Уберите его из .env, чтобы избежать путаницы; для разовой регистрации на один сервер используйте `--guild <id>`."
    );
  }

  const rest = new REST().setToken(token);
  const route = cliGuildId
    ? Routes.applicationGuildCommands(clientId, cliGuildId)
    : Routes.applicationCommands(clientId);

  await rest.put(route, { body: commands });
  console.log(`Зарегистрировано команд: ${commands.length} (${cliGuildId ? `guild ${cliGuildId}, мгновенно` : "глобально, обновление до ~1 часа"}).`);

  // Why every command showed up twice in the picker: the same commands were
  // registered globally AND, at some point, per-guild (an old `--guild` /
  // DISCORD_GUILD_ID deploy). Discord treats those as two separate sets and
  // lists both. A global deploy therefore also wipes the guild-scoped copies
  // on every server the bot is on, leaving only the global ones.
  // (Skipped for a one-off `--guild` deploy — there guild commands are the point.)
  if (!cliGuildId) {
    const guilds = (await rest.get(Routes.userGuilds())) as { id: string; name: string }[];
    for (const guild of guilds) {
      try {
        const existing = (await rest.get(Routes.applicationGuildCommands(clientId, guild.id))) as unknown[];
        if (!existing.length) continue;
        await rest.put(Routes.applicationGuildCommands(clientId, guild.id), { body: [] });
        console.log(`Удалены дублирующие команды сервера «${guild.name}» (${existing.length} шт.).`);
      } catch (err) {
        console.warn(`Не удалось очистить серверные команды для «${guild.name}» (${guild.id}):`, err);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
