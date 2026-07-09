# AI Presentation Coach Prototype

발표와 면접을 연습하고 Gemini 기반 피드백을 받는 정적 웹 프로토타입입니다.

## 폴더 구조

```text
.
├─ index.html                    # 코칭 모드 선택
├─ presentation.html             # 발표 코칭
├─ interview.html                # 면접 코칭
├─ assets/
│  ├─ css/
│  │  └─ app.css                 # 전체 화면 공통 스타일
│  └─ js/
│     ├─ home.js                 # 모드 선택
│     ├─ presentation.js         # 발표 녹음·분석 로직
│     ├─ presentation-flow.js    # 발표 화면 단계 이동
│     ├─ interview.js            # 면접·음성·리포트 로직
│     └─ interview-flow.js       # 면접 화면 단계 이동
├─ netlify/
│  └─ functions/
│     ├─ analyze.js              # 발표 Gemini 분석
│     ├─ gemini-interview.js     # 면접 질문·리포트 생성
│     ├─ parse-document.js       # PDF/DOCX 텍스트 추출
│     └─ typecast-tts.js         # 면접관 음성 합성
├─ netlify.toml
└─ package.json
```

## UI 연결용 AI API

`assets/js/ai-client.js`가 `window.PitaAI`를 제공합니다. 새 UI에서는 아래 함수를
호출하면 됩니다.

```js
await PitaAI.presentation.generateDraft({
  materials: [{ name, mimeType, text }], // 또는 { name, mimeType, data: base64 }
  context,
});

await PitaAI.presentation.generateQuestions({ script, context, count: 6 });

await PitaAI.presentation.analyze({
  mode: "script", // script | audio | video
  script,
  mediaBase64,
  mediaMimeType,
  context,
  measuredMetrics,
  previousSessions,
});

await PitaAI.interview.generateQuestions({ profile, interviewType });
await PitaAI.interview.generateReport({ profile, answers, messages, localAnalysis });
```

발표 요청은 `/.netlify/functions/presentation-ai`의 `draft`, `questions`, `report`
작업으로 처리됩니다. `report`는 새 UI용 `report` JSON과 기존 화면용 `feedback`
마크다운을 함께 반환합니다.

실시간 시선·자세·표정·제스처 막대는 프로토타입용 시뮬레이션입니다. 주변 환경 및
정자세 캘리브레이션은 카메라·마이크 확인 화면만 있으며 AI 분석에는 연결하지
않습니다.
