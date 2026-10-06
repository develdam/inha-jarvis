import { breakfastSections } from "./breakfast.js";
import { seatRooms } from "./seats.js";

export const FEATURES = {
  breakfast: {
    label: "BREAKFAST", title: "천원의 아침밥", description: "든든한 하루를 시작하는 아침 한 끼.",
    defaultUrl: "https://www.inha.ac.kr/kr/1072/subview.do", homeUrl: "https://www.inha.ac.kr/kr/1072/subview.do",
    hint: "학생식당 페이지가 연결돼 있어요. ‘새로 조회’를 누르거나 식단표를 연 뒤 ‘열린 페이지 읽기’를 사용해 주세요."
  },
  seats: {
    title: "정석 좌석",
    defaultUrl: "https://lib.inha.ac.kr/mylibrary/seat/reading-rooms", homeUrl: "https://lib.inha.ac.kr/mylibrary/seat/reading-rooms"
  },
  notices: {
    label: "NOTICE", title: "놓치고 싶지 않은 인하공지", description: "필요한 소식을 제목으로 검색해요.",
    defaultUrl: "https://www.inha.ac.kr/kr/950/subview.do", homeUrl: "https://www.inha.ac.kr/kr/950/subview.do",
    hint: "인하공지 페이지가 연결돼 있어요. 학과 공지 등 다른 게시판 주소로 바꿀 수도 있어요."
  }
};

