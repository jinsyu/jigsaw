# Plan: 모둠 협동 직소 퍼즐 (함께 퍼즐)

기준 문서: `docs/spec.md`(승인), `docs/research.md`, 화면 목업 `docs/mockups/*.png`·`docs/mockups/src/*.html`(화면 구성·문구·색은 목업을 따른다).
`[사용자 작업]` 표시는 에이전트가 할 수 없는 일(계정·프로젝트 생성, OAuth 등록, 비밀번호 입력, 도메인 연결)이다. T14 전까지는 전부 로컬 Supabase로 개발·검증한다.

- [x] T1: 프로젝트 초기화 (정적 사이트 뼈대, Vitest·Playwright, 기본 SEO·파비콘, 빈 배포 가능 상태) — DoD: -
  - pnpm `package.json`(개발 의존성만: vitest, @playwright/test). 빌드 단계 없음.
  - 폴더 구조: `public/`(배포 루트: `index.html`, `privacy.html` 자리, `css/`, `js/`, `images/`), `supabase/`, `tests/unit`·`tests/db`·`tests/e2e`·`tests/fixtures`, `scripts/`.
  - `vercel.json`: `outputDirectory: "public"`(migrations·tests가 공개되지 않게), 화면 경로(`/teacher/...`, `/join` 등) → `index.html` 재작성, 기본 보안 헤더.
  - `scripts/serve.mjs`: 의존성 없는 로컬 정적 서버(같은 재작성 규칙). Playwright `webServer` 로 사용.
  - 목업 `common.css`를 바탕으로 기본 스타일, 첫 화면 뼈대(학생 '코드 입력' 크게, 교사 '수업 만들기' 작게)와 경로 분기(`js/app.js`).
  - SEO: title·description·canonical(`https://jigsaw.gyosil.app`)·OG(og 이미지 1200x630), `robots.txt`, `sitemap.xml`, 파비콘(SVG + PNG 32·180, 목업 `iconPiece` 모양).
  - 시험: Vitest 예제 1개, Playwright 스모크(첫 화면 표시, 360·390·1024·1440px 가로 넘침 없음).

- [x] T2: 퍼즐 기하·맞춤 판정 JS 모듈 + 공용 시험 사례 표 — DoD: D7
  - `public/js/puzzle/geometry.js`: 시드 rng, 조각 수(12·24·48·70) → 격자(4x3, 6x4, 8x6, 10x7, 세로 그림은 행열 바꿈), 조각 모양(목업 `common.js` `makePuzzle`·`edge` 재사용, Path2D/SVG path 둘 다).
  - 좌표 규약: 완성 그림 너비 = cols x 100 단위, 높이는 그림 비율로. 덩어리 위치 (x, y) = 완성 그림 원점의 판 위 위치. 판 = 각 변 약 √3배(넓이 3배).
  - `public/js/puzzle/snap.js`: `findMerges(clusters, droppedId, tol)` — 이웃 조각을 가진 덩어리끼리 원점 차이가 허용 거리 안이면 합치고, 합친 뒤 다시 검사(연쇄). 합친 위치는 큰 덩어리(같으면 id 작은 쪽) 기준으로 정한다. 진행률(맞춘 조각 = 2개 이상 덩어리에 속한 조각 수)·완성 판정. (T5 에서 바뀜: 판 가운데 틀 원점 `frameOrigin` 가까이 오면 제자리에 고정, 고정된 쪽이 합치기 기준, 진행률 = 고정된 조각 수, 완성 = 모든 조각 고정, 허용 거리 40)
  - 판 경계 고정(clamp) 규칙도 여기서 정의.
  - `tests/fixtures/snap-cases.json`: 입력(격자, 덩어리 목록, 놓은 덩어리, 허용 거리) → 기대 결과(합쳐진 덩어리, 최종 위치, 완성 여부). 경계값(허용 거리 딱 안/밖), 대각선(이웃 아님), 연쇄 합치기, 판 밖 놓기 포함 15개 이상.
  - Vitest: 같은 시드 → 같은 모양, 모든 사례 통과.

