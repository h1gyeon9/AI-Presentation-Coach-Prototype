const API_ENDPOINT = "/.netlify/functions/gemini-interview";
const DOCUMENT_ENDPOINT = "/.netlify/functions/parse-document";
const LIVE_TOKEN_ENDPOINT = "/.netlify/functions/live-token";
const LIVE_WS_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";
const LIVE_INPUT_SAMPLE_RATE = 16000;
const LIVE_OUTPUT_SAMPLE_RATE = 24000;
const LIVE_SETUP_VARIANTS = ["full", "no-transcription", "minimal"];
const NONVERBAL_TICK_MS = 1600;
const NONVERBAL_LOG_EVERY_TICKS = 5;
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
  liveMode: false,
  liveReady: false,
  liveSocket: null,
  liveStream: null,
  liveAudioContext: null,
  liveSource: null,
  liveProcessor: null,
  liveOutputTime: 0,
  liveInputBuffer: "",
  liveOutputBuffer: "",
  liveModel: "",
  liveManualClose: false,
  liveSetupAttempt: 0,
  liveSetupComplete: false,
  liveSetupVariant: "full",
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
  liveStatus: $("#liveStatus"),
  liveStartButton: $("#liveStartButton"),
  liveStopButton: $("#liveStopButton"),
  answerForm: $("#answerForm"),
  answerInput: $("#answerInput"),
  sendButton: $("#sendButton"),
  reportButton: $("#reportButton"),
  retryButton: $("#retryButton"),
  downloadReportButton: $("#downloadReportButton"),
  shareReportButton: $("#shareReportButton"),
  resetButton: $("#resetButton"),
  apiNotice: $("#apiNotice"),
  reportContent: $("#reportContent"),
  personaSummary: $("#personaSummary"),
  turnMetric: $("#turnMetric"),
  fillerMetric: $("#fillerMetric"),
  voiceMetric: $("#voiceMetric"),
  connectionText: $("#connectionText"),
  connectionPill: $("#connectionPill"),
  cameraStage: $("#cameraStage"),
  cameraPreview: $("#cameraPreview"),
  cameraButton: $("#cameraButton"),
  simulationButton: $("#simulationButton"),
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
  elements.downloadReportButton.disabled = !enabled;
  elements.shareReportButton.disabled = !enabled;
}

function getProfile() {
  return {
    company: elements.companyInput.value.trim() || "미입력 회사",
    role: elements.roleInput.value.trim() || "미입력 직무",
    talent: elements.talentInput.value.trim() || "미입력 인재상",
    persona: elements.personaInput.value,
    personaLabel: personaLabels[elements.personaInput.value],
    depth: Number(elements.depthInput.value),
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

function updateMetrics() {
  const analysis = analyzeAnswers();
  elements.turnMetric.textContent = String(state.answers.length);
  elements.fillerMetric.textContent = String(analysis.fillerTotal);
  elements.voiceMetric.textContent = state.liveMode ? "LIVE" : state.voiceEnabled ? "ON" : "OFF";
  elements.reportButton.disabled = state.answers.length === 0;
  updateLiveControls();
}

function persistSession() {
  const payload = {
    inputs: {
      company: elements.companyInput.value,
      role: elements.roleInput.value,
      talent: elements.talentInput.value,
      persona: elements.personaInput.value,
      depth: elements.depthInput.value,
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
  elements.cameraMode.textContent = mode === "live" ? "카메라" : "데모";
  elements.cameraStatus.textContent = statusText;
  elements.cameraButton.textContent = mode === "live" ? "카메라 끄기" : "카메라 켜기";
  elements.simulationButton.textContent = mode === "demo" ? "데모 재시작" : "데모 모드";

  tickNonverbal();
  state.nonverbalTimer = window.setInterval(tickNonverbal, NONVERBAL_TICK_MS);
}

function stopNonverbalSession(clearHistory = false) {
  window.clearInterval(state.nonverbalTimer);
  state.nonverbalTimer = null;
  state.nonverbalMode = "idle";
  elements.cameraStage.classList.remove("is-live");
  elements.cameraMode.textContent = "대기";
  elements.cameraStatus.textContent = clearHistory
    ? "카메라 대기 중"
    : "카메라가 꺼졌습니다. 마지막 신호가 리포트에 반영됩니다.";
  elements.cameraButton.textContent = "카메라 켜기";
  elements.simulationButton.textContent = "데모 모드";

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
    startNonverbalSession("demo", "카메라 API를 사용할 수 없어 데모 모드로 실행 중");
    return;
  }

  elements.cameraStatus.textContent = "카메라 권한 확인 중";
  elements.cameraButton.disabled = true;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 720 },
        height: { ideal: 480 },
        facingMode: "user",
      },
      audio: false,
    });
    state.cameraStream = stream;
    state.cameraActive = true;
    elements.cameraPreview.srcObject = stream;
    await elements.cameraPreview.play().catch(() => {});
    startNonverbalSession("live", "얼굴 위치와 비언어 신호 분석 중");
  } catch (error) {
    state.cameraActive = false;
    state.cameraStream = null;
    elements.cameraPreview.srcObject = null;
    startNonverbalSession("demo", "카메라 권한 없이 데모 모드 실행 중");
  } finally {
    elements.cameraButton.disabled = false;
  }
}

