# 함께 퍼즐 운영 문서 (rt 서버·DB 백업·탈퇴 처리)

실시간·판정 서버 `rt.gyosil.app` 의 설치·배포·로그·백업·복원과 교사 탈퇴 처리 절차를 적는다. 구조는 `docs/spec.md` '시스템 구조'를 따른다. rt 서버(Lightsail)는 여러 앱이 함께 쓰는 구조다. 서버 공통 설정과 앱별 규칙은 '12. 새 앱 추가', 이전 구조에서 옮기는 절차는 '13. 여러 앱 구조로 옮기기'에 있다.

## 1. 한눈에 보기

| 항목 | 값 |
|---|---|
| 서버 | AWS Lightsail 서울, Ubuntu 24.04, 1GB, 고정 IP `13.124.90.119`, 방화벽 22·80·443 |
| 주소 | `rt.gyosil.app` A 레코드 → 고정 IP. Caddy 가 HTTPS 인증서를 자동으로 받는다 |
| 흐름 | 브라우저 → Caddy(443) → `127.0.0.1:3400` Node 24 (`server/src/index.js`) → Supabase gyosil |
| 코드 | `/opt/jigsaw` (공개 저장소 `https://github.com/jinsyu/jigsaw.git` 의 main, root 소유). 서버는 `server/` 만 실행하고, 퍼즐 규칙은 `public/js/puzzle/` 를 그대로 읽는다 |
| 실행 사용자 | `jigsaw-rt` (시스템 사용자, 로그인 셸 없음, 코드는 읽기만) |
| 서비스 | `jigsaw-rt.service` (`scripts/rt/jigsaw-rt.service`) |
| 비밀값 | `/etc/jigsaw-rt.env` (root, 600). 키 목록과 설명은 `server/.env.example` |
| 백업 | `jigsaw-backup.timer` → `scripts/db/backup.sh`, 파일은 `/var/backups/jigsaw` (600), 접속 주소는 `/etc/jigsaw-backup.env` (root, 600) |
| 로그 | journald, 14일 보관 (`/etc/systemd/journald.conf.d/zz-retention.conf`, 서버 전체) |
| Caddy (서버 공통) | `/etc/caddy/Caddyfile` (`scripts/rt/caddy/Caddyfile`): 전역 옵션(기본 로그(오류·tls·admin.api)에서 접속자 주소·포트·요청 헤더 제거)과 마지막 줄 `import /etc/caddy/sites/*.caddy` 만 |
| Caddy (jigsaw 사이트) | `/etc/caddy/sites/jigsaw.caddy` (`scripts/rt/caddy/sites/jigsaw.caddy`): `rt.gyosil.app` → `127.0.0.1:3400`. 접근 로그 없음, `trusted_proxies` 없음 |

- 저장소가 공개라 서버는 https 로 clone·pull 한다. **deploy key·GitHub 토큰은 쓰지 않는다.** 저장소를 비공개로 바꾸면 그때 읽기 전용 deploy key 를 만든다.
- 배포(다시 시작)는 모든 수업을 몇 초 끊는다. 학생·교사 화면은 자동으로 다시 연결되고 판은 이어진다(spec D17). 그래도 **배포는 수업 시간 밖에** 한다.

## 2. 처음 설치

미리 되어 있어야 하는 것: 원격 마이그레이션 적용(`SUPABASE_DB_URL=… bash scripts/db/migrate.sh`, 사용자가 노트북에서 실행), Data API Exposed schemas 에 `jigsaw`·`core`.

SSH 로 서버에 들어가 실행한다.

```bash
# 1) 설치 스크립트 받기 (처음 한 번. 그다음부터는 /opt/jigsaw/scripts/rt/setup.sh)
curl -fsSL https://raw.githubusercontent.com/jinsyu/jigsaw/main/scripts/rt/setup.sh -o /tmp/jigsaw-setup.sh

# 2) 1회차: 서버 공통(패키지·저장소·스왑·journald·Caddy 설치)과 앱(Node·사용자·의존성)을 갖추고
#    /etc/jigsaw-rt.env 틀을 만든 뒤 멈춘다 (종료 코드 3)
sudo bash /tmp/jigsaw-setup.sh

# 3) 비밀값 넣기 (아래 '3. 비밀값')
sudo nano /etc/jigsaw-rt.env

# 4) 2회차: 백업 타이머·서비스·Caddy 설정. 새 서버의 Caddyfile 은 Caddy 패키지 기본 파일이라 교체 옵션을 붙인다
sudo bash /opt/jigsaw/scripts/rt/setup.sh --replace-caddyfile

# 5) 확인
curl -s https://rt.gyosil.app/health
```

`setup.sh` 는 몇 번을 다시 실행해도 된다. 단계마다 먼저 확인하고 이미 된 것은 건너뛴다. 단계는 '서버 공통' → '앱: jigsaw' → 'Caddy 설정' 순서다. 공통 설정 파일의 원본도 이 저장소에 있어서 저장소를 먼저 받는다.

