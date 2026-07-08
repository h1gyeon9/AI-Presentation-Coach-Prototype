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
const SPEECH_CHARS_PER_MINUTE = 300; // 한국어 발표 발화 속도 추정치 (분당 글자 수)

// netlify/functions/analyze.js의 CONTENT_MARKER/NONVERBAL_MARKER와 정확히 일치해야 함
const CONTENT_MARKER = "## 내용 리포트";
const NONVERBAL_MARKER = "## 비언어 리포트";

const statusBadge = document.getElementById("status-badge");
const scriptText = document.getElementById("script-text");
const audienceSelect = document.getElementById("audience-select");
const modeSelect = document.getElementById("mode-select");

const coachStatusLine = document.getElementById("coach-status-line");
const statMode = document.getElementById("stat-mode");
const statTime = document.getElementById("stat-time");
const statTimeLabel = document.getElementById("stat-time-label");

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

const confirmScriptBtn = document.getElementById("confirm-script-btn");
const scriptConfirmStatus = document.getElementById("script-confirm-status");

const generateReportBtn = document.getElementById("generate-report-btn");
const resetReportBtn = document.getElementById("reset-report-btn");
const reportContent = document.getElementById("report-content");
const reportHint = document.getElementById("report-hint");
const nonverbalReportSection = document.getElementById("nonverbal-report-section");
const nonverbalReportContent = document.getElementById("nonverbal-report-content");

let scriptConfirmed = false;
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

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inlineFormat(text) {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

// Gemini 응답이 마크다운(#, **, - 등)으로 오기 때문에, 별도 라이브러리 없이
// 헤딩/굵게/목록 정도만 가볍게 HTML로 변환해서 가독성을 높인다.
function renderMarkdownLite(raw) {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const htmlParts = [];
  let listBuffer = [];
  let listType = null;
  let paragraphBuffer = [];

  function flushParagraph() {
    if (paragraphBuffer.length) {
      htmlParts.push(`<p>${paragraphBuffer.join(" ")}</p>`);
      paragraphBuffer = [];
    }
  }

  function flushList() {
    if (listBuffer.length) {
      const tag = listType === "ol" ? "ol" : "ul";
      htmlParts.push(`<${tag}>${listBuffer.map((item) => `<li>${item}</li>`).join("")}</${tag}>`);
      listBuffer = [];
      listType = null;
    }
  }

  lines.forEach((line) => {
    const trimmed = line.trim();

    if (trimmed === "") {
      flushParagraph();
      flushList();
      return;
    }

    if (/^#{1,6}\s+/.test(trimmed)) {
      flushParagraph();
      flushList();
      htmlParts.push(`<h4 class="md-heading">${inlineFormat(trimmed.replace(/^#{1,6}\s+/, ""))}</h4>`);
      return;
    }

    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      flushParagraph();
      flushList();
      htmlParts.push("<hr>");
      return;
    }

    const bulletMatch = trimmed.match(/^[-*]\s+(.*)/);
    if (bulletMatch) {
      flushParagraph();
      if (listType !== "ul") flushList();
      listType = "ul";
      listBuffer.push(inlineFormat(bulletMatch[1]));
      return;
    }

    const numberedMatch = trimmed.match(/^\d+[.)]\s+(.*)/);
    if (numberedMatch) {
      flushParagraph();
      if (listType !== "ol") flushList();
      listType = "ol";
      listBuffer.push(inlineFormat(numberedMatch[1]));
      return;
    }

    flushList();
    paragraphBuffer.push(inlineFormat(trimmed));
  });

  flushParagraph();
  flushList();

  return htmlParts.join("");
}

function splitReportSections(feedback) {
  const contentIndex = feedback.indexOf(CONTENT_MARKER);
  const nonverbalIndex = feedback.indexOf(NONVERBAL_MARKER);

  if (contentIndex === -1) {
    // 모델이 지정된 제목 형식을 따르지 않은 경우, 전체를 내용 리포트로 취급
    return { content: feedback.trim(), nonverbal: "" };
  }

  if (nonverbalIndex === -1) {
    return { content: feedback.slice(contentIndex + CONTENT_MARKER.length).trim(), nonverbal: "" };
  }

  return {
    content: feedback.slice(contentIndex + CONTENT_MARKER.length, nonverbalIndex).trim(),
    nonverbal: feedback.slice(nonverbalIndex + NONVERBAL_MARKER.length).trim(),
  };
}

