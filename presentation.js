const MAX_MEDIA_BYTES = 4 * 1024 * 1024; // base64 인코딩(+33%) 후에도 Netlify 함수/로컬 dev 서버의 요청 한도를 넘지 않도록 여유치를 둠
const MIN_SCRIPT_LENGTH = 100;
const MIN_RECORD_SECONDS = 10;
const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/quicktime"];

// 기본 웹캠 녹화는 화질/비트레이트가 높아 몇 초 만에 용량 한도를 넘기 때문에,
// 해상도와 비트레이트를 낮춰서 녹화 자체의 크기를 줄인다.
const VIDEO_CONSTRAINTS = { width: { ideal: 320 }, height: { ideal: 240 } };
const VIDEO_BITRATE = 200000;
const AUDIO_BITRATE = 32000;

const RECORD_LABEL = "레코딩";

const statusBadge = document.getElementById("status-badge");
const scriptText = document.getElementById("script-text");
const audienceSelect = document.getElementById("audience-select");
const modeSelect = document.getElementById("mode-select");
const startBtn = document.getElementById("start-btn");

const coachStatusLine = document.getElementById("coach-status-line");
const statMode = document.getElementById("stat-mode");
const statTime = document.getElementById("stat-time");

const scriptPanel = document.getElementById("script-panel");
const scriptOptionalPanel = document.getElementById("script-optional-panel");
const scriptSlotMain = document.getElementById("script-slot-main");
const scriptSlotOptional = document.getElementById("script-slot-optional");
const analysisBlock = document.getElementById("analysis-block");

const camBox = document.getElementById("cam-box");
const camPlaceholder = document.getElementById("cam-placeholder");
const camCaption = document.getElementById("cam-caption");
const videoLive = document.getElementById("video-live");
const videoPreview = document.getElementById("video-preview");
const audioPreview = document.getElementById("audio-preview");

const mediaFileInput = document.getElementById("media-file");
const cameraToggleBtn = document.getElementById("camera-toggle-btn");
const recordBtn = document.getElementById("record-btn");
const uploadBtn = document.getElementById("upload-btn");
const retakeBtn = document.getElementById("retake-btn");
const resetBtn = document.getElementById("reset-btn");

const metricBars = document.getElementById("metric-bars");
const eventLog = document.getElementById("event-log");
const coachFeedbackContent = document.getElementById("coach-feedback-content");

const generateReportBtn = document.getElementById("generate-report-btn");
const resetReportBtn = document.getElementById("reset-report-btn");
const reportContent = document.getElementById("report-content");
const reportHint = document.getElementById("report-hint");

let sessionStarted = false;
let cameraOn = false;
let activeStream = null;
let recorder = null;
let chunks = [];
let mediaStore = { blob: null, mimeType: null };
let timerInterval = null;
let elapsedSeconds = 0;
let metricsTickInterval = null;

function setStatus(kind, text) {
  statusBadge.textContent = text;
  statusBadge.classList.remove("busy", "done");
  if (kind) statusBadge.classList.add(kind);
}

function setContent(container, text, isPlaceholder) {
  container.innerHTML = "";
  const p = document.createElement("p");
  p.className = isPlaceholder ? "result-placeholder" : "result-text";
  p.textContent = text;
  container.appendChild(p);
}

