// 수강 중인 강의의 시험 일정. date는 한국 시간 기준 "YYYY-MM-DD", 나머지 항목은 비워 둬도 돼요.
// gap: 다음 시험까지 여유가 있으면 "free"(초록 구분선), 없으면 "tight"(빨간 구분선).
export const EXAMS = [
  { course: "회귀분석", date: "2026-10-20", time: "10:30~11:45", place: "5남332", note: "계산기 지참 · 흑색 볼펜", gap: "tight" },
  { course: "데이터베이스", date: "2026-10-20", time: "15:00", place: "5남332", gap: "free" },
  { course: "객체지향프로그래밍 2", date: "2026-10-21", time: "11:00~12:45", place: "하-332", gap: "free" },
  { course: "논리회로", date: "2026-10-22", time: "18:00~19:15", place: "하-220", gap: "tight" },
  { course: "인터넷프로그래밍", date: "2026-10-23", time: "09:00", place: "60주년-907", gap: "free" },
  { course: "회계원론", date: "2026-10-30", time: "13:30~14:30", place: "6-521" },
];

function koreanToday(now) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type) => Number(parts.find((item) => item.type === type).value);
  return Date.UTC(part("year"), part("month") - 1, part("day"));
}

// Exams from today on, soonest first, each with its D-day in Korean calendar days.
export function upcomingExams(exams = EXAMS, now = new Date()) {
  const today = koreanToday(now);
  return exams.flatMap((exam) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(exam.date || "");
    if (!match) return [];
    const days = Math.round((Date.UTC(+match[1], +match[2] - 1, +match[3]) - today) / 86_400_000);
    return days < 0 ? [] : [{ ...exam, days }];
  }).sort((a, b) => a.days - b.days || String(a.time || "").localeCompare(String(b.time || "")));
}

export function dDayLabel(days) { return days === 0 ? "D-DAY" : `D-${days}`; }
