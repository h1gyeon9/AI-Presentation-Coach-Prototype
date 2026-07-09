const interviewScreens = [...document.querySelectorAll("[data-screen]")];
// Interview screen flow
const interviewTypeSelect = document.getElementById("interview-type");
const interviewSetupNext = document.getElementById("interview-setup-next");
const interviewBranchButtons = [...document.querySelectorAll("[data-interview-branch]")];
const interviewPersonaSelect = document.getElementById("personaInput");
const interviewReportButton = document.getElementById("reportButton");
const interviewReportContent = document.getElementById("reportContent");
const interviewResumeFile = document.getElementById("resumeFile");

let interviewBranch = "questions";
let interviewCheckStream = null;

function showInterviewScreen(name) {
  interviewScreens.forEach((screen) => {
    screen.classList.toggle("is-active", screen.dataset.screen === name);
  });

  if (name !== "interview-environment") {
    stopInterviewCheckCamera();
  }

  if (name === "interview-environment") {
    startInterviewCheckCamera();
  }

  window.scrollTo({ top: 0, behavior: "instant" });
}

document.querySelectorAll("[data-go]").forEach((button) => {
  button.addEventListener("click", () => showInterviewScreen(button.dataset.go));
});

interviewResumeFile.addEventListener("change", () => {
  document.getElementById("fileName").classList.toggle("is-ready", Boolean(interviewResumeFile.files?.[0]));
});

interviewTypeSelect.addEventListener("change", () => {
  interviewSetupNext.disabled = !interviewTypeSelect.value;
  persistSession();
});

interviewBranchButtons.forEach((button) => {
  button.addEventListener("click", () => {
    interviewBranch = button.dataset.interviewBranch;
    interviewBranchButtons.forEach((item) => {
      const selected = item === button;
      item.classList.toggle("is-selected", selected);
      item.setAttribute("aria-pressed", String(selected));
    });
  });
});

interviewSetupNext.addEventListener("click", async () => {
  if (!interviewTypeSelect.value) return;
  if (interviewBranch === "practice") {
    showInterviewScreen("interview-environment");
    return;
  }

  showInterviewScreen("questions-loading");
  await loadExpectedQuestions();
});

async function loadExpectedQuestions() {
  const container = document.getElementById("expected-questions-content");
  document.getElementById("questions-persona-label").textContent =
    interviewPersonaSelect.selectedOptions[0]?.textContent || "가상 면접관";

  try {
    const response = await fetch("/.netlify/functions/gemini-interview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "questions",
        profile: getProfile(),
        interviewType: interviewTypeSelect.selectedOptions[0]?.textContent || "",
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "예상 질문 생성에 실패했습니다.");
    const questions = Array.isArray(data.questions) ? data.questions : [];
    renderExpectedQuestions(questions.length ? questions : fallbackExpectedQuestions());
  } catch (error) {
    renderExpectedQuestions(fallbackExpectedQuestions());
  }

  showInterviewScreen("questions-report");
}

function renderExpectedQuestions(questions) {
  const grouped = questions.reduce((result, item) => {
    const category = item.category || "직무 경험 (적합성)";
    if (!result[category]) result[category] = [];
    result[category].push(item);
    return result;
  }, {});

  document.getElementById("expected-questions-content").innerHTML = Object.entries(grouped)
    .map(
      ([category, items]) => `
        <section class="question-group">
          <h3>${escapeFlowHtml(category)}</h3>
          <ol>
            ${items
              .map(
                (item) => `
                  <li>
                    <strong>${escapeFlowHtml(item.question || String(item))}</strong>
                    ${item.intent ? `<p>질문 의도 · ${escapeFlowHtml(item.intent)}</p>` : ""}
                  </li>
                `,
              )
              .join("")}
          </ol>
        </section>
      `,
    )
    .join("");
}

function fallbackExpectedQuestions() {
  const role = document.getElementById("roleInput").value.trim() || "지원 직무";
  return [
    {
      category: "직무 경험 (적합성)",
      question: `${role} 직무와 가장 밀접한 경험에서 본인이 직접 맡은 역할을 설명해주세요.`,
      intent: "직무 연관성과 실제 기여 범위를 확인합니다.",
    },
    {
      category: "직무 경험 (적합성)",
      question: "그 경험의 결과를 수치나 구체적인 변화로 설명해주세요.",
      intent: "성과를 객관적인 근거로 설명하는 능력을 확인합니다.",
    },
    {
      category: "위기 및 갈등 관리",
      question: "팀 내 의견 충돌을 해결했던 경험과 본인의 판단 기준을 말씀해주세요.",
      intent: "협업 방식과 갈등 해결 역량을 확인합니다.",
    },
    {
      category: "위기 및 갈등 관리",
      question: "실패했던 경험에서 다시 같은 상황이 온다면 무엇을 다르게 하시겠습니까?",
      intent: "회고 능력과 재발 방지 사고를 확인합니다.",
    },
  ];
}

function escapeFlowHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function startInterviewCheckCamera() {
  const video = document.getElementById("interview-check-video");
  const placeholder = document.getElementById("interview-check-placeholder");
  try {
    interviewCheckStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 360 }, facingMode: "user" },
      audio: false,
    });
    video.srcObject = interviewCheckStream;
    placeholder.hidden = true;
  } catch (error) {
    placeholder.hidden = false;
    placeholder.textContent = "카메라 권한이 필요합니다";
  }
}

function stopInterviewCheckCamera() {
  interviewCheckStream?.getTracks().forEach((track) => track.stop());
  interviewCheckStream = null;
  const video = document.getElementById("interview-check-video");
  if (video) video.srcObject = null;
}

document.getElementById("interview-mic-check").addEventListener("click", async () => {
  const status = document.getElementById("interview-check-status");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    status.textContent = "마이크 연결을 확인했어요.";
    setTimeout(() => stream.getTracks().forEach((track) => track.stop()), 1000);
  } catch (error) {
    status.textContent = "마이크 권한을 허용한 뒤 다시 시도해주세요.";
  }
});

document.getElementById("interview-speaker-check").addEventListener("click", () => {
  const status = document.getElementById("interview-check-status");
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

document.getElementById("startButton").addEventListener("click", () => {
  showInterviewScreen("interview-practice");
});

function setInterviewReportPersona() {
  document.getElementById("interview-report-persona").textContent =
    interviewPersonaSelect.selectedOptions[0]?.textContent || "가상 면접관";
}

interviewReportButton.addEventListener("click", () => {
  if (interviewReportButton.disabled) return;
  setInterviewReportPersona();
  showInterviewScreen("interview-loading");
}, { capture: true });

const interviewReportObserver = new MutationObserver(() => {
  const loading = document
    .querySelector('[data-screen="interview-loading"]')
    .classList.contains("is-active");
  if (loading && state.lastReport) {
    setInterviewReportPersona();
    showInterviewScreen("interview-report");
  }
});

interviewReportObserver.observe(interviewReportButton, {
  attributes: true,
  childList: true,
  subtree: true,
});

document.getElementById("interview-restart").addEventListener("click", () => {
  document.getElementById("resetButton").click();
  showInterviewScreen("interview-upload");
});

window.addEventListener("beforeunload", stopInterviewCheckCamera);

if (interviewTypeSelect.value) {
  interviewSetupNext.disabled = false;
}

if (state.lastReport) {
  showInterviewScreen("interview-report");
} else if (state.started) {
  showInterviewScreen("interview-practice");
}