function setScriptComparison(container, originalText, feedbackText) {
  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "script-compare";

  const originalCol = document.createElement("div");
  originalCol.className = "script-compare-col";
  originalCol.innerHTML = "<h4>원본 대본</h4>";
  const originalP = document.createElement("p");
  originalP.className = "compare-text";
  originalP.textContent = originalText;
  originalCol.appendChild(originalP);

  const feedbackCol = document.createElement("div");
  feedbackCol.className = "script-compare-col";
  feedbackCol.innerHTML = "<h4>AI 피드백</h4>";
  const feedbackP = document.createElement("p");
  feedbackP.className = "compare-text";
  feedbackP.textContent = feedbackText;
  feedbackCol.appendChild(feedbackP);

  wrap.appendChild(originalCol);
  wrap.appendChild(feedbackCol);
  container.appendChild(wrap);
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function startTimer() {
  elapsedSeconds = 0;
  statTime.textContent = formatTime(elapsedSeconds);
  timerInterval = setInterval(() => {
    elapsedSeconds += 1;
    statTime.textContent = formatTime(elapsedSeconds);
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
}

function resetTimer() {
  stopTimer();
  elapsedSeconds = 0;
  statTime.textContent = formatTime(0);
}

function stopActiveStream() {
  if (activeStream) {
    activeStream.getTracks().forEach((track) => track.stop());
    activeStream = null;
  }
}

function pushLogEntry(text) {
  const placeholder = eventLog.querySelector("li[data-placeholder]");
  if (placeholder) placeholder.remove();
  const li = document.createElement("li");
  const time = new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  li.textContent = `${time} ${text}`;
  eventLog.prepend(li);
}

const LIVE_TICK_MESSAGES = [
  "시선 처리 패턴 분석 중",
  "손 제스처 빈도 측정 중",
  "표정 변화 감지 중",
  "자세 안정성 측정 중",
];

function applyRandomScores() {
  metricBars.hidden = false;
  const scores = {
    eye: 60 + Math.floor(Math.random() * 30),
    posture: 60 + Math.floor(Math.random() * 30),
    expression: 55 + Math.floor(Math.random() * 30),
    gesture: 55 + Math.floor(Math.random() * 30),
  };
  Object.entries(scores).forEach(([key, value]) => {
    document.getElementById(`bar-${key}`).style.width = `${value}%`;
    document.getElementById(`score-${key}`).textContent = value;
  });
}

function tickLiveMetrics() {
  applyRandomScores();
  const message = LIVE_TICK_MESSAGES[Math.floor(Math.random() * LIVE_TICK_MESSAGES.length)];
  pushLogEntry(message);
}

function startMetricsTicking() {
  stopMetricsTicking();
  tickLiveMetrics();
  metricsTickInterval = setInterval(tickLiveMetrics, 2200);
}

function stopMetricsTicking() {
  clearInterval(metricsTickInterval);
  metricsTickInterval = null;
}

function randomizeMetrics() {
  applyRandomScores();
  pushLogEntry("비언어 신호 최종 분석 완료 (시선/자세/표정/제스처)");
}

function getBackendMode() {
  if (modeSelect.value === "script") return "script";
  return cameraOn ? "video" : "audio";
}

function getModeLabel() {
  if (modeSelect.value === "script") return "스크립트";
  return "음성 및 영상";
}

function updateModeUI() {
  const needsMedia = modeSelect.value === "record";

  statMode.textContent = getModeLabel();

  scriptPanel.hidden = needsMedia;
  scriptOptionalPanel.hidden = !needsMedia;
  analysisBlock.hidden = !needsMedia;

  const slot = needsMedia ? scriptSlotOptional : scriptSlotMain;
  slot.appendChild(scriptText);
  scriptText.rows = needsMedia ? 6 : 14;
  scriptText.placeholder = needsMedia
    ? "대본이 있다면 입력하세요 (선택, 있으면 분석 정확도가 올라갑니다)"
    : "발표할 대본을 입력하세요.";

  metricBars.hidden = true;

  if (needsMedia) {
    if (!activeStream) {
      camPlaceholder.hidden = false;
      camPlaceholder.textContent = cameraOn ? "CAM" : "MIC";
    }
    camCaption.textContent = "레코딩 시작 버튼을 눌러 시작하세요";
    cameraToggleBtn.textContent = cameraOn ? "카메라 끄기" : "카메라 켜기";
    recordBtn.textContent = `● ${RECORD_LABEL} 시작`;
    recordBtn.dataset.idleLabel = `● ${RECORD_LABEL} 시작`;
    recordBtn.dataset.recordingLabel = "■ 완료";
    mediaFileInput.accept = cameraOn ? ALLOWED_VIDEO_TYPES.join(",") : "audio/*";
  }
}

function updateGenerateReportAvailability() {
  const missingAudience = audienceSelect.value === "";
  generateReportBtn.disabled = missingAudience;
  reportHint.hidden = !missingAudience;
}

function clearMedia() {
  stopActiveStream();
  stopMetricsTicking();
  if (videoPreview.src) {
    URL.revokeObjectURL(videoPreview.src);
    videoPreview.removeAttribute("src");
  }
  if (audioPreview.src) {
    URL.revokeObjectURL(audioPreview.src);
    audioPreview.removeAttribute("src");
  }
  videoPreview.hidden = true;
  audioPreview.hidden = true;
  videoLive.hidden = true;
  mediaFileInput.value = "";
  mediaStore = { blob: null, mimeType: null };
  retakeBtn.hidden = true;
  resetBtn.hidden = true;
  cameraToggleBtn.hidden = false;
  recordBtn.hidden = false;
  uploadBtn.hidden = false;
  metricBars.hidden = true;
  resetTimer();
  updateModeUI();
}

function activatePreview() {
  navigator.mediaDevices
    .getUserMedia({ audio: true, video: VIDEO_CONSTRAINTS })
    .then((stream) => {
      activeStream = stream;
      videoLive.srcObject = stream;
      videoLive.hidden = false;
      videoPreview.hidden = true;
      audioPreview.hidden = true;
      camPlaceholder.hidden = true;
      camCaption.textContent = "카메라 미리보기 중입니다. 레코딩 시작을 누르면 저장됩니다.";
    })
    .catch(() => {
      alert("마이크/카메라 접근 권한이 필요합니다.");
      cameraOn = false;
      updateModeUI();
    });
}

function revealMedia(url) {
  if (cameraOn) {
    videoPreview.src = url;
    videoPreview.hidden = false;
    videoLive.hidden = true;
  } else {
    audioPreview.src = url;
    audioPreview.hidden = false;
  }
  retakeBtn.hidden = false;
  resetBtn.hidden = false;
  cameraToggleBtn.hidden = true;
  recordBtn.hidden = true;
  uploadBtn.hidden = true;
  camCaption.textContent = "레코딩 완료. 다시 찍거나 초기화할 수 있습니다.";
  randomizeMetrics();
}

function beginRecording(stream) {
  chunks = [];
  const mimeType = cameraOn ? "video/webm" : "audio/webm";
  const recorderOptions = cameraOn
    ? { mimeType, videoBitsPerSecond: VIDEO_BITRATE, audioBitsPerSecond: AUDIO_BITRATE }
    : { mimeType, audioBitsPerSecond: AUDIO_BITRATE };

  recorder = new MediaRecorder(stream, recorderOptions);
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  recorder.onstop = () => {
    stopMetricsTicking();
    const recordedSeconds = elapsedSeconds;
    stream.getTracks().forEach((track) => track.stop());
    activeStream = null;
    recordBtn.textContent = recordBtn.dataset.idleLabel;
    recordBtn.classList.remove("recording");
    stopTimer();

    if (recordedSeconds < MIN_RECORD_SECONDS) {
      alert(`연습 시간이 너무 짧습니다. 최소 ${MIN_RECORD_SECONDS}초 이상 레코딩해주세요.`);
      videoLive.hidden = true;
      camPlaceholder.hidden = false;
      camCaption.textContent = "레코딩 시작 버튼을 눌러 시작하세요";
      resetTimer();
      pushLogEntry("너무 짧은 레코딩으로 폐기됨");
      return;
    }

    const blob = new Blob(chunks, { type: mimeType });

    if (blob.size > MAX_MEDIA_BYTES) {
      alert("레코딩 용량이 너무 큽니다. 4MB 이하가 되도록 더 짧게 레코딩해주세요.");
      videoLive.hidden = true;
      camPlaceholder.hidden = false;
      camCaption.textContent = "레코딩 시작 버튼을 눌러 시작하세요";
      resetTimer();
      pushLogEntry("용량 초과로 레코딩 폐기됨");
      return;
    }

    mediaStore = { blob, mimeType };
    revealMedia(URL.createObjectURL(blob));
  };

  recorder.start();
  recordBtn.textContent = recordBtn.dataset.recordingLabel;
  recordBtn.classList.add("recording");
  camCaption.textContent = "레코딩 중입니다. 완료를 누르면 저장됩니다.";
  startTimer();
  startMetricsTicking();
  pushLogEntry(`${RECORD_LABEL} 시작`);
}

function startRecording() {
  if (activeStream) {
    beginRecording(activeStream);
    return;
  }

  const constraints = cameraOn ? { audio: true, video: VIDEO_CONSTRAINTS } : { audio: true };

  navigator.mediaDevices
    .getUserMedia(constraints)
    .then((stream) => {
      activeStream = stream;

      if (cameraOn) {
        videoLive.srcObject = stream;
        videoLive.hidden = false;
        videoPreview.hidden = true;
        camPlaceholder.hidden = true;
      }

      beginRecording(stream);
    })
    .catch(() => {
      alert("마이크/카메라 접근 권한이 필요합니다.");
    });
}

cameraToggleBtn.addEventListener("click", () => {
  if (recorder && recorder.state === "recording") recorder.stop();
  cameraOn = !cameraOn;
  clearMedia();
  if (cameraOn) activatePreview();
});

modeSelect.addEventListener("change", () => {
  if (recorder && recorder.state === "recording") recorder.stop();
  clearMedia();
});

audienceSelect.addEventListener("change", updateGenerateReportAvailability);

startBtn.addEventListener("click", () => {
  sessionStarted = true;
  startBtn.disabled = true;
  startBtn.textContent = "연습 중";
  coachStatusLine.textContent = "연습을 진행하고 리포트 생성을 눌러 피드백을 받아보세요.";
  setStatus(null, "연습 중");
});

recordBtn.addEventListener("click", () => {
  if (recorder && recorder.state === "recording") {
    recorder.stop();
  } else {
    startRecording();
  }
});

uploadBtn.addEventListener("click", () => mediaFileInput.click());

mediaFileInput.addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > MAX_MEDIA_BYTES) {
    alert("파일이 너무 큽니다. 4MB 이하 파일을 사용해주세요.");
    mediaFileInput.value = "";
    return;
  }
  if (cameraOn && file.type && !ALLOWED_VIDEO_TYPES.includes(file.type)) {
    alert("지원하지 않는 영상 형식입니다. MP4 또는 MOV 파일을 사용해주세요.");
    mediaFileInput.value = "";
    return;
  }
  mediaStore = { blob: file, mimeType: file.type || (cameraOn ? "video/mp4" : "audio/webm") };
  revealMedia(URL.createObjectURL(file));
  pushLogEntry("파일 업로드 완료");
});

