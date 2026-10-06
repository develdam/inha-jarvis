import { FEATURES, officialUrl, parseSnapshot, isStale, filterNotices } from "./core.js";
import { collectSnapshot, snapshotFromHtml } from "./snapshot.js";
import { refreshInterval } from "./core.js";
import { validStoredResult } from "./core.js";
import { NOTICE_BOARDS, noticeKey, featureForKey, noticeDefaultUrl } from "./sources.js";
import { menuLines, mealDay } from "./breakfast.js";
import { occupancyPercent } from "./seats.js";
import { libraryOrigins } from "./seat-connection.js";

const $ = (id) => document.getElementById(id);
const state = { selected: "seats", settings: false, board: "general", sources: {}, results: {}, messages: {}, seatTabId: null, seatLogin: false, seatChecked: false, busy: false, ready: false };
const sourceKeys = ["breakfast", "seats", ...Object.keys(NOTICE_BOARDS).map(noticeKey)];
function selectedKey() { return state.selected === "notices" ? noticeKey(state.board) : state.selected; }
const extension = !!globalThis.chrome?.runtime?.id;
const auto = { paused: {}, checking: false, permission: {}, timer: null };

function scheduleAutoRefresh() {
  clearTimeout(auto.timer);
  if (!extension || !state.ready || state.settings || state.busy || document.hidden || auto.paused[selectedKey()]) return;
  const result = state.results[selectedKey()];
  const ttl = refreshInterval(state.selected);
  const delay = result ? Math.max(0, ttl - (Date.now() - Date.parse(result.fetchedAt))) : 0;
  // A missing permission requires a user click, not repeated prompts or polling.
  if (auto.permission[selectedKey()] === false) return;
  auto.timer = setTimeout(maybeAutoRefresh, Math.max(1000, delay));
}

async function maybeAutoRefresh() {
  if (!extension || !state.ready || state.settings || state.busy || auto.checking || document.hidden || auto.paused[selectedKey()]) return;
  const key = selectedKey();
  const url = sourceUrl(key);
  if (state.results[key] && !isStale(state.results[key]) && (key !== "seats" || state.seatChecked)) { scheduleAutoRefresh(); return; }
  auto.checking = true;
  try {
    if (key === "seats") {
      const allowed = await chrome.permissions.contains({ origins: libraryOrigins });
      auto.permission.seats = allowed;
      if (selectedKey() !== key || state.settings || state.busy || document.hidden) return;
      if (!allowed) { setMessage(key, "처음 한 번 사이트 접근을 허용하면 자동으로 조회해요."); render(); return; }
      await run(key, refreshSeats);
      return;
    }
    const allowed = await chrome.permissions.contains({ origins: [new URL(officialUrl(url, featureForKey(key))).origin + "/*"] });
    if (selectedKey() !== key || state.settings || state.busy || document.hidden || sourceUrl(key) !== url || auto.paused[key]) return;
    auto.permission[key] = allowed;
    if (!allowed) {
      if (!state.messages[key]?.error) setMessage(key, "학교 사이트 접근을 한 번 허용해 주세요.");
      render();
      return;
    }
    await run(key, () => fetchResult(key));
  } catch {
    auto.paused[key] = true;
    setMessage(key, "자동 조회를 시작하지 못했어요. ‘새로 조회’로 다시 시도해 주세요.", true);
    render();
  } finally { auto.checking = false; scheduleAutoRefresh(); }
}

async function fetchResult(key) {
  try {
    const feature = featureForKey(key);
    const response = await chrome.runtime.sendMessage({ type: "FETCH_SOURCE", feature, sourceKey: key });
    if (!response?.ok) throw new Error(response?.message || "조회 응답을 받지 못했어요. 확장 프로그램을 새로고침해 주세요.");
    const snapshot = snapshotFromHtml(response.html, response.url, feature);
    if (snapshot.error) throw new Error(snapshot.error);
    const result = parseSnapshot(feature, snapshot);
    result.fetchedAt = response.fetchedAt;
    await storeResult(key, result);
    auto.paused[key] = false;
  } catch (error) {
    auto.paused[key] = true;
    throw new Error(error.message + " 자동 조회를 잠시 멈췄어요.");
  }
}

