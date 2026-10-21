import assert from "node:assert/strict";
import test from "node:test";
import { BcSession } from "../src/session.js";
import { scriptedClient } from "./helpers.js";

test("toolfout met SESSION_LOST maakt de sessie dood", async () => {
  const client = scriptedClient(() => ({
    isError: true,
    structuredContent: { error: { code: "SESSION_LOST", message: "verbinding weg", details: { reconnectFailed: true } } },
  }));
  const session = new BcSession(client, { callTimeoutMs: 200 });
  await assert.rejects(
    () => session.call("bc_list_companies", {}),
    (err) => err.code === "SESSION_LOST" && err.fatal === true && err.status === 503,
  );
  assert.equal(session.dead, true);
});

test("gewone BC-fout laat de sessie leven", async () => {
  const client = scriptedClient(() => ({
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: { code: "BUSINESS_ERROR", message: "veld leeg" } }) }],
  }));
  const session = new BcSession(client, { callTimeoutMs: 200 });
  await assert.rejects(() => session.call("bc_write_data", { fields: {} }), (err) => err.code === "BUSINESS_ERROR" && err.status === 400);
  assert.equal(session.dead, false);
});

test("geslaagd antwoord komt uit structuredContent", async () => {
  const client = scriptedClient(() => ({
    structuredContent: { currentCompany: "Koninklijke van Twist", companies: [] },
  }));
  const session = new BcSession(client, { callTimeoutMs: 200 });
  const value = await session.call("bc_list_companies");
  assert.equal(value.currentCompany, "Koninklijke van Twist");
  assert.equal(client.calls[0].name, "bc_list_companies");
  assert.deepEqual(client.calls[0].arguments, {});
});

test("timeout markeert de sessie dood", async () => {
  let rejectCall = () => {};
  const client = scriptedClient(() => new Promise((_, reject) => { rejectCall = reject; }));
  const session = new BcSession(client, { callTimeoutMs: 30 });
  await assert.rejects(
    () => session.call("bc_read_data", { pageContextId: "x" }),
    (err) => err.code === "TIMEOUT" && err.status === 504,
  );
  assert.equal(session.dead, true);
  rejectCall(new Error("afgebroken"));
});

test("transportfout EPIPE markeert de sessie dood", async () => {
  const client = scriptedClient(() => {
    throw new Error("read EPIPE");
  });
  const session = new BcSession(client, { callTimeoutMs: 200 });
  await assert.rejects(() => session.call("bc_open_page", { pageId: 22 }), /EPIPE/);
  assert.equal(session.dead, true);
});
