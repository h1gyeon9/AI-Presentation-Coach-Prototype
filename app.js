const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const preview = $('#preview');
const recordedVideo = $('#recordedVideo');
const startBtn = $('#startBtn');
const stopBtn = $('#stopBtn');
const clearBtn = $('#clearBtn');
const analyzeBtn = $('#analyzeBtn');
const copyReportBtn = $('#copyReportBtn');
const recordingState = $('#recordingState');
const analysisState = $('#analysisState');
const transcriptEl = $('#transcript');

let mediaRecorder = null;
let recordedChunks = [];
let stream = null;
let recognition = null;
let startedAt = null;
let stoppedAt = null;
let liveTranscript = '';

const fillerWords = [
  '음', '어', '그', '그러니까', '뭐', '이제', '막', '사실', '일단', '약간',
  'like', 'um', 'uh', 'actually', 'basically', 'you know', 'so'
];

const stopwords = new Set([
  '그리고', '하지만', '그래서', '저는', '제가', '우리', '대한', '통해', '위해',
  '있는', '하는', '합니다', '입니다', '같은', '으로', '에서', '에게', '까지',
  '부터', '보다', '또한', 'the', 'and', 'for', 'with', 'that', 'this'
]);

function setStatus(text, isRecording = false) {
  recordingState.textContent = text;
  recordingState.classList.toggle('recording', isRecording);
}

function setAnalysisState(text, isError = false) {
  analysisState.textContent = text;
  analysisState.classList.toggle('error', isError);
}

async function startRecording() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    preview.srcObject = stream;
    recordedChunks = [];
    liveTranscript = '';
    startedAt = new Date();
    stoppedAt = null;

    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus'
      : 'video/webm';

    mediaRecorder = new MediaRecorder(stream, { mimeType });
    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) recordedChunks.push(event.data);
    };
    mediaRecorder.onstop = handleRecordingStop;
    mediaRecorder.start();

    startSpeechRecognition();

    startBtn.disabled = true;
    stopBtn.disabled = false;
    recordedVideo.classList.add('hidden');
    setStatus('녹화 중입니다. 발표가 끝나면 녹화 종료를 눌러주세요.', true);
  } catch (error) {
    console.error(error);
    setStatus('카메라 또는 마이크 권한을 확인해주세요. 권한 없이도 텍스트 입력 분석은 가능합니다.');
  }
}

function stopRecording() {
  stoppedAt = new Date();
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  if (recognition) recognition.stop();
  if (stream) stream.getTracks().forEach((track) => track.stop());
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus('녹화가 종료되었습니다. 전사 텍스트를 확인한 뒤 리포트를 생성하세요.');
}

function handleRecordingStop() {
  const blob = new Blob(recordedChunks, { type: 'video/webm' });
  recordedVideo.src = URL.createObjectURL(blob);
  recordedVideo.classList.remove('hidden');
}

function startSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    setStatus('녹화 중입니다. 현재 브라우저에서는 자동 음성 인식이 제한될 수 있습니다.', true);
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = 'ko-KR';
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onresult = (event) => {
    let interim = '';
    let finalText = liveTranscript;
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const text = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        liveTranscript += `${text} `;
        finalText = liveTranscript;
      } else {
        interim += text;
      }
    }
    transcriptEl.value = `${finalText}${interim}`.trim();
  };

  recognition.onerror = () => {
    setStatus('음성 인식이 불안정합니다. 녹화 후 스크립트를 직접 입력해도 분석할 수 있습니다.', true);
  };

  recognition.start();
}

function clearAll() {
  if (stream) stream.getTracks().forEach((track) => track.stop());
  if (recognition) recognition.stop();
  mediaRecorder = null;
  recordedChunks = [];
  liveTranscript = '';
  startedAt = null;
  stoppedAt = null;
  preview.srcObject = null;
  recordedVideo.src = '';
  recordedVideo.classList.add('hidden');
  transcriptEl.value = '';
  $('#report').classList.add('hidden');
  setAnalysisState('');
  setStatus('대기 중');
  startBtn.disabled = false;
  stopBtn.disabled = true;
}

