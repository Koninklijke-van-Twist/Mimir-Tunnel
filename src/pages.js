import { rowMatchesFilters } from "./bc-filter.js";
import { BadRequestError } from "./errors.js";
import { applyKeyBy, parseBool, parseKeyBy } from "./key-by.js";
import { isUnsupportedFilterError, READ_CHUNK, scanRows } from "./page-window.js";

const PAGE_ID = /^[1-9]\d*$/;

export function parsePageQuery(url, pageIdRaw, headers = {}) {
  if (!PAGE_ID.test(String(pageIdRaw))) {
    throw new BadRequestError("page-id moet een positief geheel getal zijn");
  }
  const filters = [];
  for (const raw of url.searchParams.getAll("filter")) {
    const eq = raw.indexOf("=");
    if (eq <= 0) {
      throw new BadRequestError("filter moet Column=waarde zijn");
    }
    const column = raw.slice(0, eq);
    const value = raw.slice(eq + 1);
    if (!column || value === "") throw new BadRequestError("filter moet Column=waarde zijn");
    filters.push({ column, value });
  }
  const columns = url.searchParams.getAll("columns")
    .flatMap((part) => part.split(","))
    .map((part) => part.trim())
    .filter(Boolean);
  const top = optionalInt(url.searchParams.get("top"), "top", 1);
  const skip = optionalInt(url.searchParams.get("skip"), "skip", 0);
  const company = url.searchParams.get("company") || undefined;
  const section = url.searchParams.get("section") || undefined;
  const keyBy = parseKeyBy(url.searchParams.get("keyBy"), "keyBy")
    ?? parseKeyBy(headerValue(headers, "x-bc-key-by"), "X-BC-Key-By");
  const includeColumnMetadata = parseBool(url.searchParams.get("includeColumnMetadata"), "includeColumnMetadata");
  return {
    keyBy,
    includeColumnMetadata,
    pageId: Number(pageIdRaw),
    company,
    section,
    filters,
    columns,
    top,
    skip,
  };
}

