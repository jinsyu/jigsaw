#!/usr/bin/env bash
# Deploys the latest main to the rt server: git pull --ff-only, server dependencies, restart,
# /health. See docs/ops.md.
#
#   sudo bash /opt/jigsaw/scripts/rt/deploy.sh [--yes] [--no-pull]
#
# - A restart disconnects every class for a few seconds (they reconnect and resume, spec D17),
#   so with open classes the script stops unless --yes.
# - --no-pull: install and restart what is checked out now (used when rolling back).
# - On failure it prints how to go back to the previous commit.
set -euo pipefail
umask 022

APP_DIR=/opt/jigsaw
PNPM_VERSION=10.11.0
HEALTH_URL=http://127.0.0.1:3400/health
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

assume_yes=0
pull=1
for arg in "$@"; do
  case "$arg" in
    --yes) assume_yes=1 ;;
    --no-pull) pull=0 ;;
    *)
      echo "모르는 옵션: $arg" >&2
      exit 2
      ;;
  esac
done

[[ "$(id -u)" == 0 ]] || {
  echo "root 로 실행하세요: sudo bash $0" >&2
  exit 1
}

previous="$(git -C "$APP_DIR" rev-parse HEAD)"

rollback_help() {
  cat >&2 <<EOF

배포 실패. 이전 커밋 ${previous:0:7} 로 되돌리려면:
  sudo git -C $APP_DIR reset --hard $previous
  sudo bash $APP_DIR/scripts/rt/deploy.sh --no-pull --yes
로그: sudo journalctl -u jigsaw-rt -n 100 --no-pager
EOF
}
trap 'rollback_help' ERR

open_sessions="$(curl -fsS --max-time 2 "$HEALTH_URL" 2>/dev/null |
  node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{console.log(JSON.parse(s).sessions)}catch{console.log("?")}})')" || open_sessions="?"
if [[ "$open_sessions" != 0 && "$open_sessions" != "?" ]] && ((!assume_yes)); then
  trap - ERR
  echo "열린 수업이 ${open_sessions}개 있습니다. 다시 시작하면 잠시 끊겼다가 이어집니다." >&2
  echo "수업 시간 밖에 배포하거나, 그래도 하려면 --yes 를 붙이세요." >&2
  exit 4
fi

if ((pull)); then
  echo "== git pull --ff-only (지금 ${previous:0:7})"
  git -C "$APP_DIR" pull --ff-only --quiet
fi
current="$(git -C "$APP_DIR" rev-parse HEAD)"
echo "   배포할 커밋: $(git -C "$APP_DIR" log -1 --format='%h %s')"

echo "== 서버 의존성"
(cd "$APP_DIR/server" && corepack "pnpm@$PNPM_VERSION" install --prod --frozen-lockfile --reporter=silent)

echo "== 다시 시작 (저장을 마칠 때까지 최대 30초)"
systemctl restart jigsaw-rt.service

for _ in $(seq 1 30); do
  if health="$(curl -fsS --max-time 2 "$HEALTH_URL" 2>/dev/null)"; then
    echo "   /health: $health"
    echo "완료: ${previous:0:7} → ${current:0:7}"
    exit 0
  fi
  sleep 1
done
echo "30초 안에 /health 응답이 없습니다." >&2
false
