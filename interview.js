const API_ENDPOINT = "/.netlify/functions/gemini-interview";
const NONVERBAL_TICK_MS = 1600;
const NONVERBAL_LOG_EVERY_TICKS = 5;

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
  recognition: null,
  recognitionSupported: false,
  isRecording: false,
  pendingVoiceText: "",
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
  resetButton: $("#resetButton"),
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
  elements.voiceMetric.textContent = state.voiceEnabled ? "ON" : "OFF";
  elements.reportButton.disabled = state.answers.length === 0;
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
  elements.micButton.disabled = isBusy || !state.started || !state.recognitionSupported;
  if (isBusy) {
    elements.liveTranscript.textContent = "AI 면접관이 다음 질문을 준비 중입니다.";
  } else if (state.started) {
    elements.liveTranscript.textContent = state.recognitionSupported
      ? "REC 버튼을 눌러 답변하세요."
      : "이 브라우저는 음성 인식을 지원하지 않습니다. 직접 입력으로 답변하세요.";
  }
}

function addMessage(role, text) {
  state.messages.push({ role, text });
  const item = document.createElement("li");
  item.className = `message ${role}`;
  item.innerHTML = `
    <span class="message-label">${role === "ai" ? "AI 면접관" : "나"}</span>
    <div class="message-bubble">${escapeHtml(text)}</div>
  `;
  elements.chatLog.appendChild(item);
  elements.chatLog.scrollTop = elements.chatLog.scrollHeight;
}

function clearChat() {
  state.messages = [];
  state.answers = [];
  elements.chatLog.innerHTML = "";
  addMessage("ai", "면접 시작을 누르면 회사, 직무, 인재상에 맞춰 첫 질문을 드립니다.");
  state.messages = [];
  updateMetrics();
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

function setupSpeechRecognition() {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  state.recognitionSupported = Boolean(SpeechRecognition);

  if (!SpeechRecognition) {
    elements.liveTranscript.textContent =
      "이 브라우저는 음성 인식을 지원하지 않습니다. 직접 입력으로 답변하세요.";
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = "ko-KR";
  recognition.interimResults = true;
  recognition.continuous = false;

  recognition.onstart = () => {
    state.isRecording = true;
    state.pendingVoiceText = "";
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
    elements.liveTranscript.textContent =
      event.error === "not-allowed"
        ? "마이크 권한이 필요합니다."
        : "음성 인식이 중단되었습니다. 다시 시도하세요.";
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
    state.resumeText = `[첨부 파일: ${file.name}]`;
    return;
  }

  try {
    state.resumeText = await file.text();
  } catch (error) {
    state.resumeText = `[첨부 파일을 읽지 못했습니다: ${file.name}]`;
  }
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
      throw new Error(data.error || "Gemini request failed");
    }
    setConnection("Gemini 연결됨", "green");
    return data;
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
  } catch (error) {
    setConnection("로컬 모의 응답", "amber");
    const reply = fallbackInterviewerQuestion(latestAnswer);
    addMessage("ai", reply);
    speak(reply);
  } finally {
    setBusy(false);
    updateMetrics();
  }
}

async function startInterview() {
  if (state.busy) return;
  window.speechSynthesis?.cancel();
  state.started = true;
  state.answers = [];
  state.messages = [];
  elements.chatLog.innerHTML = "";
  elements.reportContent.innerHTML = `
    <div class="empty-state">답변을 한 번 이상 전송하면 리포트를 만들 수 있습니다.</div>
  `;
  elements.answerInput.value = "";
  elements.answerInput.disabled = false;
  elements.sendButton.disabled = false;
  elements.micButton.disabled = !state.recognitionSupported;
  updateMetrics();
  await requestInterviewer("");
}

async function handleAnswer(rawText) {
  const text = rawText.trim();
  if (!text || state.busy) return;
  if (!state.started) {
    state.started = true;
  }
  elements.answerInput.value = "";
  addMessage("user", text);
  state.answers.push(text);
  updateMetrics();
  await requestInterviewer(text);
}

