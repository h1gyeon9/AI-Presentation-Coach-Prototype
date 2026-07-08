const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
const API_KEY = process.env.GEMINI_API_KEY;

const AUDIENCE_LABELS = {
  general: "일반 청중",
  professor: "교수/평가자",
  team: "팀원/스터디",
  interviewer: "면접관",
  investor: "IR 투자자",
};

function buildInstructions(mode, audienceLabel) {
  const base = `당신은 발표/면접 코치입니다. 청중은 "${audienceLabel}"입니다. 한국어로 구체적이고 실행 가능한 피드백을 제공하세요. 인사말이나 "~피드백을 드리겠습니다" 같은 서두 없이, 바로 분석 내용부터 시작하세요.`;

  if (mode === "audio") {
    return `${base}\n첨부된 음성을 듣고 발화 내용(논리 구성, 단어 표현)과 전달력(속도, 휴지, 발음)을 분석해 개선점을 제시하세요.`;
  }
  if (mode === "video") {
    return `${base}\n첨부된 영상을 보고 발화 내용, 전달력에 더해 제스처, 표정, 시선 처리 등 비언어적 요소를 분석해 개선점을 제시하세요.`;
  }
  return `${base}\n대본의 논리적 구성과 단어 표현을 분석해 개선점을 제시하세요.`;
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
        body: JSON.stringify({ contents: [{ role: "user", parts }] }),
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
