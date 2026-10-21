import assert from "node:assert/strict";
import test from "node:test";
import { parsePageQuery, readPage, shapePage } from "../src/pages.js";
import { collectPageIds, normalizeCalls, runTransaction } from "../src/transaction.js";
import { BcSession } from "../src/session.js";
import { scriptedClient } from "./helpers.js";

test("querystring wordt filters, kolommen en range", () => {
  const url = new URL("http://127.0.0.1/page/22?company=Koninklijke%20van%20Twist&filter=City=London&filter=No.=10000&columns=No.,Name&top=10&skip=5&section=lines");
  const query = parsePageQuery(url, "22");
  assert.equal(query.pageId, 22);
  assert.equal(query.company, "Koninklijke van Twist");
  assert.deepEqual(query.filters, [
    { column: "City", value: "London" },
    { column: "No.", value: "10000" },
  ]);
  assert.deepEqual(query.columns, ["No.", "Name"]);
  assert.equal(query.top, 10);
  assert.equal(query.skip, 5);
  assert.equal(query.section, "lines");
});

test("rijen houden cellen op caption", () => {
  const shaped = shapePage(22, "KVT", {
    stateVersion: 4,
    section: {
      sectionId: "header",
      kind: "header",
      caption: "Klanten",
      totalRowCount: 1,
      rows: [{ bookmark: "bk", cells: { "No.": "10000", Name: "Adatum" } }],
    },
  });
  assert.deepEqual(shaped.rows[0].cells, { "No.": "10000", Name: "Adatum" });
  assert.equal(shaped.rows[0].bookmark, "bk");
});

test("readPage sluit de pagina ook als lezen mislukt", async () => {
  const client = scriptedClient(({ name }) => {
    if (name === "bc_open_page") return { structuredContent: { pageContextId: "ctx-9" } };
    if (name === "bc_read_data") {
      return { isError: true, structuredContent: { error: { code: "BUSINESS_ERROR", message: "kapot" } } };
    }
    if (name === "bc_close_page") return { structuredContent: { ok: true } };
    throw new Error(name);
  });
  const session = new BcSession(client, { callTimeoutMs: 200 });
  await assert.rejects(() => readPage(session, {
    pageId: 22, filters: [], columns: [], top: undefined, skip: undefined,
  }), (err) => err.code === "BUSINESS_ERROR");
  assert.deepEqual(client.calls.map((call) => call.name), ["bc_open_page", "bc_read_data", "bc_close_page"]);
  assert.equal(client.calls[2].arguments.pageContextId, "ctx-9");
  assert.equal(session.dead, false);
});

test("transactie vervangt placeholders en sluit achtergebleven pagina's", async () => {
  const client = scriptedClient(({ name, arguments: args }) => {
    if (name === "bc_open_page") return { structuredContent: { pageContextId: "ctx-1" } };
    if (name === "bc_read_data") {
      return {
        structuredContent: {
          stateVersion: 1,
          section: { sectionId: "header", rows: [{ bookmark: "b", cells: { Name: args.pageContextId } }] },
        },
      };
    }
    if (name === "bc_execute_action") {
      return { structuredContent: { openedPages: [{ targetPageContextId: "child-7" }] } };
    }
    if (name === "bc_close_page") return { structuredContent: { pageContextId: args.pageContextId, closed: true } };
    throw new Error(name);
  });
  const session = new BcSession(client, { callTimeoutMs: 200 });
  const spec = normalizeCalls({
    calls: [
      { tool: "bc_open_page", args: { pageId: 22 } },
      { tool: "bc_read_data", args: { pageContextId: "$0.pageContextId" } },
      { tool: "bc_execute_action", args: { pageContextId: "$0.pageContextId", action: "New" } },
    ],
  });
  const result = await runTransaction(session, spec);
  assert.equal(result.ok, true);
  assert.equal(client.calls[1].arguments.pageContextId, "ctx-1");
  assert.deepEqual(result.closedPages.sort(), ["child-7", "ctx-1"]);
  const closes = client.calls.filter((call) => call.name === "bc_close_page").map((call) => call.arguments.pageContextId);
  assert.deepEqual(closes.sort(), ["child-7", "ctx-1"]);
});

test("expliciet sluiten wordt niet nog eens gedaan", async () => {
  const client = scriptedClient(({ name }) => {
    if (name === "bc_open_page") return { structuredContent: { pageContextId: "ctx-1" } };
    if (name === "bc_close_page") return { structuredContent: { closed: true, pageContextId: "ctx-1" } };
    throw new Error(name);
  });
  const session = new BcSession(client, { callTimeoutMs: 200 });
  const spec = normalizeCalls({
    calls: [
      { tool: "bc_open_page", args: { pageId: 21 } },
      { tool: "bc_close_page", args: { pageContextId: "$0.pageContextId" } },
    ],
  });
  const result = await runTransaction(session, spec);
  assert.deepEqual(result.closedPages, []);
  assert.equal(client.calls.filter((call) => call.name === "bc_close_page").length, 1);
});

test("collectPageIds vindt geneste ids", () => {
  const ids = collectPageIds({
    pageContextId: "a",
    requestPage: { pageContextId: "b" },
    openedPages: [{ targetPageContextId: "c" }],
  });
  assert.deepEqual([...ids].sort(), ["a", "b", "c"]);
});
