# Plan: 모둠 협동 직소 퍼즐 (함께 퍼즐)

기준 문서: `docs/spec.md`(2026-10-08 서버 구조 변경 반영, 승인), `docs/research.md`, 화면 목업 `docs/mockups/*.png`·`docs/mockups/src/*.html`(화면 구성·문구·색은 목업을 따른다), gyosil 공용 원칙 `~/dev/class-rpg-game/docs/platform.md`.
`[사용자 작업]` 표시는 에이전트가 할 수 없는 일(계정·대시보드 설정, OAuth 등록, 비밀값 입력, 서버 접속 권한)이다. **T24 까지는 원격(Supabase gyosil·rt 서버·Vercel)에 아무것도 적용하지 않고 로컬(로컬 Supabase + 로컬 rt 서버)에서 완성·검증한다.** 원격 적용·배포는 T25 하나에서만 한다. 예외로 main 푸시는 태스크마다 하며 Vercel 에 자동 배포되지만, 운영 rt 주소가 T25 까지 비어 있어 운영 화면은 '준비 중'을 유지한다(메모 '푸시와 배포').

## 완료된 태스크 (이전 구조: 브라우저 → Supabase 직접)

T1~T13 은 이전 구조로 만들었다. 화면·퍼즐 모듈은 그대로 쓰고, Supabase 직접 접속 부분(RPC·RLS·Realtime·익명 로그인·pg_cron)은 T14~T23 에서 rt 서버 구조로 바꾼다. 아래 세부 내용은 기록용이다.

- [x] T1: 프로젝트 초기화 (정적 사이트 뼈대, Vitest·Playwright, 기본 SEO·파비콘, 빈 배포 가능 상태) — DoD: -
  - pnpm `package.json`(개발 의존성만: vitest, @playwright/test). 빌드 단계 없음.
  - 폴더 구조: `public/`(배포 루트), `supabase/`, `tests/unit`·`tests/db`·`tests/e2e`·`tests/fixtures`, `scripts/`.
  - `vercel.json`: `outputDirectory: "public"`, 화면 경로 → `index.html` 재작성, 기본 보안 헤더. `scripts/serve.mjs` 로컬 정적 서버.
  - SEO·파비콘·robots·sitemap, 4개 너비 스모크.
- [x] T2: 퍼즐 기하·맞춤 판정 JS 모듈 + 공용 시험 사례 표 — DoD: D7
  - `public/js/puzzle/geometry.js`, `public/js/puzzle/snap.js`(`resolveDrop`·`resolveDropWithHolds`·`grabRefusal`·`progress`·`clampPosition`, 허용 거리 40, 잡기 10초), `tests/fixtures/snap-cases.json`.
- [x] T3: 로컬 Supabase·스키마·RLS·실시간 권한·저장소 — DoD: D12, D14 (T14~T23 에서 대체)
- [x] T4: 수업 흐름 RPC + 자동 정리 — DoD: D3, D4, D5, D14 (T16·T18 로 대체)
- [x] T5: 퍼즐 RPC + JS·SQL 맞춤 판정 교차 검사 — DoD: D5, D6, D7, D10 (T15 로 대체, SQL 판정 없앰)
- [x] T6: 끊김 처리 RPC — DoD: D8, D9 (T15 로 대체)
- [x] T7: 교사 로그인·내 수업·수업 만들기·코드/QR — DoD: D1 (로그인·데이터 연결은 T20·T21 에서 교체)
- [x] T8: 그림 올리기·내 그림 관리 — DoD: D2 (브라우저 WebP 변환은 유지, 저장 경로는 T20·T21 에서 교체)
- [x] T9: 학생 입장·기다리기 + 교사 대기실 모둠 편성 — DoD: D3, D4, D14 (T21·T22 에서 연결 교체)
- [x] T10: 학생 퍼즐 화면 — 판·상자·확대 — DoD: D5, D13 (`puzzle-store.js` 계약·`local-store.js` 는 그대로)
- [x] T11: 협동 동기화·끊김·완성 화면 — DoD: D6~D10 (T22 에서 연결 교체)
- [x] T12: 교사 모둠 한눈에 보기·수업 끝내기 — DoD: D10, D11, D14 (T21 에서 폴링 → 서버 푸시)
- [x] T13: 내장 그림 약 20장·출처 표기, 개인정보 처리방침, 외부 스크립트 점검 — DoD: D15
  - 내장 그림·출처 표기·`privacy.html`. 처리방침의 처리 장소·학생 정보 설명과 CSP 허용 목록은 새 구조에 맞춰 T23 에서 다시 고친다.
- ~~T14 / T14a: 원격 배포(브라우저 직접 접속 구조로 gyosil 이전)~~ → 폐기. 아래 T14~T25 로 다시 나눔.

## 서버 전환 태스크

