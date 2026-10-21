import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeKeyId } from "../src/auth.js";
import { createServer } from "../src/http.js";
import { authHeaders, captureLogger, listen, poolFromHandler, stop, testConfig, TOKEN } from "./helpers.js";

function bcOk(value) {
  return { structuredContent: value };
}

function bcErr(code, message) {
  return { isError: true, structuredContent: { error: { code, message } } };
}

async function fixture(handler, configOverrides = {}) {
  const logs = captureLogger();
  const backing = poolFromHandler(handler, {
    logger: logs.logger,
    queueTimeoutMs: configOverrides.queueTimeoutMs ?? 300,
    callTimeoutMs: configOverrides.callTimeoutMs ?? 1000,
  });
  const config = testConfig({ queueTimeoutMs: 300, callTimeoutMs: 1000, ...configOverrides });
  const server = createServer({ config, pool: backing.pool, logger: logs.logger });
  const base = await listen(server);
  return { ...backing, ...logs, server, base, config };
}

async function json(base, path, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...authHeaders(), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  return { status: response.status, payload, text };
}

test("key-id met stuurtekens wordt niet letterlijk gelogd", () => {
  assert.equal(sanitizeKeyId("regel\nmet token " + TOKEN), "invalid");
  assert.equal(sanitizeKeyId("sleutel-1"), "sleutel-1");
});

test("health vereist het bearer-token en opent geen BC-sessie", async (t) => {
  const fx = await fixture(() => bcOk({}));
  t.after(() => stop(fx));
  const open = await fetch(`${fx.base}/health`);
  assert.equal(open.status, 401);
  const wrong = await fetch(`${fx.base}/health`, { headers: { authorization: "Bearer nope-nope-nope" } });
  assert.equal(wrong.status, 401);
  const ok = await json(fx.base, "/health");
  assert.equal(ok.status, 200);
  assert.equal(ok.payload.ok, true);
  assert.equal(ok.payload.pool.ready, 0);
  assert.equal(fx.created(), 0);
  assert.equal(fx.text().includes(TOKEN), false);
});

test("companies en een pagina: open, lees, sluit, cellen op caption", async (t) => {
  const fx = await fixture(({ name, arguments: args }) => {
    if (name === "bc_list_companies") return bcOk({ currentCompany: "KVT", companies: [{ name: "KVT", displayName: "KVT" }] });
    if (name === "bc_switch_company") return bcOk({ companyName: args.companyName });
    if (name === "bc_open_page") return bcOk({ pageContextId: `page-${args.pageId}` });
    if (name === "bc_read_data") {
      return bcOk({
        stateVersion: 2,
        section: {
          sectionId: args.section || "header",
          kind: "header",
          caption: "Klanten",
          totalRowCount: 40,
          rows: [{ bookmark: "bk", cells: { "No.": "10000", Name: "Adatum", City: "London" } }],
        },
      });
    }
    if (name === "bc_close_page") return bcOk({ closed: true });
    throw new Error(name);
  });
  t.after(() => stop(fx));

  const companies = await json(fx.base, "/companies", { headers: { "x-mimir-key-id": "sleutel-1" } });
  assert.equal(companies.status, 200);
  assert.equal(companies.payload.currentCompany, "KVT");
  assert.match(fx.text(), /sleutel-1/);

  const page = await json(fx.base, "/page/22?company=Koninklijke%20van%20Twist&filter=City=London&filter=No.=10000&columns=No.,Name&top=10&skip=5&section=lines");
  assert.equal(page.status, 200);
  assert.equal(page.payload.rows[0].cells.Name, "Adatum");
  assert.equal(page.payload.company, "Koninklijke van Twist");
  const names = fx.sessions[0].clientRef.calls.map((call) => call.name);
  assert.deepEqual(names, [
    "bc_list_companies",
    "bc_switch_company",
    "bc_open_page",
    "bc_read_data",
    "bc_close_page",
  ]);
  const read = fx.sessions[0].clientRef.calls.find((call) => call.name === "bc_read_data");
  assert.deepEqual(read.arguments.filters, [
    { column: "City", value: "London" },
    { column: "No.", value: "10000" },
  ]);
  assert.deepEqual(read.arguments.columns, ["No.", "Name"]);
  assert.deepEqual(read.arguments.range, { offset: 5, limit: 10 });
  assert.equal(read.arguments.section, "lines");

  const again = await json(fx.base, "/page/22?company=Koninklijke%20van%20Twist");
  assert.equal(again.status, 200);
  const secondSwitch = fx.sessions[0].clientRef.calls.filter((call) => call.name === "bc_switch_company");
  assert.equal(secondSwitch.length, 1);
});