function stopCamera(clearHistory = false) {
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach((track) => track.stop());
  }
  state.cameraStream = null;
  state.cameraActive = false;
  elements.cameraPreview.srcObject = null;
  stopNonverbalSession(clearHistory);
}

function startDemoMode() {
  if (state.cameraActive) {
    stopCamera(false);
  }
  startNonverbalSession("demo", "가상 비언어 신호 분석 중");
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
    state.liveMode || isBusy || !state.started || !state.recognitionSupported || state.textInputMode;
  if (isBusy) {
    elements.liveTranscript.textContent = "AI 면접관이 다음 질문을 준비 중입니다.";
  } else if (state.liveMode) {
    elements.liveTranscript.textContent = state.liveReady
      ? "실시간 음성 면접 진행 중입니다."
      : "실시간 음성 세션을 준비하고 있습니다.";
  } else if (state.started) {
    elements.liveTranscript.textContent = state.recognitionSupported && !state.textInputMode
      ? "REC 버튼을 눌러 답변하세요."
      : "텍스트 입력 모드입니다. 답변을 입력한 뒤 전송하세요.";
  }
  updateLiveControls();
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

function speak(text) {
  if (!state.voiceEnabled || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  const voices = window.speechSynthesis.getVoices();
  utterance.lang = "ko-KR";
  utterance.rate = 0.94;
  utterance.pitch = 0.96;
  utterance.voice =
    voices.find((voice) => voice.lang.toLowerCase().startsWith("ko")) ||
    voices.find((voice) => voice.lang.toLowerCase().startsWith("en")) ||
    null;
  window.speechSynthesis.speak(utterance);
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

  if (!file) return;

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
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.onerror = () => reject(reader.error || new Error("파일을 읽지 못했습니다."));
    reader.readAsDataURL(file);
  });
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
  const timeoutId = window.setTimeout(() => controller.abort(), 18000);

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

function setLiveStatus(message, tone = "idle") {
  elements.liveStatus.textContent = message;
  elements.liveStatus.classList.toggle("is-live", tone === "live");
  elements.liveStatus.classList.toggle("is-error", tone === "error");
}

function updateLiveControls() {
  elements.liveStartButton.disabled = state.busy || state.liveMode;
  elements.liveStopButton.disabled = !state.liveMode;

  if (state.liveMode) {
    elements.micButton.disabled = true;
    elements.answerInput.disabled = false;
    elements.sendButton.disabled = false;
  }
}

function normalizeLiveModelName(model) {
  const value = model || "gemini-3.1-flash-live-preview";
  return value.startsWith("models/") ? value : `models/${value}`;
}

function getLiveSetupVariant(attempt) {
  return LIVE_SETUP_VARIANTS[Math.min(attempt, LIVE_SETUP_VARIANTS.length - 1)];
}

function buildLiveSetupMessage(variant) {
  const setup = {
    model: normalizeLiveModelName(state.liveModel),
    generationConfig: {
      responseModalities: ["AUDIO"],
      temperature: 0.7,
    },
  };

  if (variant !== "minimal") {
    setup.systemInstruction = {
      parts: [{ text: buildLiveSystemInstruction() }],
    };
  }

  if (variant === "full") {
    setup.inputAudioTranscription = {};
    setup.outputAudioTranscription = {};
  }

  return { setup };
}

function buildLiveSystemInstruction() {
  const profile = getProfile();
  const history = state.messages
    .slice(-8)
    .map((message) => `${message.role === "ai" ? "면접관" : "지원자"}: ${message.text}`)
    .join("\n");

  return [
    "당신은 한국어로 실시간 음성 면접을 진행하는 1:1 AI 면접관입니다.",
    `회사: ${profile.company}`,
    `직무: ${profile.role}`,
    `인재상: ${profile.talent}`,
    `면접관 페르소나: ${profile.personaLabel}`,
    `꼬리질문 강도: 1에서 5 중 ${profile.depth}`,
    `자기소개서 파일: ${profile.resumeName || "없음"}`,
    `자기소개서 발췌: ${profile.resumeText || "없음"}`,
    history ? `[이전 대화]\n${history}` : "[이전 대화]\n아직 대화 없음",
    "실제 면접처럼 한 번에 질문 하나만 던지세요.",
    "답변 직후에는 역할, 근거, 수치, 갈등, 실패, 재발 방지, 직무 적합성 중 하나를 파고드는 꼬리 질문을 하세요.",
    "실시간 음성 대화이므로 1~2문장으로 짧고 자연스럽게 말하세요.",
    "칭찬이나 해설을 길게 하지 말고, 면접관처럼 다음 질문으로 대화를 이어가세요.",
  ].join("\n");
}

function buildLiveStartPrompt() {
  if (state.messages.length) {
    return "지금까지의 면접 대화 흐름을 이어서 다음 꼬리 질문 하나를 해 주세요.";
  }
  return "면접을 시작해 주세요. 첫 질문은 자기소개 또는 직무 지원 동기와 관련된 짧은 질문 하나로 해 주세요.";
}

function prepareLiveSession() {
  if (!state.started) {
    state.started = true;
    state.answers = [];
    state.answerMeta = [];
    state.messages = [];
    state.silenceEvents = [];
    state.lastReport = null;
    state.activeReportTab = "language";
    elements.chatLog.innerHTML = "";
    elements.reportContent.innerHTML = `
      <div class="empty-state">답변을 한 번 이상 전송하면 리포트를 만들 수 있습니다.</div>
    `;
    setReportActionsEnabled(false);
  }

  elements.answerInput.disabled = false;
  elements.sendButton.disabled = false;
  elements.micButton.disabled = true;
  elements.answerInput.value = "";
  elements.personaSummary.textContent = `${getProfile().company} · ${getProfile().role} · 실시간 음성 면접`;
  updateMetrics();
  persistSession();
}

async function requestLiveToken() {
  const response = await fetch(LIVE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      profile: getProfile(),
      systemInstruction: buildLiveSystemInstruction(),
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "실시간 AI 토큰 요청에 실패했습니다.");
    error.status = response.status;
    error.code = data.code || "LIVE_TOKEN_ERROR";
    throw error;
  }
  if (!data.token) {
    const error = new Error("실시간 AI 토큰 응답이 비어 있습니다.");
    error.code = "LIVE_TOKEN_EMPTY";
    throw error;
  }
  return data;
}

