import test from "node:test";
import assert from "node:assert/strict";
import { officialUrl, parseSnapshot, parseNotices, parseBreakfast, parseSeats, isStale, filterNotices } from "../extension/core.js";
import { fetchOfficialPage } from "../extension/network.js";
import { validStoredResult } from "../extension/core.js";
import { NOTICE_BOARDS, noticeKey, featureForKey, noticeDefaultUrl, isSourceKey } from "../extension/sources.js";
import { menuLines, mealDate, mealDay } from "../extension/breakfast.js";
import { occupancyPercent } from "../extension/seats.js";

test("breakfast highlights Korean today and tomorrow, respecting explicit years and calendar boundaries", () => {
  const now = new Date("2026-10-05T15:00:00Z");
  assert.equal(mealDay("화요일 (10.06.)", now), "today");
  assert.equal(mealDay("2026년 10월 7일", now), "tomorrow");
  for (const value of [null, "날짜 미표시", "10.05.", "2025.10.06.", "10.06. ~ 10.07.", "2.30."]) {
    assert.equal(mealDay(value, now), null);
  }
  assert.equal(mealDay("10.06.", new Date("2026-10-05T14:59:59Z")), "tomorrow");
  assert.equal(mealDay("2027.01.01.", new Date("2026-12-31T10:00:00Z")), "tomorrow");
  assert.equal(mealDay("1.01.", new Date("2026-12-31T10:00:00Z")), "tomorrow");
  assert.equal(mealDay("2026.01.01.", new Date("2026-12-31T10:00:00Z")), null);
  assert.equal(mealDay("3.01.", new Date("2028-02-29T10:00:00Z")), "tomorrow");
});

test("official URLs reject lookalike hosts, credentials, unsafe protocols and account pages", () => {
  assert.equal(officialUrl("https://www.inha.ac.kr/kr/1072/subview.do#menu"), "https://www.inha.ac.kr/kr/1072/subview.do");
  for (const url of ["https://inha.ac.kr.evil.test/", "https://fakeinha.ac.kr/", "http://www.inha.ac.kr/", "javascript:alert(1)", "https://user:pass@www.inha.ac.kr/", "https://lib.inha.ac.kr/login", "https://lib.inha.ac.kr/?token=secret", "https://lib.inha.ac.kr:8443/"]) {
    assert.throws(() => officialUrl(url));
  }
});

test("seats use library origins and login pages are not parsed", () => {
  assert.equal(isSourceKey("seats"), true);
  assert.throws(() => officialUrl("https://www.inha.ac.kr/", "seats"), { code: "URL" });
  assert.throws(() => parseSnapshot("breakfast", { url: "https://www.inha.ac.kr/kr/1072/subview.do", loginRequired: true }), { code: "LOGIN" });
});

test("signed-in library seat routes are allowed while login actions remain blocked", () => {
  const url = "https://lib.inha.ac.kr/mylibrary/seat/reading-rooms";
  assert.equal(officialUrl(url, "seats"), url);
  assert.equal(officialUrl("https://libapp.inha.ac.kr/myPage/seat", "seats"), "https://libapp.inha.ac.kr/myPage/seat");
  assert.throws(() => officialUrl(url, "notices"), { code: "LOGIN" });
  for (const path of ["/login", "/logout", "/oauth/authorize", "/sso", "/my-library/seat?token=secret"]) {
    assert.throws(() => officialUrl("https://lib.inha.ac.kr" + path, "seats"), { code: "LOGIN" });
  }
  assert.equal(parseSnapshot("seats", { url, text: "제2열람실: 18 좌석 이용가능" }).data.rooms[1].available, 18);
});

