# 함께 퍼즐 (jigsaw)

초등 교실 모둠(4~6명)이 각자 태블릿·휴대폰으로 같은 직소 퍼즐 하나를 실시간으로 함께 맞추는 무료 수업 도구.
기준 문서: `docs/spec.md`(무엇을·왜), `docs/plan.md`(태스크 기록), `docs/ops.md`(rt 서버 운영), `docs/image-candidates.md`(내장 그림 출처 조사).

## 구조

- `public/` — 빌드 없는 정적 사이트(Vercel 배포 루트, ES 모듈 + Canvas 2D). 외부 스크립트는 구글 로그인(GIS)뿐.
  - `js/puzzle/` 판정 모듈(`geometry.js`·`snap.js`·`deal.js`): 화면과 rt 서버가 **같은 파일**을 import 한다. DOM·브라우저 전용 API 없이 순수 함수로 유지(`tests/unit/node-import.test.js`).
  - `js/play/` 퍼즐 화면(판·상자·카메라·자석), `js/student/` 학생 화면, `js/teacher/` 교사 화면, `js/store/` 판 상태 저장소(원격=소켓, 로컬=데모).
  - `images/builtin/` 내장 그림(WebP 긴 변 1800 + 썸네일 720)과 `index.json`. 화면과 서버가 같이 읽는다.
- `server/` — rt 서버(Node 24, `node:http` + socket.io). 판정 권위는 서버 메모리, DB(Supabase `jigsaw` 스키마)는 재시작 복구용 사본(write-behind).
  - `src/engine/` 순수 로직(`board.js` 모둠 판, `session.js` 수업 흐름, `registry.js` 수업 목록·토큰). 시계 주입, 결과는 이벤트 목록.
- `supabase/migrations/` 스키마. 원격 적용은 `scripts/db/migrate.sh` 만(`supabase db push` 금지).
- `scripts/` 개발·운영 도구, `tests/unit`·`tests/server`(Vitest), `tests/server/db`(로컬 Supabase 필요), `tests/e2e`(Playwright).

## 명령

```bash
pnpm test                 # 단위 + 서버 엔진 시험 (1초 내외)
pnpm db:start             # 로컬 Supabase (Docker)
pnpm test:db              # DB·서버 통합 시험 (로컬 Supabase 필요)
pnpm dev                  # 정적 서버 http://localhost:4173
pnpm rt:dev               # 로컬 rt 서버 http://127.0.0.1:3400 (시험 훅 켬)
pnpm teacher:open         # 시험용 선생님으로 로그인된 창 열기 (dev·rt:dev 켠 뒤)
pnpm screens [그림 키]     # 주요 화면을 휴대폰·넓은 화면으로 찍어 test-results/screens/ 에 저장 (dev·rt:dev 켠 뒤)
pnpm test:e2e             # E2E 4개 너비(360·390·1024·1440). test:db 와 동시에 돌리지 않는다
pnpm images:builtin       # 내장 그림 다시 만들기 (네트워크 필요, 원본은 OS 임시 폴더)
pnpm images:sheet [낱말]   # 내장 그림 썸네일 대조표를 test-results/sheets/ 에 (검수용)
```

화면을 고친 뒤에는 `pnpm screens` 로 찍어 눈으로 확인한다. rt 서버 코드를 고치면 떠 있는 `rt:dev` 를 다시 켜야 반영된다(자동 재시작 없음).

## 꼭 지킬 것

- 학생 개인정보: 학생 이름은 rt 서버 메모리와 학생 기기에만. DB·Storage·서버 로그에 쓰지 않는다(E2E 가 로그를 검사).
- 브라우저는 Supabase 에 직접 접속하지 않는다(그림 서명 URL 읽기만 예외). supabase-js 를 화면에서 쓰지 않는다.
- CSP: 인라인 스크립트·인라인 `style` 속성 금지(스타일은 CSSOM `setProperty`). 허용 외부 주소는 `vercel.json` 과 `tests/unit/csp.test.js` 가 같이 지킨다.
- 내장 그림은 퍼블릭 도메인·CC0·공공누리 제1유형만. 새 외부 그림은 `scripts/builtin-external.json` 에 출처·라이선스·credit 과 함께 넣고 `pnpm images:builtin` 으로 만든다(처리방침 출처 목록도 자동 갱신). 아이에게 알맞지 않은 그림(나체·폭력 등)은 넣지 않는다.
- 내장 그림 추가 절차: 후보를 `scripts/builtin-external.json` 형식(key·title·category·topic·level·author·year·holder·source·license·images·crop·note·credit, 필요하면 tags)으로 만든다 → 커먼즈 API 로 라이선스 확인 → `pnpm images:builtin` → `pnpm images:sheet` 로 눈으로 검수(어둡거나 한 색이 절반 넘는 그림, 아이에게 알맞지 않은 그림은 뺀다) → `pnpm test`. 기준과 뺀 사례는 `docs/image-candidates.md`. 순서는 사진 → 삽화 → 명화 → 우리 그림, 저학년용 쉬운 그림이 앞. 카드 설명이 두 줄을 넘지 않게 author 는 짧게, credit 은 그림마다 달라야 한다.
- 화면 문구는 초등학생도 읽을 수 있는 쉬운 해요체 한국어. 코드 주석은 영어, 문서는 한국어.
- 퍼즐 규칙(spec '퍼즐 규칙')을 바꾸지 않는다. 판정 로직은 `public/js/puzzle/` 한 곳에만 둔다(복사 금지).
- 커밋 전 사용자 확인, 커밋 메시지는 한국어로 짧게.
