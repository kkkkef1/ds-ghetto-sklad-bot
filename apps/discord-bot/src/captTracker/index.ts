import type { Client } from "discord.js";
import { registerCaptListener } from "./listener.js";
import { pruneOldDays } from "./store.js";

const KEEP_DAYS = 7;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

/** Wires up the capt-tracking feature onto an existing bot Client. Call once, before login. */
export function initCaptTracker(client: Client): void {
  registerCaptListener(client);
  pruneOldDays(KEEP_DAYS);
  setInterval(() => pruneOldDays(KEEP_DAYS), PRUNE_INTERVAL_MS).unref();
}

export { handleCancelButton } from "./mirror.js";
export { CANCEL_BUTTON_PREFIX } from "./constants.js";