- [x] T3: 로컬 Supabase·스키마·RLS·실시간 권한·저장소 — DoD: D12, D14
  - `npx supabase init` / `npx supabase start`(docker). CLI 전역 설치 없이 `npx` 로만. `package.json` 스크립트(`db:start`, `db:reset`, `test:db`).
  - `supabase/config.toml`: 익명 로그인 켜기, 로컬 전용 이메일·비밀번호 로그인(시험용 교사), **익명 가입 한도 상향**(학교는 한 IP로 30명 이상이 들어옴).
  - 마이그레이션: `images`, `sessions`(코드, 그림, 조각 수, cols·rows, 그림 비율, 시드, 상태, 시작 시각), `groups`, `members`(이름 열 없음, 색 번호, last_seen), `clusters`, `pieces`. 교사 = 익명이 아닌 사용자(`auth.jwt()->>'is_anonymous'`).
  - RLS: 교사는 자기 수업 전체, 학생은 자기 수업 행·자기 모둠 행만 읽기. 조각·덩어리 쓰기는 직접 불가(RPC만).
  - `realtime.messages` 정책: `group:<id>` 는 그 모둠 학생·담당 교사만, `session:<id>`(Presence) 는 그 수업 참가자·교사만.
  - Storage: 비공개 버킷 `images`(경로 `<teacher_uid>/<id>.webp`), 교사 본인만 쓰기·지우기, 그 그림을 쓰는 수업의 학생은 읽기.
  - `supabase/seed.sql`: 시험용 교사 계정. `tests/db/` 공용 도우미(교사·학생 클라이언트 만들기, service 키는 `npx supabase status -o env` 에서 읽고 저장소에 커밋하지 않음).
  - 시험: 다른 모둠·다른 수업 행 읽기·쓰기 거부, 학생이 테이블 직접 update 거부, 다른 모둠 채널 구독 거부, members 에 이름 열이 없음.

- [x] T4: 수업 흐름 RPC + 자동 정리 — DoD: D3, D4, D5, D14
  - `create_session`(열린 수업 사이에서 겹치지 않는 6자리 코드, 시드), `join_session(code)`(틀린 코드·닫힌 수업 → 정해진 오류 코드, 같은 uid 재입장은 기존 행 반환), `assign_member(member, group|null)`, `randomize_groups`, `start_session`, `end_session`.
  - `start_session`: 모둠마다 조각·덩어리 생성, 모둠원 수로 무작위 고르게 나누기(최대 1개 차이), 색 번호 부여, `realtime.send` 로 `session:<id>` 에 시작 알림.
  - 시작 후 배정된 학생은 상자 없음. 시작 후 다른 모둠으로 옮긴 학생의 상자 조각은 원래 모둠 접속자에게 나눈다.
  - `end_session`: 상태 종료, members 삭제, 그 학생 익명 계정(`auth.users`) 삭제, 각 모둠·수업 채널에 종료 알림.
  - pg_cron: 24시간 지난 members·익명 계정 삭제(입장 실패로 남은 익명 계정 포함), 종료 30일 뒤 sessions(연쇄 삭제) 삭제.
  - 시험: 24조각·5명 → 5·5·5·5·4, 틀린 코드 오류, 교사가 아닌 사용자 호출 거부, 종료 후 members·익명 계정 0개, cron 함수 직접 호출로 정리 확인.

