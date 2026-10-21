import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, loadDotenv, parseAllowlist } from "../src/config.js";

function env(overrides = {}) {
  return {
    TUNNEL_TOKEN: "0123456789abcdef",
    BC_BASE_URL: "https://kvtmd365.kvt.nl/KVTMDLive_NUP",
    BC_USERNAME: "POWERBISERV",
    BC_PASSWORD: "geheim",
    ...overrides,
  };
}

test("defaults: loopback, poort, pool 1, schrijven aan, geen allowlist, geen reconnect", () => {
  const config = loadConfig(env());
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 8787);
  assert.equal(config.poolSize, 1);
  assert.equal(config.allowWrite, true);
  assert.equal(config.allowlist, null);
  assert.equal(config.bc.auth, "NavUserPassword");
  assert.equal(config.bc.tenantId, "default");
  assert.equal(config.bc.serverMajor, "26");
  assert.equal(config.bc.clientVersion, "26.3.0.0");
  assert.equal(config.bc.reconnectMaxRetries, "0");
  assert.equal(config.bc.password, "geheim");
});

test("lege allowlist is hetzelfde als niet gezet", () => {
  assert.equal(parseAllowlist(undefined), null);
  assert.equal(parseAllowlist("  "), null);
  assert.deepEqual([...loadConfig(env({ TUNNEL_TOOL_ALLOWLIST: "bc_read_data, bc_open_page" })).allowlist], [
    "bc_read_data",
    "bc_open_page",
  ]);
});

test("TUNNEL_ALLOW_WRITE false en poolgrootte", () => {
  const config = loadConfig(env({ TUNNEL_ALLOW_WRITE: "false", TUNNEL_POOL_SIZE: "2", TUNNEL_PORT: "8790" }));
  assert.equal(config.allowWrite, false);
  assert.equal(config.poolSize, 2);
  assert.equal(config.port, 8790);
});

test("weigert kort token, ontbrekend wachtwoord en te grote pool", () => {
  assert.throws(() => loadConfig(env({ TUNNEL_TOKEN: "kort" })), /TUNNEL_TOKEN/);
  assert.throws(() => loadConfig(env({ BC_PASSWORD: "" })), /BC_PASSWORD/);
  assert.throws(() => loadConfig(env({ TUNNEL_POOL_SIZE: "8" })), /TUNNEL_POOL_SIZE/);
});

test("dotenv vult alleen lege variabelen en stript quotes", () => {
  const dir = mkdtempSync(join(tmpdir(), "mimir-env-"));
  const file = join(dir, ".env");
  writeFileSync(file, [
    "# comment",
    "TUNNEL_TOKEN=\"from-file-token-xx\"",
    "BC_PASSWORD='uit-bestand'",
    "ALREADY=bewaard",
    "",
  ].join("\n"));
  const target = { ALREADY: "bewaard", TUNNEL_TOKEN: "" };
  loadDotenv(file, target);
  assert.equal(target.TUNNEL_TOKEN, "from-file-token-xx");
  assert.equal(target.BC_PASSWORD, "uit-bestand");
  assert.equal(target.ALREADY, "bewaard");
});
