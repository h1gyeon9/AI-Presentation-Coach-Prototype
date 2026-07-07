# AI Presentation Coach Prototype

발표/면접 연습 영상을 녹화하고 전사 텍스트를 바탕으로 Gemini 코칭 리포트를 생성하는 MVP입니다.

## 구성

- 정적 프론트엔드: `index.html`, `styles.css`, `app.js`
- Netlify Function: `netlify/functions/analyze.js`
- Gemini API 키는 브라우저에 노출하지 않고 Netlify 환경변수에서 읽습니다.

## Gemini API 키 발급

1. [Google AI Studio API keys](https://aistudio.google.com/app/apikey)에 접속합니다.
2. Google 계정으로 로그인합니다.
3. `Create API key`를 눌러 키를 생성합니다.
4. 생성된 키를 복사해 Netlify 환경변수에 저장합니다.

무료 티어는 모델과 지역, 사용량 제한에 따라 달라질 수 있으므로 실제 배포 전 [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing)을 확인하세요.

## Netlify 환경변수

Netlify 프로젝트의 **Site configuration > Environment variables**에 다음 값을 추가하세요.

- `GEMINI_API_KEY`: Google AI Studio에서 발급받은 Gemini API 키
- `GEMINI_MODEL`: 선택 사항. 기본값은 `gemini-3.1-flash-lite`

## 동작 흐름

1. 발표/면접 목적, 회사/대상, 직무/주제, 평가 기준을 입력합니다.
2. 브라우저에서 녹화하고 가능한 경우 음성 인식으로 전사 텍스트를 채웁니다.
3. `Gemini 분석 리포트 생성`을 누르면 `/.netlify/functions/analyze`가 Gemini API를 호출합니다.
4. API 호출에 실패하면 프론트엔드의 규칙 기반 분석으로 대체 리포트를 표시합니다.

## 로컬 실행

Netlify Functions까지 로컬에서 테스트하려면 Netlify CLI로 실행하는 것이 가장 간단합니다.

```bash
netlify dev
```

정적 화면만 확인할 때는 `index.html`을 브라우저에서 직접 열어도 됩니다. 이 경우 Gemini 호출은 동작하지 않고 폴백 분석만 사용할 수 있습니다.
