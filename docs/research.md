# 협동 직소 퍼즐 조사 (2026-10-07)

해외 서비스, 국내 한국어 서비스·교사 수요, 실시간 기술 방식을 웹에서 조사했다. [사실]은 공식 페이지·코드·원문에서 확인한 것, [추정]은 간접 근거, '미확인'은 확인하지 못한 것이다. 인디스쿨·Reddit·Jigidi는 접근이 막혀 보지 못했다.

## 1. 결론

- **새로 만들 가치가 있다.** 한국어 + 웹 + 교사 사진 + 아동 안전 + 교사용 기능을 함께 갖춘 협동 퍼즐은 국내외 어디에도 없다.
- **한국어로 쓸 수 있는 협동 퍼즐은 있지만 수업용은 없다.** Foony(게임 포털, 알파), Puzzle Garage(광고, 게임 포털), Google Puzzle Party(명화만), Puzzle Together(유료 앱)뿐이다.
- 교사들은 영어 UI인 **Jigsaw Explorer**를 불편을 감수하며 쓰고 있다(교사 연수에도 소개됨). 개선할 점은 그 불편 목록에서 나온다(3절).

## 2. 서비스 비교

| 서비스 | 한국어 | 인원 | 교사 사진 | 채팅 | 광고·가격 | 13세 미만 | 교사 기능 |
|---|---|---|---|---|---|---|---|
| Jigsaw Explorer | X | 동시 20명 | 이미지 URL만(업로드 불가) | 없음(추정) | 광고, 커스텀 퍼즐 페이지는 없음 | 교사가 만든 커스텀 링크+감독일 때만 허용 | 없음 |
| JigsawPuzzles.io | X | 방당 1~10명 | 참가자 모두 같은 파일 필요 | 있음 | 동영상 광고, $48/년 | 금지(13+) | 없음 |
| Jiggie (aggie 후속) | X | 미확인 | 업로드 | 있음(추정) | 확인 범위에선 없음 | 부적합(NSFW 공개 방) | 없음 |
| Google Puzzle Party | O | 코드상 100명 | 불가(명화 500점) | 미확인 | 무료 | 명시 없음 | 없음 |
| Foony Jigsaw | O(기계 번역투) | 권장 10, 최대 100 | 업로드 | 포털 채팅방 | 가상 아이템 | 보호자 동의서 필요 | 없음 |
| Puzzle Garage | O | 방당 최대 9 | 미확인 | 미확인 | 광고, 유료 Premium | 미확인 | 없음 |
| Puzzle Together(앱) | O | 미확인 | 업로드·AI | 음성 | 크레딧·DLC 유료, 리뷰 26% 긍정 | iOS 9+ | 없음 |
| Wordwall·Kahoot·Blooket·띵커벨 | – | – | 직소 기능 없음 | – | – | – | – |

- 같은 조각 동시 잡기: Foony는 "먼저 클릭한 사람이 이김" [사실]. 다른 곳은 미확인.
- Jigsaw Explorer FAQ: **학교망이 WebSocket을 막으면 멀티플레이가 안 된다** [사실]. 확대 기능 없음, 링크 30일 미사용 시 삭제.
- jigsawpuzzle.io 도메인은 현재 도박 사이트로 바뀌었는데 해외 추천 기사엔 아직 남아 있다 [사실].

## 3. 교사 불편 → 개선점

| 교사가 겪는 불편 (출처: 교사 블로그) | 이 서비스의 대응 |
|---|---|
| 사진이 웹에 올라가 있어야 함("큰 벽"), 일부 이미지 주소는 안 됨 | 교사가 파일을 바로 올림, 자동 축소·EXIF 제거 |
| 영어 메뉴, 크롬 번역을 켜면 오작동 | 처음부터 한국어 |
| 모둠별 링크 6개를 학생마다 따로 배포, 다른 모둠 방에 들어가는 학생이 "꼭 있음" | 코드 하나 + 교사가 모둠 배정 |
| 누가 들어왔는지 몰라 "실명으로 들어오라"고 따로 지도 | 대기실에 들어온 이름이 바로 보임 |
| 링크 30일 만료, 링크만 있으면 누구나 접속 | 수업 단위 코드, 수업 끝나면 닫힘 |
| 한두 명이 다 맞추고 나머지는 구경 (해외 Puzzle Massive 개발자도 "동시 이동이 집중을 방해" 지적) | 조각을 나눠 갖기 — 모두 참여해야 완성 |
| 교사가 모둠 진행을 볼 수 없음 | 모둠 한눈에 보기(전자칠판) |
| 광고, 13세 미만 이용 제한, 게임 포털 차단 위험 | 광고·채팅·순위 없음, 학생 로그인·개인정보 없음, 수업 도구 주소 |
| 확대가 안 됨 | 두 손가락 확대 |

수업 활용 사례(확인됨): 학급 사진으로 학급 세우기, 교과서 명화 감상, 영어 표현 넣은 퍼즐 모둠 대회, 과학 그림 복습, 완성 그림 숨기고 방탈출 단서로 쓰기, 4명이 100조각에 약 20분.

