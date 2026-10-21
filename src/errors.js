export class BridgeError extends Error {
  constructor(message, { status = 500, code = "INTERNAL", expose = true } = {}) {
    super(message);
    this.name = "BridgeError";
    this.status = status;
    this.code = code;
    this.expose = expose;
  }
}

export class BadRequestError extends BridgeError {
  constructor(message) {
    super(message, { status: 400, code: "BAD_REQUEST" });
    this.name = "BadRequestError";
  }
}

export class UnauthorizedError extends BridgeError {
  constructor() {
    super("Unauthorized", { status: 401, code: "UNAUTHORIZED" });
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends BridgeError {
  constructor(message) {
    super(message, { status: 403, code: "TOOL_FORBIDDEN" });
    this.name = "ForbiddenError";
  }
}

export class UnsupportedToolError extends BridgeError {
  constructor(tool) {
    super("Deze tool wordt niet ondersteund door de bridge", { status: 501, code: "UNSUPPORTED_TOOL" });
    this.name = "UnsupportedToolError";
    this.tool = tool;
  }
}

export class QueueTimeoutError extends BridgeError {
  constructor() {
    super("Geen vrije BC-sessie binnen de wachttijd", { status: 503, code: "QUEUE_TIMEOUT" });
    this.name = "QueueTimeoutError";
  }
}

export class CallTimeoutError extends BridgeError {
  constructor(tool, timeoutMs) {
    super(`Timeout na ${timeoutMs}ms bij ${tool}`, { status: 504, code: "TIMEOUT" });
    this.name = "CallTimeoutError";
    this.tool = tool;
    this.fatal = true;
    this.timeout = true;
  }
}

const CLIENT_CODES = new Set([
  "VALIDATION_ERROR",
  "INVALID_ARGUMENT",
  "NOT_FOUND",
  "BUSINESS_ERROR",
  "STALE_CONTEXT",
  "INVALID_BOOKMARK",
  "OPERATION_ID_REUSED",
  "MULTI_ROW_ACTION_UNAVAILABLE",
  "OPERATION_IN_DOUBT",
]);

const FATAL_SESSION_CODES = new Set(["SESSION_LOST", "ENDPOINT_UNREACHABLE"]);

export function statusForBcCode(code) {
  if (code === "TIMEOUT") return 504;
  if (FATAL_SESSION_CODES.has(code)) return 503;
  if (CLIENT_CODES.has(code)) return 400;
  return 502;
}

export class BcToolError extends BridgeError {
  constructor(tool, code, message, { fatal = false, details } = {}) {
    super(message || `${tool} mislukt`, { status: statusForBcCode(code), code: code || "BC_ERROR" });
    this.name = "BcToolError";
    this.tool = tool;
    this.fatal = fatal || FATAL_SESSION_CODES.has(code);
    this.details = details;
  }
}

export function isFatalSessionError(err) {
  return Boolean(err && (err.fatal || err.timeout || FATAL_SESSION_CODES.has(err.code)));
}

export function isTransportError(err) {
  const msg = String(err?.message || err || "");
  return /EPIPE|ECONNRESET|ECONNREFUSED|socket hang up|Not connected|Connection closed|MCP error -32000|Transport closed/i.test(msg);
}