| 구분 | 단계 | 하는 일 | 이미 되어 있으면 |
|---|---|---|---|
| 공통 | 기본 패키지 | `ca-certificates curl gnupg git` | 건너뜀 |
| 공통 | 저장소 | `/opt/jigsaw` 에 main clone (jigsaw 코드이자 공통 설정 파일 원본) | 건너뜀 (새 커밋은 `deploy.sh`) |
| 공통 | 스왑 | `/swapfile` 1GB, `/etc/fstab` | 스왑이 켜져 있으면 건너뜀 |
| 공통 | journald | 보관 14일 설정 `zz-retention.conf`. 이전 이름 `zz-jigsaw.conf` 가 있으면 `zz-jigsaw.conf.bak-<시각>` 으로 옮김 | 같으면 건너뜀 |
| 공통 | Caddy 설치 | 없으면 공식 apt 저장소로 설치, `/etc/caddy/sites` 폴더 | 건너뜀 |
| 앱 | Node.js 24 | NodeSource `node_24.x` 저장소(주 버전 고정, Ubuntu 기본 nodejs 보다 우선) | `/usr/bin/node`(유닛이 실행하는 node) 주 버전이 24 면 건너뜀 |
| pnpm | `corepack pnpm@10.11.0` (전역 설치 없음) | — |
| 앱 | PostgreSQL 17 클라이언트 | apt.postgresql.org 저장소, `postgresql-client-17` (백업용 `pg_dump`) | 건너뜀 |
| 앱 | 사용자 | `jigsaw-rt` 시스템 사용자 | 건너뜀 |
| 앱 | 의존성 | `server/` 에서 `pnpm install --prod --frozen-lockfile` | 바뀐 것만 |
| 앱 | 비밀값 파일 | 없으면 `server/.env.example` 로 틀을 만들고(운영 고정값만 채움) 멈춤. 필수 값이 비어 있어도 이름만 알리고 멈춤 | 권한을 root 600 으로 맞춤 |
| 앱 | 백업 타이머 | 유닛 설치, `/etc/jigsaw-backup.env` 틀. 접속 주소가 있으면 타이머 켬 | 같으면 건너뜀 |
| 앱 | 서비스 | 유닛 설치·켜기·시작 후 `/health` 확인(30초) | 유닛이 같고 실행 중이면 다시 시작하지 않음 |
| Caddy 설정 | 앱 사이트 파일 | `/etc/caddy/sites/jigsaw.caddy` 설치. **`sites/` 의 다른 파일(다른 앱)은 건드리지 않는다** | 같으면 건너뜀 |
| Caddy 설정 | 공통 Caddyfile | 없으면 넣음. 같으면 그대로. 이전 jigsaw 전용 Caddyfile(사이트 블록이 들어 있던 저장소 버전, sha256 으로 확인)이면 `.bak-<시각>` 으로 보관 후 교체. 그 밖에 다르면 **덮지 않고 알림** (`--replace-caddyfile` 이면 `.bak-<시각>` 으로 보관 후 교체) | 같으면 건너뜀 |
| Caddy 설정 | 검사·적용 | 바뀐 것이 있으면 `caddy validate` → 통과하면 `systemctl reload caddy`(재시작 아님). 실패하면 이번에 바꾼 두 파일을 되돌리고 멈춤(Caddy 는 이전 설정 그대로) | 바뀐 것이 없으면 reload 하지 않음 |

- Caddy 설정을 맨 끝에 한 번에 하는 이유: 공통 Caddyfile 과 `sites/jigsaw.caddy` 가 같은 reload 로 함께 바뀌어야 `rt.gyosil.app` 사이트가 빠지는 순간이 없다. 비밀값이 비어 중간에 멈춰도 Caddy 설정은 손대지 않은 상태로 남는다.
- reload 는 Caddy 를 다시 시작하지 않아 HTTP 연결과 인증서는 그대로다. Caddy 는 기본으로 reload 때 열린 WebSocket 을 바로 닫지만, `jigsaw.caddy` 의 `stream_close_delay 5m` 때문에 reload 전에 열린 jigsaw 연결은 **reload 순간에는 끊기지 않고 최대 5분 더 이어진 뒤** 닫힌다. 닫히면 학생·교사 화면이 자동으로 다시 연결되고 판은 이어진다(D17, 몇 초). reload 뒤에 새로 열린 연결은 영향이 없다.
- 그래서 사이트 파일 변경(다른 앱 추가·수정, `setup.sh` 의 Caddy 설정 반영)은 수업 중에도 할 수 있다. 대가는 5분 뒤 한 번의 자동 재연결이다. **jigsaw 서비스 재시작·배포(`deploy.sh`)와 Caddy 재시작(`systemctl restart caddy`)은 연결을 바로 끊으므로 여전히 수업 시간 밖에** 한다.
- 지연은 그 연결이 열릴 때의 설정을 따른다. `stream_close_delay` 가 없던 설정(13장의 이전 전)에서 열린 연결은 그 설정을 바꾸는 첫 reload 때 바로 닫힌다.

옵션: `--skip-systemd`(스왑·journald·유닛·서비스·caddy reload 건너뜀, 컨테이너 시험용), `--skip-caddy`(Caddy 설치·설정 건너뜀).

## 3. 비밀값 (`/etc/jigsaw-rt.env`)

- 파일은 root 소유 600 이다. systemd 가 root 로 읽어 서비스 환경변수로 넘긴다. 저장소·채팅·에이전트에게 값을 주지 않는다.
- 틀에 미리 채워지는 값(비밀 아님): `NODE_ENV=production`, `HOST=127.0.0.1`, `PORT=3400`, `RT_TRUST_PROXY=1`, `ALLOWED_ORIGINS=https://jigsaw.gyosil.app`, `SUPABASE_URL=https://ozfzpyumnaaggrlevygz.supabase.co`.
- 사용자가 넣는 값:

| 키 | 어디서 |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase 대시보드 → Project Settings → API keys (비밀) |
| `SUPABASE_ANON_KEY` | 같은 곳의 공개 키 |
| `SESSION_SECRET` | 서버에서 `openssl rand -hex 32` (비밀, 32자 이상) |
| `GOOGLE_CLIENT_ID` | Google Cloud OAuth 클라이언트 ID (공개 값) |

- 값에 공백·`$`·`#` 같은 문자가 있으면 작은따옴표로 감싼다(`KEY='값'`).
- `NODE_ENV` 는 `production` 이어야 한다(아니면 `setup.sh` 가 멈춘다). 유닛도 `NODE_ENV=production` 을 넣고 `RT_TEST_HOOKS` 를 마지막에 지우므로 시험 훅은 운영에서 켜지지 않는다.
- 값을 바꾼 뒤: `sudo systemctl restart jigsaw-rt` (수업 시간 밖에).
- `SESSION_SECRET` 을 바꾸면 발급된 교사 토큰이 모두 무효가 되어 교사는 다시 로그인한다.

## 4. 배포

```bash
sudo bash /opt/jigsaw/scripts/rt/deploy.sh
```