export class DataError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function officialUrl(value, feature) {
  let url;
  try { url = new URL(value); } catch { throw new DataError("URL", "학교 페이지의 전체 주소를 입력해 주세요."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !(url.hostname === "inha.ac.kr" || url.hostname.endsWith(".inha.ac.kr"))) {
    throw new DataError("URL", "https://로 시작하는 인하대학교 공식 페이지 주소만 연결할 수 있어요.");
  }
  if (/login|sign[-_]?in|logout|sso|oauth/i.test(url.pathname) ||
      (feature !== "seats" && /my[-_]?library|my[-_]?page/i.test(url.pathname)) ||
      [...url.searchParams.keys()].some((key) => /token|password|session|ticket|saml|code_verifier/i.test(key))) {
    throw new DataError("LOGIN", "로그인 주소나 개인 계정 페이지 대신 조회할 정보의 페이지를 열어 주세요.");
  }
  if (feature === "seats" && !["lib.inha.ac.kr", "libapp.inha.ac.kr", "booking.inha.ac.kr"].includes(url.hostname)) {
    throw new DataError("URL", "정석학술정보관의 좌석 현황 페이지를 연결해 주세요.");
  }
  url.hash = "";
  return url.href;
}

export function safeLink(value, base) {
  try { return officialUrl(new URL(value, base).href); } catch { return null; }
}

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

export function parseNotices(snapshot) {
  const items = new Map();
  for (const link of snapshot.links || []) {
    const url = safeLink(link.href, snapshot.url);
    const title = clean(link.text);
    const dateMatch = String(link.context || "").match(/\b(20\d{2})[.\-/년]\s*(\d{1,2})[.\-/월]\s*(\d{1,2})(?:일)?/);
    // Recognise article links, not navigation items or arbitrary dated links.
    let articlePath = url || "";
    try {
      const encoded = new URL(articlePath).searchParams.get("enc");
      if (encoded) articlePath += " " + decodeURIComponent(atob(encoded));
    } catch { /* An invalid encoded route is not evidence of an article. */ }
    const article = /artclView\.do|ntt(?:Id|Sn|No)=|articleNo=|[?&](?:seq|boardSeq|bbsSeq|idx|no)=|\/notice\/\d+|noticeView|selectNttInfo/i.test(articlePath);
    if (!url || !article || title.length < 5 || title.length > 350) continue;
    const date = dateMatch ? `${dateMatch[1]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[3].padStart(2, "0")}` : null;
    if (!items.has(url)) items.set(url, { title, url, date });
  }
  if (!items.size) throw new DataError("FORMAT", "공지 목록을 읽지 못했어요. 공지 목록 페이지를 열어 다시 가져와 주세요. 이미지나 새 형식의 게시판은 추가 연결이 필요해요.");
  return { items: [...items.values()].slice(0, 100) };
}

export function parseBreakfast(snapshot) {
  const sections = breakfastSections(snapshot);
  if (!sections.length) throw new DataError("FORMAT", "천원의 아침밥 정보를 구분하지 못했어요. 전용 안내문이나 아침밥 항목이 있는 식단표를 열어 주세요. 이미지 식단표는 아직 읽을 수 없어요.");
  return { sections, schemaVersion: 3 };
}

export function parseSeats(snapshot) {
  const { rooms, conflict } = seatRooms(snapshot);
  if (conflict) throw new DataError("FORMAT", "같은 열람실의 좌석 수가 서로 달라요. 공식 좌석 현황을 새로고침한 뒤 다시 읽어 주세요.");
  if (!rooms.some((room) => room.available !== null)) throw new DataError("FORMAT", "현재 제1·제2열람실의 빈자리 수를 찾지 못했어요. 정석 홈페이지에서 로그인하고 좌석 현황이 나타난 뒤 ‘열린 페이지 연결’을 눌러 주세요.");
  return { rooms, schemaVersion: 3 };
}

export function parseSnapshot(feature, snapshot) {
  if (!Object.hasOwn(FEATURES, feature)) throw new DataError("FEATURE", "지원하지 않는 기능이에요.");
  const url = officialUrl(snapshot.url, feature);
  if (snapshot.loginRequired) throw new DataError("LOGIN", "학교 사이트에서 먼저 로그인하고 정보 페이지로 이동해 주세요.");
  const parsers = { breakfast: parseBreakfast, notices: parseNotices, seats: parseSeats };
  return { feature, sourceUrl: url, sourceTitle: clean(snapshot.title).slice(0, 200),
    fetchedAt: new Date().toISOString(), method: snapshot.method || "fetch", data: parsers[feature](snapshot) };
}

export function isStale(result, now = Date.now()) {
  if (result?.feature === "breakfast" && result.data?.schemaVersion !== 3) return true;
  const time = Date.parse(result?.fetchedAt);
  const ttl = refreshInterval(result?.feature);
  return !Number.isFinite(time) || now - time >= ttl || time > now + 60_000;
}

export function refreshInterval(feature) { return feature === "seats" ? 60_000 : 30 * 60_000; }

export function filterNotices(items, query) {
  const words = clean(query).toLocaleLowerCase("ko-KR").split(" ").filter(Boolean);
  return items.filter((item) => words.every((word) => item.title.toLocaleLowerCase("ko-KR").includes(word)));
}

export function validStoredResult(key, result) {
  if (!result || result.feature !== key || !Number.isFinite(Date.parse(result.fetchedAt)) || !["fetch", "tab"].includes(result.method)) return false;
  try { officialUrl(result.sourceUrl, key); } catch { return false; }
  if (key === "seats") return result.data?.schemaVersion === 3 && Array.isArray(result.data.rooms) && result.data.rooms.length === 2 &&
    result.data.rooms.every((room, index) => room?.name === `제${index + 1}열람실` && (room.available === null || (Number.isInteger(room.available) && room.available >= 0 && room.available <= 9999))) &&
    result.data.rooms.every((room) => (room.occupied === null && room.total === null) || (Number.isInteger(room.available) && Number.isInteger(room.occupied) && room.occupied >= 0 && Number.isInteger(room.total) && room.total > 0 && room.total <= 9999 && room.available + room.occupied === room.total)) &&
    result.data.rooms.some((room) => room.available !== null);
  if (key === "notices") return Array.isArray(result.data?.items) && result.data.items.length > 0 && result.data.items.every((item) =>
    typeof item?.title === "string" && !!safeLink(item.url, result.sourceUrl) && (!item.date || typeof item.date === "string"));
  if (key === "breakfast") return Array.isArray(result.data?.sections) && result.data.sections.length > 0 && result.data.sections.every((section) =>
    typeof section?.label === "string" && typeof section.text === "string" && (section.date === null || typeof section.date === "string") && Array.isArray(section.items) && section.items.every((item) => typeof item === "string"));
  return false;
}
