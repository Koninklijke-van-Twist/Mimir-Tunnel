import assert from "node:assert/strict";
import test from "node:test";
import { createLogger } from "../src/logger.js";

test("logt geen wachtwoord, token of bearer", () => {
  const lines = [];
  const logger = createLogger({
    level: "info",
    secrets: ["Sup3rGeheim!", "tunnel-token-abcdefgh"],
    stream: { write(chunk) { lines.push(String(chunk)); } },
  });
  logger.info("bc.call", {
    tool: "bc_read_data",
    ms: 4321,
    password: "Sup3rGeheim!",
    note: "Authorization: Bearer tunnel-token-abcdefgh mislukt met Sup3rGeheim!",
  });
  const text = lines.join("");
  assert.match(text, /"ms":4321/);
  assert.match(text, /bc_read_data/);
  assert.equal(text.includes("Sup3rGeheim!"), false);
  assert.equal(text.includes("tunnel-token-abcdefgh"), false);
  assert.match(text, /Bearer \[redacted\]/);
  assert.match(text, /"password":"\[redacted\]"/);
});