- [x] T14: 보류 중인 T14a 변경 보관·정리, 퍼즐 모듈 Node 실행 확인 — DoD: D7
  - 작업 트리의 T14a 변경(코드·시험·`supabase/` 전체, `docs/` 제외)을 보관 브랜치(예: `archive/t14a`)에 커밋해 남긴다 **[사용자 확인: 보관 브랜치 커밋]**. 그 뒤 main 작업 트리를 HEAD(`5be89bc`) 상태로 되돌린다. 이때 `docs/spec.md`·`docs/plan.md` 는 되돌리지 않는다.
  - T14a 의 SQL 마이그레이션(`2026100800*`)·`supabase-names.js`·원격 주소 `config.js`·스키마 접두 변경은 버린다. Supabase 와 상관없는 변경(퍼즐 모듈·자석 `magnet.js` 수정, 시험 격리·중복 정리 등)만 diff 에서 골라 다시 적용하고, 고른 목록을 보고에 적는다.
  - `snap.js`·`geometry.js`·(조각 나누기 등) 판정에 쓰는 모듈이 DOM·브라우저 전용 API 없이 Node 에서 import 되는지 확인한다. `Path2D` 처럼 브라우저 전용인 부분은 호출할 때만 쓰이게 정리한다.
  - 검증: `tests/unit/node-import.test.js`(Vitest `environment: node` 로 퍼즐 모듈 import·`resolveDropWithHolds` 실행)를 추가하고, 기존 단위·DB·E2E 시험을 HEAD 상태에서 모두 통과시킨다(전환 중 기준선).
  - 결과: 보관 브랜치 `archive/t14a-browser-direct`(커밋 `a399116`, 원격 푸시). 다시 적용한 변경 0건(퍼즐·자석 모듈 변경도 SQL 함수 이름 주석뿐이라 버림). 퍼즐 모듈은 이미 Node 에서 import 되어 코드 수정 없음. D7 완료 표시는 서버 `drop` 경로로 증명하는 T15 에서 한다.

- [x] T15: 서버 퍼즐 엔진(모둠 판 상태, 순수 로직) — DoD: D5, D6, D7, D8, D9, D10
  - `server/package.json`(type module, Node 24, 의존성은 이 태스크에서는 없음), `server/src/engine/board.js`: 모둠 하나의 판 상태(덩어리·조각·상자 주인·잡기·접속)와 동작 `takeFromTray`·`grab`·`drop`·`release`·`memberOnline/Offline`·`tick(now)`. 판정은 `public/js/puzzle/snap.js`·`geometry.js` 를 import 해서 쓴다(복사 금지).
  - 조각 나누기(`shuffledPieces` 등)는 `local-store.js` 에서 공용 모듈(예: `public/js/puzzle/deal.js`)로 옮겨 화면 데모 저장소와 서버가 같이 쓴다.
  - 규칙: 먼저 도착한 잡기만 성공, 고정 덩어리 잡기 거부, 남의 상자 조각 거부, 잡은 채 10초 무동작 또는 끊김 → 놓임, 끊긴 지 1분 → 상자 남은 조각을 접속 중인 모둠원에게 고르게(늦게 온 학생 포함, 접속자 없으면 안 나눔, 한 번만), 같은 학생이 1분 안에 돌아오면 상자 그대로, 모든 조각 고정 → 완성 시각. 잡기 연장 상한(처음 잡은 뒤 최대 60초, 넘으면 놓임)을 둔다.
  - 시계는 주입(`now()`), 결과는 '보낼 이벤트 목록'으로 돌려준다(소켓과 분리).
  - 검증: `tests/server/board.test.js`(Vitest). 24조각·5명이면 5·5·5·5·4로 나뉘는지, 동시 잡기는 하나만 성공하는지, 남의 조각 거부, 가짜 시계로 10초·1분·연장 상한, 재분배를 한 번만 하는지, 완성을 시험한다. 그리고 **`snap-cases.json` 전 사례를 엔진의 `drop` 경로로 통과**(D7)시킨다.

- [x] T16: 서버 수업 흐름 엔진(수업·입장·편성·시작·끝내기, 순수 로직) — DoD: D3, D4, D5, D14
  - `server/src/engine/session.js`·`registry.js`:
    - 수업 만들기: 열린 수업끼리 겹치지 않는 6자리 코드와 시드를 정한다.
    - 학생 입장: 코드와 이름을 받아 member id와 무작위 학생 토큰을 만든다. 엔진에는 토큰 해시만 둔다. 틀린 코드·닫힌 수업은 정해진 오류로 답한다. 같은 토큰으로 다시 들어오면 기존 member 를 돌려준다.
    - 편성·시작: 모둠 배정·무작위 나누기, 시작 시 모둠별 판 생성·색 번호를 맡는다.
    - 시작 후 처리: 들어온 학생은 상자 없이 배정한다. 다른 모둠으로 옮긴 학생의 상자 조각은 원래 모둠 접속자에게 나눈다. 빈 모둠 규칙(아래 메모)을 따른다.
    - 끝내기: 수업을 닫으면 모든 토큰을 무효로 하고 종료 이벤트를 보낸다. 열린 수업 수 상한도 여기서 지킨다.
  - 이름은 member 객체의 메모리 필드에만 둔다. 저장용 직렬화(`toRecord()`)에는 이름이 들어가지 않는다.
  - 교사 한눈에 보기 요약(모둠별 축소판용 덩어리 위치·진행률·완성·학생 접속)을 만드는 함수.
  - 검증: `tests/server/session.test.js`. 코드가 겹치지 않는지, 틀린 코드 오류, 재입장 복귀, 무작위 나누기, 시작 후 배정, 모둠 이동 시 재분배, 빈 모둠, 끝내기 후 토큰 거부, `toRecord()` 결과 어디에도 이름 문자열이 없는지 확인한다.