function sendLiveMessage(message) {
  if (state.liveSocket?.readyState !== WebSocket.OPEN) return false;
  state.liveSocket.send(JSON.stringify(message));
  return true;
}

function sendLiveText(text) {
  if (!text || !state.liveReady) return false;
  return sendLiveMessage({
    realtimeInput: {
      text,
    },
  });
}

function handleLiveStartupError(error) {
  stopLiveInterview(false);
  const message = getReadableError(error);
  setConnection("AI Live 실패", "red");
  setLiveStatus(message, "error");
  showApiNotice(message, startLiveInterview);
}

async function connectLiveSocket(attempt = 0) {
  const variant = getLiveSetupVariant(attempt);
  state.liveSetupAttempt = attempt;
  state.liveSetupVariant = variant;

  const tokenData = await requestLiveToken();
  state.liveModel = tokenData.model || "gemini-3.1-flash-live-preview";
  console.info("[AI Live] token issued", {
    model: state.liveModel,
    setupVariant: variant,
    attempt: attempt + 1,
  });

  const socket = new WebSocket(
    `${LIVE_WS_ENDPOINT}?access_token=${encodeURIComponent(tokenData.token)}`,
  );
  state.liveSocket = socket;

  socket.onopen = () => {
    setLiveStatus("AI 음성 세션을 설정하고 있습니다.", "live");
    const setupMessage = buildLiveSetupMessage(variant);
    console.info("[AI Live] sending setup", {
      model: setupMessage.setup.model,
      setupVariant: variant,
      attempt: attempt + 1,
      fields: Object.keys(setupMessage.setup),
    });
    sendLiveMessage(setupMessage);
  };

  socket.onmessage = (event) => {
    handleLiveMessage(event.data);
  };

  socket.onerror = (event) => {
    console.error("[AI Live] websocket error", event);
    setLiveStatus("실시간 음성 연결 오류가 발생했습니다.", "error");
    setConnection("AI Live 실패", "red");
  };

  socket.onclose = (event) => {
    const wasManual = state.liveManualClose;
    console.warn("[AI Live] websocket closed", {
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
      wasManual,
      model: state.liveModel,
      setupVariant: variant,
      attempt: attempt + 1,
    });

    const shouldRetrySetup =
      !wasManual &&
      !state.liveSetupComplete &&
      attempt < LIVE_SETUP_VARIANTS.length - 1 &&
      (event.code === 1007 || event.code === 1008);

    if (shouldRetrySetup) {
      const nextAttempt = attempt + 1;
      const nextVariant = getLiveSetupVariant(nextAttempt);
      console.info("[AI Live] retrying setup with reduced fields", {
        nextVariant,
        nextAttempt: nextAttempt + 1,
      });
      state.liveSocket = null;
      state.liveReady = false;
      updateLiveControls();
      connectLiveSocket(nextAttempt).catch(handleLiveStartupError);
      return;
    }

    cleanupLiveConnection();
    if (!wasManual && state.started) {
      setLiveStatus("실시간 음성 연결이 끊겼습니다. 다시 시도할 수 있습니다.", "error");
      setConnection("AI Live 끊김", "red");
      showApiNotice(
        `실시간 음성 연결이 종료되었습니다. (${event.code || "unknown"}${event.reason ? `: ${event.reason}` : ""})`,
        startLiveInterview,
      );
    }
  };
}

async function startLiveInterview() {
  if (state.liveMode || state.busy) return;

  if (!("WebSocket" in window)) {
    showApiNotice("이 브라우저는 실시간 음성 연결을 지원하지 않습니다.", startLiveInterview);
    setLiveStatus("실시간 음성 연결을 지원하지 않는 브라우저입니다.", "error");
    return;
  }

  if (state.recognition && state.isRecording) {
    state.recognition.stop();
  }

  window.speechSynthesis?.cancel();
  hideApiNotice();
  prepareLiveSession();
  clearSilenceTimer();
  state.liveMode = true;
  state.liveReady = false;
  state.liveInputBuffer = "";
  state.liveOutputBuffer = "";
  state.liveOutputTime = 0;
  state.liveManualClose = false;
  state.liveSetupAttempt = 0;
  state.liveSetupComplete = false;
  state.liveSetupVariant = "full";
  updateLiveControls();
  setConnection("AI Live 연결 중", "amber");
  setLiveStatus("실시간 음성 세션을 준비하고 있습니다.", "live");
  elements.liveTranscript.textContent = "AI와 실시간 연결 중입니다.";

  try {
    await connectLiveSocket(0);
  } catch (error) {
    handleLiveStartupError(error);
  }
}

