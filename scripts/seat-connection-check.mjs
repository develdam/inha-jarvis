import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.JARVIS_PLAYWRIGHT_PATH || "playwright");
const artifacts = path.resolve(".artifacts");
const fixtureExtension = path.join(artifacts, "seat-test-extension");
await fs.cp(path.resolve("extension"), fixtureExtension, { recursive: true });
// Only this disposable test copy has pregranted origins. Production requests them on connection.
const manifestPath = path.join(fixtureExtension, "manifest.json");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
manifest.host_permissions = ["https://lib.inha.ac.kr/*", "https://libapp.inha.ac.kr/*", "https://booking.inha.ac.kr/*"];
await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
const profile = await fs.mkdtemp(path.join(artifacts, "seat-test-profile-"));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.JARVIS_CHROMIUM_PATH,
  headless: true,
  args: ["--disable-extensions-except=" + fixtureExtension, "--load-extension=" + fixtureExtension],
  viewport: { width: 390, height: 800 }
});
try {
  let remaining = 18;
  let loggedIn = true;
  let pageLoads = 0;
  // No real school traffic or user login is used in this test.
  await context.route("https://**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.host === "lib.inha.ac.kr") {
      pageLoads++;
      if (!loggedIn) return route.fulfill({ contentType: "text/html; charset=utf-8", body: '<title>정석학술정보관</title><form><input type="password"><button>로그인</button></form>' });
    }
    const html = url.host === "lib.inha.ac.kr" ? '<title>My Library</title><main>로그인 후 도서관 이용</main><iframe src="https://libapp.inha.ac.kr/my-library/seat" style="width:350px;height:350px"></iframe>' :
      url.host === "libapp.inha.ac.kr" ? '<title>열람실 현황</title><main><section aria-label="제1열람실: 99 좌석 이용가능"><h2>제1열람실</h2><div><strong>0</strong> 좌석 이용가능<p>375 / 375</p></div></section><section aria-label="제2열람실: 19 좌석 이용가능"><strong id="second">18</strong><h2>제2열람실</h2><p><span id="used">482</span>/<span>500</span></p></section><section style="visibility:hidden"><h2>제2열람실</h2>40<p>460 / 500</p></section><section aria-hidden="true"><h2>제2열람실</h2>50<p>450 / 500</p></section><section style="opacity:0"><h2>제2열람실</h2>60<p>440 / 500</p></section></main>' : null;
    return html ? route.fulfill({ contentType: "text/html; charset=utf-8", body: html.replace('id="second">18', 'id="second">' + remaining).replace('id="used">482', 'id="used">' + (500 - remaining)) }) : route.abort();
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  // Playwright cannot route the initial navigation of a tab opened by chrome.tabs.
  // Attach its routing before navigating; tab creation and the rest of Chrome's APIs stay real.
  await worker.evaluate(() => {
    const create = chrome.tabs.create.bind(chrome.tabs);
    chrome.tabs.create = async (options) => {
      const tab = await create({ ...options, url: "about:blank" });
      await new Promise((resolve) => setTimeout(resolve, 250));
      return chrome.tabs.update(tab.id, { url: options.url });
    };
  });
  const extensionUrl = "chrome-extension://" + new URL(worker.url()).host + "/sidepanel.html";
  await worker.evaluate(async () => { await chrome.storage.local.clear(); await chrome.storage.session.clear(); });
  for (const page of context.pages()) await page.close();
  const panel = await context.newPage();
  await panel.goto(extensionUrl);
  await panel.locator(".room strong").first().waitFor();
  await panel.locator("#refresh:enabled").waitFor();
  const library = context.pages().find((page) => page.url().startsWith("https://lib.inha.ac.kr/"));
  assert.ok(library, "Opening Jarvis alone must create the library page");
  assert.equal((await worker.evaluate(() => chrome.tabs.query({ url: "https://lib.inha.ac.kr/*" })))[0].active, false);
  assert.deepEqual(await panel.locator(".room h3").allTextContents(), ["제1열람실", "제2열람실"]);
  assert.deepEqual(await panel.locator(".room strong").allTextContents(), ["0", "18"]);
  assert.deepEqual(await panel.locator(".room-ratio").allTextContents(), ["예약 375 / 375석", "예약 482 / 500석"]);
  assert.deepEqual(await panel.locator(".room-occupancy").allTextContents(), ["혼잡도 100%", "혼잡도 96.4%"]);
  assert.equal(await panel.locator("#message.error").count(), 0);
  const session = await panel.evaluate(() => chrome.storage.session.get("seatTabId"));
  assert.ok(Number.isInteger(session.seatTabId));
  remaining = 17;
  const beforeRefresh = pageLoads;
  await panel.locator("#refresh").click();
  await panel.waitForFunction(() => document.querySelectorAll(".room strong")[1]?.textContent === "17");
  assert.equal(await panel.locator(".room-ratio").nth(1).innerText(), "예약 483 / 500석");
  assert.equal(await panel.locator(".room-occupancy").nth(1).innerText(), "혼잡도 96.6%");
  assert.ok(pageLoads > beforeRefresh, "Refresh must request new page data");
  await panel.screenshot({ path: path.join(artifacts, "seat-card-layout.png"), fullPage: true });
  await panel.locator("#settings-toggle").click();
  assert.equal(await panel.locator("#source-url").isVisible(), false);
  assert.ok((await panel.locator("#settings").boundingBox()).height < 190);
  await panel.screenshot({ path: path.join(artifacts, "compact-settings-connected.png"), fullPage: true });
  await panel.keyboard.press("Escape");
  assert.equal(await panel.locator("#settings").isVisible(), false);
  await panel.setViewportSize({ width: 300, height: 800 });
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await library.close();
  // Simulate browser restart: cached results persist, session IDs and tabs do not.
  await worker.evaluate(() => chrome.storage.session.clear());
  remaining = 16;
  await panel.reload();
  await panel.waitForFunction(() => document.querySelectorAll(".room strong")[1]?.textContent === "16");
  await panel.locator("#refresh:enabled").waitFor();
  assert.equal((await worker.evaluate(() => chrome.tabs.query({ url: "https://lib.inha.ac.kr/*" }))).length, 1);
  await panel.reload();
  await panel.locator("#refresh:enabled").waitFor();
  assert.equal((await worker.evaluate(() => chrome.tabs.query({ url: "https://lib.inha.ac.kr/*" }))).length, 1);
  loggedIn = false;
  await panel.locator("#refresh").click();
  await panel.locator("#message.error").waitFor();
  assert.match(await panel.locator("#message").innerText(), /로그인/);
  assert.equal(await panel.locator("#read-tab").innerText(), "정석 로그인");
  assert.deepEqual(await panel.locator(".room strong").allTextContents(), ["0", "16"]);
  await panel.locator("#read-tab").click();
  assert.equal((await worker.evaluate(() => chrome.tabs.query({ url: "https://lib.inha.ac.kr/*" }))).length, 1);
  const recoveredLibrary = context.pages().find((page) => page.url().startsWith("https://lib.inha.ac.kr/"));
  loggedIn = true;
  remaining = 15;
  await recoveredLibrary.reload();
  await panel.bringToFront();
  await panel.waitForFunction(() => document.querySelectorAll(".room strong")[1]?.textContent === "15");
  await panel.locator("#refresh:enabled").waitFor();
  await panel.locator("#settings-toggle").click();
  await panel.locator("#disconnect-seats").click();
  await panel.locator("#refresh:enabled").waitFor();
  const beforeDisconnect = pageLoads;
  await panel.reload();
  await panel.locator("#refresh:enabled").waitFor();
  assert.equal(pageLoads, beforeDisconnect, "Explicit disconnect persists across reopening");
  console.log("Real Chrome checks passed: automatic inactive tab creation, restart recovery, reuse without duplicates, actual reload, iframe seats, login recovery, persistent disconnect and compact layout.");
} catch (error) {
  for (const page of context.pages()) {
    console.error(page.url(), await page.locator("body").innerText().catch(() => "unreadable"));
    if (page.url().startsWith("chrome-extension:")) console.error("connection response", await page.evaluate(() => chrome.runtime.sendMessage({ type: "ENSURE_SEAT_TAB" })));
  }
  throw error;
} finally { await context.close(); }