- [x] T17: 새 DB 스키마·마이그레이션 스크립트·권한 시험 — DoD: D12, D14
  - `supabase/migrations/20261009000000_jigsaw_schema.sql`(이름에 `jigsaw_`):
    - 스키마·기록: `create schema jigsaw`, `jigsaw.schema_migrations`.
    - 테이블: `teachers`, `images`, `sessions`, `groups`(판 상태 사본 `board jsonb`), `members`(이름 열 없음, `token_hash`).
    - 권한: 모든 테이블 RLS 켜고 정책은 0개. `anon`·`authenticated`·`public` 에서 스키마·테이블·시퀀스·함수 권한을 회수하고, `alter default privileges` 로 앞으로 만들 객체도 막는다. 권한은 `service_role` 에만 준다.
    - 버킷: 비공개 `jigsaw-images`(정책 없음).
    - 이전 구조의 `public` 테이블·마이그레이션(`20261007*`)은 T23 까지 로컬에 함께 둔다(기존 화면·시험이 계속 돌게). 두 구조는 이름이 겹치지 않는다.
  - `scripts/db/migrate.sh`: `SUPABASE_DB_URL` 로 psql 접속하고, `jigsaw_` 가 들어간 파일만 이름 순으로 한 번씩 적용한다. 파일마다 트랜잭션으로 묶고 `jigsaw.schema_migrations` 에 기록한다. 첫 파일이 기록 테이블을 만드는 경우도 처리한다. 비밀번호는 출력하지 않는다.
  - 로컬 전용 준비(`supabase/seed.sql`):
    - 시험 교사(`auth.users` + `jigsaw.teachers`)를 만든다.
    - 원격에 이미 있는 `core.profiles` 를 흉내 내는 최소 스텁을 둔다. 스텁은 seed 에만 두고 jigsaw 마이그레이션에는 넣지 않는다. 원격 `core.profiles` 열 구성은 T20 전에 사용자에게 확인한다.
  - `supabase/config.toml` 은 로컬에서 Data API 노출 스키마에 `jigsaw` 를 넣는다(원격 대시보드 설정 흉내).
  - 검증: `tests/server/db/permissions.test.js`(로컬 Supabase)로 아래를 확인한다.
    - 공개 키(anon)와 로그인 사용자(authenticated) 키로 `jigsaw` 의 모든 테이블 select·insert 가 거부된다. 버킷 목록·파일 읽기·올리기도 거부된다.
    - service_role 로는 된다.
    - `migrate.sh` 를 두 번 실행해도 두 번째는 아무것도 적용하지 않는다. 다른 앱 흉내 스키마가 있는 DB 에서도 그것을 건드리지 않는다.

- [x] T18: 저장 계층(write-behind·재시작 복구·정리 작업) — DoD: D14, D17
  - `@supabase/supabase-js` 추가. `server/src/db.js` 는 service_role 클라이언트를 `db: { schema: 'jigsaw' }` 로 고정한다. 다른 스키마 접근 코드는 두지 않는다.
  - 저장 시점은 아래와 같다.
    - 즉시 저장: 수업 만들기·입장(members 행)·편성·시작·완성·끝내기.
    - 묶어 저장: 판 변경은 모둠별 최대 2초에 한 번(`groups.board`). 저장이 실패하면 다시 시도하고 로그를 남긴다.
    - SIGTERM 을 받으면 남은 저장을 마치고 끝난다.
  - 시작할 때 열린 수업(대기·진행)을 읽어 엔진에 복구한다. 잡기는 모두 놓인 상태로, 학생은 '끊김' 상태로 시작한다(이름은 재접속 때 채워짐). 재접속이 없으면 1분 규칙이 그대로 적용된다.
  - 정리 작업(서버 내부 10분 주기): 시작 24시간 지난 열린 수업 종료, 종료 수업의 members 삭제, 종료 30일 지난 sessions 삭제. `auth.users` 는 건드리지 않는다.
  - 검증: `tests/server/db/persistence.test.js`(로컬 Supabase)로 아래를 확인한다.
    - 엔진 상태를 저장한 뒤 새 엔진으로 복구하면 판·상자·배정이 같다.
    - 2초 묶음 저장이 동작하고, SIGTERM 전에 저장을 마친다.
    - 정리 작업 3가지가 맞게 지운다. 시각은 행을 직접 과거로 바꿔 시험한다.
    - DB 전체 덤프(jigsaw 스키마)에 시험 학생 이름 문자열이 없다.