function setContent(container, text, isPlaceholder) {
  container.innerHTML = "";
  if (isPlaceholder) {
    const p = document.createElement("p");
    p.className = "result-placeholder";
    p.textContent = text;
    container.appendChild(p);
    return;
  }
  const wrap = document.createElement("div");
  wrap.className = "result-text";
  wrap.innerHTML = renderMarkdownLite(text);
  container.appendChild(wrap);
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function estimateSpeakingSeconds(text) {
  const length = text.trim().length;
  return Math.round((length / SPEECH_CHARS_PER_MINUTE) * 60);
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
    statTimeLabel.textContent = "녹음 시간";
    statTime.textContent = formatTime(elapsedSeconds);

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
  } else {
    statTimeLabel.textContent = "예상 발표 시간";
    statTime.textContent = scriptConfirmed ? formatTime(estimateSpeakingSeconds(scriptText.value)) : "-";
  }
}

function updateGenerateReportAvailability() {
  const missingAudience = audienceSelect.value === "";
  const missingScriptConfirm = getBackendMode() === "script" && !scriptConfirmed;

  generateReportBtn.disabled = missingAudience || missingScriptConfirm;

  if (missingAudience) {
    reportHint.textContent = "왼쪽에서 청중 유형을 먼저 선택해주세요.";
  } else if (missingScriptConfirm) {
    reportHint.textContent = "대본을 입력하고 '대본 확정' 버튼을 눌러주세요.";
  }
  reportHint.hidden = !(missingAudience || missingScriptConfirm);
}

function setScriptConfirmed(confirmed) {
  scriptConfirmed = confirmed;
  if (confirmed) {
    const length = scriptText.value.trim().length;
    scriptConfirmStatus.textContent = `✓ 대본이 확정되었습니다 (총 ${length}자)`;
    scriptConfirmStatus.hidden = false;
    if (modeSelect.value === "script") {
      statTime.textContent = formatTime(estimateSpeakingSeconds(scriptText.value));
    }
  } else {
    scriptConfirmStatus.hidden = true;
    if (modeSelect.value === "script") {
      statTime.textContent = "-";
    }
  }
  updateGenerateReportAvailability();
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
  setScriptConfirmed(false);
  clearMedia();
});

audienceSelect.addEventListener("change", updateGenerateReportAvailability);

confirmScriptBtn.addEventListener("click", () => {
  if (scriptText.value.trim().length < MIN_SCRIPT_LENGTH) {
    alert("대본이 너무 짧습니다. 최소 100자 이상 입력해 주세요.");
    return;
  }
  setScriptConfirmed(true);
});

scriptText.addEventListener("input", () => {
  if (scriptConfirmed) setScriptConfirmed(false);
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
  setContent(reportContent, "리포트를 생성하면 이곳에 표시됩니다.", true);
  nonverbalReportSection.hidden = true;
  setContent(nonverbalReportContent, "영상 모드로 리포트를 생성하면 이곳에 표시됩니다.", true);
  if (statusBadge.classList.contains("done")) {
    setStatus(null, "Gemini 대기");
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
  nonverbalReportSection.hidden = true;

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

    const rawBody = await response.text();
    let data;
    try {
      data = JSON.parse(rawBody);
    } catch {
      throw new Error(
        rawBody
          ? `서버 응답을 해석하지 못했습니다: ${rawBody.slice(0, 200)}`
          : "서버로부터 빈 응답을 받았습니다. 파일 용량을 줄이거나 잠시 후 다시 시도해주세요."
      );
    }
    if (!response.ok) {
      throw new Error(data.error || "분석 요청이 실패했습니다.");
    }

    const { content, nonverbal } = splitReportSections(data.feedback);

    setContent(coachFeedbackContent, "분석이 완료됐습니다. 오른쪽 리포트를 확인하세요.", true);
    setContent(reportContent, content, false);

    if (mode === "video" && nonverbal) {
      nonverbalReportSection.hidden = false;
      setContent(nonverbalReportContent, nonverbal, false);
    } else {
      nonverbalReportSection.hidden = true;
    }

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
