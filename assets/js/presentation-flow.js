// Presentation screen flow
const presentationScreens = [...document.querySelectorAll("[data-screen]")];
const presentationType = document.getElementById("presentation-type-select");
const presentationPurpose = document.getElementById("audience-select");
const presentationSetupNext = document.getElementById("presentation-setup-next");
const presentationPersonaNext = document.getElementById("presentation-persona-next");
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
const presentationFileList = document.getElementById("presentation-file-list");
const presentationUploadBox = document.querySelector('[data-screen="upload"] .upload-box');
const presentationScriptText = document.getElementById("script-text");
const presentationTypeButtons = [...document.querySelectorAll("[data-type-value]")];
const presentationPersonaButtons = [...document.querySelectorAll("[data-persona-value]")];

let presentationBranch = null;
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
  presentationSetupNext.disabled = !presentationType.value;
  presentationPersonaNext.disabled = !presentationPurpose.value;
  updateGenerateReportAvailability();
}

presentationType.addEventListener("change", updatePresentationSetup);
presentationPurpose.addEventListener("change", updatePresentationSetup);

function selectDesignOption(buttons, selectedButton, select, value) {
  select.value = value;
  buttons.forEach((button) => {
    const selected = button === selectedButton;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

presentationTypeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    selectDesignOption(
      presentationTypeButtons,
      button,
      presentationType,
      button.dataset.typeValue,
    );
  });
});

presentationPersonaButtons.forEach((button) => {
  button.addEventListener("click", () => {
    selectDesignOption(
      presentationPersonaButtons,
      button,
      presentationPurpose,
      button.dataset.personaValue,
    );
  });
});

presentationBranchButtons.forEach((button) => {
  button.addEventListener("click", () => {
    presentationBranch = button.dataset.presentationBranch;
    presentationBranchButtons.forEach((item) => {
      const selected = item === button;
      item.classList.toggle("is-selected", selected);
      item.setAttribute("aria-pressed", String(selected));
    });
    presentationBranchNext.disabled = false;
  });
});

presentationBranchNext.addEventListener("click", () => {
  if (!presentationBranch) return;
  presentationModeSelect.value = presentationBranch === "practice" ? "record" : "script";
  presentationModeSelect.dispatchEvent(new Event("change", { bubbles: true }));
  showPresentationScreen(presentationBranch === "practice" ? "environment" : "script");
});

document.getElementById("presentation-document-trigger").addEventListener("click", () => {
  presentationDocumentInput.click();
});

presentationDocumentInput.addEventListener("change", async () => {
  const files = [...(presentationDocumentInput.files || [])];
  const file = files[0];
  if (!file) return;

  renderPresentationFiles(files);
  presentationDocumentState.textContent = `${files.length}개 파일을 확인하고 있어요.`;
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
      presentationDocumentState.textContent = `${files.length}개 첨부 · 대본 초안을 불러왔어요.`;
    } else {
      presentationDocumentState.textContent = `${files.length}개 파일 · 첨부 완료`;
    }
  } catch (error) {
    presentationDocumentState.textContent = `${files.length}개 파일 · 첨부 완료 (대본은 직접 입력해주세요)`;
  }
});

function renderPresentationFiles(files) {
  presentationFileList.hidden = files.length === 0;
  presentationUploadBox.hidden = files.length > 0;
  presentationFileList.innerHTML = files
    .map((file, index) => {
      const extension = file.name.split(".").pop()?.toLowerCase();
      const isDocument = ["doc", "docx", "txt", "md"].includes(extension);
      const label = index === 0 ? "발표 자료" : index === 1 ? "추가 자료" : "발표 대본";
      const icon = isDocument ? "icon-article.svg" : "icon-link.svg";
      return `
        <section class="uploaded-file-group">
          <h3>${label}</h3>
          <div class="uploaded-file-row">
            <span><img src="./assets/images/${icon}" alt="" />${escapePresentationHtml(file.name)}</span>
            <button type="button" data-remove-file="${index}" aria-label="${escapePresentationHtml(file.name)} 삭제">
              <img src="./assets/images/icon-cancel.svg" alt="" />
            </button>
          </div>
        </section>
      `;
    })
    .join("");

  const addButton = document.createElement("button");
  addButton.className = "upload-more";
  addButton.type = "button";
  addButton.textContent = "파일 다시 선택";
  addButton.addEventListener("click", () => presentationDocumentInput.click());
  presentationFileList.appendChild(addButton);

  presentationFileList.querySelectorAll("[data-remove-file]").forEach((button) => {
    button.addEventListener("click", () => removePresentationFile(Number(button.dataset.removeFile)));
  });
}

function removePresentationFile(index) {
  const transfer = new DataTransfer();
  [...presentationDocumentInput.files].forEach((file, fileIndex) => {
    if (fileIndex !== index) transfer.items.add(file);
  });
  presentationDocumentInput.files = transfer.files;
  const remainingFiles = [...transfer.files];
  renderPresentationFiles(remainingFiles);
  presentationDocumentState.textContent = remainingFiles.length
    ? `${remainingFiles.length}개 파일 · 첨부 완료`
    : "선택된 파일이 없습니다.";
}

function escapePresentationHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

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
