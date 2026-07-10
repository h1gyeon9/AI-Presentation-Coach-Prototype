const API_ENDPOINT = "/.netlify/functions/gemini-interview";
// Interview session, speech, camera, and report logic
const DOCUMENT_ENDPOINT = "/.netlify/functions/parse-document";
const TTS_ENDPOINT = "/.netlify/functions/typecast-tts";
const TTS_CHUNK_MAX_CHARS = 1200;
const NONVERBAL_TICK_MS = 1600;
const NONVERBAL_LOG_EVERY_TICKS = 5;
const NONVERBAL_VIDEO_MAX_BYTES = 3.5 * 1024 * 1024;
const NONVERBAL_VIDEO_STOP_TIMEOUT_MS = 8000;
const NONVERBAL_VIDEO_FLUSH_TIMEOUT_MS = 1500;
const NONVERBAL_VIDEO_FLUSH_INTERVAL_MS = 5000;
const NONVERBAL_VIDEO_FINALIZE_DELAY_MS = 250;
const NONVERBAL_VIDEO_BITRATE = 200000;
const NONVERBAL_AUDIO_BITRATE = 32000;
const NONVERBAL_VIDEO_CONSTRAINTS = {
  width: { ideal: 320 },
  height: { ideal: 240 },
  facingMode: "user",
};
const SILENCE_PROMPT_MS = 10000;
const SESSION_STORAGE_KEY = "interviewCoachSession.v2";
const SHARED_REPORT_PREFIX = "interviewCoachSharedReport.";

const personaLabels = {
  calm: "차분한 구조화 면접관",
  pressure: "압박형 꼬리질문 면접관",
  behavior: "경험 검증형 면접관",
  job: "직무 적합성 중심 면접관",
};

const fallbackQuestions = [
  "먼저 1분 자기소개를 직무 지원 동기와 연결해서 말씀해 주세요.",
  "방금 말씀하신 경험에서 본인이 직접 맡은 역할은 무엇이었나요?",
  "그 경험이 이 회사와 직무에 어떻게 이어진다고 보시나요?",
  "비슷한 상황이 다시 온다면 무엇을 다르게 하시겠습니까?",
  "입사 후 6개월 안에 만들고 싶은 구체적인 성과를 말씀해 주세요.",
];

const state = {
  started: false,
  busy: false,
  voiceEnabled: true,
  resumeText: "",
  resumeName: "",
  messages: [],
  answers: [],
  answerMeta: [],
  recognition: null,
  recognitionSupported: false,
  isRecording: false,
  pendingVoiceText: "",
  textInputMode: false,
  questionStartedAt: null,
  currentAnswerStartedAt: null,
  currentInputMode: "text",
  silenceTimer: null,
  silenceEvents: [],
  pendingRetry: null,
  lastReport: null,
  reportGenerating: false,
  activeReportTab: "language",
  cameraStream: null,
  cameraActive: false,
  nonverbalTimer: null,
  nonverbalTick: 0,
  nonverbalMode: "idle",
  nonverbal: {
    eye: 0,
    posture: 0,
    expression: 0,
    gesture: 0,
  },
  nonverbalHistory: [],
  signalEvents: [],
  nonverbalRecorder: null,
  nonverbalVideoChunks: [],
  nonverbalVideoBytes: 0,
  nonverbalVideoBlob: null,
  nonverbalVideoMimeType: "",
  nonverbalVideoStopPromise: null,
  nonverbalVideoStopResolve: null,
  nonverbalVideoStopTimer: null,
  nonverbalVideoFlushTimer: null,
  nonverbalVideoDiscard: false,
  nonverbalVideoIssue: "",
  ttsAudio: null,
  ttsAudioUrl: "",
  ttsBusy: false,
  ttsRequestId: 0,
  ttsCancel: null,
  ttsWarmPromise: null,
  ttsWarmed: false,
};

const $ = (selector) => document.querySelector(selector);

