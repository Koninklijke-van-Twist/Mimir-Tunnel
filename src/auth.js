import { createHash, timingSafeEqual } from "node:crypto";

export function presentedBearer(req) {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : null;
}

export function tokenMatches(presented, expected) {
  const a = createHash("sha256").update(presented ?? "", "utf8").digest();
  const b = createHash("sha256").update(expected ?? "", "utf8").digest();
  return presented != null && presented.length > 0 && timingSafeEqual(a, b);
}

export function sanitizeKeyId(value) {
  if (value == null || value === "") return undefined;
  const raw = Array.isArray(value) ? value[0] : String(value);
  if (!/^[\w.:@-]{1,80}$/.test(raw)) return "invalid";
  return raw;
}
