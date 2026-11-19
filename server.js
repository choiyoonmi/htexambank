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
 "topics": ["시험범위 단원별 본문 주제·소재를 한 줄씩(예: '7과 세계의 계절 축제 — 홀리·송크란'). 범위 자료가 없으면 단원 이름에서 짐작하지 말고 빈 배열"],
 "passage": "시험범위의 핵심 Reading 본문만 간결히(최대 500단어). 교재 전체·문제·해설을 옮기지 말 것. 없으면 빈 문자열",
 "seomulHint": "이 학교 서술형을 재현하기 위한 구체 지침(형식·조건 스타일)"
}`;

app.post("/.netlify/functions/analyze", async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY가 설정되지 않았습니다." });
    const { school = "", grade = "", scopeText = "", gichul = [], scopeFiles = [], examName = "", scopeUnits = "" } = req.body || {};
    const content = [{ type: "text", text:
      "학교: " + school + "\n학년: " + grade + "\n이번 시험: " + (examName || "-") + " / 범위 단원: " + (scopeUnits || "-") +
      "\n※ 기출 시험지는 '지난 시험'이다. 기출의 본문·소재는 유형 분석에만 쓰고, grammarPoints·functions·vocab·topics·passage 는 반드시 '이번 시험 범위' 자료에서만 뽑는다." +
      "\n\n[시험범위 텍스트]\n" + (scopeText || "(텍스트 없음, 첨부 파일 참고)") +
      "\n\n아래에 기출 시험지와 범위 자료(이미지/PDF)를 첨부한다. 분석해 JSON으로만 답하라." }];
    for (const f of gichul) content.push(fileBlock(f));
    for (const f of scopeFiles) content.push(fileBlock(f));
    let profileObj;
    for (let i = 0; i < 3; i++) {
      try { const text = await callClaude({ system: ANALYZE_SYSTEM, content, max_tokens: 8000 }); profileObj = extractObj(text); break; }
      catch (err) { if (i === 2) throw err; }
    }
    res.json(profileObj);
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
영어 문장은 문법적으로 정확해야 하며 ①②③, ⓐⓑⓒⓓⓔ 기호를 사용한다.
매우 중요(JSON 규칙): 반드시 문법적으로 유효한 JSON만 출력한다. 문자열 값 안에서는 큰따옴표(") 대신 작은따옴표(') 또는 홑화살괄호(〈 〉)를 사용하고, 값 안에 줄바꿈을 넣지 않는다.`;

// 외부지문(11/18): 교과서에 없는 '처음 보는 글'을 그 학교 선생님 방식으로 직접 써서 출제
const EXT_GUIDE = `[외부지문 영역 — 위 '범위 밖 창작 금지'의 예외]
- 이 영역은 교과서 본문을 쓰지 않는다. 선생님이 직접 쓴 것 같은 '처음 보는 글'을 새로 써서 출제한다.
- 글감은 반드시 [이번 시험 범위]의 단원 주제(topics)·본문에서 뻗어 나간 것이다: 같은 주제의 다른 인물·사례·배경지식 글, 또는 이번 본문 내용을 대화문·일기·안내문으로 바꾼 변형.
- 아래 [이 학교 외부지문 기출 패턴]은 '지난 시험'의 기록이다. 유형·형식·배점·출제 방식(예: 단원 주제 연계, 자작 글)만 참고하고, 거기 적힌 소재·인물·이야기(메모)는 절대 다시 쓰지 않는다.
- 아래 [이 묶음에 쓸 소재]가 주어지면 지문마다 그 소재를 순서대로 하나씩 쓴다.
- 아래 [이 묶음에 쓸 지문 — 학교 부교재 원문]이 주어지면 새 글을 쓰지 말고 그 원문을 지문으로 그대로 싣는다(문항에 필요한 밑줄·기호·빈칸·(A) 우리말 박스 표시만 넣는다). 이 경우 위 글감·길이 규칙은 따르지 않는다.
- 길이 110~170단어, 해당 학년 수준. 목표문법을 자연스럽게 2~3곳 넣는다(어법 문항의 근거).
- 지문 1개당 정확히 2문항. 첫 문항의 box 첫 줄에 '[지문 X]'처럼 이름을 붙이고 지문 전체를 싣는다. 둘째 문항은 box 없이 발문을 '번호. [지문 X] 윗글의 ...'로 쓴다. 지문 이름 글자는 아래에서 정해 준 것만 쓴다.
- 모든 발문(stem)은 반드시 문항 번호로 시작한다(예: '22. [지문 C] 다음 글을 읽고, ...').
- 문항 유형 비율은 학교 패턴을 따른다(예: 주제·목적, 빈칸, 어법(밑줄 ⓐ~ⓔ 또는 (A)(B)(C) 네모), 내용일치, 함축 의미). 패턴에 서술형이 있으면 둘째 문항을 지문 속 우리말 밑줄 영작(제시어·조건)으로 낸다.
- sec 값은 "외부지문". tag에 '[외부지문/유형][소재]'를 적는다.`;

