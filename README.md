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