function cleanupLiveConnection() {
  stopLiveAudioCapture();
  state.liveSocket = null;
  state.liveMode = false;
  state.liveReady = false;
  state.liveManualClose = false;
  state.liveInputBuffer = "";
  state.liveOutputBuffer = "";
  state.liveSetupComplete = false;
  state.liveSetupAttempt = 0;
  state.liveSetupVariant = "full";
  updateLiveControls();
}

function stopLiveInterview(showIdleStatus = true) {
  if (state.liveSocket) {
    const socket = state.liveSocket;
    state.liveManualClose = true;
    socket.onclose = null;
    socket.onerror = null;
    sendLiveMessage({ realtimeInput: { audioStreamEnd: true } });
    socket.close();
  }
  cleanupLiveConnection();
  if (showIdleStatus) {
    setLiveStatus("기본 음성 모드입니다. 실시간 모드를 켜면 AI와 바로 말로 주고받습니다.");
    setConnection(state.started ? "AI 연결됨" : "AI 대기", state.started ? "green" : "blue");
  }
}

function handleLiveMessage(rawMessage) {
  let response;
  try {
    response = JSON.parse(rawMessage);
  } catch (error) {
    return;
  }

  if (response.setupComplete) {
    state.liveReady = true;
    state.liveSetupComplete = true;
    console.info("[AI Live] setup complete", {
      setupVariant: state.liveSetupVariant,
      attempt: state.liveSetupAttempt + 1,
    });
    setConnection("AI Live 연결됨", "green");
    setLiveStatus("실시간 음성 면접 진행 중입니다. 자연스럽게 답변하세요.", "live");
    elements.liveTranscript.textContent = "마이크를 통해 바로 답변할 수 있습니다.";
    updateLiveControls();
    startLiveAudioCapture()
      .then(() => {
        sendLiveText(buildLiveStartPrompt());
      })
      .catch((error) => {
        stopLiveInterview(false);
        switchToTextMode("마이크 권한이 허용되지 않아 텍스트 입력 모드로 자동 전환했습니다.");
        const message = error?.message || "마이크 연결에 실패했습니다.";
        setConnection("AI Live 실패", "red");
        setLiveStatus(message, "error");
        showApiNotice(message, startLiveInterview);
      });
    return;
  }

  const serverContent = response.serverContent;
  if (!serverContent) return;

  if (serverContent.inputTranscription?.text) {
    if (!state.currentAnswerStartedAt) markAnswerStarted("live-voice");
    state.liveInputBuffer = appendTranscriptChunk(
      state.liveInputBuffer,
      serverContent.inputTranscription.text,
    );
    elements.liveTranscript.textContent = `나: ${state.liveInputBuffer}`;
  }

  if (serverContent.outputTranscription?.text) {
    state.liveOutputBuffer = appendTranscriptChunk(
      state.liveOutputBuffer,
      serverContent.outputTranscription.text,
    );
    elements.liveTranscript.textContent = `AI: ${state.liveOutputBuffer}`;
  }

  if (serverContent.modelTurn?.parts) {
    serverContent.modelTurn.parts.forEach((part) => {
      if (part.inlineData?.data) {
        playLiveAudio(part.inlineData.data);
      }
    });
  }

  if (serverContent.turnComplete || serverContent.generationComplete) {
    commitLiveTranscripts();
  }
}

function appendTranscriptChunk(current, chunk) {
  const next = String(chunk || "").trim();
  if (!next) return current;
  if (!current) return next;
  if (next.startsWith(current)) return next;
  if (current.endsWith(next)) return current;
  return `${current} ${next}`.replace(/\s+/g, " ").trim();
}

function isDuplicateRecentMessage(role, text) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return state.messages
    .slice(-4)
    .some((message) => message.role === role && message.text.replace(/\s+/g, " ").trim() === normalized);
}

function commitLiveTranscripts() {
  const userText = state.liveInputBuffer.replace(/\s+/g, " ").trim();
  const aiText = state.liveOutputBuffer.replace(/\s+/g, " ").trim();

  if (userText && !isDuplicateRecentMessage("user", userText)) {
    recordUserAnswer(userText, "live-voice");
  }

  if (aiText && !isDuplicateRecentMessage("ai", aiText)) {
    addMessage("ai", aiText);
    startSilenceTimer(aiText);
  } else if (aiText) {
    startSilenceTimer(aiText);
  }

  state.liveInputBuffer = "";
  state.liveOutputBuffer = "";
  persistSession();
}

