import { createServer as createHttpServer } from "node:http";
import { presentedBearer, sanitizeKeyId, tokenMatches } from "./auth.js";
import { BadRequestError, BridgeError, UnauthorizedError } from "./errors.js";
import { listCompanies, parsePageQuery, readPage } from "./pages.js";
import { assertToolAllowed, assertToolsAllowed } from "./policy.js";
import { withSession } from "./pool.js";
import { normalizeCalls, runTransaction, transactionIsReadOnly } from "./transaction.js";

export function createServer({ config, pool, logger }) {
  const server = createHttpServer(async (req, res) => {
    const started = Date.now();
    const keyId = sanitizeKeyId(req.headers["x-mimir-key-id"]);
    const pathOnly = (req.url || "/").split("?")[0];
    let status = 500;
    try {
      if (!tokenMatches(presentedBearer(req), config.token)) {
        throw new UnauthorizedError();
      }
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      status = await route(req, res, { config, pool, logger, url, path, keyId });
    } catch (err) {
      const mapped = err instanceof BridgeError
        ? err
        : new BridgeError("Interne fout", { status: 500, code: "INTERNAL", expose: false });
      status = mapped.status || 500;
      logger.error("request.failed", {
        code: mapped.code,
        message: err.message,
        tool: err.tool,
        keyId,
      });
      const body = {
        ok: false,
        error: mapped.expose === false ? "Interne fout" : mapped.message,
        code: mapped.code || "INTERNAL",
      };
      if (err.tool) body.tool = err.tool;
      if (err.partial?.closedPages) body.closedPages = err.partial.closedPages;
      if (err.partial?.calls) body.calls = err.partial.calls;
      send(res, status, body);
    } finally {
      logger.info("http", {
        method: req.method,
        path: pathOnly,
        status,
        ms: Date.now() - started,
        keyId,
      });
    }
  });
  const budget = config.queueTimeoutMs + (20 * config.callTimeoutMs) + 15_000;
  server.requestTimeout = budget;
  server.headersTimeout = Math.min(60_000, budget - 1);
  return server;
}

async function route(req, res, ctx) {
  const { config, pool, logger, url, path } = ctx;
  if (req.method === "GET" && path === "/health") {
    send(res, 200, {
      ok: true,
      pool: pool.stats(),
      allowWrite: config.allowWrite,
      uptimeSec: Math.round(process.uptime()),
    });
    return 200;
  }
  const pageMatch = /^\/page\/([^/]+)$/.exec(path);
  if (req.method === "GET" && path === "/companies") {
    assertToolAllowed("bc_list_companies", config);
    const result = await withSession(pool, (session) => listCompanies(session), { retry: true });
    send(res, 200, result);
    return 200;
  }
  if (req.method === "GET" && pageMatch) {
    const query = parsePageQuery(url, pageMatch[1]);
    const needed = ["bc_open_page", "bc_read_data"];
    if (query.company) needed.push("bc_switch_company");
    assertToolsAllowed(needed, config);
    const result = await withSession(pool, (session) => readPage(session, query, logger), { retry: true });
    send(res, 200, result);
    return 200;
  }
  if (req.method === "POST" && path === "/call") {
    const body = await readJson(req, config.bodyLimitBytes);
    const spec = normalizeCalls(body);
    for (const call of spec.calls) assertToolAllowed(call.tool, config);
    const result = await withSession(
      pool,
      (session) => runTransaction(session, spec, logger),
      { retry: transactionIsReadOnly(spec) },
    );
    send(res, 200, result);
    return 200;
  }
  if (path === "/health" || path === "/companies" || path === "/call" || pageMatch) {
    throw new BridgeError("Method not allowed", { status: 405, code: "METHOD_NOT_ALLOWED" });
  }
  throw new BridgeError("Niet gevonden", { status: 404, code: "NOT_FOUND" });
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(payload);
}

async function readJson(req, limit) {
  const declared = req.headers["content-length"];
  if (declared != null && Number(declared) > limit) {
    throw new BridgeError("Body te groot", { status: 413, code: "BODY_TOO_LARGE" });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw new BridgeError("Body te groot", { status: 413, code: "BODY_TOO_LARGE" });
    }
    chunks.push(chunk);
  }
  if (size === 0) throw new BadRequestError("Lege body");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BadRequestError("Ongeldige JSON");
  }
}
