const MODEL = process.env.GEMINI_TTS_MODEL || "gemini-3.1-flash-tts-preview";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const DEFAULT_VOICE = process.env.GEMINI_TTS_VOICE || "Kore";
const DEFAULT_SAMPLE_RATE = 24000;
const MAX_TTS_CHARS = 1800;

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
    return json(200, {
      code: "MISSING_KEY",
      error: "AI API 키가 설정되지 않았습니다. Netlify 환경변수 GEMINI_API_KEY를 확인해 주세요.",
      audioUnavailable: true,
    });
  }

  try {
    const payload = JSON.parse(event.body || "{}");
    const text = String(payload.text || "").trim();
    const voice = sanitizeVoice(payload.voice || DEFAULT_VOICE);

    if (!text) {
      return json(200, {
        code: "EMPTY_TEXT",
        error: "AI 음성으로 읽을 텍스트가 없습니다.",
        audioUnavailable: true,
      });
    }

    const response = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        model: MODEL,
        input: buildTtsInput(text.slice(0, MAX_TTS_CHARS), payload.style),
        response_format: { type: "audio" },
        generation_config: {
          speech_config: [{ voice }],
        },
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.warn("[AI TTS] API request failed", {
        status: response.status,
        code: data.error?.status,
        message: sanitizeError(data.error?.message || ""),
      });
      return json(200, {
        code: data.error?.status || "TTS_API_ERROR",
        error: sanitizeError(data.error?.message || "AI 음성 생성 요청에 실패했습니다."),
        audioUnavailable: true,
      });
    }

    const audio = extractAudio(data);
    if (!audio?.data) {
      console.warn("[AI TTS] empty audio response", {
        model: MODEL,
        responseShape: summarizeShape(data),
      });
      return json(200, {
        code: "EMPTY_AUDIO",
        error: "AI 음성 응답이 비어 있습니다.",
        audioUnavailable: true,
      });
    }

    const pcm = Buffer.from(audio.data, "base64");
    const sampleRate = getSampleRate(audio.mimeType) || DEFAULT_SAMPLE_RATE;
    const wav = wrapPcmAsWav(pcm, {
      channels: 1,
      sampleRate,
      bitsPerSample: 16,
    });

    return json(200, {
      audioBase64: wav.toString("base64"),
      mimeType: "audio/wav",
      model: MODEL,
      voice,
      sampleRate,
    });
  } catch (error) {
    console.warn("[AI TTS] unexpected failure", {
      code: error.code,
      message: sanitizeError(error.message || ""),
    });
    return json(200, {
      code: error.code || "TTS_UNEXPECTED_ERROR",
      error: sanitizeError(error.message || "AI 음성 생성 중 오류가 발생했습니다."),
      audioUnavailable: true,
    });
  }
};

function buildTtsInput(text, style) {
  const styleLine =
    style === "calm-interviewer"
      ? "차분하고 단정한 한국어 면접관처럼, 질문은 자연스럽고 너무 빠르지 않게 읽어 주세요."
      : "자연스러운 한국어 대화 톤으로 읽어 주세요.";

  return [
    styleLine,
    "불필요한 설명을 추가하지 말고 아래 문장만 음성으로 읽어 주세요.",
    "",
    text,
  ].join("\n");
}

function extractAudio(data) {
  if (!data) return null;
  if (typeof data.output_audio === "string") return { data: data.output_audio };
  if (typeof data.outputAudio === "string") return { data: data.outputAudio };
  if (data.output_audio?.data) return normalizeAudio(data.output_audio);
  if (data.outputAudio?.data) return normalizeAudio(data.outputAudio);
  if (data.output?.audio?.data) return normalizeAudio(data.output.audio);

  return findAudioNode(data);
}

function findAudioNode(value, path = "") {
  if (!value || typeof value !== "object") return null;

  if (typeof value.data === "string" && looksLikeAudioNode(value, path)) {
    return normalizeAudio(value);
  }

  if (value.inlineData?.data) {
    return normalizeAudio(value.inlineData);
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findAudioNode(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    const found = findAudioNode(child, path ? `${path}.${key}` : key);
    if (found) return found;
  }

  return null;
}

function looksLikeAudioNode(value, path) {
  const mimeType = String(value.mimeType || value.mime_type || value.mediaType || "").toLowerCase();
  const type = String(value.type || value.contentType || "").toLowerCase();
  const lowerPath = String(path || "").toLowerCase();
  return (
    mimeType.includes("audio") ||
    type === "audio" ||
    type.includes("audio") ||
    lowerPath.includes("audio") ||
    lowerPath.includes("delta")
  );
}

function normalizeAudio(value) {
  return {
    data: value.data,
    mimeType: value.mimeType || value.mime_type || value.mediaType || "",
  };
}

function summarizeShape(value, depth = 0) {
  if (depth > 3) return "...";
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.slice(0, 3).map((item) => summarizeShape(item, depth + 1));
  }
  if (typeof value !== "object") return typeof value;

  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 12)
      .map(([key, child]) => [key, summarizeShape(child, depth + 1)]),
  );
}

function getSampleRate(mimeType = "") {
  const match = String(mimeType).match(/rate=(\d+)/i);
  return match ? Number(match[1]) : null;
}

function wrapPcmAsWav(pcm, { channels, sampleRate, bitsPerSample }) {
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

function sanitizeVoice(voice) {
  const value = String(voice || DEFAULT_VOICE).trim();
  return /^[A-Za-z0-9_-]{2,40}$/.test(value) ? value : DEFAULT_VOICE;
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
