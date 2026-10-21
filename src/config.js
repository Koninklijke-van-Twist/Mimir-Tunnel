import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function intEnv(env, name, fallback, { min, max } = {}) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} moet een geheel getal zijn`);
  }
  if (min != null && parsed < min) throw new Error(`${name} moet >= ${min} zijn`);
  if (max != null && parsed > max) throw new Error(`${name} moet <= ${max} zijn`);
  return parsed;
}

function boolEnv(env, name, fallback) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  const value = String(raw).trim().toLowerCase();
  if (["true", "1", "yes"].includes(value)) return true;
  if (["false", "0", "no"].includes(value)) return false;
  throw new Error(`${name} moet true of false zijn`);
}

function required(env, name) {
  const value = env[name];
  if (value == null || String(value).trim() === "") {
    throw new Error(`${name} is niet gezet`);
  }
  return String(value);
}

/** Lege of afwezige TUNNEL_TOOL_ALLOWLIST = geen filter. */
export function parseAllowlist(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  const names = String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) return null;
  return new Set(names);
}

/**
 * Laadt .env uit de working directory zonder bestaande proces-env te overschrijven
 * (systemd EnvironmentFile wint). Waarden tussen gelijke quotes worden gestript
 * voor lokaal gebruik; in een systemd EnvironmentFile zijn quotes géén syntax.
 */
export function loadDotenv(file = resolve(process.cwd(), ".env"), env = process.env) {
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (env[key] == null || env[key] === "") env[key] = value;
  }
}

export function loadConfig(env = process.env) {
  const token = required(env, "TUNNEL_TOKEN");
  if (token.length < 16) {
    throw new Error("TUNNEL_TOKEN moet minimaal 16 tekens zijn");
  }
  const baseUrl = required(env, "BC_BASE_URL").replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("BC_BASE_URL is geen geldige URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("BC_BASE_URL moet http of https zijn");
  }

  return {
    host: "127.0.0.1",
    port: intEnv(env, "TUNNEL_PORT", 8787, { min: 1, max: 65535 }),
    token,
    poolSize: intEnv(env, "TUNNEL_POOL_SIZE", 1, { min: 1, max: 4 }),
    allowWrite: boolEnv(env, "TUNNEL_ALLOW_WRITE", true),
    allowlist: parseAllowlist(env.TUNNEL_TOOL_ALLOWLIST),
    callTimeoutMs: intEnv(env, "TUNNEL_CALL_TIMEOUT_MS", 120_000, { min: 1000, max: 600_000 }),
    queueTimeoutMs: intEnv(env, "TUNNEL_QUEUE_TIMEOUT_MS", 180_000, { min: 100, max: 600_000 }),
    bodyLimitBytes: intEnv(env, "TUNNEL_BODY_LIMIT_BYTES", 12 * 1024 * 1024, { min: 1024, max: 64 * 1024 * 1024 }),
    logLevel: env.LOG_LEVEL || "info",
    bc: {
      baseUrl,
      auth: env.BC_AUTH || "NavUserPassword",
      tenantId: env.BC_TENANT_ID || "default",
      username: required(env, "BC_USERNAME"),
      password: required(env, "BC_PASSWORD"),
      serverMajor: env.BC_SERVER_MAJOR || "26",
      clientVersion: env.BC_CLIENT_VERSION || "26.3.0.0",
      odataCompany: env.BC_ODATA_COMPANY || "",
      reconnectMaxRetries: env.BC_RECONNECT_MAX_RETRIES == null || env.BC_RECONNECT_MAX_RETRIES === ""
        ? "0"
        : String(env.BC_RECONNECT_MAX_RETRIES),
    },
  };
}