async function ensureLiveAudioContext() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) {
    throw new Error("이 브라우저는 실시간 오디오 처리를 지원하지 않습니다.");
  }
  if (!state.liveAudioContext || state.liveAudioContext.state === "closed") {
    state.liveAudioContext = new AudioContext();
  }
  if (state.liveAudioContext.state === "suspended") {
    await state.liveAudioContext.resume();
  }
  return state.liveAudioContext;
}

async function startLiveAudioCapture() {
  if (state.liveStream) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("마이크 API를 사용할 수 없어 실시간 음성 모드를 시작할 수 없습니다.");
  }

  const context = await ensureLiveAudioContext();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);

  processor.onaudioprocess = (event) => {
    if (!state.liveMode || !state.liveReady) return;
    const input = event.inputBuffer.getChannelData(0);
    const pcm = downsampleTo16BitPcm(input, context.sampleRate, LIVE_INPUT_SAMPLE_RATE);
    if (!pcm.length) return;
    sendLiveMessage({
      realtimeInput: {
        audio: {
          data: arrayBufferToBase64(pcm.buffer),
          mimeType: `audio/pcm;rate=${LIVE_INPUT_SAMPLE_RATE}`,
        },
      },
    });
  };

  source.connect(processor);
  processor.connect(context.destination);
  state.liveStream = stream;
  state.liveSource = source;
  state.liveProcessor = processor;
}

function stopLiveAudioCapture() {
  if (state.liveProcessor) {
    state.liveProcessor.disconnect();
    state.liveProcessor.onaudioprocess = null;
  }
  if (state.liveSource) {
    state.liveSource.disconnect();
  }
  if (state.liveStream) {
    state.liveStream.getTracks().forEach((track) => track.stop());
  }
  state.liveProcessor = null;
  state.liveSource = null;
  state.liveStream = null;
}

function downsampleTo16BitPcm(input, inputRate, outputRate) {
  if (outputRate === inputRate) {
    return floatTo16BitPcm(input);
  }
  const ratio = inputRate / outputRate;
  const length = Math.max(1, Math.round(input.length / ratio));
  const result = new Float32Array(length);

  for (let i = 0; i < length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j += 1) {
      sum += input[j];
      count += 1;
    }
    result[i] = count ? sum / count : 0;
  }

  return floatTo16BitPcm(result);
}

function floatTo16BitPcm(input) {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return window.btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function playLiveAudio(base64Audio) {
  try {
    const context = await ensureLiveAudioContext();
    const pcm = new Int16Array(base64ToArrayBuffer(base64Audio));
    const audioBuffer = context.createBuffer(1, pcm.length, LIVE_OUTPUT_SAMPLE_RATE);
    const channel = audioBuffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i += 1) {
      channel[i] = pcm[i] / 0x8000;
    }
    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + 0.02, state.liveOutputTime || 0);
    source.start(startAt);
    state.liveOutputTime = startAt + audioBuffer.duration;
  } catch (error) {
    setLiveStatus("AI 음성 재생에 실패했습니다. 대화 전사는 계속 표시됩니다.", "error");
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
    speak(reply);
    startSilenceTimer(reply);
  } catch (error) {
    const message = getReadableError(error);
    setConnection("AI 연결 실패", "red");
    showApiNotice(message, () => requestInterviewer(latestAnswer));
    const reply = fallbackInterviewerQuestion(latestAnswer);
    addMessage("ai", reply);
    speak(reply);
    startSilenceTimer(reply);
  } finally {
    setBusy(false);
    updateMetrics();
    persistSession();
  }
}

async function startInterview() {
  if (state.busy) return;
  stopLiveInterview();
  window.speechSynthesis?.cancel();
  state.started = true;
  state.answers = [];
  state.answerMeta = [];
  state.messages = [];
  state.silenceEvents = [];
  state.lastReport = null;
  state.activeReportTab = "language";
  elements.chatLog.innerHTML = "";
  elements.reportContent.innerHTML = `
    <div class="empty-state">답변을 한 번 이상 전송하면 리포트를 만들 수 있습니다.</div>
  `;
  hideApiNotice();
  setReportActionsEnabled(false);
  elements.answerInput.value = "";
  elements.answerInput.disabled = false;
  elements.sendButton.disabled = false;
  elements.micButton.disabled = !state.recognitionSupported || state.textInputMode;
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

  if (state.liveMode) {
    recordUserAnswer(text, "live-text");
    sendLiveText(text);
    return;
  }

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
    nonverbal: analyzeNonverbal(),
  };
}

