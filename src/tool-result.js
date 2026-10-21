import { BcToolError, isTransportError } from "./errors.js";

function parseText(text) {
  if (typeof text !== "string" || text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

export function unwrapToolResult(tool, result) {
  const text = Array.isArray(result?.content)
    ? result.content.find((part) => part?.type === "text")?.text
    : undefined;
  const body = result?.structuredContent ?? parseText(text) ?? {};
  if (result?.isError) {
    const code = body?.error?.code || body?.code || "BC_ERROR";
    const message = body?.error?.message || body?.message || text || `${tool} mislukt`;
    throw new BcToolError(tool, code, message, { details: body?.error?.details });
  }
  return body;
}

export function markTransport(err) {
  if (isTransportError(err)) err.fatal = true;
  return err;
}
