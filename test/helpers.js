import { once } from "node:events";
import { createLogger } from "../src/logger.js";
import { SessionPool } from "../src/pool.js";
import { BcSession } from "../src/session.js";

export const TOKEN = "test-token-value-123456";

export function testConfig(overrides = {}) {
  return {
    token: TOKEN,
    allowWrite: true,
    allowlist: null,
    callTimeoutMs: 1000,
    queueTimeoutMs: 400,
    bodyLimitBytes: 64 * 1024,
    ...overrides,
  };
}

export function captureLogger(secrets = []) {
  const lines = [];
  const stream = { write(chunk) { lines.push(String(chunk)); } };
  const logger = createLogger({ level: "debug", secrets, stream });
  return { logger, lines, text: () => lines.join("") };
}

export function scriptedClient(handler) {
  const calls = [];
  return {
    calls,
    onclose: null,
    closed: false,
    async callTool(params) {
      calls.push(params);
      return handler(params, calls);
    },
    async close() {
      this.closed = true;
      this.onclose?.();
    },
  };
}

export function poolFromHandler(handler, { size = 1, queueTimeoutMs = 400, callTimeoutMs = 1000, logger } = {}) {
  let created = 0;
  const sessions = [];
  const pool = new SessionPool({
    size,
    queueTimeoutMs,
    logger,
    createSession: async () => {
      created += 1;
      const generation = created;
      const client = scriptedClient((params, calls) => handler(params, { generation, calls }));
      const session = new BcSession(client, { callTimeoutMs, logger });
      session.clientRef = client;
      sessions.push(session);
      return session;
    },
  });
  return { pool, sessions, created: () => created };
}

export async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

export async function stop(fx) {
  fx.server.closeAllConnections?.();
  if (fx.server.listening) {
    await new Promise((resolve, reject) => {
      fx.server.close((err) => (err ? reject(err) : resolve()));
    });
  }
  await fx.pool?.close?.();
}

export function authHeaders(extra = {}) {
  return { authorization: `Bearer ${TOKEN}`, ...extra };
}
