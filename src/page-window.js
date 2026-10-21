/**
 * bc_read_data materialiseert een range door te scrollen tot de rij-array
 * lang genoeg is. Op deze webclient vervangt DataLoaded het venster (~50 rijen)
 * in plaats van het te verlengen, waardoor limit boven 50 terugkomt als 50
 * en een offset voorbij dat venster een lege slice is. Daarom leest de bridge
 * in stukken van 50 en, als een hoog offset niets nieuws oplevert, het begin
 * opnieuw: de scroll kan het venster intussen vervangen hebben.
 */

export const READ_CHUNK = 50;
export const MAX_PAGE_READS = 40;

export function isUnsupportedFilterError(err) {
  if (err?.code !== "PROTOCOL_ERROR") return false;
  const msg = String(err?.message || "");
  if (/filter column not found/i.test(msg)) return false;
  return /columnbinderpath|no repeater -- cannot filter|filterlogicalcontrol|cannot filter/i.test(msg);
}

/**
 * Verzamelt unieke rijen tot `target` stuks (na `match`, als die gezet is).
 * Een kaart (fields, geen rijen) komt terug als { card, read } zonder verder bladeren.
 */
export async function scanRows(session, args, { target, match }) {
  const seen = new Set();
  const matched = [];
  let from = 0;
  let nudged = false;
  let reads = 0;
  let read;
  let total = null;

  while (matched.length < target && reads < MAX_PAGE_READS) {
    read = await session.call("bc_read_data", {
      ...args,
      range: { offset: from, limit: READ_CHUNK },
    });
    reads += 1;
    const section = read?.section ?? {};
    if (section.totalRowCount != null) total = section.totalRowCount;
    const rows = Array.isArray(section.rows) ? section.rows : [];

    if (reads === 1 && rows.length === 0 && Array.isArray(section.fields) && section.fields.length > 0) {
      return { card: true, read, reads, rows: [], truncated: false };
    }

    let fresh = 0;
    for (const row of rows) {
      const key = rowKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      fresh += 1;
      const cells = row?.cells && typeof row.cells === "object" ? row.cells : {};
      if (match && !match(cells)) continue;
      matched.push(row);
    }

    if (rows.length === 0 && from !== 0 && !nudged) {
      nudged = true;
      from = 0;
      continue;
    }
    if (rows.length < READ_CHUNK) {
      return { card: false, read, reads, rows: matched, truncated: false };
    }
    if (fresh === 0) {
      if (from !== 0 && !nudged) {
        nudged = true;
        from = 0;
        continue;
      }
      return {
        card: false,
        read,
        reads,
        rows: matched,
        truncated: matched.length < target && (total == null || total > seen.size),
      };
    }
    from = seen.size;
    nudged = false;
  }

  return {
    card: false,
    read,
    reads,
    rows: matched,
    truncated: matched.length < target,
  };
}

function rowKey(row) {
  if (typeof row?.bookmark === "string" && row.bookmark !== "") return `b:${row.bookmark}`;
  return `c:${JSON.stringify(row?.cells ?? {})}`;
}
