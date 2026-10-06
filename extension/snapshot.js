// Self-contained: Chrome serialises this function when it runs in the active tab.
export function collectSnapshot(feature, suppliedDocument, suppliedUrl) {
  const doc = suppliedDocument || document;
  const url = suppliedUrl || location.href;
  const host = new URL(url).hostname;
  if (!(host === "inha.ac.kr" || host.endsWith(".inha.ac.kr"))) return { error: "학교 공식 페이지에서만 읽을 수 있어요." };
  if (feature === "seats" && !["lib.inha.ac.kr", "libapp.inha.ac.kr", "booking.inha.ac.kr"].includes(host)) return { error: "정석학술정보관의 좌석 현황 페이지를 열어 주세요." };
  const pathname = new URL(url).pathname;
  if (/login|sign[-_]?in|logout|sso|oauth/i.test(pathname) || (feature !== "seats" && /my[-_]?library|my[-_]?page/i.test(pathname))) return { error: "로그인 후 조회할 정보 페이지로 이동해 주세요." };
  const live = !suppliedDocument;
  const visible = (el) => {
    if (feature === "seats" && el.closest('[hidden], [aria-hidden="true"]')) return false;
    if (!live) return true;
    if (!el.getClientRects().length) return false;
    if (feature === "seats") {
      for (let parent = el; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
      }
    }
    return true;
  };
  const textOf = (el) => {
    if (!el) return "";
    if (live && visible(el)) return String(el.innerText || el.textContent || "").trim();
    const copy = el.cloneNode(true);
    copy.querySelectorAll("br").forEach((br) => br.replaceWith(doc.createTextNode("\n")));
    copy.querySelectorAll("p, div, li").forEach((block) => block.append(doc.createTextNode("\n")));
    return String(copy.textContent || "").trim();
  };
  const seatText = (el) => {
    const walker = doc.createTreeWalker(el, 4);
    const parts = [];
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement;
      if (parent && visible(parent) && !parent.closest("script,style,noscript,template")) parts.push(walker.currentNode.textContent.trim());
    }
    return parts.filter(Boolean).join("\n");
  };
  // Seat availability can be displayed in a dialog outside the page's main content.
  const root = feature === "seats" ? doc.body : doc.querySelector("main, [role=main], #contents, #content") || doc.body;
  const loginRequired = [...doc.querySelectorAll('input[type="password"]')].some(visible) && (feature === "seats" || /로그인|login/i.test(doc.title));
  const links = feature === "notices" ? [...root.querySelectorAll("a[href]")].filter(visible).slice(0, 1000).map((el) => ({
    text: textOf(el).slice(0, 350), href: el.getAttribute("href"),
    context: textOf(el.closest("tr, li, article, .board-item") || el.parentElement).slice(0, 1500)
  })) : [];
  // Weekday tabs may hide the other days even though their menus are already in the DOM.
  const tables = ["breakfast", "seats"].includes(feature) ? [...root.querySelectorAll("table")].filter((table) => feature === "breakfast" || visible(table)).slice(0, 40).map((table) => {
    const rows = [];
    [...table.rows].slice(0, 60).forEach((row, y) => {
      rows[y] ||= [];
      let x = 0;
      for (const cell of row.cells) {
        while (rows[y][x] !== undefined) x++;
        const text = textOf(cell).slice(0, 1500);
        for (let dy = 0; dy < Math.min(cell.rowSpan || 1, 20); dy++) {
          rows[y + dy] ||= [];
          for (let dx = 0; dx < Math.min(cell.colSpan || 1, 20); dx++) rows[y + dy][x + dx] = text;
        }
        x += Math.min(cell.colSpan || 1, 20);
      }
    });
    const context = [];
    let container = table;
    let foundDate = false;
    for (let depth = 0; container && container !== root && depth < 4; depth++, container = container.parentElement) {
      let sibling = container.previousElementSibling;
      for (let index = 0; sibling && index < 3; index++, sibling = sibling.previousElementSibling) {
        if (sibling.matches("table") || sibling.querySelector("table")) continue;
        const value = textOf(sibling);
        if (value.length < 160) context.push(value);
        if (value.length < 160 && /[월화수목금토일]요일\s*\(|\d{1,2}[.\/-]\d{1,2}/.test(value)) { foundDate = true; break; }
      }
      if (foundDate) break;
    }
    const labelledBy = table.closest("[aria-labelledby]")?.getAttribute("aria-labelledby");
    if (labelledBy) context.unshift(...labelledBy.split(/\s+/).map((id) => textOf(doc.getElementById(id))));
    return { caption: textOf(table.querySelector("caption")), dateContext: context.join(" "), rows };
  }) : [];
  const dateCandidates = [];
  if (feature === "breakfast") {
    // Read only public calendar controls, never arbitrary form values or account fields.
    for (const el of root.querySelectorAll('input[type="date"], input[name], input[id], select[name], select[id]')) {
      if (el.type === "password" || el.type === "email") continue;
      if (el.type !== "date" && !/date|sday|mealday|dietday/i.test(`${el.name || ""} ${el.id || ""}`)) continue;
      const value = el.tagName === "SELECT" ? textOf(el.selectedOptions?.[0]) : (live ? el.value : el.getAttribute("value"));
      if (value && /^(?:20\d{6}|20\d{2}[.\-/년]\s*\d{1,2}[.\-/월]\s*\d{1,2}(?:일)?(?:\s*\(?[월화수목금토일](?:요일)?\)?)?)$/.test(value.trim())) dateCandidates.push(value.trim());
    }
    if (!dateCandidates.length) {
      for (const el of root.querySelectorAll('time, [class*="date" i], [id*="date" i], [class*="calendar" i], [class*="calender" i]')) {
        if (!visible(el)) continue;
        const value = textOf(el);
        if (value.length < 80 && /20\d{2}[.\-/년]/.test(value)) dateCandidates.push(value);
      }
    }
  }
  const seatLabels = feature === "seats" ? [...root.querySelectorAll("[aria-label], [title]")].filter(visible).flatMap((el) =>
    [el.getAttribute("aria-label"), el.getAttribute("title")].filter((label) => label && label.length < 200 && /열람실/.test(label) && /가능|잔여|여유|빈\s*자리/.test(label))) : [];
  const seatBlocks = [];
  if (feature === "seats") {
    const seen = new Set();
    for (const label of [...root.querySelectorAll("h1,h2,h3,h4,h5,h6,a,button,div,span,p,strong,td")].slice(0, 3000)) {
      if (!visible(label) || !/^(?:제\s*)?[12]\s*열람실$/.test(textOf(label).replace(/\s+/g, " ").trim())) continue;
      let card = label.parentElement;
      for (let depth = 0; card && card !== root && depth < 6; depth++, card = card.parentElement) {
        if (seen.has(card)) break;
        const value = seatText(card); // Keep number elements separated; exclude hidden copies.
        if (value.length > 600 || (value.match(/(?:제\s*)?\d+(?:\s*[-–]\s*\d+)?\s*열람실/g) || []).length > 1) break;
        if (/\d\s*\//.test(value)) {
          seatBlocks.push(value); seen.add(card); break;
        }
      }
    }
  }
  return { url, title: doc.title, loginRequired, links, tables, dateCandidates, seatBlocks, seatLabels,
    text: feature === "notices" ? "" : (feature === "seats" ? seatText(root) : textOf(root)).slice(0, 100_000), method: live ? "tab" : "fetch" };
}

export function snapshotFromHtml(html, url, feature) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, style, noscript, template, nav, header, footer").forEach((el) => el.remove());
  // Preserve block boundaries so excerpts are legible even in detached documents.
  doc.querySelectorAll("br").forEach((el) => el.replaceWith(doc.createTextNode("\n")));
  doc.querySelectorAll("p, div, tr, li, h1, h2, h3").forEach((el) => el.append(doc.createTextNode("\n")));
  return collectSnapshot(feature, doc, url);
}
