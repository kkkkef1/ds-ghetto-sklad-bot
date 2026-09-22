// ===================== SINGLE-FLIGHT ANALYSIS QUEUE =====================
//
// runAnalysis is CPU-bound and throttled (see @workspace/log-analyzer's
// throttle.ts) so it no longer freezes the whole bot — but if two admins
// paste huge logs at the same moment, running both analyses side by side
// still means two CPU-hungry jobs fighting over the same core(s). This is a
// single small bot process, so instead we simply run analyses one at a
// time: a new session's analysis waits for the previous one to finish
// rather than starting alongside it.

type Task<T> = (hadToWait: boolean) => Promise<T>;

let activeOrQueued = 0;
let tail: Promise<void> = Promise.resolve();

/** Runs `task` once no other analysis is running. Never rejects the tail itself. */
export function runExclusive<T>(task: Task<T>): Promise<T> {
  activeOrQueued++;
  const hadToWait = activeOrQueued > 1;
  const runThis = tail.then(() => task(hadToWait));
  tail = runThis.then(
    () => undefined,
    () => undefined
  ).finally(() => { activeOrQueued--; });
  return runThis;
}