- [x] T19: rt 서버 — HTTP·socket.io·학생 연결·보안 제한 — DoD: D3, D6, D11, D12, D16, D17
  - `socket.io` 를 추가한다. `server/src/index.js` 는 `node:http` + socket.io 로 `PORT`(기본 3400)에서 돈다. 환경변수는 `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `SESSION_SECRET`, `GOOGLE_CLIENT_ID`, `ALLOWED_ORIGINS`, `NODE_ENV` 이다. 로컬 값은 `npx supabase status -o env` 에서 읽는 개발 스크립트로 채운다(커밋 안 함).
  - HTTP 경로: `GET /health`(버전·가동 시간·수업 수, 비밀값 없음), `POST /api/join`(코드+이름 → member·토큰).
  - 소켓 연결과 방:
    - 학생: 토큰과 이름으로 인증하고, 수업 방과 모둠 방에 들어간다.
    - 교사: 교사 토큰으로 인증한다. T20 전에는 시험용 서명 토큰을 쓴다.
    - 이벤트: 대기실 명단·편성·시작·꺼내기·잡기·놓기·놓아주기·끝내기를 엔진에 연결한다.
    - 방송: 모둠 방은 0.1초 묶음으로 보낸다. 교사 방에는 바뀐 모둠 요약을 1초 이내 묶음으로 보낸다(폴링 없음).
    - 다시 연결하면 전체 상태 한 벌을 보낸다.
  - 끊김 감지: socket.io `pingInterval`·`pingTimeout` 을 끊김이 약 15초 안에 잡히게 정한다. 끊기면 엔진에 '끊김'을 알린다.
  - 보안·제한(D16):
    - 허용 Origin 이 아닌 HTTP·소켓 요청은 거부한다(CORS 포함).
    - 크기 상한: 본문 크기, 소켓 메시지 크기(`maxHttpBufferSize`).
    - 빈도 제한: IP당 연결·요청은 넉넉히(학교 NAT, 예: 연결 200), 연결별 메시지(예: 초당 30), 틀린 코드는 IP당 짧은 시간 반복 시 잠시 거부.
    - 수량 상한: 열린 수업 수, 전체 연결 수.
    - 로그에는 이름·토큰·IP 를 남기지 않는다.
  - 로컬 전용 시험 훅(`NODE_ENV!=='production'` 이고 `RT_TEST_HOOKS=1` 일 때만): 엔진 시계 앞당기기. 운영에서는 경로 자체가 없다.
  - `package.json` 스크립트 `rt:dev`·`test:server` 를 만들고, Playwright `webServer` 에 rt 서버를 추가한다.
  - 검증: `tests/server/socket.test.js`(로컬 Supabase + 실제 서버 + socket.io-client 여러 개)로 아래를 확인한다.
    - 입장한 이름이 교사 소켓에 1초 안에 도착한다(D3).
    - 동시 잡기는 하나만 성공하고, 다른 학생은 잡힌 이벤트를 받는다(D6).
    - 다른 모둠·수업 대상 메시지는 거부된다(D12).
    - 교사 요약이 3초 안에 도착한다(D11).
    - 잘못된 Origin, 빈도 초과, 큰 메시지, 상한 초과가 거부된다(D16).
    - `/health` 가 응답한다.
    - 서버 프로세스를 죽였다 다시 띄우면 수업이 복구되고 소켓이 재접속한다(D17).

- [ ] T20: 교사 인증·시작하기·수업·그림 API — DoD: D1, D2, D12
  - `POST /api/teacher/login`:
    - 입력은 GIS ID 토큰과 nonce 다. 서버가 Supabase `signInWithIdToken`(공개 키 클라이언트, 세션 저장 안 함)으로 uid·이메일을 확인한다.
    - `jigsaw.teachers` 에 있으면 서버 서명 교사 토큰(12시간)을, 없으면 '시작하기 필요'를 돌려준다.
    - 토큰 교환은 함수 하나로 분리해 시험에서 대체할 수 있게 한다.
  - `POST /api/teacher/start`: 이름·약관 동의를 받아 `core.profiles` 의 공용 정보를 읽거나 쓰고(platform.md, 열 구성은 사용자 확인), `jigsaw.teachers` 행을 만든다.
  - 로컬 전용 `POST /api/dev/teacher-token`(T19 시험 훅과 같은 조건): seed 시험 교사의 교사 토큰을 발급한다. `scripts/lib/local-teacher.mjs` 를 이것으로 바꾼다.
  - 수업: `POST /api/sessions`(그림·조각 수·모둠 수·도움 설정 → 코드), `GET /api/sessions`(내 수업).
  - 그림:
    - 올리기(`POST /api/images`, 원본 바이트): WebP 서명(RIFF/WEBP)·3MB 이하·헤더의 가로세로 긴 변 2000 이하인지 검사한 뒤 `jigsaw-images/<uid>/<id>.webp` 에 저장하고 행을 만든다.
    - 조회·삭제: 목록, 서명 URL 발급(교사 본인 그림, 그리고 그 그림을 쓰는 수업의 학생 연결에 전체 상태와 함께 줌), 지우기(열린 수업에서 쓰면 거부, Storage API 로 파일 삭제 후 행 삭제, 결과를 화면에 알림).
  - 검증: `tests/server/teacher-api.test.js`(로컬 Supabase)로 아래를 확인한다.
    - 교사 토큰: 위조·만료 토큰이 거부되고, teachers 에 없는 uid 는 수업 만들기가 거부된다(D1). 토큰 교환은 대체 함수로 시험한다.
    - 시작하기를 하면 teachers 행이 생긴다.
    - 그림 형식·크기 위반이 거부된다.
    - 다른 교사의 그림 목록·삭제·서명 URL 요청이 거부된다(D12).
    - 열린 수업 그림 지우기가 거부되고, 지우면 Storage 파일도 사라진다(D2).
    - 실제 구글 로그인은 T25 에서 확인한다.

- [ ] T21: 화면 전환 ① 교사 화면 — DoD: D1, D2, D3, D4, D11
  - `public/js/rt-client.js`: rt 주소를 고른다(`config.js`: 로컬 주소면 `http://localhost:3400`). 운영 rt 주소는 T25 까지 비워 둔다. 비어 있으면 교사·학생 화면은 지금처럼 '준비 중'을 보인다(이 태스크부터 main 푸시가 곧 운영 배포이므로). 이를 E2E(`csp.spec`·`teacher.spec` 의 '준비 중' 시험)로 계속 확인한다. fetch 래퍼와 socket.io 클라이언트(고정 버전 ESM, `public/js/vendor/socket.io-<버전>.esm.min.js`)를 둔다.
  - 로그인 화면은 GIS 버튼이다. nonce 는 원본·해시를 만들어 원본을 서버로 보낸다. 받은 교사 토큰은 localStorage 에 두고 만료되면 다시 로그인한다. 로컬·E2E 는 dev 교사 토큰을 주입한다. 처음 오는 교사는 '함께 퍼즐 시작하기' 화면(이름·약관 동의, 목업 문체)을 거친다.
  - 연결 교체: `teacher/data.js`·`pictures.js`·`upload.js`(WebP 변환은 그대로, 전송만 rt 로)·`lobby-view.js`(Presence 대신 서버 명단)·`overview-data.js`(3초 폴링 대신 서버 푸시)를 rt 연결로 바꾼다. 교사 화면은 supabase-js 를 import 하지 않는다.
  - 공통: 서버 연결이 끊기면 "다시 연결하는 중" 띠를 보이고 자동으로 재접속한다.
  - 검증: E2E `teacher-create`·`teacher`(대기실·편성·시작)·`upload`·`upload-webkit`·`overview` 를 새 구조(정적 서버 + 로컬 rt + 로컬 Supabase)로 고쳐 통과시킨다. 4개 너비 검사를 포함하고, 교사 화면이 연 네트워크 요청에 `*.supabase.co`·로컬 Supabase REST 주소가 없는지 확인한다(그림 서명 URL 제외).

