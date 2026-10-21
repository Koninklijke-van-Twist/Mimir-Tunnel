const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEYS = /password|token|authorization|secret|api[_-]?token/i;
const BEARER = /Bearer\s+\S+/gi;

export function createLogger({ level = "info", secrets = [], stream = process.stderr } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const secretValues = secrets.filter((s) => typeof s === "string" && s.length >= 4);

  function redact(value) {
    if (typeof value === "string") {
      let out = value.replace(BEARER, "Bearer [redacted]");
      for (const secret of secretValues) {
        if (secret && out.includes(secret)) out = out.split(secret).join("[redacted]");
      }
      return out;
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object") {
      const out = {};
      for (const [key, inner] of Object.entries(value)) {
        out[key] = SECRET_KEYS.test(key) ? "[redacted]" : redact(inner);
      }
      return out;
    }
    return value;
  }

  function write(lvl, msg, fields = {}) {
    if ((LEVELS[lvl] ?? LEVELS.info) < min) return;
    const line = JSON.stringify(redact({
      ts: new Date().toISOString(),
      level: lvl,
      msg,
      ...fields,
    }));
    stream.write(`${line}\n`);
  }

  return {
    redact,
    debug: (msg, fields) => write("debug", msg, fields),
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
  };
}
