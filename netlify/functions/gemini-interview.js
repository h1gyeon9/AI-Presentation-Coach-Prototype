const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const GEMINI_GENERATE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

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
    const mode =
      payload.mode === "report"
        ? "report"
        : payload.mode === "questions"
          ? "questions"
          : "turn";
    const input =
      mode === "report"
        ? buildReportInput(payload)
        : mode === "questions"
          ? buildQuestionsInput(payload)
          : buildTurnInput(payload);
    const response = await callGemini(mode, payload, input);

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
    if (mode === "questions") {
      return json(200, {
        text,
        questions: Array.isArray(parsed?.questions) ? parsed.questions : [],
      });
    }

    return json(200, {
      text,
      reply: parsed?.reply || parsed?.question || text,
      focus: parsed?.focus || "",
    });
  } catch (error) {
    return json(500, { error: error.message || "Unexpected server error" });
  }
};

async function callGemini(mode, payload, input) {
  if (mode === "report" && hasVideoAttachment(payload)) {
    return fetch(`${GEMINI_GENERATE_URL}?key=${process.env.GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: buildSystemInstruction(mode, payload.profile, payload) }],
        },
        contents: [
          {
            role: "user",
            parts: [
              { text: input },
              {
                inlineData: {
                  mimeType: payload.mediaMimeType,
                  data: payload.mediaBase64,
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.35,
        },
      }),
    });
  }

  return fetch(GEMINI_INTERACTIONS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      model: MODEL,
      system_instruction: buildSystemInstruction(mode, payload.profile, payload),
      input,
      generation_config: {
        temperature: mode === "report" ? 0.35 : mode === "questions" ? 0.45 : 0.72,
      },
    }),
  });
}

function hasVideoAttachment(payload) {
  return Boolean(
    payload?.mediaBase64 &&
      payload?.mediaMimeType &&
      /^video\//i.test(payload.mediaMimeType),
  );
}

function json(statusCode, body) {
  return {
    statusCode,
    headers,
    body: JSON.stringify(body),
  };
}

function buildSystemInstruction(mode, profile = {}, payload = {}) {
  const persona = profile.personaLabel || "차분한 구조화 면접관";
  const depth = profile.depth || 3;

  if (mode === "report") {
    const videoGuidance = hasVideoAttachment(payload)
      ? "첨부된 카메라 영상 샘플이 있으면 nonverbalFeedback은 영상에서 실제로 확인되는 시선, 표정, 자세, 제스처를 근거로 5~7개의 구체적인 피드백을 작성합니다. 각 항목은 관찰된 신호, 면접 인상에 미치는 영향, 바로 연습할 개선 행동을 함께 담습니다. 화면에서 확인하기 어려운 항목은 단정하지 않습니다."
      : "첨부 영상이 없으면 실제 비언어 분석을 했다고 말하지 말고 nonverbalFeedback은 빈 배열로 반환합니다.";
    return [
      "당신은 한국어 면접 코치입니다.",
      "지원자의 답변 기록을 바탕으로 간결하고 실천 가능한 피드백을 제공합니다.",
      "답변을 바탕으로 실제 면접에서 이어질 가능성이 높은 꼬리질문과 질문 의도, 답변에 포함하면 좋은 경험·근거를 제안합니다.",
      videoGuidance,
      "면접 합격을 보장하거나 과장하지 않습니다.",
      "반드시 JSON만 반환합니다.",
    ].join(" ");
  }

  if (mode === "questions") {
    const isCivilServant = (profile.role || "").includes("공무원");
    return [
      "당신은 한국어 면접 코치입니다.",
      "지원자의 회사, 직무, 인재상, 이력서 내용을 바탕으로 실제 면접에서 나올 가능성이 높은 예상 질문을 만듭니다.",
      isCivilServant
        ? "공무원 면접이므로 공직 지원 동기, 공직가치관(청렴·봉사·책임감·국가관), 조직 적응력, 장기근속 의지, 상사 지시 이행, 민원 응대, 공익 우선 판단, 희망 부서 외 배치 대처, 불합리한 지시에 대한 대처 등 실제 공직자 면접 역량을 중심으로 질문을 구성합니다."
        : "질문은 직무 경험, 직무 적합성, 위기 및 갈등 관리, 지원 동기, 성장 가능성을 고르게 다룹니다.",
      "각 질문에는 면접관이 확인하려는 의도를 한 문장으로 붙입니다.",
      "반드시 JSON만 반환합니다.",
      "형식: {\"questions\":[{\"category\":\"직무 경험 (적합성)\",\"question\":\"질문\",\"intent\":\"질문 의도\"}]}",
      "질문은 총 15개를 반환합니다.",
    ].join(" ");
  }

  const isCivilServant = (profile.role || "").includes("공무원");
  return [
    "당신은 한국어로 진행하는 1:1 AI 면접관입니다.",
    `면접관 페르소나는 '${persona}'이고 꼬리질문 강도는 1에서 5 중 ${depth}입니다.`,
    "지원자의 최근 답변에 근거해 실제 면접처럼 하나의 질문만 던집니다.",
    "질문은 2문장 이내로 짧게 말하고, 칭찬이나 해설을 길게 붙이지 않습니다.",
    isCivilServant
      ? "공무원 인성면접 스타일로 진행합니다. 질문은 공직가치관(청렴·봉사·책임감), 조직 적응력, 장기근속 의지, 민원 응대, 상사 지시 대처, 공익 우선 판단을 중심으로 구성하고, 상황형 질문(예: 상사가 부당한 지시를 했을 때, 민원인이 무리한 요구를 할 때, 희망 외 부서에 배치됐을 때)을 자연스럽게 섞습니다. 모호한 답변에는 구체적 경험, 판단 기준, 원칙과 융통성 사이의 선택을 파고듭니다."
      : "모호한 답변에는 역할, 근거, 수치, 갈등, 실패, 재발 방지 중 하나를 파고듭니다.",
    "반드시 JSON만 반환합니다. 예: {\"reply\":\"질문\",\"focus\":\"검증하려는 역량\"}",
  ].join(" ");
}

function buildTurnInput(payload) {
  const profile = payload.profile || {};
  const isCivilServant = (profile.role || "").includes("공무원");
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
    isCivilServant
      ? "\n[공무원 면접 중점 역량]\n아직 다루지 않은 영역(공직가치관, 장기근속 의지, 조직 적응력, 민원 응대, 상사 지시 대처, 공익 판단)을 대화 흐름에 맞게 자연스럽게 질문하세요."
      : "",
    "",
    "[대화 기록]",
    history || "아직 대화 없음",
    "",
    "[최근 답변]",
    payload.latestAnswer || "첫 질문을 시작해 주세요.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function buildReportInput(payload) {
  const profile = payload.profile || {};
  const hasVideo = hasVideoAttachment(payload);
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
    hasVideo
      ? "비언어 피드백은 첨부된 카메라 영상 샘플에서 실제로 보이는 시선 처리, 표정 변화, 손/제스처, 자세를 중심으로 작성하세요. nonverbalFeedback은 5~7개 항목으로 작성하고, 각 항목은 1~2문장의 상세한 한국어 조언이어야 합니다. 로컬 비언어 점수나 화면 막대 값은 더미/시뮬레이션일 수 있으므로 사용하지 마세요."
      : "첨부 영상이 없으므로 실제 비언어 피드백을 생성하지 마세요. nonverbalFeedback은 빈 배열로 반환하세요.",
    "",
    "followUpQuestions는 3~5개를 작성하고, 실제 답변에서 더 검증할 지점을 질문으로 만드세요. 각 항목에는 질문 의도와 지원자가 언급하면 좋은 경험·수치·근거를 suggestedAnswerPoints로 제공하세요.",
    "",
    "다음 JSON 스키마로만 반환하세요.",
    "{\"summary\":\"2문장 종합평\",\"strengths\":[\"강점1\",\"강점2\"],\"languageHabits\":[\"언어 습관 피드백1\",\"언어 습관 피드백2\"],\"contentFeedback\":[\"내용 피드백1\",\"내용 피드백2\"],\"nonverbalFeedback\":[\"영상 기반 비언어 피드백 1\",\"영상 기반 비언어 피드백 2\"],\"followUpQuestions\":[{\"question\":\"예상 꼬리질문\",\"intent\":\"질문 의도\",\"suggestedAnswerPoints\":[\"언급할 경험\",\"수치 또는 근거\"]}],\"improvements\":[\"보완점1\",\"보완점2\",\"보완점3\"],\"practicePlan\":[\"연습1\",\"연습2\",\"연습3\"]}",
  ].join("\n");
}

function buildQuestionsInput(payload) {
  const profile = payload.profile || {};
  const isCivilServant = (profile.role || "").includes("공무원");
  return [
    "[지원 정보]",
    `회사: ${profile.company || "미입력"}`,
    `직무: ${profile.role || "미입력"}`,
    `인재상: ${profile.talent || "미입력"}`,
    `면접 유형: ${payload.interviewType || profile.interviewType || "미입력"}`,
    `면접관 성향: ${profile.personaLabel || "차분한 구조화 면접관"}`,
    `자기소개서 파일: ${profile.resumeName || "없음"}`,
    `자기소개서 발췌: ${profile.resumeText || "없음"}`,
    "",
    "지원자의 경험을 구체적으로 검증할 수 있는 예상 질문 15개를 만들어 주세요.",
    "이력서 내용이 부족하면 직무와 인재상을 중심으로 질문을 구성하세요.",
    isCivilServant
      ? [
          "",
          "[공무원 면접 필수 출제 영역 - 각 영역별로 고르게 포함해주세요]",
          "1. 공직 지원 동기 및 공직가치관 (청렴, 봉사, 책임감, 국가관)",
          "2. 장기근속 의지 및 헌신 (민간 대비 낮은 보상에도 지속할 수 있는 이유, 재도전 의지 등)",
          "3. 조직 적응력 (희망 부서 외 배치 시 대처, 연상 상사/연하 상사 관계, 위계 질서 수용)",
          "4. 상사의 부당하거나 불합리한 지시에 대한 대처 (내부 고발, 제도적 절차 활용 등)",
          "5. 민원인 응대 및 갈등 해결 (감정 노동, 무리한 요구, 민원 상황 시나리오)",
          "6. 팀워크·협력 (조직 내 갈등, 동료 업무 떠맡기기, 협업 경험)",
          "7. 공익 vs 개인 이익 충돌 상황 판단 (야근, 개인 일정 충돌 상황형 질문)",
          "8. 인성 및 자기 성찰 (실패 경험, 고치고 싶은 습관, 어려움 극복 경험)",
        ].join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n");
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