- [ ] T22: 화면 전환 ② 학생 화면 — DoD: D3, D4, D5, D6, D7, D8, D9, D10, D13, D14
  - 입장: 코드·이름을 `POST /api/join` 으로 보낸다. 토큰·이름은 수업 코드별 localStorage 키에 둔다. 다시 열면 저장된 토큰으로 바로 재접속하고, 수업이 끝났다는 안내를 받으면 그 키를 지운다. 익명 로그인 코드는 없앤다.
  - 퍼즐 저장소: `store/remote-store.js` 를 소켓 기반으로 다시 쓴다(`puzzle-store.js` 계약 그대로, 화면 코드는 바꾸지 않음). `student/live.js`·`presence.js`·`puzzle.js` 의 Realtime·heartbeat·`redistribute_stale` 호출을 없앤다. 놓을 때 화면이 JS 판정으로 바로 붙여 보이고, 서버 결과로 확정한다.
  - 숨김·재접속: 화면이 숨겨지면 놓아주기를 보낸다. 재접속하면 전체 상태를 다시 맞춘다. 연결이 끊기면 "다시 연결하는 중"을 보인다.
  - 검증: E2E `join`·`play`·`coop`(학생 3명)·`disconnect` 를 고쳐 통과시킨다. 1분 규칙은 rt 시험 훅으로 시계를 앞당긴다.
    - 협동: 동시 잡기는 한 명만 성공하고 다른 화면에 테두리가 보인다. 붙은 덩어리는 모든 화면에서 함께 움직인다.
    - 끊김·복귀: 한 명을 닫으면 다른 학생이 그 덩어리를 잡는다. 1분 뒤 상자가 나뉘고, 1분 안에 같은 기기로 돌아오면 상자가 그대로다.
    - 완성·화면: 마지막 조각을 놓으면 모두에게 축하 화면이 뜬다. 4개 너비와 터치 동작을 검사한다.
    - 개인정보: DB 덤프와 서버 로그 출력에 학생 이름이 없다(D14).

- [ ] T23: 이전 구조 제거·CSP·처리방침·전체 E2E — DoD: D12, D14, D15, D16, D17
  - 삭제 대상:
    - 마이그레이션·시험: `supabase/migrations/20261007*`, `tests/db/*`(살릴 것은 T17~T19 서버 시험으로 이미 옮김), `snap-parity`.
    - 화면 모듈: `public/js/supabase-client.js`·`store/supabase-api.js`.
    - 설정: supabase-js CDN 참조, `config.toml` 의 익명 로그인·익명 가입 한도, pg_cron 관련 설정.
  - 정리 뒤 로컬 DB 에 jigsaw 스키마만 남는지 확인한다.
  - CSP(`vercel.json`, `scripts/lib/local-csp.mjs`):
    - `connect-src`: `'self'`, `https://rt.gyosil.app`, `wss://rt.gyosil.app`, 그림 서명 URL 용 Supabase Storage 주소, 구글 로그인 주소.
    - `script-src`·`frame-src`·`style-src`: `https://accounts.google.com/gsi/client`·`frame` 등 GIS 가 요구하는 주소만.
    - `style-src`·`font-src`: Pretendard 글꼴용 `https://cdn.jsdelivr.net`(지금 `index.html`·`privacy.html` 그대로, 자체 호스팅 안 함). `script-src` 에서는 jsDelivr 를 뺀다(supabase-js CDN 제거).
    - `img-src`: 그림 서명 URL 을 `<img>`·SVG `<image>` 로 직접 쓰면 Supabase Storage 주소를 넣는다.
    - 로컬 주소는 로컬 CSP 에만 넣는다.
  - `privacy.html`:
    - 학생: 익명 계정 없음, 이름은 수업 중 서버 메모리와 기기에만 둔다.
    - 처리 장소: Vercel, AWS Lightsail 서울, Supabase 서울.
    - IP: 요청 제한용으로 메모리에서만 쓴다.
    - 보관 기간: spec 데이터 표대로.
    - 삭제 방법·탈퇴: jigsaw 데이터만 삭제한다.
  - 검증:
    - `csp.test`·`csp.spec`: 외부 요청 도메인 목록 검사를 새 허용 목록으로 하고, 교사 수업 만들기 화면을 포함한다(D15).
    - `privacy.test`.
    - 전체 E2E(교사 1 + 학생 5, 4개 너비).
    - 재시작 복구 E2E: 퍼즐 중 rt 서버를 죽였다 다시 띄우면 학생·교사 화면이 자동 재접속하고 판이 이어진다(D17).
    - `no-test-credentials`: service_role·시험 교사 값이 `public/` 에 없다(D16).

