import assert from "node:assert/strict";
import test from "node:test";
import { parsePageQuery, readPage, shapePage } from "../src/pages.js";
import { collectPageIds, normalizeCalls, runTransaction } from "../src/transaction.js";
import { BcSession } from "../src/session.js";
import { captureLogger, scriptedClient } from "./helpers.js";

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

function bcOk(value) {
  return { structuredContent: value };
}

function bcErr(code, message) {
  return { isError: true, structuredContent: { error: { code, message } } };
}

function row(bookmark, cells) {
  return { bookmark, cells };
}

function section(rows, extra = {}) {
  return bcOk({
    stateVersion: 3,
    section: {
      sectionId: "header",
      kind: "header",
      caption: "Lijst",
      totalRowCount: extra.totalRowCount ?? rows.length,
      rows,
      ...extra.section,
    },
  });
}

function openClose(handler) {
  return scriptedClient((params) => {
    const { name, arguments: args } = params;
    if (name === "bc_open_page") return bcOk({ pageContextId: "ctx" });
    if (name === "bc_close_page") return bcOk({ closed: true });
    if (name === "bc_read_data") return handler(args, params);
    throw new Error(name);
  });
}

test("serverfilter in een klein venster blijft één bc_read_data", async () => {
  const client = openClose((args) => section([row("bk", { Naam: "Adatum" })]));
  const session = new BcSession(client, { callTimeoutMs: 200 });
  const page = await readPage(session, {
    pageId: 22,
    filters: [{ column: "City", value: "London" }],
    columns: ["Naam"],
    top: 10,
    skip: 5,
    section: "lines",
  });
  assert.equal(page.filterMode, "server");
  assert.equal(page.truncated, undefined);
  const read = client.calls.find((call) => call.name === "bc_read_data");
  assert.deepEqual(read.arguments.filters, [{ column: "City", value: "London" }]);
  assert.deepEqual(read.arguments.range, { offset: 5, limit: 10 });
  assert.equal(read.arguments.section, "lines");
});

test("columnBinderPath valt terug op client-filter en respecteert top", async () => {
  const logs = captureLogger();
  const rows = [
    row("1", { "Nr.": "1", Naam: "Alpha" }),
    row("2", { "Nr.": "2", Naam: "Twist" }),
    row("3", { "Nr.": "3", Naam: "twist bv" }),
    row("4", { "Nr.": "4", Naam: "Anders" }),
  ];
  const client = openClose((args) => {
    if (args.filters) return bcErr("PROTOCOL_ERROR", "Column Naam has no columnBinderPath for filtering");
    assert.equal(args.columns, undefined);
    return section(rows, { totalRowCount: 4 });
  });
  const session = new BcSession(client, { callTimeoutMs: 200, logger: logs.logger });
  const page = await readPage(session, {
    pageId: 22,
    filters: [
      { column: "Naam", value: "*twist*" },
      { column: "Nr.", value: "<>1" },
    ],
    columns: ["Naam"],
    top: 1,
    skip: 1,
  }, logs.logger);
  assert.equal(page.filterMode, "client");
  assert.equal(page.truncated, undefined);
  assert.equal(page.rows.length, 1);
  assert.deepEqual(page.rows[0].cells, { Naam: "twist bv" });
  assert.match(logs.text(), /page.filter_fallback/);
  assert.equal(logs.text().includes("*twist*"), false);
  assert.equal(logs.text().includes("columnBinderPath"), false);
  const reads = client.calls.filter((call) => call.name === "bc_read_data");
  assert.equal(reads.length, 2);
  assert.ok(reads[0].arguments.filters);
  assert.equal(reads[1].arguments.filters, undefined);
  assert.deepEqual(client.calls.map((call) => call.name), ["bc_open_page", "bc_read_data", "bc_read_data", "bc_close_page"]);
});

test("kaart zonder repeater filtert fields en houdt een lege lijst bij een mis", async () => {
  const fields = [
    { name: "Servicenaam", value: "Alpha" },
    { name: "Nr.", value: "9" },
  ];
  const client = openClose((args) => {
    if (args.filters) return bcErr("PROTOCOL_ERROR", "Page has no repeater -- cannot filter");
    return bcOk({ section: { sectionId: "header", kind: "header", caption: "Kaart", fields } });
  });
  const session = new BcSession(client, { callTimeoutMs: 200 });
  const hit = await readPage(session, {
    pageId: 11333028,
    filters: [{ column: "Servicenaam", value: "alpha" }],
    columns: ["Servicenaam"],
    top: undefined,
    skip: undefined,
  });
  assert.equal(hit.filterMode, "client");
  assert.deepEqual(hit.rows, []);
  assert.deepEqual(hit.fields, [{ name: "Servicenaam", value: "Alpha" }]);

  const miss = await readPage(session, {
    pageId: 11333028,
    filters: [{ column: "Servicenaam", value: "Beta" }],
    columns: [],
    top: undefined,
    skip: undefined,
  });
  assert.deepEqual(miss.fields, []);
  assert.deepEqual(miss.rows, []);
});