1. 열린 수업이 있으면 멈춘다(`/health` 의 `sessions`). 그래도 하려면 `--yes`.
2. `git pull --ff-only` → `server/` 운영 의존성 설치(`--frozen-lockfile`) → `systemctl restart jigsaw-rt` → `/health` 를 30초 동안 기다림.
3. 실패하면 이전 커밋으로 되돌리는 명령을 출력한다.

화면(Vercel)은 main 푸시로 따로 배포된다. 서버와 화면을 함께 바꾼 커밋은 rt 서버를 먼저 배포한다.

**내장 그림만 더한 커밋은 rt 서버 배포가 필요 없다.** 서버는 시작할 때 `public/images/builtin/index.json` 을 읽고, 모르는 그림 키로 수업을 만들려 하면 화면 쪽 사본(`ALLOWED_ORIGINS` 첫 주소 + `/images/builtin/index.json`)을 받아 목록에 더한다(1분에 한 번까지, 실패하면 `[builtin]` 오류 로그). 그래서 Vercel 배포가 끝나면 새 그림으로 바로 수업을 열 수 있다. 서버 코드·`public/js/puzzle/`·`scripts/rt/` 가 바뀐 커밋은 지금처럼 배포한다.

`scripts/rt/` 의 유닛·Caddy 파일(`scripts/rt/caddy/`)·journald 설정이나 `setup.sh` 가 바뀐 커밋은 `deploy.sh` 뒤에 `sudo bash /opt/jigsaw/scripts/rt/setup.sh` 를 한 번 더 실행해 서버에 반영한다(바뀐 것만 설치하고, 유닛이 바뀌면 서비스를 다시 시작한다).

### 되돌리기

`deploy.sh` 가 실패하면 출력된 명령을 그대로 실행한다.

```bash
sudo git -C /opt/jigsaw reset --hard <이전 커밋>
sudo bash /opt/jigsaw/scripts/rt/deploy.sh --no-pull --yes
```

되돌린 뒤 main 에 고친 커밋을 올리면 다음 `deploy.sh` 가 그대로 앞으로 받는다(`reset` 한 커밋은 main 의 조상이라 fast-forward 된다).

## 5. 상태와 로그

```bash
systemctl status jigsaw-rt                   # 실행 상태, 마지막 로그 몇 줄
curl -s http://127.0.0.1:3400/health         # 버전·가동 시간·열린 수업 수·연결 수 (비밀값 없음)
sudo journalctl -u jigsaw-rt -f              # 서버 로그 따라 보기
sudo journalctl -u jigsaw-rt --since today   # 오늘 로그
sudo journalctl -u caddy -n 50 --no-pager    # Caddy (인증서·설정 오류)
```

- 서버 로그에는 학생 이름·토큰·교사 토큰·IP 를 남기지 않는다(spec 데이터 표). Caddy 는 사이트 파일(`/etc/caddy/sites/*.caddy`)에 `log` 지시어가 없어 접근 로그를 남기지 않는다. 다만 Caddy 기본 로그는 오류(예: 서버가 다시 시작하는 동안의 502)를 요청 정보와 함께 남기므로, 공통 Caddyfile 전역 `log` 의 `format filter` 로 `request>remote_ip`·`request>client_ip`·`request>remote_port`·`request>headers` 를 지운다. 오류 메시지·주소 경로·상태 코드는 남는다(로컬 Caddy 2.11.7 에서 꺼진 서버로 502 를 만들어 주소·헤더가 찍히지 않음을 확인).
- `systemctl kill jigsaw-rt` 처럼 죽어도 `Restart=always` 로 2초 뒤 다시 뜨고 열린 수업을 DB 에서 복구한다(D17).
- 종료 신호(SIGTERM)를 받으면 새 요청을 받지 않고 남은 저장(최대 3회 묶음 저장)을 마친 뒤 끝난다. `TimeoutStopSec=30` 이 지나도 안 끝나면 systemd 가 강제로 끝내며, 이때 잃는 것은 마지막 2초 안의 판 이동뿐이다.

### 로그 보관 14일 확인

`/etc/systemd/journald.conf.d/zz-retention.conf`(서버 전체, 이전 이름 `zz-jigsaw.conf`): `MaxRetentionSec=14day`, `MaxFileSec=1day`(하루마다 파일을 나눠 오래된 기록이 제때 지워지게), `ForwardToSyslog=no`(`/var/log/syslog` 로 복사하지 않음 — rsyslog 사본은 logrotate 로 몇 주 남기 때문). Ubuntu 의 `/usr/lib/systemd/journald.conf.d/syslog.conf` 가 `ForwardToSyslog=yes` 를 넣고 설정 조각은 파일 이름 순으로 적용되므로, 이 파일 이름은 `syslog.conf` 보다 뒤인 `zz-` 로 시작한다.

```bash
systemd-analyze cat-config systemd/journald.conf | grep -E '^(MaxRetentionSec|MaxFileSec|ForwardToSyslog)='   # 같은 키는 마지막 줄이 적용: ForwardToSyslog=no 가 마지막
journalctl -o short-iso --no-pager | head -n 3                  # 가장 오래된 기록 (설정 후 15일이 지나면 14일 안쪽이어야 함)
journalctl --disk-usage
sudo grep -c jigsaw-rt /var/log/syslog 2>/dev/null || true     # 설정 뒤로는 늘지 않아야 함
```

- 이 설정은 서버 전체 journal(sshd 등 포함)에 적용된다. journald 는 파일 단위로 지우므로 실제 보관은 14일 이내다.
- Lightsail 스냅숏(최근 7개)에는 그 시점의 journal 파일도 들어 있다. 그래서 운영 기록은 journal 에 14일, 스냅숏 사본까지 합하면 최대 21일 뒤에 모두 지워진다(처리방침 1번과 같음). 학생 이름·토큰·IP 는 처음부터 남기지 않는다.

### 메모리

1GB 서버에 Node 힙 상한 512MB(`--max-old-space-size=512`)와 스왑 1GB 를 둔다.

