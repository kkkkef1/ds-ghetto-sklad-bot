import "dotenv/config";
import { REST, Routes } from "discord.js";
import * as startSession from "./commands/startSession.js";
import * as stopSession from "./commands/stopSession.js";
import * as captAdmin from "./commands/captAdmin.js";

const commands = [startSession.data.toJSON(), stopSession.data.toJSON(), captAdmin.data.toJSON()];

async function main() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.DISCORD_GUILD_ID; // optional: guild-scoped commands update instantly

  if (!token) throw new Error("DISCORD_TOKEN is required");
  if (!clientId) throw new Error("DISCORD_CLIENT_ID is required");

  const rest = new REST().setToken(token);
  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);

  await rest.put(route, { body: commands });
  console.log(`Зарегистрировано команд: ${commands.length} (${guildId ? `guild ${guildId}` : "глобально"}).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
