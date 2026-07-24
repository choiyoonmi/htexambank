// netlify/functions/generate.js
// 2단계: 분석 프로파일 + 범위를 근거로 한 섹션(어법/독해/어휘/의사소통/서술형)의 문항을 생성한다.
const MODEL = process.env.MODEL || "claude-sonnet-5";
const API = "https://api.anthropic.com/v1/messages";

// ===== 지침(시스템 프롬프트) : 종합판 v2.0 + 품질기준 §15 요약 =====
const GUIDELINE = `너는 대한민국 중·고 영어 내신 '적중 예상문제' 출제 전문가다. 아래 지침을 반드시 지킨다.

[핵심 원칙]
- 유형·형식·난이도·함정은 그 학교(기출 프로파일)를 그대로 미러링한다.
- 문법·어휘·지문 소재는 반드시 '시험범위'에서만 뽑는다(범위 밖 창작 금지).
- 제공된 본문(passage)이 있으면 독해·어법 문항은 그 본문을 근거로 만든다.

[문항 유형 총목록] 내용일치/불일치, 주제·제목·요지, 목적, 빈칸(어휘/구/절/연결어), 무관한 문장, 문장삽입, 순서배열, 지칭·함의추론, 요약문(A)(B), 도표/실용문, 답할수있는질문(보기 ㄱㄴㄷ 조합), 어법(밑줄 틀린것/옳은것만 고르기/옳은 개수/네모 A·B·C 선택형), 어휘 적절성, 영영풀이(단어↔정의/틀린정의/미사용어), 대화(응답·순서배열·빈칸·추론).

[품질·난이도 기준 — 매우 중요]
1) 서술형은 절대 단순하게 내지 않는다. 반드시 아래 형식을 섞는다:
   - 다중 조건형(목표구문 강제 + 주어진 단어 어형변화 + 단어 추가 + 단어수 제한)
   - 표형식 오류수정(<보기> 5~6문장 중 틀린 것 2개 찾아 기호+옳은 문장)
   - 문장 전환·결합(두 문장→관계사(주격/목적격 구분), 능동↔수동, 직설↔used to, 관계사 생략)
   - 대화/본문 속 우리말 밑줄 영작
2) 어법은 '본문 기반 + 미세 함정'. 한 끗 차이 함정(that/which/who, used to vs be used to, 목적격 생략, where↔that, 부사↔형용사, by+동명사↔to부정사). 신유형(옳은 개수 세기, 네모 선택형) 포함.
3) 독해 오답은 '부분 진실 + 왜곡'. 누가 봐도 틀린 오답 금지. 유형 다양화(고난도 빈칸, 함의, 밑줄 영영풀이, 보기조합, 요약문).
4) 정답은 반드시 유일하고 명확해야 한다.

[출력 형식] 순수 JSON 배열만 출력한다(마크다운·설명 금지). 각 원소:
{
 "n": 문항번호(정수),
 "sec": "어법|독해|어휘|의사소통|서술형",
 "stem": "발문(문항 번호 포함, 한국어 지시문)",
 "box": ["지문/보기/조건을 넣는 박스의 각 줄", "없으면 생략"],
 "ch": ["① ...","② ...","③ ...","④ ...","⑤ ..."],   // 서술형은 [] (빈 배열)
 "ans": "정답(객관식은 번호, 서술형은 모범답안 문장)",
 "sol": "간단한 해설",
 "tag": "[문법/유형][예상확률 상/중/하]"
}
영어 문장은 문법적으로 정확해야 하며, 원(①②③) 및 밑줄기호(ⓐⓑⓒⓓⓔ)를 사용한다.`;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return resp(405, { error: "POST only" });
  if (!process.env.ANTHROPIC_API_KEY) return resp(500, { error: "ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다." });
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return resp(400, { error: "잘못된 요청(JSON)" }); }
  const { profile = {}, section, count, startNum = 1, school = "", grade = "" } = body;
  if (!section || !count) return resp(400, { error: "section, count 필요" });

  const user =
    "학교: " + school + " / 학년: " + grade + "\n" +
    "[기출 유형 프로파일]\n" + (profile.typeProfile || "") + "\n" +
    "[서술형 재현 지침]\n" + (profile.seomulHint || "") + "\n" +
    "[목표문법]\n" + (profile.grammarPoints || []).join(", ") + "\n" +
    "[의사소통기능]\n" + (profile.functions || []).join(", ") + "\n" +
    "[핵심어휘]\n" + (profile.vocab || []).join(", ") + "\n" +
    "[본문 passage]\n" + (profile.passage || "(제공된 본문 없음)") + "\n\n" +
    "위 정보를 근거로 '" + section + "' 영역 문항을 정확히 " + count + "개 생성하라.\n" +
    "문항 번호는 " + startNum + "번부터 시작한다.\n" +
    (section === "독해" ? "독해는 반드시 위 본문(passage)을 근거로 만든다. 첫 문항 앞에 본문을 다시 싣지 말고 발문에 '윗글'로 참조한다.\n" : "") +
    (section === "서술형" ? "서술형은 품질기준의 형식(다중조건/표형식 오류수정/문장전환·결합)을 반드시 섞어 고난도로 만든다.\n" : "") +
    "순수 JSON 배열만 출력하라.";

  try {
    const text = await callClaude({ system: GUIDELINE, content: [{ type: "text", text: user }], max_tokens: 8000 });
    const arr = extractJSONArray(text);
    return resp(200, { questions: arr });
  } catch (e) {
    return resp(502, { error: "생성 실패(" + section + "): " + (e.message || String(e)) });
  }
};

async function callClaude({ system, content, max_tokens }) {
  const r = await fetch(API, {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, max_tokens, system, messages: [{ role: "user", content }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ? j.error.message : ("API " + r.status));
  return (j.content || []).map((c) => c.text || "").join("");
}
function extractJSONArray(text) {
  let t = String(text).trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  const s = t.indexOf("["), e = t.lastIndexOf("]");
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  return JSON.parse(t);
}
function resp(code, obj) {
  return { statusCode: code, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: JSON.stringify(obj) };
}
