const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'POST 요청만 지원합니다.' });
  }

  if (!process.env.GEMINI_API_KEY) {
    return json(500, { error: 'Netlify 환경변수 GEMINI_API_KEY가 설정되지 않았습니다.' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: '요청 본문을 JSON으로 해석할 수 없습니다.' });
  }

  if (!payload.transcript || payload.transcript.trim().split(/\s+/).length < 10) {
    return json(400, { error: '분석할 전사 텍스트가 너무 짧습니다.' });
  }

  try {
    const response = await fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: {
        'x-goog-api-key': process.env.GEMINI_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
        system_instruction:
          '당신은 한국어 발표/면접 코치입니다. 사용자의 전사 텍스트와 맥락을 근거로 구체적이고 실행 가능한 피드백을 작성하세요. ' +
          '과장하지 말고, 점수는 관찰 가능한 근거를 바탕으로 0~100 사이로 매기세요. 반드시 JSON만 반환하세요.',
        input: buildPrompt(payload),
        generation_config: {
          temperature: 0.4,
        },
        response_format: {
          type: 'text',
          mime_type: 'application/json',
          schema: reportSchema(),
        },
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return json(response.status, { error: data.error?.message || 'Gemini API 호출에 실패했습니다.' });
    }

    const reportText = data.output_text || extractOutputText(data);
    if (!reportText) {
      return json(502, { error: 'Gemini 응답에서 리포트 본문을 찾지 못했습니다.' });
    }

    return json(200, parseJsonReport(reportText));
  } catch (error) {
    return json(500, { error: error.message || '분석 중 알 수 없는 오류가 발생했습니다.' });
  }
};

function buildPrompt(payload) {
  return JSON.stringify(
    {
      instruction:
        '아래 데이터를 분석해 scores와 sections를 가진 JSON 객체를 반환하세요. ' +
        'scores는 total, delivery, fit, habit 숫자 필드를 포함해야 합니다. ' +
        'sections는 title과 items 문자열 배열을 가진 객체 배열이며, 반드시 한국어로 작성하세요. ' +
        '권장 섹션은 전달력 진단, 말하기 습관 진단, 목적/기업/직무 적합도, 영상 리뷰 피드백, 개선 우선순위 TOP 3입니다.',
      schemaExample: {
        scores: { total: 82, delivery: 80, fit: 84, habit: 78 },
        sections: [
          {
            title: '전달력 진단',
            items: ['구체적인 피드백 1', '구체적인 피드백 2'],
          },
        ],
      },
      sessionType: payload.sessionType,
      purpose: payload.purpose,
      company: payload.company,
      role: payload.role,
      criteria: payload.criteria,
      durationMinutes: payload.durationMinutes,
      visualIssues: payload.visualIssues,
      localSignals: payload.localSignals,
      transcript: payload.transcript,
    },
    null,
    2,
  );
}

function reportSchema() {
  return {
    type: 'object',
    properties: {
      scores: {
        type: 'object',
        properties: {
          total: { type: 'number' },
          delivery: { type: 'number' },
          fit: { type: 'number' },
          habit: { type: 'number' },
        },
        required: ['total', 'delivery', 'fit', 'habit'],
      },
      sections: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            items: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['title', 'items'],
        },
      },
    },
    required: ['scores', 'sections'],
  };
}

function extractOutputText(data) {
  if (typeof data.output_text === 'string') return data.output_text;

  const textFromSteps = data.steps
    ?.flatMap((step) => step.content || step.output || [])
    ?.find((content) => content.type === 'text' && typeof content.text === 'string')
    ?.text;
  if (textFromSteps) return textFromSteps;

  return data.candidates
    ?.flatMap((candidate) => candidate.content?.parts || [])
    ?.find((part) => typeof part.text === 'string')
    ?.text;
}

function parseJsonReport(text) {
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  const parsed = JSON.parse(cleaned);
  return {
    scores: {
      total: clampScore(parsed.scores?.total),
      delivery: clampScore(parsed.scores?.delivery),
      fit: clampScore(parsed.scores?.fit),
      habit: clampScore(parsed.scores?.habit),
    },
    sections: normalizeSections(parsed.sections),
  };
}

function normalizeSections(sections) {
  if (!Array.isArray(sections)) return [];
  return sections.slice(0, 6).map((section) => ({
    title: String(section.title || '분석 결과'),
    items: Array.isArray(section.items)
      ? section.items.slice(0, 5).map((item) => String(item))
      : [],
  }));
}

function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}
