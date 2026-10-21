import assert from "node:assert/strict";
import test from "node:test";
import { assertToolAllowed, isWriteTool, READ_TOOLS, WRITE_TOOLS } from "../src/policy.js";

test("zonder allowlist zijn leestools toegestaan, ook als schrijven uit staat", () => {
  for (const tool of READ_TOOLS) {
    assert.doesNotThrow(() => assertToolAllowed(tool, { allowWrite: false, allowlist: null }));
  }
});

test("schrijven uit weigert muterende tools, ook als ze op de allowlist staan", () => {
  for (const tool of WRITE_TOOLS) {
    assert.throws(
      () => assertToolAllowed(tool, { allowWrite: false, allowlist: new Set([tool]) }),
      (err) => err.status === 403 && err.code === "TOOL_FORBIDDEN",
    );
  }
});

test("schrijven aan laat muterende tools toe", () => {
  assert.doesNotThrow(() => assertToolAllowed("bc_write_data", { allowWrite: true, allowlist: null }));
});

test("allowlist filtert alleen als hij gezet is", () => {
  assert.doesNotThrow(() => assertToolAllowed("bc_lookup", { allowWrite: false, allowlist: null }));
  assert.throws(
    () => assertToolAllowed("bc_lookup", { allowWrite: true, allowlist: new Set(["bc_list_companies"]) }),
    (err) => err.status === 403,
  );
});

test("onbekende bc-tool is 501, een geblokkeerde bekende tool blijft 403", () => {
  assert.equal(isWriteTool("bc_future_post"), false);
  assert.throws(
    () => assertToolAllowed("bc_does_not_exist", { allowWrite: true, allowlist: null }),
    (err) => err.status === 501 && err.code === "UNSUPPORTED_TOOL" && err.tool === "bc_does_not_exist"
      && err.message === "Deze tool wordt niet ondersteund door de bridge",
  );
  assert.throws(
    () => assertToolAllowed("bc_does_not_exist", { allowWrite: false, allowlist: new Set(["bc_does_not_exist"]) }),
    (err) => err.status === 501 && err.code === "UNSUPPORTED_TOOL",
  );
  assert.throws(
    () => assertToolAllowed("bc_write_data", { allowWrite: false, allowlist: null }),
    (err) => err.status === 403 && err.code === "TOOL_FORBIDDEN",
  );
});

test("ongeldige toolnaam wordt geweigerd", () => {
  assert.throws(() => assertToolAllowed("shell", { allowWrite: true, allowlist: null }));
  assert.throws(() => assertToolAllowed("BC_READ_DATA", { allowWrite: true, allowlist: null }));
});