- [x] T5: 퍼즐 RPC(꺼내기·잡기·놓기·합치기·완성) + JS·SQL 맞춤 판정 교차 검사 — DoD: D5, D6, D7, D10
  - `take_from_tray(piece, x, y)`: 상자 주인만 성공.
  - `grab(cluster)`: 원자적 update 하나로 먼저 온 쪽만 성공(비어 있음, 또는 잡은 지 10초 지남, 또는 잡은 사람 끊김일 때만 뺏을 수 있음).
  - `drop(cluster, x, y)`: 잡은 사람만, 판 경계 고정, 맞춤 판정·연쇄 합치기·제자리(틀) 고정(모둠 행을 잠가 같은 모둠의 놓기를 차례로 처리), 모든 조각이 제자리에 고정되면 `groups.completed_at` 기록. 고정된 덩어리는 잡을 수 없다(`locked`).
  - 결과는 `realtime.send` 로 `group:<id>` 에 방송(잡기·놓기·합치기·완성). 끄는 도중 움직임은 방송하지 않는다.
  - 맞춤 판정은 순수 SQL 함수로 분리하고, `tests/db/snap-parity.test.js` 가 `tests/fixtures/snap-cases.json` 의 모든 사례를 JS `resolveDropWithHolds` 와 SQL 함수(그리고 `drop`·`take_from_tray` RPC) 양쪽에 넣어 결과가 같은지 검사한다(spec 위험 요소 'SQL 맞춤 판정' 대응).
  - 시험: 남의 상자 조각 꺼내기 거부, 동시 grab 두 개(Promise.all) 중 하나만 성공, 합치기 뒤 함께 움직임, 완성 시각 기록, 방송 메시지 수신.

- [x] T6: 끊김 처리 RPC(신호·자동 놓기·상자 나누기) — DoD: D8, D9
  - `heartbeat()`: last_seen 갱신(학생 화면이 5초마다 호출). 끊김 기준 약 15초.
  - 잡은 지 10초가 지났거나 잡은 사람이 끊긴 덩어리는 다른 학생이 `grab` 가능(T5 조건 시험 포함).
  - `redistribute_stale(group)`: last_seen 이 1분 넘은 학생의 상자 남은 조각을 같은 모둠 접속자(시작 후 들어온 학생 포함)에게 고르게 나누고 방송. 모둠 화면들이 주기적으로 호출해도 한 번만 일어나게(멱등).
  - 1분 안에 같은 uid 로 돌아오면 상자가 그대로임을 시험. 접속자가 아무도 없으면 나누지 않는다.
  - 시험은 시각을 직접 조작(last_seen·grabbed_at 을 과거로 update)해 빠르게.

- [x] T7: 교사 로그인·내 수업·수업 만들기·코드/QR — DoD: D1
  - supabase-js 를 CDN(버전 고정 ESM)에서 불러온다. `public/js/config.js` 가 주소로 로컬/원격 Supabase URL·공개 키를 고른다(공개 키만, 비밀 키 없음). 원격 값은 T14에서 채운다.
  - 로그인 화면은 구글 버튼만. 로컬·E2E에서는 시험용 교사로 세션을 주입해 로그인한다(이메일 입력 화면은 만들지 않음).
  - 목업대로 내 수업, 새 수업(그림 고르기 탭: 내장 / 내 그림 / 올리기, 조각 수 12·24·48·70 미리보기, 모둠 수), '수업 열기' → 대기실에 큰 6자리 코드·주소·QR.
  - QR은 실제 QR 라이브러리(예: qrcode-generator, MIT)를 `public/js/vendor/` 에 고정 버전으로 둔다. QR 주소는 코드가 채워진 입장 주소.
  - 내장 그림은 이 단계에서 목업 장면 6장(자체 제작 SVG → WebP)과 목록 파일(`images/builtin/index.json`: 키, 제목, 분류, 가로·세로, 출처)로 시작한다.
  - E2E: 시험용 교사로 수업을 열면 6자리 코드와 QR이 보인다.

- [ ] T8: 그림 올리기·내 그림 관리 — DoD: D2
  - 브라우저에서 긴 변 2000px 이하로 줄여 캔버스로 다시 그려 WebP로 저장(다시 그리기로 EXIF 제거). `toBlob` 결과가 WebP가 아니면(구형 사파리) WASM 인코더(@jsquash/webp)를 그때만 불러와 대체.
  - Storage 업로드 + `images` 행, '내 그림' 목록(교사 본인만), 지우기 = Storage 파일 삭제 + 행 삭제. 쓰는 중인 열린 수업이 있으면 지우기를 막는다.
  - 올리기 화면에 "학생 얼굴이 나온 사진은 학교 방침을 확인한 뒤 올려 주세요" 안내(목업 문구).
  - 시험: EXIF 있는 JPEG(시험 파일) 업로드 → 저장 파일이 WebP·긴 변 ≤2000·EXIF 없음, 지우면 Storage 에서 사라짐, 다른 교사는 목록·파일 접근 불가.