function localReportHtml(analysis, aiReport = null) {
  const active = state.activeReportTab || "language";
  const tabClass = (name) => (active === name ? "is-active" : "");
  const panelAttrs = (name) =>
    `class="report-tab-panel ${tabClass(name)}" data-report-panel="${name}" role="tabpanel"`;
  const list = (items, fallback) =>
    items?.length ? items.map((item) => `<li>${escapeHtml(item)}</li>`).join("") : `<li>${fallback}</li>`;
  const badges = (items, fallback) =>
    items?.length
      ? items.map((item) => `<span class="badge">${escapeHtml(item.label)} ${item.count}회</span>`).join("")
      : `<span class="badge">${fallback}</span>`;

  const silenceItems = analysis.silenceEvents?.length
    ? analysis.silenceEvents.map(
        (event, index) =>
          `${index + 1}번째 침묵: ${event.seconds}초 이상 대기 후 안내 표시`,
      )
    : [];
  const scriptItems = state.messages
    .map(
      (message, index) => `
        <li class="script-item">
          <b>${index + 1}. ${message.role === "ai" ? "면접관 질문" : "지원자 답변"}</b>
          <p>${escapeHtml(message.text)}</p>
        </li>
      `,
    )
    .join("");
  const evaluationItems = analysis.questionEvaluations
    .map(
      (item) => `
        <li>
          ${item.index}번 답변 논리 구조 ${item.score}점:
          ${item.feedback.map(escapeHtml).join(" ")}
        </li>
      `,
    )
    .join("");
  const mappingBadges = analysis.jobFitMappings
    .map(
      (item) =>
        `<span class="badge">${escapeHtml(item.keyword)} ${item.matched ? "언급" : "미언급"}</span>`,
    )
    .join("");
  const nonverbal = analysis.nonverbal;

  return `
    <div class="report-tabs" role="tablist" aria-label="리포트 분류">
      <button class="report-tab ${tabClass("language")}" type="button" data-report-tab="language" role="tab" aria-selected="${active === "language"}">언어 습관</button>
      <button class="report-tab ${tabClass("content")}" type="button" data-report-tab="content" role="tab" aria-selected="${active === "content"}">내용</button>
      <button class="report-tab ${tabClass("nonverbal")}" type="button" data-report-tab="nonverbal" role="tab" aria-selected="${active === "nonverbal"}">비언어</button>
    </div>

    <section ${panelAttrs("language")}>
      <section class="report-block">
        <h3>언어 습관 요약</h3>
        <div class="score-grid">
          <div class="score"><b>${analysis.deliveryScore}</b><span>전달 안정감</span></div>
          <div class="score"><b>${formatDuration(analysis.avgAnswerTimeMs)}</b><span>평균 답변 시간</span></div>
          <div class="score"><b>${formatDuration(analysis.avgLatencyMs)}</b><span>평균 준비 시간</span></div>
        </div>
      </section>
      <section class="report-block">
        <h3>추임새 Top 3</h3>
        <div class="badge-row">${badges(analysis.topFillers, "감지된 추임새 적음")}</div>
      </section>
      <section class="report-block">
        <h3>반복 표현 Top 5</h3>
        <div class="badge-row">${badges(analysis.repeatedExpressions, "반복 표현 적음")}</div>
      </section>
      <section class="report-block">
        <h3>침묵 및 휴지 구간</h3>
        <ul>${list(silenceItems, "10초 이상 장시간 침묵은 감지되지 않았습니다.")}</ul>
      </section>
      ${
        aiReport?.languageHabits?.length
          ? `
            <section class="report-block">
              <h3>AI 언어 습관 피드백</h3>
              <ul>${list(aiReport.languageHabits, "언어 습관 피드백이 없습니다.")}</ul>
            </section>
          `
          : ""
      }
    </section>

    <section ${panelAttrs("content")}>
      <section class="report-block">
        <h3>내용 점수</h3>
        <div class="score-grid">
          <div class="score"><b>${analysis.structureScore}</b><span>논리 구조</span></div>
          <div class="score"><b>${analysis.specificityScore}</b><span>구체성</span></div>
          <div class="score"><b>${analysis.wordCount}</b><span>답변 단어 수</span></div>
        </div>
      </section>
      <section class="report-block">
        <h3>전체 대화 스크립트</h3>
        <ul class="script-list">${scriptItems || '<li class="script-item"><p>대화 기록이 없습니다.</p></li>'}</ul>
      </section>
      <section class="report-block">
        <h3>질문별 논리 구조 평가</h3>
        <ul>${evaluationItems || "<li>평가할 답변이 없습니다.</li>"}</ul>
      </section>
      <section class="report-block">
        <h3>직무 적합성 및 인재상 매핑</h3>
        <div class="badge-row">${mappingBadges || '<span class="badge">매핑 키워드 없음</span>'}</div>
      </section>
      <section class="report-block">
        <h3>보완 포인트</h3>
        <ul>${list(aiReport?.contentFeedback || aiReport?.improvements, "상황, 행동, 결과, 배운 점 순서로 답변을 더 명확히 구조화해 보세요.")}</ul>
      </section>
      ${
        aiReport
          ? `
            <section class="report-block">
              <h3>AI 종합 피드백</h3>
              <p>${escapeHtml(aiReport.summary || "종합 피드백을 생성했습니다.")}</p>
              <ul style="margin-top: 12px;">${list(aiReport.strengths, "강점 항목이 별도로 반환되지 않았습니다.")}</ul>
            </section>
            <section class="report-block">
              <h3>다음 연습</h3>
              <ul>${list(aiReport.practicePlan, "다음 연습 항목이 별도로 반환되지 않았습니다.")}</ul>
            </section>
          `
          : ""
      }
    </section>

    <section ${panelAttrs("nonverbal")}>
      ${
        nonverbal
          ? `
            <section class="report-block">
              <h3>비언어 요약</h3>
              <p>종합 안정도는 ${nonverbal.score}점이며, 가장 보완이 필요한 신호는 ${nonverbal.weakest}입니다.</p>
              <div class="score-grid" style="margin-top: 12px;">
                <div class="score"><b>${nonverbal.averages.eye}</b><span>시선</span></div>
                <div class="score"><b>${nonverbal.averages.posture}</b><span>자세</span></div>
                <div class="score"><b>${nonverbal.averages.expression}</b><span>표정</span></div>
              </div>
            </section>
            <section class="report-block">
              <h3>제스처 및 관찰</h3>
              <div class="badge-row"><span class="badge">제스처 ${nonverbal.averages.gesture}</span><span class="badge">샘플 ${nonverbal.samples}개</span></div>
              <ul style="margin-top: 12px;">${nonverbal.observations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
            </section>
            <section class="report-block">
              <h3>세션 중 감지 로그</h3>
              <ul>${list(state.signalEvents, "세션 중 비언어 로그가 없습니다.")}</ul>
            </section>
            ${
              aiReport?.nonverbalFeedback?.length
                ? `
                  <section class="report-block">
                    <h3>AI 비언어 피드백</h3>
                    <ul>${list(aiReport.nonverbalFeedback, "비언어 피드백이 없습니다.")}</ul>
                  </section>
                `
                : ""
            }
          `
          : `
            <section class="report-block">
              <h3>비언어 데이터 없음</h3>
              <p>카메라 또는 데모 모드를 켠 뒤 면접을 진행하면 시선, 자세, 표정, 제스처 데이터가 이 탭에 표시됩니다.</p>
            </section>
          `
      }
    </section>
  `;
}

function bindReportTabs() {
  elements.reportContent.querySelectorAll("[data-report-tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.reportTab;
      state.activeReportTab = target;
      elements.reportContent.querySelectorAll("[data-report-tab]").forEach((item) => {
        const isActive = item.dataset.reportTab === target;
        item.classList.toggle("is-active", isActive);
        item.setAttribute("aria-selected", String(isActive));
      });
      elements.reportContent.querySelectorAll("[data-report-panel]").forEach((panel) => {
        panel.classList.toggle("is-active", panel.dataset.reportPanel === target);
      });
      persistSession();
    });
  });
}

