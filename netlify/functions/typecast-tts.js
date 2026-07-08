let streamHelper = null;

try {
  ({ stream: streamHelper } = require("@netlify/functions"));
} catch (error) {
  streamHelper = null;
}

const TYPECAST_STREAM_URL = "https://api.typecast.ai/v1/text-to-speech/stream";
const DEFAULT_MODEL = process.env.TYPECAST_TTS_MODEL || "ssfm-v21";
const DEFAULT_FORMAT = "mp3";
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

async function handleTts(event) {
  if (event.httpMethod === "OPTIONS") {
    return new Response("", { status: 204, headers: corsHeaders });
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

    const response = await fetch(TYPECAST_STREAM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
      },
      body: JSON.stringify({
        text: text.slice(0, MAX_TTS_CHARS),
        model: DEFAULT_MODEL,
        voice_id: voiceId,
        language: "kor",
        output: {
          audio_format: DEFAULT_FORMAT,
          audio_tempo: normalizeTempo(DEFAULT_TEMPO),
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.warn("[Typecast TTS] streaming request failed", {
        status: response.status,
        body: errorText.slice(0, 500),
      });
      return unavailable(
        "TYPECAST_TTS_ERROR",
        `Typecast 음성 생성 요청에 실패했습니다. (${response.status})`,
      );
    }

    const upstreamContentType = response.headers.get("Content-Type") || "";
    if (upstreamContentType.toLowerCase().includes("application/json")) {
      const errorText = await response.text().catch(() => "");
      console.warn("[Typecast TTS] streaming response was JSON", {
        body: errorText.slice(0, 500),
      });
      return unavailable("TYPECAST_TTS_EMPTY_AUDIO", "Typecast 음성 응답이 비어 있습니다.");
    }

    return new Response(response.body, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": getAudioContentType(upstreamContentType),
        "Cache-Control": "no-store",
        "X-AI-TTS-Provider": "typecast",
        "X-AI-TTS-Mode": streamHelper ? "stream" : "buffered-fallback",
        "X-AI-TTS-Model": DEFAULT_MODEL,
        "X-AI-TTS-Voice": voiceId,
      },
    });
  } catch (error) {
    console.warn("[Typecast TTS] unexpected failure", {
      message: error.message || "",
    });
    return unavailable("TYPECAST_TTS_UNEXPECTED", "Typecast 음성 생성 중 오류가 발생했습니다.");
  }
}

exports.handler = streamHelper
  ? streamHelper(handleTts)
  : async (event) => responseToNetlify(await handleTts(event));

function normalizeTempo(tempo) {
  const value = Number(tempo);
  if (!Number.isFinite(value)) return 1.08;
  return Math.max(0.5, Math.min(2.0, value));
}

function getAudioContentType(contentType) {
  const value = String(contentType || "").toLowerCase();
  if (value.includes("audio/")) return contentType;
  return "audio/mpeg";
}

function unavailable(code, error) {
  return json(200, {
    code,
    error,
    audioUnavailable: true,
  });
}

function json(statusCode, body) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: jsonHeaders,
  });
}

async function responseToNetlify(response) {
  const headers = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  const contentType = String(response.headers.get("Content-Type") || "").toLowerCase();
  const isText = contentType.includes("application/json") || contentType.startsWith("text/");
  const bodyBuffer = Buffer.from(await response.arrayBuffer());

  return {
    statusCode: response.status,
    headers,
    body: isText ? bodyBuffer.toString("utf8") : bodyBuffer.toString("base64"),
    isBase64Encoded: !isText,
  };
}