```bash
free -h; swapon --show
systemctl show jigsaw-rt -p MemoryCurrent -p MemoryPeak
```

## 6. DB 백업

platform.md 2.5 대로 `jigsaw` 스키마를 매일 `pg_dump` 한다. **저장소가 공개라 GitHub Actions 아티팩트에 두지 않고**, rt 서버의 systemd 타이머로 서버 디스크에 둔다.

- 시각: 매일 03:30(서울) 전후 15분 안. 서버가 꺼져 있어 놓치면 켜질 때 한 번 한다.
- 파일: `/var/backups/jigsaw/jigsaw-<UTC 시각>.dump` (pg_dump custom 형식, 압축, 600, `jigsaw-rt` 소유). 14일보다 오래된 파일은 실행할 때마다 지운다(백업이 실패해도 지워 처리방침의 보관 기간을 지키되, 가장 최근 파일 하나는 남긴다). 실패하면 서비스가 실패로 끝나므로 `systemctl status jigsaw-backup` 으로 알 수 있다.
- 들어가는 것: `jigsaw` 스키마의 테이블·행·권한(grant)·RLS 설정, `schema_migrations`.
- **들어가지 않는 것**: Storage 의 그림 파일(`jigsaw-images`), `auth.users`·`core.profiles`·다른 앱 스키마, 버킷 설정(`storage.buckets`, 마이그레이션이 만든다). Supabase 자체 백업도 Storage 파일은 담지 않는다. 그림 파일이 지워지면 되살릴 수 없고 교사가 다시 올려야 한다.
- Lightsail 자동 스냅숏(매일, 최근 7개)이 이 백업 파일도 함께 담는다. 서버 밖에 따로 두려면 `scp` 로 받아 안전한 곳에 둔다(선택).

### 설정 (T25, 사용자)

1. 대시보드 → Connect → **Session pooler** 접속 문자열을 쓴다(IPv4. Direct connection 은 IPv6 전용이라 Lightsail 에서 안 될 수 있음).
2. `/etc/jigsaw-backup.env` 에 작은따옴표로 넣는다: `SUPABASE_DB_URL='postgresql://postgres.ozfzpyumnaaggrlevygz:<비밀번호>@<pooler 주소>:5432/postgres?sslmode=require'`
3. `sudo bash /opt/jigsaw/scripts/rt/setup.sh` 를 다시 실행하면 타이머가 켜진다.
4. 바로 한 번 돌려 확인한다.

```bash
sudo systemctl start jigsaw-backup.service
sudo journalctl -u jigsaw-backup -n 20 --no-pager     # "백업 완료: jigsaw-….dump (크기), 보관 n개"
sudo ls -l /var/backups/jigsaw
systemctl list-timers jigsaw-backup.timer
```

- `pg_dump` 는 DB 서버보다 주 버전이 같거나 높아야 한다. 설치하는 클라이언트는 17 이다. SQL 편집기에서 `select version();` 으로 gyosil Postgres 버전을 확인하고, 17 보다 높으면 `setup.sh` 의 `PG_CLIENT_MAJOR` 를 올린다.
- 백업 접속 주소는 rt 서버 프로세스에 넘기지 않으려고 `/etc/jigsaw-rt.env` 와 다른 파일에 둔다.

## 7. 복원

### DB (`jigsaw` 스키마)

`--clean` 은 지금의 `jigsaw` 테이블을 지우고 백업 시점으로 되돌린다. 백업 이후의 수업·그림 기록은 사라진다. 수업 시간 밖에, 꼭 필요할 때만 한다.

```bash
# 1) 서버 멈춤 (메모리의 수업이 복원한 DB 를 덮어쓰지 않게)
sudo systemctl stop jigsaw-rt

# 2) 백업 내용 확인
f=/var/backups/jigsaw/jigsaw-<시각>.dump
sudo pg_restore --list "$f" | grep -E 'TABLE|SCHEMA'

# 3) 복원 (한 트랜잭션: 실패하면 아무것도 바뀌지 않음)
sudo bash -c 'set -a; . /etc/jigsaw-backup.env; set +a; pg_restore --dbname="$SUPABASE_DB_URL" --clean --if-exists --no-owner --single-transaction --exit-on-error '"$f"

# 4) 마이그레이션 기록 확인 (노트북에서: 백업 뒤에 추가된 마이그레이션이 있으면 다시 적용됨)
SUPABASE_DB_URL='…' bash scripts/db/migrate.sh

# 5) 서버 시작: 열린 수업을 복원된 DB 에서 다시 읽는다
sudo systemctl start jigsaw-rt
```

- `teachers_id_fkey` 오류로 실패하면 백업 뒤에 gyosil 계정이 삭제된 교사가 있다는 뜻이다. `pg_restore --list "$f" > list.txt` 에서 `FK CONSTRAINT jigsaw teachers teachers_id_fkey` 줄 앞에 `;` 를 붙여 빼고 `-L list.txt` 로 복원한 뒤, SQL 편집기에서 `delete from jigsaw.teachers where id not in (select id from auth.users);` 와 `alter table jigsaw.teachers add constraint teachers_id_fkey foreign key (id) references auth.users (id) on delete cascade;` 를 실행한다(파괴적 SQL 이므로 실행 전 확인).
- 복원 뒤 그림 행과 파일이 어긋날 수 있다(백업 뒤 올린 파일은 행이 없고, 백업 뒤 지운 그림은 파일이 없다). SQL 편집기에서 확인한다.

```sql
-- 행은 있는데 파일이 없는 그림 (화면에서 깨져 보임 → 교사에게 다시 올려 달라고 하거나 행을 지움)
select i.id, i.teacher_id from jigsaw.images i
where not exists (select 1 from storage.objects o where o.bucket_id = 'jigsaw-images' and o.name = i.path);
-- 파일은 있는데 행이 없는 그림 (지워도 됨: 8번의 Storage 삭제 방법)
select o.name from storage.objects o
where o.bucket_id = 'jigsaw-images' and not exists (select 1 from jigsaw.images i where i.path = o.name);
```