- [ ] T24: 서버 설치·배포 스크립트와 운영 문서(로컬에서 작성·점검) — DoD: D16, D17
  - `scripts/rt/setup.sh`(Ubuntu 24.04, 여러 번 실행해도 안전):
    - 사용자·폴더: 전용 사용자 `jigsaw-rt`, 저장소를 `/opt/jigsaw` 에 clone. 서버는 `server/` 만 실행한다.
    - 설치: Node 24(공식 저장소, 버전 고정), corepack pnpm.
    - 메모리·로그: 스왑 1GB, journald 보관 14일.
    - systemd 유닛 `jigsaw-rt.service`: `EnvironmentFile=/etc/jigsaw-rt.env`, `Restart=always`, `NODE_OPTIONS=--max-old-space-size=…`, 종료 시 SIGTERM 대기 시간.
    - Caddy: `/etc/caddy/Caddyfile` 에 `rt.gyosil.app` → `localhost:3400` reverse_proxy 를 넣는다. 기존 설정이 있으면 덮지 않고 알린다.
    - `/etc/jigsaw-rt.env` 가 없으면 값이 빈 틀만 권한 600 으로 만들고 멈춘다. 비밀값은 사용자가 넣는다.
  - `scripts/rt/deploy.sh`: `git pull --ff-only` → `pnpm install --prod --frozen-lockfile`(server) → `systemctl restart` → `/health` 확인. 실패하면 이전 커밋으로 되돌리는 방법을 출력한다.
  - `server/.env.example`(키 이름만), `docs/ops.md`(설치·배포·로그 보기·되돌리기·스냅숏 복원·시범 수업 점검표: 학교망 WebSocket/롱폴링, MDM 분류, 서버 메모리 실측).
  - `docs/ops.md` 에 교사 탈퇴 수동 절차를 적는다: 문의 메일로 요청을 받으면 운영자가 실행할 SQL(그 교사의 `jigsaw` 데이터와 `jigsaw-images` 파일만 삭제, `auth.users`·`core.profiles` 는 건드리지 않음).
  - DB 백업: platform.md 2.5 대로 `jigsaw` 스키마를 매일 `pg_dump` 하는 스크립트(`scripts/db/backup.sh`, 접속 정보는 환경변수)와 복원 방법을 `docs/ops.md` 에 둔다.
  - Caddy 접근 로그는 끈다(IP 를 보관하지 않음, spec 데이터 표).
  - 검증:
    - `shellcheck` 를 통과한다.
    - Docker `ubuntu:24.04` 컨테이너(Node 24 설치)에서 setup.sh 를 systemd·Caddy 단계는 건너뛰는 옵션으로 실행해 Node 설치·의존성 설치·서버 기동·`/health` 까지 확인한다.
    - systemd 유닛·Caddyfile 은 문법 검사(`systemd-analyze verify`, `caddy validate`)를 한다. 컨테이너에서 가능한 범위만 하고 못 한 것은 보고한다.

- [ ] T25: 원격 적용·배포·실제 기기 최종 점검 — DoD: D1, D2, D12, D13, D15, D16, D17
  - [사용자 작업] gyosil Supabase 대시보드
    - Data API → Exposed schemas 에 `jigsaw` 추가.
    - 원격 `core.profiles` 구성 확인 결과를 알려 주기(T20 에서 먼저 확인했으면 생략).
    - 익명 로그인 켜기·Redirect URL 추가는 **하지 않는다**(새 구조에서 필요 없음).
  - [사용자 작업] Google Cloud OAuth 클라이언트 → 승인된 JavaScript 원본에 `https://jigsaw.gyosil.app` 추가. 클라이언트 ID(공개 값)를 알려 주기.
  - [사용자 작업] 원격 마이그레이션: `SUPABASE_DB_URL=… bash scripts/db/migrate.sh` 를 사용자가 직접 실행(DB 비밀번호는 에이전트에게 주지 않음).
  - [사용자 작업] rt 서버
    - SSH 로 `scripts/rt/setup.sh` 실행.
    - `/etc/jigsaw-rt.env` 에 비밀값을 직접 입력: `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `SESSION_SECRET`(`openssl rand -hex 32`), `GOOGLE_CLIENT_ID`, `ALLOWED_ORIGINS=https://jigsaw.gyosil.app`.
    - 서버가 저장소를 받을 수 있게 GitHub 접근을 준비(공개 저장소가 아니면 읽기 전용 deploy key).
    - Lightsail 자동 스냅숏 켜기.
    - (선택) UptimeRobot 으로 `https://rt.gyosil.app/health` 감시.
  - [사용자 작업] Vercel 프로젝트·`jigsaw.gyosil.app` 연결 확인(이미 되어 있으면 생략).
  - 순서: 원격 마이그레이션 → rt 서버 설치·기동·`/health` → `config.js` 의 운영 rt 주소를 `https://rt.gyosil.app` 으로 채우고, '준비 중' 시험을 운영 주소 시험으로 바꾼 커밋을 푸시(Vercel 배포). 이 커밋은 rt 서버가 뜬 뒤에만 푸시한다.
  - [사용자 작업] DB 백업: platform.md 2.5 대로 `jigsaw` 스키마 매일 `pg_dump`(T24 스크립트)를 설정한다. 접속 비밀번호는 사용자가 넣는다.
  - 에이전트 점검:
    - 원격 권한: 공개 키로 `jigsaw` REST 요청(`Accept-Profile: jigsaw`)이 거부되는지 curl 로 확인한다(D12).
    - 서버: `jigsaw.gyosil.app` 이 아닌 Origin 거부를 확인한다(D16). 실제 서버에서 `systemctl kill` 뒤 자동 재시작·수업 복구도 확인한다(D17).
    - 사용자와 함께: 실제 구글 로그인 → 시작하기 → 수업 열기(D1), 그림 올리기·지우기(D2).
    - 기기: 휴대폰·태블릿 실기기로 한 모둠 흐름을 돌리고(D13), 배포된 화면의 CSP 헤더와 외부 요청을 확인한다(D15).

