export const NOTICE_BOARDS = {
  general: { label: "공지사항", url: "https://www.inha.ac.kr/kr/950/subview.do" },
  dataScience: { label: "데이터사이언스학과 게시판", url: "https://datascience.inha.ac.kr/datascience/3125/subview.do" },
  computer: { label: "컴퓨터공학과 게시판", url: "https://cse.inha.ac.kr/cse/888/subview.do" },
  sw: { label: "SW융합대학사업단 게시판", url: "https://swuniv.inha.ac.kr/swuniv/12703/subview.do" }
};

export function noticeKey(board) {
  if (!Object.hasOwn(NOTICE_BOARDS, board)) throw new Error("지원하지 않는 게시판이에요.");
  return board === "general" ? "notices" : "notices:" + board;
}
export function featureForKey(key) { return key.startsWith("notices:") ? "notices" : key; }
export function isSourceKey(key) {
  return ["breakfast", "seats", ...Object.keys(NOTICE_BOARDS).map(noticeKey)].includes(key);
}
export function noticeDefaultUrl(key) {
  const board = key === "notices" ? "general" : key.slice("notices:".length);
  return NOTICE_BOARDS[board]?.url || "";
}
