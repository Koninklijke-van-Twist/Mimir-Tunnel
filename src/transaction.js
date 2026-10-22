import { BadRequestError } from "./errors.js";
import { applyKeyBy, KEY_BY_HEADER, parseBool, parseKeyBy } from "./key-by.js";
import { READ_TOOLS } from "./policy.js";
import { resolveArgs } from "./placeholders.js";

const TOOL_NAME = /^bc_[a-z0-9_]+$/;
const MAX_CALLS = 20;

export function normalizeCalls(body, headers = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BadRequestError("Body moet een JSON-object zijn");
  }
  const hasTool = Object.prototype.hasOwnProperty.call(body, "tool");
  const hasCalls = Object.prototype.hasOwnProperty.call(body, "calls");
  if (hasTool === hasCalls) {
    throw new BadRequestError("Geef óf tool óf calls");
  }
  if (hasCalls) {
    if (!Array.isArray(body.calls) || body.calls.length === 0) {
      throw new BadRequestError("calls moet een niet-lege array zijn");
    }
    if (body.calls.length > MAX_CALLS) {
      throw new BadRequestError(`Maximaal ${MAX_CALLS} calls per transactie`);
    }
    return { batch: true, calls: withKeyBy(body.calls.map(validateCall), body, headers) };
  }
  return { batch: false, calls: withKeyBy([validateCall(body)], body, headers) };
}

/**
 * Optioneel `keyBy` / `includeColumnMetadata` op body-niveau (of header
 * X-BC-Key-By) geldt voor alle calls die het begrijpen; args per call winnen.
 */
function withKeyBy(calls, body, headers) {
  const header = headers?.[KEY_BY_HEADER];
  const keyBy = parseKeyBy(body.keyBy, "keyBy") ?? parseKeyBy(Array.isArray(header) ? header[0] : header, "X-BC-Key-By");
  const includeColumnMetadata = parseBool(body.includeColumnMetadata, "includeColumnMetadata");
  if (!keyBy && includeColumnMetadata == null) return calls;
  return calls.map((call) => ({ tool: call.tool, args: applyKeyBy(call.tool, call.args, { keyBy, includeColumnMetadata }) }));
}

function validateCall(call) {
  if (!call || typeof call !== "object" || Array.isArray(call)) {
    throw new BadRequestError("Elke call moet een object zijn");
  }
  if (typeof call.tool !== "string" || !TOOL_NAME.test(call.tool)) {
    throw new BadRequestError("tool moet een naam als bc_read_data zijn");
  }
  if (call.args == null) return { tool: call.tool, args: {} };
  if (typeof call.args !== "object" || Array.isArray(call.args)) {
    throw new BadRequestError("args moet een object zijn");
  }
  return { tool: call.tool, args: call.args };
}

export function transactionIsReadOnly(spec) {
  return spec.calls.every((call) => READ_TOOLS.has(call.tool));
}

const ID_KEYS = new Set(["pageContextId", "targetPageContextId"]);

export function collectPageIds(value, into = new Set()) {
  if (!value || typeof value !== "object") return into;
  if (Array.isArray(value)) {
    for (const item of value) collectPageIds(item, into);
    return into;
  }
  for (const [key, inner] of Object.entries(value)) {
    if (ID_KEYS.has(key) && typeof inner === "string" && inner) into.add(inner);
    else collectPageIds(inner, into);
  }
  return into;
}

/**
 * Eén HTTP-request = één sessie. Pagina's die in de transactie opengingen en
 * niet met bc_close_page zijn gesloten, sluit de bridge daarna zelf.
 */
export async function runTransaction(session, spec, logger) {
  const started = Date.now();
  const open = new Set();
  const results = [];
  const prior = [];
  let failed = null;

  for (const call of spec.calls) {
    let args;
    try {
      args = resolveArgs(call.args, prior);
    } catch (err) {
      failed = err;
      results.push({ tool: call.tool, ok: false, ms: 0, code: err.code || "BAD_REQUEST", error: err.message });
      break;
    }
    if (call.tool === "bc_close_page" && typeof args?.pageContextId === "string") {
      open.delete(args.pageContextId);
    }
    const callStarted = Date.now();
    try {
      const result = await session.call(call.tool, args);
      if (call.tool === "bc_switch_company" && typeof args.companyName === "string") {
        session.company = args.companyName;
      }
      if (call.tool === "bc_list_companies" && typeof result?.currentCompany === "string") {
        session.company = result.currentCompany;
      }
      if (call.tool !== "bc_close_page") collectPageIds(result, open);
      prior.push(result);
      results.push({ tool: call.tool, ok: true, ms: Date.now() - callStarted, result });
    } catch (err) {
      results.push({
        tool: call.tool,
        ok: false,
        ms: Date.now() - callStarted,
        code: err.code || "ERROR",
        error: err.message,
      });
      failed = err;
      break;
    }
  }

  const closedPages = [];
  if (!session.dead) {
    for (const pageContextId of open) {
      try {
        await session.call("bc_close_page", { pageContextId });
        closedPages.push(pageContextId);
      } catch (err) {
        session.tainted = true;
        logger?.warn("page.close_failed", { code: err.code || "ERROR" });
        if (session.dead) break;
      }
    }
  }

  const payload = spec.batch
    ? { ok: !failed, ms: Date.now() - started, calls: results, closedPages }
    : {
      ok: !failed,
      tool: spec.calls[0].tool,
      ms: results[0]?.ms ?? (Date.now() - started),
      ...(results[0]?.ok ? { result: results[0].result } : { error: results[0]?.error, code: results[0]?.code }),
      closedPages,
    };

  if (failed) {
    if (failed.partial == null) failed.partial = payload;
    throw failed;
  }
  return payload;
}
