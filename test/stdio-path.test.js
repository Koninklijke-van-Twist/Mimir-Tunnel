import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { stdioServerPath } from "../src/mcp-client.js";

test("het stdio-serverbestand van business-central-mcp is aanwezig", () => {
  const path = stdioServerPath();
  assert.match(path, /stdio-server\.js$/);
  assert.equal(existsSync(path), true);
});
