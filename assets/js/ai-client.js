(function attachPitaAiClient(global) {
  const PRESENTATION_ENDPOINT = "/.netlify/functions/presentation-ai";
  const INTERVIEW_ENDPOINT = "/.netlify/functions/gemini-interview";
  const DEFAULT_TIMEOUT_MS = 28000;

  async function postJson(endpoint, payload, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeoutId = global.setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await response.text();
      let data;

      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(
          text
            ? `AI 응답을 해석하지 못했습니다: ${text.slice(0, 160)}`
            : "AI 서버로부터 빈 응답을 받았습니다.",
        );
      }

      if (!response.ok) {
        const error = new Error(data.error || "AI 요청이 실패했습니다.");
        error.status = response.status;
        error.data = data;
        throw error;
      }

      return data;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("AI 응답 시간이 초과되었습니다. 파일 크기를 줄이거나 다시 시도해주세요.");
      }
      throw error;
    } finally {
      global.clearTimeout(timeoutId);
    }
  }

  function presentationContextFromDom() {
    const type = document.getElementById("presentation-type-select");
    const audience = document.getElementById("audience-select");
    const selectedPurpose = document.querySelector(
      "[data-presentation-branch][aria-pressed='true']",
    );
    const selectedPersona = document.querySelector(
      "[data-persona-value][aria-pressed='true']",
    );

    return {
      presentationType: type?.selectedOptions?.[0]?.textContent?.trim() || type?.value || "",
      purpose:
        selectedPurpose?.querySelector("strong")?.textContent?.trim() ||
        selectedPurpose?.dataset.presentationBranch ||
        "",
      audience:
        audience?.selectedOptions?.[0]?.textContent?.trim() || audience?.value || "",
      personaGuidance:
        selectedPersona?.querySelector("span")?.textContent?.trim() || "",
      targetDurationSeconds: durationFromInputs("presentation-minutes", "presentation-seconds"),
      qaDurationSeconds: durationFromInputs("qa-minutes", "qa-seconds"),
    };
  }

  function durationFromInputs(minutesId, secondsId) {
    const minutes = Number(document.getElementById(minutesId)?.value || 0);
    const seconds = Number(document.getElementById(secondsId)?.value || 0);
    return Math.max(0, Math.round(minutes * 60 + seconds));
  }

  const presentation = {
    generateDraft({ materials = [], context, existingScript = "" } = {}) {
      return postJson(
        PRESENTATION_ENDPOINT,
        {
          task: "draft",
          materials,
          context: context || presentationContextFromDom(),
          existingScript,
        },
        30000,
      );
    },

    generateQuestions({ script, context, count = 6 } = {}) {
      return postJson(PRESENTATION_ENDPOINT, {
        task: "questions",
        script,
        context: context || presentationContextFromDom(),
        count,
      });
    },

    analyze({
      mode,
      script = "",
      mediaBase64 = null,
      mediaMimeType = null,
      context,
      measuredMetrics = {},
      previousSessions = [],
    } = {}) {
      return postJson(
        PRESENTATION_ENDPOINT,
        {
          task: "report",
          mode,
          script,
          mediaBase64,
          mediaMimeType,
          context: context || presentationContextFromDom(),
          measuredMetrics,
          previousSessions,
        },
        30000,
      );
    },
  };

  const interview = {
    generateQuestions(payload = {}) {
      return postJson(INTERVIEW_ENDPOINT, { mode: "questions", ...payload });
    },

    generateReport(payload = {}) {
      return postJson(INTERVIEW_ENDPOINT, { mode: "report", ...payload });
    },
  };

  global.PitaAI = Object.freeze({
    postJson,
    presentation: Object.freeze(presentation),
    interview: Object.freeze(interview),
    presentationContextFromDom,
  });
})(window);
