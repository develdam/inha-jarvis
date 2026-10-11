import { FEATURES, officialUrl } from "./core.js";
import { fetchOfficialPage } from "./network.js";
import { featureForKey, isSourceKey, noticeDefaultUrl } from "./sources.js";
import { ensureSeatTab } from "./seat-connection.js";
import { upcomingExams, dDayLabel } from "./exams.js";

// Show the nearest exam's D-day on the toolbar icon; the alarm rolls it over at midnight.
async function updateExamBadge() {
  const [next] = upcomingExams();
  await chrome.action.setBadgeText({ text: next ? (next.days === 0 ? "DDAY" : dDayLabel(next.days)) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: next && next.days <= 7 ? "#c0392b" : "#155bcc" });
  await chrome.action.setBadgeTextColor({ color: "#ffffff" });
  await chrome.action.setTitle({ title: next ? `인하 자비스 · ${next.course} ${dDayLabel(next.days)} (${next.date.slice(5).replace("-", "/")} ${next.time || ""})`.trim() : "인하 자비스 열기" });
}
chrome.alarms.create("exam-badge", { periodInMinutes: 30 });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === "exam-badge") void updateExamBadge(); });
chrome.runtime.onStartup.addListener(() => void updateExamBadge());
chrome.runtime.onInstalled.addListener(() => void updateExamBadge());
void updateExamBadge();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("sidepanel.html") || message?.type !== "ENSURE_SEAT_TAB") return false;
  ensureSeatTab().then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, message: error.message }));
  return true;
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("사이드 패널 설정 실패", error));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("sidepanel.html") ||
      message?.type !== "FETCH_SOURCE") return false;
  (async () => {
    if (!Object.hasOwn(FEATURES, message.feature)) throw new Error("지원하지 않는 기능이에요.");
    const key = message.sourceKey || message.feature;
    if (!isSourceKey(key) || featureForKey(key) !== message.feature) throw new Error("지원하지 않는 게시판이에요.");
    const stored = await chrome.storage.local.get("sources");
    const defaultUrl = message.feature === "notices" ? noticeDefaultUrl(key) : FEATURES[message.feature].defaultUrl;
    const url = officialUrl(stored.sources?.[key] || defaultUrl, message.feature);
    const allowed = await chrome.permissions.contains({ origins: [`${new URL(url).origin}/*`] });
    if (!allowed) throw new Error("조회할 학교 페이지의 접근 권한이 필요해요. 다시 조회해 주세요.");
    return await fetchOfficialPage(url, message.feature);
  })().then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, code: error.code || "NETWORK", message:
      error.code || !/fetch|timeout|abort/i.test(error.message) ? error.message :
        "학교 페이지에 연결하지 못했어요. 페이지를 브라우저에서 열고 ‘열린 페이지 읽기’를 시도해 주세요." }));
  return true;
});