app.post("/.netlify/functions/generate", async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY가 설정되지 않았습니다." });
    const { profile = {}, section, count, startNum = 1, school = "", grade = "", extPattern = "", examName = "", scopeUnits = "", extFiles = [] } = req.body || {};
    if (!section || !count) return res.status(400).json({ error: "section, count 필요" });
    const isExt = section === "외부지문";
    const CHUNK = isExt ? 4 : 5;   // 외부지문은 지문 1개에 2문항이라 짝수 묶음
    // 외부지문(11/19): 묶음들이 동시에 돌아 같은 소재를 겹쳐 쓰던 것 → 먼저 이번 범위 주제로 서로 다른 소재를 한 번에 정해 나눠 준다
    let extTopics = [], extPass = [];
    // 학교 부교재가 올라오면(11/19 대천중) 거기서 지문 N개를 원문 그대로 골라 묶음마다 나눠 준다 — 파일은 이 한 번만 보냄
    if (isExt && extFiles.length) {
      const need = Math.ceil(count / 2);
      const content = [{ type: "text", text:
        "이번 시험: " + (examName || "-") + " / 범위 단원: " + (scopeUnits || "-") + "\n[단원 주제]\n" + (profile.topics || []).join("\n") +
        "\n\n첨부는 학교가 나눠 준 외부지문 부교재다. 이번 시험 범위에 맞는 읽기 지문을 서로 다른 것으로 정확히 " + need + "개 골라, 영어 원문을 한 글자도 바꾸지 말고 옮겨라(문제·해설·번호는 빼고 지문만). 지문이 " + need + "개보다 적으면 있는 만큼만." +
        " 출력은 JSON 배열만: [{\"title\":\"부교재 속 제목이나 첫 몇 단어\",\"text\":\"지문 원문(줄바꿈 없이, 큰따옴표는 작은따옴표로)\"}]" }];
      for (const f of extFiles) content.push(fileBlock(f));
      for (let i = 0; i < 2 && !extPass.length; i++) {
        try { extPass = extractArr(await callClaude({ system: "너는 문서에서 영어 지문을 정확히 옮겨 적는 조교다. 순수 JSON 배열만 출력한다.", max_tokens: 8000, content }))
          .filter(p => p && p.text).slice(0, need); } catch (e) {}
      }
    }
    if (isExt && !extPass.length) {
      const need = Math.ceil(count / 2);
      try {
        const t = await callClaude({ system: "너는 중학교 영어 내신 출제 교사다. 순수 JSON 문자열 배열만 출력한다.", max_tokens: 1200, content: [{ type: "text", text:
          "이번 시험: " + (examName || "-") + " / 범위 단원: " + (scopeUnits || "-") + "\n[단원 주제]\n" + (profile.topics || []).join("\n") +
          "\n[본문 요약]\n" + String(profile.passage || "").slice(0, 1500) +
          "\n[지난 시험 외부지문 — 이 소재는 쓰지 말 것]\n" + (extPattern || "-") +
          "\n\n위 '이번 범위' 단원 주제에서 뻗어 나간, 서로 겹치지 않는 외부지문 소재를 정확히 " + need + "개 정하라. 단원마다 고르게 나누고, 교과서 본문과 같은 이야기·지난 시험 소재는 피한다. 각 원소는 '단원 · 소재 한 줄(한국어)' 형식. JSON 배열만." }] });
        extTopics = extractArr(t).map(String).slice(0, need);
      } catch (e) { extTopics = []; }
    }
    const LET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const buildUser = (c, sn, j) =>
      "학교: " + school + " / 학년: " + grade + "\n" +
      "[이번 시험 범위] 시험: " + (examName || "-") + " / 단원: " + (scopeUnits || "-") + "\n" +
      "[단원 주제]\n" + ((profile.topics || []).join("\n") || "(없음)") + "\n" +
      "[기출 유형 프로파일]\n" + (profile.typeProfile || "") + "\n" +
      "[서술형 재현 지침]\n" + (profile.seomulHint || "") + "\n" +
      "[목표문법]\n" + (profile.grammarPoints || []).join(", ") + "\n" +
      "[의사소통기능]\n" + (profile.functions || []).join(", ") + "\n" +
      "[핵심어휘]\n" + (profile.vocab || []).join(", ") + "\n" +
      "[본문 passage]\n" + (profile.passage || "(제공된 본문 없음)") + "\n\n" +
      "위 정보를 근거로 '" + section + "' 영역 문항을 정확히 " + c + "개 생성하라. 번호는 " + sn + "번부터.\n" +
      (section === "독해" ? "독해는 위 본문(passage)을 근거로 만들고 발문에 '윗글'로 참조한다.\n" : "") +
      (section === "서술형" ? "서술형은 품질기준의 형식(다중조건/표형식 오류수정/문장전환·결합)을 반드시 섞어 고난도로 만든다.\n" : "") +
      (isExt ? EXT_GUIDE + "\n[이 학교 외부지문 기출 패턴 — 지난 시험, 소재 재사용 금지]\n" + (extPattern || "(기록 없음 — 일반적인 중학교 내신 외부지문 방식으로)") + "\n" +
        "[지문 이름] 이 묶음의 지문은 " + LET.slice(j * (CHUNK / 2), j * (CHUNK / 2) + Math.ceil(c / 2)).split("").map(x => "[지문 " + x + "]").join(", ") + " 순서로 이름 붙인다.\n" +
        (extPass.length ? "[이 묶음에 쓸 지문 — 학교 부교재 원문]\n" + extPass.slice(j * (CHUNK / 2), j * (CHUNK / 2) + Math.ceil(c / 2)).map((p, k) => "[지문 " + LET[j * (CHUNK / 2) + k] + "] (" + (p.title || "") + ") " + p.text).join("\n") + "\n" +
          (extPass.slice(j * (CHUNK / 2), j * (CHUNK / 2) + Math.ceil(c / 2)).length < Math.ceil(c / 2) ? "부교재 지문이 모자라는 지문은 이번 범위 단원 주제로 새로 쓴다.\n" : "") : "") +
        (!extPass.length && extTopics.length ? "[이 묶음에 쓸 소재]\n" + extTopics.slice(j * (CHUNK / 2), j * (CHUNK / 2) + Math.ceil(c / 2)).join("\n") + "\n" : "") : "") +
      "순수 JSON 배열만 출력하라.";
    // 안정성: 5문항씩 나눠 생성(각 3회 재시도). 속도: 묶음들을 병렬로 동시 처리.
    const jobs = [];
    for (let done = 0, j = 0; done < count; done += CHUNK, j++) {
      const c = Math.min(CHUNK, count - done);
      const sn = startNum + done, jj = j;
      jobs.push((async () => {
        const user = buildUser(c, sn, jj);
        for (let i = 0; i < 3; i++) {
          try {
            const text = await callClaude({ system: GEN_GUIDELINE, content: [{ type: "text", text: user }], max_tokens: 8000 });
            // 번호가 빠진 발문에 번호를 붙인다(11/19 외부지문 둘째 문항 번호 빠짐)
            return extractArr(text).map((q, k) => { q.n = sn + k; const st = String(q.stem || "").trim(); q.stem = /^\d+\s*[.)]/.test(st) ? st.replace(/^\d+/, String(sn + k)) : (sn + k) + ". " + st; return q; });
          }
          catch (err) { if (i === 2) throw err; }
        }
      })());
    }
    const parts = await Promise.all(jobs);
    const questions = parts.flat();
    res.json({ questions });
  } catch (e) {
    res.status(502).json({ error: "생성 실패(" + (req.body && req.body.section) + "): " + (e.message || String(e)) });
  }
});

app.get("/healthz", (req, res) => res.send("ok"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("server on " + PORT));
