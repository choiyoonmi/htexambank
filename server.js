// server.js — Render(계속 켜져 있는 서버). Netlify 함수와 동일 경로를 제공하므로 index.html 수정 불필요.
const express = require("express");
const path = require("path");
const app = express();

const MODEL = process.env.MODEL || "claude-sonnet-5";
const API = "https://api.anthropic.com/v1/messages";

app.use(express.json({ limit: "35mb" }));
app.use(express.static(__dirname)); // index.html 등 정적 파일 제공

// ---------- 공통 ----------
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
function extractObj(text) {
  let t = String(text).trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  return JSON.parse(t);
}
function extractArr(text) {
  let t = String(text).trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  const s = t.indexOf("["), e = t.lastIndexOf("]");
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  return JSON.parse(t);
}
function fileBlock(f) {
  const mt = f.mediaType || "";
  if (mt === "application/pdf")
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: f.data } };
  if (mt.indexOf("image/") === 0)
    return { type: "image", source: { type: "base64", media_type: mt, data: f.data } };
  try { return { type: "text", text: Buffer.from(f.data, "base64").toString("utf8") }; } catch { return { type: "text", text: "" }; }
}

// ---------- 1) 분석 ----------
const ANALYZE_SYSTEM = `너는 대한민국 중·고 영어 내신 기출 분석 전문가다.
업로드된 '기출 시험지'(스캔 이미지/PDF일 수 있음)와 '시험범위 자료'를 읽고,
그 학교/교사의 출제 패턴을 분석해 아래 JSON 스키마로만 답한다. 마크다운·설명 금지, 순수 JSON만 출력.

분석 원칙:
- 유형·형식·난이도·함정·서술형 형식은 그 학교의 고유 특성이므로 반드시 포착한다.
- 특히 서술형의 '형식'(다중조건 영작 / 표형식 어법수정 / 문장전환·결합 / 배열영작 등)을 구체적으로 기록한다.
- 시험범위(본문/문법/의사소통/부교재)에서 목표문법·핵심어휘·의사소통기능·본문을 추출한다.

JSON 스키마:
{
 "typeProfile": "선택형 유형 분포와 서술형 형식, 함정 패턴을 한국어로 6~10문장 요약",
 "grammarPoints": ["목표문법1","목표문법2"],
 "functions": ["의사소통기능1","의사소통기능2"],
 "vocab": ["핵심어휘1","핵심어휘2"],
 "passage": "시험범위 본문(영어 원문). 여러 개면 이어붙임. 없으면 빈 문자열",
 "seomulHint": "이 학교 서술형을 재현하기 위한 구체 지침(형식·조건 스타일)"
}`;

app.post("/.netlify/functions/analyze", async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY가 설정되지 않았습니다." });
    const { school = "", grade = "", scopeText = "", gichul = [], scopeFiles = [] } = req.body || {};
    const content = [{ type: "text", text:
      "학교: " + school + "\n학년: " + grade + "\n\n[시험범위 텍스트]\n" + (scopeText || "(텍스트 없음, 첨부 파일 참고)") +
      "\n\n아래에 기출 시험지와 범위 자료(이미지/PDF)를 첨부한다. 분석해 JSON으로만 답하라." }];
    for (const f of gichul) content.push(fileBlock(f));
    for (const f of scopeFiles) content.push(fileBlock(f));
    const text = await callClaude({ system: ANALYZE_SYSTEM, content, max_tokens: 8000 });
    res.json(extractObj(text));
  } catch (e) {
    res.status(502).json({ error: "분석 실패: " + (e.message || String(e)) });
  }
});