- [x] T9: 학생 입장·기다리기 + 교사 대기실 모둠 편성 — DoD: D3, D4, D14
  - 학생: 코드(QR로 들어오면 미리 채움)·이름 입력 → 익명 로그인 → `join_session` → 틀리면 "코드를 다시 확인해 주세요". 이름은 localStorage 와 `session:<id>` Presence 에만.
  - 기다리기 화면("선생님이 모둠을 정하고 있어요", 배정되면 내 모둠 표시). 같은 기기로 다시 열면 같은 이름·모둠으로 복귀.
  - 교사 대기실(목업 teacher-lobby): Presence 로 들어온 이름 표시, 모둠 칸으로 끌어 넣기(마우스·터치 모두, pointer events), '무작위로 나누기', '시작하기'. 빈 모둠 처리는 메모 참고.
  - 시작 알림을 받으면 학생은 퍼즐 화면(T10)으로 이동.
  - E2E(브라우저 컨텍스트 여러 개): 학생 입장 1초 안에 교사 화면에 이름 표시, 끌어 넣기·무작위 → 시작 → 각 학생 화면에 자기 모둠 표시. DB 전체에서 학생 이름 문자열이 없음을 확인.

- [x] T10: 학생 퍼즐 화면 — 판·상자·확대(혼자 조작) — DoD: D5, D13
  - 목업 student-phone(세로: 상자 아래)·student-tablet(가로: 상자 오른쪽). 위쪽 모둠 이름·진행률·모둠원 칩·'완성 그림' 버튼(작게 보기).
  - Canvas 2D: 조각 비트맵 캐시, devicePixelRatio 상한 2, 두 손가락 확대·이동, 그림은 원본 2048px 이하로 불러온다.
  - 상자에서 끌어 판에 놓기 → `take_from_tray`. 상자에는 내 조각만, 남의 조각은 상자에 나타나지 않는다.
  - 판 위 덩어리 끌기 → `grab`/`drop`(혼자일 때 동작까지). 놓을 때 JS 판정으로 바로 붙여 보여 주고 서버 결과로 확정, 붙으면 `navigator.vibrate`.
  - E2E: 360·390·1024·1440px 가로 넘침 없음, 터치 흉내로 꺼내기·옮기기·두 손가락 확대.

- [ ] T11: 협동 동기화·끊김·완성 화면 — DoD: D6, D7, D8, D9, D10
  - `group:<id>` 비공개 채널 구독: 잡기 → 다른 화면에 잡은 학생 색 테두리 + 이름표, 놓기 → 새 자리로 미끄러지듯 이동, 합치기 반영. 입장·재연결 시 전체 상태를 한 번 조회해 맞춘다.
  - 잡은 채 10초 가만히 있으면 화면이 스스로 놓기. 화면을 벗어나거나(visibilitychange) 연결이 끊기면 놓기 시도.
  - 5초마다 `heartbeat`, 주기적으로 `redistribute_stale`, 나눠 받은 조각이 상자에 나타남.
  - 완성: 모둠원 모두에게 축하 화면·완성 그림·걸린 시간(순위 없음).
  - E2E(학생 3명 컨텍스트): 동시 잡기 한 명만 성공·다른 화면 테두리, 붙은 조각이 모든 화면에서 함께 움직임, 한 명 컨텍스트 닫기 → 다른 학생이 그 덩어리 잡기, 1분 뒤 상자 나뉨(시험에서는 시각 조작 도우미 사용), 마지막 조각 → 모두에게 축하 화면.

- [ ] T12: 교사 모둠 한눈에 보기·수업 끝내기 — DoD: D10, D11, D14
  - 목업 teacher-overview: 모둠 격자(판 축소판·진행률·'완성' 표시), 3초마다 모둠 상태 조회 RPC 하나로 갱신(실시간 구독 안 함), 모둠을 누르면 크게 보기, 학생 모둠 옮기기, 전자칠판 크기 대응.
  - '수업 끝내기' → `end_session` → 학생 화면에 "수업이 끝났어요" 안내.
  - E2E: 갱신 간격 약 3초, 모둠 완성 시 '완성' 표시, 끝내기 뒤 members·익명 계정 삭제 확인.