function renderReport(analysis, aiReport = null) {
  elements.reportContent.innerHTML = localReportHtml(analysis, aiReport);
  bindReportTabs();
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
  renderReport(analysis);
  elements.reportButton.disabled = true;
  elements.reportButton.textContent = "생성 중";

  try {
    const data = await callGemini("report", {
      profile: getProfile(),
      answers: state.answers,
      messages: state.messages,
      localAnalysis: analysis,
    });
    const report = normalizeReport(data);
    renderReport(analysis, report);
  } catch (error) {
    const message = getReadableError(error);
    setConnection("AI 리포트 실패", "red");
    showApiNotice(message, generateReport);
  } finally {
    elements.reportButton.textContent = "리포트 생성";
    elements.reportButton.disabled = false;
    persistSession();
  }
}

function printReportAsPdf() {
  if (!state.lastReport) return;
  const iframe = document.createElement("iframe");
  iframe.title = "AI 면접 리포트 PDF";
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";

  const cleanup = () => {
    window.setTimeout(() => iframe.remove(), 1000);
  };

  iframe.onload = () => {
    iframe.contentWindow?.focus();
    iframe.contentWindow?.print();
    iframe.contentWindow?.addEventListener("afterprint", cleanup, { once: true });
    window.setTimeout(cleanup, 3000);
  };

  document.body.appendChild(iframe);
  iframe.srcdoc = buildPrintableReportDocument(
    state.lastReport.analysis,
    state.lastReport.aiReport,
  );
}