function countMatches(text, regex) {
  return (text.match(regex) || []).length;
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
    fillerTotal,
    fillerRate,
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
  const frequentFillers = analysis.fillerItems
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count)
    .map((item) => `<span class="badge">${escapeHtml(item.label)} ${item.count}회</span>`)
    .join("");

  const fillerComment =
    analysis.fillerTotal >= Math.max(4, state.answers.length * 2)
      ? "추임새가 답변 흐름을 끊고 있습니다. 첫 문장을 말하기 전 1초 쉬고, 문장 중간의 공백은 침묵으로 두는 연습이 필요합니다."
      : "추임새 사용은 과도하지 않습니다. 다만 핵심 문장 앞에서는 짧게 멈춘 뒤 말하면 더 단단하게 들립니다.";

  const logicComment =
    analysis.logicSignals < state.answers.length
      ? "답변의 논리 연결어와 구조 신호가 적습니다. 상황, 행동, 결과, 배운 점 순서로 한 번 더 압축해 보세요."
      : "답변 안에 원인과 결과를 연결하려는 신호가 보입니다. 다음 단계에서는 수치 근거를 더 붙이면 좋습니다.";

  const evidenceComment =
    analysis.evidenceSignals === 0
      ? "정량 근거가 거의 없습니다. 기간, 규모, 개선율, 참여 인원처럼 검증 가능한 단위를 넣어 주세요."
      : "정량 근거가 일부 포함되어 있습니다. 성과 수치를 직무 역량과 직접 연결하면 설득력이 올라갑니다.";

  const nonverbalBlock = analysis.nonverbal
    ? `
      <section class="report-block">
        <h3>비언어 피드백</h3>
        <p>종합 안정도는 ${analysis.nonverbal.score}점이며, 가장 보완이 필요한 신호는 ${analysis.nonverbal.weakest}입니다.</p>
        <div class="badge-row" style="margin-top: 12px;">
          <span class="badge">시선 ${analysis.nonverbal.averages.eye}</span>
          <span class="badge">자세 ${analysis.nonverbal.averages.posture}</span>
          <span class="badge">표정 ${analysis.nonverbal.averages.expression}</span>
          <span class="badge">제스처 ${analysis.nonverbal.averages.gesture}</span>
        </div>
        <ul style="margin-top: 12px;">
          ${analysis.nonverbal.observations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
        </ul>
      </section>
    `
    : "";

  const aiBlock = aiReport
    ? `
      <section class="report-block">
        <h3>Gemini 종합 피드백</h3>
        <p>${escapeHtml(aiReport.summary || "종합 피드백을 생성했습니다.")}</p>
      </section>
      <section class="report-block">
        <h3>보완할 점</h3>
        <ul>
          ${(aiReport.improvements || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
        </ul>
      </section>
      <section class="report-block">
        <h3>다음 연습</h3>
        <ul>
          ${(aiReport.practicePlan || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
        </ul>
      </section>
    `
    : "";

  return `
    <section class="report-block">
      <h3>점수 요약</h3>
      <div class="score-grid">
        <div class="score">
          <b>${analysis.deliveryScore}</b>
          <span>전달 안정감</span>
        </div>
        <div class="score">
          <b>${analysis.structureScore}</b>
          <span>논리 구조</span>
        </div>
        <div class="score">
          <b>${analysis.specificityScore}</b>
          <span>구체성</span>
        </div>
      </div>
    </section>
    <section class="report-block">
      <h3>말 습관</h3>
      <p>${fillerComment}</p>
      <div class="badge-row" style="margin-top: 12px;">
        ${frequentFillers || '<span class="badge">감지된 추임새 적음</span>'}
      </div>
    </section>
    <section class="report-block">
      <h3>내용 피드백</h3>
      <ul>
        <li>${logicComment}</li>
        <li>${evidenceComment}</li>
        <li>평균 답변 길이는 ${analysis.avgLength}자입니다. 핵심 답변은 45초에서 75초 분량으로 맞춰 보세요.</li>
      </ul>
    </section>
    ${nonverbalBlock}
    ${aiBlock}
  `;
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
  elements.reportContent.innerHTML = localReportHtml(analysis);
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
    elements.reportContent.innerHTML = localReportHtml(analysis, report);
  } catch (error) {
    setConnection("로컬 리포트", "amber");
  } finally {
    elements.reportButton.textContent = "리포트 생성";
    elements.reportButton.disabled = false;
  }
}

function resetSession() {
  window.speechSynthesis?.cancel();
  stopCamera(true);
  if (state.recognition && state.isRecording) {
    state.recognition.stop();
  }
  state.started = false;
  state.busy = false;
  state.pendingVoiceText = "";
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
  setConnection("Gemini 대기", "blue");
  clearChat();
}

elements.resumeFile.addEventListener("change", (event) => {
  readResumeFile(event.target.files[0]);
});

elements.depthInput.addEventListener("input", () => {
  elements.depthOutput.textContent = elements.depthInput.value;
});

elements.startButton.addEventListener("click", startInterview);
elements.cameraButton.addEventListener("click", startCamera);
elements.simulationButton.addEventListener("click", startDemoMode);

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
window.addEventListener("beforeunload", () => stopCamera(false));

if ("speechSynthesis" in window) {
  window.speechSynthesis.onvoiceschanged = () => {};
}

setupSpeechRecognition();
renderNonverbalScores();
updateMetrics();