async function readSeatTab(tabId) {
  try {
    let tab;
    try { tab = await chrome.tabs.get(tabId); }
    catch { throw new Error("조회 중 정석 탭이 닫혔어요. 새로 조회를 누르면 자동으로 다시 열어요."); }
    if (!tab?.url) throw new Error("정석 탭을 읽을 수 없어요. 다시 연결을 눌러 접근 권한을 허용해 주세요.");
    officialUrl(tab.url, "seats");
    let injected;
    try { injected = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: collectSnapshot, args: ["seats"] }); }
    catch {
      // An unrelated embedded frame may not grant access; the main page can still contain seats.
      try { injected = await chrome.scripting.executeScript({ target: { tabId }, func: collectSnapshot, args: ["seats"] }); }
      catch { throw new Error("정석 페이지를 읽지 못했어요. 네트워크 연결과 사이트 접근 권한을 확인해 주세요."); }
    }
    const frames = (injected || []).map((item) => item.result).filter((snapshot) => {
      if (!snapshot || snapshot.error) return false;
      try { officialUrl(snapshot.url, "seats"); return true; } catch { return false; }
    });
    const readable = frames.filter((snapshot) => !snapshot.loginRequired);
    if (frames.some((snapshot) => snapshot.loginRequired)) throw loginNeeded();
    if (!readable.length) throw new Error("좌석 현황 페이지를 읽지 못했어요. 다시 조회해 주세요.");
    const snapshot = { url: tab.url, title: readable[0].title, method: "tab", text: readable.map((frame) => frame.text || "").join("\n"), tables: readable.flatMap((frame) => frame.tables || []), seatBlocks: readable.flatMap((frame) => frame.seatBlocks || []), seatLabels: readable.flatMap((frame) => frame.seatLabels || []) };
    await storeResult("seats", parseSnapshot("seats", snapshot), true);
    auto.paused.seats = false;
  } catch (error) {
    auto.paused.seats = true;
    throw error;
  }
}

function loginNeeded() {
  state.seatLogin = true;
  const error = new Error("정석 로그인이 만료됐거나 필요해요. 로그인하면 자동으로 다시 조회해요.");
  error.code = "LOGIN";
  return error;
}