## 메모

### 순서의 이유
- **기준선 먼저(T14)**: 보류 중인 T14a 를 보관하고 HEAD 로 돌려 기존 시험이 모두 통과하는 상태에서 시작한다. 이전 구조의 마이그레이션·시험은 T23 까지 로컬에 남겨 두어, 화면을 옮기는 동안에도 아직 옮기지 않은 화면과 시험이 돈다.
- **가장 불확실한 판정·동시성을 소켓·DB 없이 먼저(T15·T16)**: 순수 로직이라 가짜 시계로 빠르게 시험한다. 그다음 저장(T17·T18), 네트워크(T19·T20), 화면(T21·T22) 순서로 올린다.
- **원격은 마지막(T25)**: T24 까지 원격 계정·비밀값이 하나도 필요 없다. 사용자는 T25 의 `[사용자 작업]` 을 언제든 미리 해 둘 수 있다(Exposed schemas 추가는 jigsaw 테이블이 없어도 무해).
- 태스크가 12개(T14~T25)로 많은 편이다. 서버(엔진·저장·네트워크)와 화면 전환이 각각 무거워 한 세션 크기를 지키려고 나눴다.

### 주의할 점
- **푸시와 배포**: T14 확인 결과, `jigsaw.gyosil.app` 은 Vercel(`icn1`)로 공개 중이고 main 푸시가 곧 운영 배포다. 지금 `config.js` 의 운영 값(REMOTE)이 비어 있어 운영 화면은 '준비 중'을 보인다. 사용자 결정은 '태스크마다 main 푸시, rt 미연결이면 준비 중 유지'다. 그래서 T21~T24 동안 운영 rt 주소는 비워 두고, T25 에서 rt 서버가 뜬 뒤 채운다.
- **교사 로그인 세션(T20)**: `signInWithIdToken` 으로 uid·이메일을 확인한 직후 그 Supabase 세션을 `signOut` 해 refresh 토큰을 남기지 않을지 검토하고, 결정을 T20 보고에 적는다.
- **퍼즐 규칙은 한 곳에서**: 서버는 `public/js/puzzle/*` 를 import 한다. 복사본을 만들지 않는다. 화면 판정과 서버 판정은 같은 코드라서, 화면의 즉시 표시와 서버 확정 결과가 다르면 버그다.
- **한 프로세스, 차례 처리**: 엔진 동작은 동기 함수로 처리하고, DB 저장은 엔진 밖에서 비동기로 한다. 엔진 처리 중에 `await` 를 넣지 않는다(동시 잡기 판정이 깨짐).
- **학생 이름**: DB 행, 저장 jsonb, 로그, `/health`, 오류 메시지 어디에도 넣지 않는다. 서버 메모리와 소켓 방송(같은 수업 화면용)에만 있다. T16·T18·T22 시험에서 확인한다.
- **service_role 키**: `server/` 밖에서 import 하지 않는다. `public/` 에 없음을 시험(`no-test-credentials`)으로 지킨다. 서버 코드는 `jigsaw` 스키마 클라이언트만 만든다.
- **권한 회수**: 공용 프로젝트는 `public`·새 스키마에 기본 권한이 붙을 수 있다. 마이그레이션마다 새 테이블 권한을 회수하고 T17 권한 시험을 테이블 목록 전체로 돌린다(테이블을 추가하면 시험이 자동으로 포함하게).
- **학교 NAT**: 한 반 30명 이상이 IP 하나로 들어온다. IP 단위 한도로 학생을 막지 않게 넉넉히 잡고, 남용 제한은 연결·토큰 단위로 한다.
- **빈 모둠**: 시작할 때 학생이 0명인 모둠은 퍼즐을 만들지 않고 한눈에 보기에서 '학생 없음'으로 표시한다. 나중에 그 모둠에 학생을 넣으면 그때 퍼즐을 만들고 그 학생에게 조각을 모두 준다.
- **코드 추측**: 6자리 코드는 열린 수업 동안만 유효하다. 틀린 코드가 짧은 시간에 반복되면 잠시 거부한다.
- **시험 훅**: 화면 시험 훅(`test-hooks.js`)과 서버 시험 훅(시계 앞당기기, dev 교사 토큰)은 로컬에서만 켠다. 운영 빌드·운영 환경변수에서는 경로가 없어야 한다(T19·T20 시험).
- **웹 품질**: 모든 화면은 `~/.claude/standards/web-quality.md` 를 지킨다. 화면 태스크(T21·T22)마다 4개 너비 Playwright 검사를 함께 넣는다.
- **CDN 없음**: 외부 스크립트는 구글 GIS 하나뿐이다. socket.io 클라이언트·WASM 인코더·QR 은 `public/js/vendor/` 에 고정 버전으로 둔다. 예외는 Pretendard 글꼴 CSS·글꼴 파일(jsDelivr, 스크립트 아님)이다.
- **원격 금지 사항**: `supabase db push`·`config push`·원격 `db reset`·`seed.sql` 원격 적용·`alter role`·`auth.users` 삭제·공용 확장 추가 금지. 파괴적 SQL(`drop`, `truncate`)은 실행 전에 사용자 확인.
- **그림 지우기 결과**: 서버가 거부하거나 실패하면 화면에 알린다(이전 T8 후속 권장 사항).
- **잡기 연장 상한 뒤 재잡기(T15 결정)**: 60초 상한으로 놓인 직후 같은 학생이 다시 잡는 것은 허용한다. 학급 도구라 위협이 낮고, 그 사이 다른 학생이 먼저 잡을 수 있다.
- **끄는 도중 놓임(T22)**: 끄는 중에 `release`(reason `limit`·`idle`)를 받거나 놓기가 `not-held` 로 거부될 때 화면이 덩어리를 어떻게 돌려놓고 알릴지 정한다.
- **한 학생 여러 덩어리 잡기(T19)**: 한 학생이 동시에 여러 덩어리를 잡는 것을 막을지 소켓 메시지 검증에서 정한다(엔진은 지금 막지 않음).
- **복구 입력 검증(T18)**: DB 에서 판을 복구할 때 덩어리 id 가 정수인지, 모든 조각이 판·상자 중 정확히 한 곳에 있는지 확인한다(엔진은 중복·범위만 검사하고, 빠진 조각은 주인 없는 조각으로 본다).
- **session.end 는 registry 전용(T19 전)**: 수업 객체의 `end` 를 공개 API 에서 빼거나 registry 만 부르게 한다. 직접 부르면 registry 의 토큰 색인이 남는다(D14).
- **교사 메시지 검증·학생 수 상한(T19)**: 수업당 학생 수 상한(예: 60)을 검토한다. 편성·시작·한눈에 보기·끝내기 등 교사 메시지는 `session.teacherId` 와 교사 토큰 uid 를 대조하고, 거부 시험을 둔다(D12).
- **24시간 자동 종료(T18)**: `registry.end` 로 메모리까지 닫는다. 시작 전 수업은 `createdAt` 기준으로 센다.
- **저장 토큰 재접속 실패(T22)**: 저장된 토큰으로 다시 들어가다 `invalid_code` 를 받으면 그 수업 코드의 localStorage 키를 지운다.
- **원격 권한 점검(T25)**: 원격 적용 전후에 `storage.objects` 에 bucket 조건 없이 anon·authenticated 에 열린 정책이 있는지, `pg_default_acl` 에 스키마 지정 없는 전역 기본 권한이 있는지 확인한다. D12 curl 점검에 Storage 요청(공개 키로 `jigsaw-images` 목록·읽기)을 포함한다.
- **계정 삭제와 그림 파일(T24)**: `docs/ops.md` 의 탈퇴 절차는 gyosil `auth.users` 계정이 삭제될 때도 적용한다. DB 행은 cascade 로 지워지지만 Storage 파일은 남으므로 `jigsaw-images/<uid>/` 파일 삭제 절차를 함께 적는다.
- **T19 결정 기록**: 한 학생은 한 덩어리만 잡는다(다른 덩어리를 잡으면 먼저 잡은 것은 `regrab` 으로 놓임). 틀린 코드는 같은 1분 창에서 `틀린 코드 > 60 + 그 주소의 성공 입장 × 3` 이 되면 30초 동안 그 주소의 입장을 모두(맞는 코드 포함) 거부한다. 학교 NAT 에서 한 반이 함께 들어오며 내는 오타로는 막히지 않게 한 값이다(`RT_WRONG_CODE_LIMIT`·`RT_WRONG_CODE_BONUS`·`RT_WRONG_CODE_BLOCK_MS` 로 조정). 수업당 학생 상한 60, 교사 소켓은 연결할 때 교사 토큰 uid 와 `session.teacherId` 를 대조한다. 소켓 시험은 로컬 Supabase 가 필요해 `tests/server/db/socket.test.js` 에 둔다(`pnpm test:server`).
- **입장 차단 안내(T22)**: `POST /api/join` 이 `429 too_many_attempts` 를 주면 학생 화면은 '잠시 뒤에 다시 입력해 주세요' 라고 안내한다.
- **주소 판단과 프록시(T24·T25)**: `docs/ops.md` 의 Caddyfile 에 `trusted_proxies` 를 넣지 않는다(Caddy 가 클라이언트가 보낸 X-Forwarded-For 를 그대로 넘기지 않게). T25 에서 위조한 `X-Forwarded-For` 로 주소별 제한을 피할 수 없는지 확인한다. `/etc/jigsaw-rt.env` 틀과 systemd 유닛에 `NODE_ENV=production` 을 명시한다(시험 훅이 켜지지 않게).
