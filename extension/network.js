import { officialUrl, DataError } from "./core.js";

export async function fetchOfficialPage(url, feature, fetcher = fetch) {
  url = officialUrl(url, feature);
  const response = await fetcher(url, {
    method: "GET", credentials: "omit", redirect: "error", cache: "no-store",
    signal: AbortSignal.timeout(15_000)
  });
  if (response.status === 401 || response.status === 403) throw new DataError("LOGIN", "직접 조회가 제한됐어요. 학교 페이지를 열고 필요하면 로그인한 뒤 ‘열린 페이지 읽기’를 사용해 주세요.");
  if (!response.ok) throw new DataError("HTTP", `학교 서버에서 응답하지 못했어요 (HTTP ${response.status}). 잠시 후 다시 시도해 주세요.`);
  const type = response.headers.get("content-type") || "";
  if (!/text\/html|application\/xhtml\+xml/i.test(type)) throw new DataError("FORMAT", "HTML 페이지 주소가 필요해요. 이미지·PDF·파일 다운로드 주소는 지원하지 않아요.");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2_000_000) throw new DataError("SIZE", "페이지가 너무 커서 가져오지 못했어요. 해당 정보의 상세 페이지를 연결해 주세요.");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const head = new TextDecoder().decode(bytes.slice(0, 4096));
  const charset = `${type} ${head}`.match(/charset\s*=\s*["']?\s*([\w-]+)/i)?.[1] || "utf-8";
  let decoder;
  try { decoder = new TextDecoder(charset); } catch { decoder = new TextDecoder("utf-8"); }
  return { html: decoder.decode(bytes), url, fetchedAt: new Date().toISOString() };
}
