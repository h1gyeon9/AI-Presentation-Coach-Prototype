const DEFAULT_LIVE_MODEL = "gemini-3.1-flash-live-preview";
const LIVE_MODEL_ALIASES = {
  "gemini live 2.5 flash native audio": "gemini-live-2.5-flash-native-audio",
  "gemini-live-2.5-flash-native-audio": "gemini-live-2.5-flash-native-audio",
  "gemini 2.5 flash native audio dialog": "gemini-live-2.5-flash-native-audio",
  "gemini 2.5 flash live native audio": "gemini-live-2.5-flash-native-audio",
  "gemini-2.5-flash-native-audio": "gemini-live-2.5-flash-native-audio",
  "gemini 3 flash live": "gemini-3.1-flash-live-preview",
  "gemini-3-flash-live": "gemini-3.1-flash-live-preview",
  "gemini-3-flash-live-preview": "gemini-3.1-flash-live-preview",
  "gemini 3.1 flash live": "gemini-3.1-flash-live-preview",
  "gemini 3.1 flash live preview": "gemini-3.1-flash-live-preview",
  "gemini-3.1-flash-live": "gemini-3.1-flash-live-preview",
  "gemini-3.1-flash-live-preview": "gemini-3.1-flash-live-preview",
  "gemini-2.5-flash-native-audio-preview-12-2025":
    "gemini-2.5-flash-native-audio-preview-12-2025",
};

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
    return json(500, {
      code: "MISSING_KEY",
      error: "AI API 키가 설정되지 않았습니다. Netlify 환경변수 GEMINI_API_KEY를 확인해 주세요.",
    });
  }

  try {
    const payload = JSON.parse(event.body || "{}");
    const model = normalizeModelName(process.env.GEMINI_LIVE_MODEL || DEFAULT_LIVE_MODEL);
    console.info("[AI Live Token] issuing token", { model });
    const token = await createLiveToken(model);

    return json(200, {
      token,
      model,
      expiresInMinutes: 30,
    });
  } catch (error) {
    console.error("[AI Live Token] failed", {
      code: error.code,
      status: error.status || error.statusCode,
      message: sanitizeError(error.message || ""),
    });
    const statusCode = Number(error.status || error.statusCode) || 500;
    return json(statusCode, {
      code: error.code || "LIVE_TOKEN_ERROR",
      error: sanitizeError(error.message || "실시간 AI 토큰을 발급하지 못했습니다."),
    });
  }
};

async function createLiveToken(model) {
  const { GoogleGenAI } = await import("@google/genai");
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const expireTime = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const newSessionExpireTime = new Date(Date.now() + 60 * 1000);

  const token = await client.authTokens.create({
    config: {
      uses: 1,
      expireTime,
      newSessionExpireTime,
      liveConnectConstraints: {
        model,
        config: {
          sessionResumption: {},
          temperature: 0.7,
          responseModalities: ["AUDIO"],
        },
      },
      httpOptions: {
        apiVersion: "v1alpha",
      },
    },
  });

  const tokenValue = token?.name || token?.token || token?.accessToken;
  if (!tokenValue) {
    const error = new Error("AI Live 토큰 응답이 비어 있습니다.");
    error.code = "EMPTY_TOKEN";
    throw error;
  }
  return tokenValue;
}

function normalizeModelName(model) {
  const raw = String(model || DEFAULT_LIVE_MODEL).trim().replace(/^models\//, "");
  const normalized = raw.toLowerCase().replace(/_/g, "-").replace(/\s+/g, " ");
  return LIVE_MODEL_ALIASES[normalized] || raw;
}

function sanitizeError(message) {
  return String(message).replace(/Gemini/g, "AI").replace(/GEMINI/g, "AI");
}

function json(statusCode, body) {
  return {
    statusCode,
    headers,
    body: JSON.stringify(body),
  };
}
