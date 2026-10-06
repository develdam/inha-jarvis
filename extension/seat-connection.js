import { officialUrl, FEATURES } from "./core.js";

export const libraryOrigins = ["https://lib.inha.ac.kr/*", "https://libapp.inha.ac.kr/*", "https://booking.inha.ac.kr/*"];
let pending;

// The worker serializes discovery across panels so simultaneous opens create one tab.
export function ensureSeatTab() {
  if (pending) return pending;
  pending = findOrCreate().finally(() => { pending = null; });
  return pending;
}

async function findOrCreate() {
  const stored = await chrome.storage.local.get(["sources", "seatAutoDisabled"]);
  if (stored.seatAutoDisabled) throw new Error("정석 자동 조회가 꺼져 있어요. ‘자동 조회 시작’을 눌러 주세요.");
  if (!await chrome.permissions.contains({ origins: libraryOrigins })) throw new Error("정석 사이트 접근을 한 번 허용해 주세요.");
  const url = officialUrl(stored.sources?.seats || FEATURES.seats.defaultUrl, "seats");
  const session = await chrome.storage.session.get("seatTabId");
  let tab;
  if (Number.isInteger(session.seatTabId)) {
    try {
      const previous = await chrome.tabs.get(session.seatTabId);
      // Retain a login redirect for recovery, but never reuse unrelated user navigation.
      if (previous.url === url || /^https:\/\/(lib|libapp|booking)\.inha\.ac\.kr\/.*(?:login|signin|sso|oauth)/i.test(previous.url || "")) tab = previous;
    } catch { /* Closed tabs are automatically replaced. */ }
  }
  if (!tab) [tab] = await chrome.tabs.query({ url });
  const created = !tab;
  if (!tab) tab = await chrome.tabs.create({ url, active: false });
  await chrome.storage.session.set({ seatTabId: tab.id });
  return { tabId: tab.id, created };
}
