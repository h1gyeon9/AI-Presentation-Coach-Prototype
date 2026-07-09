// Presentation screen flow
const presentationScreens = [...document.querySelectorAll("[data-screen]")];
const presentationType = document.getElementById("presentation-type-select");
const presentationPurpose = document.getElementById("audience-select");
const presentationSetupNext = document.getElementById("presentation-setup-next");
const presentationModeSelect = document.getElementById("mode-select");
const presentationBranchButtons = [...document.querySelectorAll("[data-presentation-branch]")];
const presentationBranchNext = document.getElementById("presentation-branch-next");
const presentationGenerateButton = document.getElementById("generate-report-btn");
const presentationScriptAction = document.getElementById("script-analysis-action");
const presentationPracticeAction = document.getElementById("practice-analysis-action");
const presentationStatusBadge = document.getElementById("status-badge");
const presentationReportContent = document.getElementById("report-content");
const presentationDocumentInput = document.getElementById("presentation-document-input");
const presentationDocumentState = document.getElementById("presentation-document-state");
const presentationScriptText = document.getElementById("script-text");

let presentationBranch = "script";
let presentationCheckStream = null;
let presentationCalibrationStream = null;
let presentationCalibrationInterval = null;

function showPresentationScreen(name) {
  presentationScreens.forEach((screen) => {
    screen.classList.toggle("is-active", screen.dataset.screen === name);
  });

  if (name !== "calibration") {
    stopPresentationCalibration();
  }

  if (name === "calibration") {
    startPresentationCalibration();
  }

  if (name === "practice") {
    presentationPracticeAction.appendChild(presentationGenerateButton);
    presentationGenerateButton.textContent = "발표 분석 시작";
  } else if (name === "script") {
    presentationScriptAction.appendChild(presentationGenerateButton);
    presentationGenerateButton.textContent = "대본 분석 시작";
  }

  window.scrollTo({ top: 0, behavior: "instant" });
}

document.querySelectorAll("[data-go]").forEach((button) => {
  button.addEventListener("click", () => showPresentationScreen(button.dataset.go));
});

function updatePresentationSetup() {
  presentationSetupNext.disabled = !(presentationType.value && presentationPurpose.value);
  updateGenerateReportAvailability();
}

presentationType.addEventListener("change", updatePresentationSetup);
presentationPurpose.addEventListener("change", updatePresentationSetup);

presentationBranchButtons.forEach((button) => {
  button.addEventListener("click", () => {
    presentationBranch = button.dataset.presentationBranch;
    presentationBranchButtons.forEach((item) => {
      const selected = item === button;
      item.classList.toggle("is-selected", selected);
      item.setAttribute("aria-pressed", String(selected));
    });
  });
});

presentationBranchNext.addEventListener("click", () => {
  presentationModeSelect.value = presentationBranch === "practice" ? "record" : "script";
  presentationModeSelect.dispatchEvent(new Event("change", { bubbles: true }));
  showPresentationScreen(presentationBranch === "practice" ? "environment" : "script");
});

document.getElementById("presentation-document-trigger").addEventListener("click", () => {
  presentationDocumentInput.click();
});

presentationDocumentInput.addEventListener("change", async () => {
  const file = presentationDocumentInput.files?.[0];
  if (!file) return;

  presentationDocumentState.textContent = `${file.name} · 파일을 확인하고 있어요.`;
  presentationDocumentState.classList.add("is-ready");

  try {
    const extension = file.name.split(".").pop()?.toLowerCase();
    let text = "";

    if (["txt", "md"].includes(extension)) {
      text = await file.text();
    } else if (["pdf", "docx"].includes(extension) && file.size <= 4 * 1024 * 1024) {
      const response = await fetch("/.netlify/functions/parse-document", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: file.name,
          data: await fileToBase64ForPresentation(file),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "문서 내용을 읽지 못했습니다.");
      text = data.text || "";
    }

    if (text.trim()) {
      presentationScriptText.value = text.trim();
      presentationScriptText.dispatchEvent(new Event("input", { bubbles: true }));
      presentationDocumentState.textContent = `${file.name} · 대본 초안을 불러왔어요.`;
    } else {
      presentationDocumentState.textContent = `${file.name} · 첨부 완료`;
    }
  } catch (error) {
    presentationDocumentState.textContent = `${file.name} · 첨부 완료 (대본은 직접 입력해주세요)`;
  }
});

