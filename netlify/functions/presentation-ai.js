const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
const API_KEY = process.env.GEMINI_API_KEY;
const GENERATE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const MAX_INLINE_BASE64_CHARS = 6_000_000;

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const stringArray = {
  type: "array",
  items: { type: "string" },
};

const draftSchema = {
  type: "object",
  properties: {
    draft: { type: "string" },
    outline: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          purpose: { type: "string" },
          estimatedSeconds: { type: "integer", minimum: 0 },
        },
        required: ["title", "purpose", "estimatedSeconds"],
      },
    },
    keyMessages: stringArray,
    sourceSummary: {
      type: "array",
      items: {
        type: "object",
        properties: {
          source: { type: "string" },
          usedPoints: stringArray,
        },
        required: ["source", "usedPoints"],
      },
    },
    warnings: stringArray,
  },
  required: ["draft", "outline", "keyMessages", "sourceSummary", "warnings"],
};

const questionsSchema = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          intent: { type: "string" },
          personaPerspective: { type: "string" },
          suggestedAnswerPoints: stringArray,
        },
        required: ["question", "intent", "personaPerspective", "suggestedAnswerPoints"],
      },
    },
    warnings: stringArray,
  },
  required: ["questions", "warnings"],
};

const scoreProperties = {
  logic: { type: "integer", minimum: 0, maximum: 100 },
  evidence: { type: "integer", minimum: 0, maximum: 100 },
  delivery: { type: "integer", minimum: 0, maximum: 100 },
  pronunciation: { type: "integer", minimum: 0, maximum: 100 },
  eyeContact: { type: "integer", minimum: 0, maximum: 100 },
  posture: { type: "integer", minimum: 0, maximum: 100 },
  expression: { type: "integer", minimum: 0, maximum: 100 },
  gesture: { type: "integer", minimum: 0, maximum: 100 },
};

const reportSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    overallScore: { type: "integer", minimum: 0, maximum: 100 },
    scores: {
      type: "object",
      properties: scoreProperties,
      required: Object.keys(scoreProperties),
    },
    speechMetrics: {
      type: "object",
      properties: {
        estimatedWpm: { type: "integer", minimum: 0 },
        estimatedSilenceRatio: { type: "integer", minimum: 0, maximum: 100 },
        totalDurationSeconds: { type: "integer", minimum: 0 },
        naturalness: { type: "integer", minimum: 0, maximum: 100 },
        intonation: { type: "integer", minimum: 0, maximum: 100 },
        breathingStability: { type: "integer", minimum: 0, maximum: 100 },
        evidence: stringArray,
      },
      required: [
        "estimatedWpm",
        "estimatedSilenceRatio",
        "totalDurationSeconds",
        "naturalness",
        "intonation",
        "breathingStability",
        "evidence",
      ],
    },
    contentAnalysis: {
      type: "object",
      properties: {
        strengths: stringArray,
        weaknesses: stringArray,
        logicSummary: { type: "string" },
        evidenceSummary: { type: "string" },
        expressionSummary: { type: "string" },
        timingSummary: { type: "string" },
      },
      required: [
        "strengths",
        "weaknesses",
        "logicSummary",
        "evidenceSummary",
        "expressionSummary",
        "timingSummary",
      ],
    },
    nonverbalAnalysis: {
      type: "object",
      properties: {
        available: { type: "boolean" },
        summary: { type: "string" },
        observations: stringArray,
      },
      required: ["available", "summary", "observations"],
    },
    coaching: {
      type: "array",
      items: {
        type: "object",
        properties: {
          priority: { type: "string", enum: ["high", "medium", "low"] },
          issue: { type: "string" },
          evidence: { type: "string" },
          action: { type: "string" },
        },
        required: ["priority", "issue", "evidence", "action"],
      },
    },
    followUpQuestions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          intent: { type: "string" },
          suggestedAnswerPoints: stringArray,
        },
        required: ["question", "intent", "suggestedAnswerPoints"],
      },
    },
    historyComparison: {
      type: "object",
      properties: {
        available: { type: "boolean" },
        summary: { type: "string" },
        improvements: stringArray,
        regressions: stringArray,
      },
      required: ["available", "summary", "improvements", "regressions"],
    },
    warnings: stringArray,
  },
  required: [
    "summary",
    "overallScore",
    "scores",
    "speechMetrics",
    "contentAnalysis",
    "nonverbalAnalysis",
    "coaching",
    "followUpQuestions",
    "historyComparison",
    "warnings",
  ],
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  if (!API_KEY) {
    return json(500, { error: "GEMINI_API_KEY is not configured" });
  }

  try {
    const payload = JSON.parse(event.body || "{}");
    const task = ["draft", "questions", "report"].includes(payload.task)
      ? payload.task
      : "";

    if (!task) {
      return json(400, { error: "task must be draft, questions, or report" });
    }

    const request = buildGeminiRequest(task, payload);
    const response = await fetch(`${GENERATE_URL}?key=${API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    const data = await response.json();

    if (!response.ok) {
      return json(response.status, {
        error: data?.error?.message || "Gemini API request failed",
      });
    }

    const text = extractText(data);
    const result = parseJsonBlock(text);
    if (!result) {
      return json(502, { error: "Gemini structured response could not be parsed", text });
    }

    if (task === "report") {
      return json(200, {
        task,
        report: result,
        feedback: reportToLegacyFeedback(result),
      });
    }

    return json(200, { task, ...result });
  } catch (error) {
    return json(500, { error: error.message || "Unexpected server error" });
  }
};

function buildGeminiRequest(task, payload) {
  const config =
    task === "draft"
      ? buildDraftRequest(payload)
      : task === "questions"
        ? buildQuestionsRequest(payload)
        : buildReportRequest(payload);

  return {
    systemInstruction: {
      parts: [{ text: config.systemInstruction }],
    },
    contents: [{ role: "user", parts: config.parts }],
    generationConfig: {
      temperature: task === "report" ? 0.25 : 0.45,
      thinkingConfig: { thinkingBudget: 0 },
      responseFormat: {
        text: {
          mimeType: "application/json",
          schema: config.schema,
        },
      },
    },
  };
}

function buildDraftRequest(payload) {
  const context = normalizeContext(payload.context);
  const materials = normalizeMaterials(payload.materials);
  if (!materials.parts.length && !String(payload.existingScript || "").trim()) {
    throw new Error("대본 생성에 사용할 자료나 기존 대본이 필요합니다.");
  }

  const prompt = [
    "[발표 설정]",
    JSON.stringify(context),
    "",
    "[기존 대본]",
    String(payload.existingScript || "").slice(0, 30000) || "없음",
    "",
    "[작업]",
    "첨부 자료에 근거해 실제로 말하기 자연스러운 한국어 발표 대본을 작성하세요.",
    "자료에 없는 수치나 사실을 만들지 말고, 불확실한 내용은 warnings에 기록하세요.",
    "목표 시간이 있으면 outline의 estimatedSeconds 합계와 대본 분량을 그 시간에 맞추세요.",
    "자료별로 실제 사용한 핵심 포인트를 sourceSummary에 남기세요.",
    materials.description,
  ].join("\n");

  return {
    schema: draftSchema,
    systemInstruction:
      "당신은 한국어 발표 대본 편집자입니다. 원자료의 사실성을 보존하면서 흐름, 표현, 논리, 시간 배분을 개선합니다.",
    parts: [{ text: prompt }, ...materials.parts],
  };
}

function buildQuestionsRequest(payload) {
  const context = normalizeContext(payload.context);
  const script = String(payload.script || "").trim();
  if (!script) throw new Error("질문 생성에 사용할 발표 대본이 필요합니다.");

  return {
    schema: questionsSchema,
    systemInstruction:
      "당신은 한국어 발표 청중 역할을 수행합니다. 선택된 페르소나의 관점에서 현실적인 질문을 만들고 질문 의도를 설명합니다.",
    parts: [
      {
        text: [
          "[발표 설정]",
          JSON.stringify(context),
          "",
          "[발표 대본]",
          script.slice(0, 40000),
          "",
          "[작업]",
          `예상 질문 ${clamp(payload.count, 1, 12, 6)}개를 만드세요.`,
          "질문마다 청중 관점, 질문 의도, 답변에 포함하면 좋은 포인트를 제공하세요.",
        ].join("\n"),
      },
    ],
  };
}

function buildReportRequest(payload) {
  const context = normalizeContext(payload.context);
  const mode = ["script", "audio", "video"].includes(payload.mode)
    ? payload.mode
    : "script";
  const script = String(payload.script || "").trim();
  const mediaPart = buildMediaPart(payload.mediaBase64, payload.mediaMimeType);
  if (mode === "script" && !script) throw new Error("분석할 발표 대본이 필요합니다.");
  if (mode !== "script" && !mediaPart) throw new Error("분석할 오디오 또는 영상이 필요합니다.");

  const measuredMetrics = payload.measuredMetrics || {};
  const previousSessions = Array.isArray(payload.previousSessions)
    ? payload.previousSessions.slice(-5)
    : [];
  const prompt = [
    "[발표 설정]",
    JSON.stringify(context),
    "",
    "[분석 모드]",
    mode,
    "",
    "[발표 대본 또는 보조 원고]",
    script.slice(0, 40000) || "없음",
    "",
    "[코드에서 측정한 지표]",
    JSON.stringify(measuredMetrics),
    "",
    "[이전 세션]",
    JSON.stringify(previousSessions),
    "",
    "[작업]",
    "발표 유형, 목적, 청중 페르소나, 목표 시간에 맞춰 종합 분석하세요.",
    "코드 측정값이 있으면 반드시 그 값을 우선하고, 임의로 바꾸지 마세요.",
    "미디어에서 확인하기 어려운 수치에는 0을 사용하고 warnings에 이유를 적으세요.",
    "WPM, 침묵 비율 등 미디어 기반 값은 추정치임을 evidence 또는 warnings에 명시하세요.",
    "영상이 없으면 비언어 점수를 0으로 두고 nonverbalAnalysis.available을 false로 설정하세요.",
    "이전 세션이 없으면 historyComparison.available을 false로 설정하세요.",
  ].join("\n");

  return {
    schema: reportSchema,
    systemInstruction:
      "당신은 한국어 발표 코치입니다. 근거가 확인되는 범위에서만 평가하고, 점수보다 관찰 근거와 실행 가능한 개선 행동을 우선합니다.",
    parts: [{ text: prompt }, ...(mediaPart ? [mediaPart] : [])],
  };
}

function normalizeContext(context = {}) {
  return {
    presentationType: String(context.presentationType || "미입력"),
    purpose: String(context.purpose || "미입력"),
    audience: String(context.audience || "일반 청중"),
    personaGuidance: String(context.personaGuidance || ""),
    targetDurationSeconds: clamp(context.targetDurationSeconds, 0, 21600, 0),
    qaDurationSeconds: clamp(context.qaDurationSeconds, 0, 21600, 0),
  };
}

function normalizeMaterials(materials) {
  const list = Array.isArray(materials) ? materials.slice(0, 8) : [];
  const parts = [];
  const descriptions = [];
  let inlineChars = 0;

  list.forEach((material, index) => {
    const name = String(material?.name || `자료 ${index + 1}`);
    const text = String(material?.text || "").trim();
    const data = String(material?.data || "");
    const mimeType = String(material?.mimeType || "");

    if (text) {
      descriptions.push(`${index + 1}. ${name}: 추출 텍스트 제공`);
      parts.push({ text: `[자료: ${name}]\n${text.slice(0, 50000)}` });
      return;
    }

    if (data && mimeType && inlineChars + data.length <= MAX_INLINE_BASE64_CHARS) {
      descriptions.push(`${index + 1}. ${name}: ${mimeType} 원본 제공`);
      parts.push({ inlineData: { mimeType, data } });
      inlineChars += data.length;
      return;
    }

    descriptions.push(`${index + 1}. ${name}: 내용 없음 또는 요청 크기 제한으로 제외`);
  });

  return {
    parts,
    description: ["[첨부 자료 목록]", ...descriptions].join("\n"),
  };
}

function buildMediaPart(data, mimeType) {
  if (!data || !mimeType) return null;
  const encoded = String(data);
  if (encoded.length > MAX_INLINE_BASE64_CHARS) {
    throw new Error("미디어 파일이 요청 크기 제한을 초과했습니다.");
  }
  return { inlineData: { mimeType: String(mimeType), data: encoded } };
}

function extractText(data) {
  return (
    data?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("")
      .trim() || ""
  );
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
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function reportToLegacyFeedback(report) {
  const content = report?.contentAnalysis || {};
  const scores = report?.scores || {};
  const coaching = Array.isArray(report?.coaching) ? report.coaching : [];
  const questions = Array.isArray(report?.followUpQuestions)
    ? report.followUpQuestions
    : [];
  const nonverbal = report?.nonverbalAnalysis || {};
  const lines = [
    "## 내용 리포트",
    report?.summary || "발표 분석을 완료했습니다.",
    "",
    `- 종합 점수: ${report?.overallScore || 0}점`,
    `- 논리 구조: ${scores.logic || 0}점`,
    `- 근거와 예시: ${scores.evidence || 0}점`,
    `- 전달력: ${scores.delivery || 0}점`,
    "",
    "### 강점",
    ...(content.strengths || []).map((item) => `- ${item}`),
    "",
    "### 개선 우선순위",
    ...coaching.map((item) => `- ${item.issue}: ${item.action} (${item.evidence})`),
    "",
    "### 예상 질문",
    ...questions.map(
      (item) =>
        `- ${item.question}\n  - 의도: ${item.intent}\n  - 답변 포인트: ${(item.suggestedAnswerPoints || []).join(", ")}`,
    ),
  ];

  if (nonverbal.available) {
    lines.push(
      "",
      "## 비언어 리포트",
      nonverbal.summary || "",
      ...(nonverbal.observations || []).map((item) => `- ${item}`),
    );
  }

  return lines.join("\n").trim();
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function json(statusCode, body) {
  return {
    statusCode,
    headers,
    body: JSON.stringify(body),
  };
}
