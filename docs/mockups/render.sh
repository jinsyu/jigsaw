#!/bin/sh
# 목업 HTML(src/*.html)을 PNG로 찍는다. 사용법: sh render.sh [이름...]
cd "$(dirname "$0")"
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
size() {
  case "$1" in
    student-phone) echo 2190,1060 ;;
    student-tablet) echo 1312,1050 ;;
    teacher-create) echo 1536,1060 ;;
    teacher-lobby|teacher-overview) echo 1920,1080 ;;
  esac
}
for n in ${@:-student-phone student-tablet teacher-create teacher-lobby teacher-overview}; do
  "$CH" --headless=new --hide-scrollbars --force-device-scale-factor=1 --window-size="$(size "$n")" \
    --virtual-time-budget=6000 --screenshot="$PWD/$n.png" "file://$PWD/src/$n.html" >/dev/null 2>&1
  echo "$n.png"
done