- [ ] T13: 내장 그림 약 20장·출처 표기, 개인정보 처리방침, 외부 스크립트 점검 — DoD: D15
  - 내장 그림: 자체 제작 SVG 장면과 출처·라이선스가 확인된 그림(공공누리 1유형, CC0)만. WebP 긴 변 2000px 이하, `index.json` 에 출처·라이선스 기록, 출처 화면(또는 처리방침 아래)에 표기. 고른 목록은 사용자 확인을 받는다.
  - `privacy.html`: 수집 항목(교사 구글 이메일, 교사 그림, 학생은 익명 식별자만·이름은 저장 안 함), 보관 기간(spec 데이터 표), 삭제 방법(내 그림 지우기, 수업 끝내기, 자동 정리, 탈퇴 문의), 학습지원 소프트웨어 관련 근거. 모든 화면 아래에 링크.
  - 광고·외부 분석 스크립트 없음 확인: CSP 헤더(자기 도메인 + supabase-js CDN + Supabase 주소만), 시험으로 외부 요청 도메인 목록 검사.

- [ ] T14: 원격 배포·운영 설정·전체 E2E 최종 점검 — DoD: D1, D13
  - [사용자 작업] Supabase 원격 프로젝트 생성, `npx supabase link` 와 `db push`(DB 비밀번호 입력), 익명 로그인 켜기, 익명 가입 한도 상향, pg_cron 확장 확인.
  - [사용자 작업] Google Cloud OAuth 클라이언트 등록(승인된 리디렉션: Supabase 콜백), Supabase 구글 공급자 설정, Auth 리디렉션 허용 주소에 `https://jigsaw.gyosil.app` 추가.
  - [사용자 작업] GitHub 저장소 연결, Vercel 프로젝트 생성·연결, `jigsaw.gyosil.app` 도메인 DNS 연결.
  - 에이전트: `config.js` 에 원격 URL·공개 키(사용자에게 받은 값) 반영, 배포 확인, 실제 구글 로그인으로 수업 열기까지 사용자와 함께 확인.
  - 전체 흐름 E2E(교사 1 + 학생 5, 로컬)를 4개 너비에서 다시 실행, 실패 없음 확인. 시범 수업 점검표(학교망 WebSocket, MDM 분류, 메시지 사용량 측정 방법)를 README에 남긴다.

## 메모

### 순서의 이유
- 가장 불확실한 부분(맞춤 판정을 JS·SQL 양쪽에 같게, RLS·Realtime 권한)을 화면보다 먼저 만든다(T2~T6). 화면 태스크는 검증된 RPC 위에 올린다.
- T14 전까지 원격 계정이 하나도 필요 없다. 구글 로그인은 로컬에서 시험용 교사 세션 주입으로 대신하고, 실제 구글 로그인은 T14에서 확인한다. 사용자는 T14의 `[사용자 작업]` 을 언제든 미리 해 둘 수 있다.
- 태스크가 14개로 보통보다 많다. 서버(RPC·RLS)와 화면이 각각 무거워 한 세션 크기를 지키려고 나눴다.