async function refreshSeats() {
  auto.paused.seats = false;
  state.seatLogin = false;
  try {
    const response = await chrome.runtime.sendMessage({ type: "ENSURE_SEAT_TAB" });
    if (!response?.ok) throw new Error(response?.message || "정석 페이지를 열지 못했어요.");
    state.seatTabId = response.tabId;
    let tab = await chrome.tabs.get(response.tabId);
    try { officialUrl(tab.url || tab.pendingUrl, "seats"); }
    catch { if (tab.status !== "loading") throw loginNeeded(); }
    // Refresh the actual page, so the timestamp never just describes a stale DOM read.
    if (!response.created && tab.status !== "loading") await chrome.tabs.reload(tab.id);
    const deadline = Date.now() + 20_000;
    let lastError;
    while (Date.now() < deadline) {
      tab = await chrome.tabs.get(response.tabId);
      if (tab.status !== "loading") {
        try { officialUrl(tab.url, "seats"); } catch { throw loginNeeded(); }
        try {
          await readSeatTab(tab.id);
          state.seatChecked = true;
          return;
        } catch (error) {
          if (error.code === "LOGIN") throw error;
          lastError = error;
          // Rendering and cross-origin frames may finish after the page load event.
          auto.paused.seats = false;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw lastError || new Error("정석 페이지 응답이 늦어요. 잠시 뒤 다시 조회해 주세요.");
  } catch (error) { auto.paused.seats = true; throw error; }
}

function beginSeatConnection() {
  const permission = chrome.permissions.request({ origins: libraryOrigins });
  void run("seats", async () => {
    auto.permission.seats = await permission;
    if (!auto.permission.seats) throw new Error("자동 조회에는 정석 사이트 접근 허용이 필요해요.");
    await chrome.storage.local.remove("seatAutoDisabled");
    await refreshSeats();
  });
}

async function openSeatLogin() {
  try {
    await chrome.tabs.update(state.seatTabId, { active: true });
  } catch {
    const tab = await chrome.tabs.create({ url: FEATURES.seats.defaultUrl, active: true });
    state.seatTabId = tab.id;
    await chrome.storage.session.set({ seatTabId: tab.id });
  }
}

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function sourceUrl(key) { return state.sources[key] || (featureForKey(key) === "notices" ? noticeDefaultUrl(key) : FEATURES[key].defaultUrl); }
function timestamp(value) {
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value));
}
function setMessage(key, text, error = false) { state.messages[key] = { text, error }; }

function renderResults() {
  const key = selectedKey();
  const feature = featureForKey(key);
  const result = state.results[key];
  $("results").replaceChildren();
  $("notice-tools").hidden = feature !== "notices" || !result;
  $("provenance").textContent = "";
  $("connect").hidden = !!result || state.busy || !!state.messages[key]?.error || !extension;
  $("connect").textContent = feature === "seats" ? "자동 조회 시작" : "정보 불러오기";
  $("connect").disabled = !state.ready;
  if (!result) {
    if (!state.busy && !state.messages[key]?.text) $("results").append(node("p", "아직 불러온 정보가 없어요.", "empty-state"));
    return;
  }
  if (feature === "seats") {
    for (const room of result.data.rooms) {
      const article = node("article", undefined, "room");
      const numbers = node("div", undefined, "room-numbers");
      const count = node("p", undefined, "room-count");
      if (room.available === null) count.append(node("span", "확인 필요", "help"));
      else count.append(node("strong", String(room.available)), node("span", "석 남음"));
      numbers.append(count);
      const percent = occupancyPercent(room);
      if (percent !== null) {
        numbers.append(node("p", `예약 ${room.occupied.toLocaleString("ko-KR")} / ${room.total.toLocaleString("ko-KR")}석`, "room-ratio"));
        numbers.append(node("p", `혼잡도 ${percent}%`, "room-occupancy"));
      } else if (room.available !== null) numbers.append(node("p", "예약·총 좌석 미확인", "room-ratio"));
      article.append(node("h3", room.name), numbers);
      $("results").append(article);
    }
  } else if (feature === "notices") {
    const items = filterNotices(result.data.items, $("notice-query").value);
    for (const item of items) {
      const article = node("article", undefined, "notice");
      const link = node("a", item.title);
      link.href = item.url; link.target = "_blank"; link.rel = "noopener noreferrer";
      article.append(link);
      if (item.date) article.append(node("p", item.date, "help"));
      $("results").append(article);
    }
    if (!items.length) $("results").append(node("p", "검색어와 일치하는 제목이 없어요.", "help"));
  } else {
    const now = new Date();
    for (const section of result.data.sections) {
      const article = node("article", undefined, "breakfast-section");
      const day = section.kind === "announcement" ? null : mealDay(section.date, now);
      const heading = node("h3", section.kind === "announcement" ? "운영 안내" : section.date || "날짜 미표시", "meal-date");
      if (day) {
        article.classList.add(`meal-${day}`);
        heading.prepend(node("span", day === "today" ? "오늘" : "내일", "meal-day-label"), document.createTextNode(" "));
      }
      article.append(heading);
      if (section.kind === "announcement") article.append(node("p", section.text, "excerpt"));
      else {
        const list = node("ul", undefined, "menu-list");
        for (const item of section.items.flatMap(menuLines)) list.append(node("li", item));
        article.append(list);
        if (!list.childElementCount) article.append(node("p", "등록된 메뉴가 없어요.", "help"));
      }
      $("results").append(article);
    }
  }
  $("provenance").textContent = timestamp(result.fetchedAt) + (feature === "seats" ? " 조회" : result.method === "tab" ? " 페이지 읽음 · 자동 갱신 안 됨" : " 조회");
  $("provenance").title = "한국 시간 · " + new URL(result.sourceUrl).hostname;
}

function render() {
  const key = selectedKey();
  const feature = FEATURES[state.selected];
  const result = state.results[key];
  const notice = state.messages[key];
  document.querySelectorAll("[data-feature]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.feature === state.selected)));
  $("settings-toggle").setAttribute("aria-expanded", String(state.settings));
  $("settings").hidden = !state.settings;
  $("disconnect-seats").hidden = state.seatTabId === null;
  $("settings-source").value = key;
  $("settings-message").textContent = notice?.text || "";
  $("settings-message").classList.toggle("error", !!notice?.error);
  $("feature-title").textContent = { breakfast: "천원의 아침밥", notices: "인하공지", seats: "정석 좌석" }[state.selected];
  $("notice-board-tools").hidden = state.selected !== "notices";
  $("notice-board").value = state.board;
  $("status").hidden = !state.busy && !(result && isStale(result));
  $("status").textContent = state.busy ? "갱신 중" : "오래된 정보";
  $("status").classList.toggle("stale", !!result && isStale(result));
  $("message").textContent = state.selected === "seats" && notice?.error ? notice.text : notice?.error ? (result ? "갱신하지 못했어요. 이전 정보입니다." : "정보를 불러오지 못했어요. 원문을 확인해 주세요.") : notice?.text || "";
  $("message").classList.toggle("error", !!notice?.error);
  $("message-detail").textContent = notice?.error ? notice.text : "";
  $("recovery").hidden = state.selected === "seats" ? !notice?.error : !notice?.error && result?.method !== "tab";
  $("read-tab").textContent = state.selected === "seats" ? (state.seatLogin ? "정석 로그인" : "다시 연결") : "열린 페이지 읽기";
  $("refresh").title = state.selected === "seats" ? "좌석 새로 조회" : "새로 조회";
  $("refresh").setAttribute("aria-label", $("refresh").title);
  $("message-detail").parentElement.hidden = !notice?.error;
  $("source-link").href = result?.sourceUrl || sourceUrl(key) || feature.homeUrl;
  $("source-link").textContent = state.selected === "seats" ? "좌석 현황 열기 ↗" : "원문 ↗";
  for (const id of ["refresh", "read-tab", "save-source", "clear-data", "disconnect-seats", "source-url"]) $(id).disabled = !state.ready || state.busy || !extension;
  $("results").setAttribute("aria-busy", String(state.busy));
  $("auto-status").textContent = auto.paused[key] ? "자동 조회 일시 중지 · 새로 조회로 재시도" :
    key === "seats" ? "자비스를 열면 자동 연결 · 1분마다 갱신" :
    auto.permission[key] === false ? "첫 사이트 접근 허용 후 자동 조회" :
      "자동 조회 · 저장 정보가 30분 지나면 갱신";
  $("tab-help").textContent = key === "seats" ? "필요한 정석 탭은 자동으로 열어요. 로그인이 만료되면 다시 로그인해 주세요." : "페이지 읽기로 가져온 정보는 원문을 새로고침한 뒤 다시 읽어 주세요.";
  renderResults();
}

function selectFeature(key) {
  state.settings = false;
  state.selected = key;
  $("source-url").value = sourceUrl(selectedKey());
  render();
  void maybeAutoRefresh();
}

async function run(key, action) {
  if (state.busy) return;
  state.busy = true;
  setMessage(key, ""); render();
  try { await action(); }
  catch (error) { setMessage(key, (error.message || "처리하지 못했어요. 다시 시도해 주세요.") + (state.results[key] ? " 이전에 가져온 정보를 아래에 남겨 두었어요." : ""), true); }
  finally { state.busy = false; render(); scheduleAutoRefresh(); }
}

async function storeResult(key, result, rememberSource = false) {
  const results = { ...state.results, [key]: result };
  const sources = rememberSource ? { ...state.sources, [key]: result.sourceUrl } : state.sources;
  await chrome.storage.local.set({ results, sources });
  state.results = results; state.sources = sources;
  if (selectedKey() === key) $("source-url").value = sourceUrl(key);
  setMessage(key, "");
}

$("refresh").addEventListener("click", () => {
  const key = selectedKey();
  if (key === "seats") {
    if (state.seatLogin) void openSeatLogin();
    else beginSeatConnection();
    return;
  }
  let url;
  try { url = officialUrl(sourceUrl(key), featureForKey(key)); }
  catch (error) { setMessage(key, error.message, true); toggleSettings(true); render(); $("source-url").focus(); return; }
  // Request directly from the click gesture, before any asynchronous work.
  const permission = chrome.permissions.request({ origins: [new URL(url).origin + "/*"] });
  run(key, async () => {
    auto.permission[key] = await permission;
    if (!auto.permission[key]) throw new Error("사이트 접근 권한이 허용되지 않았어요. 공식 페이지에서 자비스를 열고 ‘열린 페이지 읽기’를 사용할 수 있어요.");
    auto.paused[key] = false;
    await fetchResult(key);
  });
});

$("read-tab").addEventListener("click", () => {
  const key = selectedKey();
  if (key === "seats") { if (state.seatLogin) void openSeatLogin(); else beginSeatConnection(); return; }
  const feature = featureForKey(key);
  run(key, async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) throw new Error("학교 정보 페이지 탭에서 확장 프로그램 아이콘을 누른 뒤 다시 시도해 주세요.");
    officialUrl(tab.url, feature);
    if (feature === "notices" && new URL(tab.url).origin !== new URL(sourceUrl(key)).origin) throw new Error("선택한 게시판의 학교 페이지를 열어 주세요.");
    let injected;
    try { injected = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collectSnapshot, args: [feature] }); }
    catch { throw new Error("페이지를 읽을 권한이 없어요. 해당 학교 탭에서 자비스 아이콘을 누른 뒤 다시 시도해 주세요."); }
    const snapshot = injected?.[0]?.result;
    if (!snapshot || snapshot.error) throw new Error(snapshot?.error || "페이지 내용을 읽지 못했어요.");
    await storeResult(key, parseSnapshot(feature, snapshot), true);
    // A rendered tab is a manual snapshot; polling it would not refresh the server data.
    auto.paused[key] = true;
  });
});

