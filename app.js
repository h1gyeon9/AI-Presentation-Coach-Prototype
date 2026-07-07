const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const preview = $('#preview');
const startBtn = $('#startBtn');
const stopBtn = $('#stopBtn');
const clearBtn = $('#clearBtn');
const analyzeBtn = $('#analyzeBtn');
const copyReportBtn = $('#copyReportBtn');
const recordingState = $('#recordingState');
const analysisState = $('#analysisState');
const analysisOverlay = $('#analysisOverlay');
const emptyVideoState = $('#emptyVideoState');
const overlayStep = $('#overlayStep');
const overlayPercent = $('#overlayPercent');
const report = $('#report');
const reportBody = $('#reportBody');

let stream = null;
let progressTimer = null;

const analysisSteps = [
  '얼굴 위치 감지 중',
  '시선 방향 추정 중',
  '자세 흔들림 분석 중',
  '발화 습관 리포트 구성 중',
];

const sampleReport = [
  {
    title: '영상 기반 관찰',
    items: [
      '얼굴은 대부분 화면 중앙에 위치하지만, 답변 후반부에서 고개가 아래로 내려가는 구간이 반복됩니다.',
      '시선은 카메라보다 화면 하단을 향하는 시간이 길어, 청중과 직접 대화하는 느낌이 약해질 수 있습니다.',
      '어깨 높이가 일정하지 않아 긴장감이 드러나는 편입니다. 첫 10초 동안 자세를 고정한 뒤 시작하면 안정적으로 보입니다.',
    ],
  },
  {
    title: '발표 전달력',
    items: [
      '핵심 메시지는 분명하지만 문장 길이가 길어지는 구간에서 설득 포인트가 흐려집니다.',
      '중요한 문장 뒤에 짧은 정지를 넣으면 자신감과 강조감이 더 잘 전달됩니다.',
      '말의 속도는 전반적으로 적절하지만 예시 설명 구간에서 조금 빨라지는 경향이 있습니다.',
    ],
  },
  {
    title: '내용 구조',
    items: [
      '문제 상황, 본인의 행동, 결과 순서가 비교적 잘 드러납니다.',
      '다만 답변 첫 문장에서 결론을 먼저 제시하면 면접관이 의도를 더 빠르게 파악할 수 있습니다.',
      '직무와 연결되는 키워드를 마지막 문장에 한 번 더 넣으면 답변 완성도가 올라갑니다.',
    ],
  },
  {
    title: '개선 우선순위 TOP 3',
    items: [
      '첫 문장을 결론형으로 바꾸기: “저는 사용자 문제를 빠르게 구조화해 해결하는 강점이 있습니다.”',
      '카메라 렌즈 근처에 시선 기준점을 두고, 문장 끝마다 0.5초 멈추기.',
      '긴 예시는 상황 설명을 줄이고 “행동과 결과” 중심으로 압축하기.',
    ],
  },
];

async function startCamera() {
  showOverlay();
  setStatus('카메라 입력을 준비하는 중입니다...', true);

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    preview.srcObject = stream;
    emptyVideoState.classList.add('hidden');
    startBtn.disabled = true;
    stopBtn.disabled = false;
    setStatus('영상 입력이 감지되었습니다. 얼굴 위치와 시선 추적 UI를 표시 중입니다.', true);
  } catch (error) {
    console.warn(error);
    emptyVideoState.classList.remove('hidden');
    startBtn.disabled = true;
    stopBtn.disabled = false;
    setStatus('카메라 권한 없이 데모 오버레이만 표시 중입니다.', true);
  }
}

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  preview.srcObject = null;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus('영상 입력이 중지되었습니다.');
}

function resetDemo() {
  stopCamera();
  hideOverlay();
  clearInterval(progressTimer);
  progressTimer = null;
  report.classList.add('hidden');
  analysisState.textContent = '';
  overlayPercent.textContent = '0%';
  overlayStep.textContent = 'Face position tracking';
  $$('.pipeline-step').forEach((step) => step.classList.remove('active', 'done'));
  emptyVideoState.classList.remove('hidden');
  setStatus('대기 중');
}

function showOverlay() {
  analysisOverlay.classList.remove('hidden');
}

function hideOverlay() {
  analysisOverlay.classList.add('hidden');
}

function setStatus(text, isActive = false) {
  recordingState.textContent = text;
  recordingState.classList.toggle('recording', isActive);
}

function setPipelineStep(index) {
  $$('.pipeline-step').forEach((step, stepIndex) => {
    step.classList.toggle('active', stepIndex === index);
    step.classList.toggle('done', stepIndex < index);
  });
}

function runAnalysisSimulation() {
  showOverlay();
  report.classList.add('hidden');
  analyzeBtn.disabled = true;
  analysisState.textContent = '영상 프레임을 분석하는 중입니다...';

  let progress = 0;
  clearInterval(progressTimer);

  progressTimer = setInterval(() => {
    progress += 4;
    const stepIndex = Math.min(Math.floor(progress / 25), analysisSteps.length - 1);
    setPipelineStep(stepIndex);
    overlayStep.textContent = analysisSteps[stepIndex];
    overlayPercent.textContent = `${Math.min(progress, 100)}%`;

    if (progress >= 100) {
      clearInterval(progressTimer);
      progressTimer = null;
      $$('.pipeline-step').forEach((step) => step.classList.add('done'));
      analysisState.textContent = '분석이 완료되었습니다. 샘플 코칭 리포트를 생성했습니다.';
      renderReport();
      report.classList.remove('hidden');
      report.scrollIntoView({ behavior: 'smooth', block: 'start' });
      analyzeBtn.disabled = false;
    }
  }, 90);
}

function renderReport() {
  reportBody.innerHTML = '';

  sampleReport.forEach((section) => {
    const article = document.createElement('article');
    article.className = 'report-section';

    const title = document.createElement('h3');
    title.textContent = section.title;
    article.appendChild(title);

    const list = document.createElement('ul');
    section.items.forEach((item) => {
      const li = document.createElement('li');
      li.textContent = item;
      list.appendChild(li);
    });
    article.appendChild(list);
    reportBody.appendChild(article);
  });
}

async function copyReport() {
  try {
    await navigator.clipboard.writeText(report.innerText.trim());
    copyReportBtn.textContent = '복사 완료';
    setTimeout(() => {
      copyReportBtn.textContent = '리포트 복사';
    }, 1200);
  } catch {
    alert('브라우저에서 클립보드 복사를 허용하지 않았습니다. 리포트 영역을 직접 선택해 복사해주세요.');
  }
}

startBtn.addEventListener('click', startCamera);
stopBtn.addEventListener('click', stopCamera);
clearBtn.addEventListener('click', resetDemo);
analyzeBtn.addEventListener('click', runAnalysisSimulation);
copyReportBtn.addEventListener('click', copyReport);
