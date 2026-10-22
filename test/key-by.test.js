import assert from "node:assert/strict";
import test from "node:test";
import { applyKeyBy, parseKeyBy } from "../src/key-by.js";
import { parsePageQuery, readPage } from "../src/pages.js";
import { normalizeCalls } from "../src/transaction.js";
import { BcSession } from "../src/session.js";
import { scriptedClient } from "./helpers.js";

test("parseKeyBy: designName, caption, leeg en fout", () => {
  assert.equal(parseKeyBy("designName"), "designName");
  assert.equal(parseKeyBy("DESIGNNAME"), "designName");
  assert.equal(parseKeyBy("caption"), "caption");
  assert.equal(parseKeyBy(""), undefined);
  assert.equal(parseKeyBy(undefined), undefined);
  assert.throws(() => parseKeyBy("odata"), (err) => err.code === "BAD_REQUEST");
});

test("applyKeyBy laat args ongemoeid zonder designName", () => {
  assert.deepEqual(applyKeyBy("bc_read_data", { pageContextId: "p" }, {}), { pageContextId: "p" });
  assert.deepEqual(applyKeyBy("bc_read_data", { pageContextId: "p" }, { keyBy: "caption" }), { pageContextId: "p" });
  assert.deepEqual(applyKeyBy("bc_close_page", { pageContextId: "p" }, { keyBy: "designName" }), { pageContextId: "p" });
  assert.deepEqual(
    applyKeyBy("bc_write_data", { pageContextId: "p", keyBy: "caption" }, { keyBy: "designName" }),
    { pageContextId: "p", keyBy: "caption" },
  );
});

test("GET /page: keyBy via query of header", () => {
  const plain = parsePageQuery(new URL("http://x/page/22"), "22");
  assert.equal(plain.keyBy, undefined);
  const q = parsePageQuery(new URL("http://x/page/22?keyBy=designName&includeColumnMetadata=1"), "22");
  assert.equal(q.keyBy, "designName");
  assert.equal(q.includeColumnMetadata, true);
  const h = parsePageQuery(new URL("http://x/page/22"), "22", { "x-bc-key-by": "designName" });
  assert.equal(h.keyBy, "designName");
});

test("readPage geeft keyBy door aan open en read, niet aan close", async () => {
  const client = scriptedClient(({ name }) => {
    if (name === "bc_open_page") return { structuredContent: { pageContextId: "ctx" } };
    if (name === "bc_read_data") {
      return { structuredContent: { section: { rows: [{ bookmark: "b", cells: { No: "1" } }], columns: [{ key: "No", caption: "Nr.", designName: "No" }] } } };
    }
    if (name === "bc_close_page") return { structuredContent: { ok: true } };
    throw new Error(name);
  });
  const session = new BcSession(client, { callTimeoutMs: 200 });
  const shaped = await readPage(session, {
    pageId: 22, filters: [], columns: [], keyBy: "designName", includeColumnMetadata: true,
  });
  const [open, read, close] = client.calls;
  assert.equal(open.arguments.keyBy, "designName");
  assert.equal(read.arguments.keyBy, "designName");
  assert.equal(read.arguments.includeColumnMetadata, true);
  assert.equal(close.arguments.keyBy, undefined);
  assert.equal(shaped.keyBy, "designName");
  assert.deepEqual(shaped.rows[0].cells, { No: "1" });
  assert.equal(shaped.columns[0].caption, "Nr.");
});

test("readPage zonder keyBy stuurt geen keyBy mee", async () => {
  const client = scriptedClient(({ name }) => {
    if (name === "bc_open_page") return { structuredContent: { pageContextId: "ctx" } };
    if (name === "bc_read_data") return { structuredContent: { section: { rows: [] } } };
    return { structuredContent: { ok: true } };
  });
  const session = new BcSession(client, { callTimeoutMs: 200 });
  const shaped = await readPage(session, { pageId: 22, filters: [], columns: [] });
  for (const call of client.calls) assert.equal("keyBy" in call.arguments, false);
  assert.equal(shaped.keyBy, "caption");
});

test("POST /call: keyBy op body-niveau geldt voor lezen én schrijven", () => {
  const spec = normalizeCalls({
    keyBy: "designName",
    calls: [
      { tool: "bc_open_page", args: { pageId: 21 } },
      { tool: "bc_write_data", args: { pageContextId: "$0.pageContextId", fields: { Name: "A" } } },
      { tool: "bc_close_page", args: { pageContextId: "$0.pageContextId" } },
    ],
  });
  assert.equal(spec.calls[0].args.keyBy, "designName");
  assert.equal(spec.calls[1].args.keyBy, "designName");
  assert.equal(spec.calls[2].args.keyBy, undefined);
  const viaHeader = normalizeCalls({ tool: "bc_read_data", args: { pageContextId: "p" } }, { "x-bc-key-by": "designName" });
  assert.equal(viaHeader.calls[0].args.keyBy, "designName");
  const plain = normalizeCalls({ tool: "bc_read_data", args: { pageContextId: "p" } });
  assert.deepEqual(plain.calls[0].args, { pageContextId: "p" });
});
