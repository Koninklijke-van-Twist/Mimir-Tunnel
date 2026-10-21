import assert from "node:assert/strict";
import test from "node:test";
import { QueueTimeoutError } from "../src/errors.js";
import { SessionPool, withSession } from "../src/pool.js";

test("één sessie: de tweede acquire wacht tot release", async () => {
  let n = 0;
  const pool = new SessionPool({
    size: 1,
    queueTimeoutMs: 500,
    createSession: async () => ({ id: ++n, async close() {} }),
  });
  const first = await pool.acquire();
  let second = null;
  const pending = pool.acquire().then((slot) => {
    second = slot;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(second, null);
  pool.release(first);
  await pending;
  assert.equal(second.session.id, first.session.id);
  assert.equal(pool.stats().busy, 1);
  await pool.close();
});

test("poolgrootte 2 maakt twee sessies", async () => {
  let n = 0;
  const pool = new SessionPool({
    size: 2,
    queueTimeoutMs: 500,
    createSession: async () => ({ id: ++n, async close() {} }),
  });
  const a = await pool.acquire();
  const b = await pool.acquire();
  assert.notEqual(a.session.id, b.session.id);
  assert.equal(pool.stats().ready, 2);
  assert.equal(pool.stats().idle, 0);
  await pool.close();
});

test("wachtrij geeft 503 als er niemand vrijkomt", async () => {
  const pool = new SessionPool({
    size: 1,
    queueTimeoutMs: 40,
    createSession: async () => ({ async close() {} }),
  });
  await pool.acquire();
  await assert.rejects(pool.acquire(), (err) => err instanceof QueueTimeoutError && err.status === 503);
  await pool.close();
});

test("discard bouwt bij de wachtende caller een nieuwe sessie", async () => {
  let n = 0;
  const pool = new SessionPool({
    size: 1,
    queueTimeoutMs: 500,
    createSession: async () => ({ id: ++n, async close() {} }),
  });
  const first = await pool.acquire();
  const pending = pool.acquire();
  await pool.discard(first);
  const second = await pending;
  assert.equal(second.session.id, 2);
  await pool.close();
});

test("withSession herhaalt een dode leessessie één keer en een mutatie niet", async () => {
  let n = 0;
  const pool = new SessionPool({
    size: 1,
    queueTimeoutMs: 500,
    createSession: async () => {
      const id = ++n;
      return {
        id,
        dead: false,
        tainted: false,
        async close() { this.dead = true; },
      };
    },
  });

  const read = await withSession(pool, async (session) => {
    if (session.id === 1) {
      session.dead = true;
      const err = new Error("EPIPE");
      err.fatal = true;
      err.code = "SESSION_LOST";
      throw err;
    }
    return session.id;
  }, { retry: true });
  assert.equal(read, 2);

  const writePool = new SessionPool({
    size: 1,
    queueTimeoutMs: 500,
    createSession: async () => ({
      dead: false,
      tainted: false,
      async close() {},
    }),
  });
  let writes = 0;
  await assert.rejects(() => withSession(writePool, async (session) => {
    writes += 1;
    session.dead = true;
    const err = new Error("weg");
    err.fatal = true;
    throw err;
  }, { retry: false }));
  assert.equal(writes, 1);
  await pool.close();
  await writePool.close();
});
