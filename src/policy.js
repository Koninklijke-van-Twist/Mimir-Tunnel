import { ForbiddenError } from "./errors.js";

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
  if (WRITE_TOOLS.has(tool)) return true;
  if (READ_TOOLS.has(tool)) return false;
  // Onbekende toekomstige tools tellen als muterend zolang schrijven uit staat.
  return true;
}

/**
 * allowlist is null als TUNNEL_TOOL_ALLOWLIST niet gezet (of leeg) is.
 * Een gezet allowlist-filter weigert alles wat er niet op staat.
 * TUNNEL_ALLOW_WRITE=false weigert muterende tools ook als ze op de lijst staan.
 */
export function assertToolAllowed(tool, { allowWrite, allowlist }) {
  if (typeof tool !== "string" || !TOOL_NAME.test(tool)) {
    throw new ForbiddenError("Toolnaam is ongeldig");
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