### 서버 (Lightsail 스냅숏)

1. Lightsail 콘솔 → 스냅숏 → 원하는 날짜 → '새 인스턴스 만들기'(서울, 같은 크기).
2. 새 인스턴스에 방화벽 22·80·443 을 연다.
3. 고정 IP `13.124.90.119` 를 옛 인스턴스에서 떼어 새 인스턴스에 붙인다(DNS 는 그대로).
4. SSH 로 들어가 `systemctl status jigsaw-rt caddy`, `curl -s https://rt.gyosil.app/health` 를 확인하고 `sudo bash /opt/jigsaw/scripts/rt/deploy.sh` 로 최신 main 을 받는다.
5. 옛 인스턴스는 확인이 끝난 뒤 멈추고 지운다.

스냅숏은 서버 디스크(코드·설정·비밀값·로그·DB 백업 파일)만 담는다. DB 와 Storage 는 Supabase 에 있으므로 스냅숏 복원으로 되돌아가지 않는다.

## 8. 교사 탈퇴·계정 삭제

탈퇴는 처리방침의 문의 메일로 요청받아 운영자가 처리한다(spec, privacy.html 2번). **함께 퍼즐 데이터(`jigsaw` 스키마의 행)와 Storage `jigsaw-images/<uid>/` 파일만 지운다. `auth.users`·`core.profiles` 는 건드리지 않는다**(gyosil 공용 계정. 계정까지 지워 달라는 요청이면 gyosil 공용 절차로 따로 처리).

### 1) 확인 (Supabase SQL 편집기, 읽기만)

```sql
-- 요청한 메일 주소로 uid 찾기
select id, email from auth.users where email = '<요청 메일 주소>';

-- 함께 퍼즐 교사인지, 지울 것이 얼마나 있는지
select
  (select count(*) from jigsaw.teachers where id = '<uid>') as teacher,
  (select count(*) from jigsaw.images where teacher_id = '<uid>') as images,
  (select count(*) from jigsaw.sessions where teacher_id = '<uid>') as sessions,
  (select count(*) from jigsaw.sessions where teacher_id = '<uid>' and status <> 'ended') as open_sessions,
  (select count(*) from storage.objects where bucket_id = 'jigsaw-images' and name like '<uid>/%') as files;
```

`open_sessions` 가 0 이 아니면 그 수업이 끝날 때까지(늦어도 시작 24시간 뒤 자동 종료) 기다리거나, 수업 시간 밖에 `sudo systemctl stop jigsaw-rt` 로 서버를 멈춘 상태에서 2)를 하고 다시 시작한다. 열린 수업을 메모리에 둔 채 행을 지우면 서버의 저장이 계속 실패한다.

### 2) DB 행 삭제

```sql
-- teachers 한 행만 지우면 images·sessions·groups·members 는 cascade 로 함께 지워진다
delete from jigsaw.teachers where id = '<uid>';
```

행이 지워지면 그 교사 토큰으로는 바로 아무 요청도 할 수 없다(서버가 요청마다 `jigsaw.teachers` 를 확인). 그래서 파일을 지우는 동안 새 그림이 올라오지 않는다.

### 3) Storage 파일 삭제

SQL 로 `storage.objects` 를 지우지 않는다(파일은 남고 Supabase 가 막는다). 둘 중 하나로 지운다.

- 대시보드: Storage → `jigsaw-images` → `<uid>` 폴더 → 파일 모두 선택 → Delete.
- rt 서버에서(service_role 키는 `/etc/jigsaw-rt.env` 에서 읽고 출력하지 않음):

```bash
sudo bash -c 'set -a; . /etc/jigsaw-rt.env; set +a; cd /opt/jigsaw/server && TEACHER_UID=<uid> node --input-type=module' <<'EOF'
import { createClient } from '@supabase/supabase-js';
const uid = process.env.TEACHER_UID;
if (!/^[0-9a-f-]{36}$/.test(uid ?? '')) throw new Error('TEACHER_UID 가 uuid 가 아닙니다.');
const bucket = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
}).storage.from('jigsaw-images');
const { data, error } = await bucket.list(uid, { limit: 1000 });
if (error) throw error;
const paths = data.map((file) => `${uid}/${file.name}`);
if (paths.length > 0) {
  const removed = await bucket.remove(paths);
  if (removed.error) throw removed.error;
}
const left = await bucket.list(uid, { limit: 1000 });
if (left.error) throw left.error;
console.log(`지운 파일 ${paths.length}개, 남은 파일 ${left.data.length}개`);
EOF
```

### 4) 확인과 회신

```sql
select
  (select count(*) from jigsaw.teachers where id = '<uid>') as teacher,
  (select count(*) from storage.objects where bucket_id = 'jigsaw-images' and name like '<uid>/%') as files;
-- 둘 다 0
```

요청한 교사에게 처리 결과를 메일로 알린다. DB 백업 파일에는 최대 14일, 그 백업을 담은 Lightsail 스냅숏(7일)까지 합하면 최대 21일 동안 지운 행이 남았다가 순환으로 사라진다(처리방침 2번과 같음).

### gyosil 계정이 삭제된 경우

`auth.users` 행이 지워지면 `jigsaw.teachers` 와 딸린 행은 cascade 로 함께 지워지지만 **Storage 파일은 남는다.** 주인 없는 파일 폴더를 찾아 3)으로 지운다.

```sql
select split_part(name, '/', 1) as uid, count(*) as files
from storage.objects
where bucket_id = 'jigsaw-images'
  and split_part(name, '/', 1) not in (select id::text from jigsaw.teachers)
group by 1;
```

계정 삭제 때 그 교사의 열린 수업이 있었다면 서버 로그에 저장 실패가 이어진다. 수업 시간 밖에 `sudo systemctl restart jigsaw-rt` 로 정리한다(다시 뜰 때 DB 에 없는 수업은 읽지 않음).

## 9. 보안 메모