test("seats show the unified second room, retain zero and ignore old subdivisions", () => {
  const result = parseSeats({ text: "제1열람실: 12 좌석 이용가능\n제2열람실 잔여 좌석: 0석\n제2-1열람실: 99 좌석 이용가능\n제2-2열람실: 42 좌석 이용가능\n제2-2열람실 (대학원생 전용): 7 좌석 이용가능" });
  assert.deepEqual(result.rooms, [{ name: "제1열람실", available: 12, occupied: null, total: null }, { name: "제2열람실", available: 0, occupied: null, total: null }]);
  const legacy = parseSeats({ text: "제1열람실: 12 좌석 이용가능\n제2-1열람실: 99 좌석 이용가능\n제2-2열람실: 42 좌석 이용가능" });
  assert.equal(legacy.rooms[1].available, null);
  assert.throws(() => parseSeats({ text: "제2-1열람실: 99 좌석 이용가능\n제2-2열람실: 42 좌석 이용가능" }), { code: "FORMAT" });
});

test("seat tables require an availability heading and conflicting counts fail", () => {
  const result = parseSeats({ text: "", tables: [{ rows: [["열람실", "전체", "잔여 좌석"], ["제1열람실", "1500", "1,000"], ["제2열람실", "500", "25석"]] }] });
  assert.deepEqual(result.rooms.map((room) => room.available), [1000, 25]);
  for (const text of ["", "Please enable JavaScript", "제2열람실 150 21 / 170", "제2열람실: 12345 좌석 이용가능", "제2열람실: 10 좌석 이용가능\n제2열람실: 20 좌석 이용가능"]) {
    assert.throws(() => parseSeats({ text }), { code: "FORMAT" });
  }
});

test("school cards use remaining above occupied/total and check the sum", () => {
  const result = parseSeats({ text: "제1열람실\n216\n159 / 375\n제2열람실\n0\n500 / 500" });
  assert.deepEqual(result.rooms.map((room) => room.available), [216, 0]);
  const aboveTitle = parseSeats({ seatBlocks: ["216\n제1열람실\n159 / 375", "1,200\n제2열람실\n300 / 1,500"] });
  assert.deepEqual(aboveTitle.rooms.map((room) => room.available), [216, 1200]);
  for (const block of ["제2열람실 18 480 / 500", "제2열람실 482 / 500", "제2열람실 0 0 / 0", "제2열람실 18 제1열람실 482 / 500", "제2-1열람실 18 482 / 500", "제2열람실 18.5 481.5 / 500"]) {
    assert.throws(() => parseSeats({ seatBlocks: [block] }), { code: "FORMAT" });
  }
  assert.throws(() => parseSeats({ seatBlocks: ["제2열람실 18 482 / 500", "제2열람실 19 481 / 500"] }), { code: "FORMAT" });
});

test("availability text cannot mistake the following occupied/total for remaining seats", () => {
  const result = parseSeats({ text: "제2열람실\n18 좌석 이용가능\n482 / 500" });
  assert.equal(result.rooms[1].available, 18);
  assert.equal(result.rooms[1].occupied, 482);
  assert.equal(result.rooms[1].total, 500);
});

test("seat occupancy retains the original ratio, rounds to one decimal, and handles full/empty rooms", () => {
  const data = parseSeats({ seatBlocks: ["제1열람실 216 159 / 375", "제2열람실 0 500 / 500"] });
  assert.deepEqual(data.rooms[0], { name: "제1열람실", available: 216, occupied: 159, total: 375 });
  assert.equal(occupancyPercent(data.rooms[0]), 42.4);
  assert.equal(occupancyPercent(data.rooms[1]), 100);
  assert.equal(occupancyPercent(parseSeats({ text: "제1열람실 375 0 / 375" }).rooms[0]), 0);
  assert.equal(occupancyPercent(parseSeats({ text: "제1열람실 2 1 / 3" }).rooms[0]), 33.3);
  assert.equal(occupancyPercent(parseSeats({ text: "제1열람실: 18 좌석 이용가능" }).rooms[0]), null);
  assert.equal(occupancyPercent({ available: 0, occupied: 0, total: 0 }), null);
  assert.equal(occupancyPercent({ available: 20, occupied: 90, total: 100 }), null);
  assert.throws(() => parseSeats({ seatBlocks: ["제2열람실 18 482 / 500", "제2열람실 18 382 / 400"] }), { code: "FORMAT" });
});

