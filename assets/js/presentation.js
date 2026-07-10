// Presentation recording and analysis
const MAX_MEDIA_BYTES = 4 * 1024 * 1024; // base64 인코딩(+33%) 후에도 Netlify 함수/로컬 dev 서버의 요청 한도를 넘지 않도록 여유치를 둠
const MIN_SCRIPT_LENGTH = 100;
const MIN_RECORD_SECONDS = 10;
// 로컬 netlify dev(및 실제 Netlify 동기 함수)는 응답까지 약 30초 제한이 있어,
// 영상이 길어질수록 Gemini 응답이 늦어져 타임아웃날 위험이 커진다. 그래서 녹화 자체를 짧게 제한한다.
const MAX_RECORD_SECONDS = 45;
const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/quicktime"];

// 기본 웹캠 녹화는 화질/비트레이트가 높아 몇 초 만에 용량 한도를 넘기 때문에,
// 해상도와 비트레이트를 낮춰서 녹화 자체의 크기를 줄인다.
const VIDEO_CONSTRAINTS = { width: { ideal: 320 }, height: { ideal: 240 } };
const VIDEO_BITRATE = 200000;
const AUDIO_BITRATE = 32000;

const RECORD_LABEL = "레코딩";
const SPEECH_CHARS_PER_MINUTE = 300; // 한국어 발표 발화 속도 추정치 (분당 글자 수)

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
const recTimerBadge = document.getElementById("rec-timer-badge");
const recTimerValue = document.getElementById("rec-timer-value");

const mediaFileInput = document.getElementById("media-file");
const cameraToggleBtn = document.getElementById("camera-toggle-btn");
const recordBtn = document.getElementById("record-btn");
const uploadBtn = document.getElementById("upload-btn");
const retakeBtn = document.getElementById("retake-btn");
const resetBtn = document.getElementById("reset-btn");

const metricBars = document.getElementById("metric-bars");
const eventLog = document.getElementById("event-log");

const confirmScriptBtn = document.getElementById("confirm-script-btn");
const scriptConfirmStatus = document.getElementById("script-confirm-status");

