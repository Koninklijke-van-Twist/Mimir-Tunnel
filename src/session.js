import { BcToolError, CallTimeoutError } from "./errors.js";
import { markTransport, unwrapToolResult } from "./tool-result.js";

/**
 * Eén ingelogde MCP-sessie (één stdio-proces van business-central-mcp).
 * De login gebeurt lui, bij de eerste tool-call in dat proces.
 */
export class BcSession {
  constructor(client, { callTimeoutMs, logger }) {
    this.client = client;
    this.callTimeoutMs = callTimeoutMs;
    this.logger = logger;
    this.dead = false;
    this.tainted = false;
    this.company = null;
    const previous = client.onclose;
    client.onclose = () => {
      this.dead = true;
      if (typeof previous === "function") previous();
    };
  }

  async call(tool, args = {}) {
    if (this.dead) {
      throw new BcToolError(tool, "SESSION_LOST", "BC-sessie is dood", { fatal: true });
    }
    const started = Date.now();
    let timer;
    const pending = this.client.callTool(
      { name: tool, arguments: args },
      undefined,
      { timeout: this.callTimeoutMs },
    );
    pending.catch(() => {});
    try {
      const result = await Promise.race([
        pending,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new CallTimeoutError(tool, this.callTimeoutMs)), this.callTimeoutMs);
        }),
      ]);
      const value = unwrapToolResult(tool, result);
      this.logger?.info("bc.call", { tool, ms: Date.now() - started, ok: true });
      return value;
    } catch (err) {
      markTransport(err);
      // De SDK kan de call zelf op timeout zetten terwijl het kindproces nog
      // in BC bezig is. Die sessie niet hergebruiken.
      if (!(err instanceof BcToolError) && /timed out/i.test(String(err?.message || ""))) {
        err.fatal = true;
        err.timeout = true;
        err.status = 504;
        err.code = "TIMEOUT";
      }
      if (err.fatal || err.timeout) this.dead = true;
      this.logger?.info("bc.call", {
        tool,
        ms: Date.now() - started,
        ok: false,
        code: err.code || (err.timeout ? "TIMEOUT" : "ERROR"),
      });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async close() {
    this.dead = true;
    await this.client.close?.();
  }
}