test("validated visible cards take precedence over page text and stale attribute labels", () => {
  const result = parseSeats({ text: "제1열람실: 12 좌석 이용가능\n제2열람실: 19 좌석 이용가능", seatBlocks: ["제2열람실 18 482 / 500"], seatLabels: ["제2열람실: 20 좌석 이용가능"] });
  assert.deepEqual(result.rooms.map((room) => room.available), [12, 18]);
});

test("old split-room seat caches cannot return as current data", () => {
  const record = { feature: "seats", sourceUrl: "https://lib.inha.ac.kr/kiosk/", method: "fetch", fetchedAt: "2026-10-06T08:00:00Z", data: { rooms: [{ name: "제2-1열람실", available: 99 }] } };
  assert.equal(validStoredResult("seats", record), false);
  record.data = parseSeats({ text: "제2열람실: 20 좌석 이용가능" });
  assert.equal(validStoredResult("seats", record), true);
  const invalid = structuredClone(record);
  invalid.data.rooms[1].occupied = 9;
  invalid.data.rooms[1].total = 100;
  assert.equal(validStoredResult("seats", invalid), false);
  assert.equal(isStale(record, Date.parse("2026-10-06T08:00:59Z")), false);
  assert.equal(isStale(record, Date.parse("2026-10-06T08:01:00Z")), true);
});

test("notices resolve relative links, deduplicate, exclude navigation and unsafe URLs", () => {
  const result = parseNotices({ url: "https://www.inha.ac.kr/list", links: [
    { text: "2026 장학금 신청 안내", href: "/bbs/kr/8/123/artclView.do", context: "2026.10.06" },
    { text: "중복 장학금 신청 안내", href: "/bbs/kr/8/123/artclView.do", context: "2026.10.06" },
    { text: "학사 공지사항", href: "/list", context: "2026.10.06" },
    { text: "악성 사이트 공지", href: "https://evil.test/notice/123" },
    { text: "스크립트 실행 공지", href: "javascript:alert(1)" },
    { text: "기숙사 모집 안내", href: "/bbs/kr/8/124/artclView.do" }
  ] });
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].date, "2026-10-06");
  assert.equal(result.items[1].date, null);
  assert.equal(filterNotices(result.items, "장학금 신청").length, 1);
  assert.equal(filterNotices(result.items, "존재하지않음").length, 0);
});

test("breakfast extracts programme rows with original date headers and excludes lunch and dinner", () => {
  const result = parseBreakfast({ title: "학생식당", text: "천원의 아침밥", tables: [{ rows: [
    ["구분", "10/05 월요일", "10/06 화요일"],
    ["천원의 아침밥", "쌀밥\n미역국\n김치", "계란국\n두부조림"],
    ["중식", "제육볶음", "돈가스"],
    ["석식", "우동", "볶음밥"]
  ] }] });
  assert.equal(result.sections.length, 2);
  assert.equal(result.sections[0].date, "10/05 월요일");
  assert.deepEqual(result.sections[0].items, ["쌀밥", "미역국", "김치"]);
  assert.equal(result.sections[1].date, "10/06 화요일");
  assert.deepEqual(result.sections[1].items, ["계란국", "두부조림"]);
  assert.doesNotMatch(result.sections.map((section) => section.text).join("\n"), /돈가스|우동/);
  assert.throws(() => parseBreakfast({ title: "학생식당", text: "일반 메뉴", tables: [{ rows: [["조식", "토스트"]] }] }));
});

test("breakfast date rows select only the breakfast column and retain menu line breaks", () => {
  const result = parseBreakfast({ title: "식단", text: "천원의 아침밥", tables: [{ rows: [
    ["날짜", "천원의 아침밥", "중식"],
    ["2026.10.06(화)", "흰밥\n된장국\n깍두기", "돈가스"],
    ["2026.10.07(수)", "잡곡밥 · 소고기국 · 배추김치", "우동"]
  ] }] });
  assert.equal(result.sections[0].date, "2026.10.06(화)");
  assert.deepEqual(result.sections[0].items, ["흰밥", "된장국", "깍두기"]);
  assert.deepEqual(result.sections[1].items, ["잡곡밥", "소고기국", "배추김치"]);
});

