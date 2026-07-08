# AI Coaching Prototype

AI 기반 면접 및 발표 코칭 서비스를 나누어 개발하기 위한 정적 프로토타입입니다.

## 현재 구조

- `index.html`: 면접 연습과 발표 연습 중 하나를 선택하는 메인 진입 페이지
- `styles.css`: 메인 진입 페이지 스타일
- `presentation.html` / `presentation.css` / `presentation.js`: 발표 연습 페이지
- `netlify/functions/analyze.js`: Gemini API 호출용 Netlify Function (API 키는 서버에서만 사용)
- `netlify.toml`: Netlify 빌드/함수 경로 설정

## Gemini API 연동

1. Netlify 대시보드 > Site settings > Environment variables에서 `GEMINI_API_KEY`를 등록합니다.
2. 로컬에서 `netlify dev`로 테스트하려면 `.env.example`을 복사해 `.env`를 만들고 값을 채웁니다 (`.env`는 git에 커밋하지 않습니다).
3. 프론트엔드는 `/.netlify/functions/analyze`로만 요청하며, API 키는 클라이언트에 노출되지 않습니다.

## 협업 방식

1. `main` 브랜치에는 공통 진입점인 `index.html`을 유지합니다.
2. 면접 페이지 담당자는 별도 브랜치에서 `interview.html`을 만듭니다.
3. 발표 페이지 담당자는 별도 브랜치에서 `presentation.html`을 만듭니다.
4. 각 페이지가 완성되면 `main`으로 병합합니다.

## 실행 방법

별도 빌드 과정 없이 `index.html`을 브라우저에서 열면 됩니다.