// ---------- 2) 생성 ----------
const GEN_GUIDELINE = `너는 대한민국 중·고 영어 내신 '적중 예상문제' 출제 전문가다. 아래 지침을 반드시 지킨다.

[핵심 원칙]
- 유형·형식·난이도·함정은 그 학교(기출 프로파일)를 그대로 미러링한다.
- 문법·어휘·지문 소재는 반드시 '시험범위'에서만 뽑는다(범위 밖 창작 금지).
- 제공된 본문(passage)이 있으면 독해·어법 문항은 그 본문을 근거로 만든다.

[문항 유형 총목록] 내용일치/불일치, 주제·제목·요지, 목적, 빈칸(어휘/구/절/연결어), 무관한 문장, 문장삽입, 순서배열, 지칭·함의추론, 요약문(A)(B), 답할수있는질문(보기 ㄱㄴㄷ 조합), 어법(밑줄 틀린것/옳은것만 고르기/옳은 개수/네모 A·B·C 선택형), 어휘 적절성, 영영풀이(단어↔정의/틀린정의/미사용어), 대화(응답·순서배열·빈칸·추론).

[품질·난이도 기준 — 매우 중요]
1) 서술형은 절대 단순하게 내지 않는다. 다음 형식을 섞는다: 다중 조건형(목표구문 강제+주어진 단어 어형변화+단어 추가+단어수 제한) / 표형식 오류수정(<보기> 5~6문장 중 틀린 것 2개 찾아 기호+옳은 문장) / 문장 전환·결합(두 문장→관계사(주격·목적격 구분), 능동↔수동, 직설↔used to, 관계사 생략) / 대화·본문 속 우리말 밑줄 영작.
2) 어법은 '본문 기반 + 미세 함정'. 신유형(옳은 개수 세기, 네모 선택형) 포함.
3) 독해 오답은 '부분 진실 + 왜곡'. 누가 봐도 틀린 오답 금지.
4) 정답은 반드시 유일하고 명확해야 한다.

[출력 형식] 순수 JSON 배열만 출력(마크다운·설명 금지). 각 원소:
{"n":정수,"sec":"어법|독해|어휘|의사소통|서술형","stem":"발문(번호 포함)","box":["지문/보기/조건 줄들, 없으면 생략"],"ch":["① ...","..."],"ans":"객관식은 번호/서술형은 모범답안","sol":"해설","tag":"[문법/유형][예상확률]"}
영어 문장은 문법적으로 정확해야 하며 ①②③, ⓐⓑⓒⓓⓔ 기호를 사용한다.`;

app.post("/.netlify/functions/generate", async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY가 설정되지 않았습니다." });
    const { profile = {}, section, count, startNum = 1, school = "", grade = "" } = req.body || {};
    if (!section || !count) return res.status(400).json({ error: "section, count 필요" });
    const user =
      "학교: " + school + " / 학년: " + grade + "\n" +
      "[기출 유형 프로파일]\n" + (profile.typeProfile || "") + "\n" +
      "[서술형 재현 지침]\n" + (profile.seomulHint || "") + "\n" +
      "[목표문법]\n" + (profile.grammarPoints || []).join(", ") + "\n" +
      "[의사소통기능]\n" + (profile.functions || []).join(", ") + "\n" +
      "[핵심어휘]\n" + (profile.vocab || []).join(", ") + "\n" +
      "[본문 passage]\n" + (profile.passage || "(제공된 본문 없음)") + "\n\n" +
      "위 정보를 근거로 '" + section + "' 영역 문항을 정확히 " + count + "개 생성하라. 번호는 " + startNum + "번부터.\n" +
      (section === "독해" ? "독해는 위 본문(passage)을 근거로 만들고 발문에 '윗글'로 참조한다.\n" : "") +
      (section === "서술형" ? "서술형은 품질기준의 형식(다중조건/표형식 오류수정/문장전환·결합)을 반드시 섞어 고난도로 만든다.\n" : "") +
      "순수 JSON 배열만 출력하라.";
    const text = await callClaude({ system: GEN_GUIDELINE, content: [{ type: "text", text: user }], max_tokens: 8000 });
    res.json({ questions: extractArr(text) });
  } catch (e) {
    res.status(502).json({ error: "생성 실패(" + (req.body && req.body.section) + "): " + (e.message || String(e)) });
  }
});

app.get("/healthz", (req, res) => res.send("ok"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("server on " + PORT));