function normalizeText(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[\n\r]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getWords(text) {
  return normalizeText(text)
    .replace(/[.,!?;:()[\]{}"'`~]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function extractKeywords(text) {
  return [...new Set(getWords(text).filter((word) => word.length >= 2 && !stopwords.has(word)))].slice(0, 35);
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function getDurationMinutes() {
  const manual = Number($('#durationMinutes').value);
  if (manual > 0) return manual;
  if (startedAt && stoppedAt) return Math.max((stoppedAt - startedAt) / 1000 / 60, 0.1);
  return null;
}

function countFillers(text) {
  const normalized = normalizeText(text);
  return fillerWords.reduce((sum, word) => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(^|\\s)${escaped}(?=\\s|$|[,.!?])`, 'gi');
    return sum + (normalized.match(regex) || []).length;
  }, 0);
}

function getSentenceStats(text) {
  const sentences = normalizeText(text)
    .split(/[.!?。]+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const lengths = sentences.map((sentence) => getWords(sentence).length);
  const avg = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;
  const longCount = lengths.filter((len) => len >= 35).length;
  return { count: sentences.length, avgLength: avg, longCount };
}

function makeLevel(score) {
  if (score >= 85) return '<span class="badge-ok">강점</span>';
  if (score >= 70) return '<span class="badge-warn">보완 필요</span>';
  return '<span class="badge-danger">우선 개선</span>';
}

function collectPayload() {
  const transcript = transcriptEl.value.trim();
  const words = getWords(transcript);
  const duration = getDurationMinutes();

  if (!transcript || words.length < 10) {
    throw new Error('분석하려면 최소 10단어 이상의 전사 텍스트나 스크립트를 입력해주세요.');
  }

  return {
    sessionType: $('#sessionType').value,
    purpose: $('#purpose').value.trim(),
    company: $('#company').value.trim(),
    role: $('#role').value.trim(),
    criteria: $('#criteria').value.trim(),
    transcript,
    durationMinutes: duration,
    visualIssues: $$('.visualCheck:checked').map((el) => el.value),
    localSignals: buildLocalSignals(transcript, duration),
  };
}

function buildLocalSignals(transcript, duration) {
  const words = getWords(transcript);
  const fillerCount = countFillers(transcript);
  const fillerRate = words.length ? (fillerCount / words.length) * 100 : 0;
  const sentenceStats = getSentenceStats(transcript);
  const wpm = duration ? words.length / duration : null;
  return {
    wordCount: words.length,
    fillerCount,
    fillerRate: Number(fillerRate.toFixed(1)),
    averageSentenceWords: Number(sentenceStats.avgLength.toFixed(1)),
    longSentenceCount: sentenceStats.longCount,
    wordsPerMinute: wpm ? Math.round(wpm) : null,
  };
}

async function analyze() {
  let payload;
  try {
    payload = collectPayload();
  } catch (error) {
    alert(error.message);
    return;
  }

  analyzeBtn.disabled = true;
  setAnalysisState('AI가 리포트를 생성하는 중입니다...');

  try {
    const aiReport = await requestAiReport(payload);
    renderAiReport(aiReport);
    setAnalysisState('AI 분석이 완료되었습니다.');
  } catch (error) {
    console.error(error);
    const fallback = buildFallbackReport(payload);
    renderAiReport(fallback);
    setAnalysisState(`AI 호출에 실패해 로컬 분석으로 대체했습니다. (${error.message})`, true);
  } finally {
    analyzeBtn.disabled = false;
    $('#report').classList.remove('hidden');
    $('#report').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

async function requestAiReport(payload) {
  const response = await fetch('/.netlify/functions/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || `HTTP ${response.status}`);
  }
  return data;
}

function buildFallbackReport(payload) {
  const { transcript, durationMinutes, visualIssues } = payload;
  const words = getWords(transcript);
  const contextText = [
    payload.purpose,
    payload.company,
    payload.role,
    payload.criteria,
    payload.sessionType,
  ].join(' ');

  const keywords = extractKeywords(contextText);
  const matchedKeywords = keywords.filter((keyword) => normalizeText(transcript).includes(keyword));
  const keywordFit = keywords.length ? matchedKeywords.length / keywords.length : 0.45;

  const fillerCount = countFillers(transcript);
  const fillerRate = words.length ? (fillerCount / words.length) * 100 : 0;
  const sentenceStats = getSentenceStats(transcript);
  const wpm = durationMinutes ? words.length / durationMinutes : null;

  let deliveryScore = 86;
  if (wpm !== null) {
    if (wpm < 95) deliveryScore -= 14;
    if (wpm > 175) deliveryScore -= 16;
    if (wpm > 210) deliveryScore -= 26;
  } else {
    deliveryScore -= 4;
  }
  if (sentenceStats.avgLength > 28) deliveryScore -= 10;
  if (sentenceStats.longCount > 1) deliveryScore -= 8;

  const habitScore = clamp(100 - fillerRate * 9 - sentenceStats.longCount * 4);
  const fitScore = clamp(52 + keywordFit * 48);
  const totalScore = clamp(deliveryScore * 0.32 + habitScore * 0.22 + fitScore * 0.34 + (100 - visualIssues.length * 5) * 0.12);
  const speedText = wpm === null
    ? '발표 시간이 입력되지 않아 말하기 속도는 계산하지 못했습니다.'
    : `현재 속도는 약 ${Math.round(wpm)}단어/분입니다. 보통 100~170단어/분 사이가 안정적으로 들립니다.`;

  return {
    scores: {
      total: totalScore,
      delivery: clamp(deliveryScore),
      fit: fitScore,
      habit: habitScore,
    },
    sections: [
      {
        title: `전달력 진단 ${stripTags(makeLevel(clamp(deliveryScore)))}`,
        items: [
          speedText,
          `문장 평균 길이는 ${sentenceStats.avgLength.toFixed(1)}단어입니다.`,
          sentenceStats.longCount > 0
            ? `35단어 이상 긴 문장이 ${sentenceStats.longCount}개 감지되었습니다. 핵심 주장과 근거를 나눠 말해보세요.`
            : '지나치게 긴 문장은 적게 감지되었습니다.',
        ],
      },
      {
        title: `말하기 습관 진단 ${stripTags(makeLevel(habitScore))}`,
        items: [
          `불필요한 추임새로 보이는 표현이 ${fillerCount}회 감지되었습니다. 전체 대비 ${fillerRate.toFixed(1)}%입니다.`,
          fillerRate > 3
            ? '문장 시작 전 0.5초 멈추고 말하는 연습이 도움이 됩니다.'
            : '추임새 비율은 비교적 안정적입니다.',
          '첫 문장과 마무리 문장을 미리 고정해두면 실전 안정감이 올라갑니다.',
        ],
      },
      {
        title: `목적/기업/직무 적합도 ${stripTags(makeLevel(fitScore))}`,
        items: [
          keywords.length
            ? `입력 맥락의 핵심 키워드 ${keywords.length}개 중 ${matchedKeywords.length}개가 답변에 반영되었습니다.`
            : '목적, 회사, 직무, 평가 기준을 더 입력하면 적합도 판단이 정교해집니다.',
          matchedKeywords.length ? `반영된 키워드: ${matchedKeywords.slice(0, 12).join(', ')}` : '맥락 키워드가 답변에 충분히 드러나지 않았습니다.',
          fitScore < 75 ? '기업/직무 언어를 답변 초반과 결론에 직접 포함해보세요.' : '입력한 맥락과 답변의 연결성은 비교적 좋습니다.',
        ],
      },
      {
        title: '영상 리뷰 피드백',
        items: visualIssues.length ? visualIssues : ['체크된 비언어적 이슈가 없습니다.'],
      },
      {
        title: '개선 우선순위 TOP 3',
        items: buildPriorities({ wpm, fillerRate, fitScore, sentenceStats, visualIssues }),
      },
    ],
  };
}

function buildPriorities({ wpm, fillerRate, fitScore, sentenceStats, visualIssues }) {
  const priorities = [];
  if (fitScore < 78) priorities.push('첫 20초 안에 발표 목적, 기업/직무 적합도, 핵심 메시지를 직접 말해보세요.');
  if (fillerRate > 3) priorities.push('추임새를 줄이기 위해 문장 사이에 짧은 침묵을 허용하세요.');
  if (wpm !== null && wpm > 175) priorities.push('속도가 빠릅니다. 핵심 문장 뒤에 1초 정지하는 연습을 해보세요.');
  if (wpm !== null && wpm < 95) priorities.push('속도가 느립니다. 예시 설명을 줄이고 결론부터 말하는 구조로 바꿔보세요.');
  if (sentenceStats.avgLength > 28) priorities.push('긴 문장은 주장, 근거, 예시로 나눠 말하세요.');
  if (visualIssues.length) priorities.push('녹화 영상을 다시 보며 시선, 표정, 자세 중 하나만 정해 다음 연습에서 집중 교정하세요.');
  if (priorities.length < 3) priorities.push('현재 답변의 핵심 키워드 3개를 정하고 각 키워드마다 구체 경험 1개를 연결하세요.');
  if (priorities.length < 3) priorities.push('마무리 문장에 직무나 발표 목적과의 적합성을 다시 한 번 넣어보세요.');
  return priorities.slice(0, 3);
}

function stripTags(html) {
  const temp = document.createElement('div');
  temp.innerHTML = html;
  return temp.textContent || temp.innerText || '';
}

function renderAiReport(report) {
  const scores = report.scores || {};
  $('#totalScore').textContent = clamp(scores.total ?? 0);
  $('#deliveryScore').textContent = clamp(scores.delivery ?? 0);
  $('#fitScore').textContent = clamp(scores.fit ?? 0);
  $('#habitScore').textContent = clamp(scores.habit ?? 0);
  renderReport(report.sections || []);
}

function renderReport(sections) {
  const body = $('#reportBody');
  const template = $('#sectionTemplate');
  body.innerHTML = '';

  sections.forEach((section) => {
    const node = template.content.cloneNode(true);
    node.querySelector('h3').textContent = section.title;
    const ul = node.querySelector('ul');
    (section.items || []).forEach((item) => {
      const li = document.createElement('li');
      li.textContent = item;
      ul.appendChild(li);
    });
    body.appendChild(node);
  });
}

async function copyReport() {
  const report = $('#report');
  const text = report.innerText.trim();
  try {
    await navigator.clipboard.writeText(text);
    copyReportBtn.textContent = '복사 완료';
    setTimeout(() => { copyReportBtn.textContent = '리포트 복사'; }, 1200);
  } catch {
    alert('브라우저에서 클립보드 복사를 허용하지 않았습니다. 리포트 영역을 직접 선택해 복사해주세요.');
  }
}

startBtn.addEventListener('click', startRecording);
stopBtn.addEventListener('click', stopRecording);
clearBtn.addEventListener('click', clearAll);
analyzeBtn.addEventListener('click', analyze);
copyReportBtn.addEventListener('click', copyReport);
