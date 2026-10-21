import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const require = createRequire(import.meta.url);

export function stdioServerPath() {
  const pkgJson = require.resolve("business-central-mcp/package.json");
  return join(dirname(pkgJson), "dist/stdio-server.js");
}

/**
 * Start één stdio-proces van business-central-mcp. De login naar BC gebeurt
 * in dat proces bij de eerste tool-call. STATE_DIR is per proces, zodat
 * sessies in de pool elkaars operation-ledger niet delen.
 */
export async function createBcClient(config, logger) {
  const bc = config.bc;
  const stateDir = mkdtempSync(join(tmpdir(), "mimir-bc-"));
  const env = {
    BC_BASE_URL: bc.baseUrl,
    BC_AUTH: bc.auth,
    BC_TENANT_ID: bc.tenantId,
    BC_USERNAME: bc.username,
    BC_PASSWORD: bc.password,
    BC_SERVER_MAJOR: String(bc.serverMajor),
    BC_CLIENT_VERSION: bc.clientVersion,
    BC_RECONNECT_MAX_RETRIES: String(bc.reconnectMaxRetries),
    LOG_LEVEL: "info",
    STATE_DIR: stateDir,
    LOG_DIR: stateDir,
  };
  if (bc.odataCompany) env.BC_ODATA_COMPANY = bc.odataCompany;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [stdioServerPath()],
    env,
    stderr: "pipe",
  });
  if (transport.stderr) {
    let buffer = "";
    transport.stderr.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const redacted = logger?.redact(line) ?? line;
        if (redacted.trim()) process.stderr.write(`[bc-mcp] ${redacted}\n`);
      }
    });
  }

  const client = new Client({ name: "mimir-bc-bridge", version: "1.0.0" });
  await client.connect(transport);
  return client;
}
