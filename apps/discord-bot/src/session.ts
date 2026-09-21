// ===================== SESSION STORE =====================
//
// Every "слив склада" session is keyed by its dedicated Discord channel id.
// A user can only have one active session at a time (enforced via activeByUser).
// Sessions never share state with each other — each wizard run only ever reads
// and writes the Session object tied to the channel it's collecting in.

export type SessionStep =
  | "select_faction"
  | "await_warehouse"
  | "await_placements"
  | "await_roster"
  | "await_admin_name"
  | "processing"
  | "done";

export interface Session {
  channelId: string;
  ownerId: string;
  guildId: string;
  faction: string | null;
  step: SessionStep;
  warehouseLog: string | null;
  placementLogs: string[];
  rosterLog: string | null;
  adminName: string | null;
  createdAt: number;
}

const sessions = new Map<string, Session>();
const activeByUser = new Map<string, string>(); // userId -> channelId

export function createSession(channelId: string, ownerId: string, guildId: string): Session {
  const session: Session = {
    channelId,
    ownerId,
    guildId,
    faction: null,
    step: "select_faction",
    warehouseLog: null,
    placementLogs: [],
    rosterLog: null,
    adminName: null,
    createdAt: Date.now(),
  };
  sessions.set(channelId, session);
  activeByUser.set(ownerId, channelId);
  return session;
}

export function getSession(channelId: string): Session | undefined {
  return sessions.get(channelId);
}

export function getActiveSessionChannel(ownerId: string): string | undefined {
  return activeByUser.get(ownerId);
}

/**
 * Frees the user's "one active session" slot. The Discord channel itself is
 * intentionally NOT deleted or archived — sessions are meant to remain as a
 * permanent record in the "Логи" category.
 */
export function endSession(channelId: string) {
  const session = sessions.get(channelId);
  if (session) activeByUser.delete(session.ownerId);
  sessions.delete(channelId);
}