function fileToBase64ForPresentation(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

document.getElementById("presentation-mic-check").addEventListener("click", async () => {
  const status = document.getElementById("presentation-check-status");
  try {
    presentationCheckStream?.getTracks().forEach((track) => track.stop());
    presentationCheckStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    status.textContent = "마이크 연결을 확인했어요.";
    setTimeout(() => {
      presentationCheckStream?.getTracks().forEach((track) => track.stop());
      presentationCheckStream = null;
    }, 1200);
  } catch (error) {
    status.textContent = "마이크 권한을 허용한 뒤 다시 시도해주세요.";
  }
});

document.getElementById("presentation-speaker-check").addEventListener("click", () => {
  const status = document.getElementById("presentation-check-status");
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    status.textContent = "이 브라우저에서는 스피커 테스트를 지원하지 않습니다.";
    return;
  }
  const context = new AudioContextClass();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.value = 523.25;
  gain.gain.value = 0.08;
  oscillator.connect(gain).connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.35);
  oscillator.addEventListener("ended", () => context.close());
  status.textContent = "테스트음이 들렸다면 스피커 준비가 완료됐어요.";
});

async function startPresentationCalibration() {
  const video = document.getElementById("presentation-calibration-video");
  const placeholder = document.getElementById("presentation-calibration-placeholder");
  const timer = document.getElementById("presentation-calibration-timer");
  let seconds = 5;
  timer.textContent = "00:05";
  clearInterval(presentationCalibrationInterval);
  presentationCalibrationInterval = setInterval(() => {
    seconds = Math.max(0, seconds - 1);
    timer.textContent = `00:${String(seconds).padStart(2, "0")}`;
    if (seconds === 0) clearInterval(presentationCalibrationInterval);
  }, 1000);

  try {
    presentationCalibrationStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 360 }, facingMode: "user" },
      audio: false,
    });
    video.srcObject = presentationCalibrationStream;
    placeholder.hidden = true;
  } catch (error) {
    placeholder.hidden = false;
    placeholder.textContent = "카메라 권한이 필요합니다";
  }
}

function stopPresentationCalibration() {
  clearInterval(presentationCalibrationInterval);
  presentationCalibrationInterval = null;
  presentationCalibrationStream?.getTracks().forEach((track) => track.stop());
  presentationCalibrationStream = null;
  const video = document.getElementById("presentation-calibration-video");
  if (video) video.srcObject = null;
}

presentationGenerateButton.addEventListener("click", () => {
  if (presentationGenerateButton.disabled) return;
  if (
    presentationModeSelect.value === "record" &&
    document.getElementById("video-preview").hidden &&
    document.getElementById("audio-preview").hidden
  ) {
    return;
  }
  setTimeout(() => {
    if (presentationStatusBadge.classList.contains("busy")) {
      showPresentationScreen("loading");
    }
  }, 0);
});

const presentationStatusObserver = new MutationObserver(() => {
  if (presentationStatusBadge.classList.contains("done")) {
    const typeLabel = presentationType.selectedOptions[0]?.textContent || "발표";
    const purposeLabel = presentationPurpose.selectedOptions[0]?.textContent || "발표 목적";
    document.getElementById("presentation-report-type").textContent = typeLabel;
    document.getElementById("presentation-report-purpose").textContent =
      `${purposeLabel}에 맞춘 발표 리포트`;
    showPresentationScreen("report");
  } else if (
    document.querySelector('[data-screen="loading"]').classList.contains("is-active") &&
    !presentationStatusBadge.classList.contains("busy") &&
    !presentationReportContent.textContent.includes("분석 중")
  ) {
    showPresentationScreen("report");
  }
});

presentationStatusObserver.observe(presentationStatusBadge, {
  attributes: true,
  childList: true,
  subtree: true,
});

document.getElementById("reset-report-btn").addEventListener("click", () => {
  showPresentationScreen("ready");
});

window.addEventListener("beforeunload", () => {
  presentationCheckStream?.getTracks().forEach((track) => track.stop());
  stopPresentationCalibration();
});

updatePresentationSetup();