function headerValue(headers, name) {
  const value = headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function optionalInt(raw, name, min) {
  if (raw == null || raw === "") return undefined;
  if (!/^\d+$/.test(raw)) throw new BadRequestError(`${name} moet een geheel getal zijn`);
  const value = Number(raw);
  if (value < min) throw new BadRequestError(`${name} moet >= ${min} zijn`);
  return value;
}

export function shapePage(pageId, company, read, keyBy) {
  const section = read?.section ?? {};
  const rows = Array.isArray(section.rows)
    ? section.rows.map((row) => ({
      bookmark: row?.bookmark ?? null,
      cells: row?.cells && typeof row.cells === "object" ? row.cells : {},
    }))
    : [];
  const body = {
    pageId,
    company: company ?? null,
    sectionId: section.sectionId ?? "header",
    kind: section.kind ?? null,
    caption: section.caption ?? null,
    totalRowCount: section.totalRowCount ?? null,
    stateVersion: read?.stateVersion ?? null,
    rows,
  };
  if (Array.isArray(section.fields)) body.fields = section.fields;
  if (Array.isArray(section.columns)) body.columns = section.columns;
  body.keyBy = keyBy ?? "caption";
  return body;
}

export async function listCompanies(session) {
  const result = await session.call("bc_list_companies", {});
  if (result && typeof result.currentCompany === "string" && result.currentCompany) {
    session.company = result.currentCompany;
  }
  return result;
}

/**
 * open → read_data → close, ook als het lezen mislukt.
 * Sluiten dat mislukt maakt de sessie onbruikbaar (tainted): de pool logt
 * daarna opnieuw in, zodat er geen pagina open blijft staan.
 */
export async function readPage(session, query, logger) {
  if (query.company && query.company !== session.company) {
    await session.call("bc_switch_company", { companyName: query.company });
    session.company = query.company;
  }
  const opened = await session.call("bc_open_page", applyKeyBy("bc_open_page", { pageId: query.pageId }, { keyBy: query.keyBy }));
  const pageContextId = opened?.pageContextId;
  if (typeof pageContextId !== "string" || pageContextId === "") {
    session.tainted = true;
    throw new BadRequestError("bc_open_page gaf geen pageContextId");
  }
  let filterMode;
  try {
    const filters = query.filters;
    let loaded;
    if (filters.length > 0) {
      try {
        loaded = await loadWindow(session, query, pageContextId, { useFilters: true });
        filterMode = "server";
      } catch (err) {
        if (!isUnsupportedFilterError(err)) throw err;
        logger?.info("page.filter_fallback", { pageId: query.pageId, code: err.code });
        loaded = await loadWindow(session, query, pageContextId, { clientFilter: true });
        filterMode = "client";
      }
    } else {
      loaded = await loadWindow(session, query, pageContextId, {});
    }
    const shaped = shapePage(query.pageId, session.company, loaded.read, query.keyBy);
    if (filterMode) shaped.filterMode = filterMode;
    if (loaded.truncated) shaped.truncated = true;
    return shaped;
  } finally {
    // BC onthoudt serverfilters per pagina binnen de sessie, ook na sluiten.
    if (filterMode === "server") await clearFilters(session, pageContextId, logger);
    await closeOne(session, pageContextId, logger);
  }
}

async function clearFilters(session, pageContextId, logger) {
  if (session.dead) return;
  try {
    await session.call("bc_read_data", { pageContextId, clearFilters: true, range: { offset: 0, limit: 1 } });
  } catch (err) {
    logger?.warn("page.clear_filters_failed", { code: err.code || "ERROR" });
  }
}

/**
 * Zonder top, skip en filter: één leesactie, het venster dat BC zelf geeft.
 * Een venster dat in 50 rijen past: één bc_read_data met die range.
 * Daarboven, en bij client-side filter: stukken van 50, daarna skip/top lokaal.
 * Een filter zonder top, of alleen skip, gebruikt top 100.
 */
async function loadWindow(session, query, pageContextId, { useFilters = false, clientFilter = false }) {
  const offset = query.skip ?? 0;
  const bounded = query.top != null || query.skip != null || clientFilter || useFilters;
  const limit = query.top ?? (bounded ? 100 : null);
  const args = applyKeyBy("bc_read_data", { pageContextId }, query);
  if (query.section) args.section = query.section;
  if (useFilters && query.filters.length > 0) args.filters = query.filters;
  if (!clientFilter && query.columns.length > 0) args.columns = query.columns;

  if (limit == null) {
    return { read: await session.call("bc_read_data", args), truncated: false };
  }
  if (!clientFilter && offset + limit <= READ_CHUNK) {
    const read = await session.call("bc_read_data", { ...args, range: { offset, limit } });
    return { read, truncated: false };
  }

  const match = clientFilter ? (cells) => {
    // Kolom niet in de cellen: niet 2000 rijen scannen voor 0 resultaten.
    const names = Object.keys(cells ?? {}).map((name) => name.toLowerCase());
    const missing = query.filters.find((filter) => !names.includes(filter.column.toLowerCase()));
    if (missing) throw new BadRequestError(`filterkolom niet op de pagina: ${missing.column}`);
    return rowMatchesFilters(cells, query.filters);
  } : null;
  const scanned = await scanRows(session, args, { target: offset + limit, match });
  if (scanned.card) {
    return {
      read: clientFilter ? applyCardFilter(scanned.read, query) : scanned.read,
      truncated: false,
    };
  }
  let rows = scanned.rows.slice(offset, offset + limit);
  if (clientFilter) rows = rows.map((row) => projectRow(row, query.columns));
  return { read: withRows(scanned.read, rows), truncated: scanned.truncated };
}

function applyCardFilter(read, query) {
  const section = read?.section ?? {};
  const fields = Array.isArray(section.fields) ? section.fields : [];
  const cells = {};
  for (const field of fields) {
    if (field && typeof field.name === "string") cells[field.name] = field.value ?? "";
  }
  const matched = (query.skip ?? 0) === 0 && rowMatchesFilters(cells, query.filters);
  let next = matched ? fields : [];
  if (matched && query.columns.length > 0) {
    const wanted = new Set(query.columns.map((column) => column.toLowerCase()));
    next = next.filter((field) => wanted.has(String(field.name).toLowerCase()));
  }
  return { ...read, section: { ...section, rows: [], fields: next } };
}

function projectRow(row, columns) {
  return {
    bookmark: row?.bookmark ?? null,
    cells: projectCells(row?.cells, columns),
  };
}

function projectCells(cells, columns) {
  const source = cells && typeof cells === "object" ? cells : {};
  if (!columns.length) return source;
  const wanted = new Set(columns.map((column) => column.toLowerCase()));
  return Object.fromEntries(Object.entries(source).filter(([key]) => wanted.has(key.toLowerCase())));
}

function withRows(read, rows) {
  return { ...read, section: { ...(read?.section ?? {}), rows } };
}

async function closeOne(session, pageContextId, logger) {
  if (session.dead) return;
  try {
    await session.call("bc_close_page", { pageContextId });
  } catch (err) {
    session.tainted = true;
    logger?.warn("page.close_failed", { code: err.code || "ERROR" });
  }
}
