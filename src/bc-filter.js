/**
 * BC-filtersyntax op celtekst, hoofdletterongevoelig.
 * Exact, jokers * en ?, bereik a..b (ook open), vergelijkingen, OF via |.
 * Meerdere filters zijn EN en horen buiten deze functie.
 */

const COMPARE = /^(<>|>=|<=|>|<)(.*)$/;
const NUMBER = /^-?\d+(?:[.,]\d+)?$/;

export function rowMatchesFilters(cells, filters) {
  const source = cells && typeof cells === "object" ? cells : {};
  return filters.every((filter) => {
    const key = Object.keys(source).find((name) => name.toLowerCase() === filter.column.toLowerCase());
    if (!key) return false;
    return matchBcFilter(source[key], filter.value);
  });
}

export function matchBcFilter(cellValue, expr) {
  const value = cellValue == null ? "" : String(cellValue).trim();
  const expression = String(expr ?? "").trim();
  if (expression.includes("|")) {
    return expression.split("|").some((part) => matchAtom(value, part));
  }
  return matchAtom(value, expression);
}

function matchAtom(value, expr) {
  let token = String(expr ?? "").trim();
  if (token.startsWith("@")) token = token.slice(1).trim();
  if (token === "" || token === "''" || token === '""') return value === "";

  const cmp = COMPARE.exec(token);
  if (cmp) return compare(value, cmp[1], cmp[2].trim());

  if (token.includes("..") && !token.includes("*") && !token.includes("?")) {
    const splitAt = token.indexOf("..");
    return inRange(value, token.slice(0, splitAt).trim(), token.slice(splitAt + 2).trim());
  }
  if (token.includes("*") || token.includes("?")) return wildcard(value, token);
  return value.toLowerCase() === token.toLowerCase();
}

function compare(value, op, rhs) {
  const diff = compareValues(value, rhs);
  if (op === ">") return diff > 0;
  if (op === "<") return diff < 0;
  if (op === ">=") return diff >= 0;
  if (op === "<=") return diff <= 0;
  return diff !== 0;
}

function inRange(value, low, high) {
  if (low !== "" && compareValues(value, low) < 0) return false;
  if (high !== "" && compareValues(value, high) > 0) return false;
  return true;
}

function compareValues(left, right) {
  const a = parseNum(left);
  const b = parseNum(right);
  if (a != null && b != null) return a - b;
  return left.toLowerCase().localeCompare(right.toLowerCase());
}

function parseNum(raw) {
  const text = String(raw ?? "").trim().replace(",", ".");
  if (!NUMBER.test(String(raw ?? "").trim())) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function wildcard(value, pattern) {
  const body = pattern.split("").map((ch) => {
    if (ch === "*") return ".*";
    if (ch === "?") return ".";
    return ch.replace(/[\\^$.+()|[\]{}]/g, "\\$&");
  }).join("");
  return new RegExp(`^${body}$`, "i").test(value);
}
