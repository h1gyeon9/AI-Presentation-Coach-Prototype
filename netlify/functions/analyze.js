const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
const API_KEY = process.env.GEMINI_API_KEY;

const AUDIENCE_LABELS = {
  general: "일반 청중",
  professor: "교수/평가자",
  team: "팀원/스터디",
  interviewer: "면접관",
  investor: "IR 투자자",
};

const CONTENT_MARKER = "## 내용 리포트";
const NONVERBAL_MARKER = "## 비언어 리포트";

function buildInstructions(mode, audienceLabel) {
  const base = `당신은 발표/면접 코치입니다. 청중은 "${audienceLabel}"입니다. 한국어로 구체적이고 실행 가능한 피드백을 제공하세요. 인사말이나 "~피드백을 드리겠습니다" 같은 서두 없이, 바로 분석 내용부터 시작하세요.`;
  const contentTask = "논리적 구성(서론-본론-결론 흐름, 근거 연결)과 단어 표현(모호하거나 반복되는 표현)을 분석해 개선점을 제시하세요.";

  if (mode === "audio") {
    return `${base}\n\n반드시 아래 제목을 그대로 사용해 한 섹션으로만 답변하세요.\n\n${CONTENT_MARKER}\n첨부된 음성을 듣고 발화 내용과 전달력(속도, 휴지, 발음)을 포함해 ${contentTask}`;
  }
  if (mode === "video") {
    return `${base}\n\n반드시 아래 두 제목을 그대로 사용해 두 섹션으로 나누어 답변하세요.\n\n${CONTENT_MARKER}\n첨부된 영상의 음성 내용을 바탕으로 ${contentTask}\n\n${NONVERBAL_MARKER}\n영상 속 시선 처리, 표정 변화, 손/제스처, 자세 등 비언어적 요소를 분석해 개선점을 제시하세요.`;
  }
  return `${base}\n\n반드시 아래 제목을 그대로 사용해 한 섹션으로만 답변하세요.\n\n${CONTENT_MARKER}\n${contentTask}`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  if (!API_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "서버에 GEMINI_API_KEY가 설정되어 있지 않습니다." }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "잘못된 요청 본문입니다." }) };
  }

  const { mode, script = "", audience = "general", mediaBase64, mediaMimeType } = payload;

  if (!["script", "audio", "video"].includes(mode)) {
    return { statusCode: 400, body: JSON.stringify({ error: "mode 값이 올바르지 않습니다." }) };
  }

  const audienceLabel = AUDIENCE_LABELS[audience] || AUDIENCE_LABELS.general;
  const instructions = buildInstructions(mode, audienceLabel);

  const parts = [
    { text: `${instructions}${script ? `\n\n대본:\n${script}` : ""}` },
  ];

  if (mediaBase64 && mediaMimeType) {
    parts.push({ inlineData: { mimeType: mediaMimeType, data: mediaBase64 } });
  }

  try {
    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          // 로컬/실서비스 함수 타임아웃(약 30초)을 넘기지 않도록 thinking을 꺼서 응답 속도를 높인다.
          generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
        }),
      }
    );

    const data = await geminiResponse.json();

    if (!geminiResponse.ok) {
      const message = data?.error?.message || "Gemini API 호출이 실패했습니다.";
      return { statusCode: geminiResponse.status, body: JSON.stringify({ error: message }) };
    }

    const feedback =
      data?.candidates?.[0]?.content?.parts?.map((part) => part.text).join("\n").trim() ||
      "분석 결과를 가져오지 못했습니다.";

    return { statusCode: 200, body: JSON.stringify({ feedback }) };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Gemini API 호출 중 오류가 발생했습니다." }),
    };
  }
};
