const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  if (!process.env.GEMINI_API_KEY) {
    return json(500, { error: "GEMINI_API_KEY is not configured" });
  }

  try {
    const payload = JSON.parse(event.body || "{}");
    const mode = payload.mode === "report" ? "report" : "turn";
    const input = mode === "report" ? buildReportInput(payload) : buildTurnInput(payload);

    const response = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        model: MODEL,
        system_instruction: buildSystemInstruction(mode, payload.profile),
        input,
        generation_config: {
          temperature: mode === "report" ? 0.35 : 0.72,
        },
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return json(response.status, {
        error: data.error?.message || "Gemini API request failed",
      });
    }

    const text = extractOutputText(data);
    if (mode === "report") {
      return json(200, {
        text,
        report: parseJsonBlock(text),
      });
    }

    const parsed = parseJsonBlock(text);
    return json(200, {
      text,
      reply: parsed?.reply || parsed?.question || text,
      focus: parsed?.focus || "",
    });
  } catch (error) {
    return json(500, { error: error.message || "Unexpected server error" });
  }
};

function json(statusCode, body) {
  return {
    statusCode,
    headers,
    body: JSON.stringify(body),
  };
}

function buildSystemInstruction(mode, profile = {}) {
  const persona = profile.personaLabel || "차분한 구조화 면접관";
  const depth = profile.depth || 3;

  if (mode === "report") {
    return [
      "당신은 한국어 면접 코치입니다.",
      "지원자의 답변 기록을 바탕으로 간결하고 실천 가능한 피드백을 제공합니다.",
      "면접 합격을 보장하거나 과장하지 않습니다.",
      "반드시 JSON만 반환합니다.",
    ].join(" ");
  }

  return [
    "당신은 한국어로 진행하는 1:1 AI 면접관입니다.",
    `면접관 페르소나는 '${persona}'이고 꼬리질문 강도는 1에서 5 중 ${depth}입니다.`,
    "지원자의 최근 답변에 근거해 실제 면접처럼 하나의 질문만 던집니다.",
    "질문은 2문장 이내로 짧게 말하고, 칭찬이나 해설을 길게 붙이지 않습니다.",
    "모호한 답변에는 역할, 근거, 수치, 갈등, 실패, 재발 방지 중 하나를 파고듭니다.",
    "반드시 JSON만 반환합니다. 예: {\"reply\":\"질문\",\"focus\":\"검증하려는 역량\"}",
  ].join(" ");
}

function buildTurnInput(payload) {
  const profile = payload.profile || {};
  const history = (payload.messages || [])
    .slice(-10)
    .map((message) => `${message.role === "ai" ? "면접관" : "지원자"}: ${message.text}`)
    .join("\n");

  return [
    "[지원 정보]",
    `회사: ${profile.company || "미입력"}`,
    `직무: ${profile.role || "미입력"}`,
    `인재상: ${profile.talent || "미입력"}`,
    `자기소개서 파일: ${profile.resumeName || "없음"}`,
    `자기소개서 발췌: ${profile.resumeText || "없음"}`,
    "",
    "[대화 기록]",
    history || "아직 대화 없음",
    "",
    "[최근 답변]",
    payload.latestAnswer || "첫 질문을 시작해 주세요.",
  ].join("\n");
}

function buildReportInput(payload) {
  const profile = payload.profile || {};
  const conversation = (payload.messages || [])
    .map((message, index) => {
      const speaker = message.role === "ai" ? "면접관" : "지원자";
      return `${index + 1}. ${speaker}: ${message.text}`;
    })
    .join("\n");
  const answers = (payload.answers || [])
    .map((answer, index) => `${index + 1}. ${answer}`)
    .join("\n");

  return [
    "[지원 정보]",
    `회사: ${profile.company || "미입력"}`,
    `직무: ${profile.role || "미입력"}`,
    `인재상: ${profile.talent || "미입력"}`,
    `자기소개서 파일: ${profile.resumeName || "없음"}`,
    `자기소개서 발췌: ${profile.resumeText || "없음"}`,
    "",
    "[로컬 분석]",
    JSON.stringify(payload.localAnalysis || {}),
    "",
    "[전체 면접 대화 기록]",
    conversation || "대화 기록 없음",
    "",
    "[지원자 답변만 모아보기]",
    answers || "답변 없음",
    "",
    "면접관 질문의 의도와 지원자 답변의 대응력을 함께 평가하세요.",
    "로컬 분석은 참고 자료이며, 최종 피드백은 대화 기록을 우선해서 판단하세요.",
    "비언어 분석은 프로토타입 시뮬레이션 값이므로 확정 진단처럼 말하지 말고 완곡하게 표현하세요.",
    "",
    "다음 JSON 스키마로만 반환하세요.",
    "{\"summary\":\"2문장 종합평\",\"strengths\":[\"강점1\",\"강점2\"],\"languageHabits\":[\"언어 습관 피드백1\",\"언어 습관 피드백2\"],\"contentFeedback\":[\"내용 피드백1\",\"내용 피드백2\"],\"nonverbalFeedback\":[\"비언어 피드백1\",\"비언어 피드백2\"],\"improvements\":[\"보완점1\",\"보완점2\",\"보완점3\"],\"practicePlan\":[\"연습1\",\"연습2\",\"연습3\"]}",
  ].join("\n");
}

function extractOutputText(data) {
  if (typeof data.output_text === "string") return data.output_text;
  if (typeof data.outputText === "string") return data.outputText;
  if (typeof data.text === "string") return data.text;

  const candidatesText = data.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("");
  if (candidatesText) return candidatesText;

  const stepText = Array.isArray(data.steps)
    ? data.steps
        .flatMap((step) => step.content || step.contents || [])
        .map((content) => content.text || "")
        .join("")
    : "";
  if (stepText) return stepText;

  return "";
}

function parseJsonBlock(text) {
  if (!text) return null;
  const cleaned = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (error) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (innerError) {
      return null;
    }
  }
}