test("missing food dates never use today's date and allergy codes remain in the menu", () => {
  const result = parseBreakfast({ title: "학생식당", text: "천원의 아침밥", tables: [{ rows: [
    ["천원의 아침밥", "미역국(1.5.6)\n쌀밥"]
  ] }] });
  assert.equal(result.sections[0].date, null);
  assert.deepEqual(result.sections[0].items, ["미역국(1.5.6)", "쌀밥"]);
});

test("dedicated daily menu tables retain the first date row", () => {
  const result = parseBreakfast({ title: "천원의 아침밥", tables: [{ rows: [
    ["2026.10.06(화)", "쌀밥\n국"], ["2026.10.07(수)", "잡곡밥\n계란국"]
  ] }] });
  assert.equal(result.sections.length, 2);
  assert.equal(result.sections[0].date, "2026.10.06(화)");
});

test("weekday-first school headers map menus to dates and a separate 1000 price is excluded", () => {
  const result = parseBreakfast({ title: "학생식당", text: "천원의 아침밥", tables: [{ rows: [
    ["구분", "가격", "월요일 (10.05.)", "화요일 (10.06.)"],
    ["천원의 아침밥", "1000", "쌀밥\n미역국", "잡곡밥\n계란국\n배추김치"]
  ] }] });
  assert.equal(result.sections.length, 2);
  assert.equal(result.sections[1].date, "화요일 (10.06.)");
  assert.deepEqual(result.sections[1].items, ["잡곡밥", "계란국", "배추김치"]);
  assert.doesNotMatch(JSON.stringify(result), /1000/);
});

test("all weekly dates, repeated day blocks and empty menu days are retained", () => {
  const dates = ["월요일 (10.05.)", "화요일 (10.06.)", "수요일 (10.07.)", "목요일 (10.08.)", "금요일 (10.09.)"];
  const weekly = parseBreakfast({ title: "학생식당", text: "천원의 아침밥", tables: [{ rows: [
    ["구분", ...dates], ["천원의 아침밥", "월 메뉴", "화 메뉴", "수 메뉴", "목 메뉴", ""]
  ] }] });
  assert.deepEqual(weekly.sections.map((section) => section.date), dates);
  assert.deepEqual(weekly.sections[4].items, []);
  const repeated = parseBreakfast({ title: "학생식당", text: "천원의 아침밥", tables: [{ rows: dates.flatMap((date, index) => [
    [date, date, date], ["천원의 아침밥", "1000", `메뉴 ${index}`], ["중식", "5000", "점심"]
  ]) }] });
  assert.deepEqual(repeated.sections.map((section) => section.date), dates);
  assert.deepEqual(repeated.sections.map((section) => section.items), dates.map((_date, index) => [`메뉴 ${index}`]));
  const dailyRows = parseBreakfast({ title: "학생식당", text: "천원의 아침밥", tables: [{ rows: dates.map((date, index) => [date, "천원의 아침밥", `메뉴 ${index}`]) }] });
  assert.deepEqual(dailyRows.sections.map((section) => section.date), dates);
});

test("all common 1000-won price labels are removed without removing dish names", () => {
  assert.deepEqual(menuLines("1000\n1,000\n1000원\n1,000 원\n가격: 1000\n₩1,000\n쌀밥\n국(1,5,6)"), ["쌀밥", "국(1,5,6)"]);
});

test("duplicate date labels and selected calendar values provide the meal date", () => {
  assert.equal(mealDate("화요일 (10.06.) 화요일 (10.06.)"), "화요일 (10.06.)");
  const result = parseBreakfast({ title: "학생식당", text: "천원의 아침밥", dateCandidates: ["20261006"], tables: [{ rows: [["천원의 아침밥", "1000", "쌀밥\n국"]] }] });
  assert.equal(result.sections[0].date, "2026.10.06");
  assert.deepEqual(result.sections[0].items, ["쌀밥", "국"]);
});