const generateReportBtn = document.getElementById("generate-report-btn");
const reportHint = document.getElementById("report-hint");
const reportDashboardRoot = document.getElementById("report-dashboard-root");

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
  recTimerValue.textContent = formatTime(elapsedSeconds);
  recTimerBadge.hidden = false;
  timerInterval = setInterval(() => {
    elapsedSeconds += 1;
    statTime.textContent = formatTime(elapsedSeconds);
    recTimerValue.textContent = formatTime(elapsedSeconds);
    if (elapsedSeconds >= MAX_RECORD_SECONDS && recorder && recorder.state === "recording") {
      pushLogEntry(`최대 레코딩 시간(${MAX_RECORD_SECONDS}초)에 도달해 자동으로 종료합니다.`);
      recorder.stop();
    }
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  recTimerBadge.hidden = true;
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
  camBox.classList.remove("scanning");
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
    camBox.classList.remove("scanning");
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
  if (cameraOn) camBox.classList.add("scanning");
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

function buildPresentationReportModel(report, ctx) {
  const scores = report.scores || {};
  const speech = report.speechMetrics || {};
  const contentAnalysis = report.contentAnalysis || {};
  const nonverbal = report.nonverbalAnalysis || {};
  const coaching = Array.isArray(report.coaching) ? report.coaching : [];
  const followUp = Array.isArray(report.followUpQuestions) ? report.followUpQuestions : [];
  const history = report.historyComparison || {};
  const overall = Math.round(report.overallScore || 0);
  const priorityRank = { high: 0, medium: 1, low: 2 };
  const sortedCoaching = [...coaching].sort(
    (a, b) => (priorityRank[a.priority] ?? 3) - (priorityRank[b.priority] ?? 3),
  );
  const topIssue = sortedCoaching[0] || {};
  const emojiIndex = overall >= 80 ? 1 : overall >= 60 ? 3 : overall >= 40 ? 0 : 2;
  const durationLabel = formatTime(
    speech.totalDurationSeconds || (ctx.mode === "script" ? estimateSpeakingSeconds(scriptText.value) : elapsedSeconds),
  );
  const dateLabel = new Date().toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" });
  const hasVideo = ctx.mode === "video" && Boolean(mediaStore.blob);
  const radarLabels = ["자신감", "논리성", "전달력", "유창함", "시선처리", "발음"];
  const radarMine = [
    scores.delivery || 0,
    scores.logic || 0,
    scores.delivery || 0,
    speech.naturalness || 0,
    scores.eyeContact || 0,
    scores.pronunciation || 0,
  ];
  const radarAvg = [62, 62, 62, 62, 62, 62];

  return {
    title: "발표 분석 결과",
    meta: `${dateLabel} · ${ctx.typeLabel || "발표"} · ${getModeLabel()} · 발표 시간 ${durationLabel}`,
    userName: "김발표",
    userSub: `${ctx.purposeLabel || "발표"} 코칭`,
    sessionBadge: dateLabel,
    defaultTab: "report",
    tabs: [
      { id: "script", label: "발표 대본 분석", visible: ctx.mode === "script" },
      { id: "report", label: "종합 레포트" },
      { id: "ai", label: "AI 분석 상세" },
      { id: "video", label: "영상 분석" },
    ],
    report: {
      coaching: {
        emojis: ["😤", "😊", "😰", "😐"],
        activeIndex: emojiIndex,
        title: topIssue.issue || report.summary || "분석 결과를 확인해보세요",
        body: topIssue.action || report.summary || "",
      },
      voice: {
        wpm: speech.estimatedWpm || 0,
        silenceRatioPct: speech.estimatedSilenceRatio || 0,
        durationLabel,
        seed: (speech.estimatedWpm || 0) + overall + 10,
        bars: [
          { label: "발음 명확도", value: scores.pronunciation || 0, color: "#00e5e5" },
          { label: "말하기 자연스러움", value: speech.naturalness || 0, color: "#00c9a7" },
          { label: "강세 & 억양", value: speech.intonation || 0, color: "#ffa502" },
          { label: "호흡 안정성", value: speech.breathingStability || 0, color: "#5352ed" },
        ],
      },
      content: {
        donutPct: overall,
        subScores: [
          { label: "핵심 메시지 전달", score: scores.evidence || 0, color: "#00e5e5" },
          { label: "논리적 구조", score: scores.logic || 0, color: "#00c9a7" },
          { label: "근거 및 예시", score: scores.delivery || 0, color: "#ffa502" },
        ],
        note: contentAnalysis.logicSummary || contentAnalysis.evidenceSummary || report.summary || "",
      },
      radar: {
        labels: radarLabels,
        mine: radarMine,
        avg: radarAvg,
        badges: [
          { label: "자신감", value: scores.delivery || 0, color: "#00e5e5" },
          { label: "발음", value: scores.pronunciation || 0, color: "#00c9a7" },
          { label: "논리성", value: scores.logic || 0, color: "#ffa502" },
        ],
        note: contentAnalysis.strengths?.[0] || "",
      },
      scoreSummary: {
        big: overall,
        items: [
          { label: "내용", value: scores.logic || 0, color: "#00e5e5" },
          { label: "전달", value: scores.delivery || 0, color: "#00c9a7" },
          { label: "음성", value: scores.pronunciation || 0, color: "#ffa502" },
          { label: "태도", value: scores.eyeContact || 0, color: "#5352ed" },
        ],
      },
    },
    ai: {
      subtitle: "10개 핵심 지표 기반 분석",
      metrics: [
        { label: "논리 구조", value: scores.logic || 0, color: "#00e5e5" },
        { label: "근거/예시", value: scores.evidence || 0, color: "#00c9a7" },
        { label: "전달력", value: scores.delivery || 0, color: "#ffa502" },
        { label: "발음 명확도", value: scores.pronunciation || 0, color: "#5352ed" },
        { label: "시선 처리", value: scores.eyeContact || 0, color: "#00e5e5" },
        { label: "자세", value: scores.posture || 0, color: "#00c9a7" },
        { label: "표정", value: scores.expression || 0, color: "#ffa502" },
        { label: "제스처", value: scores.gesture || 0, color: "#5352ed" },
        { label: "자연스러움", value: speech.naturalness || 0, color: "#00e5e5" },
        { label: "억양", value: speech.intonation || 0, color: "#00c9a7" },
      ],
      radar: { labels: radarLabels, mine: radarMine, avg: radarAvg },
      insights: sortedCoaching.slice(0, 5).map((item) => ({
        title: item.issue || "개선 포인트",
        body: `${item.action || ""}${item.evidence ? ` (${item.evidence})` : ""}`,
      })),
      historyNote: history.available ? history.summary : "이전 세션 데이터가 없어 비교할 수 없습니다.",
    },
    video: {
      objectUrl: hasVideo ? URL.createObjectURL(mediaStore.blob) : null,
      emptyNote: nonverbal.available ? "" : "영상으로 연습을 녹화하면 비언어 분석 결과가 표시됩니다.",
      scores: [
        { label: "시선 처리", value: scores.eyeContact || 0, color: "#00e5e5" },
        { label: "자세", value: scores.posture || 0, color: "#00c9a7" },
        { label: "표정/제스처", value: Math.round(((scores.expression || 0) + (scores.gesture || 0)) / 2), color: "#ffa502" },
      ],
      feedback: nonverbal.available ? (nonverbal.observations || []).map((text) => ({ text })) : [],
      emptyFeedbackNote: nonverbal.summary || "영상 기반 비언어 피드백이 아직 없습니다.",
    },
    script:
      ctx.mode === "script"
        ? {
            subtitle: `${ctx.typeLabel || "발표"} · 대본 구조 분석`,
            scoreTiles: [
              { label: "종합 점수", value: overall, color: "#00e5e5" },
              { label: "논리 구조", value: scores.logic || 0, color: "#00c9a7" },
              { label: "근거 및 예시", value: scores.evidence || 0, color: "#ffa502" },
              { label: "전달력", value: scores.delivery || 0, color: "#5352ed" },
            ],
            summary: report.summary || "",
            strengths: contentAnalysis.strengths || [],
            improvements: sortedCoaching.map((item) => ({
              title: item.issue,
              detail: `${item.action || ""}${item.evidence ? ` — ${item.evidence}` : ""}`,
              tone: item.priority === "high" ? "bad" : item.priority === "medium" ? "warn" : "good",
            })),
            qa: followUp.map((item) => ({
              question: item.question,
              intent: item.intent,
              points: (item.suggestedAnswerPoints || []).join(", "),
            })),
          }
        : null,
    actions: {
      shareLabel: "PDF로 저장",
      homeLabel: "처음으로",
      resetLabel: "발표 연습 이어가기",
      onShare: () => window.print(),
      onHome: () => showPresentationScreen("ready"),
      onReset: () => {
        if (typeof presentationBranch !== "undefined") presentationBranch = "practice";
        modeSelect.value = "record";
        modeSelect.dispatchEvent(new Event("change", { bubbles: true }));
        document.querySelectorAll("[data-presentation-branch]").forEach((button) => {
          const selected = button.dataset.presentationBranch === "practice";
          button.classList.toggle("is-selected", selected);
          button.setAttribute("aria-pressed", String(selected));
        });
        const nextButton = document.getElementById("presentation-branch-next");
        if (nextButton) nextButton.disabled = false;
        showPresentationScreen("environment");
      },
    },
  };
}

generateReportBtn.addEventListener("click", async () => {
  const mode = getBackendMode();
  const script = scriptText.value.trim();

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
  // 로딩 화면 전환을 setTimeout(0) + busy 클래스 검사에 의존하면, 로컬처럼
  // 요청이 즉시 실패하는 환경에서 상태가 이미 원복된 뒤 검사가 실행되는
  // 레이스가 생겨 화면이 넘어가지 않는다. 여기서 동기적으로 바로 전환한다.
  showPresentationScreen("loading");

  try {
    let mediaBase64 = null;
    let mediaMimeType = null;
    if (mediaStore.blob) {
      mediaBase64 = await blobToBase64(mediaStore.blob);
      mediaMimeType = mediaStore.mimeType;
    }

    const data = await window.PitaAI.presentation.analyze({
      mode,
      script,
      mediaBase64,
      mediaMimeType,
      measuredMetrics: {
        recordedDurationSeconds: mode === "script" ? 0 : elapsedSeconds,
        scriptCharacterCount: script.length,
      },
    });

    const report = data.report || {};
    window.lastPresentationAiReport = report;

    const ctx = window.PitaAI.presentationContextFromDom();
    const model = buildPresentationReportModel(report, {
      mode,
      typeLabel: ctx.presentationType,
      purposeLabel: ctx.purpose,
    });
    window.PitaReportUI.renderDashboard(reportDashboardRoot, model);

    coachStatusLine.textContent = "분석이 완료됐습니다.";
    setStatus("done", "분석 완료");
    showPresentationScreen("report");
  } catch (err) {
    const message = err.message || "오류가 발생했습니다. 다시 시도해주세요.";
    coachStatusLine.textContent = message;
    setStatus(null, "Gemini 대기");
    alert(message);
    showPresentationScreen("ready");
  } finally {
    updateGenerateReportAvailability();
  }
});

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(dataUrlToBase64(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
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

updateModeUI();
updateGenerateReportAvailability();
