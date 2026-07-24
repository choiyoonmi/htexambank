// netlify/functions/analyze.js
// 1단계: 업로드된 기출 PDF/이미지 + 시험범위를 읽어 '학교 유형 프로파일'을 뽑는다.
const MODEL = process.env.MODEL || "claude-sonnet-5";
const API = "https://api.anthropic.com/v1/messages";

const SYSTEM = `너는 대한민국 중·고 영어 내신 기출 분석 전문가다.
업로드된 '기출 시험지'(스캔 이미지/PDF일 수 있음)와 '시험범위 자료'를 읽고,
그 학교/교사의 출제 패턴을 분석해 아래 JSON 스키마로만 답한다. 마크다운·설명 금지, 순수 JSON만 출력.

분석 원칙:
- 유형·형식·난이도·함정·서술형 형식은 그 학교의 고유 특성이므로 반드시 포착한다.
- 특히 서술형의 '형식'(다중조건 영작 / 표형식 어법수정 / 문장전환·결합 / 배열영작 등)을 구체적으로 기록한다.
- 시험범위(본문/문법/의사소통/부교재)에서 목표문법·핵심어휘·의사소통기능·본문을 추출한다.

JSON 스키마:
{
 "typeProfile": "선택형 유형 분포와 서술형 형식, 함정 패턴을 한국어로 6~10문장 요약",
 "sectionMix": {"어법":0,"독해":0,"어휘":0,"의사소통":0,"서술형":0},
 "grammarPoints": ["목표문법1","목표문법2"],
 "functions": ["의사소통기능1","의사소통기능2"],
 "vocab": ["핵심어휘1","핵심어휘2"],
 "passage": "시험범위 본문(영어 원문). 여러 개면 이어붙임. 없으면 빈 문자열",
 "seomulHint": "이 학교 서술형을 재현하기 위한 구체 지침(형식·조건 스타일)"
}`;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return resp(405, { error: "POST only" });
  if (!process.env.ANTHROPIC_API_KEY) return resp(500, { error: "ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다." });
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return resp(400, { error: "잘못된 요청(JSON)" }); }
  const { school = "", grade = "", scopeText = "", gichul = [], scopeFiles = [] } = body;

  const content = [];
  content.push({ type: "text", text:
    "학교: " + school + "\n학년: " + grade + "\n\n[시험범위 텍스트]\n" + (scopeText || "(텍스트 없음, 첨부 파일 참고)") +
    "\n\n아래에 기출 시험지와 범위 자료(이미지/PDF)를 첨부한다. 분석해 JSON으로만 답하라." });
  for (const f of gichul) content.push(fileBlock(f, "[기출 시험지]"));
  for (const f of scopeFiles) content.push(fileBlock(f, "[시험범위 자료]"));

  try {
    const text = await callClaude({ system: SYSTEM, content, max_tokens: 3000 });
    return resp(200, extractJSON(text));
  } catch (e) {
    return resp(502, { error: "분석 실패: " + (e.message || String(e)) });
  }
};

function fileBlock(f, label) {
  const mt = f.mediaType || "";
  if (mt === "application/pdf")
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: f.data } };
  if (mt.indexOf("image/") === 0)
    return { type: "image", source: { type: "base64", media_type: mt, data: f.data } };
  return { type: "text", text: label + "\n" + safeDecode(f.data) };
}
function safeDecode(b64) { try { return Buffer.from(b64, "base64").toString("utf8"); } catch { return ""; } }

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
function extractJSON(text) {
  let t = String(text).trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  return JSON.parse(t);
}
function resp(code, obj) {
  return { statusCode: code, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: JSON.stringify(obj) };
}
