const TYPECAST_URL = "https://api.typecast.ai/v1/text-to-speech";
const DEFAULT_MODEL = process.env.TYPECAST_TTS_MODEL || "ssfm-v21";
const DEFAULT_FORMAT = process.env.TYPECAST_TTS_FORMAT || "mp3";
const DEFAULT_TEMPO = Number(process.env.TYPECAST_TTS_TEMPO || 1.08);
const MAX_TTS_CHARS = 1800;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const jsonHeaders = {
  ...corsHeaders,
  "Content-Type": "application/json; charset=utf-8",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  try {
    const payload = JSON.parse(event.body || "{}");
    if (payload.warmup) {
      return json(200, { warmed: true });
    }

    const apiKey = process.env.TYPECAST_API_KEY;
    const voiceId = process.env.TYPECAST_VOICE_ID;
    const text = String(payload.text || "").trim();

    if (!apiKey) {
      return unavailable("MISSING_TYPECAST_KEY", "TYPECAST_API_KEY가 설정되지 않았습니다.");
    }

    if (!voiceId) {
      return unavailable("MISSING_TYPECAST_VOICE", "TYPECAST_VOICE_ID가 설정되지 않았습니다.");
    }

    if (!text) {
      return unavailable("EMPTY_TEXT", "AI 음성으로 읽을 텍스트가 없습니다.");
    }

    const response = await fetch(TYPECAST_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
      },
      body: JSON.stringify({
        text: text.slice(0, MAX_TTS_CHARS),
        model: DEFAULT_MODEL,
        voice_id: voiceId,
        output: {
          audio_format: normalizeFormat(DEFAULT_FORMAT),
          audio_tempo: normalizeTempo(DEFAULT_TEMPO),
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.warn("[Typecast TTS] request failed", {
        status: response.status,
        body: errorText.slice(0, 500),
      });
      return unavailable("TYPECAST_TTS_ERROR", "Typecast 음성 생성 요청에 실패했습니다.");
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    const contentType = getAudioContentType(response.headers.get("Content-Type"), DEFAULT_FORMAT);

    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": contentType,
        "Cache-Control": "no-store",
        "X-AI-TTS-Provider": "typecast",
        "X-AI-TTS-Model": DEFAULT_MODEL,
        "X-AI-TTS-Voice": voiceId,
      },
      body: audioBuffer.toString("base64"),
      isBase64Encoded: true,
    };
  } catch (error) {
    console.warn("[Typecast TTS] unexpected failure", {
      message: error.message || "",
    });
    return unavailable("TYPECAST_TTS_UNEXPECTED", "Typecast 음성 생성 중 오류가 발생했습니다.");
  }
};

function normalizeFormat(format) {
  return String(format || DEFAULT_FORMAT).toLowerCase() === "wav" ? "wav" : "mp3";
}

function normalizeTempo(tempo) {
  const value = Number(tempo);
  if (!Number.isFinite(value)) return 1.08;
  return Math.max(0.5, Math.min(2.0, value));
}

function getAudioContentType(contentType, format) {
  const value = String(contentType || "").toLowerCase();
  if (value.includes("audio/")) return contentType;
  return normalizeFormat(format) === "wav" ? "audio/wav" : "audio/mpeg";
}

function unavailable(code, error) {
  return json(200, {
    code,
    error,
    audioUnavailable: true,
  });
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: jsonHeaders,
    body: JSON.stringify(body),
  };
}