test("een leesfout sluit de pagina alsnog", async (t) => {
  const fx = await fixture(({ name }) => {
    if (name === "bc_open_page") return bcOk({ pageContextId: "ctx" });
    if (name === "bc_read_data") return bcErr("NOT_FOUND", "geen rijen");
    if (name === "bc_close_page") return bcOk({ closed: true });
    throw new Error(name);
  });
  t.after(() => stop(fx));
  const page = await json(fx.base, "/page/21");
  assert.equal(page.status, 400);
  assert.equal(page.payload.code, "NOT_FOUND");
  assert.deepEqual(fx.sessions[0].clientRef.calls.map((call) => call.name), ["bc_open_page", "bc_read_data", "bc_close_page"]);
});

test("dode sessie wordt één keer opnieuw ingelogd bij lezen, niet bij schrijven", async (t) => {
  const fx = await fixture(({ name }, ctx) => {
    if (ctx.generation === 1) return bcErr("SESSION_LOST", "weg");
    if (name === "bc_list_companies") return bcOk({ currentCompany: "KVT", companies: [] });
    return bcOk({ ok: true });
  });
  t.after(() => stop(fx));
  const companies = await json(fx.base, "/companies");
  assert.equal(companies.status, 200);
  assert.equal(companies.payload.currentCompany, "KVT");
  assert.equal(fx.created(), 2);

  const writeFx = await fixture(() => bcErr("SESSION_LOST", "weg"));
  t.after(() => stop(writeFx));
  const write = await json(writeFx.base, "/call", {
    method: "POST",
    body: { tool: "bc_write_data", args: { pageContextId: "x", fields: { Name: "A" } } },
  });
  assert.equal(write.status, 503);
  assert.equal(write.payload.code, "SESSION_LOST");
  assert.equal(writeFx.created(), 1);
});

test("schrijven uit en allowlist gelden voor POST /call", async (t) => {
  let calls = 0;
  const fx = await fixture(() => {
    calls += 1;
    return bcOk({});
  }, { allowWrite: false, allowlist: new Set(["bc_list_companies", "bc_write_data"]) });
  t.after(() => stop(fx));
  const deniedWrite = await json(fx.base, "/call", {
    method: "POST",
    body: { tool: "bc_write_data", args: { pageContextId: "x", fields: { Name: "A" } } },
  });
  assert.equal(deniedWrite.status, 403);
  const deniedRead = await json(fx.base, "/call", {
    method: "POST",
    body: { tool: "bc_read_data", args: { pageContextId: "x" } },
  });
  assert.equal(deniedRead.status, 403);
  const allowed = await json(fx.base, "/companies");
  assert.equal(allowed.status, 200);
  assert.equal(calls, 1);
});

test("POST /call deelt één sessie en ruimt pagina's op", async (t) => {
  const fx = await fixture(({ name, arguments: args }) => {
    if (name === "bc_open_page") return bcOk({ pageContextId: "ctx-1", sections: [] });
    if (name === "bc_read_data") return bcOk({ section: { rows: [{ bookmark: "b", cells: { Name: "Uit " + args.pageContextId } }] }, stateVersion: 1 });
    if (name === "bc_close_page") return bcOk({ closed: true });
    throw new Error(name);
  });
  t.after(() => stop(fx));
  const response = await json(fx.base, "/call", {
    method: "POST",
    body: {
      calls: [
        { tool: "bc_open_page", args: { pageId: 22 } },
        { tool: "bc_read_data", args: { pageContextId: "$0.pageContextId" } },
      ],
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.payload.calls[1].result.section.rows[0].cells.Name, "Uit ctx-1");
  assert.deepEqual(response.payload.closedPages, ["ctx-1"]);
  assert.equal(fx.created(), 1);
});

test("ongeldige route, methode, json en een te grote body", async (t) => {
  const fx = await fixture(() => bcOk({}));
  t.after(() => stop(fx));
  assert.equal((await json(fx.base, "/nope")).status, 404);
  assert.equal((await json(fx.base, "/health", { method: "POST", body: {} })).status, 405);
  const bad = await fetch(`${fx.base}/call`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: "{",
  });
  assert.equal(bad.status, 400);
  const big = await fetch(`${fx.base}/call`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ tool: "bc_list_companies", args: { pad: "x".repeat(80_000) } }),
  });
  assert.equal(big.status, 413);
  const key = await json(fx.base, "/health", { headers: { "x-mimir-key-id": "bad/id" } });
  assert.equal(key.status, 200);
  assert.match(fx.text(), /"keyId":"invalid"/);
  assert.equal(fx.text().includes("bad/id"), false);
  assert.equal(fx.text().includes(TOKEN), false);
});

test("wachtrij-timeout wordt 503", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fx = await fixture(
    () => gate.then(() => bcOk({ currentCompany: "KVT", companies: [] })),
    { queueTimeoutMs: 80, callTimeoutMs: 5000 },
  );
  t.after(() => stop(fx));
  const first = json(fx.base, "/companies");
  const deadline = Date.now() + 1000;
  while (fx.pool.stats().busy !== 1) {
    if (Date.now() > deadline) throw new Error("sessie werd niet bezet");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const second = await json(fx.base, "/companies");
  assert.equal(second.status, 503);
  assert.equal(second.payload.code, "QUEUE_TIMEOUT");
  release();
  assert.equal((await first).status, 200);
});
