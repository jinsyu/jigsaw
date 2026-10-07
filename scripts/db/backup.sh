#!/usr/bin/env bash
# Dumps the jigsaw schema of the gyosil database to a compressed file and keeps the last days.
#
#   SUPABASE_DB_URL='postgresql://…' bash scripts/db/backup.sh
#
# On the rt server jigsaw-backup.timer runs it daily with /etc/jigsaw-backup.env (docs/ops.md).
# - Only the jigsaw schema (tables, rows, grants, RLS). Other apps' schemas, auth.users and the
#   Storage files (jigsaw-images) are not in the dump.
# - pg_dump custom format (compressed; restore with pg_restore). Files are mode 600.
# - Files older than BACKUP_KEEP_DAYS (default 14) are removed after every run, also when the
#   dump fails (the privacy policy promises at most 14 days), except the newest file, which
#   always stays so that one backup is left.
# - The connection string (with its password) is never printed.
# BACKUP_DIR: where the files go (default /var/backups/jigsaw).
set -euo pipefail
umask 077

if [[ -z "${SUPABASE_DB_URL:-}" ]]; then
  echo "SUPABASE_DB_URL 이 비어 있습니다. 접속 주소를 환경변수로 넣어 실행하세요." >&2
  exit 2
fi

backup_dir="${BACKUP_DIR:-/var/backups/jigsaw}"
keep_days="${BACKUP_KEEP_DAYS:-14}"
if [[ ! "$keep_days" =~ ^[1-9][0-9]*$ ]]; then
  echo "BACKUP_KEEP_DAYS 는 1 이상의 정수여야 합니다." >&2
  exit 2
fi

mkdir -p "$backup_dir"
target="$backup_dir/jigsaw-$(date -u +%Y%m%dT%H%M%SZ).dump"
partial="$target.partial"
trap 'rm -f "$partial"' EXIT

dumped=0
if PGCONNECT_TIMEOUT=15 pg_dump \
  --dbname="$SUPABASE_DB_URL" \
  --schema=jigsaw \
  --format=custom \
  --compress=6 \
  --no-owner \
  --file="$partial"; then
  mv "$partial" "$target"
  dumped=1
fi

# File names carry the UTC time, so the last name is the newest file. -mtime +N: older than N+1
# whole days.
newest="$(find "$backup_dir" -maxdepth 1 -type f -name 'jigsaw-*.dump' | sort | tail -n 1)"
while IFS= read -r old; do
  [[ "$old" == "$newest" ]] || rm -f -- "$old"
done < <(find "$backup_dir" -maxdepth 1 -type f -name 'jigsaw-*.dump' -mtime +"$((keep_days - 1))")

count="$(find "$backup_dir" -maxdepth 1 -type f -name 'jigsaw-*.dump' | wc -l | tr -d ' ')"
if ((dumped)); then
  echo "백업 완료: $(basename "$target") ($(du -h "$target" | cut -f1)), 보관 ${count}개"
else
  echo "백업 실패: pg_dump 오류 (위 메시지). 보관 ${count}개" >&2
  exit 1
fi