### 주의할 점
- **좌표·허용 거리 상수는 한 곳에서**: JS `snap.js` 상수와 SQL 함수 상수가 어긋나지 않게, 공용 사례 표에 허용 거리 값을 함께 넣고 교차 검사로 지킨다. 실수 비교는 경계에서 오차가 날 수 있으니 사례 표 경계값은 1e-6 이상 떨어뜨린다.
- **동시성**: `grab` 은 조건부 update 한 번(행 잠금)으로 처리하고, `drop` 은 모둠 행 `for update` 로 같은 모둠 합치기를 차례로 처리한다. 트랜잭션 안 `now()` 는 고정값임에 유의.
- **realtime.send**: 비공개 채널은 클라이언트에서 `private: true` + `realtime.setAuth()` 가 필요하고 `realtime.messages` RLS 정책이 있어야 받는다. 로컬 Supabase 버전에서 동작을 T3에서 먼저 확인한다.
- **익명 가입 한도**: Supabase 기본값은 IP당 시간당 30회다. 한 반이 학교 IP 하나로 들어오므로 로컬·원격 모두 올려야 한다(T3, T14).
- **Storage 직접 삭제 금지**: SQL로 `storage.objects` 를 지우면 막히거나 파일이 남는다. 그림 지우기는 Storage API로 한다. spec의 '1년 미사용 그림 자동 정리'는 Storage API가 필요하므로, T4 cron 에서 처리하기 어려우면 대상 목록만 표시하고 방법(Edge Function 예약 실행)을 보고해 결정을 받는다.
- **학생 이름**: DB 행, RPC 인자, 방송 payload, 로그 어디에도 넣지 않는다. 이름은 Presence 상태와 localStorage 에만. T9·T12 시험에서 DB 덤프에 이름 문자열이 없는지 검사한다.
- **빈 모둠**(가정, 사용자가 다르게 원하면 T9 전에 알려 주세요): 시작할 때 학생이 0명인 모둠은 퍼즐을 만들지 않고 한눈에 보기에서 '학생 없음'으로 표시한다. 그 모둠에 나중에 학생을 넣으면 그때 퍼즐을 만들고 그 학생에게 조각을 모두 준다.
- **코드 추측**: 6자리 코드는 열린 수업 동안만 유효하다. `join_session` 실패가 짧은 시간에 반복되면 잠시 거부하는 정도의 제한을 둔다.
- **웹 품질**: 모든 화면은 `~/.claude/standards/web-quality.md`(SEO·파비콘, 360·390·1024·1440px 반응성, 성능)를 지킨다. 화면 태스크마다 4개 너비 Playwright 검사를 함께 넣는다.
- **목업 재사용**: `docs/mockups/src/common.js` 의 `rng`·`edge`·`makePuzzle` 는 ES 모듈로 옮겨 쓴다. 목업의 QR(`qrSVG`)은 가짜이므로 쓰지 않는다.
- **CDN 고정**: supabase-js 와 WASM 인코더는 버전을 고정해 불러오고, CSP 허용 목록에 그 도메인만 넣는다. 단위 시험은 CDN 없이 도는 순수 모듈만 대상으로 한다.

### T3 리뷰 참고사항 (이후 태스크)
- **T4**: 모둠 이동·`end_session` 뒤에도 Realtime 권한 캐시 때문에 예전 `group:<id>` 채널을 계속 받을 수 있다 → 모둠을 옮기면 클라이언트가 다시 구독하게 하고 동작을 시험한다. 익명 계정 삭제 기준은 '그 수업 members 의 user_id'.
- **T5**: Supabase 이미지는 `extra_float_digits = 0` 이라 float8 → JSON·text 가 15자리로 잘린다. T3 마이그레이션이 API 역할에 `extra_float_digits = 1` 을 걸었지만, float8 을 JSON·text 로 만드는 함수(realtime.send 내용 등)는 `set extra_float_digits = 1` 을 직접 붙인다.
- **T9**: Presence 키는 클라이언트가 정한다 → 대기실 이름은 members 와 대조하고, Presence 키를 그대로 믿지 않는다.
- **T14**: `supabase config push` 금지(로컬 auth 설정이 원격에 올라감), seed 원격 적용 금지, 이메일 공급자 끄기(구글만), 익명 가입 한도 상향, 공개 Realtime 채널 접근 끄기(비공개만), `extra_float_digits` alter role 이 원격에 적용됐는지 확인.

