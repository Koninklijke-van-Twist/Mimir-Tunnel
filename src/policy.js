import { ForbiddenError, UnsupportedToolError } from "./errors.js";

/** Tools die Tim als lezen classificeert, plus bc_get_operation (alleen naslag). */
export const READ_TOOLS = new Set([
  "bc_list_companies",
  "bc_switch_company",
  "bc_open_page",
  "bc_read_data",
  "bc_navigate",
  "bc_lookup",
  "bc_search_pages",
  "bc_close_page",
  "bc_query",
  "bc_get_operation",
]);

/** Muterend volgens Tim. bc_close_page hoort hier niet bij: opruimen moet altijd kunnen. */
export const WRITE_TOOLS = new Set([
  "bc_write_data",
  "bc_execute_action",
  "bc_respond_dialog",
  "bc_run_report",
  "bc_wizard_navigate",
  "bc_upload_file",
  "bc_run_tests",
]);

const TOOL_NAME = /^bc_[a-z0-9_]+$/;

export function isWriteTool(tool) {
  return WRITE_TOOLS.has(tool);
}

export function isKnownTool(tool) {
  return READ_TOOLS.has(tool) || WRITE_TOOLS.has(tool);
}

/**
 * allowlist is null als TUNNEL_TOOL_ALLOWLIST niet gezet (of leeg) is.
 * Een bc_-naam buiten de lees- en schrijfset is 501 (de bridge kent hem niet).
 * Een gezet allowlist-filter weigert een bekende tool die er niet op staat (403).
 * TUNNEL_ALLOW_WRITE=false weigert bekende muterende tools, ook als ze op de lijst staan (403).
 */
export function assertToolAllowed(tool, { allowWrite, allowlist }) {
  if (typeof tool !== "string" || !TOOL_NAME.test(tool)) {
    throw new ForbiddenError("Toolnaam is ongeldig");
  }
  if (!isKnownTool(tool)) {
    throw new UnsupportedToolError(tool);
  }
  if (!allowWrite && isWriteTool(tool)) {
    throw new ForbiddenError(`${tool} is muterend en TUNNEL_ALLOW_WRITE=false`);
  }
  if (allowlist && !allowlist.has(tool)) {
    throw new ForbiddenError(`${tool} staat niet op TUNNEL_TOOL_ALLOWLIST`);
  }
}

export function assertToolsAllowed(tools, policy) {
  for (const tool of tools) assertToolAllowed(tool, policy);
}