- 서버는 `127.0.0.1:3400` 에서만 듣는다. 밖에서는 Caddy(443)로만 들어온다. Lightsail 방화벽은 22·80·443 만 연다.
- 요청 주소: `RT_TRUST_PROXY=1` 이면 서버는 `X-Forwarded-For` 의 첫 주소를 쓴다. 공통 Caddyfile 과 사이트 파일에 `trusted_proxies` 를 넣지 않았으므로 Caddy 는 클라이언트가 보낸 `X-Forwarded-For` 를 버리고 실제 접속 주소로 다시 쓴다(로컬 Caddy 2.11 로 확인). **`trusted_proxies` 를 넣지 않는다.** 넣으면 위조한 주소로 주소별 제한을 피할 수 있다.
- 허용 Origin 은 `https://jigsaw.gyosil.app` 하나다. 다른 Origin 의 API·소켓 요청은 403.
- 서비스는 `jigsaw-rt` 사용자로 돌고 파일 시스템은 읽기만 한다(`ProtectSystem=strict` 등).

## 10. T25 에서 확인할 것

- [ ] `setup.sh` 1회차 종료 코드 3 과 `/etc/jigsaw-rt.env` 권한 `600 root:root` (`stat -c '%a %U:%G' /etc/jigsaw-rt.env`).
- [ ] 2회차 뒤 `systemctl is-enabled jigsaw-rt caddy`, `curl -s https://rt.gyosil.app/health`.
- [ ] `sudo systemd-analyze verify /etc/systemd/system/jigsaw-rt.service` 경고 없음.
- [ ] **XFF 덮어쓰기**: 노트북에서 위조 헤더로 요청해도 주소별 제한이 실제 주소로 걸리는지. 예: `for i in $(seq 1 65); do curl -s -o /dev/null -w '%{http_code} ' -H 'Origin: https://jigsaw.gyosil.app' -H 'Content-Type: application/json' -H "X-Forwarded-For: 10.0.0.$i" -d '{"code":"000000","name":"t"}' https://rt.gyosil.app/api/join; done` → 처음 61번은 `404`(틀린 코드)이고, 위조 주소가 매번 달라도 62번째부터 `429` 가 나와야 한다. 그 주소는 30초 동안 입장이 막히므로 수업 시간 밖에 한다.
- [ ] 다른 Origin 거부: `curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Origin: https://evil.example' -H 'Content-Type: application/json' -d '{}' https://rt.gyosil.app/api/join` → `403`.
- [ ] 시험 훅 없음: `curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Origin: https://jigsaw.gyosil.app' https://rt.gyosil.app/api/test/clock` → `404`.
- [ ] `sudo systemctl kill jigsaw-rt` 뒤 자동 재시작·수업 복구(D17).
- [ ] journald 설정(5번 명령)과 `/var/log/syslog` 에 jigsaw-rt 가 더 쌓이지 않는지. Caddy 로그(`journalctl -u caddy`)에 접속자 주소가 남지 않는지.
- [ ] 스왑 1GB(`swapon --show`), `/etc/fstab`.
- [ ] 백업: `select version();` 로 pg_dump 17 이 맞는지, 6번 설정 후 수동 실행 한 번, 파일 권한 600.
- [ ] Lightsail 자동 스냅숏 켜짐.

## 11. 시범 수업 점검표

수업 전
- [ ] `curl -s https://rt.gyosil.app/health` 응답, `sessions` 확인.
- [ ] 학교 기기·학교망에서 `https://jigsaw.gyosil.app` 과 `https://rt.gyosil.app/health` 가 열리는지(MDM·유해 사이트 차단이 새 도메인을 막지 않는지). 막히면 학교 MDM 담당자에게 두 도메인 허용(분류: 교육용 수업 도구)을 요청한다.

수업 중
- [ ] **학교망 WebSocket**: 교사 PC 브라우저 개발자 도구 → Network → `socket.io` 요청. `transport=websocket` 연결(상태 101)이 유지되면 WebSocket, `transport=polling` 요청만 계속 반복되면 롱폴링으로 대체된 것이다. 롱폴링이어도 동작해야 하며, 반응이 늦은지 적어 둔다.
- [ ] 끊김 띠("다시 연결하는 중")가 자주 보이는지, 조각 이동이 늦게 보이는지.
- [ ] **서버 메모리 실측**: 수업 전·중·후에 `systemctl show jigsaw-rt -p MemoryCurrent -p MemoryPeak`, `free -h`, `swapon --show` 를 기록한다(동시 수업 수·학생 수와 함께). `MemoryPeak` 가 400MB 를 넘거나 스왑을 계속 쓰면 인스턴스 크기를 다시 본다.

수업 뒤
- [ ] `sudo journalctl -u jigsaw-rt --since '2 hours ago' | grep -E '실패|error'` 로 오류 확인.
- [ ] 학생 이름이 로그에 없는지(`grep` 으로 시범 수업에서 쓴 이름 몇 개 검색).

## 12. 새 앱 추가

rt 서버(`13.124.90.119`)는 여러 앱이 함께 쓴다. 서버 공통 설정은 이 저장소의 `scripts/rt/setup.sh` 가 관리하고, 앱마다 아래 규칙으로 **자기 파일만** 둔다. 이 장은 규칙과 순서다. 다른 앱의 실제 설치 스크립트·문서는 그 앱 저장소에 둔다(`setup.sh` 의 '앱: jigsaw' 부분을 본뜬다).

### 서버 공통 (모든 앱이 함께 씀)

| 항목 | 위치 | 누가 바꾸나 |
|---|---|---|
| Caddy 전역 설정 | `/etc/caddy/Caddyfile` (원본 `scripts/rt/caddy/Caddyfile`): 로그 필터와 `import /etc/caddy/sites/*.caddy` 만 | 이 저장소에서 고치고 `setup.sh` 로 반영. 다른 앱은 고치지 않는다 |
| Caddy 사이트 | `/etc/caddy/sites/<앱>.caddy` | 앱마다 자기 파일 하나. `setup.sh` 는 `jigsaw.caddy` 만 쓰고 다른 파일은 읽기만 한다 |
| 로그 보관 | journald 14일 `/etc/systemd/journald.conf.d/zz-retention.conf` | 서버 전체(모든 앱)에 적용 |
| 스왑 | `/swapfile` 1GB | — |
| 방화벽 | Lightsail 22·80·443 | 앱 포트는 열지 않는다(Caddy 로만 들어옴) |

