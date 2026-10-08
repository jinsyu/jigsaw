#!/usr/bin/env bash
# Sets up the rt server (Lightsail, Ubuntu 24.04) and the jigsaw app on it (rt.gyosil.app). Safe
# to run again: every step checks first and skips what is already in place. See docs/ops.md.
#
#   sudo bash setup.sh [--skip-systemd] [--skip-caddy] [--replace-caddyfile]
#
# The server is shared by several apps (docs/ops.md '새 앱 추가'), so the steps come in parts:
# - Server (shared): apt basics, swap 1 GB, journald 14 days (zz-retention.conf), Caddy with the
#   folder /etc/caddy/sites. The shared files come from this repository, so it is fetched first.
# - App (jigsaw): Node 24 (NodeSource), pnpm (corepack), PostgreSQL client (backups), user
#   jigsaw-rt, repository in /opt/jigsaw, server dependencies, /etc/jigsaw-rt.env, backup timer,
#   jigsaw-rt.service.
# - Caddy configuration, last and in one go: the shared /etc/caddy/Caddyfile (global options and
#   `import /etc/caddy/sites/*.caddy`) and the app's /etc/caddy/sites/jigsaw.caddy. Checked with
#   `caddy validate` (on failure both are put back as they were), then `systemctl reload caddy`.
#   Other files in /etc/caddy/sites belong to other apps and are never touched.
# - /etc/jigsaw-rt.env missing or with empty secrets: a template (mode 600) is written or the
#   empty names are listed, and the script stops there. Fill it in and run the script again.
# - /etc/caddy/Caddyfile different from scripts/rt/caddy/Caddyfile: left as it is and reported,
#   unless --replace-caddyfile or it is one of the earlier jigsaw-only Caddyfiles (with the
#   jigsaw site block inside), which are replaced. The old file is kept as Caddyfile.bak-<time>.
# - The earlier journald drop-in zz-jigsaw.conf is renamed to zz-jigsaw.conf.bak-<time>.
# - The service is restarted only when its unit changed or it is not running; deploys use
#   scripts/rt/deploy.sh.
# --skip-systemd: no swap, journald, units, service or caddy reload (containers without systemd).
# --skip-caddy: Caddy is neither installed nor configured.
set -euo pipefail
umask 022

APP_DIR=/opt/jigsaw
REPO_URL=https://github.com/jinsyu/jigsaw.git
REPO_BRANCH=main
SERVICE_USER=jigsaw-rt
ENV_FILE=/etc/jigsaw-rt.env
BACKUP_ENV_FILE=/etc/jigsaw-backup.env
BACKUP_DIR=/var/backups/jigsaw
NODE_MAJOR=24
PNPM_VERSION=10.11.0
PG_CLIENT_MAJOR=17
SWAP_FILE=/swapfile
HEALTH_URL=http://127.0.0.1:3400/health
REQUIRED_KEYS=(SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY SUPABASE_ANON_KEY SESSION_SECRET GOOGLE_CLIENT_ID ALLOWED_ORIGINS)
JOURNALD_DIR=/etc/systemd/journald.conf.d
JOURNALD_FILE=$JOURNALD_DIR/zz-retention.conf
OLD_JOURNALD_FILE=$JOURNALD_DIR/zz-jigsaw.conf
CADDYFILE=/etc/caddy/Caddyfile
CADDY_SITES_DIR=/etc/caddy/sites
APP_SITE_FILE=$CADDY_SITES_DIR/jigsaw.caddy
# sha256 of the earlier /etc/caddy/Caddyfile versions that held the jigsaw site block themselves
# (scripts/rt/Caddyfile at commits bebaaed and a1e97e9). Only these are replaced without asking.
OLD_JIGSAW_CADDYFILES=(
  86556c875afbec46b22213a4912978f4e02e687d4ec56885fbe72711d6e2c37d
  5be54175dba8b58cfe058b7aac90b5237804452921761d78b3c66edcdbf414ec
)

skip_systemd=0
skip_caddy=0
replace_caddyfile=0
for arg in "$@"; do
  case "$arg" in
    --skip-systemd) skip_systemd=1 ;;
    --skip-caddy) skip_caddy=1 ;;
    --replace-caddyfile) replace_caddyfile=1 ;;
    *)
      echo "모르는 옵션: $arg" >&2
      exit 2
      ;;
  esac
done