### T4 리뷰 참고사항 (T5 에서 반드시 처리)
1. `private.deal_tray` 의 moved update WHERE 에 `not p.on_board` 와 기대 주인 조건을 다시 넣거나, 모둠 행 `for update` 잠금을 T5·T6 과 공유한다 — 교사 이동 중 학생 `take_from_tray` 와 경쟁하면 판 위 조각에 주인이 다시 생긴다(reviewer 가 두 연결로 재현). T5 에서 시험으로 막는다.
2. `join_session`: 수업 종료로 익명 계정이 삭제된 뒤 남은 JWT 로 호출하면 원시 FK 오류(23503)가 난다 → 시작할 때 `auth.users` 존재를 확인하고, 없으면 정해진 오류(`account_gone`)를 돌려준다. T9 화면은 이를 받으면 익명 로그인을 다시 한다.
3. `assign_member` 주석(343행 근처)과 실제 응답(`member_not_found` / `forbidden`)이 어긋난다 → 주석 또는 응답을 정리한다.
4. 참고: cleanup 의 24시간 자동 종료는 `end` 방송·잡기 해제가 없다 → 화면은 수업 상태 조회로 종료를 감지한다(T11·T12). `start_session` 은 색 번호를 다시 매기지만 `groups` 방송이 없다 → 화면은 `start` 를 받으면 members 를 다시 읽는다(T9·T11). 내장 그림 `p_aspect` 범위 제한(예 1/2000~2000)을 검토한다.

### T6 리뷰 참고사항 (T11 에서 처리)
- 화면은 `heartbeat` 를 5초마다 따로 보내고, 백그라운드에서 돌아오면 `redistribute_stale` 보다 `heartbeat` 를 먼저 부른다(호출자 자신이 1분 넘게 끊긴 상태면 자기 상자가 나뉠 수 있음 — `disconnect.sql` 121~129행).
- 모둠원이 아닌 상자 주인도 끊긴 것으로 보고 나눈다(방어용).
- Realtime 이 방송 payload 에 메시지 `id`(uuid)를 덧붙인다 → 화면은 무시한다.
- T14 관찰: `heartbeat` 호출 빈도 제한 없음(사용량 확인).
- 나중: `private.cleanup_expired` 가 members → auth.users 삭제 순서라 잠금 순서와 반대다(24시간 넘은 수업 대상, 영향 작음) — cleanup 을 손볼 때 `lock_board` 를 먼저 잡는다.

### T9 리뷰 참고사항
- Presence 위조: 같은 수업 학생이 다른 학생의 uid 를 Presence 키로 써서 이름을 사칭할 수 있다. 서버는 Presence 내용을 검사하지 않고, 막으려면 이름을 저장해야 해 D14(이름 미저장)와 충돌하므로 완전 차단은 불가. 화면은 members 행과 대조한 이름만 보여 준다(교실 안 장난 수준의 위험).
- 들어왔다가 나간 학생도 members 에 남아 대기실에 '나감'으로 보이고 무작위 나누기에 포함된다 → T11 에서 시작 때 그 학생 상자 조각이 어떻게 처리되는지(1분 뒤 나누기) 확인한다.
- `tests/db/rls.test.js` '교사 읽기'는 공유 시험 교사의 수업 목록 전체를 기대하므로, E2E 와 동시에 돌리거나 남은 시험 수업이 있으면 실패한다 → 시험 격리 개선 필요.
- 학생 모듈이 `public/js/teacher/dom.js`(h, nodes, pieceIcon)를 재사용한다 → 나중에 공용 위치(예: `public/js/dom.js`)로 옮긴다.

### 규칙 변경 반영 리뷰 참고사항
1. 수업 만들기 '수업 열기' 버튼이 1440×900 에서 화면 밖으로 밀린다(옆 패널이 화면보다 길다) → 그림 분류 탭 작업 때 패널 max-height + 버튼 sticky, 또는 도움 설정 접기로 처리한다.
2. 학생 화면이 sessions 의 hint_* 를 읽어 쓰는 연결(`hintsFromSession`)은 T11 원격 저장소에서 한다.
3. 판 크기는 수업 행에 저장하지 않는다(배포 전이라 단순하게). 배포 뒤 판 크기를 다시 바꾸면 sessions 에 판 비율을 저장해야 한다.
4. csp.spec 에 교사 수업 만들기 화면을 추가하는 것을 권장한다.