const elements = {
  resumeFile: $("#resumeFile"),
  fileName: $("#fileName"),
  companyInput: $("#companyInput"),
  roleInput: $("#roleInput"),
  talentInput: $("#talentInput"),
  personaInput: $("#personaInput"),
  depthInput: $("#depthInput"),
  depthOutput: $("#depthOutput"),
  startButton: $("#startButton"),
  chatLog: $("#chatLog"),
  micButton: $("#micButton"),
  liveTranscript: $("#liveTranscript"),
  voiceToggle: $("#voiceToggle"),
  answerForm: $("#answerForm"),
  answerInput: $("#answerInput"),
  sendButton: $("#sendButton"),
  reportButton: $("#reportButton"),
  retryButton: $("#retryButton"),
  shareReportButton: $("#shareReportButton"),
  resetButton: $("#resetButton"),
  apiNotice: $("#apiNotice"),
  reportDashboardRoot: $("#report-dashboard-root"),
  loadingStatus: $("#interview-loading-status"),
  personaSummary: $("#personaSummary"),
  turnMetric: $("#turnMetric"),
  fillerMetric: $("#fillerMetric"),
  voiceMetric: $("#voiceMetric"),
  connectionText: $("#connectionText"),
  connectionPill: $("#connectionPill"),
  cameraStage: $("#cameraStage"),
  cameraPreview: $("#cameraPreview"),
  cameraButton: $("#cameraButton"),
  cameraMode: $("#cameraMode"),
  cameraStatus: $("#cameraStatus"),
  signalFeed: $("#signalFeed"),
  eyeScore: $("#eyeScore"),
  postureScore: $("#postureScore"),
  expressionScore: $("#expressionScore"),
  gestureScore: $("#gestureScore"),
  eyeBar: $("#eyeBar"),
  postureBar: $("#postureBar"),
  expressionBar: $("#expressionBar"),
  gestureBar: $("#gestureBar"),
};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatDuration(ms) {
  if (!ms || ms < 0) return "0초";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}분 ${rest}초`;
}

function clearReportDashboard() {
  elements.reportDashboardRoot.classList.remove("report-dashboard");
  elements.reportDashboardRoot.innerHTML = `
    <p class="rd-empty-note" style="margin:40px;">답변을 한 번 이상 전송하면 리포트를 만들 수 있습니다.</p>
  `;
}

function getReadableError(error) {
  if (error?.name === "AbortError" || error?.code === "TIMEOUT") {
    return "AI 응답 시간이 초과되었습니다. 네트워크 상태를 확인한 뒤 재시도해 주세요.";
  }
  if (error?.code === "MISSING_KEY") {
    return "AI API 키가 설정되지 않았습니다. Netlify 환경변수를 확인해 주세요.";
  }
  if (error?.status === 429) {
    return "AI 사용량 한도 또는 분당 요청 제한에 도달했습니다. API 콘솔에서 결제/쿼터 상태를 확인하거나 잠시 후 다시 시도해 주세요.";
  }
  if (error?.status) {
    return `AI API 오류가 발생했습니다. (${error.status}) ${error.message || ""}`.trim();
  }
  return error?.message?.replace(/Gemini/g, "AI") || "AI 연결에 실패했습니다. 잠시 후 다시 시도해 주세요.";
}

function showApiNotice(message, retryFn = null) {
  elements.apiNotice.hidden = false;
  elements.apiNotice.textContent = `${message} 세션 데이터는 유지됩니다. AI 재시도 버튼을 눌러 다시 연결해 보세요.`;
  state.pendingRetry = retryFn;
  elements.retryButton.hidden = !retryFn;
  persistSession();
}

function hideApiNotice() {
  elements.apiNotice.hidden = true;
  elements.apiNotice.textContent = "";
  state.pendingRetry = null;
  elements.retryButton.hidden = true;
}

function setReportActionsEnabled(enabled) {
  elements.shareReportButton.disabled = !enabled;
}

function getProfile() {
  const interviewType = document.getElementById("interview-type");
  return {
    company: elements.companyInput.value.trim() || "미입력 회사",
    role: elements.roleInput.value.trim() || "미입력 직무",
    talent: elements.talentInput.value.trim() || "미입력 인재상",
    persona: elements.personaInput.value,
    personaLabel: personaLabels[elements.personaInput.value],
    depth: Number(elements.depthInput.value),
    interviewType: interviewType?.selectedOptions?.[0]?.textContent || "미입력 면접 유형",
    resumeName: state.resumeName,
    resumeText: state.resumeText.slice(0, 5000),
  };
}

function setConnection(text, tone = "blue") {
  elements.connectionText.textContent = text;
  const colors = {
    blue: "#3157c9",
    green: "#1f7a5b",
    amber: "#a76612",
    red: "#b42318",
  };
  elements.connectionPill.style.color = colors[tone] || colors.blue;
}

function setNonverbalVideoStatus(message) {
  if (elements.cameraStatus) {
    elements.cameraStatus.textContent = message;
  }
  if (elements.loadingStatus) {
    elements.loadingStatus.textContent = message;
  }
}

function updateMetrics() {
  const analysis = analyzeAnswers();
  elements.turnMetric.textContent = String(state.answers.length);
  elements.fillerMetric.textContent = String(analysis.fillerTotal);
  elements.voiceMetric.textContent = state.ttsBusy ? "AI" : state.voiceEnabled ? "ON" : "OFF";
  elements.reportButton.disabled = state.answers.length === 0;
}

function persistSession() {
  const payload = {
    inputs: {
      company: elements.companyInput.value,
      role: elements.roleInput.value,
      talent: elements.talentInput.value,
      persona: elements.personaInput.value,
      depth: elements.depthInput.value,
      interviewType: document.getElementById("interview-type")?.value || "",
    },
    resumeName: state.resumeName,
    resumeText: state.resumeText,
    messages: state.messages,
    answers: state.answers,
    answerMeta: state.answerMeta,
    silenceEvents: state.silenceEvents,
    lastReport: state.lastReport,
    activeReportTab: state.activeReportTab,
  };
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    // Session persistence is helpful, but the prototype should keep running if storage is blocked.
  }
}

function renderMessages() {
  elements.chatLog.innerHTML = "";
  if (!state.messages.length) {
    addMessage("ai", "면접 시작을 누르면 회사, 직무, 인재상에 맞춰 첫 질문을 드립니다.", false);
    state.messages = [];
    return;
  }

  state.messages.forEach((message) => {
    const item = document.createElement("li");
    item.className = `message ${message.role}`;
    item.innerHTML = `
      <span class="message-label">${message.role === "ai" ? "AI 면접관" : "나"}</span>
      <div class="message-bubble">${escapeHtml(message.text)}</div>
    `;
    elements.chatLog.appendChild(item);
  });
  elements.chatLog.scrollTop = elements.chatLog.scrollHeight;
}

function restoreSession() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SESSION_STORAGE_KEY) || "null");
    if (!saved) return;

    elements.companyInput.value = saved.inputs?.company || elements.companyInput.value;
    elements.roleInput.value = saved.inputs?.role || elements.roleInput.value;
    elements.talentInput.value = saved.inputs?.talent || elements.talentInput.value;
    elements.personaInput.value = saved.inputs?.persona || elements.personaInput.value;
    elements.depthInput.value = saved.inputs?.depth || elements.depthInput.value;
    elements.depthOutput.textContent = elements.depthInput.value;
    const interviewType = document.getElementById("interview-type");
    if (interviewType && saved.inputs?.interviewType) {
      interviewType.value = saved.inputs.interviewType;
    }

    state.resumeName = saved.resumeName || "";
    state.resumeText = saved.resumeText || "";
    elements.fileName.textContent = state.resumeName || "선택된 파일 없음";
    state.messages = saved.messages || [];
    state.answers = saved.answers || [];
    state.answerMeta = saved.answerMeta || [];
    state.silenceEvents = saved.silenceEvents || [];
    state.lastReport = saved.lastReport || null;
    state.activeReportTab = saved.activeReportTab || "language";
    state.started = state.messages.length > 0 || state.answers.length > 0;

    renderMessages();
    if (state.lastReport) {
      renderReport(state.lastReport.analysis, state.lastReport.aiReport);
      setReportActionsEnabled(true);
    }
    updateMetrics();
  } catch (error) {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  }
}

function clearSilenceTimer() {
  window.clearTimeout(state.silenceTimer);
  state.silenceTimer = null;
}

function startSilenceTimer(questionText = "") {
  clearSilenceTimer();
  state.questionStartedAt = Date.now();
  state.currentAnswerStartedAt = null;
  state.currentInputMode = "text";

  state.silenceTimer = window.setTimeout(() => {
    if (!state.started || state.busy || state.currentAnswerStartedAt) return;
    const event = {
      at: Date.now(),
      seconds: Math.round(SILENCE_PROMPT_MS / 1000),
      question: questionText,
    };
    state.silenceEvents.push(event);
    elements.liveTranscript.textContent = "답변 준비가 되셨나요? 준비되면 음성 또는 텍스트로 답변해 주세요.";
    persistSession();
  }, SILENCE_PROMPT_MS);
}

function markAnswerStarted(mode) {
  if (!state.currentAnswerStartedAt) {
    state.currentAnswerStartedAt = Date.now();
    state.currentInputMode = mode;
  }
  clearSilenceTimer();
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function average(values) {
  if (!values.length) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function setSignalValue(scoreElement, barElement, value) {
  scoreElement.textContent = value ? String(value) : "--";
  barElement.style.width = `${value || 0}%`;
  barElement.classList.toggle("low", value > 0 && value < 64);
  barElement.classList.toggle("mid", value >= 64 && value < 78);
}

function renderNonverbalScores() {
  setSignalValue(elements.eyeScore, elements.eyeBar, state.nonverbal.eye);
  setSignalValue(elements.postureScore, elements.postureBar, state.nonverbal.posture);
  setSignalValue(elements.expressionScore, elements.expressionBar, state.nonverbal.expression);
  setSignalValue(elements.gestureScore, elements.gestureBar, state.nonverbal.gesture);

  if (!state.signalEvents.length) {
    elements.signalFeed.innerHTML = "<li>카메라를 켜면 비언어 신호가 표시됩니다.</li>";
    return;
  }

  elements.signalFeed.innerHTML = state.signalEvents
    .slice(0, 4)
    .map((event) => `<li>${escapeHtml(event)}</li>`)
    .join("");
}

function getNonverbalEvent(snapshot) {
  const scores = [
    ["eye", snapshot.eye],
    ["posture", snapshot.posture],
    ["expression", snapshot.expression],
    ["gesture", snapshot.gesture],
  ].sort((a, b) => a[1] - b[1]);
  const [weakestKey, weakestScore] = scores[0];
  const clock = new Date().toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  if (weakestScore >= 82) return `${clock} 전반적인 비언어 안정도 양호`;
  if (weakestKey === "eye") return `${clock} 시선이 화면 밖으로 분산되는 구간 감지`;
  if (weakestKey === "posture") return `${clock} 상체 기울어짐과 어깨 긴장 신호 감지`;
  if (weakestKey === "expression") return `${clock} 표정 변화가 적어 전달 에너지 낮음`;
  return `${clock} 손동작 리듬이 답변 흐름과 어긋나는 구간 감지`;
}

function tickNonverbal() {
  state.nonverbalTick += 1;
  const t = state.nonverbalTick;
  const speakingBoost = state.isRecording ? 8 : 0;
  const demoOffset = state.nonverbalMode === "demo" ? -2 : 2;

  state.nonverbal = {
    eye: clampScore(78 + demoOffset + Math.sin(t / 2.2) * 8 + (Math.random() - 0.5) * 10),
    posture: clampScore(80 + demoOffset + Math.cos(t / 2.8) * 7 + (Math.random() - 0.5) * 8),
    expression: clampScore(74 + demoOffset + Math.sin(t / 1.7) * 9 + (Math.random() - 0.5) * 10),
    gesture: clampScore(
      66 + speakingBoost + demoOffset + Math.sin(t / 2.4) * 12 + (Math.random() - 0.5) * 12,
    ),
  };

  state.nonverbalHistory.unshift({
    ...state.nonverbal,
    mode: state.nonverbalMode,
    at: Date.now(),
  });
  state.nonverbalHistory = state.nonverbalHistory.slice(0, 48);

  if (t === 1 || t % NONVERBAL_LOG_EVERY_TICKS === 0) {
    state.signalEvents.unshift(getNonverbalEvent(state.nonverbal));
    state.signalEvents = state.signalEvents.slice(0, 8);
  }

  renderNonverbalScores();
}

function startNonverbalSession(mode, statusText) {
  window.clearInterval(state.nonverbalTimer);
  state.nonverbalMode = mode;
  state.nonverbalTick = 0;
  state.nonverbalHistory = [];
  state.signalEvents = [];

  elements.cameraStage.classList.toggle("is-live", mode === "live");
  elements.cameraMode.textContent = mode === "live" ? "카메라" : "자동 진행";
  setNonverbalVideoStatus(statusText);
  elements.cameraButton.textContent = mode === "live" ? "카메라 끄기" : "카메라 켜기";

  tickNonverbal();
  state.nonverbalTimer = window.setInterval(tickNonverbal, NONVERBAL_TICK_MS);
}

function getSupportedNonverbalVideoType() {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = ["video/webm"];
  return candidates.find((type) => MediaRecorder.isTypeSupported?.(type)) || "";
}

function clearNonverbalVideoState() {
  window.clearInterval(state.nonverbalVideoFlushTimer);
  state.nonverbalVideoFlushTimer = null;
  state.nonverbalVideoChunks = [];
  state.nonverbalVideoBytes = 0;
  state.nonverbalVideoBlob = null;
  state.nonverbalVideoMimeType = "";
  state.nonverbalVideoIssue = "";
  state.nonverbalVideoDiscard = false;
}

function resolveNonverbalVideoStop() {
  window.clearTimeout(state.nonverbalVideoStopTimer);
  state.nonverbalVideoStopTimer = null;
  window.clearInterval(state.nonverbalVideoFlushTimer);
  state.nonverbalVideoFlushTimer = null;
  if (state.nonverbalVideoStopResolve) {
    state.nonverbalVideoStopResolve();
  }
  state.nonverbalVideoStopPromise = null;
  state.nonverbalVideoStopResolve = null;
}

function waitForNonverbalVideoData(previousBytes = state.nonverbalVideoBytes) {
  return new Promise((resolve) => {
    if (state.nonverbalVideoBytes > previousBytes) {
      resolve(true);
      return;
    }

    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      if (state.nonverbalVideoBytes > previousBytes) {
        window.clearInterval(timer);
        resolve(true);
        return;
      }

      if (Date.now() - startedAt >= NONVERBAL_VIDEO_FLUSH_TIMEOUT_MS) {
        window.clearInterval(timer);
        resolve(false);
      }
    }, 50);
  });
}

function completeNonverbalVideoCapture() {
  const shouldDiscard = state.nonverbalVideoDiscard;
  state.nonverbalRecorder = null;

  if (shouldDiscard) {
    clearNonverbalVideoState();
  } else if (state.nonverbalVideoChunks.length) {
    state.nonverbalVideoBlob = new Blob(state.nonverbalVideoChunks, {
      type: state.nonverbalVideoMimeType || "video/webm",
    });
    state.nonverbalVideoBytes = state.nonverbalVideoBlob.size;
    if (state.cameraActive && state.nonverbalMode === "live") {
      setNonverbalVideoStatus("Gemini 리포트용 영상 샘플 저장 완료");
    }
  } else if (!state.nonverbalVideoIssue) {
    state.nonverbalVideoIssue = "녹화 조각이 생성되지 않았습니다.";
  }

  state.nonverbalVideoDiscard = false;
  resolveNonverbalVideoStop();
}

function stopNonverbalVideoCapture({ discard = false } = {}) {
  state.nonverbalVideoDiscard = state.nonverbalVideoDiscard || discard;

  if (!state.nonverbalRecorder) {
    if (discard) clearNonverbalVideoState();
    return Promise.resolve();
  }

  if (state.nonverbalVideoStopPromise) return state.nonverbalVideoStopPromise;

  state.nonverbalVideoStopPromise = new Promise((resolve) => {
    state.nonverbalVideoStopResolve = resolve;
  });
  const stopPromise = state.nonverbalVideoStopPromise;
  state.nonverbalVideoStopTimer = window.setTimeout(() => {
    if (!state.nonverbalVideoIssue) {
      state.nonverbalVideoIssue = "브라우저가 영상 녹화 종료 이벤트를 반환하지 않았습니다.";
    }
    completeNonverbalVideoCapture();
  }, NONVERBAL_VIDEO_STOP_TIMEOUT_MS);

  try {
    if (state.nonverbalRecorder.state !== "inactive") {
      state.nonverbalRecorder.stop();
    } else {
      completeNonverbalVideoCapture();
    }
  } catch (error) {
    completeNonverbalVideoCapture();
  }

  return stopPromise;
}

async function resetNonverbalVideoCapture() {
  await stopNonverbalVideoCapture({ discard: true });
  clearNonverbalVideoState();
}

async function flushNonverbalVideoCapture() {
  const recorder = state.nonverbalRecorder;
  if (!recorder || recorder.state !== "recording") return false;

  const previousBytes = state.nonverbalVideoBytes;
  try {
    recorder.requestData();
  } catch (error) {
    return false;
  }

  return waitForNonverbalVideoData(previousBytes);
}

function startNonverbalVideoCapture(stream) {
  if (!stream || typeof MediaRecorder === "undefined") {
    setNonverbalVideoStatus("카메라 미리보기 중 · 브라우저 영상 녹화 미지원");
    return;
  }

  clearNonverbalVideoState();
  const mimeType = getSupportedNonverbalVideoType();
  state.nonverbalVideoMimeType = mimeType || "video/webm";

  try {
    const options = {
      videoBitsPerSecond: NONVERBAL_VIDEO_BITRATE,
      audioBitsPerSecond: NONVERBAL_AUDIO_BITRATE,
      ...(mimeType ? { mimeType } : {}),
    };
    const recorder = new MediaRecorder(stream, options);
    state.nonverbalRecorder = recorder;

    recorder.ondataavailable = (event) => {
      if (state.nonverbalVideoDiscard || !event.data?.size) return;
      state.nonverbalVideoChunks.push(event.data);
      state.nonverbalVideoBytes += event.data.size;
      if (state.cameraActive && state.nonverbalMode === "live") {
        setNonverbalVideoStatus(
          `카메라 미리보기 및 Gemini용 영상 샘플 저장 중 · ${Math.round(state.nonverbalVideoBytes / 1024)}KB`,
        );
      }
      if (state.nonverbalVideoBytes >= NONVERBAL_VIDEO_MAX_BYTES && recorder.state === "recording") {
        recorder.stop();
      }
    };

    recorder.onstop = () => {
      window.setTimeout(completeNonverbalVideoCapture, NONVERBAL_VIDEO_FINALIZE_DELAY_MS);
    };
    recorder.onerror = () => {
      setNonverbalVideoStatus("카메라 미리보기 중 · 영상 샘플 저장 실패");
      completeNonverbalVideoCapture();
    };

    recorder.start();
    state.nonverbalVideoFlushTimer = window.setInterval(() => {
      if (recorder.state !== "recording") {
        window.clearInterval(state.nonverbalVideoFlushTimer);
        state.nonverbalVideoFlushTimer = null;
        return;
      }
      try {
        recorder.requestData();
      } catch (error) {
        // requestData는 브라우저별로 실패할 수 있으므로 리포트 생성 시 stop flush를 한 번 더 시도한다.
      }
    }, NONVERBAL_VIDEO_FLUSH_INTERVAL_MS);
    setNonverbalVideoStatus("카메라 미리보기 및 Gemini용 영상 샘플 저장 중");
  } catch (error) {
    state.nonverbalRecorder = null;
    clearNonverbalVideoState();
    setNonverbalVideoStatus("카메라 미리보기 중 · 영상 샘플 저장 불가");
  }
}

async function prepareNonverbalVideoPayload() {
  if (state.nonverbalRecorder?.state === "recording") {
    setNonverbalVideoStatus("Gemini 리포트용 영상 샘플 정리 중");
    await flushNonverbalVideoCapture();
    await stopNonverbalVideoCapture();
  }

  if (!state.nonverbalVideoBlob?.size) {
    if (!state.nonverbalVideoIssue) {
      state.nonverbalVideoIssue = state.cameraActive
        ? "카메라는 켜져 있었지만 브라우저가 영상 샘플을 저장하지 못했습니다."
        : "카메라가 꺼져 있어 영상 샘플이 없습니다.";
    }
    return null;
  }
  return {
    mediaBase64: await fileToBase64(state.nonverbalVideoBlob),
    mediaMimeType: state.nonverbalVideoBlob.type || state.nonverbalVideoMimeType || "video/webm",
    size: state.nonverbalVideoBlob.size,
  };
}

function stopNonverbalSession(clearHistory = false) {
  window.clearInterval(state.nonverbalTimer);
  state.nonverbalTimer = null;
  state.nonverbalMode = "idle";
  elements.cameraStage.classList.remove("is-live");
  elements.cameraMode.textContent = "대기";
  setNonverbalVideoStatus(
    clearHistory
      ? "카메라 대기 중"
      : "카메라가 꺼졌습니다. 마지막 신호가 리포트에 반영됩니다.",
  );
  elements.cameraButton.textContent = "카메라 켜기";

  if (clearHistory) {
    state.nonverbal = { eye: 0, posture: 0, expression: 0, gesture: 0 };
    state.nonverbalHistory = [];
    state.signalEvents = [];
  }

  renderNonverbalScores();
}

async function startCamera() {
  if (state.cameraActive) {
    stopCamera(false);
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    startNonverbalSession("demo", "카메라 API를 사용할 수 없어 자동으로 진행합니다");
    return;
  }

  setNonverbalVideoStatus("카메라 권한 확인 중");
  elements.cameraButton.disabled = true;

  try {
    let stream;
    let videoOnlyFallback = false;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: NONVERBAL_VIDEO_CONSTRAINTS,
        audio: true,
      });
    } catch (error) {
      stream = await navigator.mediaDevices.getUserMedia({
        video: NONVERBAL_VIDEO_CONSTRAINTS,
        audio: false,
      });
      videoOnlyFallback = true;
    }
    state.cameraStream = stream;
    state.cameraActive = true;
    elements.cameraPreview.srcObject = stream;
    await elements.cameraPreview.play().catch(() => {});
    startNonverbalSession("live", "카메라 미리보기 및 Gemini용 영상 샘플 저장 중");
    startNonverbalVideoCapture(stream);
    if (videoOnlyFallback) {
      state.nonverbalVideoIssue =
        "마이크 권한을 얻지 못해 video-only 녹화로 시도했습니다.";
    }
  } catch (error) {
    state.cameraActive = false;
    state.cameraStream = null;
    elements.cameraPreview.srcObject = null;
    startNonverbalSession("demo", "카메라 권한이 없어 자동으로 진행합니다");
  } finally {
    elements.cameraButton.disabled = false;
  }
}

function stopCamera(clearHistory = false) {
  stopNonverbalVideoCapture({ discard: clearHistory });
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach((track) => track.stop());
  }
  state.cameraStream = null;
  state.cameraActive = false;
  elements.cameraPreview.srcObject = null;
  stopNonverbalSession(clearHistory);
}

function analyzeNonverbal() {
  if (!state.nonverbalHistory.length) return null;
  const history = state.nonverbalHistory;
  const averages = {
    eye: average(history.map((item) => item.eye)),
    posture: average(history.map((item) => item.posture)),
    expression: average(history.map((item) => item.expression)),
    gesture: average(history.map((item) => item.gesture)),
  };
  const entries = Object.entries(averages).sort((a, b) => a[1] - b[1]);
  const labelMap = {
    eye: "시선",
    posture: "자세",
    expression: "표정",
    gesture: "제스처",
  };
  const observations = [];

  if (averages.eye < 72) observations.push("시선이 자주 분산되어 답변 신뢰감이 약해 보일 수 있습니다.");
  else observations.push("시선 접촉은 전반적으로 안정적인 편입니다.");

  if (averages.posture < 72) observations.push("상체 중심이 흔들려 긴장감이 크게 보이는 구간이 있습니다.");
  else observations.push("자세 안정도는 면접 화면에 적합한 수준입니다.");

  if (averages.expression < 72) observations.push("표정 변화가 적어 강점 설명의 에너지가 낮게 보일 수 있습니다.");
  else observations.push("표정 반응은 자연스럽게 유지되고 있습니다.");

  if (averages.gesture < 68) observations.push("손동작이 적어 핵심 문장을 강조하는 힘이 약할 수 있습니다.");
  else if (averages.gesture > 88) observations.push("제스처가 다소 많아 시선이 분산될 수 있습니다.");
  else observations.push("제스처 리듬은 답변 흐름과 무난하게 맞습니다.");

  return {
    score: average(Object.values(averages)),
    averages,
    weakest: labelMap[entries[0][0]],
    weakestScore: entries[0][1],
    observations,
    mode: state.nonverbalMode,
    samples: history.length,
  };
}

function setBusy(isBusy) {
  state.busy = isBusy;
  elements.startButton.disabled = isBusy;
  elements.sendButton.disabled = isBusy || !state.started;
  elements.answerInput.disabled = isBusy || !state.started;
  elements.micButton.disabled =
    isBusy || !state.started || !state.recognitionSupported || state.textInputMode;
  if (isBusy) {
    elements.liveTranscript.textContent = "AI 면접관이 다음 질문을 준비 중입니다.";
  } else if (state.started) {
    elements.liveTranscript.textContent = state.recognitionSupported && !state.textInputMode
      ? "REC 버튼을 눌러 답변하세요."
      : "텍스트 입력 모드입니다. 답변을 입력한 뒤 전송하세요.";
  }
}

function addMessage(role, text, shouldPersist = true) {
  state.messages.push({ role, text });
  const item = document.createElement("li");
  item.className = `message ${role}`;
  item.innerHTML = `
    <span class="message-label">${role === "ai" ? "AI 면접관" : "나"}</span>
    <div class="message-bubble">${escapeHtml(text)}</div>
  `;
  elements.chatLog.appendChild(item);
  elements.chatLog.scrollTop = elements.chatLog.scrollHeight;
  if (shouldPersist) persistSession();
}

function clearChat() {
  state.messages = [];
  state.answers = [];
  state.answerMeta = [];
  state.silenceEvents = [];
  state.lastReport = null;
  elements.chatLog.innerHTML = "";
  addMessage("ai", "면접 시작을 누르면 회사, 직무, 인재상에 맞춰 첫 질문을 드립니다.");
  state.messages = [];
  updateMetrics();
  setReportActionsEnabled(false);
  persistSession();
}

function stopTtsPlayback() {
  state.ttsRequestId += 1;
  state.ttsBusy = false;
  if (state.ttsAudio) {
    state.ttsAudio.pause();
    state.ttsAudio.removeAttribute("src");
    state.ttsAudio.load();
    state.ttsAudio = null;
  }
  if (state.ttsAudioUrl) {
    URL.revokeObjectURL(state.ttsAudioUrl);
    state.ttsAudioUrl = "";
  }
  if (state.ttsCancel) {
    state.ttsCancel();
    state.ttsCancel = null;
  }
  updateMetrics();
}

function setAnswerReadyStatus() {
  if (!state.started) return;
  elements.liveTranscript.textContent = state.recognitionSupported && !state.textInputMode
    ? "REC 버튼을 눌러 답변하세요."
    : "텍스트 입력 모드입니다. 답변을 입력하고 전송하세요.";
}

function splitLongTtsPart(part) {
  const chunks = [];
  let rest = String(part || "").trim();

  while (rest.length > TTS_CHUNK_MAX_CHARS) {
    const slice = rest.slice(0, TTS_CHUNK_MAX_CHARS);
    const breakAt = Math.max(
      slice.lastIndexOf(" "),
      slice.lastIndexOf(","),
      slice.lastIndexOf("，"),
      slice.lastIndexOf("、"),
    );
    const cut = breakAt > TTS_CHUNK_MAX_CHARS * 0.6 ? breakAt + 1 : TTS_CHUNK_MAX_CHARS;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) chunks.push(rest);
  return chunks;
}

function getTtsChunks(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const sentences = normalized.match(/[^.!?。？！]+[.!?。？！]?/g) || [normalized];
  const chunks = [];
  let current = "";

  sentences.forEach((sentence) => {
    splitLongTtsPart(sentence).forEach((part) => {
      const next = current ? `${current} ${part}` : part;
      if (next.length <= TTS_CHUNK_MAX_CHARS) {
        current = next;
        return;
      }
      if (current) chunks.push(current);
      current = part;
    });
  });

  if (current) chunks.push(current);
  return chunks;
}

async function requestTtsAudio(text) {
  const spokenText = String(text || "").replace(/\s+/g, " ").trim();
  if (!spokenText) return { audioUnavailable: true };
  const response = await fetch(TTS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: spokenText,
      voice: "Kore",
      style: "calm-interviewer",
    }),
  });
  const contentType = response.headers.get("Content-Type") || "";
  if (response.ok && contentType.includes("audio/")) {
    const blob = await response.blob();
    return {
      audioUrl: URL.createObjectURL(blob),
      mimeType: contentType,
    };
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "AI 음성 생성에 실패했습니다.");
    error.status = response.status;
    throw error;
  }
  return { ...data, audioUnavailable: true };
}

async function playTtsAudio(audioUrl, requestId, isFinalChunk) {
  const audio = new Audio(audioUrl);
  state.ttsAudioUrl = audioUrl;
  state.ttsAudio = audio;
  audio.onplay = () => {
    elements.liveTranscript.textContent = "AI 음성을 재생 중입니다.";
  };

  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      state.ttsCancel = null;
      if (state.ttsAudio === audio) {
        state.ttsAudio = null;
        if (state.ttsAudioUrl) {
          URL.revokeObjectURL(state.ttsAudioUrl);
          state.ttsAudioUrl = "";
        }
        if (requestId === state.ttsRequestId) {
          if (isFinalChunk) {
            state.ttsBusy = false;
            if (state.started && !state.busy) {
              setAnswerReadyStatus();
            }
          }
          updateMetrics();
        }
      }
      resolve();
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      state.ttsCancel = null;
      reject(error);
    };
    state.ttsCancel = finish;
    audio.onended = finish;
    audio.onerror = () => fail(new Error("AI 음성 재생에 실패했습니다."));
    audio.play().catch(fail);
  });
}

function warmTts() {
  if (!state.voiceEnabled || state.ttsWarmed || state.ttsWarmPromise) return state.ttsWarmPromise;
  state.ttsWarmed = true;
  state.ttsWarmPromise = fetch(TTS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      warmup: true,
    }),
  })
    .then((response) => response.arrayBuffer())
    .catch(() => null)
    .finally(() => {
      state.ttsWarmPromise = null;
    });
  return state.ttsWarmPromise;
}

async function speak(text) {
  if (!state.voiceEnabled || !text) return;
  const chunks = getTtsChunks(text);
  if (!chunks.length) return;
  stopTtsPlayback();
  const requestId = state.ttsRequestId;
  state.ttsBusy = true;
  elements.liveTranscript.textContent = "AI 음성을 생성하고 있습니다.";
  updateMetrics();

  try {
    for (let index = 0; index < chunks.length; index += 1) {
      const data = await requestTtsAudio(chunks[index]);
      if (requestId !== state.ttsRequestId || !state.voiceEnabled) return;
      if (data.audioUnavailable) {
        state.ttsBusy = false;
        setAnswerReadyStatus();
        updateMetrics();
        return;
      }

      await playTtsAudio(data.audioUrl, requestId, index === chunks.length - 1);
      if (requestId !== state.ttsRequestId || !state.voiceEnabled) return;
    }
  } catch (error) {
    if (requestId !== state.ttsRequestId) return;
    if (state.ttsAudio) {
      state.ttsAudio.pause();
      state.ttsAudio.removeAttribute("src");
      state.ttsAudio = null;
    }
    if (state.ttsAudioUrl) {
      URL.revokeObjectURL(state.ttsAudioUrl);
      state.ttsAudioUrl = "";
    }
    state.ttsCancel = null;
    state.ttsBusy = false;
    setAnswerReadyStatus();
    updateMetrics();
  }
}

function switchToTextMode(message) {
  state.textInputMode = true;
  elements.micButton.disabled = true;
  elements.answerInput.disabled = !state.started;
  elements.sendButton.disabled = !state.started;
  elements.liveTranscript.textContent = message;
  persistSession();
}

function setupSpeechRecognition() {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  state.recognitionSupported = Boolean(SpeechRecognition);

  if (!SpeechRecognition) {
    switchToTextMode("이 브라우저는 음성 인식을 지원하지 않습니다. 텍스트 입력 모드로 전환합니다.");
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = "ko-KR";
  recognition.interimResults = true;
  recognition.continuous = false;

  recognition.onstart = () => {
    state.isRecording = true;
    state.pendingVoiceText = "";
    markAnswerStarted("voice");
    elements.micButton.classList.add("mic-active");
    elements.micButton.textContent = "STOP";
    elements.liveTranscript.classList.add("mic-active");
    elements.liveTranscript.textContent = "듣고 있습니다.";
  };

  recognition.onresult = (event) => {
    let finalText = "";
    let interimText = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalText += transcript;
      } else {
        interimText += transcript;
      }
    }
    state.pendingVoiceText = `${state.pendingVoiceText} ${finalText}`.trim();
    const visibleText = [state.pendingVoiceText, interimText].filter(Boolean).join(" ");
    elements.liveTranscript.textContent = visibleText || "듣고 있습니다.";
  };

  recognition.onerror = (event) => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      switchToTextMode("마이크 권한이 허용되지 않아 텍스트 입력 모드로 자동 전환했습니다.");
      return;
    }

    elements.liveTranscript.textContent = "음성 인식이 중단되었습니다. 다시 시도하거나 직접 입력하세요.";
  };

  recognition.onend = () => {
    state.isRecording = false;
    elements.micButton.classList.remove("mic-active");
    elements.micButton.textContent = "REC";
    elements.liveTranscript.classList.remove("mic-active");

    const text = state.pendingVoiceText.trim();
    state.pendingVoiceText = "";
    if (text) {
      handleAnswer(text);
    } else if (state.started && !state.busy) {
      elements.liveTranscript.textContent = "인식된 답변이 없습니다. 다시 말하거나 직접 입력하세요.";
    }
  };

  state.recognition = recognition;
}

async function readResumeFile(file) {
  state.resumeName = file ? file.name : "";
  state.resumeText = "";
  elements.fileName.textContent = file ? file.name : "선택된 파일 없음";

  if (!file) {
    persistSession();
    return;
  }

  const textLike =
    file.type.startsWith("text/") ||
    file.name.toLowerCase().endsWith(".txt") ||
    file.name.toLowerCase().endsWith(".md");

  if (!textLike) {
    const lowerName = file.name.toLowerCase();
    const supportedDocument = lowerName.endsWith(".pdf") || lowerName.endsWith(".docx");
    if (!supportedDocument) {
      state.resumeText = `[지원하지 않는 첨부 파일 형식: ${file.name}]`;
      elements.fileName.textContent = `${file.name} · 지원 형식은 PDF, DOCX, TXT, MD입니다.`;
      persistSession();
      return;
    }

    elements.fileName.textContent = `${file.name} · 텍스트 추출 중`;
    try {
      const parsed = await parseResumeDocument(file);
      state.resumeText = parsed.text || `[첨부 파일: ${file.name}]`;
      elements.fileName.textContent = `${file.name} · ${parsed.method || "텍스트 추출 완료"}`;
    } catch (error) {
      state.resumeText = `[첨부 파일: ${file.name}]`;
      elements.fileName.textContent = `${file.name} · Netlify 배포 후 PDF/DOCX 텍스트 추출 가능`;
      showApiNotice("자기소개서 텍스트 추출 함수에 연결하지 못했습니다.", () => readResumeFile(file));
    }
    persistSession();
    return;
  }

  try {
    state.resumeText = await file.text();
    elements.fileName.textContent = `${file.name} · 텍스트 추출 완료`;
  } catch (error) {
    state.resumeText = `[첨부 파일을 읽지 못했습니다: ${file.name}]`;
  }
  persistSession();
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(dataUrlToBase64(result));
    };
    reader.onerror = () => reject(reader.error || new Error("파일을 읽지 못했습니다."));
    reader.readAsDataURL(file);
  });
}

function dataUrlToBase64(value) {
  const text = String(value || "");
  const marker = "base64,";
  const markerIndex = text.indexOf(marker);
  if (markerIndex !== -1) return text.slice(markerIndex + marker.length);
  const commaIndex = text.lastIndexOf(",");
  return commaIndex !== -1 ? text.slice(commaIndex + 1) : text;
}

async function parseResumeDocument(file) {
  const base64 = await fileToBase64(file);
  const response = await fetch(DOCUMENT_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: file.name,
      contentType: file.type,
      data: base64,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "문서 파싱 실패");
  }
  return data;
}

async function callGemini(mode, payload) {
  const controller = new AbortController();
  const timeoutMs = mode === "report" ? 28000 : 18000;
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(API_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, ...payload }),
      signal: controller.signal,
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || "AI request failed");
      error.status = response.status;
      error.code = data.code || (response.status === 500 && /GEMINI_API_KEY/.test(data.error || "") ? "MISSING_KEY" : "API_ERROR");
      throw error;
    }
    setConnection("AI 연결됨", "green");
    hideApiNotice();
    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      error.code = "TIMEOUT";
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function fallbackInterviewerQuestion(latestAnswer) {
  const turnIndex = state.answers.length;
  const answer = latestAnswer || "";
  if (!answer) return fallbackQuestions[0];
  if (answer.length < 70) {
    return "조금 더 구체적으로 말씀해 주세요. 어떤 상황에서 어떤 행동을 하셨고 결과가 무엇이었나요?";
  }
  if (!/(결과|성과|수치|증가|감소|개선|달성|전환|완료)/.test(answer)) {
    return "그 경험의 결과를 수치나 변화로 설명한다면 어떻게 말할 수 있을까요?";
  }
  if (!/(제가|저는|맡아|주도|기여|설계|분석|제안)/.test(answer)) {
    return "그 과정에서 지원자님이 직접 책임진 부분은 어디까지였나요?";
  }
  return fallbackQuestions[Math.min(turnIndex, fallbackQuestions.length - 1)];
}

async function requestInterviewer(latestAnswer = "") {
  setBusy(true);
  clearSilenceTimer();
  warmTts();
  const profile = getProfile();
  elements.personaSummary.textContent = `${profile.company} · ${profile.role} · ${profile.personaLabel}`;

  try {
    const data = await callGemini("turn", {
      profile,
      latestAnswer,
      messages: state.messages.slice(-10),
    });
    const reply = data.reply || data.text || fallbackInterviewerQuestion(latestAnswer);
    addMessage("ai", reply);
    await speak(reply);
    startSilenceTimer(reply);
  } catch (error) {
    const message = getReadableError(error);
    setConnection("AI 연결 실패", "red");
    showApiNotice(message, () => requestInterviewer(latestAnswer));
    const reply = fallbackInterviewerQuestion(latestAnswer);
    addMessage("ai", reply);
    await speak(reply);
    startSilenceTimer(reply);
  } finally {
    setBusy(false);
    updateMetrics();
    persistSession();
  }
}

async function startInterview() {
  if (state.busy) return;
  stopTtsPlayback();
  state.started = true;
  state.answers = [];
  state.answerMeta = [];
  state.messages = [];
  state.silenceEvents = [];
  state.lastReport = null;
  state.activeReportTab = "language";
  elements.chatLog.innerHTML = "";
  clearReportDashboard();
  hideApiNotice();
  setReportActionsEnabled(false);
  elements.answerInput.value = "";
  elements.answerInput.disabled = false;
  elements.sendButton.disabled = false;
  elements.micButton.disabled = !state.recognitionSupported || state.textInputMode;
  await resetNonverbalVideoCapture();
  if (state.cameraActive) {
    startNonverbalVideoCapture(state.cameraStream);
  }
  updateMetrics();
  persistSession();
  await requestInterviewer("");
}

function recordUserAnswer(text, mode = state.currentInputMode || "text") {
  const answeredAt = Date.now();
  const startedAt = state.currentAnswerStartedAt || answeredAt;
  const durationMs = Math.max(1000, answeredAt - startedAt);
  const latencyMs = state.questionStartedAt ? Math.max(0, startedAt - state.questionStartedAt) : 0;

  clearSilenceTimer();
  addMessage("user", text);
  state.answers.push(text);
  state.answerMeta.push({
    text,
    mode,
    startedAt,
    endedAt: answeredAt,
    durationMs,
    latencyMs,
  });
  state.currentAnswerStartedAt = null;
  state.currentInputMode = "text";
  updateMetrics();
  persistSession();
}

async function handleAnswer(rawText) {
  const text = rawText.trim();
  if (!text || state.busy) return;
  if (!state.started) {
    state.started = true;
  }
  elements.answerInput.value = "";

  recordUserAnswer(text);
  await requestInterviewer(text);
}

function countMatches(text, regex) {
  return (text.match(regex) || []).length;
}

function topCountItems(items, limit) {
  return items
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function getRepeatedExpressions(text) {
  const stopwords = new Set(["그리고", "그래서", "저는", "제가", "이", "그", "좀", "더", "수", "것", "때", "를", "을"]);
  const words = text
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2 && !stopwords.has(word));
  const counts = new Map();

  words.forEach((word) => counts.set(word, (counts.get(word) || 0) + 1));
  for (let i = 0; i < words.length - 1; i += 1) {
    const phrase = `${words[i]} ${words[i + 1]}`;
    counts.set(phrase, (counts.get(phrase) || 0) + 1);
  }

  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .filter((item) => item.count > 1)
    .sort((a, b) => b.count - a.count || a.label.length - b.label.length)
    .slice(0, 5);
}

function getConversationPairs() {
  const pairs = [];
  let currentQuestion = null;

  state.messages.forEach((message) => {
    if (message.role === "ai") {
      currentQuestion = message.text;
      return;
    }
    if (message.role === "user") {
      pairs.push({
        question: currentQuestion || "질문 기록 없음",
        answer: message.text,
      });
      currentQuestion = null;
    }
  });

  return pairs;
}

function evaluateAnswer(answer) {
  const logic = countMatches(answer, /(왜냐하면|따라서|그래서|결과적으로|예를 들어|첫째|둘째|근거|문제|해결|결과|배운)/g);
  const evidence = countMatches(answer, /(\d+|퍼센트|%|명|건|회|개월|주|매출|전환|유지율|시간|비용)/g);
  const roleSignal = countMatches(answer, /(제가|저는|맡아|주도|기여|설계|분석|제안|개선|협업)/g);
  const score = Math.min(100, Math.round(35 + logic * 12 + evidence * 14 + roleSignal * 7 + answer.length / 12));
  const feedback = [];

  if (logic === 0) feedback.push("상황-행동-결과의 연결어가 부족합니다.");
  if (evidence === 0) feedback.push("성과를 보여줄 수치나 규모가 부족합니다.");
  if (roleSignal === 0) feedback.push("본인이 직접 맡은 역할이 더 분명해야 합니다.");
  if (!feedback.length) feedback.push("질문 의도에 맞춰 구조와 근거가 비교적 잘 드러납니다.");

  return { score, feedback };
}

function getJobFitMappings() {
  const profile = getProfile();
  const source = `${profile.role} ${profile.talent}`;
  const keywords = source
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 2)
    .slice(0, 12);
  const joined = state.answers.join(" ");

  return keywords.slice(0, 8).map((keyword) => ({
    keyword,
    matched: joined.includes(keyword),
  }));
}

function analyzeAnswers() {
  const joined = state.answers.join(" ");
  const fillerItems = [
    ["음", /(^|[\s,.!?])음+($|[\s,.!?])/g],
    ["어", /(^|[\s,.!?])어+($|[\s,.!?])/g],
    ["그", /(^|[\s,.!?])그($|[\s,.!?])/g],
    ["약간", /약간/g],
    ["이제", /이제/g],
    ["뭔가", /뭔가/g],
    ["같아요", /같아요/g],
    ["사실", /사실/g],
  ].map(([label, regex]) => ({ label, count: countMatches(joined, regex) }));

  const fillerTotal = fillerItems.reduce((sum, item) => sum + item.count, 0);
  const repeatedExpressions = getRepeatedExpressions(joined);
  const answerDurations = state.answerMeta.map((item) => item.durationMs).filter(Boolean);
  const avgAnswerTimeMs = answerDurations.length ? average(answerDurations) : 0;
  const avgLatencyMs = state.answerMeta.length
    ? average(state.answerMeta.map((item) => item.latencyMs || 0))
    : 0;
  const conversationPairs = getConversationPairs();
  const questionEvaluations = conversationPairs.map((pair, index) => ({
    index: index + 1,
    question: pair.question,
    answer: pair.answer,
    ...evaluateAnswer(pair.answer),
  }));
  const wordCount = joined.trim() ? joined.trim().split(/\s+/).length : 0;
  const avgLength = state.answers.length
    ? Math.round(joined.length / state.answers.length)
    : 0;
  const logicSignals = countMatches(
    joined,
    /(왜냐하면|따라서|그래서|결과적으로|예를 들어|첫째|둘째|근거|문제|해결|결과|배운)/g,
  );
  const evidenceSignals = countMatches(
    joined,
    /(\d+|퍼센트|%|명|건|회|개월|주|매출|전환|유지율|시간|비용)/g,
  );
  const fillerRate = wordCount ? Math.round((fillerTotal / wordCount) * 100) : 0;
  const structureScore = Math.min(100, 42 + logicSignals * 8 + evidenceSignals * 6);
  const deliveryScore = Math.max(30, Math.min(100, 92 - fillerTotal * 5));
  const specificityScore = Math.min(100, 38 + evidenceSignals * 12 + avgLength / 8);

  return {
    fillerItems,
    topFillers: topCountItems(fillerItems, 3),
    fillerTotal,
    fillerRate,
    repeatedExpressions,
    avgAnswerTimeMs,
    avgLatencyMs,
    silenceEvents: state.silenceEvents,
    answerMeta: state.answerMeta,
    conversationPairs,
    questionEvaluations,
    jobFitMappings: getJobFitMappings(),
    wordCount,
    avgLength,
    logicSignals,
    evidenceSignals,
    structureScore: Math.round(structureScore),
    deliveryScore: Math.round(deliveryScore),
    specificityScore: Math.round(specificityScore),
  };
}

function buildInterviewReportModel(analysis, aiReport) {
  const overall = Math.round(
    average([analysis.structureScore || 0, analysis.deliveryScore || 0, analysis.specificityScore || 0]),
  );
  const nonverbal = analyzeNonverbal();
  const nonverbalAvg = (key) => (nonverbal?.averages?.[key] ? Math.round(nonverbal.averages[key]) : 0);
  const nonverbalOverall = nonverbal ? Math.round(nonverbal.score) : 0;
  const hasAiNonverbal = Boolean(aiReport?.nonverbalFeedback?.length);
  const hasVideo = Boolean(state.nonverbalVideoBlob?.size);
  const dateLabel = new Date().toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" });
  const personaLabel = document.getElementById("personaInput")?.selectedOptions?.[0]?.textContent || "가상 면접관";
  const emojiIndex = overall >= 80 ? 1 : overall >= 60 ? 3 : overall >= 40 ? 0 : 2;
  const improvementTexts = aiReport?.improvements?.length
    ? aiReport.improvements
    : aiReport?.contentFeedback?.length
      ? aiReport.contentFeedback
      : [];
  const radarLabels = ["논리성", "전달력", "구체성", "시선처리", "자세", "표정"];
  const radarMine = [
    analysis.structureScore || 0,
    analysis.deliveryScore || 0,
    analysis.specificityScore || 0,
    nonverbalAvg("eye"),
    nonverbalAvg("posture"),
    nonverbalAvg("expression"),
  ];
  const radarAvg = [62, 62, 62, 62, 62, 62];

  return {
    title: "면접 분석 결과",
    meta: `${dateLabel} · ${personaLabel} · 답변 ${state.answers.length}건`,
    userName: "김면접",
    userSub: `${personaLabel} 코칭`,
    sessionBadge: dateLabel,
    defaultTab: "report",
    tabs: [
      { id: "report", label: "종합 레포트" },
      { id: "ai", label: "AI 분석 상세" },
      { id: "video", label: "영상 분석" },
    ],
    report: {
      coaching: {
        title: aiReport?.summary || "답변을 분석해 핵심 포인트를 정리했습니다",
        activeIndex: emojiIndex,
        body: improvementTexts[0] || (aiReport?.strengths || [])[0] || "리포트를 생성하면 코칭 포인트가 표시됩니다.",
      },
      voice: {
        cardTitle: "🗣️ 답변 습관 분석",
        seed: (analysis.wordCount || 0) + overall + 10,
        stats: [
          { value: formatDuration(analysis.avgAnswerTimeMs), label: "평균 답변 시간" },
          { value: formatDuration(analysis.avgLatencyMs), label: "평균 준비 시간" },
          { value: `${state.answers.length}건`, label: "총 답변 수" },
        ],
        bars: [
          { label: "논리 구조", value: analysis.structureScore || 0, color: "#00e5e5" },
          { label: "전달 안정감", value: analysis.deliveryScore || 0, color: "#00c9a7" },
          { label: "구체성", value: analysis.specificityScore || 0, color: "#ffa502" },
          { label: "추임새 억제", value: Math.max(0, 100 - (analysis.fillerRate || 0)), color: "#5352ed" },
        ],
      },
      content: {
        donutPct: overall,
        subScores: [
          { label: "논리 구조", score: analysis.structureScore || 0, color: "#00e5e5" },
          { label: "구체성", score: analysis.specificityScore || 0, color: "#00c9a7" },
          { label: "전달 안정감", score: analysis.deliveryScore || 0, color: "#ffa502" },
        ],
        note: aiReport?.summary || (analysis.questionEvaluations?.[0]?.feedback || []).join(" ") || "",
      },
      radar: {
        labels: radarLabels,
        mine: radarMine,
        avg: radarAvg,
        badges: [
          { label: "논리성", value: analysis.structureScore || 0, color: "#00e5e5" },
          { label: "전달력", value: analysis.deliveryScore || 0, color: "#00c9a7" },
          { label: "구체성", value: analysis.specificityScore || 0, color: "#ffa502" },
        ],
        note: hasVideo ? "" : "카메라를 켜고 면접을 진행하면 시선/자세/표정 지표가 채워집니다.",
      },
      scoreSummary: {
        big: overall,
        items: [
          { label: "내용", value: analysis.structureScore || 0, color: "#00e5e5" },
          { label: "전달", value: analysis.deliveryScore || 0, color: "#00c9a7" },
          { label: "구체성", value: analysis.specificityScore || 0, color: "#ffa502" },
          { label: "태도", value: nonverbalOverall, color: "#5352ed" },
        ],
      },
    },
    ai: {
      subtitle: "질문/답변 기반 심층 분석",
      metrics: [
        { label: "논리 구조", value: analysis.structureScore || 0, color: "#00e5e5" },
        { label: "전달 안정감", value: analysis.deliveryScore || 0, color: "#00c9a7" },
        { label: "구체성", value: analysis.specificityScore || 0, color: "#ffa502" },
        { label: "시선 처리", value: nonverbalAvg("eye"), color: "#5352ed" },
        { label: "자세", value: nonverbalAvg("posture"), color: "#00e5e5" },
        { label: "표정", value: nonverbalAvg("expression"), color: "#00c9a7" },
        { label: "제스처", value: nonverbalAvg("gesture"), color: "#ffa502" },
      ],
      radar: { labels: radarLabels, mine: radarMine, avg: radarAvg },
      insights: (improvementTexts.length ? improvementTexts : aiReport?.languageHabits || [])
        .slice(0, 5)
        .map((text, index) => ({ title: `개선 포인트 ${index + 1}`, body: text })),
      historyNote: null,
    },
    video: {
      objectUrl: hasVideo ? URL.createObjectURL(state.nonverbalVideoBlob) : null,
      emptyNote: hasVideo ? "" : state.nonverbalVideoIssue || "카메라 영상 샘플이 없어 영상 재생을 지원하지 않습니다.",
      scores: [
        { label: "시선", value: nonverbalAvg("eye"), color: "#00e5e5" },
        { label: "자세", value: nonverbalAvg("posture"), color: "#00c9a7" },
        { label: "표정/제스처", value: Math.round((nonverbalAvg("expression") + nonverbalAvg("gesture")) / 2), color: "#ffa502" },
      ],
      feedback: hasAiNonverbal
        ? aiReport.nonverbalFeedback.map((text) => ({ text }))
        : (nonverbal?.observations || []).map((text) => ({ text, tone: "warn" })),
      emptyFeedbackNote: hasAiNonverbal
        ? ""
        : nonverbal
          ? "로컬 시뮬레이션 기준 비언어 신호 요약입니다."
          : "카메라를 켜고 면접을 진행하면 비언어 신호가 표시됩니다.",
    },
    actions: {
      shareLabel: "공유하기",
      resetLabel: "다시 연습하기",
      onShare: () => elements.shareReportButton.click(),
      onReset: () => document.getElementById("interview-restart").click(),
    },
  };
}

function renderReport(analysis, aiReport = null) {
  const model = buildInterviewReportModel(analysis, aiReport);
  window.PitaReportUI.renderDashboard(elements.reportDashboardRoot, model);
  state.lastReport = { analysis, aiReport };
  setReportActionsEnabled(true);
  persistSession();
}

function normalizeReport(data) {
  if (data.report && typeof data.report === "object") return data.report;
  if (data.text) {
    try {
      return JSON.parse(data.text);
    } catch (error) {
      return { summary: data.text, improvements: [], practicePlan: [] };
    }
  }
  return null;
}

async function generateReport() {
  if (!state.answers.length) return;
  const analysis = analyzeAnswers();
  state.activeReportTab = state.activeReportTab || "language";
  state.reportGenerating = true;
  renderReport(analysis);
  elements.reportButton.disabled = true;
  elements.reportButton.textContent = "생성 중";

  try {
    setNonverbalVideoStatus("Gemini 리포트용 영상 샘플 정리 중");
    const nonverbalMedia = await prepareNonverbalVideoPayload();
    if (nonverbalMedia?.mediaBase64) {
      setNonverbalVideoStatus(`Gemini 리포트에 카메라 영상 샘플 첨부됨 · ${Math.round(nonverbalMedia.size / 1024)}KB`);
    } else {
      setNonverbalVideoStatus(`Gemini 리포트용 영상 샘플 없음 · ${state.nonverbalVideoIssue || "로컬 신호 요약 사용"}`);
    }
    const data = await callGemini("report", {
      profile: getProfile(),
      answers: state.answers,
      messages: state.messages,
      localAnalysis: analysis,
      mediaBase64: nonverbalMedia?.mediaBase64,
      mediaMimeType: nonverbalMedia?.mediaMimeType,
    });
    const report = normalizeReport(data);
    renderReport(analysis, report);
  } catch (error) {
    const message = getReadableError(error);
    setConnection("AI 리포트 실패", "red");
    showApiNotice(message, generateReport);
  } finally {
    state.reportGenerating = false;
    elements.reportButton.textContent = "리포트 생성";
    elements.reportButton.disabled = false;
    persistSession();
  }
}

async function shareReportLink() {
  if (!state.lastReport) return;
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const url = new URL(window.location.href);
  url.hash = `report=${id}`;
  const payload = {
    createdAt: new Date().toISOString(),
    report: state.lastReport,
    messages: state.messages,
    answers: state.answers,
    answerMeta: state.answerMeta,
    silenceEvents: state.silenceEvents,
  };

  try {
    localStorage.setItem(`${SHARED_REPORT_PREFIX}${id}`, JSON.stringify(payload));
    await navigator.clipboard?.writeText(url.toString());
    elements.apiNotice.hidden = false;
    elements.apiNotice.textContent = "공유 링크를 클립보드에 복사했습니다. 같은 브라우저에서 열면 리포트를 복원합니다.";
  } catch (error) {
    elements.apiNotice.hidden = false;
    elements.apiNotice.textContent = `공유 링크: ${url.toString()}`;
  }
}

function restoreSharedReport() {
  const match = window.location.hash.match(/report=([^&]+)/);
  if (!match) return false;

  try {
    const saved = JSON.parse(localStorage.getItem(`${SHARED_REPORT_PREFIX}${match[1]}`) || "null");
    if (!saved?.report) return false;
    state.messages = saved.messages || [];
    state.answers = saved.answers || [];
    state.answerMeta = saved.answerMeta || [];
    state.silenceEvents = saved.silenceEvents || [];
    state.lastReport = saved.report;
    renderMessages();
    renderReport(saved.report.analysis, saved.report.aiReport);
    setReportActionsEnabled(true);
    elements.apiNotice.hidden = false;
    elements.apiNotice.textContent = "공유 링크에서 리포트를 복원했습니다.";
    updateMetrics();
    return true;
  } catch (error) {
    return false;
  }
}

function resetSession() {
  const confirmed = window.confirm("현재 면접 대화와 리포트를 모두 초기화할까요?");
  if (!confirmed) return;

  stopTtsPlayback();
  stopCamera(true);
  clearSilenceTimer();
  if (state.recognition && state.isRecording) {
    state.recognition.stop();
  }
  state.started = false;
  state.busy = false;
  state.pendingVoiceText = "";
  state.questionStartedAt = null;
  state.currentAnswerStartedAt = null;
  state.answerMeta = [];
  state.silenceEvents = [];
  state.lastReport = null;
  state.activeReportTab = "language";
  elements.answerInput.value = "";
  elements.answerInput.disabled = true;
  elements.sendButton.disabled = true;
  elements.micButton.disabled = true;
  elements.liveTranscript.textContent = state.recognitionSupported
    ? "음성 인식 대기 중"
    : "이 브라우저는 음성 인식을 지원하지 않습니다.";
  elements.personaSummary.textContent = "설정을 완료하고 면접을 시작하세요.";
  clearReportDashboard();
  hideApiNotice();
  setReportActionsEnabled(false);
  setConnection("AI 대기", "blue");
  clearChat();
  sessionStorage.removeItem(SESSION_STORAGE_KEY);
}

elements.resumeFile.addEventListener("change", (event) => {
  readResumeFile(event.target.files[0]);
});

elements.depthInput.addEventListener("input", () => {
  elements.depthOutput.textContent = elements.depthInput.value;
  persistSession();
});

[elements.companyInput, elements.roleInput, elements.talentInput, elements.personaInput].forEach((input) => {
  input.addEventListener("input", persistSession);
  input.addEventListener("change", persistSession);
});

elements.startButton.addEventListener("click", startInterview);
elements.cameraButton.addEventListener("click", startCamera);
elements.retryButton.addEventListener("click", () => {
  if (state.pendingRetry) state.pendingRetry();
});
elements.shareReportButton.addEventListener("click", shareReportLink);

elements.micButton.addEventListener("click", () => {
  if (!state.recognition || state.busy) return;
  if (state.isRecording) {
    state.recognition.stop();
    return;
  }
  try {
    state.recognition.start();
  } catch (error) {
    elements.liveTranscript.textContent = "음성 인식을 다시 시작할 수 없습니다. 잠시 후 다시 눌러 주세요.";
  }
});

elements.answerInput.addEventListener("input", () => {
  if (elements.answerInput.value.trim()) {
    markAnswerStarted("text");
  }
});

elements.voiceToggle.addEventListener("click", () => {
  state.voiceEnabled = !state.voiceEnabled;
  elements.voiceToggle.textContent = state.voiceEnabled ? "음성 출력 ON" : "음성 출력 OFF";
  elements.voiceToggle.setAttribute("aria-pressed", String(state.voiceEnabled));
  if (!state.voiceEnabled) {
    stopTtsPlayback();
  }
  updateMetrics();
});

elements.answerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  handleAnswer(elements.answerInput.value);
});

elements.reportButton.addEventListener("click", generateReport);
elements.resetButton.addEventListener("click", resetSession);
window.addEventListener("beforeunload", () => {
  stopTtsPlayback();
  stopCamera(false);
});
window.addEventListener("afterprint", () => document.body.classList.remove("print-report"));

if (!restoreSharedReport()) {
  restoreSession();
}
setupSpeechRecognition();
renderNonverbalScores();
updateMetrics();