## 4. 학교 환경·제도

- 학생 기기는 섞여 있다(서울: 안드로이드 > 크롬북 > 윈도 > iOS > 웨일북). 터치·마우스, 크롬·웨일·사파리를 모두 지원해야 한다.
- 학교 기기 관리(MDM)는 게임 사이트를 막는다 → 게임 포털형 도메인은 막힐 위험 [추정].
- **학습지원 소프트웨어 선정 기준**(초·중등교육법 제29조의2, 2026년 3월부터): 학생 개인정보를 처리하는 소프트웨어는 필수기준 6가지(최소처리, 14세 미만 법정대리인 동의 등)를 지키고 학교운영위원회 심의를 거쳐야 한다. 학생 개인정보를 처리하지 않으면 대상에서 빠질 여지가 있다 [추정].
- 개인정보보호법 제22조의2: 14세 미만은 법정대리인 동의가 필요하다 → 학생 계정을 두지 않는다.

## 5. 기술 방식

| 방식 | 30명(모둠 6개) 수업에서 | 판단 |
|---|---|---|
| Cloudflare Durable Objects | 받는 메시지 20개 = 요청 1개, 보내는 메시지 무료. 하루 약 8수업까지 무료, 이후 월 $5 | 비용·서버 권위 면에서 최적 |
| **Supabase Realtime (채택)** | 보낸 1 + 받은 N으로 셈. 무료 초당 100·월 200만, 1주 미사용 시 일시정지. Pro $25 | 익숙한 도구, 잡기·놓기만 방송하면 무료로 한 반 가능 |
| Liveblocks | 방당 10명(Free·Pro) | 모둠 단위면 가능하나 교사 관전까지 빠듯 |
| Ably·Pusher | 무료 한도를 수업 몇 번에 넘김 | 비추천 |
| Firebase RTDB | 무료 동시 접속 100명, Storage에 카드 등록 필요 | 시제품용 |
| Yjs/CRDT | 잠금·판정 권위가 없음 | 맞지 않음 |
| Vercel WebSocket | 베타, 약 5분에 끊김 | 부적합 |

- 설계 참고: 조각마다 잡은 사람(owner)을 두고 서버가 빈 조각만 잡게 함(먼저 온 사람이 이김), 조각 모양은 시드로 모든 기기가 같게 계산, 늦게 들어온 사람에게는 위치 스냅숏만 전송(Zutatensuppe/puzzle 구조).
- 조각 모양 공개 코드: Draradech/jigsaw(CC0), headbreaker(ISC). puzzle-massive는 AGPL이라 코드 재사용 주의.
- 렌더링: Canvas 2D + 조각 비트맵 캐시, devicePixelRatio 상한 2, 원본 2048px 이하.

## 출처

**해외 서비스**: jigsawexplorer.com(/multiplayer-jigsaw-puzzle-games, /support, /terms-of-service, /privacy-policy), jigsawpuzzles.io(/supporter, /terms-of-service, /blog/how-to-turn-your-own-image-into-a-jigsaw-puzzle), jiggie.fun, git.coom.tech/coomdev/reaggie, artsandculture.google.com/experiment/puzzle-party/EwGBPZlIzv0KRw?hl=ko, foony.com/ko/games/jigsaw-puzzle-online, foony.com/terms, puzzlegarage.com/multiplayer, jigsawplanet.com/?rc=faq, store.steampowered.com/app/1478220, apps.apple.com/app/id1530102367, miro.com/templates/collaborative-jigsaw-puzzle-ice-breaker, github.com/jkenlooper/puzzle-massive, github.com/flbulgarelli/headbreaker, github.com/Zutatensuppe/puzzle, github.com/Draradech/jigsaw

**교사 글**: blog.naver.com/y_not_m/223538943520, blog.naver.com/hailoo1/223454779718, blog.naver.com/codetrip/224057034164, sciencelove.com/2618, blog.naver.com/creatorjo/223256029566, blog.naver.com/art_talk_class/224324384296, blog.naver.com/mineandyours/223348631615, blog.naver.com/uhgene/222483631022, blog.naver.com/thsalsdk0727/223705974337

**제도·환경**: moe.go.kr 학습지원 소프트웨어 선정 기준(2025.12.29), etnews.com/20251229000259, blog.naver.com/hihi033/224173913219, goe.go.kr 2025 스마트기기 관리 방안, biz.heraldcorp.com/article/3218739, casenote.kr/법령/개인정보_보호법/제22조의2

**기술**: supabase.com/docs/guides/realtime/limits, supabase.com/docs/guides/realtime/pricing, supabase.com/pricing, developers.cloudflare.com/durable-objects/platform/pricing, liveblocks.io/pricing, ably.com/pricing, pusher.com/channels/pricing, firebase.google.com/pricing, dev.classmethod.jp/en/articles/vercel-functions-websocket-public-beta-verification
