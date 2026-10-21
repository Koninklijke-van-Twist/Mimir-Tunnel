import { loadConfig, loadDotenv } from "./config.js";
import { createServer } from "./http.js";
import { createLogger } from "./logger.js";
import { createBcClient } from "./mcp-client.js";
import { SessionPool } from "./pool.js";
import { BcSession } from "./session.js";

loadDotenv();
const config = loadConfig();
const logger = createLogger({
  level: config.logLevel,
  secrets: [config.token, config.bc.password, config.bc.username],
});

const pool = new SessionPool({
  size: config.poolSize,
  queueTimeoutMs: config.queueTimeoutMs,
  logger,
  createSession: async () => {
    const client = await createBcClient(config, logger);
    return new BcSession(client, { callTimeoutMs: config.callTimeoutMs, logger });
  },
});

const server = createServer({ config, pool, logger });

server.on("error", (err) => {
  logger.error("listen.failed", { message: err.message, port: config.port });
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  logger.info("listen", {
    host: config.host,
    port: config.port,
    poolSize: config.poolSize,
    allowWrite: config.allowWrite,
    allowlist: config.allowlist ? [...config.allowlist] : null,
  });
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutdown", { signal });
  await new Promise((resolve) => server.close(resolve));
  await pool.close();
  process.exit(0);
}

process.on("SIGINT", () => {
  shutdown("SIGINT").catch((err) => {
    logger.error("shutdown.failed", { message: err.message });
    process.exit(1);
  });
});
process.on("SIGTERM", () => {
  shutdown("SIGTERM").catch((err) => {
    logger.error("shutdown.failed", { message: err.message });
    process.exit(1);
  });
});