### 앱 규칙 (`<앱>` 은 소문자 이름)

| 항목 | 규칙 | jigsaw |
|---|---|---|
| 코드 | `/opt/<앱>` (root 소유, 서비스 사용자는 읽기만) | `/opt/jigsaw` |
| 실행 사용자 | `<앱>-rt` (시스템 사용자, 로그인 셸 없음) | `jigsaw-rt` |
| 비밀값 | `/etc/<앱>-rt.env` (root:root, 600) | `/etc/jigsaw-rt.env` |
| 서비스 | `<앱>-rt.service` (`Restart=always`, `jigsaw-rt.service` 와 같은 보호 설정, Node 힙 상한 `--max-old-space-size`) | `jigsaw-rt.service` |
| 듣는 주소 | `127.0.0.1:<포트>` 전용 (아래 할당표) | `127.0.0.1:3400` |
| Caddy 사이트 | `/etc/caddy/sites/<앱>.caddy` (틀: `scripts/rt/caddy/sites/_template.caddy.example`) | `jigsaw.caddy` |
| 백업 | `/var/backups/<앱>` (700, 파일 600). 접속 정보가 필요하면 `/etc/<앱>-backup.env` (root, 600) | `/var/backups/jigsaw` |
| 로그 | journald, `SyslogIdentifier=<앱>-rt` | `jigsaw-rt` |

### 포트 할당표

| 포트 | 앱 | 주소 |
|---|---|---|
| 3400 | jigsaw | `rt.gyosil.app` |
| 3500 | (다음 앱) | |
| 3600 | (그다음 앱) | |

- 100 단위로 띄워 쓴다. 새 앱은 **먼저 이 표에 적어 커밋한** 뒤 쓴다.
- 서버에서 확인: `sudo ss -ltnp | grep 127.0.0.1` (같은 포트가 이미 쓰이면 서비스가 시작하지 못한다).

### DNS

- `gyosil.app` 아래 주소(예: `<이름>.gyosil.app`): `gyosil.app` 의 DNS 는 Vercel 이 맡는다. Vercel 대시보드의 `gyosil.app` 도메인 DNS 레코드에 A 레코드 `<이름>` → `13.124.90.119` 를 더한다. `jigsaw.gyosil.app`(화면, Vercel) 같은 기존 레코드는 건드리지 않는다.
- 다른 도메인: 그 도메인을 관리하는 DNS 에서 A 레코드 → `13.124.90.119`.
- A 레코드가 퍼진 뒤(`dig +short <주소>` 가 고정 IP) 사이트 파일을 넣어야 Caddy 가 인증서를 바로 받는다. 먼저 넣어도 Caddy 가 다시 시도하지만 그동안 오류 로그가 쌓인다.

### 로그 정책 (모든 앱)

- 사이트 파일에 `log` 지시어를 넣지 않는다(접근 로그 없음). `trusted_proxies` 도 넣지 않는다(위조한 `X-Forwarded-For` 로 주소별 제한을 피할 수 있게 됨).
- 공통 Caddyfile 의 로그 필터가 모든 사이트의 오류·tls·admin.api 로그에서 접속자 주소·포트·요청 헤더를 지운다. 앱이 필터를 바꾸거나 끄지 않는다.
- 앱 로그(journald)에 IP·사람 이름(학생·사용자)·토큰을 남기지 않는다. journald 는 서버 전체가 14일 보관이므로, 새 앱의 처리방침에도 서버 로그 보관 기간(14일, 스냅숏 포함 최대 21일)을 같게 적는다.

### 메모리 (1GB 기준)

- 지금 1GB 에 jigsaw(Node 힙 상한 512MB)·Caddy·시스템과 스왑 1GB 가 있다. 여유가 작아 **두 번째 Node 앱을 상시로 띄우려면 먼저 2GB 로 올리는 것을 기본으로 한다.**
- 아주 작은 앱(힙 상한 128MB 이하)을 1GB 에 더했다면, 아래 중 하나라도 보이면 2GB 로 올린다.
  - 수업 중 `systemctl show jigsaw-rt -p MemoryPeak` 가 400MB 를 넘는다(11장 점검표와 같은 기준).
  - `free -h` 의 스왑 사용이 수업 밖에도 줄지 않거나, `swapon --show` 의 USED 가 계속 늘어난다.
  - `sudo journalctl -k | grep -i 'out of memory'` 에 OOM 기록이 있다.
- 올리는 방법(Lightsail): 스냅숏에서 더 큰 인스턴스를 만들고 고정 IP `13.124.90.119` 를 새 인스턴스로 옮긴다(DNS 는 그대로). 수업 시간 밖에 한다.

### 순서

1. 포트 할당표에 포트를 정해 적는다.
2. DNS A 레코드를 만든다.
3. 그 앱의 설치 스크립트로 `/opt/<앱>`·사용자·`/etc/<앱>-rt.env`·`<앱>-rt.service` 를 갖추고 `curl -s http://127.0.0.1:<포트>/...` 로 응답을 확인한다.
4. 사이트 파일을 넣고 검사 후 다시 읽는다. reload 는 수업 중에도 된다(jigsaw 의 열린 연결은 최대 5분 뒤 한 번 자동 재연결, 2장 참고). 새 앱 사이트 파일에도 틀처럼 `stream_close_delay 5m` 를 둔다.

```bash
sudo install -m 644 /opt/jigsaw/scripts/rt/caddy/sites/_template.caddy.example /etc/caddy/sites/<앱>.caddy
sudo nano /etc/caddy/sites/<앱>.caddy          # 주소와 포트를 바꾼다
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy                    # 재시작 아님
curl -s localhost:2019/config/apps/http/servers | grep -o '"host":\[[^]]*\]'   # 새 주소와 rt.gyosil.app
```