function buildPrintableReportDocument(analysis, aiReport = null) {
  const profile = getProfile();
  const generatedAt = new Date().toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const resumeLabel = profile.resumeName ? profile.resumeName : "첨부 없음";
  const reportHtml = localReportHtml(analysis, aiReport);

  return `<!doctype html>
    <html lang="ko">
      <head>
        <meta charset="UTF-8" />
        <title>AI 면접 리포트</title>
        <style>
          :root {
            --text: #172033;
            --muted: #667085;
            --line: #d9e0ea;
            --surface: #f8fafc;
            --green: #1f7a5b;
            --blue: #3157c9;
            --amber: #a76612;
          }

          * {
            box-sizing: border-box;
          }

          body {
            margin: 0;
            color: var(--text);
            background: #fff;
            font-family: Inter, Pretendard, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          }

          .print-page {
            width: min(920px, calc(100% - 48px));
            margin: 0 auto;
            padding: 32px 0 44px;
          }

          .print-header {
            padding-bottom: 20px;
            border-bottom: 2px solid var(--text);
          }

          .kicker {
            margin: 0 0 8px;
            color: var(--blue);
            font-size: 12px;
            font-weight: 900;
            letter-spacing: 0.08em;
            text-transform: uppercase;
          }

          h1 {
            margin: 0;
            font-size: 30px;
            line-height: 1.2;
          }

          .summary {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 10px;
            margin-top: 18px;
          }

          .summary-item,
          .score,
          .report-block,
          .script-item {
            border: 1px solid var(--line);
            border-radius: 8px;
            background: #fff;
          }

          .summary-item {
            min-height: 58px;
            padding: 10px 12px;
          }

          .summary-item span,
          .score span {
            display: block;
            color: var(--muted);
            font-size: 11px;
            font-weight: 900;
          }

          .summary-item b,
          .score b {
            display: block;
            margin-top: 4px;
            font-size: 16px;
          }

          .report-tabs {
            display: none;
          }

          .report-tab-panel {
            display: grid !important;
            gap: 12px;
            margin-top: 24px;
            break-before: page;
          }

          .report-tab-panel:first-of-type {
            break-before: auto;
          }

          .report-tab-panel::before {
            display: block;
            padding-bottom: 8px;
            border-bottom: 1px solid var(--line);
            font-size: 21px;
            font-weight: 900;
          }

          .report-tab-panel[data-report-panel="language"]::before {
            content: "언어 습관";
          }

          .report-tab-panel[data-report-panel="content"]::before {
            content: "내용";
          }

          .report-tab-panel[data-report-panel="nonverbal"]::before {
            content: "비언어";
          }

          .report-block {
            padding: 14px;
            background: var(--surface);
            break-inside: avoid;
          }

          .report-block h3 {
            margin: 0 0 10px;
            font-size: 15px;
          }

          .report-block p,
          .report-block li {
            color: var(--muted);
            font-size: 13px;
            line-height: 1.58;
          }

          .report-block p {
            margin: 0;
          }

          .report-block ul {
            margin: 0;
            padding-left: 18px;
          }

          .score-grid {
            display: grid;
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 8px;
          }

          .score {
            min-height: 72px;
            padding: 10px;
            background: #fff;
          }

          .score b {
            font-size: 20px;
          }

          .badge-row {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
          }

          .badge {
            display: inline-flex;
            min-height: 28px;
            align-items: center;
            padding: 0 9px;
            border: 1px solid rgba(167, 102, 18, 0.22);
            border-radius: 8px;
            background: rgba(167, 102, 18, 0.08);
            color: var(--amber);
            font-size: 11px;
            font-weight: 900;
          }

          .script-list {
            max-height: none !important;
            overflow: visible !important;
            display: grid;
            gap: 8px;
            margin: 0;
            padding: 0;
            list-style: none;
          }

          .script-item {
            display: grid;
            gap: 5px;
            padding: 10px;
            background: #fff;
            break-inside: avoid;
          }

          .script-item b {
            color: var(--text);
            font-size: 12px;
          }

          .script-item p {
            margin: 0;
          }

          .print-footer {
            margin-top: 24px;
            padding-top: 12px;
            border-top: 1px solid var(--line);
            color: var(--muted);
            font-size: 11px;
          }

          @page {
            margin: 14mm;
          }

          @media print {
            .print-page {
              width: 100%;
              padding: 0;
            }
          }
        </style>
      </head>
      <body>
        <main class="print-page">
          <header class="print-header">
            <p class="kicker">AI Interview Coach</p>
            <h1>면접 리포트</h1>
            <div class="summary">
              <div class="summary-item"><span>생성일</span><b>${escapeHtml(generatedAt)}</b></div>
              <div class="summary-item"><span>회사 / 직무</span><b>${escapeHtml(profile.company)} · ${escapeHtml(profile.role)}</b></div>
              <div class="summary-item"><span>면접관 유형</span><b>${escapeHtml(profile.personaLabel)}</b></div>
              <div class="summary-item"><span>자기소개서</span><b>${escapeHtml(resumeLabel)}</b></div>
            </div>
          </header>
          ${reportHtml}
          <footer class="print-footer">
            이 리포트는 면접 연습 기록과 AI 분석 결과를 기반으로 생성된 프로토타입 리포트입니다.
          </footer>
        </main>
      </body>
    </html>`;
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

  window.speechSynthesis?.cancel();
  stopLiveInterview(false);
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
  elements.reportContent.innerHTML = `
    <div class="empty-state">답변을 한 번 이상 전송하면 리포트를 만들 수 있습니다.</div>
  `;
  hideApiNotice();
  setReportActionsEnabled(false);
  setConnection("AI 대기", "blue");
  setLiveStatus("기본 음성 모드입니다. 실시간 모드를 켜면 AI와 바로 말로 주고받습니다.");
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
elements.simulationButton.addEventListener("click", startDemoMode);
elements.liveStartButton.addEventListener("click", startLiveInterview);
elements.liveStopButton.addEventListener("click", () => stopLiveInterview(true));
elements.retryButton.addEventListener("click", () => {
  if (state.pendingRetry) state.pendingRetry();
});
elements.downloadReportButton.addEventListener("click", printReportAsPdf);
elements.shareReportButton.addEventListener("click", shareReportLink);

elements.micButton.addEventListener("click", () => {
  if (state.liveMode) return;
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
    window.speechSynthesis?.cancel();
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
  stopLiveInterview(false);
  stopCamera(false);
});
window.addEventListener("afterprint", () => document.body.classList.remove("print-report"));

if ("speechSynthesis" in window) {
  window.speechSynthesis.onvoiceschanged = () => {};
}

if (!restoreSharedReport()) {
  restoreSession();
}
setupSpeechRecognition();
renderNonverbalScores();
updateMetrics();
updateLiveControls();
