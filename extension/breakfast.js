const compact = (value) => String(value || "").replace(/\s+/g, " ").trim();
const programme = /천\s*원(?:의)?\s*아침밥|1,?000\s*원.*아침|아침.*1,?000\s*원/;
const morning = /천\s*원|아침|조식/;
const otherMeal = /중식|석식|점심|저녁/;
const datePattern = /(?:[월화수목금토일](?:요일)?\s*\(\s*)?(?:(?:20\d{2})\s*[.\-/년]\s*)?(?:1[0-2]|0?[1-9])\s*[.\/월-]\s*(?:3[01]|[12]\d|0?[1-9])(?:일|\.)?\)?(?:\s*\(?[월화수목금토일](?:요일)?\)?(?![가-힣]|\s*\())?/g;

export function mealDate(value) {
  const matches = [...compact(value).matchAll(datePattern)].map((match) => match[0].trim());
  const unique = new Map(matches.map((date) => [date.match(/\d+/g).map(Number).join("-"), date]));
  return unique.size === 1 ? [...unique.values()][0] : null;
}

export function mealDay(value, now = new Date()) {
  const date = mealDate(value);
  if (!date) return null;
  const numbers = date.match(/\d+/g).map(Number);
  const [year, month, day] = numbers.length === 3 ? numbers : [null, ...numbers];
  // Compare calendar dates in Korea, including tomorrow across month/year boundaries.
  const koreanDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(now);
  const part = (type) => Number(koreanDate.find((item) => item.type === type).value);
  const today = Date.UTC(part("year"), part("month") - 1, part("day"));
  for (const [offset, label] of [[0, "today"], [1, "tomorrow"]]) {
    const target = new Date(today + offset * 86_400_000);
    if ((year === null || year === target.getUTCFullYear()) && month === target.getUTCMonth() + 1 && day === target.getUTCDate()) return label;
  }
  return null;
}

function selectedMealDate(snapshot) {
  const candidates = (snapshot.dateCandidates || []).map((value) => {
    const text = compact(value);
    return /^20\d{6}$/.test(text) ? `${text.slice(0, 4)}.${text.slice(4, 6)}.${text.slice(6, 8)}` : text;
  }).filter((value) => mealDate(value));
  if (candidates.length) return mealDate(candidates.join(" "));
  // A single full date in the page is usable; multiple days or week ranges are ambiguous.
  const dates = String(snapshot.text || "").match(/20\d{2}\s*[.\-/년]\s*\d{1,2}\s*[.\-/월]\s*\d{1,2}(?:일)?/g) || [];
  return mealDate(dates.join(" "));
}

function dateCell(value) {
  const date = mealDate(value);
  return date && compact(value).replace(date, "").replace(/날짜|일자|식단|[\s:：()[\]]/g, "") === "" ? date : null;
}

export function menuLines(value) {
  return String(value || "").split(/\r?\n|\t|\s*[·•]\s*|\s*\/\s*|,(?!\d)/)
    .map((line) => line.replace(/^[\s\-•·]+/, "").trim()).filter(Boolean)
    .filter((line) => !/^(?:천\s*원(?:의)?\s*아침밥|조식|아침)$/.test(line))
    .filter((line) => !/^(?:(?:가격|금액|판매가|이용료)\s*[:：]?\s*)?(?:₩\s*)?1,?000(?:\.00)?\s*(?:원|KRW)?$/i.test(line));
}

export function breakfastSections(snapshot) {
  const sections = [];
  const add = (date, values) => {
    const items = values.flatMap(menuLines);
    if (!items.length && !date) return;
    if (sections.some((section) => section.date === date && JSON.stringify(section.items) === JSON.stringify(items))) return;
    sections.push({ label: "식단표 원문", date, items, text: [date, ...items].filter(Boolean).join("\n") });
  };
  for (const table of snapshot.tables || []) {
    const rows = table.rows || [];
    const context = `${table.caption || ""} ${table.dateContext || ""} ${snapshot.title || ""}`;
    const dedicated = programme.test(context);
    const eligible = dedicated || programme.test(snapshot.text || "") || rows.some((row) => row.some((cell) => /천\s*원/.test(cell)));
    if (!eligible) continue;
    let dateHeader = null;
    let currentDate = mealDate(context) || selectedMealDate(snapshot);
    const courseHeader = rows.find((row) => row.some((cell) => morning.test(cell)) && row.some((cell) => /^(날짜|일자|요일)$/.test(compact(cell)) || otherMeal.test(cell)) && !row.some(dateCell));
    if (courseHeader) {
      const column = courseHeader.findIndex((cell) => morning.test(cell) && !otherMeal.test(cell));
      for (const row of rows.slice(rows.indexOf(courseHeader) + 1)) {
        const dates = row.filter((cell, index) => index !== column && dateCell(cell));
        if (dates.length === 1) add(mealDate(dates[0]), [row[column] || ""]);
      }
      continue;
    }
    for (const row of rows) {
      const dates = row.map(dateCell).filter(Boolean);
      const header = dates.length && row.every((cell) => dateCell(cell) || !compact(cell) || /^(구분|식사|메뉴|시간|가격|요일|날짜|일자|식단|코너|식당|분류|식사구분|단가)$/.test(compact(cell)));
      if (header) {
        if (new Set(dates).size === 1 && row.every((cell) => dateCell(cell) || !compact(cell))) {
          currentDate = dates[0];
          dateHeader = null;
        } else dateHeader = row;
        continue;
      }
      if (row.some((cell) => otherMeal.test(cell))) continue;
      const labelIndex = row.findIndex((cell) => morning.test(cell));
      if (labelIndex < 0 && !dedicated) continue;
      if (dateHeader) {
        for (let column = 0; column < dateHeader.length; column++) {
          const date = dateCell(dateHeader[column]);
          if (date && column !== labelIndex) add(date, [row[column] || ""]);
        }
      } else {
        const dateIndex = row.findIndex(dateCell);
        const date = dateIndex >= 0 ? mealDate(row[dateIndex]) : currentDate;
        const values = row.filter((_cell, index) => index !== labelIndex && index !== dateIndex);
        add(date, values);
      }
    }
  }
  if (!sections.length && programme.test(snapshot.title || "")) {
    const lines = String(snapshot.text || "").split(/\n+/).map(compact).filter(Boolean);
    const index = lines.findIndex((line) => programme.test(line));
    if (index >= 0) {
      const text = lines.slice(index, index + 35).join("\n").slice(0, 2200);
      if (text.length > 40) sections.push({ label: "운영 안내", date: null, items: [], text, kind: "announcement" });
    }
  }
  return sections.slice(0, 35);
}
