import { BadRequestError } from "./errors.js";

/**
 * Optionele sleutelkeuze van business-central-mcp (fork feat/key-by-design-name):
 * `keyBy: "designName"` geeft cellen/velden op de AL-controlnaam (DesignName),
 * taalonafhankelijk. Standaard (niet meegegeven) blijft alles op caption.
 */
export const KEY_BY_HEADER = "x-bc-key-by";

/** Tools die `keyBy` begrijpen. */
export const KEY_BY_TOOLS = new Set([
  "bc_read_data",
  "bc_open_page",
  "bc_navigate",
  "bc_write_data",
  "bc_lookup",
  "bc_execute_action",
  "bc_get_operation",
]);

/** Tools die `includeColumnMetadata` begrijpen. */
export const COLUMN_METADATA_TOOLS = new Set(["bc_read_data", "bc_open_page", "bc_navigate", "bc_get_operation"]);

/** "designName" | "caption" | undefined (niet gevraagd). Ongeldige waarde → 400. */
export function parseKeyBy(raw, source = "keyBy") {
  if (raw == null) return undefined;
  const value = String(raw).trim();
  if (value === "") return undefined;
  const lower = value.toLowerCase();
  if (lower === "designname" || lower === "design_name" || lower === "design-name") return "designName";
  if (lower === "caption") return "caption";
  throw new BadRequestError(`${source} moet "designName" of "caption" zijn`);
}

export function parseBool(raw, source) {
  if (raw == null || raw === "") return undefined;
  if (typeof raw === "boolean") return raw;
  const value = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "ja"].includes(value)) return true;
  if (["0", "false", "no", "nee"].includes(value)) return false;
  throw new BadRequestError(`${source} moet true of false zijn`);
}

/**
 * Zet keyBy/includeColumnMetadata op de args van één call, tenzij de caller die
 * per call al zelf meegaf. Bij keyBy "caption" of niets gaat er niets extra mee,
 * zodat een pakketversie zonder keyBy precies dezelfde args krijgt als vroeger.
 */
export function applyKeyBy(tool, args, { keyBy, includeColumnMetadata } = {}) {
  const out = { ...(args ?? {}) };
  if (keyBy === "designName" && KEY_BY_TOOLS.has(tool) && out.keyBy == null) out.keyBy = keyBy;
  if (includeColumnMetadata === true && COLUMN_METADATA_TOOLS.has(tool) && out.includeColumnMetadata == null) {
    out.includeColumnMetadata = true;
  }
  return out;
}
