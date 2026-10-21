import { BadRequestError } from "./errors.js";

const PLACEHOLDER = /^\$(\d+)(?:\.(.+))?$/;

function getPath(value, path) {
  let current = value;
  for (const part of path.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Vervangt in argumenten een string die exact `$0.pageContextId` is door het
 * resultaat van call 0. Alleen de hele string, zodat filtertekst met een `$`
 * intact blijft.
 */
export function resolveArgs(args, previousResults) {
  if (Array.isArray(args)) return args.map((item) => resolveArgs(item, previousResults));
  if (args && typeof args === "object") {
    const out = {};
    for (const [key, value] of Object.entries(args)) {
      out[key] = resolveArgs(value, previousResults);
    }
    return out;
  }
  if (typeof args !== "string") return args;
  const match = PLACEHOLDER.exec(args);
  if (!match) return args;
  const index = Number(match[1]);
  if (!Number.isInteger(index) || index < 0 || index >= previousResults.length) {
    throw new BadRequestError(`Placeholder $${index} wijst niet naar een eerder resultaat in deze transactie`);
  }
  if (!match[2]) return previousResults[index];
  const resolved = getPath(previousResults[index], match[2]);
  if (resolved === undefined) {
    throw new BadRequestError(`Placeholder $${index}.${match[2]} is leeg`);
  }
  return resolved;
}
