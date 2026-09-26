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

// ===================== FORCE-CLOSE =====================
//
// The wizard (wizard.ts) spends almost all of its time awaiting Discord
// message/button collectors, which don't resolve on their own until the
// user answers or a 15-minute step timeout fires. To let /stopsliv end a
// session immediately regardless of which step it's stuck on, the running
// wizard registers a small controller here that knows how to interrupt
// whatever it's currently waiting on.
export interface SessionController {
  /** Interrupts the current step's collector(s) and ends the wizard loop. */
  forceClose: () => void;
}

const controllers = new Map<string, SessionController>();

export function registerSessionController(channelId: string, controller: SessionController): void {
  controllers.set(channelId, controller);
}

export function unregisterSessionController(channelId: string): void {
  controllers.delete(channelId);
}

/**
 * Forces the wizard running in `channelId` to stop immediately, wherever it
 * currently is (faction pick, log collection, admin-name prompt, ...).
 * Returns false if there's no running wizard to interrupt for that channel
 * (e.g. it already finished, or analysis is in progress — see the
 * "processing" step, which has no collector left to abort).
 */
export function forceCloseSession(channelId: string): boolean {
  const controller = controllers.get(channelId);
  if (!controller) return false;
  controller.forceClose();
  return true;
}

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
