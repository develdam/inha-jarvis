const compact = (value) => String(value || "").replace(/\s+/g, " ").trim();
const roomPattern = /(?:제\s*)?\d+(?:\s*[-–]\s*\d+)?\s*열람실(?:\s*\([^\n)]{1,30}\))?/g;
const availableLabel = "(?:잔여(?:\\s*좌석)?|여유(?:\\s*좌석)?|빈\\s*자리|(?:이용|사용|배정|예약)\\s*가능(?:\\s*좌석)?|가용(?:\\s*좌석)?)";

function roomId(value) {
  const match = compact(value).match(/^(?:제\s*)?([12])\s*열람실$/);
  return match ? Number(match[1]) : null;
}

function cardCounts(value) {
  // Confirmed school layout: remaining seats above occupied / total seats.
  // Require all three values and their arithmetic relationship, never a lone fraction.
  const number = "(\\d{1,3}(?:,\\d{3})+|\\d+)";
  const match = compact(value).match(new RegExp("^[:：]?\\s*" + number + "(?:\\s*(?:좌석|석))?(?:\\s*(?:이용|사용|배정|예약)\\s*가능)?\\s+" + number + "(?:\\s*(?:좌석|석))?\\s*/\\s*" + number + "(?:\\s*(?:좌석|석))?(?=\\s|$)"));
  if (!match) return null;
  const [available, occupied, total] = match.slice(1).map((part) => Number(part.replaceAll(",", "")));
  return total > 0 && total <= 9999 && available + occupied === total ? { available, occupied, total } : null;
}

export function occupancyPercent(room) {
  if (!Number.isInteger(room?.available) || !Number.isInteger(room?.occupied) || !Number.isInteger(room?.total) ||
      room.available < 0 || room.occupied < 0 || room.total <= 0 || room.total > 9999 || room.available + room.occupied !== room.total) return null;
  return Math.round(room.occupied / room.total * 1000) / 10;
}

// Explicit labels and the user-confirmed card layout are supported; old split rooms are not totals.
export function seatRooms(snapshot) {
  const counts = new Map();
  const record = (id, value, rank = 1) => {
    const data = typeof value === "number" ? { available: value, occupied: null, total: null } : value;
    if (!id || !data || !Number.isInteger(data.available) || data.available < 0 || data.available > 9999) return;
    const current = counts.get(id);
    if (!current || rank > current.rank) counts.set(id, { rank, values: new Set([data.available]), details: new Map(data.total === null ? [] : [[`${data.occupied}/${data.total}`, data]]) });
    else if (rank === current.rank) {
      current.values.add(data.available);
      if (data.total !== null) current.details.set(`${data.occupied}/${data.total}`, data);
    }
  };
  const readText = (value, rank) => {
  const text = String(value || "");
  const matches = [...text.matchAll(roomPattern)];
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    const id = roomId(match[0]);
    if (!id) continue;
    const body = text.slice(match.index + match[0].length, Math.min(matches[index + 1]?.index ?? text.length, match.index + match[0].length + 240));
    record(id, cardCounts(body), rank);
    const afterCount = [...body.matchAll(/(?<![\d,.])(\d{1,3}(?:,\d{3})+|\d+)(?![\d,.])\s*(?:좌석|석)\s*(?:이용|사용|배정|예약)\s*가능/g)];
    for (const count of afterCount) {
      if (!/\d\s*\/\s*$/.test(body.slice(0, count.index))) record(id, Number(count[1].replaceAll(",", "")), rank);
    }
    const beforeCount = new RegExp(availableLabel + "\\s*[:：]?\\s*(\\d{1,3}(?:,\\d{3})+|\\d+)(?![\\d,.])\\s*(?:좌석|석)?", "g");
    for (const count of body.matchAll(beforeCount)) {
      // In "18 좌석 이용가능 482 / 500", 이용가능 belongs to 18, not to 482.
      if (afterCount.some((previous) => count.index < previous.index + previous[0].length && count.index + count[0].length > previous.index)) continue;
      record(id, Number(count[1].replaceAll(",", "")), rank);
    }
  }
  };
  readText(snapshot.text, 1);
  // Attribute labels can lag behind visible text after the site's counters update.
  for (const label of snapshot.seatLabels || []) readText(label, 0);
  for (const block of snapshot.seatBlocks || []) {
    const names = [...String(block).matchAll(roomPattern)];
    if (names.length !== 1) continue;
    record(roomId(names[0][0]), cardCounts(String(block).replace(names[0][0], " ")), 3);
  }
  for (const table of snapshot.tables || []) {
    let availableColumn = -1;
    for (const row of table.rows || []) {
      const column = row.findIndex((cell) => new RegExp("^" + availableLabel + "(?:\\s*수)?(?:\\s*\\(석\\))?$").test(compact(cell)));
      if (column >= 0 && !row.some((cell) => roomId(cell))) { availableColumn = column; continue; }
      const id = row.map(roomId).find(Boolean);
      const value = compact(row[availableColumn]);
      if (id && /^(?:\d{1,3}(?:,\d{3})+|\d+)\s*(?:좌석|석)?$/.test(value)) record(id, Number(value.match(/[\d,]+/)[0].replaceAll(",", "")), 2);
    }
  }
  if ([...counts.values()].some((entry) => entry.values.size > 1 || entry.details.size > 1)) return { conflict: true, rooms: [] };
  return { rooms: [1, 2].map((id) => ({ name: `제${id}열람실`, available: counts.has(id) ? [...counts.get(id).values][0] : null,
    occupied: counts.has(id) ? [...counts.get(id).details.values()][0]?.occupied ?? null : null,
    total: counts.has(id) ? [...counts.get(id).details.values()][0]?.total ?? null : null })) };
}