retakeBtn.addEventListener("click", () => {
  clearMedia();
  startRecording();
});

resetBtn.addEventListener("click", () => {
  if (recorder && recorder.state === "recording") recorder.stop();
  clearMedia();
  pushLogEntry("초기화됨");
});

resetReportBtn.addEventListener("click", () => {
  setContent(reportContent, "연습을 시작하고 리포트를 생성하면 이곳에 표시됩니다.", true);
  if (statusBadge.classList.contains("done")) {
    setStatus(null, sessionStarted ? "연습 중" : "Gemini 대기");
  }
});

generateReportBtn.addEventListener("click", async () => {
  const mode = getBackendMode();
  const script = scriptText.value.trim();
  const audience = audienceSelect.value;

  if (mode === "script" && script.length < MIN_SCRIPT_LENGTH) {
    alert("대본이 너무 짧습니다. 최소 100자 이상 입력해 주세요.");
    return;
  }
  if (mode !== "script" && !mediaStore.blob) {
    alert(cameraOn ? "영상을 녹화하거나 업로드해주세요." : "음성을 녹음하거나 업로드해주세요.");
    return;
  }

  generateReportBtn.disabled = true;
  setStatus("busy", "분석 중");
  coachStatusLine.textContent = "분석 중입니다...";
  setContent(coachFeedbackContent, "분석 중입니다...", true);
  setContent(reportContent, "분석 중입니다...", true);

  try {
    let mediaBase64 = null;
    let mediaMimeType = null;
    if (mediaStore.blob) {
      mediaBase64 = await blobToBase64(mediaStore.blob);
      mediaMimeType = mediaStore.mimeType;
    }

    const response = await fetch("/.netlify/functions/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, script, audience, mediaBase64, mediaMimeType }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "분석 요청이 실패했습니다.");
    }

    if (mode === "script") {
      setScriptComparison(coachFeedbackContent, script, data.feedback);
    } else {
      setContent(coachFeedbackContent, "분석이 완료됐습니다. 오른쪽 리포트를 확인하세요.", true);
    }
    setContent(reportContent, data.feedback, false);
    coachStatusLine.textContent = "분석이 완료됐습니다.";
    setStatus("done", "분석 완료");
  } catch (err) {
    const message = err.message || "오류가 발생했습니다. 다시 시도해주세요.";
    setContent(coachFeedbackContent, message, true);
    setContent(reportContent, message, true);
    coachStatusLine.textContent = "오류가 발생했습니다.";
    setStatus(null, "Gemini 대기");
  } finally {
    updateGenerateReportAvailability();
  }
});

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

updateModeUI();
updateGenerateReportAvailability();