test("four notice boards have independent source keys and the user-provided URLs", () => {
  assert.equal(Object.keys(NOTICE_BOARDS).length, 4);
  const keys = Object.keys(NOTICE_BOARDS).map(noticeKey);
  assert.equal(new Set(keys).size, 4);
  for (const key of keys) { assert.equal(isSourceKey(key), true); assert.equal(featureForKey(key), "notices"); }
  assert.equal(noticeDefaultUrl(noticeKey("dataScience")), "https://datascience.inha.ac.kr/datascience/3125/subview.do");
  assert.equal(noticeDefaultUrl(noticeKey("computer")), "https://cse.inha.ac.kr/cse/888/subview.do");
  assert.equal(noticeDefaultUrl(noticeKey("sw")), "https://swuniv.inha.ac.kr/swuniv/12703/subview.do");
  assert.equal(isSourceKey("notices:unknown"), false);
  assert.throws(() => noticeKey("unknown"));
});

test("image-only or unavailable breakfasts do not produce invented menus", () => {
  assert.throws(() => parseBreakfast({ title: "학생식당", text: "", tables: [] }));
});

test("encoded K2Web article links are recognised without executing their contents", () => {
  const encoded = btoa("fnct1|@@|" + encodeURIComponent("/bbs/kr/8/123/artclView.do?page=1"));
  const result = parseNotices({ url: "https://www.inha.ac.kr/kr/950/subview.do", links: [
    { href: "?enc=" + encoded, text: "인하공지 검증용 제목", context: "2026.10.06" }
  ] });
  assert.equal(result.items.length, 1);
});

test("damaged cache records cannot crash the panel or inject unsafe links", () => {
  const record = { feature: "notices", sourceUrl: "https://www.inha.ac.kr/kr/950/subview.do", method: "fetch", fetchedAt: new Date().toISOString(), data: { items: [null] } };
  assert.equal(validStoredResult("notices", record), false);
  record.data.items = [{ title: "bad link", url: "javascript:alert(1)" }];
  assert.equal(validStoredResult("notices", record), false);
});

test("cache freshness rejects old breakfast schemas, invalid and future timestamps", () => {
  const now = Date.parse("2026-10-06T08:00:00Z");
  assert.equal(isStale({ feature: "breakfast", data: { schemaVersion: 2 }, fetchedAt: "2026-10-06T07:58:59Z" }, now), true);
  assert.equal(isStale({ feature: "breakfast", data: { schemaVersion: 3 }, fetchedAt: "2026-10-06T07:58:59Z" }, now), false);
  assert.equal(isStale({ feature: "notices", fetchedAt: "2026-10-06T07:58:59Z" }, now), false);
  assert.equal(isStale({ fetchedAt: "broken" }, now), true);
  assert.equal(isStale({ fetchedAt: "2027-01-01" }, now), true);
});

test("network transport makes read-only credential-free requests and refuses redirects", async () => {
  let options;
  const result = await fetchOfficialPage("https://www.inha.ac.kr/kr/1072/subview.do", "breakfast", async (_url, opts) => {
    options = opts; return new Response("<html>식단</html>", { headers: { "content-type": "text/html; charset=utf-8" } });
  });
  assert.equal(options.method, "GET");
  assert.equal(options.credentials, "omit");
  assert.equal(options.redirect, "error");
  assert.match(result.html, /식단/);
});

test("network failures distinguish authentication, invalid formats and oversized payloads", async () => {
  const url = "https://www.inha.ac.kr/kr/1072/subview.do";
  await assert.rejects(fetchOfficialPage(url, "breakfast", async () => new Response("", { status: 403 })), { code: "LOGIN" });
  await assert.rejects(fetchOfficialPage(url, "breakfast", async () => new Response("{}", { headers: { "content-type": "application/json" } })), { code: "FORMAT" });
  await assert.rejects(fetchOfficialPage(url, "breakfast", async () => new Response("x".repeat(2_000_001), { headers: { "content-type": "text/html" } })), { code: "SIZE" });
  await assert.rejects(fetchOfficialPage("https://evil.test/", "breakfast", async () => assert.fail("must not fetch")), { code: "URL" });
});
