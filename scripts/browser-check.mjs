import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { collectSnapshot } from "../extension/snapshot.js";
import { parseSnapshot } from "../extension/core.js";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.JARVIS_PLAYWRIGHT_PATH || "playwright");
const artifacts = path.resolve(".artifacts");
await fs.mkdir(artifacts, { recursive: true });
const context = await chromium.launchPersistentContext(path.join(artifacts, "test-profile"), {
  executablePath: process.env.JARVIS_CHROMIUM_PATH,
  headless: true,
  args: ["--disable-extensions-except=" + path.resolve("extension"), "--load-extension=" + path.resolve("extension")],
  viewport: { width: 390, height: 920 }
});
const dates = ["월요일 (10.05.)", "화요일 (10.06.)", "수요일 (10.07.)", "목요일 (10.08.)", "금요일 (10.09.)"];
const mealHtml = '<title>학생식당</title><main><h1>천원의 아침밥</h1>' + dates.map((date, index) =>
  `<section ${index === 1 ? '' : 'style="display:none"'}><h2>${date}</h2><div><table><tr><th>구분</th><th>가격</th><th>메뉴</th></tr><tr><td>천원의 아침밥</td><td>1000</td><td>${index === 4 ? '' : `검증용 메뉴 ${index}<br>쌀밥<br>배추김치`}</td></tr><tr><td>중식</td><td>5000</td><td>점심</td></tr></table></div></section>`
).join('') + '</main>';
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionUrl = "chrome-extension://" + new URL(worker.url()).host + "/sidepanel.html";
  // Live page extraction must include hidden weekday panes, preserving line breaks.
  const schoolPage = await context.newPage();
  await schoolPage.route("https://www.inha.ac.kr/**", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: mealHtml }));
  await schoolPage.goto("https://www.inha.ac.kr/kr/1072/subview.do");
  const breakfast = parseSnapshot("breakfast", await schoolPage.evaluate(collectSnapshot, "breakfast"));
  assert.deepEqual(breakfast.data.sections.map((section) => section.date), dates);
  assert.deepEqual(breakfast.data.sections[0].items, ["검증용 메뉴 0", "쌀밥", "배추김치"]);
  assert.deepEqual(breakfast.data.sections[4].items, []);
  await schoolPage.close();

  const libraryPage = await context.newPage();
  await libraryPage.route("https://lib.inha.ac.kr/**", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body:
    '<title>정석학술정보관</title><main>도서 검색</main><div role="dialog"><table><tr><th>열람실</th><th>전체</th><th>잔여 좌석</th></tr><tr><td>제1열람실</td><td>375</td><td>0</td></tr></table><button aria-label="제2열람실: 28 좌석 이용가능">제2열람실</button></div>' }));
  await libraryPage.goto("https://lib.inha.ac.kr/");
  const librarySnapshot = await libraryPage.evaluate(collectSnapshot, "seats");
  assert.deepEqual(parseSnapshot("seats", librarySnapshot).data.rooms, [{ name: "제1열람실", available: 0, occupied: null, total: null }, { name: "제2열람실", available: 28, occupied: null, total: null }]);
  await libraryPage.close();

  const page = await context.newPage();
  await page.clock.install({ time: new Date("2026-10-06T10:00:00Z") });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(extensionUrl);
  await page.locator("#refresh:enabled").waitFor();
  const fromHtml = await page.evaluate(async (html) => {
    const { snapshotFromHtml } = await import("./snapshot.js");
    const { parseSnapshot } = await import("./core.js");
    return parseSnapshot("breakfast", snapshotFromHtml(html, "https://www.inha.ac.kr/kr/1072/subview.do", "breakfast"));
  }, mealHtml);
  assert.deepEqual(fromHtml.data.sections, breakfast.data.sections);
  const notices = parseSnapshot("notices", { url: "https://www.inha.ac.kr/kr/950/subview.do", links: [
    { href: "/bbs/kr/8/123/artclView.do", text: "장학금 검증용 공지", context: "2026.10.06" },
    { href: "/bbs/kr/8/124/artclView.do", text: "수강신청 검증용 공지", context: "2026.10.05" }
  ] });
  notices.fetchedAt = "2020-01-01T00:00:00Z";
  await page.evaluate(async (results) => { await chrome.storage.local.clear(); await chrome.storage.local.set({ results }); }, { breakfast, notices });
  await page.reload();
  await page.locator("#refresh:enabled").waitFor();
  assert.deepEqual(await page.locator(".features button").allTextContents(), ["정석 좌석", "천원의 아침밥", "인하공지"]);
  assert.ok((await page.locator("#settings-toggle").boundingBox()).width <= 30);
  await page.locator('[data-feature="breakfast"]').click();
  assert.deepEqual(await page.locator(".meal-date").allTextContents(), dates.map((date, index) => (index === 1 ? "오늘 " : index === 2 ? "내일 " : "") + date));
  assert.equal(await page.locator(".meal-today").evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(229, 245, 201)");
  assert.equal(await page.locator(".meal-tomorrow").evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(255, 243, 191)");
  assert.doesNotMatch(await page.locator("#results").innerText(), /1,?000|점심/);
  assert.match(await page.locator(".breakfast-section").last().innerText(), /등록된 메뉴가 없어요/);
  await page.screenshot({ path: path.join(artifacts, "breakfast-week.png"), fullPage: true });
  await page.clock.setSystemTime(new Date("2026-10-06T15:00:00Z"));
  await page.clock.runFor(15_001);
  assert.match(await page.locator(".meal-today .meal-date").innerText(), /10\.07/);
  assert.match(await page.locator(".meal-tomorrow .meal-date").innerText(), /10\.08/);
  await page.locator('[data-feature="notices"]').click();
  assert.match(await page.locator("#status").innerText(), /오래된/);
  await page.locator("#notice-query").fill("장학금");
  assert.equal(await page.locator(".notice").count(), 1);
  await page.locator("#notice-query").fill("");
  await page.evaluate(() => {
    chrome.permissions.request = async () => true;
    chrome.runtime.sendMessage = async () => ({ ok: false, message: "검증용 네트워크 오류" });
  });
  await page.locator("#refresh").click();
  await page.locator("#message.error").waitFor();
  assert.equal(await page.locator(".notice").count(), 2);
  await page.evaluate(() => { chrome.runtime.sendMessage = () => new Promise((resolve) => { globalThis.finishTestResponse = resolve; }); });
  await page.locator("#refresh").click();
  await page.locator('[data-feature="breakfast"]').click();
  await page.evaluate(() => finishTestResponse({ ok: false, message: "공지 조회 실패" }));
  await page.locator("#refresh:enabled").waitFor();
  assert.doesNotMatch(await page.locator("#message").innerText(), /공지 조회 실패/);

  await page.locator("#settings-toggle").click();
  assert.equal(await page.locator("#feature-content").isVisible(), true);
  assert.equal(await page.locator("#settings-toggle").getAttribute("aria-expanded"), "true");
  assert.equal(await page.locator("#source-url").isVisible(), false);
  await page.screenshot({ path: path.join(artifacts, "compact-settings.png"), fullPage: true });
  await page.locator("#advanced-settings summary").click();
  assert.equal(await page.locator("#settings-source option").count(), 6);
  await page.locator("#settings-source").selectOption("notices:computer");
  assert.equal(await page.locator("#source-url").inputValue(), "https://cse.inha.ac.kr/cse/888/subview.do");
  await page.screenshot({ path: path.join(artifacts, "settings-tab.png"), fullPage: true });
  await page.locator("#source-url").fill("https://inha.ac.kr.evil.test/");
  await page.locator("#save-source").click();
  await page.locator("#settings-message.error").waitFor();
  assert.match(await page.locator("#settings-message").innerText(), /공식 페이지/);
  await page.locator("#clear-data").click();
  await page.waitForFunction(() => document.querySelector("#settings-message").textContent.includes("삭제했어요"));
  assert.deepEqual(await page.evaluate(() => chrome.storage.local.get(["results", "sources"])), {});
  await page.setViewportSize({ width: 300, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  await page.close();
  console.log("Browser checks passed: every weekday including hidden panes and empty menus, both DOM extraction paths, settings tab, source selection, failure retention, notice search, 300px layout.");

  const autoPage = await context.newPage();
  await autoPage.clock.install();
  await autoPage.addInitScript((html) => {
    globalThis.autoTest = { calls: 0, fail: false, prompts: 0 };
    chrome.permissions.contains = async ({ origins }) => origins[0].includes("www.inha.ac.kr");
    chrome.permissions.request = async () => { autoTest.prompts++; return true; };
    chrome.runtime.sendMessage = async () => {
      autoTest.calls++;
      return autoTest.fail ? { ok: false, message: "조회 실패" } : { ok: true, url: "https://www.inha.ac.kr/kr/1072/subview.do", fetchedAt: new Date().toISOString(), html };
    };
  }, mealHtml);
  await autoPage.goto(extensionUrl);
  await autoPage.locator('[data-feature="breakfast"]').click();
  await autoPage.locator(".meal-date").first().waitFor();
  assert.equal(await autoPage.evaluate(() => autoTest.calls), 1);
  await autoPage.locator("#settings-toggle").click();
  await autoPage.clock.runFor(1_800_001);
  assert.equal(await autoPage.evaluate(() => autoTest.calls), 1);
  await autoPage.locator('[data-feature="breakfast"]').click();
  await autoPage.waitForFunction(() => autoTest.calls === 2);
  await autoPage.locator("#refresh:enabled").waitFor();
  await autoPage.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); });
  await autoPage.clock.runFor(1_800_001);
  assert.equal(await autoPage.evaluate(() => autoTest.calls), 2);
  await autoPage.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event("visibilitychange")); });
  await autoPage.waitForFunction(() => autoTest.calls === 3);
  await autoPage.locator("#refresh:enabled").waitFor();
  await autoPage.evaluate(() => { autoTest.fail = true; });
  await autoPage.clock.runFor(1_800_001);
  await autoPage.locator("#message.error").waitFor();
  assert.equal(await autoPage.evaluate(() => autoTest.calls), 4);
  await autoPage.clock.runFor(3_600_000);
  assert.equal(await autoPage.evaluate(() => autoTest.calls), 4);
  assert.equal(await autoPage.evaluate(() => autoTest.prompts), 0);
  await autoPage.evaluate(() => { autoTest.fail = false; });
  await autoPage.locator("#refresh").click();
  await autoPage.locator("#refresh:enabled").waitFor();
  assert.equal(await autoPage.evaluate(() => autoTest.calls), 5);
  await autoPage.locator("#settings-toggle").click();
  await autoPage.locator("#clear-data").click();
  await autoPage.locator("#clear-data:enabled").waitFor();
  await autoPage.locator('[data-feature="breakfast"]').click();
  await autoPage.clock.runFor(1_800_001);
  assert.equal(await autoPage.evaluate(() => autoTest.calls), 5);
  await autoPage.close();
  console.log("Auto-refresh checks passed: 30-minute polling, settings/hidden pause, return refresh, failure pause, manual recovery and no refetch after clearing.");

  // Logged-in seat data is read from an explicitly connected tab, not fetched without its session.
  const seatPage = await context.newPage();
  await seatPage.clock.install();
  await seatPage.addInitScript(() => {
    globalThis.seatTest = { reads: 0, count: 28, closed: false, allowed: false };
    chrome.permissions.contains = async () => seatTest.allowed;
    chrome.permissions.request = async () => { seatTest.allowed = true; return true; };
    chrome.tabs.reload = async () => {};
    chrome.runtime.sendMessage = async ({ type }) => {
      if (type !== "ENSURE_SEAT_TAB") throw new Error("Seats must not use credential-free fetch");
      if (seatTest.closed) return { ok: false, message: "Test connection failure" };
      await chrome.storage.session.set({ seatTabId: 777 });
      return { ok: true, tabId: 777, created: false };
    };
    chrome.tabs.query = async () => [{ id: 777, url: "https://lib.inha.ac.kr/" }];
    chrome.tabs.get = async (id) => {
      if (id !== 777 || seatTest.closed) throw new Error("No tab");
      return { id, url: "https://lib.inha.ac.kr/" };
    };
    chrome.scripting.executeScript = async ({ target, args }) => {
      if (target.tabId !== 777 || args[0] !== "seats") throw new Error("Wrong target");
      seatTest.reads++;
      return [{ result: { url: "https://lib.inha.ac.kr/", title: "정석학술정보관", method: "tab", text: `제1열람실: 0 좌석 이용가능\n제2열람실: ${seatTest.count} 좌석 이용가능\n제2-1열람실: 99 좌석 이용가능` } }];
    };
  });
  await seatPage.goto(extensionUrl);
  await seatPage.locator("#refresh:enabled").waitFor();
  await seatPage.locator('[data-feature="seats"]').click();
  assert.equal(await seatPage.locator("#connect").innerText(), "자동 조회 시작");
  assert.equal(await seatPage.evaluate(() => seatTest.reads), 0);
  await seatPage.locator("#connect").click();
  await seatPage.locator(".room").first().waitFor();
  assert.deepEqual(await seatPage.locator(".room h3").allTextContents(), ["제1열람실", "제2열람실"]);
  assert.deepEqual(await seatPage.locator(".room strong").allTextContents(), ["0", "28"]);
  assert.equal(await seatPage.locator(".room-occupancy").count(), 0);
  assert.match(await seatPage.locator("#provenance").innerText(), /조회/);
  assert.deepEqual(await seatPage.evaluate(() => chrome.storage.session.get("seatTabId")), { seatTabId: 777 });
  await seatPage.screenshot({ path: path.join(artifacts, "unified-seats.png"), fullPage: true });
  await seatPage.evaluate(() => { seatTest.count = 27; });
  await seatPage.clock.runFor(60_001);
  await seatPage.waitForFunction(() => document.querySelectorAll(".room strong")[1].textContent === "27");
  assert.equal(await seatPage.evaluate(() => seatTest.reads), 2);
  await seatPage.locator("#settings-toggle").click();
  await seatPage.clock.runFor(60_001);
  assert.equal(await seatPage.evaluate(() => seatTest.reads), 2);
  await seatPage.locator('[data-feature="seats"]').click();
  await seatPage.waitForFunction(() => seatTest.reads === 3);
  await seatPage.locator("#refresh:enabled").waitFor();
  await seatPage.evaluate(() => { seatTest.closed = true; });
  await seatPage.clock.runFor(60_001);
  await seatPage.locator("#message.error").waitFor();
  assert.match(await seatPage.locator("#message-detail").textContent(), /Test connection failure/);
  assert.deepEqual(await seatPage.locator(".room strong").allTextContents(), ["0", "27"]);
  await seatPage.clock.runFor(120_001);
  assert.equal(await seatPage.evaluate(() => seatTest.reads), 3);
  await seatPage.evaluate(() => { seatTest.closed = false; seatTest.count = 26; });
  await seatPage.locator("#read-tab").click();
  await seatPage.waitForFunction(() => document.querySelectorAll(".room strong")[1].textContent === "26");
  await seatPage.reload();
  await seatPage.locator("#refresh:enabled").waitFor();
  await seatPage.locator('[data-feature="seats"]').click();
  assert.equal(await seatPage.locator(".room").count(), 2);
  await seatPage.locator("#settings-toggle").click();
  await seatPage.locator("#clear-data").click();
  await seatPage.locator("#clear-data:enabled").waitFor();
  assert.deepEqual(await seatPage.evaluate(() => chrome.storage.session.get("seatTabId")), {});
  await seatPage.setViewportSize({ width: 300, height: 800 });
  assert.equal(await seatPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await seatPage.close();
  console.log("Seat checks passed: explicit tab connection, merged second room, zero seats, 60-second page reads, settings pause, closed-tab fallback, reconnect and session cleanup.");

  const boardPage = await context.newPage();
  await boardPage.addInitScript(() => {
    globalThis.boardTest = { calls: [] };
    chrome.permissions.contains = async ({ origins }) => /datascience|cse|swuniv/.test(origins[0]);
    chrome.runtime.sendMessage = async ({ sourceKey }) => {
      boardTest.calls.push(sourceKey);
      const { noticeDefaultUrl } = await import("./sources.js");
      const response = { ok: true, url: noticeDefaultUrl(sourceKey), fetchedAt: new Date().toISOString(), html: '<main><a href="/bbs/test/1/123/artclView.do">' + sourceKey + ' 검증용 공지</a></main>' };
      if (sourceKey === "notices:dataScience") return new Promise((resolve) => { boardTest.finish = () => resolve(response); });
      return response;
    };
  });
  await boardPage.goto(extensionUrl);
  await boardPage.locator("#refresh:enabled").waitFor();
  await boardPage.locator('[data-feature="notices"]').click();
  assert.deepEqual(await boardPage.locator("#notice-board option").allTextContents(), ["공지사항", "데이터사이언스학과 게시판", "컴퓨터공학과 게시판", "SW융합대학사업단 게시판"]);
  await boardPage.locator("#notice-board").selectOption("dataScience");
  await boardPage.waitForFunction(() => !!boardTest.finish);
  await boardPage.locator("#notice-board").selectOption("computer");
  await boardPage.evaluate(() => boardTest.finish());
  await boardPage.waitForFunction(() => document.querySelector("#results").textContent.includes("notices:computer"));
  assert.doesNotMatch(await boardPage.locator("#results").innerText(), /dataScience/);
  await boardPage.locator("#notice-board").selectOption("dataScience");
  assert.match(await boardPage.locator("#results").innerText(), /notices:dataScience/);
  assert.equal(await boardPage.evaluate(() => boardTest.calls.filter((key) => key === "notices:dataScience").length), 1);
  await boardPage.locator("#notice-board").selectOption("sw");
  await boardPage.waitForFunction(() => document.querySelector("#results").textContent.includes("notices:sw"));
  await boardPage.reload();
  await boardPage.locator("#refresh:enabled").waitFor();
  await boardPage.locator('[data-feature="notices"]').click();
  assert.equal(await boardPage.locator("#notice-board").inputValue(), "sw");
  assert.match(await boardPage.locator("#results").innerText(), /notices:sw/);
  await boardPage.close();
  console.log("Notice-board checks passed: four choices, independent caches, in-flight switch isolation and selection persistence.");
} finally { await context.close(); }