test("Filter column not found en een andere protocolfout vallen niet terug", async () => {
  for (const message of ["Filter column not found: Zz", "Page context not found: ctx"]) {
    const client = openClose(() => bcErr("PROTOCOL_ERROR", message));
    const session = new BcSession(client, { callTimeoutMs: 200 });
    await assert.rejects(() => readPage(session, {
      pageId: 22,
      filters: [{ column: "Zz", value: "1" }],
      columns: [],
      top: 10,
      skip: 0,
    }), (err) => err.code === "PROTOCOL_ERROR" && err.status === 502);
    assert.equal(client.calls.filter((call) => call.name === "bc_read_data").length, 1);
    assert.equal(client.calls.at(-1).name, "bc_close_page");
  }
});

test("serverfilter boven 50 blijft op elke leesactie staan", async () => {
  const client = openClose((args) => {
    assert.deepEqual(args.filters, [{ column: "Naam", value: "A" }]);
    const start = args.range.offset;
    const count = start >= 50 ? 10 : 50;
    const rows = Array.from({ length: count }, (_, i) => row(`b${start + i}`, { Naam: "A" }));
    return section(rows, { totalRowCount: 60 });
  });
  const session = new BcSession(client, { callTimeoutMs: 200 });
  const page = await readPage(session, {
    pageId: 22,
    filters: [{ column: "Naam", value: "A" }],
    columns: [],
    top: 60,
    skip: 0,
  });
  assert.equal(page.filterMode, "server");
  assert.equal(page.rows.length, 60);
  assert.equal(page.truncated, undefined);
});

test("top boven 50 wordt in stukken van 50 gelezen", async () => {
  const client = openClose((args) => {
    const start = args.range.offset;
    const count = start >= 100 ? 20 : 50;
    const rows = Array.from({ length: count }, (_, i) => row(`b${start + i}`, { Naam: `R${start + i}` }));
    return section(rows, { totalRowCount: 120 });
  });
  const session = new BcSession(client, { callTimeoutMs: 200 });
  const page = await readPage(session, {
    pageId: 810, filters: [], columns: [], top: 120, skip: 0,
  });
  assert.equal(page.rows.length, 120);
  assert.equal(page.rows[0].bookmark, "b0");
  assert.equal(page.rows[119].bookmark, "b119");
  assert.equal(page.truncated, undefined);
  const reads = client.calls.filter((call) => call.name === "bc_read_data");
  assert.deepEqual(reads.map((call) => call.arguments.range), [
    { offset: 0, limit: 50 },
    { offset: 50, limit: 50 },
    { offset: 100, limit: 50 },
  ]);
});

test("een leeg vervolg herleest het begin als het venster vervangen is", async () => {
  let phase = 0;
  const client = openClose((args) => {
    if (args.range.offset >= 50) {
      phase = 1;
      return section([], { totalRowCount: 80 });
    }
    const start = phase === 0 ? 0 : 50;
    const rows = Array.from({ length: 50 }, (_, i) => row(`b${start + i}`, { Naam: `R${start + i}` }));
    return section(rows, { totalRowCount: 80 });
  });
  const session = new BcSession(client, { callTimeoutMs: 200 });
  const page = await readPage(session, {
    pageId: 810, filters: [], columns: [], top: 80, skip: 0,
  });
  assert.equal(page.rows.length, 80);
  assert.equal(page.rows[50].bookmark, "b50");
  assert.equal(page.truncated, undefined);
});

test("stilvallend venster van 50 zet truncated", async () => {
  const rows = Array.from({ length: 50 }, (_, i) => row(`b${i}`, { Naam: `R${i}` }));
  const client = openClose((args) => {
    if (args.range.offset >= 50) return section([], { totalRowCount: 500 });
    return section(rows, { totalRowCount: 500 });
  });
  const session = new BcSession(client, { callTimeoutMs: 200 });
  const page = await readPage(session, {
    pageId: 810, filters: [], columns: [], top: 500, skip: 0,
  });
  assert.equal(page.rows.length, 50);
  assert.equal(page.truncated, true);
});

test("collectPageIds vindt geneste ids", () => {
  const ids = collectPageIds({
    pageContextId: "a",
    requestPage: { pageContextId: "b" },
    openedPages: [{ targetPageContextId: "c" }],
  });
  assert.deepEqual([...ids].sort(), ["a", "b", "c"]);
});
