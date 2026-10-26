# 조각조각 (jigsaw)

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

## 도메인

- 화면은 `jigsaw.gyosil.app`, 실시간 서버는 `jigsaw-rt.gyosil.app`이다. 2026-10-13에 `rt.gyosil.app`에서 바꿨다. 같은 서버를 쓰는 다른 앱(boardgames의 `madang-rt`, ecosystem의 `eco-rt`)과 헷갈리지 않도록 앱 이름을 붙였다.
- `rt.gyosil.app`은 예전 화면과 캐시된 페이지를 위해 Caddy에 그대로 남겨 둔다. **지우지 않는다.**
- 실시간 서버 주소를 바꿀 때는 `public/js/config.js`(`REMOTE_RT_URL`, 서버 IP 는 `RT_IP_URL`·`RT_IP_PREFIX`), `vercel.json` CSP `connect-src`, 서버 Caddy 사이트 파일, 관련 테스트(`tests/unit/csp.test.js`, `tests/unit/rt-proxy.test.js`)를 함께 바꾼다. CSP 에서 `https://<rt 주소>` 가 빠지면 연결 확인(`/health`)이 늘 실패해 모든 화면이 `/rt` 로 간다.
- 서버 IP 경로(2026-10-26): 학교망이 rt 주소를 막으면 화면은 먼저 `https://13.124.90.119/jigsaw/*`(같은 서버, Caddy `scripts/rt/caddy/sites/ip.caddy`, WebSocket 됨)로 붙는다. rt 주소와 IP 의 `/health` 를 페이지당 한 번 동시에 확인한다. CSP `connect-src` 에 `https://13.124.90.119 wss://13.124.90.119` 가 빠지면 IP 경로가 쓰이지 않는다.
- `/rt`(2026-10-26): 학교망이 rt 주소와 서버 IP 를 모두 막으면 화면이 같은 사이트의 `/rt/*` 를 거쳐 rt 서버에 붙는다(`public/js/rt-client.js` `rtRoute` → `middleware.js` Vercel Routing Middleware, polling 만). `middleware.js` 는 `config.js` 의 `REMOTE_RT_URL` 을 읽으므로 주소를 따로 적지 않는다. 직접 연결의 요청 주소(`/socket.io/?EIO=4…`)는 바꾸지 않는다. 비밀값 `RT_PROXY_SECRET` 은 Vercel 과 `/etc/jigsaw-rt.env` 에 같은 값(`docs/ops.md` '/rt 우회 연결').
- 같은 화면을 `jigsaw-gyosil.vercel.app`(같은 Vercel 프로젝트 별칭)으로도 연다. 학교망이 `*.gyosil.app` 을 막을 때 쓰는 기본 주소다(2026-10-23). rt 서버 `ALLOWED_ORIGINS` 에 두 주소가 모두 있어야 한다.
- 학교망이 주소 이름으로 차단하는 경우가 있다(2026-10 rpg·boardgames·news 등). 새 주소에는 game·play 같은 단어를 넣지 않는다.

## 제안전 준수 규칙 (2026 초등 AI수업도구 제안전, 상세: gyosil/docs/contest-2026/spec.md)

- 광고·제휴 링크·후원/유료 결제 유도·유료화 예고 문구를 넣지 않는다(AdSense, ads.txt, 쿠팡 등).
- 운영자 연락처는 gyosil.app@gmail.com 하나. 회사명·실명·주소·전화는 쓰지 않고 주체는 "운영자"로 표기한다.
- 학생 실명·연락처·학생과 연결된 학습 이력을 서버에 저장하지 않는다.
- 학생 입력 칸에는 "이름·주소·연락처를 쓰지 마세요" 안내와 전화번호·주민등록번호·이메일 형식 필터를 둔다. 이름(실명) 패턴 필터는 오탐이 많아 두지 않는다.
- 수집 항목·저장 위치·보관 기간·분석 도구·외부 전송이 바뀌면 같은 커밋에서 처리방침을 고친다.
- 처리방침·약관의 변경 공지 조항 문구("이용자에게 불리하거나 수집 항목이 늘어나는 변경은 시행 7일 전부터 공지하고, 그 밖의 변경은 시행일에 공지합니다.")는 바꾸지 않는다.
- 타인 저작물·상표·이미지는 권리 근거 없이 쓰지 않고, 근거는 앱 안에 표시한다.
- 실행 중 AI 호출 기능을 새로 넣지 않는다.
