// ===================== COOPERATIVE THROTTLING =====================
//
// A single big paste can produce hundreds of thousands of log lines. Parsing
// and matching them in one uninterrupted synchronous pass pins the Node.js
// event loop for as long as that takes: no Discord gateway heartbeat, no
// other command, no other session's analysis can run meanwhile — and on a
// small VPS the process sits at 100% CPU until it's done, which is what
// disconnected the bot. A Yielder periodically hands control back to the
// event loop (a short timer tick) so the process stays responsive and other
// work can interleave. This trades a little wall-clock time for the
// analysis itself ("медленно, но верно") in exchange for never blocking
// everything else.

export const YIELD_BATCH_SIZE = 500;
export const YIELD_DELAY_MS = 4;

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class Yielder {
  private count = 0;

  constructor(
    private batchSize: number = YIELD_BATCH_SIZE,
    private delayMs: number = YIELD_DELAY_MS
  ) {}

  /** Call once per unit of work (line, event, player...). Yields every `batchSize` calls. */
  async tick(): Promise<void> {
    this.count++;
    if (this.count % this.batchSize === 0) {
      await sleep(this.delayMs);
    }
  }
}