$("source-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const key = selectedKey();
  const input = $("source-url").value.trim();
  run(key, async () => {
    const url = officialUrl(input, featureForKey(key));
    const sources = { ...state.sources, [key]: url };
    const results = { ...state.results };
    if (sourceUrl(key) !== url) {
      delete results[key];
      if (key === "seats") {
        await chrome.storage.session.remove("seatTabId");
        state.seatTabId = null;
      }
    }
    await chrome.storage.local.set({ sources, results });
    state.sources = sources; state.results = results;
    auto.paused[key] = false; delete auto.permission[key];
    setMessage(key, "주소를 저장했어요. 접근 권한이 있으면 자동으로 조회해요.");
  });
});

$("clear-data").addEventListener("click", () => run(selectedKey(), async () => {
  await chrome.storage.local.remove(["sources", "results", "noticeBoard"]);
  await chrome.storage.local.set({ seatAutoDisabled: true });
  await chrome.storage.session.remove("seatTabId");
  state.seatTabId = null;
  state.seatLogin = false;
  state.sources = {}; state.results = {}; state.messages = {};
  for (const key of sourceKeys) auto.paused[key] = true;
  clearTimeout(auto.timer);
  $("notice-query").value = "";
  $("source-url").value = sourceUrl(selectedKey());
  setMessage(selectedKey(), "저장된 주소와 조회 결과를 삭제했어요.");
}));
$("notice-query").addEventListener("input", renderResults);
for (const [value, board] of Object.entries(NOTICE_BOARDS)) {
  const option = node("option", board.label); option.value = value;
  $("notice-board").append(option);
}
$("notice-board").addEventListener("change", () => {
  state.board = $("notice-board").value;
  $("notice-query").value = "";
  $("source-url").value = sourceUrl(selectedKey());
  if (extension) chrome.storage.local.set({ noticeBoard: state.board }).catch(() => {});
  render();
  void maybeAutoRefresh();
});
function toggleSettings(open) {
  state.settings = open;
  clearTimeout(auto.timer);
  render();
  if (!open) void maybeAutoRefresh();
}
$("settings-toggle").addEventListener("click", () => toggleSettings(!state.settings));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.settings) { toggleSettings(false); $("settings-toggle").focus(); }
});
document.addEventListener("click", (event) => {
  if (state.settings && !$("settings").contains(event.target) && !$("settings-toggle").contains(event.target)) toggleSettings(false);
});
$("disconnect-seats").addEventListener("click", () => run("seats", async () => {
  await chrome.storage.session.remove("seatTabId");
  state.seatTabId = null;
  state.seatLogin = false;
  await chrome.storage.local.set({ seatAutoDisabled: true });
  auto.paused.seats = true;
  clearTimeout(auto.timer);
  setMessage("seats", "정석 페이지 연결을 해제했어요.");
}));
for (const key of sourceKeys) {
  const label = key === "breakfast" ? "천원의 아침밥" : key === "seats" ? "정석 좌석" : NOTICE_BOARDS[key === "notices" ? "general" : key.slice(8)].label;
  const option = node("option", label); option.value = key;
  $("settings-source").append(option);
}
$("settings-source").addEventListener("change", () => {
  const key = $("settings-source").value;
  state.selected = featureForKey(key);
  if (state.selected === "notices") state.board = key === "notices" ? "general" : key.slice(8);
  $("source-url").value = sourceUrl(key);
  render();
});
$("connect").addEventListener("click", () => $("refresh").click());
document.querySelectorAll("[data-feature]").forEach((button) => button.addEventListener("click", () => selectFeature(button.dataset.feature)));