5. `https://<주소>` 응답, `sudo journalctl -u caddy --since '10 min ago'` 에 인증서 발급 기록이 있고 접속자 주소가 없는지 확인한다.
6. 메모리를 위 기준으로 확인한다.

앱을 뺄 때는 그 앱의 사이트 파일을 지우고 검사·reload 한 뒤 서비스를 멈추고 끈다(`systemctl disable --now <앱>-rt`). 포트 할당표에서 지운다.

## 13. 여러 앱 구조로 옮기기 (기존 운영 서버, 한 번)

T25 에 설치한 서버는 `/etc/caddy/Caddyfile` 안에 `rt.gyosil.app` 사이트 블록이 있고 journald 설정 이름이 `zz-jigsaw.conf` 다. `setup.sh` 를 한 번 실행하면 12장 구조로 바뀐다. jigsaw 서비스·주소·동작은 그대로다.

- `/etc/caddy/Caddyfile` 이 저장소의 이전 버전(`bebaaed` sha256 `86556c87…`, `a1e97e9` sha256 `5be54175…`)과 똑같을 때만 옵션 없이 바꾼다. 손으로 고친 파일이면 덮지 않고 알린다(아래 3).
- `sites/jigsaw.caddy` 와 공통 Caddyfile 을 함께 바꾸고 `caddy validate` 를 통과해야 한 번 reload 한다. 실패하면 두 파일을 되돌리고 멈춘다.
- `jigsaw-rt.service` 유닛이 같으므로 `setup.sh` 는 jigsaw 서버를 다시 시작하지 않는다(1)의 `deploy.sh` 는 평소처럼 한 번 다시 시작한다). 이전 Caddyfile 에는 `stream_close_delay` 가 없어서 이번 reload 때는 열린 WebSocket 이 바로 한 번 끊겼다 다시 붙는다(그다음 reload 부터는 5분 유예). **수업 시간 밖에** 한다.

```bash
# 0) 지금 상태
sudo sha256sum /etc/caddy/Caddyfile            # 86556c87… 또는 5be54175… 이면 자동으로 옮긴다
ls /etc/caddy /etc/systemd/journald.conf.d

# 1) 최신 main 받기 (수업 시간 밖에)
sudo bash /opt/jigsaw/scripts/rt/deploy.sh

# 2) 구조 옮기기 (옵션 없이)
sudo bash /opt/jigsaw/scripts/rt/setup.sh
```

2) 의 출력에 아래가 보여야 한다.

- journald: `설치: /etc/systemd/journald.conf.d/zz-retention.conf`, `이전 파일 보관: …/zz-jigsaw.conf.bak-<시각>`, `journald 다시 시작`
- Caddy: `설치: /etc/caddy/sites/jigsaw.caddy`, `이전 구조(jigsaw 사이트 블록이 들어 있는 Caddyfile)를 공통 Caddyfile 로 바꿉니다.`, `기존 파일 보관: /etc/caddy/Caddyfile.bak-<시각>`, `검사 통과`, `caddy 설정 다시 읽음 (재시작 아님)`

3) Caddyfile 이 `덮어쓰지 않았습니다` 로 나오면 서버에서 손으로 고친 것이다. `diff /etc/caddy/Caddyfile /opt/jigsaw/scripts/rt/caddy/Caddyfile` 로 차이를 보고, 고친 내용이 `sites/` 의 파일로 옮겨져야 하는 것인지 확인한 뒤 `sudo bash /opt/jigsaw/scripts/rt/setup.sh --replace-caddyfile` 로 바꾼다.

4) 확인

```bash
tail -n 1 /etc/caddy/Caddyfile                 # import /etc/caddy/sites/*.caddy
ls -l /etc/caddy/sites                         # jigsaw.caddy
curl -s localhost:2019/config/apps/http/servers | grep -o '"host":\[[^]]*\]'   # ["rt.gyosil.app"]
curl -s https://rt.gyosil.app/health
ls /etc/systemd/journald.conf.d                # zz-retention.conf, zz-jigsaw.conf.bak-<시각>
systemd-analyze cat-config systemd/journald.conf | grep -E '^(MaxRetentionSec|MaxFileSec|ForwardToSyslog)='   # ForwardToSyslog=no 가 마지막
sudo bash /opt/jigsaw/scripts/rt/setup.sh      # 다시 실행: 모두 '변경 없음', 새 .bak 없음, reload 없음
```

- 옮긴 직후 `journalctl -u caddy` 에 `"uri":"/load","remote_ip":"127.0.0.1"` 한 줄이 있을 수 있다. reload 요청 자체를 이전 설정(admin.api 필터가 없던 `bebaaed` 버전)이 기록한 것으로, 서버 자신의 주소이고 접속자 주소가 아니다. 그 뒤 기록에는 주소가 없다.
- `.bak` 파일은 확인이 끝나고 1주쯤 뒤 지워도 된다. `zz-jigsaw.conf.bak-<시각>` 은 이름이 `.conf` 로 끝나지 않아 journald 가 읽지 않는다.

5) 되돌리기 (문제가 있을 때만, 수업 시간 밖에)

```bash
sudo cp -p /etc/caddy/Caddyfile.bak-<시각> /etc/caddy/Caddyfile
sudo rm /etc/caddy/sites/jigsaw.caddy
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && sudo systemctl reload caddy
sudo mv /etc/systemd/journald.conf.d/zz-jigsaw.conf.bak-<시각> /etc/systemd/journald.conf.d/zz-jigsaw.conf
sudo rm /etc/systemd/journald.conf.d/zz-retention.conf
sudo systemctl restart systemd-journald
```

되돌린 상태에서 새 `setup.sh` 를 다시 실행하면 다시 옮긴다. 원인을 고치기 전까지는 `setup.sh` 를 실행하지 않는다.
