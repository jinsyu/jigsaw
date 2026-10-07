#!/usr/bin/env bash
# Applies jigsaw's SQL migrations to a Postgres database, each file once, in name order.
#
#   SUPABASE_DB_URL='postgresql://…' bash scripts/db/migrate.sh
#
# - Only files in supabase/migrations whose name contains "jigsaw_" are applied (the shared
#   gyosil project has other apps; `supabase db push` is never used there).
# - Each file runs in one transaction together with its row in jigsaw.schema_migrations, so a
#   failed file leaves nothing behind and is tried again next time. The first file creates
#   that table; until it exists nothing counts as applied.
# - The connection string (with its password) is never printed.
# JIGSAW_MIGRATIONS_DIR overrides the folder (tests only).
set -euo pipefail

if [[ -z "${SUPABASE_DB_URL:-}" ]]; then
  echo "SUPABASE_DB_URL 이 비어 있습니다. 접속 주소를 환경변수로 넣어 실행하세요." >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
migrations_dir="${JIGSAW_MIGRATIONS_DIR:-$script_dir/../../supabase/migrations}"

run_psql() {
  PGCONNECT_TIMEOUT=15 psql "$SUPABASE_DB_URL" --no-psqlrc --quiet --set ON_ERROR_STOP=1 "$@"
}

has_table="$(run_psql --tuples-only --no-align --command "select to_regclass('jigsaw.schema_migrations') is not null")"
applied=""
if [[ "$has_table" == "t" ]]; then
  applied="$(run_psql --tuples-only --no-align --command "select name from jigsaw.schema_migrations")"
fi

shopt -s nullglob
files=("$migrations_dir"/*jigsaw_*.sql)
shopt -u nullglob

new_count=0
skipped_count=0
for file in "${files[@]}"; do
  name="$(basename "$file" .sql)"
  if [[ ! "$name" =~ ^[0-9]{14}_jigsaw_[a-z0-9_]+$ ]]; then
    echo "이름 형식이 맞지 않아 멈춥니다: $name (예: 20261009000000_jigsaw_schema.sql)" >&2
    exit 1
  fi
  if grep --quiet --line-regexp --fixed-strings -- "$name" <<<"$applied"; then
    skipped_count=$((skipped_count + 1))
    continue
  fi
  echo "적용: $name"
  run_psql --single-transaction \
    --file "$file" \
    --command "insert into jigsaw.schema_migrations (name) values ('$name')"
  new_count=$((new_count + 1))
done

echo "완료: 새로 적용 ${new_count}개, 이미 적용 ${skipped_count}개"