async function init() {
  if (extension) {
    try {
      const stored = await chrome.storage.local.get(["sources", "results", "noticeBoard", "seatAutoDisabled"]);
      if (stored.seatAutoDisabled) {
        auto.paused.seats = true;
        setMessage("seats", "자동 조회가 꺼져 있어요. 새로 조회를 누르면 다시 시작해요.");
      }
      const session = await chrome.storage.session.get("seatTabId");
      if (Number.isInteger(session.seatTabId)) state.seatTabId = session.seatTabId;
      if (Object.hasOwn(NOTICE_BOARDS, stored.noticeBoard)) state.board = stored.noticeBoard;
      for (const key of sourceKeys) {
        try {
          if (stored.sources?.[key]) state.sources[key] = officialUrl(stored.sources[key], featureForKey(key));
          const result = stored.results?.[key];
          if (validStoredResult(featureForKey(key), result)) {
            state.results[key] = result;
            if (result.method === "tab" && key !== "seats") auto.paused[key] = true;
          }
        } catch { /* A damaged record must not prevent opening the panel. */ }
      }
    } catch { setMessage("breakfast", "저장된 정보를 읽지 못했어요. 확장 프로그램을 다시 열어 주세요.", true); }
  } else {
    for (const key of sourceKeys) setMessage(key, "화면 미리보기예요. 조회 기능은 크롬에 확장 프로그램을 설치하면 사용할 수 있어요.");
  }
  state.ready = true; selectFeature("seats");
}
setInterval(() => {
  if (state.results[selectedKey()] && (state.selected === "breakfast" || isStale(state.results[selectedKey()]))) render();
}, 15_000);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearTimeout(auto.timer);
  else {
    if (state.selected === "breakfast") render();
    // Login can finish inside a SPA without a navigation event.
    if (state.seatLogin) { auto.paused.seats = false; state.seatChecked = false; }
    void maybeAutoRefresh();
  }
});
if (extension) chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (tabId !== state.seatTabId || change.status !== "complete" || !state.seatLogin || state.busy) return;
  try { officialUrl(tab.url, "seats"); } catch { return; }
  state.seatLogin = false;
  state.seatChecked = false;
  auto.paused.seats = false;
  void maybeAutoRefresh();
});
init();