part() { printf '\n######## %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
fail() {
  printf '중단: %s\n' "$*" >&2
  exit 1
}

export DEBIAN_FRONTEND=noninteractive
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
apt_updated=0
apt_install() {
  local missing=()
  local pkg
  for pkg in "$@"; do
    dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q 'install ok installed' || missing+=("$pkg")
  done
  if ((${#missing[@]} == 0)); then
    note "설치되어 있음: $*"
    return 0
  fi
  if ((apt_updated == 0)); then
    apt-get update -qq
    apt_updated=1
  fi
  note "설치: ${missing[*]}"
  apt-get install -y -qq --no-install-recommends "${missing[@]}" >/dev/null
}

# Copies src to dst with the mode when the content differs. Returns 0 when it changed.
install_if_changed() {
  local src="$1" dst="$2" mode="$3"
  if [[ -f "$dst" ]] && cmp -s "$src" "$dst"; then
    note "변경 없음: $dst"
    return 1
  fi
  install -m "$mode" -o root -g root "$src" "$dst"
  note "설치: $dst"
  return 0
}

# Value of KEY in an env file, without surrounding quotes (never printed).
env_value() {
  local file="$1" key="$2" value
  value="$(grep -E "^${key}=" "$file" | tail -n 1 | cut -d= -f2-)" || true
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  printf '%s' "$value"
}

stamp() { date +%Y%m%d%H%M%S; }

# ---------------------------------------------------------------------------------------------
step "확인"
[[ "$(id -u)" == 0 ]] || fail "root 로 실행하세요: sudo bash $0"
# shellcheck source=/dev/null
. /etc/os-release
if [[ "${ID:-}" != ubuntu || "${VERSION_ID:-}" != 24.04 ]]; then
  note "주의: Ubuntu 24.04 용 스크립트입니다 (지금: ${PRETTY_NAME:-알 수 없음})."
fi

# ---------------------------------------------------------------------------------------------
part "서버 공통"

step "기본 패키지"
apt_install ca-certificates curl gnupg git

step "저장소 $APP_DIR (공통 설정 파일의 원본이기도 함)"
if [[ -d "$APP_DIR/.git" ]]; then
  note "있음: $(git -C "$APP_DIR" log -1 --format='%h %s') (새 커밋은 deploy.sh 가 받습니다)"
elif [[ -e "$APP_DIR" ]]; then
  fail "$APP_DIR 가 있지만 git 저장소가 아닙니다. 옮기거나 지운 뒤 다시 실행하세요."
else
  git clone --quiet --branch "$REPO_BRANCH" "$REPO_URL" "$APP_DIR"
  note "받음: $(git -C "$APP_DIR" log -1 --format='%h %s')"
fi

if ((skip_systemd)); then
  step "스왑·journald 건너뜀 (--skip-systemd)"
else
  step "스왑 1GB"
  if swapon --show=NAME --noheadings | grep -q .; then
    note "켜져 있음: $(swapon --show=NAME,SIZE --noheadings | tr -s ' ' | paste -sd, -)"
  else
    if [[ ! -f "$SWAP_FILE" ]]; then
      fallocate -l 1G "$SWAP_FILE"
      chmod 600 "$SWAP_FILE"
      mkswap "$SWAP_FILE" >/dev/null
    fi
    swapon "$SWAP_FILE"
    note "켬: $SWAP_FILE"
  fi
  if [[ -f "$SWAP_FILE" ]] && ! grep -qE "^${SWAP_FILE}[[:space:]]" /etc/fstab; then
    echo "$SWAP_FILE none swap sw 0 0" >>/etc/fstab
    note "/etc/fstab 에 추가 (재부팅 뒤에도 켜짐)"
  fi

  step "journald 보관 14일 (서버 전체)"
  install -d -m 755 "$JOURNALD_DIR"
  journald_changed=0
  if install_if_changed "$APP_DIR/scripts/rt/journald-retention.conf" "$JOURNALD_FILE" 644; then journald_changed=1; fi
  if [[ -f "$OLD_JOURNALD_FILE" ]]; then
    # Same settings under the earlier app-specific name; a name not ending in .conf is not read.
    old_backup="$OLD_JOURNALD_FILE.bak-$(stamp)"
    mv "$OLD_JOURNALD_FILE" "$old_backup"
    journald_changed=1
    note "이전 파일 보관: $old_backup"
  fi
  if ((journald_changed)); then
    systemctl restart systemd-journald
    note "journald 다시 시작"
  fi
fi

if ((skip_caddy)); then
  step "Caddy 건너뜀 (--skip-caddy)"
else
  step "Caddy 설치, 사이트 폴더 $CADDY_SITES_DIR"
  if command -v caddy >/dev/null; then
    note "설치되어 있음: $(caddy version | cut -d' ' -f1)"
  else
    note "공식 저장소(dl.cloudsmith.io/public/caddy/stable)로 설치"
    apt_install debian-keyring debian-archive-keyring apt-transport-https
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key |
      gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt >/etc/apt/sources.list.d/caddy-stable.list
    apt_updated=0
    apt_install caddy
  fi
  install -d -m 755 -o root -g root "$CADDY_SITES_DIR"
  note "사이트 파일 $(find "$CADDY_SITES_DIR" -maxdepth 1 -type f -name '*.caddy' | wc -l | tr -d ' ')개 (설정은 마지막 단계에서)"
fi

# ---------------------------------------------------------------------------------------------
part "앱: jigsaw"

step "Node.js $NODE_MAJOR"
# jigsaw-rt.service starts /usr/bin/node, so that is the node that has to be version 24.
node_major="$(/usr/bin/node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo none)"
if [[ "$node_major" == "$NODE_MAJOR" ]]; then
  note "설치되어 있음: /usr/bin/node $(/usr/bin/node -v)"
else
  note "지금 node: $node_major → NodeSource node_${NODE_MAJOR}.x 저장소로 설치"
  install -d -m 755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key |
    gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    >/etc/apt/sources.list.d/nodesource.list
  # Ubuntu's own nodejs package must never win over NodeSource.
  printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' >/etc/apt/preferences.d/nodejs
  apt-get update -qq
  apt_updated=1
  apt-get install -y -qq nodejs >/dev/null
  node_major="$(/usr/bin/node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo none)"
  [[ "$node_major" == "$NODE_MAJOR" ]] || fail "/usr/bin/node $NODE_MAJOR 설치를 확인하지 못했습니다 (지금: $node_major)."
  note "설치함: /usr/bin/node $(/usr/bin/node -v)"
fi

step "pnpm $PNPM_VERSION (corepack)"
command -v corepack >/dev/null || fail "corepack 이 없습니다 (Node $NODE_MAJOR 에 들어 있어야 합니다)."
pnpm() { corepack "pnpm@$PNPM_VERSION" "$@"; }
note "pnpm $(pnpm --version)"

step "PostgreSQL $PG_CLIENT_MAJOR 클라이언트 (백업용 pg_dump)"
if [[ -x "/usr/lib/postgresql/$PG_CLIENT_MAJOR/bin/pg_dump" ]]; then
  note "설치되어 있음: $("/usr/lib/postgresql/$PG_CLIENT_MAJOR/bin/pg_dump" --version)"
else
  apt_install postgresql-common
  if [[ ! -f /etc/apt/sources.list.d/pgdg.list && ! -f /etc/apt/sources.list.d/pgdg.sources ]]; then
    note "PostgreSQL 공식 저장소(apt.postgresql.org) 추가"
    /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y >/dev/null
    apt_updated=0
  fi
  apt_install "postgresql-client-$PG_CLIENT_MAJOR"
fi

step "사용자 $SERVICE_USER"
if id "$SERVICE_USER" >/dev/null 2>&1; then
  note "있음"
else
  useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$SERVICE_USER"
  note "만듦"
fi

step "서버 의존성 (server/, 운영 의존성만)"
(cd "$APP_DIR/server" && pnpm install --prod --frozen-lockfile --reporter=silent)
note "설치함"

step "비밀값 파일 $ENV_FILE"
set_default() {
  local key="$1" value="$2"
  sed -i "s|^${key}=\$|${key}=${value}|" "$ENV_FILE.new"
}
if [[ ! -f "$ENV_FILE" ]]; then
  install -m 600 -o root -g root "$APP_DIR/server/.env.example" "$ENV_FILE.new"
  set_default NODE_ENV 'production'
  set_default HOST '127.0.0.1'
  set_default PORT '3400'
  set_default RT_TRUST_PROXY '1'
  set_default ALLOWED_ORIGINS 'https://jigsaw.gyosil.app'
  set_default SUPABASE_URL 'https://ozfzpyumnaaggrlevygz.supabase.co'
  mv "$ENV_FILE.new" "$ENV_FILE"
  note "틀을 만들었습니다 (root, 600)."
fi
chown root:root "$ENV_FILE"
chmod 600 "$ENV_FILE"
empty=()
for key in "${REQUIRED_KEYS[@]}"; do
  [[ -n "$(env_value "$ENV_FILE" "$key")" ]] || empty+=("$key")
done
if [[ "$(env_value "$ENV_FILE" NODE_ENV)" != production ]]; then
  empty+=("NODE_ENV(production 이어야 함)")
fi
if ((${#empty[@]} > 0)); then
  note "비어 있는 값: ${empty[*]}"
  note "sudo nano $ENV_FILE 로 값을 넣은 뒤 이 스크립트를 다시 실행하세요 (docs/ops.md '비밀값')."
  exit 3
fi
note "필수 값이 모두 있습니다 (값은 출력하지 않음)."

if ((skip_systemd)); then
  step "systemd 단계 건너뜀 (--skip-systemd): 백업 타이머, jigsaw-rt.service"
else
  step "DB 백업 타이머"
  install -d -m 700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$BACKUP_DIR"
  if [[ ! -f "$BACKUP_ENV_FILE" ]]; then
    printf '%s\n' \
      '# Database URL for scripts/db/backup.sh (docs/ops.md). Session pooler string, in single quotes.' \
      "SUPABASE_DB_URL=" >"$BACKUP_ENV_FILE.new"
    install -m 600 -o root -g root "$BACKUP_ENV_FILE.new" "$BACKUP_ENV_FILE"
    rm -f "$BACKUP_ENV_FILE.new"
    note "틀을 만들었습니다: $BACKUP_ENV_FILE (root, 600)"
  fi
  chown root:root "$BACKUP_ENV_FILE"
  chmod 600 "$BACKUP_ENV_FILE"
  units_changed=0
  for unit in jigsaw-backup.service jigsaw-backup.timer; do
    if install_if_changed "$APP_DIR/scripts/rt/$unit" "/etc/systemd/system/$unit" 644; then units_changed=1; fi
  done
  if ((units_changed)); then systemctl daemon-reload; fi
  if [[ -n "$(env_value "$BACKUP_ENV_FILE" SUPABASE_DB_URL)" ]]; then
    systemctl enable --now jigsaw-backup.timer >/dev/null 2>&1
    note "타이머 켜짐: $(systemctl show jigsaw-backup.timer -p NextElapseUSecRealtime --value)"
  else
    note "SUPABASE_DB_URL 이 비어 있어 타이머를 켜지 않았습니다. 값을 넣고 다시 실행하세요."
  fi

  step "jigsaw-rt.service"
  unit_changed=0
  if install_if_changed "$APP_DIR/scripts/rt/jigsaw-rt.service" /etc/systemd/system/jigsaw-rt.service 644; then
    unit_changed=1
    systemctl daemon-reload
  fi
  systemctl enable jigsaw-rt.service >/dev/null 2>&1
  if ((unit_changed)) || ! systemctl is-active --quiet jigsaw-rt.service; then
    systemctl restart jigsaw-rt.service
    note "시작함"
  else
    note "실행 중이라 다시 시작하지 않았습니다 (배포는 deploy.sh)."
  fi
  healthy=0
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
      healthy=1
      break
    fi
    sleep 1
  done
  if ((healthy)); then
    note "/health: $(curl -fsS --max-time 2 "$HEALTH_URL")"
  else
    note "30초 안에 /health 응답이 없습니다. 로그: sudo journalctl -u jigsaw-rt -n 50 --no-pager"
    exit 1
  fi
fi

# ---------------------------------------------------------------------------------------------
# The shared Caddyfile and the app's site file change together and Caddy reads them once, so a
# server moving from the jigsaw-only Caddyfile never runs without the rt.gyosil.app site.
if ((!skip_caddy)); then
  part "Caddy 설정: 공통 $CADDYFILE + 앱 $APP_SITE_FILE"
  caddy_previous="$(mktemp -d)"
  trap 'rm -rf "$caddy_previous"' EXIT
  caddyfile_backup=""
  site_changed=0
  caddyfile_changed=0

  step "앱 사이트 파일 $APP_SITE_FILE"
  if [[ -f "$APP_SITE_FILE" ]]; then cp -p "$APP_SITE_FILE" "$caddy_previous/site"; fi
  if install_if_changed "$APP_DIR/scripts/rt/caddy/sites/jigsaw.caddy" "$APP_SITE_FILE" 644; then site_changed=1; fi

  step "공통 Caddyfile $CADDYFILE"
  wanted="$APP_DIR/scripts/rt/caddy/Caddyfile"
  current_hash=""
  if [[ -f "$CADDYFILE" ]]; then current_hash="$(sha256sum "$CADDYFILE" | cut -d' ' -f1)"; fi
  old_jigsaw=0
  for hash in "${OLD_JIGSAW_CADDYFILES[@]}"; do
    if [[ "$current_hash" == "$hash" ]]; then old_jigsaw=1; fi
  done
  if [[ -f "$CADDYFILE" ]] && cmp -s "$wanted" "$CADDYFILE"; then
    note "변경 없음: $CADDYFILE"
  elif [[ ! -f "$CADDYFILE" ]] || ((replace_caddyfile || old_jigsaw)); then
    if ((old_jigsaw)); then
      note "이전 구조(jigsaw 사이트 블록이 들어 있는 Caddyfile)를 공통 Caddyfile 로 바꿉니다."
    fi
    if [[ -f "$CADDYFILE" ]]; then
      caddyfile_backup="$CADDYFILE.bak-$(stamp)"
      cp -p "$CADDYFILE" "$caddyfile_backup"
      note "기존 파일 보관: $caddyfile_backup"
    fi
    install -m 644 -o root -g root "$wanted" "$CADDYFILE"
    caddyfile_changed=1
    note "설치: $CADDYFILE"
  else
    note "기존 $CADDYFILE 이 저장소의 scripts/rt/caddy/Caddyfile 과 다릅니다. 덮어쓰지 않았습니다."
    note "차이: diff $CADDYFILE $wanted"
    note "바꾸려면: sudo bash $0 --replace-caddyfile (기존 파일은 .bak 으로 보관)"
    if ! grep -qE "^[[:space:]]*import[[:space:]]+$CADDY_SITES_DIR/\*\.caddy[[:space:]]*$" "$CADDYFILE"; then
      note "주의: 지금 Caddyfile 은 $CADDY_SITES_DIR/*.caddy 를 읽지 않아 사이트 파일($APP_SITE_FILE)이 적용되지 않습니다."
    fi
  fi

  if ((site_changed || caddyfile_changed)); then
    step "caddy validate, reload"
    if ! validate_output="$(caddy validate --config "$CADDYFILE" --adapter caddyfile 2>&1)"; then
      printf '%s\n' "$validate_output" | tail -n 5 >&2
      if ((caddyfile_changed)) && [[ -n "$caddyfile_backup" ]]; then cp -p "$caddyfile_backup" "$CADDYFILE"; fi
      if ((caddyfile_changed)) && [[ -z "$caddyfile_backup" ]]; then rm -f "$CADDYFILE"; fi
      if ((site_changed)) && [[ -f "$caddy_previous/site" ]]; then cp -p "$caddy_previous/site" "$APP_SITE_FILE"; fi
      if ((site_changed)) && [[ ! -f "$caddy_previous/site" ]]; then rm -f "$APP_SITE_FILE"; fi
      fail "caddy validate 실패: 바꾼 Caddy 파일을 되돌렸습니다 (Caddy 는 이전 설정 그대로). 확인: caddy validate --config $CADDYFILE --adapter caddyfile"
    fi
    note "검사 통과 (사이트 파일 $(find "$CADDY_SITES_DIR" -maxdepth 1 -type f -name '*.caddy' | wc -l | tr -d ' ')개)"
    if ((skip_systemd)); then
      note "systemd 없음(--skip-systemd): caddy 를 다시 읽지 않았습니다."
    elif systemctl is-active --quiet caddy; then
      systemctl reload caddy || fail "systemctl reload caddy 실패. 로그: sudo journalctl -u caddy -n 50 --no-pager"
      note "caddy 설정 다시 읽음 (재시작 아님)"
    else
      systemctl enable --now caddy >/dev/null 2>&1 || fail "caddy 시작 실패. 로그: sudo journalctl -u caddy -n 50 --no-pager"
      note "caddy 시작"
    fi
  fi
fi

step "끝"
note "로그: sudo journalctl -u jigsaw-rt -f    배포: sudo bash $APP_DIR/scripts/rt/deploy.sh"
