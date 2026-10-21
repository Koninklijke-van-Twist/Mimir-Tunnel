import { isFatalSessionError, QueueTimeoutError } from "./errors.js";

/**
 * Kleine pool van ingelogde BC-sessies. Eén sessie handelt één transactie
 * tegelijk af; extra requests wachten. Een dode sessie wordt weggegooid en
 * bij de volgende acquire opnieuw opgebouwd (nieuwe login).
 */
export class SessionPool {
  constructor({ size, createSession, queueTimeoutMs, logger }) {
    this.size = size;
    this.createSession = createSession;
    this.queueTimeoutMs = queueTimeoutMs;
    this.logger = logger;
    this.slots = [];
    this.waiters = [];
    this.creating = 0;
    this.closed = false;
  }

  stats() {
    const busy = this.slots.filter((slot) => slot.busy).length;
    return {
      size: this.size,
      ready: this.slots.length,
      busy,
      idle: this.slots.length - busy,
      queued: this.waiters.length,
      starting: this.creating,
    };
  }

  async acquire() {
    if (this.closed) throw new QueueTimeoutError();
    const idle = this.slots.find((slot) => !slot.busy);
    if (idle) {
      idle.busy = true;
      return idle;
    }
    if (this.slots.length + this.creating < this.size) {
      return this.#startSlot();
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        reject(new QueueTimeoutError());
      }, this.queueTimeoutMs);
      this.waiters.push(waiter);
    });
  }

  release(slot) {
    if (!this.slots.includes(slot)) return;
    slot.busy = false;
    this.#dispatch();
  }

  async discard(slot) {
    this.slots = this.slots.filter((item) => item !== slot);
    slot.busy = false;
    this.logger?.info("session.discard", {});
    try {
      await slot.session?.close();
    } catch {
      // Proces is al weg.
    }
    this.#dispatch();
  }

  async close() {
    this.closed = true;
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new QueueTimeoutError());
    }
    this.waiters = [];
    const slots = this.slots.splice(0);
    await Promise.all(slots.map(async (slot) => {
      try {
        await slot.session?.close();
      } catch {
        // Afsluiten mag mislukken tijdens shutdown.
      }
    }));
  }

  async #startSlot() {
    this.creating += 1;
    try {
      const session = await this.createSession();
      if (this.closed) {
        await session.close?.();
        throw new QueueTimeoutError();
      }
      const slot = { session, busy: true };
      this.slots.push(slot);
      this.logger?.info("session.ready", { ready: this.slots.length });
      return slot;
    } finally {
      this.creating -= 1;
    }
  }

  #dispatch() {
    while (this.waiters.length > 0) {
      const idle = this.slots.find((slot) => !slot.busy);
      if (idle) {
        const waiter = this.waiters.shift();
        clearTimeout(waiter.timer);
        idle.busy = true;
        waiter.resolve(idle);
        continue;
      }
      if (this.slots.length + this.creating < this.size) {
        const waiter = this.waiters.shift();
        clearTimeout(waiter.timer);
        this.#startSlot().then(waiter.resolve, waiter.reject);
        continue;
      }
      break;
    }
  }
}

/**
 * Leent een sessie. Bij een dode sessie gooit de pool hem weg.
 * retry=true (alleen lees-transacties) probeert de hele functie één keer
 * opnieuw op een verse login. Mutaties worden niet herhaald: de uitkomst
 * kan al in BC geland zijn.
 */
export async function withSession(pool, fn, { retry = false } = {}) {
  let attempt = 0;
  const max = retry ? 2 : 1;
  let lastError;
  while (attempt < max) {
    attempt += 1;
    const slot = await pool.acquire();
    let drop = false;
    try {
      const value = await fn(slot.session);
      drop = Boolean(slot.session?.dead || slot.session?.tainted);
      return value;
    } catch (err) {
      lastError = err;
      drop = Boolean(slot.session?.dead || slot.session?.tainted);
      // Alleen opnieuw proberen als de sessie dood is. Een mislukte close
      // (tainted) na een geslaagde leesactie is geen reden om die actie te herhalen,
      // en een mutatie herhalen we nooit (retry blijft dan false).
      const again = retry && attempt < max && Boolean(slot.session?.dead) && isFatalSessionError(err);
      if (!again) throw err;
    } finally {
      if (drop) await pool.discard(slot);
      else pool.release(slot);
    }
  }
  throw lastError;
}
